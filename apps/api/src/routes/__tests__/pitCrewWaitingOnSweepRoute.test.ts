// R-F3: POST /pit-crew/ops/waiting-on/sweep is the human caller for
// sweepOverdueWaitingOn. Gates match every other Pit Crew route. The body
// is ignored: brokerageId, now, and actor come from the session. A second
// call is a no-op. GET /pit-crew/workspace does not sweep.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, entitlementGrants, pitCrewAssignments, users } from "@aee/db";
import { claimWorkItem, startProgress, setWaitingOn, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL } from "../../lib/pitCrew/assignment.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import {
  createBrokerageWithUsers,
  cleanupBrokerages,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
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
let fixtureCounter = 0;

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function makePitCrew(email: string, brokerageName: string): Promise<DevLoginResult> {
  const result = await devLogin(baseUrl, { email, firstName: "Pit", lastName: "Crew", brokerageName });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, result.user.id));
  return result;
}

function buildFinding(targetPropertyId: number, targetBrokerageId: number): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_WAITING_ON_SWEEP_ROUTE_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC sweep route ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
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
    dedupKey: `TEST_PITCREW_WAITING_ON_SWEEP_ROUTE_RULE:${targetBrokerageId}:SWEEP_ROUTE_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number): Promise<string> {
  const finding = buildFinding(targetPropertyId, targetBrokerageId);
  const result = await createOrUpdateException(finding, targetBrokerageId, targetPropertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

async function parkWaitingOn(input: {
  brokerageId: number;
  propertyId: number;
  actorUserId: number;
  waitingOnExpectedAt?: Date;
}): Promise<{ sourceRecordId: string; version: number }> {
  const sourceRecordId = await createException(input.brokerageId, input.propertyId);
  let row = await claimWorkItem({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: 0,
    actorUserId: input.actorUserId,
  });
  row = await startProgress({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: row.version,
    actorUserId: input.actorUserId,
  });
  row = await setWaitingOn({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: "EXCEPTION",
    sourceRecordId,
    expectedVersion: row.version,
    actorUserId: input.actorUserId,
    waitingOnParty: "Buyer's solicitor",
    waitingOnNote: "Chasing the contract",
    waitingOnExpectedAt: input.waitingOnExpectedAt,
  });
  assert.equal(row.status, "WAITING_ON");
  return { sourceRecordId, version: row.version };
}

async function loadAssignment(sourceRecordId: string) {
  const [row] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  assert.ok(row, "expected an overlay row");
  return row;
}

function sweep(cookie?: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${baseUrl}/api/pit-crew/ops/waiting-on/sweep`, {
    method: "POST",
    headers,
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
}

async function setRunAccess(targetBrokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, targetBrokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(targetBrokerageId);
}

