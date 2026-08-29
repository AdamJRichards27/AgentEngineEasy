// AI Governance, Authority & Action Control Architecture -- Stage G10.
//
// Security and regression tests for the governance system built in
// Stages G2-G9, covering the explicit test list in Build Instructions
// Part 25/26: permission restriction, org isolation, entitlement
// restriction, restricted-action blocking, approval requirement, approval
// ownership, duplicate execution, tampered payload, prompt injection,
// workflow overwrite prevention, and audit completeness.
//
// Integration tests against a real database, following the same pattern
// as apps/api/src/lib/entitlements/__tests__/*.test.ts: every test creates
// its own throwaway brokerage/user/property fixtures and tears them down
// in t.after(), so tests never interfere with each other or with real data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  properties,
  aiActionRequests,
  workflowChangeProposals,
  type UserRole,
} from "@aee/db";
import { configureEventStore } from "@aee/events";
import type { DomainEvent, EventStore, PublishEventInput } from "@aee/events";
import { evaluateAIAction, type PolicyActor } from "../policyEngine.js";
import {
  proposeAIAction,
  getAIActionRequest,
  approveAIActionRequest,
  rejectAIActionRequest,
  hashInputPayload,
} from "../actionRequests.js";
import { executeAIAction } from "../executionGateway.js";
import { assertNoProtectedOperationsRegistered } from "../protectedOperations.js";
import { riskTierForLevel } from "../authority.js";

// ---------------------------------------------------------------------------
// In-memory event store, so "audit completeness" tests can assert on what
// was actually published without needing a real event-store backend.
// ---------------------------------------------------------------------------
class InMemoryEventStore implements EventStore {
  events: DomainEvent[] = [];
  async append(input: PublishEventInput): Promise<DomainEvent> {
    const event = {
      ...input,
      id: randomUUID(),
      recordedAt: new Date(),
      processingStatus: "PROCESSED",
      handlerErrors: null,
      attemptCount: 1,
      eventVersion: input.eventVersion ?? 1,
    } as DomainEvent;
    this.events.push(event);
    return event;
  }
  async updateProcessingStatus(
    id: string,
    status: DomainEvent["processingStatus"],
    handlerErrors: DomainEvent["handlerErrors"],
  ): Promise<void> {
    const event = this.events.find((e) => e.id === id);
    if (event) {
      event.processingStatus = status;
      event.handlerErrors = handlerErrors;
    }
  }
}
const testEventStore = new InMemoryEventStore();
configureEventStore(testEventStore);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: UserRole): Promise<number> {
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
    .values({ brokerageId, agentId, formattedAddress: "1 Test St, Testville" })
    .returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  await db.delete(workflowChangeProposals).where(eq(workflowChangeProposals.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

function actorOf(id: number, role: UserRole | string, brokerageId: number): PolicyActor {
  return { id, role, brokerageId };
}

// ---------------------------------------------------------------------------
// 1. Permission restriction (Golden Rule)
// ---------------------------------------------------------------------------
test("Golden Rule: a role outside the action's allowedRoles is denied, even though the action itself is enabled", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - permission restriction");
  t.after(() => cleanupBrokerage(brokerageId));
  const pitCrewId = await createUser(brokerageId, "Pit Crew");

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(pitCrewId, "Pit Crew", brokerageId),
    actorType: "USER",
    rawInput: { propertyId: 1, note: "test" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ROLE_FORBIDDEN");
});

// ---------------------------------------------------------------------------
// 2. Org (tenant) isolation
// ---------------------------------------------------------------------------
test("org isolation: a request created in one brokerage is invisible when looked up under another brokerage's id", async (t) => {
  const brokerageA = await createBrokerage("Gov Test - tenant A");
  const brokerageB = await createBrokerage("Gov Test - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));

  const agentA = await createUser(brokerageA, "Agent");
  const propertyA = await createProperty(brokerageA, agentA);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyA, note: "tenant isolation test" },
  });
  assert.equal(decision.allowed, true);
  assert.ok(request);

  const seenFromOwnTenant = await getAIActionRequest(request!.id, brokerageA);
  assert.ok(seenFromOwnTenant);

  const seenFromOtherTenant = await getAIActionRequest(request!.id, brokerageB);
  assert.equal(seenFromOtherTenant, null);
});

test("org isolation: execution fails when the proposed resource belongs to a different brokerage than the request", async (t) => {
  const brokerageA = await createBrokerage("Gov Test - cross-tenant resource A");
  const brokerageB = await createBrokerage("Gov Test - cross-tenant resource B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));

  const agentA = await createUser(brokerageA, "Agent");
  const agentB = await createUser(brokerageB, "Agent");
  const propertyB = await createProperty(brokerageB, agentB);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentA, "Agent", brokerageA),
    actorType: "USER",
    rawInput: { propertyId: propertyB, note: "should never be written" },
  });
  assert.equal(decision.allowed, true);
  assert.ok(request);
  assert.equal(request!.status, "APPROVED");

  const result = await executeAIAction(request!.id, brokerageA);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXECUTION_FAILED");
});

