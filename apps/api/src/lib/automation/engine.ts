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
// proposeAIAction(), then the Execution Gateway (executeAIActionAsSystem(),
// its SYSTEM-only entry point since Stage F4.0) as the sole caller of an
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
  type AutomationAction,
} from "@aee/db";
import { publishDomainEvent, logger, incrementCounter, type DomainEvent } from "@aee/events";
import { getActionDefinition } from "../ai/actions/registry.js";
import { proposeAIAction, recoverStuckExecutingActionRequests, DEFAULT_STUCK_EXECUTING_THRESHOLD_MS } from "../ai/actionRequests.js";
import { executeAIActionAsSystem } from "../ai/executionGateway.js";
import type { PolicyActor, PolicyDecision } from "../ai/policyEngine.js";
import { buildFacts, type AutomationFacts } from "./facts.js";
import { evaluateConditionGroup, type AutomationConditionGroup } from "./conditions.js";
import { resolveActionParams } from "./templating.js";
import { getActiveRuleVersionsForTrigger, type AutomationRuleAction } from "./rules.js";
import { AUTOMATION_ENGINE_HANDLER_NAME, type AutomationAuthorityDecision } from "./types.js";
import {
  finalizeFailedAction,
  deriveExecutionRollup,
  deriveExecutionRollupExtras,
  claimActionForRetry,
  type ActionRollupOutcome,
} from "./operations.js";

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

// ---------------------------------------------------------------------
// AE GROW Priority 6 Stage F4.0 (D5) — stuck-EXECUTING AI action recovery.
// There is no AI-action scheduler, and recoverAbandonedRunning()
// (operations.ts) has no production caller, so the automation engine's own
// per-event processing is the periodic path: at most once per
// STUCK_AI_ACTION_SWEEP_INTERVAL_MS per process, one bounded, unscoped
// recoverStuckExecutingActionRequests() batch runs (it only ever marks
// stale EXECUTING rows FAILED and audits them; it never executes
// anything). The throttle timestamp is taken BEFORE the sweep, so the
// AI_ACTION_FAILED events the sweep itself publishes (which are dispatched
// back into this handler) never re-enter it. A sweep failure is logged
// and never affects event handling.
// ---------------------------------------------------------------------
export const STUCK_AI_ACTION_SWEEP_INTERVAL_MS = 5 * 60_000;
const STUCK_AI_ACTION_SWEEP_BATCH = 100;
let lastStuckAiActionSweepAt = 0;

export async function sweepStuckAiActionRequestsIfDue(now: number = Date.now()): Promise<number> {
  if (now - lastStuckAiActionSweepAt < STUCK_AI_ACTION_SWEEP_INTERVAL_MS) return 0;
  lastStuckAiActionSweepAt = now;
  try {
    const recovered = await recoverStuckExecutingActionRequests(DEFAULT_STUCK_EXECUTING_THRESHOLD_MS, { limit: STUCK_AI_ACTION_SWEEP_BATCH });
    return recovered.length;
  } catch (err) {
    logger.error("automation_stuck_ai_action_sweep_failed", { error: err });
    return 0;
  }
}

/** Test-only: make the next sweepStuckAiActionRequestsIfDue() call run immediately. */
export function resetStuckAiActionSweepThrottleForTests(): void {
  lastStuckAiActionSweepAt = 0;
}

export async function handleAutomationDomainEvent(event: DomainEvent): Promise<void> {
  await sweepStuckAiActionRequestsIfDue();

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
        logger.error("automation_rule_evaluation_threw", {
          ruleId: rule.id,
          ruleVersionId: version.id,
          eventId: event.id,
          eventType: event.eventType,
          brokerageId: event.brokerageId,
          error: err,
        });
        incrementCounter("workflow_execution_failure_total", { workflow: "automation_rule" });
      }
    }
    await markReceiptProcessed(claim.receiptId);
  } catch (err) {
    await markReceiptFailed(claim.receiptId, err);
    throw err;
  }
}

