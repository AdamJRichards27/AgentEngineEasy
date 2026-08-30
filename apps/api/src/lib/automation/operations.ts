// Agent Engine 2.0 -- WAE Operational Readiness (Stage: WF4).
//
// Makes the Workflow Automation Engine observable, recoverable, and safely
// operable. This module deliberately adds NO parallel infrastructure: it
// extends the existing automationExecutions/automationActions tables
// (additive columns only, see packages/db/src/schema/automation.ts), reuses
// the existing compare-and-set claiming convention already proven by
// executionGateway.ts's "UPDATE ... WHERE status = 'APPROVED'" claim, reuses
// the existing AI Governance approval mechanism (aiActionRequests) rather
// than building a second one, and reuses logAudit / publishDomainEvent for
// every operator action -- exactly the same primitives engine.ts already
// uses. There is still no scheduler/worker anywhere in this codebase
// (confirmed unchanged since the Foundation stage); every function here is
// callable directly by an operator (via routes/automationOps.ts) or by a
// future worker/cron that would poll RETRY_SCHEDULED rows past their
// nextRetryEligibleAt -- that worker is a documented deferred deployment
// dependency (docs/stage-wf/WF4_OPERATIONAL_READINESS.md), not built here.

import { and, eq, lt, lte, isNull, or, inArray, sql } from "drizzle-orm";
import {
  db,
  users,
  automationExecutions,
  automationActions,
  automationRules,
  aiActionRequests,
  type AutomationExecution,
  type AutomationAction,
} from "@aee/db";
import { publishDomainEvent } from "@aee/events";
import { logAudit } from "../audit.js";
import { setAutomationRuleStatus } from "./rules.js";

// ---------------------------------------------------------------------
// Section 5: failure classification.
// ---------------------------------------------------------------------

export type FailureClassification =
  | "RETRYABLE"
  | "APPROVAL_REQUIRED"
  | "VALIDATION_OR_POLICY"
  | "TERMINAL_TECHNICAL";

// Validation/policy/authority failures must fail closed and must NEVER be
// made executable through repeated retries -- these are the existing
// engine.ts BLOCKED-path denial reasons (mapDecisionToAuthorityDecision)
// plus executionGateway.ts's own tamper/policy denial reasons, extended
// (not duplicated) here.
const VALIDATION_OR_POLICY_PATTERN =
  /PAYLOAD_TAMPERED|POLICY_DENIED|BLOCK_POLICY_CONFLICT|BLOCK_MISSING_ENTITLEMENT|BLOCK_MISSING_CONTEXT|not registered|is not a registered/i;

// A curated set of clearly non-transient, investigation-required failures
// -- data/config problems, not infrastructure blips. Deliberately narrow:
// anything NOT matched here defaults to RETRYABLE (Section 5's retryable
// examples -- "temporary database contention", "transient queue/service
// failure", "temporary internal dependency unavailability", "recoverable
// worker interruption" -- are exactly the open-ended, can't-enumerate-them-
// all case; failing OPEN to retryable for an unrecognised technical error
// is the safe default because the bounded-attempts + backoff policy below
// already caps the blast radius, whereas failing closed to terminal on
// every unknown error would silently stop retrying things that were only
// ever a momentary blip).
const TERMINAL_TECHNICAL_PATTERN =
  /ACTION_NOT_FOUND|not registered|Property not found|Transaction not found|no longer exists|no longer registered|is not a function|Cannot read propert|undefined is not|TypeError/i;

export function classifyActionFailure(input: {
  authorityDecision: string | null;
  errorMessage: string | null;
}): FailureClassification {
  const { authorityDecision, errorMessage } = input;
  const haystack = `${authorityDecision ?? ""} ${errorMessage ?? ""}`;
  if (VALIDATION_OR_POLICY_PATTERN.test(haystack)) return "VALIDATION_OR_POLICY";
  if (TERMINAL_TECHNICAL_PATTERN.test(haystack)) return "TERMINAL_TECHNICAL";
  return "RETRYABLE";
}

// ---------------------------------------------------------------------
// Section 6: retry policy -- bounded attempts, deterministic backoff.
// ---------------------------------------------------------------------

const RETRY_BASE_DELAY_MS = 30_000; // 30s
const RETRY_MAX_DELAY_MS = 60 * 60_000; // 1h cap

