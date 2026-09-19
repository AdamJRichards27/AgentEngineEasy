// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// End-to-end and targeted tests for the engine (engine.ts) against the real
// database and the real event pipeline (configureEvents(), same as
// apps/api/src/lib/ai/__tests__/actionEvents.test.ts) — this is what proves
// registerHandler/dispatchToHandlers, automation_executions/automation_actions,
// and the reused AI Governance pipeline all genuinely work together, not
// just in isolation.
//
// Covers the 12 named scenarios from the WAE foundation task:
//   1. eligible workflow execution
//   2. condition mismatch and clean skip
//   3. duplicate event delivery
//   4. disabled workflow
//   5. wrong tenant
//   6. missing entitlement
//   7. unregistered action type
//   8. insufficient authority
//   9. approval-required action
//   10. retryable failure
//   11. non-retryable failure
//   12. audit and correlation continuity

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  properties,
  automationRules,
  automationRuleVersions,
  automationExecutions,
  automationActions,
  eventProcessingReceipts,
  aiActionRequests,
  domainEvents,
  type UserRole,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId, type DomainEvent } from "@aee/events";
import { configureEvents } from "../../events.js";
import { registerAutomationEngine } from "../bootstrap.js";
import {
  handleAutomationDomainEvent,
  retryAutomationAction,
  mapDecisionToAuthorityDecision,
  resetStuckAiActionSweepThrottleForTests,
} from "../engine.js";
import { createAutomationRule, createRuleVersion, approveAndActivateRuleVersion } from "../rules.js";
import { approveAIActionRequest, proposeAIAction, STUCK_EXECUTING_RECOVERED_MESSAGE } from "../../ai/actionRequests.js";
import type { AutomationConditionGroup } from "../conditions.js";

configureEvents();
registerAutomationEngine();

const VALID_CONDITIONS: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "propertyId", operator: "exists" }] };

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

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
  const [row] = await db.insert(properties).values({ brokerageId, agentId, formattedAddress: "1 Engine Test St, Testville" }).returning();
  return row.id;
}

async function publishAgencyAgreementSigned(input: { brokerageId: number; propertyId: number; agentId: number }): Promise<DomainEvent> {
  return publishDomainEvent({
    eventType: "AGENCY_AGREEMENT_SIGNED",
    occurredAt: new Date(),
    propertyId: input.propertyId,
    transactionId: null,
    partyId: null,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    actorType: "USER",
    actorId: input.agentId,
    source: "test:engine",
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: `test-agency-agreement-signed:${randomUUID()}`,
    payload: { propertyId: input.propertyId },
    metadata: {},
  });
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  const eventRows = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  const eventIds = eventRows.map((r) => r.id);

  const executionRows = await db.select({ id: automationExecutions.id }).from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  const executionIds = executionRows.map((r) => r.id);
  if (executionIds.length > 0) {
    await db.delete(automationActions).where(inArray(automationActions.executionId, executionIds));
  }
  await db.delete(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));

  if (eventIds.length > 0) {
    await db.delete(eventProcessingReceipts).where(inArray(eventProcessingReceipts.eventId, eventIds));
  }

  const ruleRows = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.brokerageId, brokerageId));
  for (const rule of ruleRows) {
    await db.delete(automationRuleVersions).where(eq(automationRuleVersions.ruleId, rule.id));
  }
  await db.delete(automationRules).where(eq(automationRules.brokerageId, brokerageId));

  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  await db.delete(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

async function setUpActiveAgencyAgreementRule(input: {
  brokerageId: number;
  adminId: number;
  conditionGroup?: AutomationConditionGroup;
  actionKey?: string;
  actionParams?: unknown;
  allowedRolesActorCheck?: boolean;
}) {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Engine test rule",
    triggerEventType: "AGENCY_AGREEMENT_SIGNED",
    createdByUserId: input.adminId,
  });
  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: input.conditionGroup ?? VALID_CONDITIONS,
    actions: [{ actionKey: input.actionKey ?? "PROPERTY_NOTE_ADD", params: input.actionParams ?? { propertyId: "$event.propertyId", note: "engine test note" } }],
    createdByUserId: input.adminId,
  });
  const activated = await approveAndActivateRuleVersion({ versionId: version.id, brokerageId: input.brokerageId, approvedByUserId: input.adminId });
  return { rule, version: activated };
}

// ---------------------------------------------------------------------
// 1. Eligible workflow execution
// ---------------------------------------------------------------------