async function publishAutomationEvent(
  eventType: "AUTOMATION_EXECUTION_SKIPPED" | "AUTOMATION_EXECUTION_COMPLETED" | "AUTOMATION_ACTION_BLOCKED" | "AUTOMATION_ACTION_FAILED" | "AUTOMATION_ACTION_RETRY_SCHEDULED",
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
    logger.error("automation_publish_domain_event_failed", {
      eventType,
      triggeringEventId: triggeringEvent.id,
      brokerageId: triggeringEvent.brokerageId,
      error: err,
    });
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
      .set({
        status: "SKIPPED",
        conditionResult,
        statusReason: "Condition group did not match the triggering event.",
        startedAt: new Date(),
        completedAt: new Date(),
      })
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

  const { status: finalStatus, actionCount } = await recomputeExecutionRollup(execution);

  if (finalStatus === "COMPLETED") {
    await publishAutomationEvent(
      "AUTOMATION_EXECUTION_COMPLETED",
      event,
      { ruleId: rule.id, ruleVersionId: version.id, executionId: execution.id, actionCount },
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
    .set({ status: "BLOCKED", errorMessage, statusReason: errorMessage, completedAt: new Date() })
    .where(eq(automationExecutions.id, execution.id));
}

// ---------------------------------------------------------------------
// Per-action execution — routes through the SAME proposeAIAction/executeAIAction
// pipeline every human/AI-initiated action uses. actorType "SYSTEM" is
// exactly what aiActionRequests.actorType and addPropertyNote's actorType
// parameter already documented as a valid value before this PR.
// ---------------------------------------------------------------------

type AutomationActionOutcome = ActionRollupOutcome; // "SUCCEEDED" | "BLOCKED" | "AWAITING_APPROVAL" | "RETRY_SCHEDULED" | "FAILED_TERMINAL" | "CANCELLED"

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
  // Stage F4.0: the explicitly named SYSTEM execution path. It refuses any
  // request that is not actorType "SYSTEM" + auto-execute-eligible, so a
  // human-approval-required action can never be run from here.
  const execResult = await executeAIActionAsSystem(request.id, rule.brokerageId);

  if (execResult.ok) {
    await db
      .update(automationActions)
      .set({ status: "SUCCEEDED", result: (execResult.result ?? null) as Record<string, unknown> | null, completedAt: new Date() })
      .where(eq(automationActions.id, row.id));
    return "SUCCEEDED";
  }

  // Component: safe, bounded retry with deterministic backoff
  // (operations.ts's finalizeFailedAction/classifyActionFailure) — a
  // genuine execution-time failure is never blindly retried forever nor
  // silently dropped; it is classified, and only a RETRYABLE classification
  // with attempts remaining is scheduled for a later attempt. Never inserts
  // a new automationActions row: attemptCount was already incremented on
  // this SAME row above, before this branch is reached.
  const failureMessage = execResult.errorMessage ?? execResult.reason ?? "Execution failed";
  const actionForClassification: AutomationAction = { ...row, attemptCount: row.attemptCount + 1, authorityDecision };
  const { outcome, classification, nextRetryEligibleAt } = await finalizeFailedAction(actionForClassification, failureMessage);
  // AUTOMATION_ACTION_FAILED already exists in the canonical catalogue
  // (added in the same prior-session change that added AUTOMATION_ACTION_BLOCKED);
  // AI_ACTION_FAILED was already published by executeAIAction itself
  // (actionEvents.ts) — this is the automation-specific complement of that,
  // scoped to the automationActions row rather than the aiActionRequests row.
  // AUTOMATION_ACTION_RETRY_SCHEDULED (new this stage) gives the retry path
  // its own distinct, filterable event instead of overloading FAILED for a
  // state that is not actually terminal.
  const failureEventType = outcome === "RETRY_SCHEDULED" ? "AUTOMATION_ACTION_RETRY_SCHEDULED" : "AUTOMATION_ACTION_FAILED";
  await publishAutomationEvent(
    failureEventType,
    event,
    { executionId: execution.id, actionId: row.id, actionKey: action.actionKey, reason: execResult.reason, classification, nextRetryEligibleAt },
    `automation_action:${row.id}:${failureEventType}:${row.attemptCount + 1}`,
  );
  return outcome;
}

function mapActionStatusToOutcome(status: string): AutomationActionOutcome | null {
  switch (status) {
    case "SUCCEEDED":
    case "BLOCKED":
    case "AWAITING_APPROVAL":
    case "RETRY_SCHEDULED":
    case "FAILED_TERMINAL":
    case "CANCELLED":
      return status as AutomationActionOutcome;
    case "FAILED":
      // Legacy pre-classification terminal value (predates finalizeFailedAction);
      // treated as a non-retryable terminal outcome for rollup purposes.
      return "FAILED_TERMINAL";
    default:
      // PENDING / RUNNING are transient, in-flight states that should never
      // be observed here in practice (every action this function is asked
      // to roll up has already been executed at least once by the time this
      // is called) -- excluded rather than guessed at if one somehow is.
      return null;
  }
}

// Single source of truth for recomputing and persisting an execution's
// rollup (status/statusReason/lastFailureClassification/nextRetryEligibleAt)
// from its CURRENT automationActions rows -- used both after a fresh
// evaluation runs all of a rule version's actions, and after a single
// action is retried (retryAutomationAction, below), so the two call sites
// can never compute this differently.
async function recomputeExecutionRollup(execution: AutomationExecution): Promise<{ status: string; actionCount: number }> {
  const actionRows = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  const outcomes = actionRows
    .map((a) => mapActionStatusToOutcome(a.status))
    .filter((o): o is AutomationActionOutcome => o !== null);
  const rollup = deriveExecutionRollup(outcomes);
  const extras = deriveExecutionRollupExtras(actionRows);
  await db
    .update(automationExecutions)
    .set({
      status: rollup.status,
      statusReason: rollup.statusReason,
      lastFailureClassification: extras.lastFailureClassification,
      nextRetryEligibleAt: extras.nextRetryEligibleAt,
      completedAt: new Date(),
    })
    .where(eq(automationExecutions.id, execution.id));
  return { status: rollup.status, actionCount: actionRows.length };
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

export type RetryDenialReason =
  | "NOT_FOUND"
  | "NOT_RETRY_ELIGIBLE"
  | "NOT_YET_ELIGIBLE"
  | "MAX_ATTEMPTS_REACHED"
  | "LOST_CLAIM_RACE"
  | "NON_RETRYABLE_FAILURE";

// Failure classification (RETRYABLE / APPROVAL_REQUIRED / VALIDATION_OR_POLICY
// / TERMINAL_TECHNICAL) now lives centrally in operations.ts's
// classifyActionFailure, applied once at the moment an action first fails
// (finalizeFailedAction, inside executeAutomationAction above). By the time
// an action reaches RETRY_SCHEDULED it has already been classified
// RETRYABLE; re-deriving that classification a second time here from the
// same errorMessage would be a second, potentially disagreeing source of
// truth for the same decision.

export async function retryAutomationAction(
  actionId: string,
  brokerageId: number,
  claimedBy = "system",
): Promise<{ ok: true; status: AutomationActionOutcome } | { ok: false; reason: RetryDenialReason }> {
  // Component 4: safe execution claiming. The atomic compare-and-set claim
  // (operations.ts's claimActionForRetry) is now the sole gate on whether a
  // retry is allowed to proceed — replacing the unguarded read-then-check
  // this function used before this stage. Two concurrent callers can both
  // reach this function for the same action; only one can ever win the
  // claim, so this function can never execute the same attempt twice.
  const claim = await claimActionForRetry(actionId, brokerageId, claimedBy);
  if (!claim.ok) return { ok: false, reason: claim.reason };
  const action = claim.action;

  // From this point the action is claimed (status RUNNING). Every remaining
  // failure branch below must leave the row in a resolved terminal state
  // rather than abandoning it RUNNING — releaseRetryClaim is the single place
  // that does so, so no branch can forget.
  const releaseRetryClaim = async (errorMessage: string): Promise<{ ok: false; reason: RetryDenialReason }> => {
    await db
      .update(automationActions)
      .set({ status: "FAILED_TERMINAL", failureClassification: "VALIDATION_OR_POLICY", errorMessage, completedAt: new Date() })
      .where(and(eq(automationActions.id, action.id), eq(automationActions.status, "RUNNING")));
    return { ok: false, reason: "NON_RETRYABLE_FAILURE" };
  };

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.id, action.executionId));
  if (!execution || execution.brokerageId !== brokerageId) {
    return releaseRetryClaim("Execution record could not be re-verified for this brokerage.");
  }

  const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, execution.ruleId));
  if (!rule) return releaseRetryClaim("Rule record no longer exists.");

  const [version] = await db.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, execution.ruleVersionId));
  if (!version) return releaseRetryClaim("Rule version record no longer exists.");

  // Re-verify authority fresh, exactly as the original attempt did — an
  // approver who was valid at first attempt may no longer be.
  const approver = await resolveVersionApprover(version, brokerageId);
  if (!approver) return releaseRetryClaim("Rule version's approving user could not be re-verified; authority cannot be established.");

  const [eventRow] = await db.select().from(domainEvents).where(eq(domainEvents.id, execution.triggeringEventId));
  if (!eventRow) return releaseRetryClaim("Triggering event record no longer exists.");
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

  // Component: a retry only re-runs ONE action, but the execution's own
  // rollup (status/statusReason/lastFailureClassification/nextRetryEligibleAt)
  // must still reflect the outcome across ALL of its actions afterward —
  // e.g. the last RETRY_SCHEDULED action in a 3-action execution finally
  // succeeding must be able to bring the execution to COMPLETED. Reuses the
  // exact same recompute function the initial evaluation path uses, so the
  // two can never disagree.
  const { status: finalStatus, actionCount } = await recomputeExecutionRollup(execution);
  if (finalStatus === "COMPLETED") {
    await publishAutomationEvent(
      "AUTOMATION_EXECUTION_COMPLETED",
      triggeringEvent,
      { ruleId: rule.id, ruleVersionId: version.id, executionId: execution.id, actionCount },
      `automation_execution:${execution.id}:AUTOMATION_EXECUTION_COMPLETED`,
    );
  }

  return { ok: true, status: outcome };
}