// ---------------------------------------------------------------------------
// 3. Entitlement restriction -- out of scope for the current 3 demo actions
// ---------------------------------------------------------------------------
test(
  "entitlement restriction: no currently registered action requires a paid entitlement",
  { skip: "Per Part 24 (small demonstration set only), none of the 3 registered actions set requiredEntitlementKey. The routing to explainEntitlementDecision()/requireEntitlement() is implemented in policyEngine.ts and covered directly by apps/api/src/lib/entitlements/__tests__; this placeholder documents the gap rather than fabricating an entitlement-gated demo action out of scope." },
  async () => {},
);

// ---------------------------------------------------------------------------
// 4. Restricted-action blocking
// ---------------------------------------------------------------------------
test("restricted-action blocking: a RESTRICTED-tier (riskLevel 4) action fails the registry startup self-check", () => {
  assert.throws(
    () => assertNoProtectedOperationsRegistered([{ actionKey: "SOME_DEMO_ACTION", riskLevel: 4 }]),
    /RESTRICTED/,
  );
});

test("restricted-action blocking: an actionKey matching a protected-operation fragment fails the registry startup self-check", () => {
  assert.throws(
    () => assertNoProtectedOperationsRegistered([{ actionKey: "CHANGE_USER_ROLE", riskLevel: 0 }]),
    /forbidden fragment/,
  );
});

test("restricted-action blocking: riskTierForLevel(4) resolves to RESTRICTED", () => {
  assert.equal(riskTierForLevel(4), "RESTRICTED");
});

// ---------------------------------------------------------------------------
// 5. Approval requirement
// ---------------------------------------------------------------------------
test("approval requirement: a SYSTEM_CHANGE action always requires human approval", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval requirement (system change)");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  const { request, decision } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, true);
  assert.equal(request!.status, "AWAITING_APPROVAL");
});

test("approval requirement: a LOW-risk EXECUTE action is auto-execute-eligible and skips the human queue", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval requirement (auto)");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request, decision } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "auto-eligible test" },
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresApproval, false);
  assert.equal(request!.status, "APPROVED");
});

// ---------------------------------------------------------------------------
// 6. Approval ownership
// ---------------------------------------------------------------------------
test("approval ownership: only a role that could perform the action manually may approve it", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - approval ownership");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);

  const deniedApproval = await approveAIActionRequest(request!.id, brokerageId, actorOf(agentId, "Agent", brokerageId));
  assert.equal(deniedApproval.ok, false);
  assert.equal(deniedApproval.reason, "APPROVER_ROLE_FORBIDDEN");

  const stillWaiting = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(stillWaiting!.status, "AWAITING_APPROVAL");
});

// ---------------------------------------------------------------------------
// 7. No duplicate execution
// ---------------------------------------------------------------------------
test("duplicate execution is prevented: a second execute call on an already-executed request is refused", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - duplicate execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "duplicate execution test" },
  });
  assert.ok(request);

  const first = await executeAIAction(request!.id, brokerageId);
  assert.equal(first.ok, true);
  assert.equal(first.request?.status, "COMPLETED");

  const second = await executeAIAction(request!.id, brokerageId);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "WRONG_STATUS");
});

// ---------------------------------------------------------------------------
// 8. Tampered payload
// ---------------------------------------------------------------------------
test("tamper protection: a payload altered after proposal is rejected at approval time, not silently approved", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - tamper at approval");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: actorOf(adminId, "Brokerage Administrator", brokerageId),
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);
  assert.equal(hashInputPayload(request!.inputPayload), request!.inputPayloadHash);

  await db.update(aiActionRequests).set({ inputPayload: { proposalId: 1 } }).where(eq(aiActionRequests.id, request!.id));

  const approval = await approveAIActionRequest(request!.id, brokerageId, actorOf(adminId, "Brokerage Administrator", brokerageId));
  assert.equal(approval.ok, false);
  assert.equal(approval.reason, "PAYLOAD_TAMPERED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "REJECTED");
});

test("tamper protection: a payload altered after auto-approval is rejected at execution time, not silently executed", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - tamper at execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "original note" },
  });
  assert.ok(request);
  assert.equal(request!.status, "APPROVED");

  await db.update(aiActionRequests).set({ inputPayload: { propertyId, note: "tampered note" } }).where(eq(aiActionRequests.id, request!.id));

  const result = await executeAIAction(request!.id, brokerageId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PAYLOAD_TAMPERED");

  const after = await getAIActionRequest(request!.id, brokerageId);
  assert.equal(after!.status, "FAILED");
});

// ---------------------------------------------------------------------------
// 9. Prompt-injection-style input cannot grant authority
// ---------------------------------------------------------------------------
test("context security: unrecognised fields in the input (e.g. an injected role/authority claim) are stripped, never interpreted", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - injected fields");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: {
      propertyId,
      note: "legitimate note",
      role: "Brokerage Administrator",
      allowedRoles: ["Brokerage Administrator"],
      authorityLevel: 5,
      bypassApproval: true,
    },
  });

  assert.equal(decision.allowed, true);
  const parsed = decision.parsedInput as Record<string, unknown>;
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "role"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "authorityLevel"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, "bypassApproval"), false);
});