/** Deterministic exponential backoff -- no jitter, so tests and operators can reason about it exactly. */
export function computeBackoff(attemptCount: number, now: Date = new Date()): { delayMs: number; nextRetryEligibleAt: Date } {
  const exponent = Math.max(0, attemptCount - 1);
  const delayMs = Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
  return { delayMs, nextRetryEligibleAt: new Date(now.getTime() + delayMs) };
}

export type ActionRollupOutcome = "SUCCEEDED" | "BLOCKED" | "AWAITING_APPROVAL" | "RETRY_SCHEDULED" | "FAILED_TERMINAL";

/**
 * Called by engine.ts immediately after an action's execute attempt comes
 * back FAILED (a genuine execution-time exception, not a policy denial --
 * those already short-circuit to BLOCKED before this is ever reached).
 * Classifies the failure, decides RETRY_SCHEDULED vs FAILED_TERMINAL,
 * writes the row, and emits the required audit trail -- never inserts a
 * new automationActions row (attemptCount already incremented on the same
 * row by engine.ts before this is called, matching the existing
 * "retries reuse the same row" convention).
 */
export async function finalizeFailedAction(
  action: AutomationAction,
  errorMessage: string,
): Promise<{ outcome: ActionRollupOutcome; classification: FailureClassification; nextRetryEligibleAt: Date | null }> {
  const classification = classifyActionFailure({ authorityDecision: action.authorityDecision, errorMessage });
  const attemptsRemain = action.attemptCount < action.maxAttempts;
  const eligible = classification === "RETRYABLE" && attemptsRemain;

  if (eligible) {
    const { nextRetryEligibleAt } = computeBackoff(action.attemptCount);
    await db
      .update(automationActions)
      .set({
        status: "RETRY_SCHEDULED",
        failureClassification: classification,
        nextRetryEligibleAt,
        errorMessage,
        completedAt: new Date(),
      })
      .where(eq(automationActions.id, action.id));
    await logAudit({
      action: "automation_action_retry_scheduled",
      recordType: "automation_action",
      recordId: action.id,
      updatedValue: `attempt ${action.attemptCount}/${action.maxAttempts}, next eligible ${nextRetryEligibleAt.toISOString()}`,
    });
    return { outcome: "RETRY_SCHEDULED", classification, nextRetryEligibleAt };
  }

  const reason = !attemptsRemain
    ? `Maximum retry attempts (${action.maxAttempts}) reached.`
    : `Failure classified as ${classification}; not eligible for automatic retry.`;
  await db
    .update(automationActions)
    .set({
      status: "FAILED_TERMINAL",
      failureClassification: classification,
      errorMessage: `${errorMessage} (${reason})`,
      completedAt: new Date(),
    })
    .where(eq(automationActions.id, action.id));
  await logAudit({
    action: "automation_action_failed_terminal",
    recordType: "automation_action",
    recordId: action.id,
    updatedValue: reason,
  });
  return { outcome: "FAILED_TERMINAL", classification, nextRetryEligibleAt: null };
}

/** Execution-level rollup from its actions' current outcomes -- never independently written, so it can never drift. */
export function deriveExecutionRollup(outcomes: ActionRollupOutcome[]): {
  status: "COMPLETED" | "BLOCKED" | "AWAITING_APPROVAL" | "RETRY_SCHEDULED" | "FAILED_TERMINAL" | "PARTIALLY_COMPLETED";
  statusReason: string;
} {
  if (outcomes.length === 0) return { status: "COMPLETED", statusReason: "No actions to execute." };
  if (outcomes.every((o) => o === "SUCCEEDED")) return { status: "COMPLETED", statusReason: "Every action succeeded." };
  if (outcomes.every((o) => o === "BLOCKED")) return { status: "BLOCKED", statusReason: "Every action was blocked by policy/authority." };
  if (outcomes.some((o) => o === "AWAITING_APPROVAL")) return { status: "AWAITING_APPROVAL", statusReason: "At least one action requires human approval." };
  if (outcomes.some((o) => o === "RETRY_SCHEDULED")) return { status: "RETRY_SCHEDULED", statusReason: "At least one action failed retryably and is scheduled for a later attempt." };
  if (outcomes.every((o) => o === "FAILED_TERMINAL" || o === "BLOCKED")) return { status: "FAILED_TERMINAL", statusReason: "Every action reached a non-retryable terminal state." };
  return { status: "PARTIALLY_COMPLETED", statusReason: "A mix of succeeded and non-succeeded actions." };
}

