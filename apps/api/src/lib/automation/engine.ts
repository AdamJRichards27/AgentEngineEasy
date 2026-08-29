// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// The engine itself: "WHEN an approved domain event occurs -> evaluate
// applicable rules -> create controlled, auditable actions." This is the
// first real consumer of packages/events' registerHandler/dispatchToHandlers
// (confirmed, by repository search, to have zero call sites before this
// change) and the first real writer to the automation_* tables
// (packages/db/src/schema/automation.ts), which docs/foundation-remediation/
// F2_AUTOMATION_SCHEMA_CHECKPOINT.md confirmed were "SCAFFOLDED ONLY" —
// five tables, zero rows, nothing reading or writing them.
//
// Non-negotiable structural decision carried over unchanged from
// docs/stage-wf/WF1_DISCOVERY.md: action execution goes through the SAME
// AI Governance pipeline every other actor uses — evaluateAIAction() via
// proposeAIAction(), then executeAIAction() as the sole caller of an
// action definition's execute(). This module never calls execute()
// directly and never re-implements policy/authority/entitlement logic —
// see policyEngine.ts, executionGateway.ts, actionRequests.ts.
//
// Safety requirements this file is directly responsible for:
//   - fail closed when authority, tenant, entitlement, or action
//     registration cannot be verified (every branch below that cannot
//     positively confirm one of these ends the action/execution as
//     BLOCKED, never proceeds optimistically);
//   - never execute an arbitrary function/prompt/script/URL/DB mutation
//     supplied through workflow configuration (conditions.ts/templating.ts
//     are the only interpreters of rule-authored data, and neither
//     contains eval/Function/dynamic import/raw SQL);
//   - permit only explicitly registered action types (assertActionsAreRegistered
//     at write time in rules.ts; getActionDefinition re-checked here at
//     execution time);
//   - separate rule evaluation (evaluateConditionGroup) from action
//     execution (executeAutomationAction) — distinct functions, distinct
//     DB writes, the former never mutates anything but automationExecutions.conditionResult;
//   - prevent the same event/workflow/version combination from executing
//     twice (event_processing_receipts claim + the automation_executions
//     unique index, both below);
//   - preserve immutable execution evidence (every state transition is a
//     new column value on an append-only-in-spirit row — nothing here ever
//     deletes an execution/action row, and retries reuse rather than
//     duplicate a row, per automation.ts's own column comments);
//   - route approval-required actions through the established approval
//     mechanism (this file only ever leaves such an action AWAITING_APPROVAL
//     with aiActionRequestId set — a human approves/executes it through the
//     existing POST /ai/actions/requests/:id/approve|execute endpoints,
//     unchanged by this PR);
//   - record why a workflow ran, skipped, failed, or was rejected
//     (automationExecutions.conditionResult + errorMessage, automationActions.errorMessage,
//     plus the AUTOMATION_EXECUTION_SKIPPED/COMPLETED and existing
//     AUTOMATION_ACTION_FAILED/BLOCKED domain events).

import { and, eq } from "drizzle-orm";
import {
  db,
  users,
  domainEvents,
  automationRules,
  automationRuleVersions,
  automationExecutions,
  automationActions,
  eventProcessingReceipts,
  type AutomationRule,
  type AutomationRuleVersion,
  type AutomationExecution,
} from "@aee/db";
import { publishDomainEvent, type DomainEvent } from "@aee/events";
import { getActionDefinition } from "../ai/actions/registry.js";
import { proposeAIAction } from "../ai/actionRequests.js";
import { executeAIAction } from "../ai/executionGateway.js";
import type { PolicyActor, PolicyDecision } from "../ai/policyEngine.js";
import { buildFacts, type AutomationFacts } from "./facts.js";
import { evaluateConditionGroup, type AutomationConditionGroup } from "./conditions.js";
import { resolveActionParams } from "./templating.js";
import { getActiveRuleVersionsForTrigger, type AutomationRuleAction } from "./rules.js";
import { AUTOMATION_ENGINE_HANDLER_NAME, type AutomationAuthorityDecision } from "./types.js";

