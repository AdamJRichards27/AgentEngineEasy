// Owner t277u decisions — security regression tests (synthetic data, throwaway DB, test keys only).
// (t276u header kept for the shared helpers) Owner t276u decisions, regression tests (synthetic data, throwaway DB):
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
import { openAuditValue, retentionDays, retireAuditValueKey, rotateAuditValueKeys, sealAuditValue, verifyAuditValueKeys } from "../../lib/auditValueVault.js";
import { runRetentionSweep } from "../../lib/retentionSweep.js";

const KEY = "5".repeat(64); // synthetic test-only key
const KEY2 = "6".repeat(64); // synthetic test-only key (rotation target)
process.env.AE_AUDIT_VALUE_KEY = KEY;
process.env.AE_AUDIT_VALUE_KEY_ID = "k1";
const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `t277-${Date.now()}`;
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
    delete process.env.AE_ADMIN_AGENT_ROLE_USER_IDS;
    delete process.env.AE_AUDIT_VALUE_KEYS;
    delete process.env.AE_AUDIT_VALUE_ACTIVE_KEY_ID;
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


const age = (id: number, days: number) => db.update(auditLogs).set({ createdAt: sql`now() - make_interval(days => ${days})` }).where(eq(auditLogs.id, id));

test("t277u 1: dual Admin/Agent role sends own records as Agent; admin-only needs a valid delegation; Pit Crew never", async () => {
  const w = await world("Dual");
  // An appraisal the administrator owns (admin's own listing + contact).
  const prop = await call(w.admin.cookie, "POST", "/properties", { formattedAddress: `3 ${tag} Admin St, Testville`, state: "NSW", suburb: "Testville", postcode: "2000" });
  const party = await call(w.admin.cookie, "POST", "/parties", { propertyId: prop.json.property.id, role: "Seller", partyType: "Person", firstName: "Adele", lastName: `Own${tag}`, email: `adele-${tag}@example.com` });
  const ap = await call(w.admin.cookie, "POST", "/grow/appraisals/from-contact", { partyId: party.json.party.id, propertyId: prop.json.property.id });
  assert.equal(ap.status, 201, ap.text);
  const own = ap.json.appraisal.id as number;
  const agentAp = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.propertyId });
  const theirs = agentAp.json.appraisal.id as number;
  const send = (cookie: string, id: number, h: Record<string, string> = {}) => call(cookie, "POST", `/grow/appraisals/${id}/send`, {}, h);
  delete process.env.AE_ADMIN_AGENT_ROLE_USER_IDS;
  assert.equal((await send(w.admin.cookie, own)).json?.reason, "ADMIN_REVIEW_ONLY", "admin-only: own record still refused");
  process.env.AE_ADMIN_AGENT_ROLE_USER_IDS = `${w.admin.user.id},${w.pc.user.id}`;
  try {
    assert.notEqual((await send(w.admin.cookie, own)).json?.code, "SEND_AUTHORISATION_REQUIRED", "dual role sends own record");
    assert.ok((await audits(w.brokerageId, "send_as_agent_dual_role")).some((a) => a.recordId === String(own) && a.userId === w.admin.user.id));
    assert.equal((await send(w.admin.cookie, theirs)).json?.reason, "ADMIN_REVIEW_ONLY", "dual role never sends another agent's record");
    assert.equal((await send(w.pc.cookie, theirs, auth(w.agent.user.id))).json?.reason, "PIT_CREW", "listed Pit Crew still never sends");
  } finally {
    delete process.env.AE_ADMIN_AGENT_ROLE_USER_IDS;
  }
});