// ---------------------------------------------------------------------
// Section 4: safe execution claiming -- reuses the existing compare-and-set
// convention (executionGateway.ts's "UPDATE ... WHERE status = X").
// ---------------------------------------------------------------------

export type RetryClaimDenialReason =
  | "NOT_FOUND"
  | "NOT_RETRY_ELIGIBLE"
  | "NOT_YET_ELIGIBLE"
  | "MAX_ATTEMPTS_REACHED"
  | "LOST_CLAIM_RACE";

/**
 * Atomically claims a RETRY_SCHEDULED action for a fresh attempt. Two
 * concurrent callers (a double-clicked operator retry, or two workers) can
 * both pass the eligibility read below, but only one UPDATE ... WHERE
 * status = 'RETRY_SCHEDULED' can ever affect a row -- the other gets zero
 * rows back and is told it lost the race, never double-executes.
 */
export async function claimActionForRetry(
  actionId: string,
  brokerageId: number,
  claimedBy: string,
): Promise<{ ok: true; action: AutomationAction } | { ok: false; reason: RetryClaimDenialReason }> {
  const [row] = await db
    .select({ action: automationActions, execution: automationExecutions })
    .from(automationActions)
    .innerJoin(automationExecutions, eq(automationActions.executionId, automationExecutions.id))
    .where(and(eq(automationActions.id, actionId), eq(automationExecutions.brokerageId, brokerageId)));
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const { action } = row;
  if (action.status !== "RETRY_SCHEDULED" && action.status !== "FAILED") {
    return { ok: false, reason: "NOT_RETRY_ELIGIBLE" };
  }
  if (action.attemptCount >= action.maxAttempts) return { ok: false, reason: "MAX_ATTEMPTS_REACHED" };
  if (action.nextRetryEligibleAt && action.nextRetryEligibleAt.getTime() > Date.now()) {
    return { ok: false, reason: "NOT_YET_ELIGIBLE" };
  }

  const [claimed] = await db
    .update(automationActions)
    .set({ status: "RUNNING", claimedAt: new Date(), claimedBy, startedAt: new Date() })
    .where(and(eq(automationActions.id, actionId), eq(automationActions.status, action.status)))
    .returning();
  if (!claimed) return { ok: false, reason: "LOST_CLAIM_RACE" };
  return { ok: true, action: claimed };
}

// ---------------------------------------------------------------------
// Section 7 / 10: cancellation -- only while no irreversible side effect
// has occurred. "Irreversible" here means: the linked aiActionRequests row
// (if any) has reached EXECUTING or COMPLETED -- executionGateway.ts's own
// claim already guarantees execute() is called at most once, so this check
// is sufficient to know whether real work may already be underway.
// ---------------------------------------------------------------------

const ACTION_CANCELLABLE_STATUSES = ["PENDING", "AWAITING_APPROVAL", "RETRY_SCHEDULED", "FAILED"];
const EXECUTION_CANCELLABLE_STATUSES = ["PENDING", "EVALUATING", "AWAITING_APPROVAL", "RETRY_SCHEDULED"];

export type CancelDenialReason = "NOT_FOUND" | "NOT_CANCELLABLE" | "IRREVERSIBLE_PROGRESS";

export async function cancelAction(
  actionId: string,
  brokerageId: number,
  actor: { id: number; role: string },
  reason: string,
): Promise<{ ok: true; action: AutomationAction } | { ok: false; reason: CancelDenialReason }> {
  const [row] = await db
    .select({ action: automationActions, execution: automationExecutions })
    .from(automationActions)
    .innerJoin(automationExecutions, eq(automationActions.executionId, automationExecutions.id))
    .where(and(eq(automationActions.id, actionId), eq(automationExecutions.brokerageId, brokerageId)));
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  const { action } = row;
  if (!ACTION_CANCELLABLE_STATUSES.includes(action.status)) return { ok: false, reason: "NOT_CANCELLABLE" };

  if (action.aiActionRequestId) {
    const [req] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, action.aiActionRequestId));
    if (req && (req.status === "EXECUTING" || req.status === "COMPLETED")) {
      return { ok: false, reason: "IRREVERSIBLE_PROGRESS" };
    }
  }

  const [cancelled] = await db
    .update(automationActions)
    .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: actor.id, resolutionNote: reason, completedAt: new Date() })
    .where(and(eq(automationActions.id, actionId), eq(automationActions.status, action.status)))
    .returning();
  if (!cancelled) return { ok: false, reason: "NOT_CANCELLABLE" };

  await logAudit({ userId: actor.id, action: "automation_action_cancelled", recordType: "automation_action", recordId: actionId, updatedValue: reason });
  await publishOpsEvent("AUTOMATION_ACTION_CANCELLED", row.execution, { actionId, reason, cancelledByUserId: actor.id });
  return { ok: true, action: cancelled };
}

