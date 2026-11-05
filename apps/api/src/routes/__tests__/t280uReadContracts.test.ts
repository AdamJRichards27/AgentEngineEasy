// Owner t280u read contracts — server authorisation tests (synthetic data, throwaway DB, test keys only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db, entitlementGrants, users, auditLogs, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";
import { growRelationships } from "@aee/db";
import { getRelationshipTimeline } from "../../lib/relationshipTimeline.js";
import { relationshipStatusWording, relationshipTypeWording } from "../../lib/relationshipWording.js";

const KEY = "5".repeat(64); // synthetic test-only key
const KEY2 = "6".repeat(64); // synthetic test-only key (rotation target)
process.env.AE_AUDIT_VALUE_KEY = KEY;
process.env.AE_AUDIT_VALUE_KEY_ID = "k1";
const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `t280-${Date.now()}`;
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
const anon = (method: string, path: string) => fetch(`${base}/api${path}`, { method, headers: { connection: "close" } }).then((r) => r.status);

async function readOnly(label: string) {
  const w = await world(label);
  await setGrants(w.brokerageId, ["grow.access", "grow.contacts.read"]);
  return w;
}

test("t280u 1: delegation status — owner/admin/other agent/Pit Crew/read-only/unauthenticated; expiry, renewal, revocation, ownership change", async () => {
  const w = await world("Deleg");
  const ro = await readOnly("DelegRO");
  const ap = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.propertyId });
  assert.equal(ap.status, 201, ap.text);
  const id = ap.json.appraisal.id as number;
  const q = `/send-delegations?recordType=appraisal&recordId=${id}`;
  const body = { recordType: "appraisal", recordId: id, delegateUserId: w.admin.user.id, reason: "Away this month, Ada sends" };
  const d = await call(w.agent.cookie, "POST", "/send-delegations", body);
  assert.equal(d.status, 201, d.text);

  assert.equal(await anon("GET", q), 401, "unauthenticated");
  const pc = await call(w.pc.cookie, "GET", q, undefined, auth(w.agent.user.id));
  assert.deepEqual([pc.status, pc.json?.code, pc.json?.reason], [403, "SEND_DELEGATION_READ_FORBIDDEN", "PIT_CREW"]);
  assert.equal((await call(ro.agent.cookie, "GET", q)).status, 404, "other brokerage (read-only agent) cannot see the record");
  assert.equal((await call(w.agent.cookie, "GET", "/send-delegations?recordType=nope&recordId=1")).json?.code, "SEND_DELEGATION_INVALID");

  const own = await call(w.agent.cookie, "GET", q);
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.viewer, "owner");
  assert.equal(own.json.canManage, true);
  const row = own.json.delegations[0];
  assert.deepEqual([row.delegateUserId, row.state, row.reason, row.renewable, row.revocable], [w.admin.user.id, "active", "Away this month, Ada sends", true, true]);
  assert.equal(new Date(row.expiresAt).getTime() - new Date(row.grantedAt).getTime(), 30 * 86_400_000);
  const elig = own.json.eligibleDelegates.map((e: { userId: number }) => e.userId);
  assert.ok(elig.includes(w.admin.user.id) && elig.includes(w.agent2.user.id));
  assert.ok(!elig.includes(w.pc.user.id) && !elig.includes(w.agent.user.id), "never Pit Crew, never self");

  const adm = await call(w.admin.cookie, "GET", q);
  assert.deepEqual([adm.status, adm.json.viewer, adm.json.canManage, adm.json.eligibleDelegates.length, adm.json.delegations.length], [200, "admin", false, 0, 1]);
  assert.equal(adm.json.delegations[0].renewable, false);
  const other = await call(w.agent2.cookie, "GET", q);
  assert.deepEqual([other.status, other.json.viewer, other.json.delegations.length], [200, "delegate", 0], "another agent sees only their own delegation");

  await age(d.json.auditId, 31);
  assert.equal((await call(w.agent.cookie, "GET", q)).json.delegations[0].state, "expired");
  const ren = await call(w.agent.cookie, "POST", "/send-delegations/renew", body);
  assert.equal(ren.status, 201);
  const afterRen = (await call(w.agent.cookie, "GET", q)).json.delegations[0];
  assert.deepEqual([afterRen.state, afterRen.renewedFrom, afterRen.renewalCount], ["active", d.json.auditId, 1]);
  await call(w.agent.cookie, "POST", "/send-delegations/revoke", body);
  const rev = (await call(w.agent.cookie, "GET", q)).json.delegations[0];
  assert.deepEqual([rev.state, rev.revokedByUserId, rev.renewable], ["revoked", w.agent.user.id, false]);
  assert.ok(rev.revokedAt);
  await call(w.agent.cookie, "POST", "/send-delegations", body);
  await db.execute(sql`update appraisals set owner_user_id = ${w.agent2.user.id} where id = ${id}`);
  const inv = await call(w.agent2.cookie, "GET", q);
  assert.equal(inv.json.viewer, "owner");
  assert.deepEqual([inv.json.delegations[0].state, inv.json.delegations[0].invalidatedByOwnershipChange, inv.json.delegations[0].renewable], ["invalidated", true, false]);
  assert.equal((await call(w.agent2.cookie, "POST", "/send-delegations/renew", body)).json?.code, "SEND_DELEGATION_NOT_RENEWABLE", "new owner cannot renew the old owner's delegation");
  assert.equal((await call(w.agent.cookie, "GET", q)).json.viewer, "delegate", "previous owner is no longer the owner");
});