test("t277u 2: delegations expire after 30 days; owner renews; revoke is immediate; ownership change invalidates; audited", async () => {
  const w = await world("Expiry");
  const ap = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.propertyId });
  const id = ap.json.appraisal.id as number;
  const send = () => call(w.admin.cookie, "POST", `/grow/appraisals/${id}/send`, {});
  const body = { recordType: "appraisal", recordId: id, delegateUserId: w.admin.user.id, reason: "Away this month, Ada sends" };
  const d = await call(w.agent.cookie, "POST", "/send-delegations", body);
  assert.equal(d.status, 201, d.text);
  const exp = new Date(d.json.expiresAt).getTime() - Date.now();
  assert.ok(exp > 29.9 * 86_400_000 && exp <= 30 * 86_400_000 + 5000, "expires in 30 days");
  assert.notEqual((await send()).json?.code, "SEND_AUTHORISATION_REQUIRED");
  await age(d.json.auditId, 31);
  assert.equal((await send()).json?.reason, "ADMIN_REVIEW_ONLY", "expired after 30 days");
  assert.equal((await call(w.admin.cookie, "POST", "/send-delegations/renew", body)).json?.code, "SEND_DELEGATION_OWNER_ONLY", "only the owner renews");
  const ren = await call(w.agent.cookie, "POST", "/send-delegations/renew", body);
  assert.equal(ren.status, 201, ren.text);
  assert.equal(ren.json.renewedFrom, d.json.auditId);
  assert.notEqual((await send()).json?.code, "SEND_AUTHORISATION_REQUIRED", "renewed");
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations/revoke", body)).status, 200);
  assert.equal((await send()).json?.reason, "ADMIN_REVIEW_ONLY", "revocation immediate");
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations/renew", body)).json?.code, "SEND_DELEGATION_NOT_RENEWABLE", "a revoked delegation cannot be renewed");
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations", body)).status, 201);
  assert.notEqual((await send()).json?.code, "SEND_AUTHORISATION_REQUIRED");
  await db.execute(sql`update appraisals set owner_user_id = ${w.agent2.user.id} where id = ${id}`);
  assert.equal((await send()).json?.reason, "ADMIN_REVIEW_ONLY", "ownership change invalidates");
  const hist = (await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "appraisal"), eq(auditLogs.recordId, String(id))))).map((a) => a.action);
  for (const a of ["send_authority_delegated", "send_authority_revoked", "send_on_delegated_authority"]) assert.ok(hist.includes(a), a);
});

test("t277u 3: export-ready notification to the owner only, with expiry and no contact data; gone after download/dismiss; sweep deletes scope after 7 days", async () => {
  const w = await world("Notify");
  const h = auth(w.agent.user.id);
  const prep = await call(w.pc.cookie, "POST", "/grow/contacts/exports", {}, h);
  assert.equal(prep.status, 201, prep.text);
  const notes = await call(w.agent.cookie, "GET", "/notifications");
  const n = notes.json.notifications.find((x: { exportId: number }) => x.exportId === prep.json.exportId);
  assert.ok(n, notes.text);
  assert.equal(n.kind, "export_ready");
  assert.equal(n.preparedBy, "Pit Crew");
  const ttl = new Date(n.expiresAt).getTime() - new Date(n.preparedAt).getTime();
  assert.equal(ttl, 7 * 86_400_000);
  assert.equal(notes.text.includes("olive-"), false, "no contact data in notifications");
  for (const c of [w.pc.cookie, w.admin.cookie, w.agent2.cookie]) assert.equal((await call(c, "GET", "/notifications")).json.notifications.some((x: { exportId: number }) => x.exportId === prep.json.exportId), false);
  assert.equal((await call(w.admin.cookie, "POST", `/notifications/export:${prep.json.exportId}/dismiss`)).status, 404, "only the owner dismisses");
  assert.equal((await call(w.agent.cookie, "GET", `/grow/contacts/exports/${prep.json.exportId}/download`)).status, 200);
  assert.equal((await call(w.agent.cookie, "GET", "/notifications")).json.notifications.length, 0, "cleared after download");
  const p2 = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  assert.equal((await call(w.agent.cookie, "POST", `/notifications/export:${p2.json.exportId}/dismiss`)).status, 200);
  assert.equal((await call(w.agent.cookie, "GET", "/notifications")).json.notifications.length, 0, "cleared after dismiss");
  // Expiry: past 7 days the download is gone, the sweep deletes the scope and records it.
  const p3 = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  await age(p3.json.exportId, 8);
  assert.equal((await call(w.agent.cookie, "GET", `/grow/contacts/exports/${p3.json.exportId}/download`)).status, 410);
  const run = await runRetentionSweep();
  assert.ok("runId" in run);
  const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, p3.json.exportId));
  const meta = JSON.parse(row.updatedValue ?? "{}");
  assert.deepEqual(meta.scope.partyIds, []);
  assert.ok(meta.scope.partyCount >= 1 && meta.expiredAt);
  assert.ok((await audits(w.brokerageId, "contact_export_expired")).some((a) => a.recordId === String(p3.json.exportId)));
  assert.equal((await call(w.agent.cookie, "GET", "/notifications")).json.notifications.length, 0);
});

