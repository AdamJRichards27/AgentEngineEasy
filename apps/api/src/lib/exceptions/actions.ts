// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// WAE integration (Build Instructions §13): "recommended actions ... use
// registered WAE actions where execution is required". A risk rule never
// executes anything itself — when its recommended action is "create a
// remediation task", the engine calls straight into
// apps/api/src/lib/automation/tasks.ts's createAutomationTask(), the same
// function Stage 2's rule templates call, rather than inserting a second,
// parallel task record. The task's id is then linked back onto the
// exception (relatedTaskIds) so both directions of the relationship are
// navigable.

import { createAutomationTask } from "../automation/tasks.js";
import { attachRelatedTask } from "./model.js";
import type { UserRole } from "@aee/db";

// Exception remediation tasks use their own closed vocabulary, deliberately
// separate from AUTOMATION_TASK_KEYS (apps/api/src/lib/automation/types.ts)
// — that list is documented as "the Stage 2 workflow catalogue", scoped to
// the five rule templates built in that phase. Reusing it here would mean
// either inventing task keys that don't describe what this engine actually
// creates tasks for, or expanding a vocabulary owned by a different phase.
// createAutomationTask() itself does not validate taskKey against any
// registry (see its own source — validation there happens one layer up, in
// the CREATE_INTERNAL_TASK action's zod schema, which this call bypasses
// by calling the domain function directly, exactly as templates.ts's own
// rule-triggered calls already do), so this closed list is enforced here,
// at the one call site, instead.
export const EXCEPTION_REMEDIATION_TASK_KEYS = [
  "RESOLVE_MISSING_AGREEMENT_OWNER",
  "FOLLOW_UP_SIGNATURE_OVERDUE",
  "COMPLETE_LISTING_INFORMATION",
  "REQUEST_SELLER_AML_VERIFICATION",
  "REQUEST_BUYER_AML_VERIFICATION",
  "REVIEW_AML_EXCEPTION",
  "LINK_ACCEPTED_OFFER_TO_TRANSACTION",
  "RESOLVE_DUPLICATE_ACCEPTED_OFFERS",
  "RECONCILE_OFFER_TRANSACTION_MISMATCH",
  "CONFIRM_LEGAL_REPRESENTATIVES",
  "SET_CONDITION_DUE_DATE",
  "FOLLOW_UP_CONDITION_DUE",
  "RESOLVE_OVERDUE_CONDITION",
  "RESOLVE_FINANCE_CONDITION",
  "RECORD_SETTLEMENT_DATE",
  "REVIEW_BLOCKING_CONDITION_BEFORE_SETTLEMENT",
  "COMPLETE_OVERDUE_SETTLEMENT_TASK",
  "FOLLOW_UP_OVERDUE_SETTLEMENT",
  "RESOLVE_CLOSURE_BLOCKER",
  "REVIEW_FORCED_CLOSURE",
  "REVIEW_FAILED_WORKFLOW",
  "REVIEW_STALLED_WORKFLOW",
  "REVIEW_APPROVAL_REQUEST",
] as const;
export type ExceptionRemediationTaskKey = (typeof EXCEPTION_REMEDIATION_TASK_KEYS)[number];

export interface CreateRemediationTaskInput {
  brokerageId: number;
  propertyId: number;
  transactionId: number | null;
  taskKey: ExceptionRemediationTaskKey;
  title: string;
  detail?: string | null;
  assignedRole: UserRole | null;
  dueAt: Date | null;
  exceptionId: string;
}

/**
 * Idempotent by construction: createAutomationTask's own (property-or-
 * transaction, taskKey) ACTIVE-row check means calling this again for the
 * same exception/taskKey either no-ops (UNCHANGED) or supersedes-and-
 * recreates on a material change — it can never create a second concurrent
 * ACTIVE task for the same exception (Build Instructions §13: "be
 * idempotent"). The new/updated task id is linked back onto the exception
 * either way, but only once — attachRelatedTask appends, so a caller that
 * only wants a fresh link on a genuinely new task should check the outcome
 * before calling it a second time in the same evaluation pass.
 */
export async function createRemediationTask(input: CreateRemediationTaskInput): Promise<{ taskId: string; outcome: string }> {
  const result = await createAutomationTask({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId ?? undefined,
    taskKey: input.taskKey as unknown as Parameters<typeof createAutomationTask>[0]["taskKey"],
    kind: "TASK",
    title: input.title,
    detail: input.detail ?? null,
    assignedRole: input.assignedRole,
    dueAt: input.dueAt,
    originatingField: `risk_exception:${input.exceptionId}`,
  });

  if (result.outcome === "CREATED" || result.outcome === "SUPERSEDED_AND_RECREATED") {
    await attachRelatedTask(input.exceptionId, result.task.id);
  }

  return { taskId: result.task.id, outcome: result.outcome };
}
