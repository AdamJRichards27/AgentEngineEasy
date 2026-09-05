// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). DB-backed
// coverage for assignment.ts: the full claim/assign/start/waiting-on/
// return/complete/release/handoff lifecycle (Section 9 and 12-14), the
// optimistic-concurrency guard, invalid-transition rejection, that
// mutations are actually landing in the shared audit log (Section 33 /
// the "reuse lib/audit.ts, don't build a second history" mandate), and
// (STEP 2 security hardening) the cross-tenant IDOR fix in
// loadOrCreateOverlay/assignWorkItem: a sourceRecordId or assigneeUserId
// naming a real record from a DIFFERENT brokerage must never be accepted,
// even when every other id in the same request genuinely belongs to the
// caller.
//
// Every fixture here uses a REAL risk_exceptions row (via
// createOrUpdateException) rather than an arbitrary string as
// sourceRecordId -- loadOrCreateOverlay now requires sourceRecordId to
// name a real exception belonging to both the caller's propertyId and
// brokerageId before it will create or load an overlay row, so a synthetic
// id would fail every test in this file with PitCrewPropertyMismatchError.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, auditLogs, pitCrewAssignments } from "@aee/db";
import {
  claimWorkItem,
  assignWorkItem,
  startProgress,
  setWaitingOn,
  returnFromWaitingOn,
  completeWorkItem,
  releaseWorkItem,
  handoffWorkItem,
  PitCrewTransitionError,
  PitCrewConcurrencyError,
  PitCrewPropertyMismatchError,
  PitCrewAssigneeMismatchError,
} from "../assignment.js";
import { getPitCrewWorkspace } from "../queries.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

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
let brokerageId: number;
let propertyId: number;

// A second, wholly independent brokerage -- the "victim" in every
// cross-tenant test below. Its own property and its own real exception are
// what an attacker in `brokerageId` above must never be able to touch.
let otherAdmin: DevLoginResult;
let otherBrokerageId: number;
let otherPropertyId: number;

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

let fixtureCounter = 0;
function buildFinding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding> = {}): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_ASSIGNMENT_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC assignment finding ${fixtureCounter}`,
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
    dedupKey: `TEST_PITCREW_ASSIGNMENT_RULE:${targetBrokerageId}:ASSIGNMENT_SCOPE_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

/**
 * Creates a real risk_exceptions row scoped to the given property/
 * brokerage and returns its (real, UUID) id -- what every mutation below
 * uses as sourceRecordId, since loadOrCreateOverlay now requires that id
 * to actually resolve to a same-property, same-brokerage exception.
 */