describe("POST /pit-crew/ops/waiting-on/sweep", { concurrency: 1 }, () => {
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

    const created = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Route ${Date.now()}`);
    admin = created.admin;
    agent = created.agent;
    brokerageId = created.brokerageId;
    propertyId = await createProperty(agent.cookie, "1 Sweep Route St");
    pitCrewMember = await makePitCrew(`pitcrew-sweep-route-${brokerageId}@example.com`, admin.user.brokerageName!);

    const other = await createBrokerageWithUsers(baseUrl, `PitCrew Sweep Route Other ${Date.now()}`);
    otherAgent = other.agent;
    otherBrokerageId = other.brokerageId;
    otherPropertyId = await createProperty(other.agent.cookie, "1 Other Sweep Route St");
  });

  after(async () => {
    await setRunAccess(brokerageId, true);
    await cleanupBrokerages([brokerageId, otherBrokerageId]);
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("requires authentication", async () => {
    const res = await fetch(`${baseUrl}/api/pit-crew/ops/waiting-on/sweep`, { method: "POST" });
    assert.equal(res.status, 401);
  });

  test("is forbidden for a plain Agent", async () => {
    const res = await sweep(agent.cookie);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "Forbidden");
  });

  test("a Brokerage Administrator may trigger the sweep", async () => {
    const res = await sweep(admin.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { returned: number };
    assert.equal(body.returned, 0);
  });

  test("revoked run.access is 403 Not entitled, and restoring the grant allows the sweep", async () => {
    await setRunAccess(brokerageId, false);
    try {
      const res = await sweep(pitCrewMember.cookie);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: string; entitlementKey?: string };
      assert.equal(body.error, "Not entitled");
      assert.equal(body.entitlementKey, "run.access");
    } finally {
      await setRunAccess(brokerageId, true);
    }

    const restored = await sweep(pitCrewMember.cookie);
    assert.equal(restored.status, 200);
  });

  test("returns only this brokerage's overdue waiting-on items, ignores the body, and is idempotent", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const overdue = await parkWaitingOn({
      brokerageId,
      propertyId,
      actorUserId: pitCrewMember.user.id,
      waitingOnExpectedAt: past,
    });
    const openEnded = await parkWaitingOn({
      brokerageId,
      propertyId,
      actorUserId: pitCrewMember.user.id,
    });
    const later = await parkWaitingOn({
      brokerageId,
      propertyId,
      actorUserId: pitCrewMember.user.id,
      waitingOnExpectedAt: future,
    });
    const foreign = await parkWaitingOn({
      brokerageId: otherBrokerageId,
      propertyId: otherPropertyId,
      actorUserId: otherAgent.user.id,
      waitingOnExpectedAt: past,
    });

    const workspace = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: pitCrewMember.cookie } });
    assert.equal(workspace.status, 200);
    const beforeSweep = await loadAssignment(overdue.sourceRecordId);
    assert.equal(beforeSweep.status, "WAITING_ON");
    assert.equal(beforeSweep.version, overdue.version);

    const res = await sweep(pitCrewMember.cookie, {
      brokerageId: otherBrokerageId,
      now: future.toISOString(),
      actor: { actorUserId: otherAgent.user.id, actorEmail: PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      scanned: number;
      returned: number;
      skipped: number;
      returnedSourceRecordIds: string[];
    };
    assert.deepEqual(body, {
      scanned: 1,
      returned: 1,
      skipped: 0,
      returnedSourceRecordIds: [overdue.sourceRecordId],
    });

    const returnedRow = await loadAssignment(overdue.sourceRecordId);
    assert.equal(returnedRow.status, "IN_PROGRESS");
    assert.equal(returnedRow.waitingOnParty, null);
    assert.equal(returnedRow.waitingOnNote, null);
    assert.equal(returnedRow.waitingOnSince, null);
    assert.equal(returnedRow.waitingOnExpectedAt, null);
    assert.equal(returnedRow.version, overdue.version + 1);
    assert.equal(returnedRow.assignedToUserId, pitCrewMember.user.id);

    const openRow = await loadAssignment(openEnded.sourceRecordId);
    assert.equal(openRow.status, "WAITING_ON");
    assert.equal(openRow.waitingOnExpectedAt, null);
    assert.equal(openRow.version, openEnded.version);

    const laterRow = await loadAssignment(later.sourceRecordId);
    assert.equal(laterRow.status, "WAITING_ON");
    assert.ok(laterRow.waitingOnExpectedAt);
    assert.equal(laterRow.version, later.version);

    const foreignRow = await loadAssignment(foreign.sourceRecordId);
    assert.equal(foreignRow.status, "WAITING_ON");
    assert.ok(foreignRow.waitingOnExpectedAt);
    assert.equal(foreignRow.version, foreign.version);
    assert.equal(body.returnedSourceRecordIds.includes(foreign.sourceRecordId), false);

    const logs = await db.select().from(auditLogs).where(and(
      eq(auditLogs.recordType, "EXCEPTION"),
      eq(auditLogs.recordId, overdue.sourceRecordId),
      eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
    ));
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.userId, pitCrewMember.user.id);
    assert.equal(logs[0]!.userEmail, pitCrewMember.user.email);
    assert.equal(logs[0]!.previousValue, "WAITING_ON");
    assert.equal(logs[0]!.updatedValue, "IN_PROGRESS");
    assert.equal(logs[0]!.propertyId, propertyId);
    assert.notEqual(logs[0]!.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);

    const second = await sweep(pitCrewMember.cookie);
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { returned: number; returnedSourceRecordIds: string[] };
    assert.equal(secondBody.returned, 0);
    assert.equal(secondBody.returnedSourceRecordIds.includes(overdue.sourceRecordId), false);

    const afterSecond = await loadAssignment(overdue.sourceRecordId);
    assert.equal(afterSecond.status, "IN_PROGRESS");
    assert.equal(afterSecond.version, returnedRow.version);
    const logsAfter = await db.select().from(auditLogs).where(and(
      eq(auditLogs.recordType, "EXCEPTION"),
      eq(auditLogs.recordId, overdue.sourceRecordId),
      eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
    ));
    assert.equal(logsAfter.length, 1);
  });
});