test("scenario 1 — eligible workflow execution: a matching event runs the rule's action end to end through the reused AI Governance pipeline", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - eligible execution");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const { version } = await setUpActiveAgencyAgreementRule({ brokerageId, adminId });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db
    .select()
    .from(automationExecutions)
    .where(eq(automationExecutions.triggeringEventId, event.id));
  assert.ok(execution, "an execution row must exist for the triggering event");
  assert.equal(execution.status, "COMPLETED");
  assert.equal(execution.ruleVersionId, version.id);

  const [actionRow] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRow.status, "SUCCEEDED");
  assert.equal(actionRow.authorityDecision, "ALLOW");
  assert.ok(actionRow.aiActionRequestId, "a real aiActionRequests row must back this action");

  const [request] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, actionRow.aiActionRequestId!));
  assert.equal(request.status, "COMPLETED");
  assert.equal(request.actorType, "SYSTEM");
});

// ---------------------------------------------------------------------
// 2. Condition mismatch and clean skip
// ---------------------------------------------------------------------

test("scenario 2 — condition mismatch: an event that fails the rule's conditions produces a clean SKIPPED execution and zero actions", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - condition mismatch");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const neverMatches: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "payload.doesNotExist", operator: "exists" }] };
  await setUpActiveAgencyAgreementRule({ brokerageId, adminId, conditionGroup: neverMatches });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "SKIPPED");
  assert.ok(execution.conditionResult, "conditionResult must record why the rule was skipped");

  const actionRows = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRows.length, 0, "no action should ever be attempted for a skipped execution");
});

// ---------------------------------------------------------------------
// 3. Duplicate event delivery
// ---------------------------------------------------------------------

test("scenario 3 — duplicate event delivery: handling the same event twice produces exactly one execution, no throw", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - duplicate delivery");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  await setUpActiveAgencyAgreementRule({ brokerageId, adminId });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });
  // The publish above already dispatched to the automation engine once
  // (registerAutomationEngine() is registered at module scope). Simulate a
  // redelivery — the exact scenario event_processing_receipts exists for —
  // by invoking the handler directly a second time with the same event.
  await assert.doesNotReject(() => handleAutomationDomainEvent(event));

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(executions.length, 1, "a redelivered event must never create a second execution");

  const [receipt] = await db
    .select()
    .from(eventProcessingReceipts)
    .where(eq(eventProcessingReceipts.eventId, event.id));
  assert.equal(receipt.status, "PROCESSED");
});

// ---------------------------------------------------------------------
// 4. Disabled workflow
// ---------------------------------------------------------------------

test("scenario 4 — disabled workflow: a rule version left in DRAFT (never activated) is never evaluated", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - disabled workflow");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const rule = await createAutomationRule({ brokerageId, name: "disabled rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: VALID_CONDITIONS,
    actions: [{ actionKey: "PROPERTY_NOTE_ADD", params: { propertyId: "$event.propertyId", note: "should never run" } }],
    createdByUserId: adminId,
  });
  // Deliberately never approveAndActivateRuleVersion — the version (and the
  // parent rule) stay DRAFT.

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(executions.length, 0, "a DRAFT (never-activated) rule version must never produce an execution");
});

// ---------------------------------------------------------------------
// 5. Wrong tenant
// ---------------------------------------------------------------------

test("scenario 5 — wrong tenant: a rule active for brokerage A never fires for an event published under brokerage B", async (t) => {
  const brokerageA = await createBrokerage("Engine Test - tenant A");
  const brokerageB = await createBrokerage("Engine Test - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const adminA = await createUser(brokerageA, "Brokerage Administrator");
  const agentA = await createUser(brokerageA, "Agent");
  await createProperty(brokerageA, agentA);
  await setUpActiveAgencyAgreementRule({ brokerageId: brokerageA, adminId: adminA });

  const agentB = await createUser(brokerageB, "Agent");
  const propertyB = await createProperty(brokerageB, agentB);
  const eventForB = await publishAgencyAgreementSigned({ brokerageId: brokerageB, propertyId: propertyB, agentId: agentB });

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, eventForB.id));
  assert.equal(executions.length, 0, "brokerage A's rule must never evaluate an event published under brokerage B");
});

// ---------------------------------------------------------------------
// 6. Missing entitlement
// ---------------------------------------------------------------------
// None of the 3 actions currently in ai/actions/registry.ts require a paid
// entitlement (same limitation documented by
// apps/api/src/lib/ai/__tests__/governance.test.ts's own skipped
// "entitlement restriction" test) — so this exercises mapDecisionToAuthorityDecision,
// engine.ts's own translation of an ENTITLEMENT_DENIED policy decision,
// directly rather than fabricating an entitlement-gated demo action out of
// scope for this foundation PR.

