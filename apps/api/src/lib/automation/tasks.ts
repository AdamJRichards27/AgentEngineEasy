// Agent Engine 2.0 — Workflow Automation Engine (Stage 2: Controlled
// Production Workflows).
//
// Domain service layer over automation_tasks — backs the CREATE_INTERNAL_TASK,
// CREATE_REMINDER, and ASSIGN_TASK_OWNER registered actions
// (apps/api/src/lib/ai/actions/registry.ts). Ordinary, non-AI-specific
// functions, mirroring propertyNotes.ts's tenant-check-then-mutate pattern —
// the registry's execute() functions call these directly, and a future
// manual "create task" UI feature would call exactly the same functions.
//
// Idempotency / supersede model (Build Instructions §4 "idempotent", §6
// "avoid duplicate reminders", "retain evidence of superseded dates/tasks
// rather than silently overwriting history"): createAutomationTask reads the
// current ACTIVE row (if any) for the same (transaction-or-property, taskKey)
// scope before writing.
//   - identical title/detail/dueAt as what's already ACTIVE -> no-op, return
//     the existing row (outcome "UNCHANGED"). This is what makes duplicate
//     event delivery / a repeated action-execution attempt safe even though
//     the engine's own event_processing_receipts + automation_executions
//     unique index already prevent it from being *attempted* twice in the
//     normal flow — this is defense in depth, the same layered-idempotency
//     convention engine.ts documents for automation_actions.
//   - a materially different dueAt/title/detail (e.g. a settlement
//     reschedule) -> the existing ACTIVE row is SUPERSEDED (never deleted or
//     overwritten in place) and a fresh ACTIVE row is inserted, linked back
//     via supersededByTaskId (outcome "SUPERSEDED_AND_RECREATED").
// This is a deliberate read-then-write business-rule check, not a DB unique
// constraint — the same convention every other domain service in this
// codebase already uses for business-rule idempotency (acceptOffer's
// sibling-offer auto-decline, scheduleSettlement's reschedule handling);
// see automation.ts's own column comment on why this table has plain
// indexes rather than a unique constraint here.
//
// #122 (Run Transaction Vertical Slice) adds completeAutomationTask at the
// bottom of this file — agent-facing task completion, closing the gap
// where automationTasks/automationAttentionItems had zero non-admin surface.

import { and, eq, isNull } from "drizzle-orm";
import { db, auditLogs, automationTasks, properties, transactions, users, type AutomationTask, type UserRole } from "@aee/db";
import { currentCorrelationId, logger, publishDomainEvent } from "@aee/events";
import { logAudit } from "../audit.js";
import {
  AUTOMATION_TASK_CLOSURE_POLICY,
  COMMISSION_CHECKLIST_TASK_KEY,
  NEVER_AUTO_COMPLETE_TASK_KEYS,
  RUN_CLOSURE_AUTO_COMPLETE_ACTOR_EMAIL,
  isAutomationTaskKey,
} from "./closurePolicy.js";
import { parseManualCommissionEvidence, reconcileManualCommissionEvidence } from "./manualCommissionEvidence.js";
import type { AutomationTaskKey, AutomationTaskKind } from "./types.js";

export interface CreateAutomationTaskInput {
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  taskKey: AutomationTaskKey;
  kind: AutomationTaskKind;
  title: string;
  detail?: string | null;
  assignedRole?: UserRole | null;
  dueAt?: Date | null;
  originatingEventId?: string | null;
  originatingExecutionId?: string | null;
  originatingField?: string | null;
}

export type CreateAutomationTaskOutcome = "CREATED" | "UNCHANGED" | "SUPERSEDED_AND_RECREATED";

