// AE GROW Pilot Readiness WP1 — hardening coverage for routes/contacts.ts:
//   P2-1: every contact-intelligence mutation (role add/remove, household relationship
//         add/remove, commitment create/complete/cancel) writes an ids-only audit row, the
//         canceller is recorded, and complete/cancel is a conditional UPDATE so concurrent
//         completes cannot both succeed or write duplicate task_completion activities.
//   P2-4: free-text length limits and non-numeric id handling (400, never 500).
// Same real-HTTP conventions as contacts.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, entitlementGrants, growActivities, growCommitments } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let partyId: number;
let relatedPartyId: number;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `WP1 Contacts Hardening ${suffix}`);
  for (const key of ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.activities.manage"]) {
    await grant(A.brokerageId, key);
  }
  const propertyId = await createProperty(A.agent.cookie, `1 Hardening Rd ${suffix}`);
  partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Audit", lastName: "Subject" });
  relatedPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Audit", lastName: "Related" });
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Party", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

function call(method: string, path: string, body?: unknown, cookie = A.agent.cookie) {
  return fetch(`${baseUrl}/api/grow/contacts${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function auditRowsFor(recordType: string, recordId: number) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, A.brokerageId), eq(auditLogs.recordType, recordType), eq(auditLogs.recordId, String(recordId))));
}

async function createCommitment(description: string): Promise<number> {
  const res = await call("POST", `/${partyId}/commitments`, { description, dueAt: "2027-06-01" });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { commitment: { id: number } }).commitment.id;
}

test("WP1 P2-1: role assign/remove and household relationship create/remove are audited with ids/enum values only", async () => {
  const roleRes = await call("POST", `/${partyId}/roles`, { role: "Prospect" });
  assert.equal(roleRes.status, 201, await roleRes.clone().text());
  const roleId = ((await roleRes.json()) as { role: { id: number } }).role.id;
  const [assigned] = await auditRowsFor("grow_contact_role", roleId);
  assert.ok(assigned, "role assignment must be audited");
  assert.equal(assigned.action, "grow_contact_role_assigned");
  assert.equal(assigned.userId, A.agent.user.id);
  assert.deepEqual(JSON.parse(assigned.updatedValue!), { partyId, role: "Prospect" });

  // An idempotent re-assign is a no-op and writes no second audit row.
  assert.equal((await call("POST", `/${partyId}/roles`, { role: "Prospect" })).status, 200);
  assert.equal((await auditRowsFor("grow_contact_role", roleId)).length, 1);

  assert.equal((await call("DELETE", `/${partyId}/roles/Prospect`)).status, 204);
  const roleAudits = await auditRowsFor("grow_contact_role", roleId);
  const roleRemoved = roleAudits.find((r) => r.action === "grow_contact_role_removed");
  assert.ok(roleRemoved, "role removal must be audited");
  assert.deepEqual(JSON.parse(roleRemoved.previousValue!), { partyId, role: "Prospect" });

  const relRes = await call("POST", `/${partyId}/relationships`, {
    relatedPartyId,
    relationshipType: "spouse_partner",
    note: "free text that must never be copied into the audit trail",
  });
  assert.equal(relRes.status, 201, await relRes.clone().text());
  const relationshipId = ((await relRes.json()) as { relationship: { id: number } }).relationship.id;

  const [created] = await auditRowsFor("grow_contact_relationship", relationshipId);
  assert.ok(created, "relationship creation must be audited");
  assert.equal(created.action, "grow_contact_relationship_created");
  assert.deepEqual(JSON.parse(created.updatedValue!), { partyId, relatedPartyId, relationshipType: "spouse_partner" });
  assert.ok(!created.updatedValue!.includes("free text"), "notes are never copied into the audit trail");

  assert.equal((await call("DELETE", `/relationships/${relationshipId}`)).status, 204);
  const removed = (await auditRowsFor("grow_contact_relationship", relationshipId)).find((r) => r.action === "grow_contact_relationship_removed");
  assert.ok(removed, "relationship removal must be audited");
  assert.equal(removed.userId, A.agent.user.id);
  assert.deepEqual(JSON.parse(removed.previousValue!), { partyId, relatedPartyId, relationshipType: "spouse_partner" });
});

test("WP1 P2-1: commitment create / complete / cancel are audited, and the canceller is recorded in the audit row", async () => {
  const toComplete = await createCommitment("private free-text commitment description");
  const [created] = await auditRowsFor("grow_commitment", toComplete);
  assert.ok(created);
  assert.equal(created.action, "grow_commitment_created");
  assert.equal(created.userId, A.agent.user.id);
  assert.ok(!created.updatedValue!.includes("private free-text"), "descriptions are never copied into the audit trail");

  assert.equal((await call("PATCH", `/commitments/${toComplete}`, { status: "Completed" })).status, 200);
  const completed = (await auditRowsFor("grow_commitment", toComplete)).find((r) => r.action === "grow_commitment_completed");
  assert.ok(completed);
  assert.deepEqual(JSON.parse(completed.updatedValue!), { status: "Completed", completedByUserId: A.agent.user.id });

  const toCancel = await createCommitment("to be cancelled");
  // The admin (a different user from the creator) cancels it.
  const cancelRes = await call("PATCH", `/commitments/${toCancel}`, { status: "Cancelled", cancelReason: "sensitive reason text" }, A.admin.cookie);
  assert.equal(cancelRes.status, 200);
  const cancelled = (await auditRowsFor("grow_commitment", toCancel)).find((r) => r.action === "grow_commitment_cancelled");
  assert.ok(cancelled, "cancellation must be audited");
  assert.equal(cancelled.userId, A.admin.user.id);
  assert.deepEqual(JSON.parse(cancelled.updatedValue!), { status: "Cancelled", cancelledByUserId: A.admin.user.id });
  assert.ok(!cancelled.updatedValue!.includes("sensitive"), "cancel reasons are never copied into the audit trail");
});

test("WP1 P2-1: concurrent completes of the same commitment -- exactly one succeeds, the rest get 409, and exactly one task_completion activity is written", async () => {
  const commitmentId = await createCommitment(`race commitment ${suffix}`);
  const summary = `Commitment completed: race commitment ${suffix}`;

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      call("PATCH", `/commitments/${commitmentId}`, { status: "Completed" }, i % 2 === 0 ? A.agent.cookie : A.admin.cookie),
    ),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one complete may win: ${statuses.join(",")}`);
  assert.equal(statuses.filter((s) => s === 409).length, 7, `every other complete must be a 409: ${statuses.join(",")}`);

  const activities = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.brokerageId, A.brokerageId), eq(growActivities.activityType, "task_completion"), eq(growActivities.summary, summary)));
  assert.equal(activities.length, 1, "no duplicate task_completion activity");

  const completedAudits = (await auditRowsFor("grow_commitment", commitmentId)).filter((r) => r.action === "grow_commitment_completed");
  assert.equal(completedAudits.length, 1);

  // A complete racing a cancel likewise has exactly one winner.
  const racing = await createCommitment(`complete-vs-cancel ${suffix}`);
  const [c1, c2] = await Promise.all([
    call("PATCH", `/commitments/${racing}`, { status: "Completed" }),
    call("PATCH", `/commitments/${racing}`, { status: "Cancelled" }, A.admin.cookie),
  ]);
  assert.deepEqual([c1.status, c2.status].sort(), [200, 409]);
  const [row] = await db.select().from(growCommitments).where(eq(growCommitments.id, racing));
  assert.ok(row.status === "Completed" || row.status === "Cancelled");
});