test("t277u 4: values kept 2 years by default (documented basis needed to change); metadata kept; restricted access unchanged", async () => {
  const saved = { d: process.env.AE_AUDIT_VALUE_RETENTION_DAYS, b: process.env.AE_AUDIT_VALUE_RETENTION_BASIS };
  try {
    delete process.env.AE_AUDIT_VALUE_RETENTION_DAYS;
    assert.equal(retentionDays(), 730);
    process.env.AE_AUDIT_VALUE_RETENTION_DAYS = "3650";
    delete process.env.AE_AUDIT_VALUE_RETENTION_BASIS;
    assert.equal(retentionDays(), 730, "no documented basis → default");
    process.env.AE_AUDIT_VALUE_RETENTION_BASIS = "Legal hold LH-2026-04 (documented)";
    assert.equal(retentionDays(), 3650);
  } finally {
    if (saved.d === undefined) delete process.env.AE_AUDIT_VALUE_RETENTION_DAYS; else process.env.AE_AUDIT_VALUE_RETENTION_DAYS = saved.d;
    if (saved.b === undefined) delete process.env.AE_AUDIT_VALUE_RETENTION_BASIS; else process.env.AE_AUDIT_VALUE_RETENTION_BASIS = saved.b;
  }
  const w = await world("Retain");
  const edit = async (email: string) => {
    const r = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email }, auth(w.agent.user.id));
    assert.equal(r.status, 200, r.text);
    const rows = (await audits(w.brokerageId, "grow_contact_updated_on_authority")).sort((a, b) => b.id - a.id);
    return rows[0].id;
  };
  const old = await edit(`olive-a-${tag}@example.com`);
  const recent = await edit(`olive-b-${tag}@example.com`);
  await age(old, 731);
  await age(recent, 700);
  await runRetentionSweep();
  const [o] = await db.select().from(auditLogs).where(eq(auditLogs.id, old));
  const [r] = await db.select().from(auditLogs).where(eq(auditLogs.id, recent));
  assert.equal(o.previousValue, "[expired]", "values past 2 years purged");
  assert.deepEqual(JSON.parse(o.updatedValue ?? "{}").fields, ["email"], "metadata kept");
  assert.equal(JSON.parse(o.updatedValue ?? "{}").requestedBy.userId, w.agent.user.id);
  assert.match(r.previousValue ?? "", /^enc:v1:/, "values within 2 years kept");
  // Restricted same-brokerage access, mandatory reason, logging (unchanged from t276u).
  process.env.AE_AUDIT_VALUE_READER_USER_IDS = String(w.admin.user.id);
  try {
    assert.equal((await call(w.admin.cookie, "POST", `/audit/contact-values/${recent}`, {})).json?.code, "AUDIT_VALUES_REASON_REQUIRED");
    assert.equal((await call(w.admin.cookie, "POST", `/audit/contact-values/${recent}`, { reason: "Dispute 2026-11" })).status, 200);
    assert.equal((await call(w.admin.cookie, "POST", `/audit/contact-values/${old}`, { reason: "Dispute 2026-11" })).status, 410);
    assert.equal((await call(w.agent.cookie, "POST", `/audit/contact-values/${recent}`, { reason: "Dispute 2026-11" })).status, 403);
  } finally {
    delete process.env.AE_AUDIT_VALUE_READER_USER_IDS;
  }
  const refusals = (await audits(w.brokerageId, "audit_values_access_refused")).map((a) => JSON.parse(a.updatedValue ?? "{}").refusal);
  for (const k of ["REASON_REQUIRED", "EXPIRED", "NOT_AUTHORISED"]) assert.ok(refusals.includes(k), k);
});

