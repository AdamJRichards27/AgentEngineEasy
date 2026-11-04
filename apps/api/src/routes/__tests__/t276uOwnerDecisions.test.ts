// Owner t276u decisions, regression tests (synthetic data, throwaway DB):
//  1. final send is agent-only; administrators review; delegation must be explicitly recorded;
//  2. admin AI only via AE_AGENT_AI_ADMIN_USER_IDS, never overriding Pit Crew / read-only;
//  3. exports delivered to the contact owner; Pit Crew download needs a separate owner release;
//  4. before/after contact values encrypted, masked in ordinary views, restricted + logged reads,
//     retention;
//  5. imported contacts owned without a property relationship; held for review when the owner
//     cannot be established.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db, entitlementGrants, users, auditLogs, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";
import { maskAuditValue, purgeExpiredAuditValues, sealAuditValue, openAuditValue } from "../../lib/auditValueVault.js";
import { getPropertyTimeline } from "../../lib/timeline.js";

const KEY = "7".repeat(64); // synthetic test-only key
process.env.AE_AUDIT_VALUE_KEY = KEY;
const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `t276-${Date.now()}`;
let server: Server;
let base = "";
const ids: number[] = [];

before(async () => {
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  try {
    await cleanupBrokerages(ids);
  } finally {
    delete process.env.AE_AGENT_AI_ADMIN_USER_IDS;
    delete process.env.AE_AUDIT_VALUE_READER_USER_IDS;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

async function setGrants(brokerageId: number, keys: readonly string[]) {
  await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  for (const k of keys) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: k, granteeType: "brokerage", granteeId: brokerageId, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}

async function call(cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, connection: "close", ...(body ? { "content-type": "application/json" } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text };
}
const auth = (ownerId: number, ref = "INSTR-276 email instruction") => ({ "x-ae-on-behalf-of": String(ownerId), "x-ae-authority-ref": ref });
const audits = async (brokerageId: number, action: string) => db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, brokerageId), eq(auditLogs.action, action)));