export interface CreateAutomationTaskResult {
  task: AutomationTask;
  outcome: CreateAutomationTaskOutcome;
  supersededTaskId?: string;
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

async function findActiveTask(
  propertyId: number,
  transactionId: number | null,
  taskKey: string,
): Promise<AutomationTask | undefined> {
  const [row] = transactionId
    ? await db
        .select()
        .from(automationTasks)
        .where(
          and(
            eq(automationTasks.transactionId, transactionId),
            eq(automationTasks.taskKey, taskKey),
            eq(automationTasks.status, "ACTIVE"),
          ),
        )
    : await db
        .select()
        .from(automationTasks)
        .where(
          and(
            eq(automationTasks.propertyId, propertyId),
            eq(automationTasks.taskKey, taskKey),
            isNull(automationTasks.transactionId),
            eq(automationTasks.status, "ACTIVE"),
          ),
        );
  return row;
}

export async function createAutomationTask(input: CreateAutomationTaskInput): Promise<CreateAutomationTaskResult> {
  const [property] = await db.select().from(properties).where(eq(properties.id, input.propertyId));
  if (!property || property.brokerageId !== input.brokerageId) {
    throw new Error("Property not found in this brokerage.");
  }
  if (input.transactionId) {
    const [transaction] = await db.select().from(transactions).where(eq(transactions.id, input.transactionId));
    if (!transaction || transaction.propertyId !== input.propertyId) {
      throw new Error("Transaction not found for this property.");
    }
  }

  const dueAt = input.dueAt ?? null;
  const detail = input.detail ?? null;
  const assignedRole = input.assignedRole ?? null;

  const existingActive = await findActiveTask(input.propertyId, input.transactionId ?? null, input.taskKey);

  if (existingActive) {
    const unchanged =
      existingActive.title === input.title &&
      existingActive.detail === detail &&
      sameInstant(existingActive.dueAt, dueAt);
    if (unchanged) {
      return { task: existingActive, outcome: "UNCHANGED" };
    }

    const [recreated] = await db
      .insert(automationTasks)
      .values({
        brokerageId: input.brokerageId,
        propertyId: input.propertyId,
        transactionId: input.transactionId ?? null,
        taskKey: input.taskKey,
        kind: input.kind,
        title: input.title,
        detail,
        assignedRole,
        dueAt,
        status: "ACTIVE",
        originatingEventId: input.originatingEventId ?? null,
        originatingExecutionId: input.originatingExecutionId ?? null,
        originatingField: input.originatingField ?? null,
      })
      .returning();

    await db
      .update(automationTasks)
      .set({ status: "SUPERSEDED", supersededByTaskId: recreated.id, updatedAt: new Date() })
      .where(eq(automationTasks.id, existingActive.id));

    await logAudit({
      brokerageId: input.brokerageId,
      action: input.kind === "REMINDER" ? "automation_reminder_superseded" : "automation_task_superseded",
      recordType: "automation_task",
      recordId: recreated.id,
      propertyId: input.propertyId,
      previousValue: existingActive.dueAt ? existingActive.dueAt.toISOString() : existingActive.title,
      updatedValue: dueAt ? dueAt.toISOString() : input.title,
    });

    return { task: recreated, outcome: "SUPERSEDED_AND_RECREATED", supersededTaskId: existingActive.id };
  }

  const [created] = await db
    .insert(automationTasks)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId ?? null,
      taskKey: input.taskKey,
      kind: input.kind,
      title: input.title,
      detail,
      assignedRole,
      dueAt,
      status: "ACTIVE",
      originatingEventId: input.originatingEventId ?? null,
      originatingExecutionId: input.originatingExecutionId ?? null,
      originatingField: input.originatingField ?? null,
    })
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    action: input.kind === "REMINDER" ? "automation_reminder_created" : "automation_task_created",
    recordType: "automation_task",
    recordId: created.id,
    propertyId: input.propertyId,
    updatedValue: input.title,
  });

  return { task: created, outcome: "CREATED" };
}

export type AssignAutomationTaskDenialReason = "NOT_FOUND";

export interface AssignAutomationTaskOwnerInput {
  brokerageId: number;
  propertyId: number;
  taskKey: AutomationTaskKey;
  assignedRole: UserRole;
}

export type AssignAutomationTaskOwnerResult =
  | { ok: true; task: AutomationTask }
  | { ok: false; reason: AssignAutomationTaskDenialReason };

/**
 * Re-assigns the current ACTIVE automation task for a property (matched by
 * taskKey) to a different authorised internal role. Deliberately looked up
 * by (propertyId, taskKey) rather than a specific task id: the automation
 * engine's action-params templating (resolveActionParams, ./templating.ts)
 * can only substitute values already present on the triggering event's
 * facts — it has no mechanism to reference the id of a row a *different*
 * action in the same rule version just created — so this action is
 * designed to be usable directly from a rule template (propertyId comes
 * from $event.propertyId, taskKey/assignedRole are static rule
 * configuration) rather than requiring a same-execution action-chaining
 * capability this engine does not have.
 */