// ---------------------------------------------------------------------
// Component 7: idempotency and duplicate-event protection at the outbox /
// handler-dispatch layer, independent of the automation_executions unique
// index below (defense in depth — this layer stops duplicate work from
// even being attempted; the DB unique index is the last line of defense
// if it is).
// ---------------------------------------------------------------------

type ReceiptClaim = { claimed: true; receiptId: number } | { claimed: false; reason: string };

async function claimEventProcessingReceipt(eventId: string): Promise<ReceiptClaim> {
  const [inserted] = await db
    .insert(eventProcessingReceipts)
    .values({
      eventId,
      handlerName: AUTOMATION_ENGINE_HANDLER_NAME,
      status: "PROCESSING",
      attemptCount: 1,
      claimedAt: new Date(),
    })
    .onConflictDoNothing({ target: [eventProcessingReceipts.eventId, eventProcessingReceipts.handlerName] })
    .returning();

  if (inserted) return { claimed: true, receiptId: inserted.id };

  // A receipt already exists — this is either a genuine re-delivery of an
  // already-fully-handled event, or (foundation-stage limitation,
  // documented rather than silently mishandled) a concurrent/crashed
  // attempt this stage does not yet reclaim. Either way: never process the
  // same event twice through this path.
  const [existing] = await db
    .select()
    .from(eventProcessingReceipts)
    .where(
      and(eq(eventProcessingReceipts.eventId, eventId), eq(eventProcessingReceipts.handlerName, AUTOMATION_ENGINE_HANDLER_NAME)),
    );
  return { claimed: false, reason: existing?.status ?? "UNKNOWN" };
}

async function markReceiptProcessed(receiptId: number): Promise<void> {
  await db.update(eventProcessingReceipts).set({ status: "PROCESSED", processedAt: new Date() }).where(eq(eventProcessingReceipts.id, receiptId));
}

async function markReceiptFailed(receiptId: number, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(eventProcessingReceipts)
    .set({ status: "FAILED", lastError: message })
    .where(eq(eventProcessingReceipts.id, receiptId));
}

// ---------------------------------------------------------------------
// Top-level handler — registered once per canonical event type by
// bootstrap.ts's registerAutomationEngine(). Exported directly (not only
// reachable through registerHandler) so tests can invoke it deterministically,
// including invoking it twice in a row to prove duplicate-delivery protection
// without depending on a redelivery mechanism that does not exist yet.
// ---------------------------------------------------------------------

export async function handleAutomationDomainEvent(event: DomainEvent): Promise<void> {
  // Fail closed: automation is inherently tenant-scoped (component 10).
  // A brokerageId-less event (there is no such canonical event today, but
  // nothing enforces that at the type level) can never be matched to a
  // brokerage's rules, so it is a clean no-op, never a guess.
  if (!event.brokerageId) return;

  const claim = await claimEventProcessingReceipt(event.id);
  if (!claim.claimed) return;

  try {
    const matches = await getActiveRuleVersionsForTrigger(event.brokerageId, event.eventType);
    for (const { rule, version } of matches) {
      try {
        await evaluateAndExecuteRule(event, rule, version);
      } catch (err) {
        // Isolation: one rule throwing must never stop a sibling rule
        // matching the same event from being evaluated — same principle
        // packages/events/src/registry.ts's dispatchToHandlers already
        // applies between handlers, reproduced here between rules within
        // this one handler.
        console.error(`automation engine: rule ${rule.id} version ${version.id} threw during evaluation`, err);
      }
    }
    await markReceiptProcessed(claim.receiptId);
  } catch (err) {
    await markReceiptFailed(claim.receiptId, err);
    throw err;
  }
}