async function world(label: string) {
  const name = `${tag} ${label}`;
  const b = await createBrokerageWithUsers(base, name);
  ids.push(b.brokerageId);
  await setGrants(b.brokerageId, ["run.access", ...GROW]);
  const slug = name.replace(/\s+/g, "-").toLowerCase();
  const pc = await devLogin(base, { email: `pc-${slug}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pc.user.id));
  const agent2 = await devLogin(base, { email: `agent2-${slug}@example.com`, firstName: "Second", lastName: "Agent", brokerageName: name });
  await db.update(users).set({ role: "Agent" }).where(eq(users.id, agent2.user.id));
  const prop = await call(b.agent.cookie, "POST", "/properties", { formattedAddress: `9 ${name} St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(prop.status, 201, prop.text);
  const c = await call(b.agent.cookie, "POST", "/parties", { propertyId: prop.json.property.id, role: "Seller", partyType: "Person", firstName: "Olive", lastName: `Owner${label}`, email: `olive-${slug}@example.com`, mobile: "0400 111 222" });
  assert.equal(c.status, 201, c.text);
  return { ...b, pc, agent2, propertyId: prop.json.property.id as number, partyId: c.json.party.id as number };
}

test("t276u 1: final send is agent-only; admin reviews; delegation is explicit, recorded, owner-only, revocable; Pit Crew never", async () => {
  const w = await world("Send");
  const made = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.propertyId });
  assert.equal(made.status, 201, made.text);
  const id = made.json.appraisal.id as number;
  const send = (cookie: string, h: Record<string, string> = {}) => call(cookie, "POST", `/grow/appraisals/${id}/send`, {}, h);
  // Admin: oversight/review (can read) but cannot send by role.
  assert.equal((await call(w.admin.cookie, "GET", `/grow/appraisals/${id}`)).status, 200);
  const adm = await send(w.admin.cookie);
  assert.deepEqual([adm.status, adm.json?.code, adm.json?.reason], [403, "SEND_AUTHORISATION_REQUIRED", "ADMIN_REVIEW_ONLY"]);
  const pc = await send(w.pc.cookie, auth(w.agent.user.id));
  assert.deepEqual([pc.status, pc.json?.reason], [403, "PIT_CREW"]);
  // Only the owning agent may delegate; never to Pit Crew; reason required.
  const body = { recordType: "appraisal", recordId: id, delegateUserId: w.admin.user.id, reason: "On leave Friday, Ada to send" };
  assert.equal((await call(w.agent2.cookie, "POST", "/send-delegations", body)).json?.code, "SEND_DELEGATION_OWNER_ONLY");
  assert.equal((await call(w.admin.cookie, "POST", "/send-delegations", body)).json?.code, "SEND_DELEGATION_OWNER_ONLY");
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations", { ...body, delegateUserId: w.pc.user.id })).json?.code, "SEND_DELEGATE_INVALID");
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations", { ...body, reason: undefined })).status, 400);
  const del = await call(w.agent.cookie, "POST", "/send-delegations", body);
  assert.equal(del.status, 201, del.text);
  const rec = (await audits(w.brokerageId, "send_authority_delegated")).find((a) => a.recordId === String(id));
  assert.ok(rec && rec.userId === w.agent.user.id && rec.providerReference === `delegate:${w.admin.user.id}`);
  const ok = await send(w.admin.cookie);
  assert.notEqual(ok.json?.code, "SEND_AUTHORISATION_REQUIRED", ok.text);
  assert.ok((await audits(w.brokerageId, "send_on_delegated_authority")).some((a) => a.recordId === String(id) && a.userId === w.admin.user.id));
  // Delegation is per record: another appraisal is still refused.
  const prop2 = await call(w.agent.cookie, "POST", "/properties", { formattedAddress: `10 ${tag} Second St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  assert.equal(prop2.status, 201, prop2.text);
  const p2 = await call(w.agent.cookie, "POST", "/parties", { propertyId: prop2.json.property.id, role: "Buyer", partyType: "Person", firstName: "Second", lastName: `Contact${tag}`, email: `second-${tag}@example.com` });
  assert.equal(p2.status, 201, p2.text);
  const other = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: p2.json.party.id, propertyId: prop2.json.property.id });
  assert.equal(other.status, 201, other.text);
  assert.notEqual(other.json.appraisal.id, id);
  const otherSend = await call(w.admin.cookie, "POST", `/grow/appraisals/${other.json.appraisal.id}/send`, {});
  assert.equal(otherSend.json?.reason, "ADMIN_REVIEW_ONLY", otherSend.text);
  // Revoked → refused again.
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations/revoke", { recordType: "appraisal", recordId: id, delegateUserId: w.admin.user.id })).status, 200);
  assert.equal((await send(w.admin.cookie)).json?.reason, "ADMIN_REVIEW_ONLY");
  // Agents send.
  assert.notEqual((await send(w.agent.cookie)).json?.code, "SEND_AUTHORISATION_REQUIRED");
});

test("t276u 2: admin AI only via the allowlist, which never overrides Pit Crew or read-only", async () => {
  const w = await world("Ai");
  const ask = (cookie: string) => call(cookie, "POST", "/ai/ask", { question: "How am I tracking?" });
  delete process.env.AE_AGENT_AI_ADMIN_USER_IDS;
  assert.equal((await ask(w.admin.cookie)).json?.reason, "ADMIN_NOT_AUTHORISED");
  process.env.AE_AGENT_AI_ADMIN_USER_IDS = `${w.admin.user.id},${w.pc.user.id}`;
  try {
    assert.notEqual((await ask(w.admin.cookie)).json?.code, "AGENT_AI_AGENT_ONLY");
    assert.equal((await ask(w.pc.cookie)).json?.reason, "PIT_CREW", "allowlisted Pit Crew still refused");
    await setGrants(w.brokerageId, ["grow.access", "grow.contacts.read"]);
    const ro = await ask(w.admin.cookie);
    assert.deepEqual([ro.status, ro.json?.reason], [403, "READ_ONLY"], "allowlisted read-only admin still refused");
    assert.equal((await call(w.admin.cookie, "GET", "/ai/capabilities")).json?.agentAiAllowed, false);
    assert.equal((await ask(w.agent.cookie)).json?.reason, "READ_ONLY");
  } finally {
    delete process.env.AE_AGENT_AI_ADMIN_USER_IDS;
    await setGrants(w.brokerageId, ["run.access", ...GROW]);
  }
  assert.notEqual((await ask(w.agent.cookie)).json?.code, "AGENT_AI_AGENT_ONLY", "agents keep access");
});

test("t276u 3: exports are delivered to the owner; Pit Crew initiates but downloads only after a separate owner release; full audit", async () => {
  const w = await world("Export");
  const h = auth(w.agent.user.id);
  assert.equal((await call(w.pc.cookie, "POST", "/grow/contacts/exports", {})).json?.code, "CONTACT_OWNER_AUTHORITY_REQUIRED");
  const prep = await call(w.pc.cookie, "POST", "/grow/contacts/exports", {}, h);
  assert.equal(prep.status, 201, prep.text);
  assert.equal(prep.json.deliveredTo, w.agent.user.id);
  assert.equal(prep.text.includes("olive-"), false, "no data returned to the initiator");
  const exportId = prep.json.exportId as number;
  const dl = (cookie: string, x: Record<string, string> = {}) => call(cookie, "GET", `/grow/contacts/exports/${exportId}/download`, undefined, x);
  assert.equal((await dl(w.pc.cookie, h)).json?.code, "EXPORT_DELIVERED_TO_OWNER");
  assert.equal((await dl(w.admin.cookie)).json?.code, "EXPORT_DELIVERED_TO_OWNER", "brokerage admin is not the owner");
  assert.equal((await dl(w.agent2.cookie)).json?.code, "EXPORT_DELIVERED_TO_OWNER");
  // Owner's list shows it; the owner downloads.
  assert.ok((await call(w.agent.cookie, "GET", "/grow/contacts/exports")).json.exports.some((e: { exportId: number; mine: boolean }) => e.exportId === exportId && e.mine));
  const own = await dl(w.agent.cookie);
  assert.equal(own.status, 200);
  assert.ok(own.text.includes(`olive-`));
  // Release: owner only, to the initiator only, reason required.
  assert.equal((await call(w.pc.cookie, "POST", `/grow/contacts/exports/${exportId}/release`, { recipientUserId: w.pc.user.id, reason: "self release" }, h)).json?.code, "EXPORT_RELEASE_OWNER_ONLY");
  assert.equal((await call(w.agent.cookie, "POST", `/grow/contacts/exports/${exportId}/release`, { recipientUserId: w.agent2.user.id, reason: "wrong person" })).json?.code, "EXPORT_RELEASE_INVALID");
  assert.equal((await call(w.agent.cookie, "POST", `/grow/contacts/exports/${exportId}/release`, { recipientUserId: w.pc.user.id })).json?.code, "EXPORT_RELEASE_INVALID");
  const rel = await call(w.agent.cookie, "POST", `/grow/contacts/exports/${exportId}/release`, { recipientUserId: w.pc.user.id, reason: "Pit Crew to load the mailer list" });
  assert.equal(rel.status, 201, rel.text);
  const pcGot = await dl(w.pc.cookie, h);
  assert.equal(pcGot.status, 200, pcGot.text);
  const rows = (await audits(w.brokerageId, "contacts_exported")).map((a) => JSON.parse(a.updatedValue ?? "{}"));
  const ownerRow = rows.find((r) => r.recipient.userId === w.agent.user.id)!;
  const pcRow = rows.find((r) => r.recipient.userId === w.pc.user.id)!;
  for (const r of [ownerRow, pcRow]) {
    assert.equal(r.owner, w.agent.user.id);
    assert.equal(r.requestedBy, w.agent.user.id);
    assert.equal(r.initiatedBy, w.pc.user.id);
    assert.equal(r.scope.kind, "owner_contacts");
    assert.ok(Array.isArray(r.scope.fields) && typeof r.at === "string");
  }
  assert.equal(ownerRow.releaseAuditId, null);
  assert.equal(pcRow.releaseAuditId, rel.json.releaseAuditId);
  // Legacy GET /export: owner direct download still works (agent), Pit Crew refused.
  assert.equal((await call(w.agent.cookie, "GET", "/grow/contacts/export")).status, 200);
  assert.equal((await call(w.pc.cookie, "GET", "/grow/contacts/export", undefined, h)).json?.code, "EXPORT_DELIVERED_TO_OWNER");
  // Cross-brokerage: another brokerage cannot see the export.
  const other = await world("ExportOther");
  assert.equal((await call(other.agent.cookie, "GET", `/grow/contacts/exports/${exportId}/download`)).status, 404);
});

test("t276u 4: before/after values encrypted at rest, masked in ordinary views, restricted + audited reads, retention", async () => {
  const w = await world("Audit");
  const newEmail = `olive-new-${tag}@example.com`;
  const edit = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: newEmail }, auth(w.agent.user.id));
  assert.equal(edit.status, 200, edit.text);
  const [row] = (await audits(w.brokerageId, "grow_contact_updated_on_authority")).filter((a) => a.recordId === String(w.partyId));
  assert.ok(row, "audited");
  const raw = `${row.previousValue} ${row.updatedValue}`;
  assert.equal(raw.includes("olive-"), false, "no plaintext contact values at rest");
  assert.match(row.previousValue ?? "", /^enc:v1:/);
  const meta = JSON.parse(row.updatedValue ?? "{}");
  assert.deepEqual(meta.fields, ["email"]);
  assert.equal(meta.requestedBy.userId, w.agent.user.id);
  assert.equal((openAuditValue(meta.after) as { email: string }).email, newEmail);
  // Ordinary views mask envelopes.
  assert.equal(maskAuditValue(row.updatedValue)!.includes("enc:v1:"), false);
  assert.ok(maskAuditValue(row.updatedValue)!.includes("[encrypted]"));
  const linkRes = await call(w.pc.cookie, "POST", "/parties", { propertyId: w.propertyId, partyId: w.partyId, role: "Buyer" }, auth(w.agent.user.id));
  assert.equal(linkRes.status, 201, linkRes.text);
  // A timeline-visible audit row that carries an envelope is shown masked.
  await db.insert(auditLogs).values({ brokerageId: w.brokerageId, userId: w.agent.user.id, action: "party_added", recordType: "party", recordId: String(w.partyId), propertyId: w.propertyId, updatedValue: JSON.stringify({ after: sealAuditValue({ email: "olive-secret@example.com" }) }) });
  const timeline = JSON.stringify(await getPropertyTimeline(w.propertyId, w.brokerageId, true));
  assert.ok(timeline.includes("[encrypted]"), "masked marker shown");
  assert.equal(timeline.includes("enc:v1:"), false, "timeline never carries envelopes");
  // Restricted read: not listed → refused and logged; listed admin with reason → values, logged.
  const url = `/audit/contact-values/${row.id}`;
  assert.equal((await call(w.agent.cookie, "POST", url, { reason: "checking change" })).json?.code, "AUDIT_VALUES_RESTRICTED");
  assert.equal((await call(w.admin.cookie, "POST", url, { reason: "checking change" })).json?.code, "AUDIT_VALUES_RESTRICTED");
  process.env.AE_AUDIT_VALUE_READER_USER_IDS = String(w.admin.user.id);
  try {
    assert.equal((await call(w.admin.cookie, "POST", url, {})).json?.code, "AUDIT_VALUES_REASON_REQUIRED");
    const got = await call(w.admin.cookie, "POST", url, { reason: "Complaint review #12" });
    assert.equal(got.status, 200, got.text);
    assert.equal(got.json.after.email, newEmail);
    assert.match(String(got.json.before.email), /^olive-/);
    const other = await world("AuditOther");
    process.env.AE_AUDIT_VALUE_READER_USER_IDS = `${w.admin.user.id},${other.admin.user.id}`;
    assert.equal((await call(other.admin.cookie, "POST", url, { reason: "cross tenant probe" })).status, 404);
    // Wrong key → 503, never plaintext.
    process.env.AE_AUDIT_VALUE_KEY = "8".repeat(64);
    assert.equal((await call(w.admin.cookie, "POST", url, { reason: "Complaint review #12" })).status, 503);
    process.env.AE_AUDIT_VALUE_KEY = KEY;
    const logged = (await audits(w.brokerageId, "audit_values_accessed")).filter((a) => a.recordId === String(row.id));
    assert.equal(logged.length, 1);
    assert.ok(JSON.parse(logged[0].updatedValue ?? "{}").reason === "Complaint review #12");
    assert.ok((await audits(w.brokerageId, "audit_values_access_refused")).length >= 3);
    // Retention: past retention → 410, and purge replaces envelopes (metadata kept).
    await db.update(auditLogs).set({ createdAt: sql`now() - interval '3000 days'` }).where(eq(auditLogs.id, row.id));
    assert.equal((await call(w.admin.cookie, "POST", url, { reason: "Complaint review #12" })).status, 410);
    assert.ok((await purgeExpiredAuditValues()) >= 1);
    const [purged] = await db.select().from(auditLogs).where(eq(auditLogs.id, row.id));
    assert.equal(purged.previousValue, "[expired]");
    assert.deepEqual(JSON.parse(purged.updatedValue ?? "{}").fields, ["email"]);
  } finally {
    delete process.env.AE_AUDIT_VALUE_READER_USER_IDS;
    process.env.AE_AUDIT_VALUE_KEY = KEY;
  }
  // No key → values withheld, never plaintext.
  delete process.env.AE_AUDIT_VALUE_KEY;
  try {
    assert.equal(sealAuditValue({ email: "x@example.com" }), null);
    const e2 = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `olive-third-${tag}@example.com` }, auth(w.agent.user.id));
    assert.equal(e2.status, 200, e2.text);
    const rows = (await audits(w.brokerageId, "grow_contact_updated_on_authority")).filter((a) => a.recordId === String(w.partyId));
    const latest = rows.sort((a, b) => b.id - a.id)[0];
    assert.equal(`${latest.previousValue}${latest.updatedValue}`.includes("olive-"), false);
    assert.ok(JSON.parse(latest.updatedValue ?? "{}").after.withheld);
  } finally {
    process.env.AE_AUDIT_VALUE_KEY = KEY;
  }
});

test("t276u 5: imported contacts are owned without a property relationship; Pit Crew import assigns the named owner; held for review when the owner cannot be established", async () => {
  const w = await world("Import");
  const upload = async (cookie: string, csv: string, h: Record<string, string> = {}) => {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(csv)], { type: "text/csv" }), "c.csv");
    const r = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie, ...h }, body: form });
    const j = (await r.json()) as { job: { id: number } };
    assert.equal(r.status, 201, JSON.stringify(j));
    return j.job.id;
  };
  const MAP = { mapping: { "First Name": "person.firstName", "Last Name": "person.lastName", Email: "person.email" } };
  // Pit Crew imports for the agent: contacts with NO property become the agent's.
  const h = auth(w.agent.user.id);
  const job = await upload(w.pc.cookie, `First Name,Last Name,Email\nNoprop,Imported${tag},noprop-${tag}@example.com\n`, h);
  assert.equal((await call(w.pc.cookie, "PUT", `/import/jobs/${job}/mapping`, MAP, h)).status, 200);
  const ex = await call(w.pc.cookie, "POST", `/import/jobs/${job}/execute`, {}, h);
  assert.equal(ex.status, 200, ex.text);
  const [party] = (await db.execute(sql`select id from parties where brokerage_id = ${w.brokerageId} and email = ${`noprop-${tag}@example.com`}`)).rows as { id: number }[];
  assert.ok(party, "imported");
  const links = (await db.execute(sql`select 1 from property_parties where party_id = ${party.id}`)).rows;
  assert.equal(links.length, 0, "no property relationship");
  const owner = (await audits(w.brokerageId, "contact_owner_recorded")).find((a) => a.recordId === String(party.id));
  assert.equal(owner?.providerReference, `owner:${w.agent.user.id}`);
  const ov = JSON.parse(owner!.updatedValue ?? "{}");
  assert.deepEqual([ov.source, ov.importJobId, ov.authorityRef], ["import", job, "INSTR-276 email instruction"]);
  assert.ok((await audits(w.brokerageId, "import_owner_assigned")).some((a) => a.recordId === String(job)));
  // Owner-scoped access: in the owner's export, and editable by Pit Crew for that owner only.
  const prep = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  assert.ok((await call(w.agent.cookie, "GET", `/grow/contacts/exports/${prep.json.exportId}/download`)).text.includes(`Imported${tag}`));
  assert.equal((await call(w.pc.cookie, "PATCH", `/grow/contacts/${party.id}`, { lastName: `Edited${tag}` }, h)).status, 200);
  assert.equal((await call(w.pc.cookie, "PATCH", `/grow/contacts/${party.id}`, { lastName: `Nope${tag}` }, auth(w.agent2.user.id))).json?.code, "CONTACT_OWNER_AUTHORITY_OUT_OF_SCOPE");
  // Ownership cannot be established (the owning agent was deactivated) → held for review.
  const job2 = await upload(w.agent2.cookie, `First Name,Last Name,Email\nHeld,Import${tag},held-${tag}@example.com\n`);
  assert.equal((await call(w.agent2.cookie, "PUT", `/import/jobs/${job2}/mapping`, MAP)).status, 200);
  await db.update(users).set({ isActive: false }).where(eq(users.id, w.agent2.user.id));
  const held = await call(w.admin.cookie, "POST", `/import/jobs/${job2}/execute`, {});
  assert.deepEqual([held.status, held.json?.code, held.json?.reason], [409, "IMPORT_HELD_FOR_REVIEW", "OWNER_INACTIVE"]);
  assert.equal(((await db.execute(sql`select 1 from parties where email = ${`held-${tag}@example.com`}`)).rows).length, 0, "nothing imported while held");
  assert.ok((await audits(w.brokerageId, "import_held_for_review")).some((a) => a.recordId === String(job2)));
  // Resolution: Pit Crew / another agent cannot assign; admin records an eligible owner.
  assert.equal((await call(w.pc.cookie, "POST", `/import/jobs/${job2}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "INSTR-9" })).status, 403);
  assert.equal((await call(w.agent.cookie, "POST", `/import/jobs/${job2}/owner`, { ownerUserId: w.admin.user.id, authorityRef: "INSTR-9" })).json?.code, "IMPORT_OWNER_ASSIGN_FORBIDDEN");
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${job2}/owner`, { ownerUserId: w.agent2.user.id, authorityRef: "INSTR-9" })).json?.reason, "OWNER_INACTIVE");
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${job2}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "Reassigned at review INSTR-9" })).status, 201);
  const ran = await call(w.admin.cookie, "POST", `/import/jobs/${job2}/execute`, {});
  assert.equal(ran.status, 200, ran.text);
  const [p2] = (await db.execute(sql`select id from parties where email = ${`held-${tag}@example.com`}`)).rows as { id: number }[];
  assert.equal((await audits(w.brokerageId, "contact_owner_recorded")).find((a) => a.recordId === String(p2.id))?.providerReference, `owner:${w.agent.user.id}`);
});