test("t277u 5: key rotation re-encrypts across versions; retirement refuses until every record is verified; no values without an active key", async () => {
  const w = await world("Keys");
  const scope = { brokerageIds: [w.brokerageId] };
  const h = auth(w.agent.user.id);
  for (const i of [1, 2, 3]) assert.equal((await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `olive-k${i}-${tag}@example.com` }, h)).status, 200);
  const rows = async () => (await audits(w.brokerageId, "grow_contact_updated_on_authority")).sort((a, b) => a.id - b.id);
  assert.ok((await rows()).every((r) => (r.previousValue ?? "").startsWith("enc:v1:k1:")));
  // Add k2 and make it active (ring keeps k1 for reading).
  process.env.AE_AUDIT_VALUE_KEYS = `k1:${KEY},k2:${KEY2}`;
  process.env.AE_AUDIT_VALUE_ACTIVE_KEY_ID = "k2";
  try {
    assert.deepEqual((await retireAuditValueKey("k1", scope)), { ok: false, reason: "ENVELOPES_REMAIN", remaining: (await verifyAuditValueKeys(scope)).byKid.k1, unverified: 0 });
    const first = (await rows())[0].id;
    const partial = await rotateAuditValueKeys({ scope, failOn: new Set([first]) });
    assert.deepEqual(partial.failed, [first], "partial failure reported");
    assert.equal((await retireAuditValueKey("k1", scope)).reason, "ENVELOPES_REMAIN", "still refuses after a partial rotation");
    const retry = await rotateAuditValueKeys({ scope });
    assert.equal(retry.failed.length, 0);
    assert.equal(retry.reencrypted, 1, "retry only touches the failed row (idempotent)");
    assert.equal((await rotateAuditValueKeys({ scope })).reencrypted, 0, "third run is a no-op");
    assert.ok((await rows()).every((r) => !`${r.previousValue}${r.updatedValue}`.includes("enc:v1:k1:")));
    assert.equal((await retireAuditValueKey("k2", scope)).reason, "KEY_IS_ACTIVE");
    // A corrupted envelope blocks retirement.
    const victim = (await rows())[1];
    const pv = victim.previousValue ?? "";
    const broken = pv.slice(0, -6) + (pv.slice(-6) === "AAAAAA" ? "BBBBBB" : "AAAAAA");
    await db.update(auditLogs).set({ previousValue: broken }).where(eq(auditLogs.id, victim.id));
    assert.equal((await retireAuditValueKey("k1", scope)).reason, "UNVERIFIED_RECORDS");
    await db.update(auditLogs).set({ previousValue: victim.previousValue }).where(eq(auditLogs.id, victim.id));
    assert.deepEqual(await retireAuditValueKey("k1", scope), { ok: true, remaining: 0, unverified: 0 });
    const certs = (await db.select().from(auditLogs).where(eq(auditLogs.action, "audit_key_retirement_verified"))).map((a) => JSON.parse(a.updatedValue ?? "{}"));
    assert.ok(certs.some((c) => c.kid === "k1"));
    // After retiring k1 (removed from the ring) everything still decrypts with k2 only.
    process.env.AE_AUDIT_VALUE_KEYS = `k2:${KEY2}`;
    delete process.env.AE_AUDIT_VALUE_KEY;
    assert.equal((await verifyAuditValueKeys(scope)).unverified.length, 0);
    assert.match(JSON.stringify(openAuditValue((await rows())[2].previousValue!)), /olive-k2-/);
    // Active key unavailable → no values stored.
    process.env.AE_AUDIT_VALUE_ACTIVE_KEY_ID = "k9";
    assert.equal(sealAuditValue({ email: "x@example.com" }), null);
    assert.equal((await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `olive-k4-${tag}@example.com` }, h)).status, 200);
    const last = (await rows()).at(-1)!;
    assert.equal(`${last.previousValue}${last.updatedValue}`.includes("olive-"), false);
    assert.ok(JSON.parse(last.updatedValue ?? "{}").after.withheld);
  } finally {
    delete process.env.AE_AUDIT_VALUE_KEYS;
    delete process.env.AE_AUDIT_VALUE_ACTIVE_KEY_ID;
    process.env.AE_AUDIT_VALUE_KEY = KEY;
    process.env.AE_AUDIT_VALUE_KEY_ID = "k1";
  }
});