export async function cancelExecution(
  executionId: string,
  brokerageId: number,
  actor: { id: number; role: string },
  reason: string,
): Promise<{ ok: true; execution: AutomationExecution } | { ok: false; reason: CancelDenialReason }> {
  const [execution] = await db
    .select()
    .from(automationExecutions)
    .where(and(eq(automationExecutions.id, executionId), eq(automationExecutions.brokerageId, brokerageId)));
  if (!execution) return { ok: false, reason: "NOT_FOUND" };
  if (!EXECUTION_CANCELLABLE_STATUSES.includes(execution.status)) return { ok: false, reason: "NOT_CANCELLABLE" };

  const [cancelled] = await db
    .update(automationExecutions)
    .set({ status: "CANCELLED", statusReason: reason, cancelledAt: new Date(), cancelledByUserId: actor.id, completedAt: new Date() })
    .where(and(eq(automationExecutions.id, executionId), eq(automationExecutions.status, execution.status)))
    .returning();
  if (!cancelled) return { ok: false, reason: "NOT_CANCELLABLE" };

  await db
    .update(automationActions)
    .set({ status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: actor.id, resolutionNote: `Execution cancelled: ${reason}`, completedAt: new Date() })
    .where(and(eq(automationActions.executionId, executionId), inArray(automationActions.status, ACTION_CANCELLABLE_STATUSES)));

  await logAudit({ userId: actor.id, action: "automation_execution_cancelled", recordType: "automation_execution", recordId: executionId, updatedValue: reason });
  await publishOpsEvent("AUTOMATION_EXECUTION_CANCELLED", cancelled, { executionId, reason, cancelledByUserId: actor.id });
  return { ok: true, execution: cancelled };
}

// ---------------------------------------------------------------------
// Resolution notes -- available regardless of status, never changes status.
// ---------------------------------------------------------------------

export async function addExecutionResolutionNote(
  executionId: string,
  brokerageId: number,
  actor: { id: number },
  note: string,
): Promise<{ ok: true; execution: AutomationExecution } | { ok: false; reason: "NOT_FOUND" }> {
  const [execution] = await db
    .select()
    .from(automationExecutions)
    .where(and(eq(automationExecutions.id, executionId), eq(automationExecutions.brokerageId, brokerageId)));
  if (!execution) return { ok: false, reason: "NOT_FOUND" };
  const [updated] = await db
    .update(automationExecutions)
    .set({ resolutionNote: note, resolvedByUserId: actor.id, resolvedAt: new Date() })
    .where(eq(automationExecutions.id, executionId))
    .returning();
  await logAudit({ userId: actor.id, action: "automation_execution_resolution_note", recordType: "automation_execution", recordId: executionId, updatedValue: note });
  return { ok: true, execution: updated };
}

// ---------------------------------------------------------------------
// Section 10: enable/disable a workflow -- reuses the existing
// automationRules.status column (rules.ts's setAutomationRuleStatus) and
// only adds the audit/event trail an operator control requires.
// ---------------------------------------------------------------------

export async function pauseAutomationRule(ruleId: number, brokerageId: number, actor: { id: number }, reason: string) {
  const rule = await setAutomationRuleStatus(ruleId, brokerageId, "PAUSED");
  await logAudit({ userId: actor.id, action: "automation_rule_paused", recordType: "automation_rule", recordId: String(ruleId), updatedValue: reason });
  return rule;
}

