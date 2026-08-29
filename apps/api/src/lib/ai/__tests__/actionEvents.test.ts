// AI Governance, Authority & Action Control Architecture -- Stage G7.
//
// Pre-WAE Gate Remediation, F-03: real-database regression coverage for
// the causationId/UUID domain-event audit failure. Stage G10's own
// governance.test.ts (apps/api/src/lib/ai/__tests__/governance.test.ts)
// configures an InMemoryEventStore, so it exercises publishAiActionEvent's
// call shape but never the real Postgres uuid-column validation -- that is
// exactly why the bug shipped undetected. These tests configure the real
// DrizzleEventStore (via apps/api/src/lib/events.ts's configureEvents(),
// the same function app.ts calls at real startup) and assert directly
// against the domain_events table.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, users, properties, aiActionRequests, domainEvents } from "@aee/db";
import { configureEvents } from "../../events.js";
import { publishAiActionEvent } from "../actionEvents.js";
import {
  proposeAIAction,
  approveAIActionRequest,
  rejectAIActionRequest,
  getAIActionRequest,
} from "../actionRequests.js";
import { executeAIAction } from "../executionGateway.js";
import type { PolicyActor } from "../policyEngine.js";

configureEvents();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type EventRow = typeof domainEvents.$inferSelect;

// ---------------------------------------------------------------------
// Fixtures -- same throwaway brokerage/user/property + t.after() teardown
// pattern used by governance.test.ts and lib/entitlements/__tests__.
// ---------------------------------------------------------------------

async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: string): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ authProviderId: `test-${suffix}`, email: `test-${suffix}@example.com`, role, brokerageId })
    .returning();
  return row.id;
}

async function createProperty(brokerageId: number, agentId: number): Promise<number> {
  const [row] = await db
    .insert(properties)
    .values({ brokerageId, agentId, formattedAddress: "1 F-03 Test St, Testville" })
    .returning();
  return row.id;
}

function actorOf(id: number, role: string, brokerageId: number): PolicyActor {
  return { id, role, brokerageId };
}

// domain_events rows from publishAiActionEvent always carry propertyId: null,
// so they must be cleaned up by brokerageId directly -- the property-scoped
// delete in routes/__tests__/testSupport.ts's cleanupBrokerages() (fixed
// alongside this file, see the Pre-WAE Gate Remediation Report) would miss
// them entirely.
async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

async function eventsFor(requestId: number, brokerageId: number): Promise<EventRow[]> {
  const rows = await db.select().from(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  return rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.requestId === requestId);
}

// ---------------------------------------------------------------------
// 1. The proven defect: causationId as a bare stringified integer
//    (`String(row.id)`) crashes on insert against the uuid-typed
//    domain_events.causation_id column. An in-memory store never
//    validates column types, so this could only be caught here.
// ---------------------------------------------------------------------

test("F-03: publishAiActionEvent persists a real domain_events row for AI_ACTION_PROPOSED instead of silently failing", async (t) => {
  const brokerageId = await createBrokerage("F-03 - propose persists");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "F-03 regression test note" },
  });
  assert.equal(decision.allowed, true, `propose should be allowed: ${decision.reason ?? ""}`);
  assert.ok(request);

  const rows = await eventsFor(request!.id, brokerageId);
  const proposed = rows.find((r) => r.eventType === "AI_ACTION_PROPOSED");
  assert.ok(proposed, "AI_ACTION_PROPOSED must be persisted to domain_events -- before the fix this insert threw 22P02 and was swallowed, leaving zero rows");
});

test("F-03: the persisted event's causationId is null, matching the same convention used by every other publishDomainEvent call site in this codebase (aml.ts, transactions.ts, offers.ts, etc.), not a bare stringified integer", async (t) => {
  const brokerageId = await createBrokerage("F-03 - causationId null");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "causation test" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  assert.equal(proposed.causationId, null);
});

test("F-03: the persisted event's correlationId is a well-formed UUID (domain_events.correlation_id is NOT NULL and uuid-typed)", async (t) => {
  const brokerageId = await createBrokerage("F-03 - correlationId uuid");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "correlation test" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  assert.ok(proposed.correlationId, "correlationId must be present");
  assert.match(proposed.correlationId, UUID_RE);
});