async function publishAutomationEvent(
  eventType: "AUTOMATION_EXECUTION_SKIPPED" | "AUTOMATION_EXECUTION_COMPLETED" | "AUTOMATION_ACTION_BLOCKED" | "AUTOMATION_ACTION_FAILED",
  triggeringEvent: DomainEvent,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType,
      occurredAt: new Date(),
      propertyId: triggeringEvent.propertyId,
      transactionId: triggeringEvent.transactionId,
      partyId: triggeringEvent.partyId,
      brokerageId: triggeringEvent.brokerageId,
      agentId: triggeringEvent.agentId,
      actorType: "SYSTEM",
      actorId: null,
      source: "automation-engine",
      // Component 9: correlation/causation traceability. correlationId
      // continues the triggering event's own chain; causationId points at
      // the specific event that caused this one to be published — the
      // first genuine (non-null) use of causationId in this codebase (see
      // apps/api/src/lib/ai/__tests__/actionEvents.test.ts's F-03 tests,
      // which document every existing publishAiActionEvent call site as
      // always publishing causationId: null).
      correlationId: triggeringEvent.correlationId,
      causationId: triggeringEvent.id,
      idempotencyKey,
      metadata: payload,
      payload: {},
    });
  } catch (err) {
    console.error(`automation engine: failed to publish ${eventType}, continuing`, err);
  }
}

// ---------------------------------------------------------------------
// Per-rule evaluation + execution.
// ---------------------------------------------------------------------

type ApproverActor = { id: number; role: string; brokerageId: number | null };

async function evaluateAndExecuteRule(
  event: DomainEvent,
  rule: AutomationRule,
  version: AutomationRuleVersion,
): Promise<AutomationExecution | undefined> {
  // Component 7 (defense in depth #2): the unique index on
  // (ruleVersionId, triggeringEventId) means this exact (rule version,
  // event) pair can never produce two execution rows, no matter how many
  // times this function is entered for it.
  const [execution] = await db
    .insert(automationExecutions)
    .values({
      brokerageId: rule.brokerageId,
      ruleId: rule.id,
      ruleVersionId: version.id,
      triggeringEventId: event.id,
      correlationId: event.correlationId,
      causationDepth: 0,
      status: "EVALUATING",
    })
    .onConflictDoNothing({ target: [automationExecutions.ruleVersionId, automationExecutions.triggeringEventId] })
    .returning();
  if (!execution) return undefined;

  const facts = buildFacts(event);
  const conditionResult = evaluateConditionGroup(version.conditionGroup as AutomationConditionGroup, facts);

  if (!conditionResult.matched) {
    await db
      .update(automationExecutions)
      .set({ status: "SKIPPED", conditionResult, startedAt: new Date(), completedAt: new Date() })
      .where(eq(automationExecutions.id, execution.id));
    await publishAutomationEvent(
      "AUTOMATION_EXECUTION_SKIPPED",
      event,
      { ruleId: rule.id, ruleVersionId: version.id, executionId: execution.id },
      `automation_execution:${execution.id}:AUTOMATION_EXECUTION_SKIPPED`,
    );
    return execution;
  }

  await db
    .update(automationExecutions)
    .set({ status: "RUNNING", conditionResult, startedAt: new Date() })
    .where(eq(automationExecutions.id, execution.id));

  // Component 11 (authority and approval-policy enforcement), fail closed:
  // the human who approved and activated THIS rule version is who the
  // automation acts on behalf of for policy-evaluation purposes (the
  // Golden Rule extended to unattended execution — the system can never be
  // granted more authority than the human who signed off on this exact
  // version actually has). No approver on record -> cannot verify
  // authority -> BLOCKED, never a silent default actor.
  const approver = await resolveVersionApprover(version, rule.brokerageId);
  if (!approver) {
    await blockExecution(execution, "Rule version's approving user could not be verified; authority cannot be established.");
    return execution;
  }

  const actions = version.actions as AutomationRuleAction[];
  const outcomes: AutomationActionOutcome[] = [];
  let sequence = 0;
  for (const action of actions) {
    sequence += 1;
    outcomes.push(await executeAutomationAction({ execution, rule, approver, action, sequence, event, facts }));
  }

  const finalStatus = computeExecutionStatus(outcomes);
  await db.update(automationExecutions).set({ status: finalStatus, completedAt: new Date() }).where(eq(automationExecutions.id, execution.id));

  if (finalStatus === "COMPLETED") {
    await publishAutomationEvent(
      "AUTOMATION_EXECUTION_COMPLETED",
      event,
      { ruleId: rule.id, ruleVersionId: version.id, executionId: execution.id, actionCount: outcomes.length },
      `automation_execution:${execution.id}:AUTOMATION_EXECUTION_COMPLETED`,
    );
  }

  return execution;
}