test("WP1 P2-4: commitment description / cancelReason / relationship note length limits, and non-numeric ids return 400 (never 500)", async () => {
  const tooLong = "x".repeat(2001);
  assert.equal((await call("POST", `/${partyId}/commitments`, { description: tooLong, dueAt: "2027-06-01" })).status, 400);
  assert.equal((await call("POST", `/${partyId}/commitments`, { description: "x".repeat(2000), dueAt: "2027-06-01" })).status, 201);

  const commitmentId = await createCommitment("length-limit cancel");
  assert.equal((await call("PATCH", `/commitments/${commitmentId}`, { status: "Cancelled", cancelReason: tooLong })).status, 400);
  assert.equal((await call("PATCH", `/commitments/${commitmentId}`, { status: "Cancelled", cancelReason: 42 })).status, 400);
  const [stillOpen] = await db.select().from(growCommitments).where(eq(growCommitments.id, commitmentId));
  assert.equal(stillOpen.status, "Open", "a rejected cancel must not change the commitment");

  for (const body of [
    { description: "bad property", dueAt: "2027-06-01", propertyId: "abc" },
    { description: "bad opportunity", dueAt: "2027-06-01", opportunityId: "abc" },
    { description: "fractional property", dueAt: "2027-06-01", propertyId: 1.5 },
  ]) {
    const res = await call("POST", `/${partyId}/commitments`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }

  assert.equal((await call("POST", `/${partyId}/relationships`, { relatedPartyId, relationshipType: "x", note: tooLong })).status, 400);
  assert.equal((await call("PATCH", "/commitments/abc", { status: "Completed" })).status, 400);
  assert.equal((await call("DELETE", "/relationships/abc")).status, 400);
  assert.equal((await call("DELETE", "/abc/roles/Prospect")).status, 400);
  assert.equal((await call("POST", "/abc/roles", { role: "Prospect" })).status, 400);
  assert.equal((await call("POST", `/${partyId}/relationships`, { relatedPartyId: "abc", relationshipType: "x" })).status, 400);
});