export async function assignAutomationTaskToRole(input: AssignAutomationTaskOwnerInput): Promise<AssignAutomationTaskOwnerResult> {
  const existing = await findActiveTask(input.propertyId, null, input.taskKey);
  // Also check transaction-scoped tasks for this property if no
  // property-scoped one exists — a task created against a transaction is
  // still "the task for this property" from an assignment standpoint.
  const candidate =
    existing ??
    (
      await db
        .select()
        .from(automationTasks)
        .where(
          and(
            eq(automationTasks.propertyId, input.propertyId),
            eq(automationTasks.taskKey, input.taskKey),
            eq(automationTasks.status, "ACTIVE"),
          ),
        )
    )[0];

  if (!candidate || candidate.brokerageId !== input.brokerageId) {
    return { ok: false, reason: "NOT_FOUND" };
  }

  const [updated] = await db
    .update(automationTasks)
    .set({ assignedRole: input.assignedRole, updatedAt: new Date() })
    .where(eq(automationTasks.id, candidate.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    action: "automation_task_reassigned",
    recordType: "automation_task",
    recordId: updated.id,
    propertyId: input.propertyId,
    updatedValue: input.assignedRole,
  });

  return { ok: true, task: updated };
}

export type CompleteAutomationTaskDenialReason =
  | "NOT_FOUND"
  | "ALREADY_TERMINAL"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_INVALID"
  | "EVIDENCE_DOES_NOT_RECONCILE"
  | "ROLE_NOT_PERMITTED"
  | "NOT_AUTO_COMPLETABLE";

export interface CompleteAutomationTaskResult {
  ok: boolean;
  task?: AutomationTask;
  reason?: CompleteAutomationTaskDenialReason;
  message?: string;
  completedNow?: boolean;
}

export interface SystemCompletionMilestone {
  eventType: string;
  eventId: string;
  evidence: Record<string, unknown>;
  correlationId?: string | null;
}

type CompleteAutomationTaskInput =
  | { brokerageId: number; taskId: string; userId: number; manualEvidence?: unknown }
  | { brokerageId: number; taskId: string; userId: null; mode: "system"; milestone: SystemCompletionMilestone };

const MILESTONE_EVENT_ID_IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Agent-facing task completion (#122), plus R-F42 system auto-completion.
 * Idempotent: completing an already-COMPLETED task is a no-op that returns
 * the same row; a SUPERSEDED or CANCELLED task cannot be completed.
 *
 * Manual completion of the commission checklist (S2) requires a Brokerage
 * Administrator and reconciling evidence. That evidence is written on the
 * completion audit row in the same transaction as the status change.
 * System completion records userId null and publishes TASK_COMPLETED.
 */
export async function completeAutomationTask(input: CompleteAutomationTaskInput): Promise<CompleteAutomationTaskResult> {
  const [task] = await db.select().from(automationTasks).where(eq(automationTasks.id, input.taskId));
  if (!task || task.brokerageId !== input.brokerageId) {
    return { ok: false, reason: "NOT_FOUND" };
  }
  if (task.status === "COMPLETED") {
    return { ok: true, task, completedNow: false };
  }
  if (task.status === "SUPERSEDED" || task.status === "CANCELLED") {
    return { ok: false, reason: "ALREADY_TERMINAL" };
  }

  if (input.userId === null) {
    return completeAsSystem(task, input.milestone);
  }
  return completeAsUser(task, input);
}

async function completeAsUser(
  task: AutomationTask,
  input: { brokerageId: number; userId: number; manualEvidence?: unknown },
): Promise<CompleteAutomationTaskResult> {
  if (task.taskKey === COMMISSION_CHECKLIST_TASK_KEY) {
    const [actor] = await db
      .select({ role: users.role, email: users.email })
      .from(users)
      .where(and(eq(users.id, input.userId), eq(users.brokerageId, input.brokerageId)));
    if (!actor || actor.role !== "Brokerage Administrator") {
      return {
        ok: false,
        reason: "ROLE_NOT_PERMITTED",
        message: "Only a Brokerage Administrator can record a manual commission sign-off.",
      };
    }
    const parsed = parseManualCommissionEvidence(input.manualEvidence);
    if (!parsed.ok) return parsed;
    const reconciled = await reconcileManualCommissionEvidence(task.transactionId, parsed.evidence);
    if (!reconciled.ok) return reconciled;

    const updatedValue = JSON.stringify(reconciled.stored);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(automationTasks)
        .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(automationTasks.id, task.id), eq(automationTasks.status, "ACTIVE")))
        .returning();
      if (!row) return null;
      await tx.insert(auditLogs).values({
        brokerageId: input.brokerageId,
        userId: input.userId,
        userEmail: actor.email,
        action: "automation_task_completed",
        recordType: "automation_task",
        recordId: row.id,
        propertyId: row.propertyId,
        updatedValue,
      });
      return row;
    });
    if (!updated) {
      const [current] = await db.select().from(automationTasks).where(eq(automationTasks.id, task.id));
      if (current?.status === "COMPLETED") return { ok: true, task: current, completedNow: false };
      return { ok: false, reason: "ALREADY_TERMINAL" };
    }
    return { ok: true, task: updated, completedNow: true };
  }

  const [updated] = await db
    .update(automationTasks)
    .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(automationTasks.id, task.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "automation_task_completed",
    recordType: "automation_task",
    recordId: updated.id,
    propertyId: updated.propertyId,
    updatedValue: updated.title,
  });

  return { ok: true, task: updated, completedNow: true };
}