test("context security: a malformed/injected actor role string is compared literally and denied, never specially interpreted", async () => {
  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: { id: 1, role: "Agent' OR '1'='1", brokerageId: 1 },
    actorType: "USER",
    rawInput: { propertyId: 1, note: "x" },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "ROLE_FORBIDDEN");
});

test("input validation: a structurally invalid payload is rejected before it ever reaches a domain function", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - invalid input");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");

  const decision = await evaluateAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId: "not-a-number", note: 12345 },
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "INPUT_SCHEMA_INVALID");
});

// ---------------------------------------------------------------------------
// 10. Workflow overwrite prevention
// ---------------------------------------------------------------------------
test("workflow overwrite prevention: activating a new version supersedes the old one instead of overwriting it", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - workflow overwrite prevention");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);

  async function proposeAndActivateVersion(reason: string): Promise<number> {
    const propose = await proposeAIAction({
      actionKey: "WORKFLOW_CHANGE_PROPOSE",
      actor: admin,
      actorType: "USER",
      rawInput: {
        propertyId: null,
        workflowType: "ReadyToList",
        proposedSteps: [{ stepKey: "step1", label: "Step One", sequence: 1 }],
        changeReason: reason,
      },
    });
    assert.ok(propose.request);
    const proposeExec = await executeAIAction(propose.request!.id, brokerageId);
    assert.equal(proposeExec.ok, true);
    const proposalId = (proposeExec.result as { id: number }).id;

    const activate = await proposeAIAction({
      actionKey: "WORKFLOW_VERSION_ACTIVATE",
      actor: admin,
      actorType: "USER",
      rawInput: { proposalId },
    });
    assert.ok(activate.request);
    const approval = await approveAIActionRequest(activate.request!.id, brokerageId, admin);
    assert.equal(approval.ok, true);
    const activateExec = await executeAIAction(activate.request!.id, brokerageId);
    assert.equal(activateExec.ok, true);
    return proposalId;
  }

  const firstProposalId = await proposeAndActivateVersion("first version");
  const [firstAfterFirstActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, firstProposalId));
  assert.equal(firstAfterFirstActivation.status, "ACTIVE");

  const secondProposalId = await proposeAndActivateVersion("second version, supersedes the first");
  const [firstAfterSecondActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, firstProposalId));
  const [secondAfterSecondActivation] = await db.select().from(workflowChangeProposals).where(eq(workflowChangeProposals.id, secondProposalId));

  assert.equal(firstAfterSecondActivation.status, "SUPERSEDED");
  assert.equal(secondAfterSecondActivation.status, "ACTIVE");
  assert.notEqual(firstProposalId, secondProposalId);
});

// ---------------------------------------------------------------------------
// 11. Audit completeness
// ---------------------------------------------------------------------------
test("audit completeness: every lifecycle transition of an approval-required action publishes its own event", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - audit completeness (approval path)");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const admin = actorOf(adminId, "Brokerage Administrator", brokerageId);
  const eventsBefore = testEventStore.events.length;

  const { request } = await proposeAIAction({
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actor: admin,
    actorType: "USER",
    rawInput: { proposalId: 999999 },
  });
  assert.ok(request);

  const rejection = await rejectAIActionRequest(request!.id, brokerageId, admin, "test rejection for audit trail coverage");
  assert.equal(rejection.ok, true);

  const publishedForThisRequest = testEventStore.events
    .slice(eventsBefore)
    .filter((e) => (e.metadata as Record<string, unknown>).requestId === request!.id)
    .map((e) => e.eventType);

  assert.ok(publishedForThisRequest.includes("AI_ACTION_PROPOSED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_APPROVAL_REQUIRED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_REJECTED"));
});

test("audit completeness: every lifecycle transition of an auto-approved action publishes its own event", async (t) => {
  const brokerageId = await createBrokerage("Gov Test - audit completeness (auto path)");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const eventsBefore = testEventStore.events.length;

  const { request } = await proposeAIAction({
    actionKey: "PROPERTY_NOTE_ADD",
    actor: actorOf(agentId, "Agent", brokerageId),
    actorType: "USER",
    rawInput: { propertyId, note: "audit trail coverage" },
  });
  assert.ok(request);

  const exec = await executeAIAction(request!.id, brokerageId);
  assert.equal(exec.ok, true);

  const publishedForThisRequest = testEventStore.events
    .slice(eventsBefore)
    .filter((e) => (e.metadata as Record<string, unknown>).requestId === request!.id)
    .map((e) => e.eventType);

  assert.ok(publishedForThisRequest.includes("AI_ACTION_PROPOSED"));
  assert.ok(!publishedForThisRequest.includes("AI_ACTION_APPROVAL_REQUIRED"));
  assert.ok(publishedForThisRequest.includes("AI_ACTION_EXECUTED"));
});