test("t280u 2: export status, release and durable seen marker; owner-only download unchanged", async () => {
  const w = await world("Exp");
  const ro = await readOnly("ExpRO");
  const prep = await call(w.pc.cookie, "POST", "/grow/contacts/exports", {}, auth(w.agent.user.id));
  assert.equal(prep.status, 201, prep.text);
  const eid = prep.json.exportId as number;
  const find = async (cookie: string) => (await call(cookie, "GET", "/grow/contacts/exports")).json.exports.find((e: { exportId: number }) => e.exportId === eid);
  assert.equal(await anon("GET", "/grow/contacts/exports"), 401);
  assert.equal(await anon("POST", `/grow/contacts/exports/${eid}/seen`), 401);

  let mine = await find(w.agent.cookie);
  assert.deepEqual([mine.status, mine.ready, mine.seen, mine.canDownload, mine.releasedTo.length], ["ready", true, false, true, 0]);
  assert.equal(new Date(mine.expiresAt).getTime() - new Date(mine.preparedAt).getTime(), 7 * 86_400_000);
  const pcView = await find(w.pc.cookie);
  assert.deepEqual([pcView.mine, pcView.seen, pcView.canDownload], [false, null, false], "Pit Crew initiator: not owner, no seen marker, cannot download");
  assert.equal(await find(w.admin.cookie), undefined, "admin does not see another owner's exports");
  assert.equal(await find(ro.agent.cookie), undefined);

  for (const c of [w.pc.cookie, w.admin.cookie, w.agent2.cookie]) assert.equal((await call(c, "POST", `/grow/contacts/exports/${eid}/seen`)).json?.code, "EXPORT_SEEN_OWNER_ONLY");
  assert.equal((await call(ro.agent.cookie, "POST", `/grow/contacts/exports/${eid}/seen`)).status, 404, "other brokerage");
  const s1 = await call(w.agent.cookie, "POST", `/grow/contacts/exports/${eid}/seen`);
  assert.equal(s1.status, 201);
  const s2 = await call(w.agent.cookie, "POST", `/grow/contacts/exports/${eid}/seen`);
  assert.deepEqual([s2.status, new Date(s2.json.seenAt).getTime()], [200, new Date(s1.json.seenAt).getTime()], "idempotent");
  mine = await find(w.agent.cookie);
  assert.equal(mine.seen, true);
  assert.equal((await audits(w.brokerageId, "contact_export_seen")).length, 1);

  assert.equal((await call(w.pc.cookie, "GET", `/grow/contacts/exports/${eid}/download`)).json?.code, "EXPORT_DELIVERED_TO_OWNER");
  const rel = await call(w.agent.cookie, "POST", `/grow/contacts/exports/${eid}/release`, { recipientUserId: w.pc.user.id, reason: "Pia sends it to the vendor" });
  assert.equal(rel.status, 201, rel.text);
  const pcAfter = await find(w.pc.cookie);
  assert.deepEqual([pcAfter.releasedTo.map((r: { userId: number }) => r.userId), pcAfter.canDownload], [[w.pc.user.id], true]);
  assert.equal((await call(w.agent.cookie, "GET", `/grow/contacts/exports/${eid}/download`)).status, 200);
  assert.equal((await find(w.agent.cookie)).status, "downloaded");

  const p2 = await call(w.agent.cookie, "POST", "/grow/contacts/exports", {});
  await age(p2.json.exportId, 8);
  const old = (await call(w.agent.cookie, "GET", "/grow/contacts/exports")).json.exports.find((e: { exportId: number }) => e.exportId === p2.json.exportId);
  assert.deepEqual([old.status, old.ready, old.canDownload], ["expired", false, false]);
  const roOwn = await call(ro.agent.cookie, "POST", "/grow/contacts/exports", {});
  assert.equal(roOwn.status, 201, "read-only agent may prepare own export (read entitlement)");
  assert.equal((await call(ro.agent.cookie, "POST", `/grow/contacts/exports/${roOwn.json.exportId}/seen`)).status, 201);
});