async function createException(
  targetBrokerageId: number,
  targetPropertyId: number,
  overrides: Partial<RiskFinding> = {},
): Promise<string> {
  const finding = buildFinding(targetPropertyId, targetBrokerageId, overrides);
  const result = await createOrUpdateException(finding, targetBrokerageId, targetPropertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await createBrokerageWithUsers(baseUrl, `PitCrew Assignment ${Date.now()}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  propertyId = await createProperty(agent.cookie, "1 Assignment Test St");

  const other = await createBrokerageWithUsers(baseUrl, `PitCrew Assignment Other ${Date.now()}`);
  otherAdmin = other.admin;
  otherBrokerageId = other.brokerageId;
  otherPropertyId = await createProperty(other.agent.cookie, "1 Other Brokerage Assignment St");
});

after(async () => {
  await cleanupBrokerages([brokerageId, otherBrokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("claimWorkItem claims a never-touched item starting from the version-0 sentinel", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  const row = await claimWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId,
    expectedVersion: 0, actorUserId: agent.user.id,
  });
  assert.equal(row.status, "CLAIMED");
  assert.equal(row.assignedToUserId, agent.user.id);
  assert.equal(row.version, 1);
  assert.ok(row.claimedAt);

  const [logged] = await db.select().from(auditLogs).where(and(
    eq(auditLogs.recordType, "EXCEPTION"), eq(auditLogs.recordId, sourceRecordId), eq(auditLogs.action, "PC_CLAIMED"),
  ));
  assert.ok(logged, "expected a PC_CLAIMED row in the shared audit log");
  assert.equal(logged.propertyId, propertyId);
});

test("re-claiming an already-claimed item is an invalid transition, not a version conflict", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  await assert.rejects(
    claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 1, actorUserId: admin.user.id }),
    PitCrewTransitionError,
  );
});

test("a stale expectedVersion on an otherwise-valid transition throws PitCrewConcurrencyError", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  // CLAIMED -> IN_PROGRESS is a perfectly valid move; the only thing wrong
  // here is that this caller's belief about the current version (999) does
  // not match reality (1) -- exactly what a second, slower actor in a real
  // race would submit after someone else already moved the item.
  await assert.rejects(
    startProgress({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 999, actorUserId: agent.user.id }),
    PitCrewConcurrencyError,
  );
  const afterFailedAttempt = await startProgress({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 1, actorUserId: agent.user.id,
  });
  assert.equal(afterFailedAttempt.status, "IN_PROGRESS");
  assert.equal(afterFailedAttempt.version, 2);
});

test("starting progress on a never-claimed item is an invalid transition", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await assert.rejects(
    startProgress({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id }),
    PitCrewTransitionError,
  );
});

test("full lifecycle: claim -> start -> waiting-on -> return -> complete", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  let row = await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  assert.equal(row.status, "CLAIMED");

  row = await startProgress({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id });
  assert.equal(row.status, "IN_PROGRESS");

  row = await setWaitingOn({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id,
    waitingOnParty: "Buyer's solicitor", waitingOnNote: "Chasing signed contract", waitingOnExpectedAt: new Date("2026-12-01T00:00:00.000Z"),
  });
  assert.equal(row.status, "WAITING_ON");
  assert.equal(row.waitingOnParty, "Buyer's solicitor");
  assert.ok(row.waitingOnSince);

  row = await returnFromWaitingOn({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id });
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.waitingOnParty, null, "return should clear the waiting-on fields (Section 14)");
  assert.equal(row.waitingOnSince, null);

  row = await completeWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id });
  assert.equal(row.status, "DONE");
  assert.ok(row.completedAt);

  await assert.rejects(
    startProgress({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id }),
    PitCrewTransitionError,
    "DONE should be terminal",
  );
});

test("releaseWorkItem returns a claimed item to UNCLAIMED and clears assignment fields", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  let row = await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  row = await releaseWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: agent.user.id });
  assert.equal(row.status, "UNCLAIMED");
  assert.equal(row.assignedToUserId, null);
  assert.equal(row.claimedAt, null);

  // Released items are claimable again by anyone (Section 12).
  const reclaimed = await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version, actorUserId: admin.user.id });
  assert.equal(reclaimed.status, "CLAIMED");
  assert.equal(reclaimed.assignedToUserId, admin.user.id);
});

test("handoffWorkItem reassigns without round-tripping through UNCLAIMED", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  let row = await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  row = await handoffWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: row.version,
    actorUserId: agent.user.id, toUserId: admin.user.id, note: "Covering while I'm at settlement",
  });
  assert.equal(row.status, "CLAIMED", "handoff keeps the item CLAIMED, not UNCLAIMED (Section 13)");
  assert.equal(row.assignedToUserId, admin.user.id);
  assert.equal(row.handoffFromUserId, agent.user.id);
  assert.equal(row.handoffToUserId, admin.user.id);
  assert.equal(row.handoffNote, "Covering while I'm at settlement");
  assert.ok(row.handoffAt);
});

test("assignWorkItem lets a team lead assign an unclaimed item to someone else in the SAME brokerage", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  const row = await assignWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0,
    actorUserId: admin.user.id, assigneeUserId: agent.user.id,
  });
  assert.equal(row.status, "CLAIMED");
  assert.equal(row.assignedToUserId, agent.user.id, "assignee, not the admin who did the assigning");
});

// ---------------------------------------------------------------------
// STEP 2 security hardening: cross-tenant IDOR regression coverage.
// ---------------------------------------------------------------------

test("a real exception belonging to another brokerage cannot be claimed by pairing it with the caller's OWN property id (cross-tenant IDOR)", async () => {
  const foreignExceptionId = await createException(otherBrokerageId, otherPropertyId, { ownerType: "UNASSIGNED_QUEUE" });

  // brokerageId/propertyId here are brokerage A's own, entirely valid,
  // ids -- the only thing wrong with this request is that
  // sourceRecordId names brokerage B's exception, not one of A's own.
  await assert.rejects(
    claimWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: foreignExceptionId,
      expectedVersion: 0, actorUserId: agent.user.id,
    }),
    PitCrewPropertyMismatchError,
  );

  // No forged pit_crew_assignments row should exist for that exception id
  // at all -- neither under brokerage A's ids nor anyone else's.
  const [forged] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, foreignExceptionId)));
  assert.equal(forged, undefined, "no pit_crew_assignments row should ever be created for the foreign exception");
});

test("the same cross-tenant attempt is rejected even when assignWorkItem/startProgress/etc are tried instead of claim", async () => {
  const foreignExceptionId = await createException(otherBrokerageId, otherPropertyId, { ownerType: "UNASSIGNED_QUEUE" });

  await assert.rejects(
    assignWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: foreignExceptionId,
      expectedVersion: 0, actorUserId: admin.user.id, assigneeUserId: agent.user.id,
    }),
    PitCrewPropertyMismatchError,
  );
  await assert.rejects(
    startProgress({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: foreignExceptionId,
      expectedVersion: 0, actorUserId: agent.user.id,
    }),
    PitCrewPropertyMismatchError,
  );
});

test("after a rejected cross-tenant claim attempt, the victim brokerage's own workspace shows no contamination", async () => {
  const foreignExceptionId = await createException(otherBrokerageId, otherPropertyId, { ownerType: "UNASSIGNED_QUEUE" });

  await assert.rejects(
    claimWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: foreignExceptionId,
      expectedVersion: 0, actorUserId: agent.user.id,
    }),
    PitCrewPropertyMismatchError,
  );

  const victimWorkspace = await getPitCrewWorkspace(otherBrokerageId, otherAdmin.user.id);
  const item = victimWorkspace.unassignedWork.find((i) => i.sourceRecordId === foreignExceptionId);
  assert.ok(item, "the victim's own exception should still surface normally in their own workspace");
  assert.equal(item!.pcStatus, "UNCLAIMED", "must read as unclaimed -- not contaminated by brokerage A's forged claim attempt");
  assert.equal(item!.assignedToUserId, null);
  assert.equal(item!.claimedAt, null);
  assert.equal(item!.version, 0, "no overlay row should exist for the victim's exception at all");
});

test("a non-UUID-shaped sourceRecordId for sourceType EXCEPTION fails as PitCrewPropertyMismatchError, not a raw database error", async () => {
  await assert.rejects(
    claimWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: "not-a-real-uuid",
      expectedVersion: 0, actorUserId: agent.user.id,
    }),
    PitCrewPropertyMismatchError,
  );
});

test("assignWorkItem rejects an assigneeUserId that doesn't belong to the caller's brokerage", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);

  await assert.rejects(
    assignWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0,
      actorUserId: admin.user.id, assigneeUserId: otherAdmin.user.id,
    }),
    PitCrewAssigneeMismatchError,
  );

  // The assignee check runs before loadOrCreateOverlay, so a rejected
  // assign should never create an overlay row either.
  const [row] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  assert.equal(row, undefined, "no overlay row should be created when the assignee check fails");
});

test("assignWorkItem rejects an assigneeUserId that doesn't exist at all", async () => {
  const sourceRecordId = await createException(brokerageId, propertyId);
  await assert.rejects(
    assignWorkItem({
      brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0,
      actorUserId: admin.user.id, assigneeUserId: 999_999_999,
    }),
    PitCrewAssigneeMismatchError,
  );
});