test("scenario 6 — missing entitlement: an ENTITLEMENT_DENIED policy decision maps to BLOCK_MISSING_ENTITLEMENT", () => {
  const decision = { allowed: false as const, reason: "ENTITLEMENT_DENIED" as const, actionKey: "X", requiresApproval: true };
  assert.equal(mapDecisionToAuthorityDecision(decision), "BLOCK_MISSING_ENTITLEMENT");
});

test("mapDecisionToAuthorityDecision covers every other policy outcome the engine can see", () => {
  assert.equal(mapDecisionToAuthorityDecision({ allowed: true, reason: "OK", actionKey: "X", requiresApproval: false }), "ALLOW");
  assert.equal(mapDecisionToAuthorityDecision({ allowed: true, reason: "OK", actionKey: "X", requiresApproval: true }), "ALLOW_WITH_APPROVAL");
  assert.equal(
    mapDecisionToAuthorityDecision({ allowed: false, reason: "TENANT_CONTEXT_REQUIRED", actionKey: "X", requiresApproval: true }),
    "BLOCK_MISSING_CONTEXT",
  );
  assert.equal(
    mapDecisionToAuthorityDecision({ allowed: false, reason: "ROLE_FORBIDDEN", actionKey: "X", requiresApproval: true }),
    "BLOCK_POLICY_CONFLICT",
  );
});

// ---------------------------------------------------------------------
// 7. Unregistered action type
// ---------------------------------------------------------------------

test("scenario 7 — unregistered action type: a rule version referencing a since-deregistered actionKey is BLOCKED at execution time, never silently skipped", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - unregistered action");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const rule = await createAutomationRule({ brokerageId, name: "ghost action rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  // Bypasses rules.ts's write-time assertActionsAreRegistered() to simulate
  // registry drift after authoring (the scenario the engine's own runtime
  // re-check, not just the write-time check, exists to catch).
  const [version] = await db
    .insert(automationRuleVersions)
    .values({
      ruleId: rule.id,
      version: 1,
      status: "ACTIVE",
      conditionGroup: VALID_CONDITIONS,
      actions: [{ actionKey: "GHOST_ACTION_NOT_REGISTERED", params: {} }],
      createdByUserId: adminId,
      approvedByUserId: adminId,
      approvedAt: new Date(),
      activatedAt: new Date(),
    })
    .returning();
  await db.update(automationRules).set({ status: "ACTIVE" }).where(eq(automationRules.id, rule.id));

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.ruleVersionId, version.id);
  assert.equal(execution.status, "BLOCKED");

  const [actionRow] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRow.status, "BLOCKED");
  assert.match(actionRow.errorMessage ?? "", /not registered/);
});

// ---------------------------------------------------------------------
// 8. Insufficient authority
// ---------------------------------------------------------------------

test("scenario 8 — insufficient authority: an active version whose approving user can no longer be verified is BLOCKED, fail closed", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - insufficient authority");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const { version } = await setUpActiveAgencyAgreementRule({ brokerageId, adminId });

  // Simulate authority that can no longer be established (e.g. the
  // approving user's record was corrected/removed after activation) —
  // never inferred, never defaulted to some other actor.
  await db.update(automationRuleVersions).set({ approvedByUserId: null }).where(eq(automationRuleVersions.id, version.id));

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "BLOCKED");
  assert.match(execution.errorMessage ?? "", /authority/i);

  const actionRows = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRows.length, 0, "no action may even be attempted once authority cannot be established");
});

// ---------------------------------------------------------------------
// 9. Approval-required action
// ---------------------------------------------------------------------

test("scenario 9 — approval-required action: a SYSTEM_CHANGE action stops at AWAITING_APPROVAL and is handed to the existing, unmodified approval mechanism", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - approval required");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  await setUpActiveAgencyAgreementRule({
    brokerageId,
    adminId,
    actionKey: "WORKFLOW_VERSION_ACTIVATE",
    actionParams: { proposalId: 999999 },
  });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "AWAITING_APPROVAL");

  const [actionRow] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRow.status, "AWAITING_APPROVAL");
  assert.equal(actionRow.authorityDecision, "ALLOW_WITH_APPROVAL");
  assert.ok(actionRow.aiActionRequestId);

  // Reuse, not duplication: the SAME approveAIActionRequest() a human route
  // handler calls (routes/ai-actions.ts) accepts this automation-created
  // request exactly as if a human had proposed it.
  const approval = await approveAIActionRequest(actionRow.aiActionRequestId!, brokerageId, { id: adminId, role: "Brokerage Administrator", brokerageId });
  assert.equal(approval.ok, true);
  assert.equal(approval.request?.status, "APPROVED");
});