test("F-03: idempotencyKey matches the documented ai_action_request:{id}:{eventType} pattern", async (t) => {
  const brokerageId = await createBrokerage("F-03 - idempotencyKey");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "idempotency key test" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  assert.equal(proposed.idempotencyKey, `ai_action_request:${request!.id}:AI_ACTION_PROPOSED`);
});

test("F-03: actorType/actorId/brokerageId on the persisted event correctly identify a USER actor (tenant- and actor-correct)", async (t) => {
  const brokerageId = await createBrokerage("F-03 - actor correctness user");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "actor correctness test" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  assert.equal(proposed.actorType, "USER");
  assert.equal(proposed.actorId, agentId);
  assert.equal(proposed.brokerageId, brokerageId);
});

test("F-03: actorType is AI on the persisted event when the request's actorType is AI", async (t) => {
  const brokerageId = await createBrokerage("F-03 - actor correctness ai");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "AI",
    rawInput: { propertyId, note: "AI-initiated note" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  assert.equal(proposed.actorType, "AI");
});

// ---------------------------------------------------------------------
// 2. All 7 AI_ACTION_* lifecycle stages persist through the real store.
// ---------------------------------------------------------------------

test("F-03: an auto-execute-eligible action (LOW risk, PROPERTY_NOTE_ADD) publishes exactly one AI_ACTION_PROPOSED event and no AI_ACTION_APPROVAL_REQUIRED", async (t) => {
  const brokerageId = await createBrokerage("F-03 - auto-execute eligible");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "auto-execute test" },
  });
  assert.equal(decision.requiresApproval, false);
  const rows = await eventsFor(request!.id, brokerageId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, "AI_ACTION_PROPOSED");
});

test("F-03: a SYSTEM_CHANGE action (WORKFLOW_VERSION_ACTIVATE) publishes both AI_ACTION_PROPOSED and AI_ACTION_APPROVAL_REQUIRED at propose time, each with its own valid causationId/correlationId", async (t) => {
  const brokerageId = await createBrokerage("F-03 - approval required");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  const { request, decision } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.equal(decision.requiresApproval, true);
  const rows = await eventsFor(request!.id, brokerageId);
  const types = rows.map((r) => r.eventType).sort();
  assert.deepEqual(types, ["AI_ACTION_APPROVAL_REQUIRED", "AI_ACTION_PROPOSED"]);
  for (const row of rows) {
    assert.equal(row.causationId, null);
    assert.match(row.correlationId, UUID_RE);
  }
});

test("F-03: approveAIActionRequest publishes AI_ACTION_APPROVED with the approver's id in metadata", async (t) => {
  const brokerageId = await createBrokerage("F-03 - approve");
  t.after(() => cleanupBrokerage(brokerageId));
  const proposerId = await createUser(brokerageId, "Brokerage Administrator");
  const approverId = await createUser(brokerageId, "Brokerage Administrator");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(proposerId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  const result = await approveAIActionRequest(request!.id, brokerageId, actorOf(approverId, "Brokerage Administrator", brokerageId));
  assert.equal(result.ok, true, `approve should succeed: ${"reason" in result ? result.reason : ""}`);

  const rows = await eventsFor(request!.id, brokerageId);
  const approved = rows.find((r) => r.eventType === "AI_ACTION_APPROVED");
  assert.ok(approved, "AI_ACTION_APPROVED must be persisted");
  assert.equal(approved.causationId, null);
  assert.match(approved.correlationId, UUID_RE);
  assert.equal((approved.payload as Record<string, unknown>).approvedByUserId, approverId);
});

test("F-03: rejectAIActionRequest publishes AI_ACTION_REJECTED with the rejector's id and reason in metadata", async (t) => {
  const brokerageId = await createBrokerage("F-03 - reject");
  t.after(() => cleanupBrokerage(brokerageId));
  const proposerId = await createUser(brokerageId, "Brokerage Administrator");
  const rejectorId = await createUser(brokerageId, "Brokerage Administrator");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(proposerId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  const result = await rejectAIActionRequest(
    request!.id,
    brokerageId,
    actorOf(rejectorId, "Brokerage Administrator", brokerageId),
    "F-03 regression test rejection",
  );
  assert.equal(result.ok, true);

  const rows = await eventsFor(request!.id, brokerageId);
  const rejected = rows.find((r) => r.eventType === "AI_ACTION_REJECTED");
  assert.ok(rejected, "AI_ACTION_REJECTED must be persisted");
  assert.equal((rejected.payload as Record<string, unknown>).rejectedByUserId, rejectorId);
});

test("F-03: executeAIAction publishes AI_ACTION_EXECUTED with metadata.status reflecting the freshly-updated COMPLETED row, not the stale pre-execution row", async (t) => {
  const brokerageId = await createBrokerage("F-03 - execute");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "execute test" },
  });
  const result = await executeAIAction(request!.id, brokerageId);
  assert.equal(result.ok, true, `execute should succeed: ${"reason" in result ? result.reason : ""}`);

  const rows = await eventsFor(request!.id, brokerageId);
  const executed = rows.find((r) => r.eventType === "AI_ACTION_EXECUTED");
  assert.ok(executed, "AI_ACTION_EXECUTED must be persisted");
  assert.equal(executed.causationId, null);
  assert.match(executed.correlationId, UUID_RE);
  assert.equal(
    (executed.metadata as Record<string, unknown>).status,
    "COMPLETED",
    "metadata.status must reflect the post-execution row, not the pre-execution APPROVED snapshot",
  );
});

