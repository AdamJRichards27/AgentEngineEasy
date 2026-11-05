// Owner t282u backend corrections — server authorisation tests (synthetic data, throwaway DB, test keys only).
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
const tag = `t282-${Date.now()}`;
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
async function upload(cookie: string, n: string) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(`First Name,Last Name,Email\nHeld,${n}${tag},${n.toLowerCase()}-${tag}@example.com\n`)], { type: "text/csv" }), `secret-${n}-${tag}.csv`);
  const up = await fetch(`${base}/api/import/jobs`, { method: "POST", headers: { cookie }, body: form });
  assert.equal(up.status, 201);
  return ((await up.json()) as { job: { id: number } }).job.id;
}

test("t282u 1+2: held imports — Agent sees only own; Admin sees brokerage; history kept after release and completion", async () => {
  const w = await world("HeldVis");
  const ro = await readOnly("HeldVisRO");
  const other = await world("HeldVisOther");
  const slug = `${tag} HeldVis`.replace(/\s+/g, "-").toLowerCase();
  const agent3 = await devLogin(base, { email: `agent3-${slug}@example.com`, firstName: "Third", lastName: "Agent", brokerageName: `${tag} HeldVis` });
  await db.update(users).set({ role: "Agent" }).where(eq(users.id, agent3.user.id));

  // Job A: started by agent, owner recorded as agent2, agent2 leaves -> held.
  const jobA = await upload(w.agent.cookie, "Alpha");
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${jobA}/owner`, { ownerUserId: w.agent2.user.id, authorityRef: "Initial owner INSTR-A" })).status, 201);
  // Job B: started by agent2 only.
  const jobB = await upload(w.agent2.cookie, "Bravo");
  await db.update(users).set({ isActive: false }).where(eq(users.id, w.agent2.user.id));
  for (const j of [jobA, jobB]) assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${j}/execute`, {})).json?.code, "IMPORT_HELD_FOR_REVIEW");

  const list = async (cookie: string, h: Record<string, string> = {}) => call(cookie, "GET", "/import/held", undefined, h);
  assert.equal((await fetch(`${base}/api/import/held`)).status, 401, "unauthenticated");
  for (const h of [{}, auth(w.agent.user.id)]) assert.deepEqual([(await list(w.pc.cookie, h)).status, (await list(w.pc.cookie, h)).json?.reason], [403, "PIT_CREW"]);
  assert.equal((await list(ro.agent.cookie)).status, 403, "read-only");
  const otherAdmin = await list(other.admin.cookie);
  assert.equal(otherAdmin.status, 200);
  assert.equal(otherAdmin.text.includes("secret-"), false, "other brokerage sees nothing");

  const adm = await list(w.admin.cookie);
  const ids = adm.json.held.map((x: { importJobId: number }) => x.importJobId);
  assert.ok(ids.includes(jobA) && ids.includes(jobB), "admin sees the brokerage");
  const ag = await list(w.agent.cookie);
  assert.deepEqual(ag.json.held.map((x: { importJobId: number }) => x.importJobId), [jobA], "agent sees only the import they started");
  assert.equal(ag.text.includes("Bravo"), false, "never another agent's filename");
  const a3 = await list(agent3.cookie);
  assert.deepEqual([a3.status, a3.json.held.length, a3.text.includes("secret-")], [200, 0, false], "unrelated agent sees nothing");

  // Release (agent accepts for self) -> released, with history and authority reference.
  assert.equal((await call(w.agent.cookie, "POST", `/import/jobs/${jobA}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "Accepted at review INSTR-A2" })).status, 201);
  let a = (await list(w.agent.cookie)).json.held.find((x: { importJobId: number }) => x.importJobId === jobA);
  assert.deepEqual([a.releaseStatus, a.reasonCode, a.release.authorityRef, a.release.releasedByUserId], ["released", null, "Accepted at review INSTR-A2", w.agent.user.id]);
  const events = a.history.map((e: { event: string }) => e.event);
  assert.ok(events.includes("held") && events.filter((e: string) => e === "owner_recorded").length === 2, JSON.stringify(a.history));
  assert.equal(a.history.find((e: { event: string }) => e.event === "held").reasonCode, "OWNER_INACTIVE");
  // Completed: still listed (history preserved).
  await db.execute(sql`update import_jobs set status = 'COMPLETED' where id = ${jobA}`);
  a = (await list(w.agent.cookie)).json.held.find((x: { importJobId: number }) => x.importJobId === jobA);
  assert.deepEqual([a.releaseStatus, a.jobStatus, a.canAcceptForSelf, a.canAssignAnyOwner], ["completed", "COMPLETED", false, false]);
  assert.ok((await list(w.admin.cookie)).json.held.some((x: { importJobId: number; releaseStatus: string }) => x.importJobId === jobA && x.releaseStatus === "completed"));
  // Admin view still shows job B held; Pit Crew still cannot release.
  for (const h of [{}, auth(w.agent.user.id)]) assert.equal((await call(w.pc.cookie, "POST", `/import/jobs/${jobB}/owner`, { ownerUserId: w.agent.user.id, authorityRef: "INSTR-B" }, h)).status, 403);
});

test("t282u 3: eligible delegates exclude Pit Crew, read-only/unsubscribed and inactive users; grant refused, revoke still works", async () => {
  const w = await world("Elig");
  const slug = `${tag} Elig`.replace(/\s+/g, "-").toLowerCase();
  const mk = async (n: string) => {
    const u = await devLogin(base, { email: `${n}-${slug}@example.com`, firstName: n, lastName: "User", brokerageName: `${tag} Elig` });
    await db.update(users).set({ role: "Agent" }).where(eq(users.id, u.user.id));
    return u;
  };
  const unsub = await mk("unsub");
  const gone = await mk("gone");
  // Brokerage-wide: everything except the send entitlement; send entitlement per user (seats).
  await setGrants(w.brokerageId, ["run.access", ...GROW.filter((k) => k !== "grow.opportunities.manage")]);
  for (const u of [w.agent.user.id, w.admin.user.id, w.agent2.user.id, gone.user.id, w.pc.user.id])
    await db.insert(entitlementGrants).values({ brokerageId: w.brokerageId, entitlementKey: "grow.opportunities.manage", granteeType: "user", granteeId: u, sourceType: "admin_override", status: "Active" });
  invalidateEntitlementCache(w.brokerageId);
  await db.update(users).set({ isActive: false }).where(eq(users.id, gone.user.id));
  const ap = await call(w.agent.cookie, "POST", "/grow/appraisals/from-contact", { partyId: w.partyId, propertyId: w.propertyId });
  assert.equal(ap.status, 201, ap.text);
  const id = ap.json.appraisal.id as number;
  const st = await call(w.agent.cookie, "GET", `/send-delegations?recordType=appraisal&recordId=${id}`);
  assert.equal(st.status, 200, st.text);
  const elig = st.json.eligibleDelegates.map((e: { userId: number }) => e.userId).sort();
  assert.deepEqual(elig, [w.admin.user.id, w.agent2.user.id].sort(), JSON.stringify(st.json.eligibleDelegates));
  const grant = (d: number) => call(w.agent.cookie, "POST", "/send-delegations", { recordType: "appraisal", recordId: id, delegateUserId: d, reason: "Covering this week" });
  for (const d of [unsub.user.id, gone.user.id, w.pc.user.id]) assert.equal((await grant(d)).json?.code, "SEND_DELEGATE_INVALID");
  assert.equal((await grant(w.agent2.user.id)).status, 201);
  // agent2 later loses the seat: revocation must still work.
  await db.delete(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, w.brokerageId), eq(entitlementGrants.granteeId, w.agent2.user.id)));
  invalidateEntitlementCache(w.brokerageId);
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations/revoke", { recordType: "appraisal", recordId: id, delegateUserId: w.agent2.user.id })).status, 200);
  assert.equal((await call(w.agent.cookie, "POST", "/send-delegations/renew", { recordType: "appraisal", recordId: id, delegateUserId: w.agent2.user.id, reason: "Again please" })).json?.code, "SEND_DELEGATE_INVALID");
});