// ---------------------------------------------------------------------
// 10 & 11. Safe retry — retryable vs non-retryable failures
// ---------------------------------------------------------------------

async function insertMinimalExecutionAndAction(input: {
  brokerageId: number;
  ruleId: number;
  ruleVersionId: number;
  triggeringEventId: string;
  correlationId: string;
  actionKey: string;
  params: unknown;
  status: "FAILED";
  errorMessage: string;
  attemptCount: number;
  maxAttempts: number;
}) {
  const [execution] = await db
    .insert(automationExecutions)
    .values({
      brokerageId: input.brokerageId,
      ruleId: input.ruleId,
      ruleVersionId: input.ruleVersionId,
      triggeringEventId: input.triggeringEventId,
      correlationId: input.correlationId,
      status: "PARTIALLY_COMPLETED",
      startedAt: new Date(),
    })
    .returning();
  const [action] = await db
    .insert(automationActions)
    .values({
      executionId: execution.id,
      sequence: 1,
      actionKey: input.actionKey,
      params: input.params,
      status: input.status,
      errorMessage: input.errorMessage,
      attemptCount: input.attemptCount,
      maxAttempts: input.maxAttempts,
      startedAt: new Date(),
      completedAt: new Date(),
    })
    .returning();
  return { execution, action };
}

test("scenario 10 — retryable failure: a genuine execution-time failure can be retried, reuses the same action row, and can succeed", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - retryable failure");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  // Left DRAFT deliberately (not activated yet) so publishing the
  // triggering event below does not also run the real pipeline against
  // this same (ruleVersionId, event) pair — this test fabricates its own
  // independent execution/action fixture representing a prior transient
  // failure, then activates the rule only once that fixture exists, purely
  // so retryAutomationAction has a real approver to resolve.
  const rule = await createAutomationRule({ brokerageId, name: "retry test rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const draftVersion = await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: VALID_CONDITIONS,
    actions: [{ actionKey: "PROPERTY_NOTE_ADD", params: { propertyId, note: "retry test — this run should succeed" } }],
    createdByUserId: adminId,
  });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const { action } = await insertMinimalExecutionAndAction({
    brokerageId,
    ruleId: rule.id,
    ruleVersionId: draftVersion.id,
    triggeringEventId: event.id,
    correlationId: event.correlationId,
    actionKey: "PROPERTY_NOTE_ADD",
    params: { propertyId, note: "retry test — this run should succeed" },
    status: "FAILED",
    errorMessage: "simulated transient timeout",
    attemptCount: 1,
    maxAttempts: 3,
  });

  // Activate only now that the fixture exists — retryAutomationAction needs
  // a real approver to resolve; activating earlier would have let the
  // pipeline auto-process the triggering event and collide with this
  // fixture's own (ruleVersionId, event) pair via the unique index.
  await approveAndActivateRuleVersion({ versionId: draftVersion.id, brokerageId, approvedByUserId: adminId });

  const result = await retryAutomationAction(action.id, brokerageId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "SUCCEEDED");

  const [updated] = await db.select().from(automationActions).where(eq(automationActions.id, action.id));
  assert.equal(updated.status, "SUCCEEDED");
  assert.equal(updated.attemptCount, 2, "retry increments the SAME row's attemptCount rather than inserting a new row");
  assert.ok(updated.aiActionRequestId);
});

