// Owner t284u backend items — server authorisation tests (synthetic data, throwaway DB, test keys only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, entitlementGrants, users, auditLogs, ENTITLEMENT_KEYS } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin } from "./testSupport.js";
import { growRelationships, growOpportunities } from "@aee/db";
import { getRelationshipTimeline } from "../../lib/relationshipTimeline.js";
import { opportunityStageWording, opportunityStatusWording, opportunityTypeWording } from "../../lib/relationshipWording.js";

const KEY = "5".repeat(64); // synthetic test-only key
const KEY2 = "6".repeat(64); // synthetic test-only key (rotation target)
process.env.AE_AUDIT_VALUE_KEY = KEY;
process.env.AE_AUDIT_VALUE_KEY_ID = "k1";
const GROW = ENTITLEMENT_KEYS.filter((k) => k !== "run.access");
const tag = `t284-${Date.now()}`;
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


const nameOf = async (id: number) => {
  const [u] = await db.select({ f: users.firstName, l: users.lastName }).from(users).where(eq(users.id, id));
  return `${u.f ?? ""} ${u.l ?? ""}`.trim();
};

test("t284u 1: Agent cannot take another Agent's import by id; linked Agent can; Admin assigns; Pit Crew never", async () => {
  const w = await world("Self");
  const other = await world("SelfOther");
  const jobOther = await upload(w.agent2.cookie, "Other");
  const jobOwn = await upload(w.agent.cookie, "Own");
  // Own job held: recorded owner becomes an inactive colleague.
  const slug = `${tag} Self`.replace(/\s+/g, "-").toLowerCase();
  const leaver = await devLogin(base, { email: `leaver-${slug}@example.com`, firstName: "Lee", lastName: "Leaver", brokerageName: `${tag} Self` });
  await db.update(users).set({ role: "Agent" }).where(eq(users.id, leaver.user.id));
  assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${jobOwn}/owner`, { ownerUserId: leaver.user.id, authorityRef: "Initial INSTR" })).status, 201);
  await db.update(users).set({ isActive: false }).where(inArray(users.id, [leaver.user.id, w.agent2.user.id]));
  const take = (cookie: string, job: number, owner: number, h: Record<string, string> = {}) => call(cookie, "POST", `/import/jobs/${job}/owner`, { ownerUserId: owner, authorityRef: "Taking it INSTR-1" }, h);
  const refused = await take(w.agent.cookie, jobOther, w.agent.user.id);
  assert.deepEqual([refused.status, refused.json?.code], [403, "IMPORT_OWNER_NOT_LINKED"], "agent cannot take another agent's import by id");
  assert.ok((await audits(w.brokerageId, "import_job_owner_refused")).some((a) => a.recordId === String(jobOther) && a.userId === w.agent.user.id), "refusal audited");
  assert.equal((await take(w.agent.cookie, jobOwn, w.agent2.user.id)).json?.code, "IMPORT_OWNER_ASSIGN_FORBIDDEN", "agent cannot assign someone else");
  assert.equal((await take(other.agent.cookie, jobOwn, other.agent.user.id)).status, 404, "other brokerage: not found");
  for (const h of [{}, auth(w.agent.user.id)]) assert.equal((await take(w.pc.cookie, jobOwn, w.agent.user.id, h)).status, 403, "Pit Crew never");
  assert.equal((await fetch(`${base}/api/import/jobs/${jobOwn}/owner`, { method: "POST" })).status, 401);
  assert.equal((await take(w.agent.cookie, jobOwn, w.agent.user.id)).status, 201, "linked agent (started it) may take it");
  assert.equal((await take(w.admin.cookie, jobOther, w.agent.user.id)).status, 201, "admin assigns as agreed");
});

test("t284u 2: completed imports paginated; people are labels, never ids; neutral outside the brokerage", async () => {
  const w = await world("Page");
  const ro = await readOnly("PageRO");
  const other = await world("PageOther");
  const jobs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const j = await upload(w.agent.cookie, `P${i}`);
    assert.equal((await call(w.admin.cookie, "POST", `/import/jobs/${j}/owner`, { ownerUserId: w.agent.user.id, authorityRef: `Reviewed INSTR-${i}` })).status, 201);
    jobs.push(j);
  }
  await db.execute(sql`update import_jobs set status = 'COMPLETED' where id in (${sql.join(jobs.map((j) => sql`${j}`), sql`, `)})`);
  // One completed job whose initiator later moved brokerage -> neutral label.
  await db.execute(sql`update import_jobs set initiated_by_user_id = ${other.agent.user.id} where id = ${jobs[0]}`);
  await db.update(users).set({ firstName: "Zelda", lastName: `Elsewhere${tag}` }).where(eq(users.id, other.agent.user.id));

  const first = await call(w.admin.cookie, "GET", "/import/held?limit=2");
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.json.held, []);
  assert.deepEqual(first.json.completed.items.map((x: { importJobId: number }) => x.importJobId), [jobs[4], jobs[3]]);
  assert.equal(first.json.completed.nextCursor, jobs[3]);
  const p2 = await call(w.admin.cookie, "GET", `/import/held/completed?limit=2&cursor=${jobs[3]}`);
  assert.deepEqual(p2.json.items.map((x: { importJobId: number }) => x.importJobId), [jobs[2], jobs[1]]);
  const p3 = await call(w.admin.cookie, "GET", `/import/held/completed?limit=2&cursor=${p2.json.nextCursor}`);
  assert.deepEqual([p3.json.items.map((x: { importJobId: number }) => x.importJobId), p3.json.nextCursor], [[jobs[0]], null]);
  assert.equal((await call(w.admin.cookie, "GET", "/import/held")).json.completed.limit, 20, "default page size");
  for (const q of ["limit=0", "limit=101", "limit=abc", "cursor=-1", "cursor=x"]) assert.equal((await call(w.admin.cookie, "GET", `/import/held/completed?${q}`)).json?.code, "IMPORT_HELD_PAGE_INVALID", q);

  // Labels, never ids.
  const all = [...first.json.completed.items, ...p2.json.items, ...p3.json.items];
  const text = JSON.stringify(all);
  for (const k of ["UserId", "userId", "\"byUserId\"", "ownerUserId"]) assert.equal(text.includes(k), false, `no ${k} in ${text}`);
  const moved = p3.json.items[0];
  assert.deepEqual(moved.initiatedBy, { label: "Another user", isYou: false }, "neutral outside the brokerage");
  const otherName = await nameOf(other.agent.user.id);
  assert.ok(otherName.length > 0 && !text.includes(otherName), "no cross-brokerage name");
  const j4 = first.json.completed.items[0];
  assert.deepEqual([j4.initiatedBy.label, j4.release.releasedBy, j4.release.owner.label], [await nameOf(w.agent.user.id), { label: "You", isYou: true }, await nameOf(w.agent.user.id)]);
  const asAgent = await call(w.agent.cookie, "GET", "/import/held/completed?limit=10");
  const mine = asAgent.json.items.find((x: { importJobId: number }) => x.importJobId === jobs[4]);
  assert.deepEqual([mine.initiatedBy, mine.release.releasedBy.label], [{ label: "You", isYou: true }, await nameOf(w.admin.user.id)]);
  const moved2 = asAgent.json.items.find((x: { importJobId: number }) => x.importJobId === jobs[0]);
  assert.deepEqual([moved2.initiatedBy, moved2.recordedOwner], [{ label: "Another user", isYou: false }, { label: "You", isYou: true }], "agent still owns it; the outside initiator stays neutral");

  // Authorisation and isolation on the paginated route.
  assert.equal((await fetch(`${base}/api/import/held/completed`)).status, 401);
  for (const h of [{}, auth(w.agent.user.id)]) assert.equal((await call(w.pc.cookie, "GET", "/import/held/completed", undefined, h)).json?.reason, "PIT_CREW");
  assert.equal((await call(ro.agent.cookie, "GET", "/import/held/completed")).status, 403);
  const oth = await call(other.admin.cookie, "GET", "/import/held/completed?limit=100");
  assert.equal(oth.json.items.some((x: { importJobId: number }) => jobs.includes(x.importJobId)), false, "other brokerage sees none");
});

test("t284u 3: audit metadata for same-brokerage Admins only, every read logged; capability authoritative; values reader-only", async () => {
  const w = await world("Meta");
  const ro = await readOnly("MetaRO");
  const other = await world("MetaOther");
  delete process.env.AE_AUDIT_VALUE_READER_USER_IDS;
  const cap = async (c: string) => (await call(c, "GET", "/audit/capabilities")).json;
  assert.deepEqual([(await cap(w.admin.cookie)).canReadAuditMetadata, (await cap(w.admin.cookie)).canReadAuditAccessHistory, (await cap(w.admin.cookie)).isAuditValueReader], [true, true, false]);
  for (const c of [w.agent.cookie, w.pc.cookie, ro.agent.cookie]) assert.deepEqual([(await cap(c)).canReadAuditMetadata, (await cap(c)).canReadAuditAccessHistory], [false, false]);
  assert.equal((await fetch(`${base}/api/audit/capabilities`)).status, 401);
  const before = (await audits(w.brokerageId, "audit_metadata_viewed")).length;
  assert.equal((await call(w.admin.cookie, "GET", "/audit/metadata?limit=5")).status, 200);
  assert.equal((await call(w.admin.cookie, "GET", "/audit/access-history")).status, 200);
  const viewed = await audits(w.brokerageId, "audit_metadata_viewed");
  assert.equal(viewed.length, before + 2, "each admin read is logged");
  assert.ok(viewed.every((v) => v.userId === w.admin.user.id));
  for (const c of [w.agent.cookie, w.pc.cookie, ro.agent.cookie]) assert.equal((await call(c, "GET", "/audit/metadata")).json?.code, "AUDIT_METADATA_RESTRICTED");
  const mine = (await call(w.admin.cookie, "GET", "/audit/metadata?limit=200")).json.entries.map((e: { auditId: number }) => e.auditId);
  const theirs = (await call(other.admin.cookie, "GET", "/audit/metadata?limit=200")).json.entries.map((e: { auditId: number }) => e.auditId);
  assert.equal(mine.some((id: number) => theirs.includes(id)), false, "no cross-brokerage rows");
  // Non-reader admin cannot open values.
  const r = await call(w.pc.cookie, "PATCH", `/grow/contacts/${w.partyId}`, { email: `meta-${tag}@example.com` }, auth(w.agent.user.id));
  assert.equal(r.status, 200, r.text);
  const edit = (await audits(w.brokerageId, "grow_contact_updated_on_authority")).sort((a, b) => b.id - a.id)[0].id;
  assert.equal((await call(w.admin.cookie, "POST", `/audit/contact-values/${edit}`, { reason: "Checking a complaint" })).json?.code, "AUDIT_VALUES_RESTRICTED");
});

test("t284u 4: Opportunity History shows approved wording, never a raw key", async () => {
  assert.equal(opportunityTypeWording("PropertyManagement"), "Property management");
  assert.equal(opportunityStageWording("AppraisalBooked"), "Appraisal booked");
  assert.equal(opportunityStatusWording("Open"), "Open");
  assert.equal(opportunityStageWording("SomeNewStage"), "Some new stage");
  const w = await world("Opp");
  const created = new Date(Date.now() - 3 * 86_400_000);
  await db.insert(growOpportunities).values({ brokerageId: w.brokerageId, partyId: w.partyId, propertyId: w.propertyId, opportunityType: "PropertyManagement", stage: "AppraisalBooked", status: "Open", reason: "Owner moving interstate", createdAt: created, updatedAt: new Date() } as never);
  const http = await call(w.agent.cookie, "GET", `/grow/contacts/${w.partyId}`);
  assert.equal(http.status, 200, http.text);
  const text = (http.json.timeline as { type: string; summary: string }[]).filter((e) => e.type.startsWith("OPPORTUNITY")).map((e) => e.summary).join("\n");
  assert.ok(text.includes("Opportunity created: Property management"), text);
  assert.ok(text.includes("Opportunity updated: Property management (Appraisal booked/Open)"), text);
  for (const k of ["PropertyManagement", "AppraisalBooked"]) assert.equal(text.includes(k), false, k);
});
