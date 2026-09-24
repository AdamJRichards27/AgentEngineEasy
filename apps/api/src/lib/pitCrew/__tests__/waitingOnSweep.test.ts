// R-F1: ops sweep that auto-returns Pit Crew WAITING_ON items once
// waitingOnExpectedAt is earlier than now. Null expected-at is never
// returned. A second run is a no-op. A version conflict on one row does
// not abort the rest of the sweep.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, pitCrewAssignments } from "@aee/db";
import {
  claimWorkItem,
  startProgress,
  setWaitingOn,
  returnFromWaitingOn,
  sweepOverdueWaitingOn,
  isWaitingOnExpectedAtOverdue,
  PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL,
} from "../assignment.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let agent: DevLoginResult;
let brokerageId: number;
let propertyId: number;
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

function buildFinding(overrides: Partial<RiskFinding> = {}): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_PITCREW_WAITING_ON_SWEEP_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Test PC waiting-on sweep ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "PIT_CREW",
    ownerUserId: null,
    propertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the test thing.",
    resolutionRequirements: "The test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(propertyId),
    dedupKey: `TEST_PITCREW_WAITING_ON_SWEEP_RULE:${brokerageId}:SWEEP_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...overrides,
  };
}

async function createException(): Promise<string> {
  const finding = buildFinding();
  const result = await createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
  return result.exception.id;
}

async function parkWaitingOn(waitingOnExpectedAt?: Date): Promise<{ sourceRecordId: string; version: number }> {
  const sourceRecordId = await createException();
  let row = await claimWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId,
    expectedVersion: 0, actorUserId: agent.user.id,
  });
  row = await startProgress({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId,
    expectedVersion: row.version, actorUserId: agent.user.id,
  });
  row = await setWaitingOn({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId,
    expectedVersion: row.version, actorUserId: agent.user.id,
    waitingOnParty: "Buyer's solicitor",
    waitingOnNote: "Chasing the contract",
    waitingOnExpectedAt,
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

  const created = await createBrokerageWithUsers(baseUrl, `PitCrew WaitingOn Sweep ${Date.now()}`);
  agent = created.agent;
  brokerageId = created.brokerageId;
  propertyId = await createProperty(agent.cookie, "1 Waiting On Sweep St");
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("isWaitingOnExpectedAtOverdue is true only for WAITING_ON with an expected-at strictly before now", () => {
  const now = new Date("2026-09-24T10:00:00.000Z");
  const past = new Date("2026-09-24T09:59:59.000Z");
  const future = new Date("2026-09-24T10:00:01.000Z");
  assert.equal(isWaitingOnExpectedAtOverdue("WAITING_ON", past, now), true);
  assert.equal(isWaitingOnExpectedAtOverdue("WAITING_ON", now, now), false);
  assert.equal(isWaitingOnExpectedAtOverdue("WAITING_ON", future, now), false);
  assert.equal(isWaitingOnExpectedAtOverdue("WAITING_ON", null, now), false);
  assert.equal(isWaitingOnExpectedAtOverdue("IN_PROGRESS", past, now), false);
  assert.equal(isWaitingOnExpectedAtOverdue("CLAIMED", past, now), false);
  assert.equal(isWaitingOnExpectedAtOverdue("DONE", past, now), false);
});

test("sweep returns a WAITING_ON item whose expected-at is already past", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60 * 60 * 1000);
  const { sourceRecordId, version } = await parkWaitingOn(past);

  const result = await sweepOverdueWaitingOn({ now, brokerageId });
  assert.ok(result.returnedSourceRecordIds.includes(sourceRecordId), "past expected-at must be auto-returned");

  const row = await loadAssignment(sourceRecordId);
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.waitingOnParty, null);
  assert.equal(row.waitingOnNote, null);
  assert.equal(row.waitingOnSince, null);
  assert.equal(row.waitingOnExpectedAt, null);
  assert.equal(row.assignedToUserId, agent.user.id, "auto-return keeps the assignee");
  assert.equal(row.version, version + 1);

  const logs = await db.select().from(auditLogs).where(and(
    eq(auditLogs.recordType, "EXCEPTION"),
    eq(auditLogs.recordId, sourceRecordId),
    eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
  ));
  const ops = logs.find((entry) => entry.userEmail === PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL);
  assert.ok(ops, "expected an ops audit row for the auto-return");
  assert.equal(ops.userId, null);
  assert.equal(ops.previousValue, "WAITING_ON");
  assert.equal(ops.updatedValue, "IN_PROGRESS");
  assert.equal(ops.propertyId, propertyId);
});

test("sweep does not auto-return WAITING_ON when expected-at is null or still in the future", async () => {
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000);
  const openEnded = await parkWaitingOn(undefined);
  const later = await parkWaitingOn(future);

  const result = await sweepOverdueWaitingOn({ now, brokerageId });
  assert.equal(result.returnedSourceRecordIds.includes(openEnded.sourceRecordId), false);
  assert.equal(result.returnedSourceRecordIds.includes(later.sourceRecordId), false);

  const openRow = await loadAssignment(openEnded.sourceRecordId);
  assert.equal(openRow.status, "WAITING_ON");
  assert.equal(openRow.waitingOnExpectedAt, null);
  assert.equal(openRow.version, openEnded.version);

  const laterRow = await loadAssignment(later.sourceRecordId);
  assert.equal(laterRow.status, "WAITING_ON");
  assert.ok(laterRow.waitingOnExpectedAt);
  assert.equal(laterRow.version, later.version);
});

test("a second sweep is a no-op for an item already auto-returned", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 5 * 60 * 1000);
  const { sourceRecordId } = await parkWaitingOn(past);

  const first = await sweepOverdueWaitingOn({ now, brokerageId });
  assert.ok(first.returnedSourceRecordIds.includes(sourceRecordId));
  const afterFirst = await loadAssignment(sourceRecordId);

  const second = await sweepOverdueWaitingOn({ now, brokerageId });
  assert.equal(second.returnedSourceRecordIds.includes(sourceRecordId), false);
  const afterSecond = await loadAssignment(sourceRecordId);
  assert.equal(afterSecond.status, "IN_PROGRESS");
  assert.equal(afterSecond.version, afterFirst.version);
  assert.equal(afterSecond.waitingOnExpectedAt, null);

  const logs = await db.select().from(auditLogs).where(and(
    eq(auditLogs.recordType, "EXCEPTION"),
    eq(auditLogs.recordId, sourceRecordId),
    eq(auditLogs.action, "PC_WAITING_ON_RETURNED"),
    eq(auditLogs.userEmail, PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL),
  ));
  assert.equal(logs.length, 1, "re-running the sweep must not write a second ops audit row");
});

test("a version conflict skips that row and still returns the other overdue item", async () => {
  const now = new Date();
  const past = new Date(now.getTime() - 5 * 60 * 1000);
  const contested = await parkWaitingOn(past);
  const other = await parkWaitingOn(past);

  const result = await sweepOverdueWaitingOn({
    now,
    brokerageId,
    beforeReturn: async (row) => {
      if (row.sourceRecordId !== contested.sourceRecordId) return;
      await returnFromWaitingOn({
        brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId: row.sourceRecordId,
        expectedVersion: row.version, actorUserId: agent.user.id,
      });
    },
  });

  assert.equal(result.returnedSourceRecordIds.includes(contested.sourceRecordId), false);
  assert.ok(result.returnedSourceRecordIds.includes(other.sourceRecordId));
  assert.ok(result.skipped >= 1);

  const contestedRow = await loadAssignment(contested.sourceRecordId);
  assert.equal(contestedRow.status, "IN_PROGRESS", "the manual return still stands");
  assert.equal(contestedRow.waitingOnParty, null);
  assert.equal(contestedRow.version, contested.version + 1, "the losing sweep write must not bump version again");

  const otherRow = await loadAssignment(other.sourceRecordId);
  assert.equal(otherRow.status, "IN_PROGRESS");
  assert.equal(otherRow.version, other.version + 1);
  assert.equal(otherRow.waitingOnExpectedAt, null);
});