test("t280u 3: held imports list — reason codes and release status; Pit Crew, read-only and unauthenticated refused", async () => {
  const w = await world("Held");
  const ro = await readOnly("HeldRO");
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(`First Name,Last Name,Email\nHeld,Ten${tag},held10-${tag}@example.com\n`)], { type: "text/csv" }), "c.csv");
  const up = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie: w.agent2.cookie }, body: form });
  const job = ((await up.json()) as { job: { id: number } }).job.id;
  await db.update(users).set({ isActive: false }).where(eq(users.id, w.agent2.user.id));
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${job}/execute`, {})).json?.code, "IMPORT_HELD_FOR_REVIEW");

  assert.equal(await anon("GET", "/import/held"), 401);
  for (const h of [{}, auth(w.agent.user.id)]) {
    const r = await call(w.pc.cookie, "GET", "/import/held", undefined, h);
    assert.deepEqual([r.status, r.json?.code, r.json?.reason], [403, "IMPORT_HELD_READ_FORBIDDEN", "PIT_CREW"]);
  }
  assert.equal((await call(ro.agent.cookie, "GET", "/import/held")).status, 403, "read-only agent lacks grow.import.execute");

  const a = await call(w.admin.cookie, "GET", "/import/held");
  assert.equal(a.status, 200, a.text);
  const ah = a.json.held.find((x: { importJobId: number }) => x.importJobId === job);
  assert.deepEqual([ah.releaseStatus, ah.reasonCode, ah.canAssignAnyOwner, ah.canAcceptForSelf, ah.release], ["held", "OWNER_INACTIVE", true, false, null]);
  // t282u: an Agent no longer sees another Agent's held import.
  assert.equal((await call(w.agent.cookie, "GET", "/import/held")).json.held.some((x: { importJobId: number }) => x.importJobId === job), false);
  assert.equal((await call(w.agent.cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "Accepted at review INSTR-10" })).status, 201);
  const rel = (await call(w.admin.cookie, "GET", "/import/held")).json.held.find((x: { importJobId: number }) => x.importJobId === job);
  assert.deepEqual([rel.releaseStatus, rel.reasonCode, rel.release.ownerUserId, rel.release.releasedByUserId, rel.release.authorityRef], ["released", null, w.agent.user.id, w.agent.user.id, "Accepted at review INSTR-10"]);
  assert.equal(await anon("GET", "/import/held"), 401);
});

test("t280u 4: audit metadata, access history and server-authoritative isAuditValueReader; values never returned; refusals logged", async () => {
  const w = await world("Audit");
  const ro = await readOnly("AuditRO");
  const r = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `olive-z-${tag}@example.com` }, auth(w.agent.user.id));
  assert.equal(r.status, 200, r.text);
  const edit = (await audits(w.brokerageId, "grow_contact_updated_on_authority")).sort((a, b) => b.id - a.id)[0].id;
  process.env.AE_AUDIT_VALUE_READER_USER_IDS = `${w.admin.user.id},${w.pc.user.id},${w.agent.user.id}`;
  try {
    const cap = async (c: string) => (await call(c, "GET", "/audit/capabilities")).json;
    assert.equal(await anon("GET", "/audit/capabilities"), 401);
    assert.deepEqual([(await cap(w.admin.cookie)).isAuditValueReader, (await cap(w.admin.cookie)).canReadAuditMetadata], [true, true]);
    assert.equal((await cap(w.agent.cookie)).isAuditValueReader, false, "listed Agent is still not a reader");
    assert.equal((await cap(w.pc.cookie)).isAuditValueReader, false, "listed Pit Crew is still not a reader");
    assert.equal((await cap(ro.admin.cookie)).isAuditValueReader, false, "unlisted admin");
    const c = await cap(w.admin.cookie);
    assert.deepEqual([c.valueRetentionDays, c.metadataRetentionDays], [730, 2555]);

    for (const path of ["/audit/metadata", "/audit/access-history"]) {
      assert.equal(await anon("GET", path), 401);
      for (const cookie of [w.agent.cookie, w.pc.cookie, ro.agent.cookie, w.agent2.cookie]) assert.equal((await call(cookie, "GET", path)).json?.code, "AUDIT_METADATA_RESTRICTED", path);
    }
    assert.ok((await audits(w.brokerageId, "audit_metadata_access_refused")).length >= 6, "refusals logged");

    const meta = await call(w.admin.cookie, "GET", `/audit/metadata?recordType=party&recordId=${w.partyId}`);
    assert.equal(meta.status, 200, meta.text);
    const e = meta.json.entries.find((x: { auditId: number }) => x.auditId === edit);
    assert.ok(e, meta.text);
    assert.equal(e.hasEncryptedValues, true);
    assert.equal(new Date(e.metadataRetainedUntil).getTime() - new Date(e.createdAt).getTime(), 2555 * 86_400_000);
    assert.equal(meta.text.includes("olive-z-"), false, "no values in metadata");
    assert.equal(meta.text.includes("enc:v1"), false, "no envelopes in metadata");
    assert.equal((await call(ro.admin.cookie, "GET", `/audit/metadata?recordType=party&recordId=${w.partyId}`)).json.entries.length, 0, "other brokerage sees nothing");

    assert.equal((await call(w.admin.cookie, "POST", `/audit/contact-values/${edit}`, { reason: "Complaint review CR-10" })).status, 200);
    assert.equal((await call(w.agent.cookie, "POST", `/audit/contact-values/${edit}`, { reason: "curious" })).status, 403);
    const hist = await call(w.admin.cookie, "GET", `/audit/access-history?auditId=${edit}`);
    const outcomes = hist.json.accesses.map((x: { outcome: string; userId: number }) => `${x.outcome}:${x.userId}`);
    assert.ok(outcomes.includes(`accessed:${w.admin.user.id}`) && outcomes.includes(`refused:${w.agent.user.id}`), hist.text);
    assert.equal(hist.json.accesses.find((x: { outcome: string }) => x.outcome === "accessed").reason, "Complaint review CR-10");
    assert.equal(hist.text.includes("olive-z-"), false);
    assert.equal((await call(w.admin.cookie, "GET", "/audit/access-history?auditId=abc")).json?.code, "AUDIT_ID_INVALID");
  } finally {
    delete process.env.AE_AUDIT_VALUE_READER_USER_IDS;
  }
});

test("t280u 5: History shows approved relationship wording, never a raw stored key", async () => {
  assert.equal(relationshipTypeWording("prospective_buyer"), "Prospective buyer");
  assert.equal(relationshipTypeWording("prospective_seller"), "Future seller");
  assert.equal(relationshipTypeWording("some_new_type"), "Some new type");
  assert.equal(relationshipStatusWording("PendingReview"), "To review");
  assert.equal(relationshipStatusWording("Historical"), "Past");
  assert.equal(relationshipStatusWording("merged_into_other"), "Merged into other");
  const w = await world("Hist");
  const created = new Date(Date.now() - 5 * 86_400_000);
  const types = ["prospective_buyer", "co_owner", "unknown_pending_review", "brand_new_kind"];
  for (const t of types) {
    await db.insert(growRelationships).values({ brokerageId: w.brokerageId, partyId: w.partyId, propertyId: w.propertyId, relationshipType: t, status: t === "co_owner" ? "PendingReview" : "Historical", createdAt: created, updatedAt: new Date() } as never);
  }
  const timeline = await getRelationshipTimeline(w.brokerageId, w.partyId, 200);
  const events = ((timeline as { events?: { summary: string; type: string }[] }).events ?? (timeline as unknown as { summary: string; type: string }[])).filter((e) => e.type.startsWith("PROPERTY_RELATIONSHIP"));
  const text = events.map((e) => e.summary).join("\n");
  assert.ok(text.includes("Relationship recorded: Prospective buyer"), text);
  assert.ok(text.includes("Relationship updated: Co-owner (To review)"), text);
  assert.ok(text.includes("Unknown, pending review") && text.includes("Brand new kind") && text.includes("(Past)"), text);
  assert.equal(/[a-z]+_[a-z_]+/.test(text), false, `no snake_case key: ${text}`);
  for (const k of ["PendingReview", "Historical"]) assert.equal(text.includes(k), false, k);
  // Through the Contact 360 HTTP read (the History the desktop renders).
  const http = await call(w.agent.cookie, "GET", `/grow/contacts/${w.partyId}`);
  assert.equal(http.status, 200, http.text);
  const tl = (http.json.timeline ?? []) as { summary: string; type: string }[];
  const httpText = tl.filter((e) => e.type.startsWith("PROPERTY_RELATIONSHIP")).map((e) => e.summary).join("\n");
  assert.ok(httpText.includes("Prospective buyer"), httpText);
  assert.equal(/[a-z]+_[a-z_]+/.test(httpText), false, httpText);
});