async function completeAsSystem(task: AutomationTask, milestone: SystemCompletionMilestone): Promise<CompleteAutomationTaskResult> {
  if (!isAutomationTaskKey(task.taskKey)) {
    return { ok: false, reason: "NOT_AUTO_COMPLETABLE" };
  }
  if ((NEVER_AUTO_COMPLETE_TASK_KEYS as readonly string[]).includes(task.taskKey)) {
    return { ok: false, reason: "NOT_AUTO_COMPLETABLE" };
  }
  const allowed = AUTOMATION_TASK_CLOSURE_POLICY[task.taskKey].autoCompleteOn;
  if (!allowed?.includes(milestone.eventType)) {
    return { ok: false, reason: "NOT_AUTO_COMPLETABLE" };
  }

  const updatedValue = JSON.stringify({
    milestoneEventType: milestone.eventType,
    milestoneEventId: milestone.eventId,
    evidence: milestone.evidence,
  });

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(automationTasks)
      .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(automationTasks.id, task.id), eq(automationTasks.status, "ACTIVE")))
      .returning();
    if (!row) return null;
    await tx.insert(auditLogs).values({
      brokerageId: task.brokerageId,
      userId: null,
      userEmail: RUN_CLOSURE_AUTO_COMPLETE_ACTOR_EMAIL,
      action: "automation_task_auto_completed",
      recordType: "automation_task",
      recordId: row.id,
      propertyId: row.propertyId,
      updatedValue,
    });
    return row;
  });

  if (!updated) {
    const [current] = await db.select().from(automationTasks).where(eq(automationTasks.id, task.id));
    if (current?.status === "COMPLETED") return { ok: true, task: current, completedNow: false };
    return { ok: false, reason: "ALREADY_TERMINAL" };
  }

  try {
    await publishDomainEvent({
      eventType: "TASK_COMPLETED",
      occurredAt: new Date(),
      propertyId: updated.propertyId,
      transactionId: updated.transactionId,
      partyId: null,
      brokerageId: updated.brokerageId,
      agentId: null,
      actorType: "SYSTEM",
      actorId: null,
      source: "automation:closure-auto-complete",
      correlationId: milestone.correlationId || currentCorrelationId(),
      causationId: MILESTONE_EVENT_ID_IS_UUID.test(milestone.eventId) ? milestone.eventId : null,
      idempotencyKey: `automation-task-auto-completed:${updated.id}:${milestone.eventId}`,
      payload: {
        taskId: updated.id,
        taskKey: updated.taskKey,
        brokerageId: updated.brokerageId,
        milestoneEventType: milestone.eventType,
        milestoneEventId: milestone.eventId,
        evidence: milestone.evidence,
      },
      metadata: {
        brokerageId: updated.brokerageId,
        milestoneEventType: milestone.eventType,
        milestoneEventId: milestone.eventId,
        evidence: milestone.evidence,
      },
    });
  } catch (err) {
    logger.error("closure_auto_complete_event_failed", {
      taskId: updated.id,
      brokerageId: updated.brokerageId,
      milestoneEventType: milestone.eventType,
      milestoneEventId: milestone.eventId,
      error: err,
    });
  }

  return { ok: true, task: updated, completedNow: true };
}
