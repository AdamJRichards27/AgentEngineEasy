// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). DB-backed
// coverage for assignment.ts: the full claim/assign/start/waiting-on/
// return/complete/release/handoff lifecycle (Section 9 and 12-14), the
// optimistic-concurrency guard, invalid-transition rejection, and that
// mutations are actually landing in the shared audit log (Section 33 /
// the "reuse lib/audit.ts, don't build a second history" mandate).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, auditLogs } from "@aee/db";
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
} from "../assignment.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let brokerageId: number;
let propertyId: number;
let counter = 0;
function nextSourceRecordId(): string {
  counter += 1;
  return `assignment-test-${counter}`;
}

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
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("claimWorkItem claims a never-touched item starting from the version-0 sentinel", async () => {
  const sourceRecordId = nextSourceRecordId();
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
  const sourceRecordId = nextSourceRecordId();
  await claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id });
  await assert.rejects(
    claimWorkItem({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 1, actorUserId: admin.user.id }),
    PitCrewTransitionError,
  );
});

test("a stale expectedVersion on an otherwise-valid transition throws PitCrewConcurrencyError", async () => {
  const sourceRecordId = nextSourceRecordId();
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
  const sourceRecordId = nextSourceRecordId();
  await assert.rejects(
    startProgress({ brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0, actorUserId: agent.user.id }),
    PitCrewTransitionError,
  );
});

test("full lifecycle: claim -> start -> waiting-on -> return -> complete", async () => {
  const sourceRecordId = nextSourceRecordId();
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
  const sourceRecordId = nextSourceRecordId();
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
  const sourceRecordId = nextSourceRecordId();
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

test("assignWorkItem lets a team lead assign an unclaimed item to someone else", async () => {
  const sourceRecordId = nextSourceRecordId();
  const row = await assignWorkItem({
    brokerageId, propertyId, sourceType: "EXCEPTION", sourceRecordId, expectedVersion: 0,
    actorUserId: admin.user.id, assigneeUserId: agent.user.id,
  });
  assert.equal(row.status, "CLAIMED");
  assert.equal(row.assignedToUserId, agent.user.id, "assignee, not the admin who did the assigning");
});