test("scenario 11 — non-retryable failure: a tamper/policy-class failure is refused, never silently retried", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - non-retryable failure");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  // Left DRAFT deliberately, same reason as scenario 10 — retryAutomationAction's
  // classification checks (status/attemptCount/errorMessage pattern) run and
  // return before ever needing an ACTIVE rule/version, so no activation is
  // needed here at all.
  const rule = await createAutomationRule({ brokerageId, name: "non-retryable test rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const draftVersion = await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: VALID_CONDITIONS,
    actions: [{ actionKey: "PROPERTY_NOTE_ADD", params: { propertyId, note: "x" } }],
    createdByUserId: adminId,
  });

  // Two independent triggering events, one per fixture below — the
  // automation_executions unique index is on (ruleVersionId, triggeringEventId),
  // so two fixtures sharing this rule version each need their own event.
  const eventForTamper = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });
  const eventForExhausted = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const { action: tamperedAction } = await insertMinimalExecutionAndAction({
    brokerageId,
    ruleId: rule.id,
    ruleVersionId: draftVersion.id,
    triggeringEventId: eventForTamper.id,
    correlationId: eventForTamper.correlationId,
    actionKey: "PROPERTY_NOTE_ADD",
    params: { propertyId, note: "x" },
    status: "FAILED",
    errorMessage: "PAYLOAD_TAMPERED",
    attemptCount: 1,
    maxAttempts: 3,
  });
  const tamperedResult = await retryAutomationAction(tamperedAction.id, brokerageId);
  assert.equal(tamperedResult.ok, false);
  // Classified VALIDATION_OR_POLICY by operations.ts's classifyActionFailure
  // (errorMessage matches the PAYLOAD_TAMPERED pattern) -- claimActionForRetry
  // rejects it before ever claiming the row, same "never touch the row"
  // guarantee as before, now backed by the shared classifier instead of a
  // second, engine.ts-local regex.
  if (!tamperedResult.ok) assert.equal(tamperedResult.reason, "NOT_RETRY_ELIGIBLE");

  const { action: exhaustedAction } = await insertMinimalExecutionAndAction({
    brokerageId,
    ruleId: rule.id,
    ruleVersionId: draftVersion.id,
    triggeringEventId: eventForExhausted.id,
    correlationId: eventForExhausted.correlationId,
    actionKey: "PROPERTY_NOTE_ADD",
    params: { propertyId, note: "x" },
    status: "FAILED",
    errorMessage: "simulated transient timeout",
    attemptCount: 3,
    maxAttempts: 3,
  });
  const exhaustedResult = await retryAutomationAction(exhaustedAction.id, brokerageId);
  assert.equal(exhaustedResult.ok, false);
  if (!exhaustedResult.ok) assert.equal(exhaustedResult.reason, "MAX_ATTEMPTS_REACHED");

  const [stillTampered] = await db.select().from(automationActions).where(eq(automationActions.id, tamperedAction.id));
  assert.equal(stillTampered.status, "FAILED");
  assert.equal(stillTampered.attemptCount, 1, "a refused retry must never touch the row");
});

// ---------------------------------------------------------------------
// 12. Audit and correlation continuity
// ---------------------------------------------------------------------

test("scenario 12 — audit and correlation continuity: the execution and its completion event both carry the triggering event's correlationId, and the completion event's causationId points at the triggering event", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - audit continuity");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  await setUpActiveAgencyAgreementRule({ brokerageId, adminId });

  const event = await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.correlationId, event.correlationId);
  assert.equal(execution.triggeringEventId, event.id);

  const completionEvents = await db.select().from(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  const completion = completionEvents.find((e) => e.eventType === "AUTOMATION_EXECUTION_COMPLETED");
  assert.ok(completion, "AUTOMATION_EXECUTION_COMPLETED must be published for a fully completed execution");
  assert.equal(completion!.causationId, event.id);
  assert.equal(completion!.correlationId, event.correlationId);
  assert.equal((completion!.metadata as Record<string, unknown>).executionId, execution.id);
});

// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage F4.0 (D5) — the engine's per-event processing
// is the periodic path that recovers stuck EXECUTING AI action requests.
// ---------------------------------------------------------------------

test("F4.0 D5: handling any domain event sweeps a stale EXECUTING automation (SYSTEM, null resourceId) AI action request to FAILED, throttled to one bounded sweep per interval", async (t) => {
  const brokerageId = await createBrokerage("Engine Test - F4.0 D5 stuck sweep");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const admin = { id: adminId, role: "Brokerage Administrator", brokerageId };

  const stuckRequest = async (note: string) => {
    const { request } = await proposeAIAction({ actionKey: "PROPERTY_NOTE_ADD", actor: admin, actorType: "SYSTEM", rawInput: { propertyId, note } });
    assert.equal(request!.resourceId, null);
    await db
      .update(aiActionRequests)
      .set({ status: "EXECUTING", updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(aiActionRequests.id, request!.id));
    return request!.id;
  };

  const firstId = await stuckRequest("stuck automation action");
  resetStuckAiActionSweepThrottleForTests();
  await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId }); // dispatches to handleAutomationDomainEvent

  const [first] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, firstId));
  assert.equal(first.status, "FAILED");
  assert.equal(first.errorMessage, STUCK_EXECUTING_RECOVERED_MESSAGE);

  // Throttled: a second stale row is left for the next interval's sweep.
  const secondId = await stuckRequest("stuck again");
  await publishAgencyAgreementSigned({ brokerageId, propertyId, agentId });
  const [second] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, secondId));
  assert.equal(second.status, "EXECUTING");
});