test("F-03: a tampered payload blocks execution and publishes AI_ACTION_BLOCKED with reason PAYLOAD_TAMPERED", async (t) => {
  const brokerageId = await createBrokerage("F-03 - tamper blocked");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "original note" },
  });
  await db
    .update(aiActionRequests)
    .set({ inputPayload: { propertyId, note: "TAMPERED" } })
    .where(eq(aiActionRequests.id, request!.id));

  const result = await executeAIAction(request!.id, brokerageId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PAYLOAD_TAMPERED");

  const rows = await eventsFor(request!.id, brokerageId);
  const blocked = rows.find((r) => r.eventType === "AI_ACTION_BLOCKED");
  assert.ok(blocked, "AI_ACTION_BLOCKED must be persisted");
  assert.equal(blocked.causationId, null);
  assert.match(blocked.correlationId, UUID_RE);
});

// ---------------------------------------------------------------------
// 3. Idempotency and cross-tenant safety.
// ---------------------------------------------------------------------

test("F-03: publishing the identical (row, eventType) twice does not throw to the caller and leaves exactly one domain_events row for that idempotencyKey", async (t) => {
  const brokerageId = await createBrokerage("F-03 - idempotent retry");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "idempotent retry test" },
  });
  const row = await getAIActionRequest(request!.id, brokerageId);
  assert.ok(row);

  await assert.doesNotReject(() =>
    publishAiActionEvent(row!, "AI_ACTION_PROPOSED", { humanReadableSummary: row!.humanReadableSummary }),
  );

  const rows = await eventsFor(request!.id, brokerageId);
  const proposedRows = rows.filter((r) => r.eventType === "AI_ACTION_PROPOSED");
  assert.equal(
    proposedRows.length,
    1,
    "the unique idempotencyKey index must prevent a duplicate row, and the duplicate-insert failure must be swallowed rather than surfaced",
  );
});

test("F-03: cross-tenant safety -- events published for brokerage A never appear when querying by brokerage B's id", async (t) => {
  const brokerageA = await createBrokerage("F-03 - cross tenant A");
  const brokerageB = await createBrokerage("F-03 - cross tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const agentA = await createUser(brokerageA, "Agent");
  const propertyA = await createProperty(brokerageA, agentA);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyA, note: "cross tenant test" },
  });
  const rowsForA = await eventsFor(request!.id, brokerageA);
  assert.equal(rowsForA.length, 1);
  const rowsForB = await eventsFor(request!.id, brokerageB);
  assert.equal(rowsForB.length, 0, "brokerage B must never see brokerage A's AI action events");
});

test("F-03: the persisted event's metadata/payload never includes the raw inputPayload or inputPayloadHash", async (t) => {
  const brokerageId = await createBrokerage("F-03 - no sensitive leakage");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "sensitivity test" },
  });
  const [proposed] = await eventsFor(request!.id, brokerageId);
  const metadata = proposed.metadata as Record<string, unknown>;
  const payload = proposed.payload as Record<string, unknown>;
  assert.equal(metadata.inputPayload, undefined);
  assert.equal(metadata.inputPayloadHash, undefined);
  assert.equal(payload.inputPayload, undefined);
  assert.equal(payload.inputPayloadHash, undefined);
});