async function resolveVersionApprover(version: AutomationRuleVersion, brokerageId: number): Promise<ApproverActor | null> {
  if (!version.approvedByUserId) return null;
  const [approver] = await db.select().from(users).where(eq(users.id, version.approvedByUserId));
  if (!approver || approver.brokerageId !== brokerageId) return null;
  return { id: approver.id, role: approver.role, brokerageId: approver.brokerageId };
}

async function blockExecution(execution: AutomationExecution, errorMessage: string): Promise<void> {
  await db
    .update(automationExecutions)
    .set({ status: "BLOCKED", errorMessage, completedAt: new Date() })
    .where(eq(automationExecutions.id, execution.id));
}

// ---------------------------------------------------------------------
// Per-action execution — routes through the SAME proposeAIAction/executeAIAction
// pipeline every human/AI-initiated action uses. actorType "SYSTEM" is
// exactly what aiActionRequests.actorType and addPropertyNote's actorType
// parameter already documented as a valid value before this PR.
// ---------------------------------------------------------------------

type AutomationActionOutcome = "SUCCEEDED" | "FAILED" | "BLOCKED" | "AWAITING_APPROVAL";

export function mapDecisionToAuthorityDecision(decision: PolicyDecision): AutomationAuthorityDecision {
  if (decision.allowed) return decision.requiresApproval ? "ALLOW_WITH_APPROVAL" : "ALLOW";
  switch (decision.reason) {
    case "ENTITLEMENT_DENIED":
      return "BLOCK_MISSING_ENTITLEMENT";
    case "TENANT_CONTEXT_REQUIRED":
      return "BLOCK_MISSING_CONTEXT";
    default:
      return "BLOCK_POLICY_CONFLICT";
  }
}

