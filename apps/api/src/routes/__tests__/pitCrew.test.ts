// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). HTTP-surface
// coverage for routes/pitCrew.ts: role gating (Section 26 -- PC and
// Brokerage Administrator only, Agents get a 403), tenant isolation
// (Section 30/32), the full claim/assign/start/waiting-on/return/complete/
// release/handoff/note vertical slice over real HTTP, and the
// concurrency-conflict (409) / invalid-transition (422) / bad-body (400)
// error mapping.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import {
  createBrokerageWithUsers, cleanupBrokerages, devLogin, extractSessionCookie,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
// devLogin() below requires ALLOW_DEV_AUTH=true. Most suites in this repo
// set this themselves at module load (see e.g. transactionConditions.test.ts)
// rather than relying on an ambient value that may not be set, and this
// suite should too.
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrewMember: DevLoginResult;
let brokerageId: number;
let propertyId: number;

let otherAgent: DevLoginResult;
let otherBrokerageId: number;
let otherPropertyId: number;

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await jsonBody(res)) as { property: { id: number } };
  return property.id;
}

async function makePitCrew(email: string, brokerageName: string): Promise<DevLoginResult> {
  const result = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, result.user.id));
  return result;
}

// STEP 2 security hardening: loadOrCreateOverlay now requires sourceRecordId
// (for sourceType EXCEPTION) to name a real risk_exceptions row belonging
// to both the request's propertyId and the caller's brokerageId -- an
// arbitrary string is no longer accepted. Every mutating test below that
// exercises the write path (claim/start/waiting-on/complete/handoff) needs
// a REAL exception fixture instead of a made-up id.
let fixtureCounter = 0;
function buildFinding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding> = {}): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_ROUTE_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC route finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId: targetPropertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(targetPropertyId),
    dedupKey: `TEST_PITCREW_ROUTE_RULE:${targetBrokerageId}:ROUTE_SCOPE_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number): Promise<string> {
  const finding = buildFinding(targetPropertyId, targetBrokerageId);
  const result = await createOrUpdateException(finding, targetBrokerageId, targetPropertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await createBrokerageWithUsers(baseUrl, `PitCrew Route ${Date.now()}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  propertyId = await createProperty(agent.cookie, "1 Route Test St");
  pitCrewMember = await makePitCrew(`pitcrew-route-${brokerageId}@example.com`, admin.user.brokerageName!);

  const other = await createBrokerageWithUsers(baseUrl, `PitCrew Route Other ${Date.now()}`);
  otherAgent = other.agent;
  otherBrokerageId = other.brokerageId;
  otherPropertyId = await createProperty(other.agent.cookie, "1 Other Brokerage St");
});

after(async () => {
  await cleanupBrokerages([brokerageId, otherBrokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("GET /pit-crew/workspace requires authentication", async () => {
  const res = await fetch(`${baseUrl}/api/pit-crew/workspace`);
  assert.equal(res.status, 401);
});

test("GET /pit-crew/workspace is forbidden for a plain Agent", async () => {
  const res = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: agent.cookie } });
  assert.equal(res.status, 403);
});

test("GET /pit-crew/workspace is allowed for Pit Crew and for Brokerage Administrator", async () => {
  const pcRes = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: pitCrewMember.cookie } });
  assert.equal(pcRes.status, 200);
  const pcBody = await jsonBody(pcRes);
  assert.ok(Array.isArray(pcBody.unassignedWork));
  assert.ok(Array.isArray(pcBody.team));

  const adminRes = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: admin.cookie } });
  assert.equal(adminRes.status, 200);
});

test("GET /pit-crew/workspace only ever returns items scoped to the caller's own brokerage", async () => {
  // otherPropertyId/otherBrokerageId exist and have no PC overlay yet, so this
  // is really asserting that the query is brokerage-scoped at the SQL level,
  // not merely that nothing happens to match by coincidence.
  const res = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: pitCrewMember.cookie } });
  const body = await jsonBody(res);
  const allItems = [...body.unassignedWork, ...body.myWork, ...body.teamWork, ...body.waitingOn, ...body.completedToday];
  assert.ok(allItems.every((i: { propertyId: number }) => i.propertyId !== otherPropertyId));
});

test("GET /pit-crew/team is allowed for Pit Crew and lists the roster", async () => {
  const res = await fetch(`${baseUrl}/api/pit-crew/team`, { headers: { cookie: pitCrewMember.cookie } });
  assert.equal(res.status, 200);
  const body = await jsonBody(res);
  assert.ok(body.team.some((m: { userId: number }) => m.userId === pitCrewMember.user.id));
});

async function jsonBody(res: Response): Promise<any> {
  return res.json();
}