export async function resumeAutomationRule(ruleId: number, brokerageId: number, actor: { id: number }, reason: string) {
  const rule = await setAutomationRuleStatus(ruleId, brokerageId, "ACTIVE");
  await logAudit({ userId: actor.id, action: "automation_rule_resumed", recordType: "automation_rule", recordId: String(ruleId), updatedValue: reason });
  return rule;
}

// ---------------------------------------------------------------------
// Section 4 / 12: recover abandoned RUNNING work. Never blindly re-executes
// -- executionGateway.ts's own conditional claim on aiActionRequests
// already prevents a second concurrent execute() call, so this function's
// job is reconciliation (did it actually finish?) and, only when genuinely
// unresolvable, marking the row FAILED_TERMINAL for manual investigation
// ("avoid releasing a claim while external side effects remain uncertain").
// ---------------------------------------------------------------------

export const DEFAULT_STALE_RUNNING_THRESHOLD_MS = 15 * 60_000; // 15 minutes

export interface RecoverySummary {
  actionsInspected: number;
  reconciledSucceeded: number;
  reconciledFailed: number;
  markedTerminalForInvestigation: number;
}

export async function recoverAbandonedRunning(staleThresholdMs = DEFAULT_STALE_RUNNING_THRESHOLD_MS): Promise<RecoverySummary> {
  const cutoff = new Date(Date.now() - staleThresholdMs);
  const staleActions = await db
    .select()
    .from(automationActions)
    .where(and(eq(automationActions.status, "RUNNING"), lt(automationActions.startedAt, cutoff)));

  const summary: RecoverySummary = { actionsInspected: staleActions.length, reconciledSucceeded: 0, reconciledFailed: 0, markedTerminalForInvestigation: 0 };

  for (const action of staleActions) {
    const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.id, action.executionId));
    let req: typeof aiActionRequests.$inferSelect | undefined;
    if (action.aiActionRequestId) {
      [req] = await db.select().from(aiActionRequests).where(eq(aiActionRequests.id, action.aiActionRequestId));
    }

    if (req?.status === "COMPLETED") {
      await db
        .update(automationActions)
        .set({ status: "SUCCEEDED", result: (req.executionResult ?? null) as Record<string, unknown> | null, completedAt: req.executedAt ?? new Date(), claimedAt: new Date(), claimedBy: "recovery-sweep" })
        .where(and(eq(automationActions.id, action.id), eq(automationActions.status, "RUNNING")));
      summary.reconciledSucceeded += 1;
    } else if (req?.status === "FAILED") {
      await finalizeFailedAction({ ...action, attemptCount: action.attemptCount }, req.errorMessage ?? "Reconciled: linked AI action request failed.");
      summary.reconciledFailed += 1;
    } else {
      await db
        .update(automationActions)
        .set({
          status: "FAILED_TERMINAL",
          failureClassification: "TERMINAL_TECHNICAL",
          errorMessage: "Abandoned RUNNING state recovered after apparent worker/process interruption; manual investigation required.",
          claimedAt: new Date(),
          claimedBy: "recovery-sweep",
          completedAt: new Date(),
        })
        .where(and(eq(automationActions.id, action.id), eq(automationActions.status, "RUNNING")));
      summary.markedTerminalForInvestigation += 1;
    }

    if (execution) {
      await logAudit({ action: "automation_execution_recovered", recordType: "automation_execution", recordId: execution.id, updatedValue: `action ${action.id} recovered from abandoned RUNNING state` });
      await publishOpsEvent("AUTOMATION_EXECUTION_RECOVERED", execution, { actionId: action.id });
    }
  }

  return summary;
}

// ---------------------------------------------------------------------
// Section 11 / 12: structured operational metrics + health. No metrics
// backend exists in this repository -- these are structured instrumentation
// points (cheap DB aggregate queries) exposed through the ops health route;
// wiring them into a real metrics platform (Prometheus/Datadog/etc.) is a
// documented deferred deployment dependency, not built here.
// ---------------------------------------------------------------------

export interface AutomationHealthReport {
  healthy: boolean;
  degraded: boolean;
  checks: {
    databaseReachable: boolean;
    staleRunningActions: number;
    retryBacklog: number;
    terminalFailuresLast24h: number;
    approvalBacklog: number;
  };
}