async function executeAutomationAction(input: {
  execution: AutomationExecution;
  rule: AutomationRule;
  approver: ApproverActor;
  action: AutomationRuleAction;
  sequence: number;
  event: DomainEvent;
  facts: AutomationFacts;
}): Promise<AutomationActionOutcome> {
  const { execution, rule, approver, action, sequence, event, facts } = input;

  // Retries call this same insert with onConflictDoNothing and then read
  // the existing row back — never a second row for the same
  // (executionId, sequence) pair (component 13, "retries reuse the same
  // row" per automation.ts's own index comment).
  const [inserted] = await db
    .insert(automationActions)
    .values({
      executionId: execution.id,
      sequence,
      actionKey: action.actionKey,
      params: action.params,
      status: "PENDING",
      attemptCount: 0,
      maxAttempts: 3,
    })
    .onConflictDoNothing({ target: [automationActions.executionId, automationActions.sequence] })
    .returning();
  const [row] =
    inserted !== undefined
      ? [inserted]
      : await db
          .select()
          .from(automationActions)
          .where(and(eq(automationActions.executionId, execution.id), eq(automationActions.sequence, sequence)));

  // Component 4/re-check: permit only explicitly registered action types.
  // Already validated once at rule-version write time (rules.ts's
  // assertActionsAreRegistered); re-checked here because the registry's
  // contents can change between authoring and execution (an action could
  // be removed or disabled).
  const definition = getActionDefinition(action.actionKey);
  if (!definition) {
    await db
      .update(automationActions)
      .set({ status: "BLOCKED", authorityDecision: "BLOCK_POLICY_CONFLICT", errorMessage: `Action "${action.actionKey}" is not registered.`, completedAt: new Date() })
      .where(eq(automationActions.id, row.id));
    await publishAutomationEvent(
      "AUTOMATION_ACTION_BLOCKED",
      event,
      { executionId: execution.id, actionId: row.id, actionKey: action.actionKey, reason: "ACTION_NOT_REGISTERED" },
      `automation_action:${row.id}:AUTOMATION_ACTION_BLOCKED:${row.attemptCount}`,
    );
    return "BLOCKED";
  }

  const resolvedParams = resolveActionParams(action.params, facts);
  const actor: PolicyActor = { id: approver.id, role: approver.role, brokerageId: rule.brokerageId };

  const { request, decision } = await proposeAIAction({
    actionKey: action.actionKey,
    actor,
    actorType: "SYSTEM",
    rawInput: resolvedParams,
  });

  const authorityDecision = mapDecisionToAuthorityDecision(decision);
  await db
    .update(automationActions)
    .set({ authorityDecision, aiActionRequestId: request?.id ?? null, attemptCount: row.attemptCount + 1 })
    .where(eq(automationActions.id, row.id));

  if (!decision.allowed || !request) {
    await db
      .update(automationActions)
      .set({ status: "BLOCKED", errorMessage: `Policy denied: ${decision.reason}`, completedAt: new Date() })
      .where(eq(automationActions.id, row.id));
    await publishAutomationEvent(
      "AUTOMATION_ACTION_BLOCKED",
      event,
      { executionId: execution.id, actionId: row.id, actionKey: action.actionKey, reason: decision.reason },
      `automation_action:${row.id}:AUTOMATION_ACTION_BLOCKED:${row.attemptCount + 1}`,
    );
    return "BLOCKED";
  }

  if (request.status === "AWAITING_APPROVAL") {
    // Component: route approval-required actions through the established
    // approval mechanism. This action stops here — a human approves and
    // executes it through the existing, unmodified
    // POST /ai/actions/requests/:id/approve and .../execute endpoints.
    await db.update(automationActions).set({ status: "AWAITING_APPROVAL" }).where(eq(automationActions.id, row.id));
    return "AWAITING_APPROVAL";
  }

  await db.update(automationActions).set({ status: "RUNNING", startedAt: new Date() }).where(eq(automationActions.id, row.id));
  const execResult = await executeAIAction(request.id, rule.brokerageId);

  if (execResult.ok) {
    await db
      .update(automationActions)
      .set({ status: "SUCCEEDED", result: (execResult.result ?? null) as Record<string, unknown> | null, completedAt: new Date() })
      .where(eq(automationActions.id, row.id));
    return "SUCCEEDED";
  }

  await db
    .update(automationActions)
    .set({ status: "FAILED", errorMessage: execResult.errorMessage ?? execResult.reason ?? "Execution failed", completedAt: new Date() })
    .where(eq(automationActions.id, row.id));
  // AUTOMATION_ACTION_FAILED already exists in the canonical catalogue
  // (added in the same prior-session change that added AUTOMATION_ACTION_BLOCKED);
  // AI_ACTION_FAILED was already published by executeAIAction itself
  // (actionEvents.ts) — this is the automation-specific complement of that,
  // scoped to the automationActions row rather than the aiActionRequests row.
  await publishAutomationEvent(
    "AUTOMATION_ACTION_FAILED",
    event,
    { executionId: execution.id, actionId: row.id, actionKey: action.actionKey, reason: execResult.reason },
    `automation_action:${row.id}:AUTOMATION_ACTION_FAILED:${row.attemptCount + 1}`,
  );
  return "FAILED";
}