test("t277u 6: held imports — admin assigns or agent accepts for self, authority reference required and audited; Pit Crew cannot release", async () => {
  const w = await world("Held");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(`First Name,Last Name,Email\nHeld,Six${tag},held6-${tag}@example.com\n`)], { type: "text/csv" }), "c.csv");
  const up = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie: w.agent2.cookie }, body: form });
  const job = ((await up.json()) as { job: { id: number } }).job.id;
  await db.update(users).set({ isActive: false }).where(eq(users.id, w.agent2.user.id));
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${job}/execute`, {})).json?.code, "IMPORT_HELD_FOR_REVIEW");
  for (const h of [{}, auth(w.agent.user.id)]) assert.equal((await call(w.pc.cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "INSTR-6" }, h)).status, 403, "Pit Crew cannot release");
  assert.equal((await call(w.agent.cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: w.agent.user.id })).json?.code, "IMPORT_OWNER_INVALID", "authority reference required");
  assert.equal((await call(w.agent.cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "Accepted at review INSTR-6" })).status, 201, "agent accepts for self");
  const rec = (await audits(w.brokerageId, "import_job_owner_recorded")).filter((a) => a.recordId === String(job)).sort((a, b) => b.id - a.id)[0];
  const v = JSON.parse(rec.updatedValue ?? "{}");
  assert.deepEqual([rec.userId, v.owner, v.authorityRef, v.source], [w.agent.user.id, w.agent.user.id, "Accepted at review INSTR-6", "review"]);
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: w.admin.user.id, authorityRef: "Admin reassign INSTR-7" })).status, 201, "admin assigns");
});

test("t277u 7: retention sweep is observable, auditable, idempotent and retries a partial failure", async () => {
  const w = await world("Sweep");
  const a = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  const b = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  await age(a.json.exportId, 9);
  await age(b.json.exportId, 9);
  const r1 = (await runRetentionSweep(new Date(), { failExports: new Set([b.json.exportId]) })) as { outcome: string; runId: number; exports: { failedIds: number[] } };
  assert.equal(r1.outcome, "partial");
  assert.deepEqual(r1.exports.failedIds.filter((x) => x === b.json.exportId), [b.json.exportId]);
  const expiredFor = async (id: number) => (await audits(w.brokerageId, "contact_export_expired")).filter((x) => x.recordId === String(id)).length;
  assert.equal(await expiredFor(a.json.exportId), 1);
  assert.equal(await expiredFor(b.json.exportId), 0);
  const r2 = (await runRetentionSweep()) as { outcome: string; runId: number };
  assert.equal(r2.outcome, "completed");
  assert.equal(await expiredFor(b.json.exportId), 1, "retried");
  assert.equal(await expiredFor(a.json.exportId), 1, "not processed twice");
  await runRetentionSweep();
  assert.equal(await expiredFor(a.json.exportId) + await expiredFor(b.json.exportId), 2, "idempotent");
  // Run records exist and are readable; metrics exported.
  const runs = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "retention_sweep_run"), sql`${auditLogs.id} in (${r1.runId}, ${r2.runId})`));
  assert.equal(runs.length, 2);
  assert.equal(JSON.parse(runs.find((x) => x.id === r1.runId)!.updatedValue ?? "{}").outcome, "partial");
  const { renderMetricsText } = await import("@aee/events");
  assert.match(renderMetricsText(), /retention_sweep_run_total\{outcome="partial"\}/);
  // Overlap guard.
  const [x, y] = await Promise.all([runRetentionSweep(), runRetentionSweep()]);
  assert.ok([x, y].some((r) => (r as { outcome: string }).outcome === "skipped_overlap"));
});