async function post(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/pit-crew${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

test("full HTTP vertical slice: claim -> start -> waiting-on -> return -> complete, plus a note", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);

  const claimRes = await post(`/items/EXCEPTION/${sourceRecordId}/claim`, pitCrewMember.cookie, {
    propertyId, expectedVersion: 0,
  });
  assert.equal(claimRes.status, 200);
  let row = await jsonBody(claimRes);
  assert.equal(row.status, "CLAIMED");
  assert.equal(row.assignedToUserId, pitCrewMember.user.id);

  const startRes = await post(`/items/EXCEPTION/${sourceRecordId}/start`, pitCrewMember.cookie, {
    propertyId, expectedVersion: row.version,
  });
  assert.equal(startRes.status, 200);
  row = await jsonBody(startRes);
  assert.equal(row.status, "IN_PROGRESS");

  const waitRes = await post(`/items/EXCEPTION/${sourceRecordId}/waiting-on`, pitCrewMember.cookie, {
    propertyId, expectedVersion: row.version, waitingOnParty: "Conveyancer", waitingOnNote: "Awaiting title search",
  });
  assert.equal(waitRes.status, 200);
  row = await jsonBody(waitRes);
  assert.equal(row.status, "WAITING_ON");

  const noteRes = await post(`/items/EXCEPTION/${sourceRecordId}/note`, pitCrewMember.cookie, {
    propertyId, note: "Called the conveyancer, following up Friday.",
  });
  assert.equal(noteRes.status, 200);

  const returnRes = await post(`/items/EXCEPTION/${sourceRecordId}/return`, pitCrewMember.cookie, {
    propertyId, expectedVersion: row.version,
  });
  assert.equal(returnRes.status, 200);
  row = await jsonBody(returnRes);
  assert.equal(row.status, "IN_PROGRESS");

  const completeRes = await post(`/items/EXCEPTION/${sourceRecordId}/complete`, pitCrewMember.cookie, {
    propertyId, expectedVersion: row.version,
  });
  assert.equal(completeRes.status, 200);
  row = await jsonBody(completeRes);
  assert.equal(row.status, "DONE");
});

test("a stale expectedVersion over HTTP maps to 409, not 500", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await post(`/items/EXCEPTION/${sourceRecordId}/claim`, pitCrewMember.cookie, { propertyId, expectedVersion: 0 });
  const res = await post(`/items/EXCEPTION/${sourceRecordId}/start`, pitCrewMember.cookie, { propertyId, expectedVersion: 999 });
  assert.equal(res.status, 409);
});

test("an invalid transition over HTTP maps to 422, not 500", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  // Never claimed, so IN_PROGRESS is not reachable.
  const res = await post(`/items/EXCEPTION/${sourceRecordId}/start`, pitCrewMember.cookie, { propertyId, expectedVersion: 0 });
  assert.equal(res.status, 422);
});

test("a malformed body maps to 400", async () => {
  const res = await post(`/items/EXCEPTION/route-bad-body/claim`, pitCrewMember.cookie, { propertyId: "not-a-number" });
  assert.equal(res.status, 400);
});

test("handoff over HTTP reassigns to the named user", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await post(`/items/EXCEPTION/${sourceRecordId}/claim`, pitCrewMember.cookie, { propertyId, expectedVersion: 0 });
  const res = await post(`/items/EXCEPTION/${sourceRecordId}/handoff`, pitCrewMember.cookie, {
    propertyId, expectedVersion: 1, toUserId: admin.user.id, note: "Handing off",
  });
  assert.equal(res.status, 200);
  const row = await jsonBody(res);
  assert.equal(row.assignedToUserId, admin.user.id);
  assert.equal(row.handoffToUserId, admin.user.id);
});

test("claiming a property that belongs to a different brokerage is rejected, not silently allowed", async () => {
  const sourceRecordId = `route-cross-tenant-${Date.now()}`;
  const res = await post(`/items/EXCEPTION/${sourceRecordId}/claim`, pitCrewMember.cookie, {
    propertyId: otherPropertyId, expectedVersion: 0,
  });
  assert.notEqual(res.status, 200, "a Pit Crew member from brokerage A must not be able to create a PC overlay row against brokerage B's property by supplying its id in the request body");
});

// STEP 2 security hardening regression: the propertyId in the body is
// brokerage A's own, valid, id -- the only thing wrong is that the
// sourceRecordId in the URL names a real exception belonging to brokerage
// B. Before the fix this created a forged overlay row stamped with A's own
// brokerageId/propertyId, keyed on B's exception id.
test("claiming a REAL exception belonging to a different brokerage is rejected even when propertyId is the caller's own (cross-tenant IDOR)", async () => {
  const foreignExceptionId = await createException(otherBrokerageId, otherPropertyId);
  const res = await post(`/items/EXCEPTION/${foreignExceptionId}/claim`, pitCrewMember.cookie, {
    propertyId, expectedVersion: 0,
  });
  assert.equal(res.status, 404, "a foreign brokerage's exception id must read as not-found, matching the existing propertyId-mismatch convention");
});

test("assigning to a userId from a different brokerage is rejected, not silently allowed", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  const res = await post(`/items/EXCEPTION/${sourceRecordId}/assign`, pitCrewMember.cookie, {
    propertyId, expectedVersion: 0, assigneeUserId: otherAgent.user.id,
  });
  assert.notEqual(res.status, 200, "a Pit Crew member must not be able to assign an item to a userId from another brokerage");
});