function computeExecutionStatus(outcomes: AutomationActionOutcome[]): "COMPLETED" | "BLOCKED" | "AWAITING_APPROVAL" | "FAILED" | "PARTIALLY_COMPLETED" {
  if (outcomes.length === 0) return "COMPLETED";
  if (outcomes.every((o) => o === "SUCCEEDED")) return "COMPLETED";
  if (outcomes.every((o) => o === "BLOCKED")) return "BLOCKED";
  if (outcomes.some((o) => o === "AWAITING_APPROVAL")) return "AWAITING_APPROVAL";
  if (outcomes.every((o) => o === "FAILED")) return "FAILED";
  return "PARTIALLY_COMPLETED";
}

// ---------------------------------------------------------------------
// Component 13: safe retry behaviour for retryable actions. A foundation
// primitive, callable explicitly (by an admin action or a future worker) —
// no scheduler/worker exists anywhere in this codebase yet (confirmed by
// repository search) to call this automatically, and building one is
// out of scope for this foundation stage (see the WF2 report's deferred
// section). Never inserts a new automationActions row: attemptCount
// increments on the SAME row, per its own unique-index comment.
// ---------------------------------------------------------------------

export type RetryDenialReason = "NOT_FOUND" | "NOT_RETRYABLE_STATUS" | "MAX_ATTEMPTS_REACHED" | "NON_RETRYABLE_FAILURE";

// Failure classes that must never be blindly retried — retrying a tampered
// or policy-denied request would just fail identically (or, worse, mask a
// real security event as routine flakiness). Only a genuine execution-time
// failure (e.g. the underlying domain function threw) is retryable.
const NON_RETRYABLE_ERROR_PATTERN = /PAYLOAD_TAMPERED|POLICY_DENIED|ACTION_NOT_FOUND|NOT_FOUND/;

export async function retryAutomationAction(
  actionId: string,
  brokerageId: number,
): Promise<{ ok: true; status: AutomationActionOutcome } | { ok: false; reason: RetryDenialReason }> {
  const [row] = await db
    .select({ action: automationActions, execution: automationExecutions })
    .from(automationActions)
    .innerJoin(automationExecutions, eq(automationActions.executionId, automationExecutions.id))
    .where(and(eq(automationActions.id, actionId), eq(automationExecutions.brokerageId, brokerageId)));
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const { action, execution } = row;
  if (action.status !== "FAILED") return { ok: false, reason: "NOT_RETRYABLE_STATUS" };
  if (action.attemptCount >= action.maxAttempts) return { ok: false, reason: "MAX_ATTEMPTS_REACHED" };
  if (action.errorMessage && NON_RETRYABLE_ERROR_PATTERN.test(action.errorMessage)) {
    return { ok: false, reason: "NON_RETRYABLE_FAILURE" };
  }

  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, execution.ruleId));
  if (!rule) return { ok: false, reason: "NOT_FOUND" };

  const [version] = await db.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, execution.ruleVersionId));
  if (!version) return { ok: false, reason: "NOT_FOUND" };

  // Re-verify authority fresh, exactly as the original attempt did — an
  // approver who was valid at first attempt may no longer be.
  const approver = await resolveVersionApprover(version, brokerageId);
  if (!approver) return { ok: false, reason: "NON_RETRYABLE_FAILURE" };

  const [eventRow] = await db.select().from(domainEvents).where(eq(domainEvents.id, execution.triggeringEventId));
  if (!eventRow) return { ok: false, reason: "NOT_FOUND" };
  const triggeringEvent = { ...eventRow, handlerErrors: eventRow.handlerErrors as DomainEvent["handlerErrors"] } as DomainEvent;
  const facts = buildFacts(triggeringEvent);

  const outcome = await executeAutomationAction({
    execution,
    rule,
    approver,
    action: { actionKey: action.actionKey, params: action.params },
    sequence: action.sequence,
    event: triggeringEvent,
    facts,
  });

  return { ok: true, status: outcome };
}