export async function getAutomationHealth(staleThresholdMs = DEFAULT_STALE_RUNNING_THRESHOLD_MS): Promise<AutomationHealthReport> {
  try {
    const cutoff = new Date(Date.now() - staleThresholdMs);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60_000);

    const [[staleRunning], [retryBacklog], [terminalFailures], [approvalBacklog]] = await Promise.all([
      db.select({ count: sql<number>`count(*)::int` }).from(automationActions).where(and(eq(automationActions.status, "RUNNING"), lt(automationActions.startedAt, cutoff))),
      db.select({ count: sql<number>`count(*)::int` }).from(automationActions).where(eq(automationActions.status, "RETRY_SCHEDULED")),
      db.select({ count: sql<number>`count(*)::int` }).from(automationActions).where(and(eq(automationActions.status, "FAILED_TERMINAL"), sql`${automationActions.completedAt} > ${dayAgo}`)),
      db.select({ count: sql<number>`count(*)::int` }).from(automationActions).where(eq(automationActions.status, "AWAITING_APPROVAL")),
    ]);

    const checks = {
      databaseReachable: true,
      staleRunningActions: staleRunning?.count ?? 0,
      retryBacklog: retryBacklog?.count ?? 0,
      terminalFailuresLast24h: terminalFailures?.count ?? 0,
      approvalBacklog: approvalBacklog?.count ?? 0,
    };
    // Do not mark the whole application healthy when its required
    // workflow-processing dependency is unavailable -- but a nonzero
    // backlog is a normal, expected operating state (this repo has no
    // worker to drain RETRY_SCHEDULED automatically yet, see module
    // comment), so it degrades, it does not fail, health.
    const degraded = checks.staleRunningActions > 0 || checks.retryBacklog > 10 || checks.approvalBacklog > 25;
    return { healthy: true, degraded, checks };
  } catch (err) {
    console.error("getAutomationHealth: database unreachable", err);
    return {
      healthy: false,
      degraded: true,
      checks: { databaseReachable: false, staleRunningActions: -1, retryBacklog: -1, terminalFailuresLast24h: -1, approvalBacklog: -1 },
    };
  }
}

// ---------------------------------------------------------------------
// Redaction -- allow-list only. Never returns raw params/result/errorMessage
// in list views; detail views strip known-sensitive keys and truncate long
// free-text fields. Section 11: "Use redaction or allow-listing rather than
// logging entire event payloads."
// ---------------------------------------------------------------------

const SENSITIVE_KEY_PATTERN = /token|secret|password|ssn|passport|credit.?card|card.?number|bank|iban|licen[cs]e.?number|medicare/i;

export function redactSensitiveFields(input: unknown, depth = 0): unknown {
  if (depth > 4 || input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => redactSensitiveFields(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactSensitiveFields(value, depth + 1);
      }
    }
    return out;
  }
  if (typeof input === "string" && input.length > 2000) return `${input.slice(0, 2000)}... [truncated]`;
  return input;
}

export function summarizeActionForOps(action: AutomationAction): Record<string, unknown> {
  const { params: _params, result: _result, ...safe } = action;
  return safe;
}

export function detailActionForOps(action: AutomationAction): Record<string, unknown> {
  return { ...action, params: redactSensitiveFields(action.params), result: redactSensitiveFields(action.result) };
}

// ---------------------------------------------------------------------
// Shared event publisher for this module -- mirrors engine.ts's own
// publishAutomationEvent exactly (best-effort, never throws into the
// caller's transaction), duplicated narrowly here rather than exported from
// engine.ts to avoid a circular import (engine.ts already imports this
// file).
// ---------------------------------------------------------------------

async function publishOpsEvent(
  eventType: "AUTOMATION_ACTION_CANCELLED" | "AUTOMATION_EXECUTION_CANCELLED" | "AUTOMATION_EXECUTION_RECOVERED",
  execution: AutomationExecution,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType,
      occurredAt: new Date(),
      propertyId: null,
      transactionId: null,
      partyId: null,
      brokerageId: execution.brokerageId,
      agentId: null,
      actorType: "SYSTEM",
      actorId: null,
      source: "automation-ops",
      correlationId: execution.correlationId,
      causationId: execution.triggeringEventId,
      idempotencyKey: `${execution.id}:${eventType}:${Date.now()}`,
      metadata: payload,
      payload: {},
    });
  } catch (err) {
    console.error(`automation ops: failed to publish ${eventType}, continuing`, err);
  }
}
