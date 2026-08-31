// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category G — Workflow & Operational (Build Instructions §10.G, rules
// 36-40). #40 is deferred: it reads as an aggregate/cross-property
// operational-health rule (e.g. a statistical threshold breach), which
// would require metrics infrastructure this build does not have and risks
// overlapping the explicitly out-of-scope Command Centre/BI work (Build
// Instructions §29's out-of-scope list). Left for that future build rather
// than approximated here with an invented per-record proxy.
//
// G36 below also absorbs automation_attention_items as an additional input
// signal, per that table's own doc comment (packages/db/src/schema/
// automation.ts) naming this exact module as its intended consumer — see
// G36's own comment for which reason codes are in scope and why the rest
// are deliberately left to more specific rules elsewhere in this catalogue.

import { and, eq, inArray, lt } from "drizzle-orm";
import {
  db,
  properties,
  transactions,
  automationExecutions,
  automationActions,
  automationAttentionItems,
  automationTasks,
  domainEvents,
  aiActionRequests,
  type Property,
} from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

// Every G-rule below needs the property behind an automationExecutions/
// automationActions row, and neither table carries propertyId directly
// (automationExecutions.brokerageId is enough for tenant scoping, but
// riskExceptions.propertyId is NOT NULL — see exceptions.ts — so a property
// must be resolved before a finding can be built). The only path to it is
// the triggering domain event. A row whose triggering event has no
// propertyId (e.g. a subscription/entitlement-triggered execution) is
// skipped rather than guessed at — this is the per-record instance of
// Build Instructions §10's "record exact missing dependency" for an
// otherwise-implementable rule.
async function propertyMapFor(propertyIds: number[]): Promise<Map<number, Property>> {
  if (propertyIds.length === 0) return new Map();
  const rows = await db.select().from(properties).where(inArray(properties.id, propertyIds));
  return new Map(rows.map((p) => [p.id, p]));
}

const G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED: RiskRule = {
  ruleId: "G36_WAE_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED",
  version: 1,
  category: "WORKFLOW_OPERATIONAL",
  name: "Automated workflow execution failed, blocked, or flagged for attention",
  description:
    "Catalogue #36 (a WAE execution reached a terminal FAILED/BLOCKED state) combined with automation_attention_items as an additional input signal. Only attention items whose reasonCode is INCOMPLETE_TRIGGERING_EVENT or OTHER are read here — MISSING_SETTLEMENT_DATE, MISSING_REGISTERED_OWNER, MISSING_LEGAL_REPRESENTATIVE, and CONDITION_WITHOUT_DUE_DATE are already covered, with full field-level evidence, by D21, A02, D15, and D16 respectively, so re-surfacing them from the coarser attention-item summary would duplicate the same fact under a second rule identity.",
  triggerEventTypes: ["AUTOMATION_ACTION_FAILED", "AUTOMATION_ACTION_BLOCKED"],
  async scanBrokerage(brokerageId, now) {
    const findings: RiskFinding[] = [];

    const executionRows = await db
      .select({ execution: automationExecutions, event: domainEvents })
      .from(automationExecutions)
      .innerJoin(domainEvents, eq(automationExecutions.triggeringEventId, domainEvents.id))
      .where(and(eq(automationExecutions.brokerageId, brokerageId), inArray(automationExecutions.status, ["FAILED", "BLOCKED"])));

    const attentionRows = await db
      .select()
      .from(automationAttentionItems)
      .where(
        and(
          eq(automationAttentionItems.brokerageId, brokerageId),
          eq(automationAttentionItems.status, "OPEN"),
          inArray(automationAttentionItems.reasonCode, ["INCOMPLETE_TRIGGERING_EVENT", "OTHER"]),
        ),
      );

    const propertyIds = [
      ...new Set([
        ...executionRows.map((r) => r.event.propertyId).filter((id): id is number => id !== null),
        ...attentionRows.map((a) => a.propertyId),
      ]),
    ];
    const propertyById = await propertyMapFor(propertyIds);

    for (const { execution, event } of executionRows) {
      if (event.propertyId === null) continue;
      const property = propertyById.get(event.propertyId);
      if (!property) continue;
      const owner = resolveDefaultOwner(property, event.transactionId !== null);
      findings.push({
        ruleId: G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.ruleId,
        ruleVersion: G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.version,
        category: "WORKFLOW_OPERATIONAL",
        severity: "CRITICAL",
        title: `Automated workflow execution ${execution.status === "FAILED" ? "failed" : "was blocked"}`,
        problemDescription: `Automation execution ${execution.id} reached ${execution.status}${execution.errorMessage ? `: ${execution.errorMessage}` : "."}`,
        businessImpact: "A failed or blocked controlled workflow means an expected automated action did not happen — downstream steps relying on it may be silently missing.",
        detectedCause: `automationExecutions.status = ${execution.status}.`,
        ...owner,
        propertyId: property.id,
        transactionId: event.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review the failed/blocked execution and either resolve the underlying cause and re-trigger it, or record why no action is needed.",
        resolutionRequirements: "A subsequent execution of the same rule for this target reaches COMPLETED, or an authorised reviewer dismisses this exception with a reason.",
        dismissible: true,
        sourceRecordType: "automation_execution",
        sourceRecordId: String(execution.id),
        dedupKey: dedupKey(G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.ruleId, brokerageId, `execution:${execution.id}`),
        recurrenceMode: "NEW_OCCURRENCE",
        requiresFinancialEntitlement: false,
        metadata: { automationExecutionId: execution.id },
      });
    }

    for (const item of attentionRows) {
      const property = propertyById.get(item.propertyId);
      if (!property) continue;
      const owner = resolveDefaultOwner(property, item.transactionId !== null);
      findings.push({
        ruleId: G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.ruleId,
        ruleVersion: G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.version,
        category: "WORKFLOW_OPERATIONAL",
        severity: "ATTENTION",
        title: "Workflow raised an unresolved attention item",
        problemDescription: `Automation raised an attention item: ${item.summary}`,
        businessImpact: "An unresolved workflow attention item means a controlled action could not proceed and needs a human decision.",
        detectedCause: `automationAttentionItems.reasonCode = ${item.reasonCode}, status = OPEN.`,
        ...owner,
        propertyId: property.id,
        transactionId: item.transactionId,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Review and resolve the attention item through the automation ops interface.",
        resolutionRequirements: "The automationAttentionItems row reaches status RESOLVED.",
        dismissible: true,
        sourceRecordType: "automation_attention_item",
        sourceRecordId: String(item.id),
        dedupKey: dedupKey(G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED.ruleId, brokerageId, `attention:${item.id}`),
        recurrenceMode: "NEW_OCCURRENCE",
        requiresFinancialEntitlement: false,
      });
    }

    return findings;
  },
};

// PENDING/EVALUATING should resolve almost immediately (they're in-process
// synchronous steps); RUNNING covers action execution, which can
// legitimately take longer (provider calls etc.), hence the wider window.
const STALE_THRESHOLDS_MS: Record<string, number> = {
  PENDING: 2 * 60 * 60 * 1000,
  EVALUATING: 2 * 60 * 60 * 1000,
  RUNNING: 6 * 60 * 60 * 1000,
};

const G37_EXECUTION_STALE: RiskRule = {
  ruleId: "G37_WAE_EXECUTION_STALE_IN_ACTIVE_STATE",
  version: 1,
  category: "WORKFLOW_OPERATIONAL",
  name: "Automated workflow execution stale in an active state",
  description:
    "An execution has sat in PENDING/EVALUATING/RUNNING well beyond how long that state should ever take — a likely stuck worker, not a normal in-flight run. Deliberately excludes AWAITING_APPROVAL: that state is tracked with more specific evidence (aiActionRequests.expiresAt where available) by G38 below, so the same stalled action is never described by two rules at once.",
  triggerEventTypes: [],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ execution: automationExecutions, event: domainEvents })
      .from(automationExecutions)
      .innerJoin(domainEvents, eq(automationExecutions.triggeringEventId, domainEvents.id))
      .where(and(eq(automationExecutions.brokerageId, brokerageId), inArray(automationExecutions.status, ["PENDING", "EVALUATING", "RUNNING"])));

    const propertyIds = [...new Set(rows.map((r) => r.event.propertyId).filter((id): id is number => id !== null))];
    const propertyById = await propertyMapFor(propertyIds);

    const findings: RiskFinding[] = [];
    for (const { execution, event } of rows) {
      if (event.propertyId === null) continue;
      const property = propertyById.get(event.propertyId);
      if (!property) continue;
      const referenceTime = execution.startedAt ?? execution.createdAt;
      const thresholdMs = STALE_THRESHOLDS_MS[execution.status] ?? STALE_THRESHOLDS_MS.RUNNING;
      const dueDate = new Date(referenceTime.getTime() + thresholdMs);
      const severity = severityForDeadline(now, dueDate, 0, 1);
      if (severity === "INFORMATION") continue; // still within the normal processing window — not yet a real signal
      const owner = resolveDefaultOwner(property, event.transactionId !== null);
      findings.push({
        ruleId: G37_EXECUTION_STALE.ruleId,
        ruleVersion: G37_EXECUTION_STALE.version,
        category: "WORKFLOW_OPERATIONAL",
        severity,
        title: "Workflow execution appears stuck",
        problemDescription: `Automation execution ${execution.id} has been ${execution.status} since ${referenceTime.toDateString()} — longer than that state should normally take.`,
        businessImpact: "A stuck execution means its actions never ran and never will unless the run is diagnosed and recovered.",
        detectedCause: `automationExecutions.status = ${execution.status} beyond its expected processing window.`,
        ...owner,
        propertyId: property.id,
        transactionId: event.transactionId,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 1),
        recommendedAction: "Diagnose the stuck execution (worker health, event_processing_receipts) and recover or fail it explicitly.",
        resolutionRequirements: "The execution reaches a terminal status (COMPLETED, SKIPPED, FAILED, BLOCKED, or CANCELLED).",
        dismissible: false,
        sourceRecordType: "automation_execution",
        sourceRecordId: String(execution.id),
        dedupKey: dedupKey(G37_EXECUTION_STALE.ruleId, brokerageId, execution.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { automationExecutionId: execution.id },
      });
    }
    return findings;
  },
};

const G38_APPROVAL_UNRESOLVED: RiskRule = {
  ruleId: "G38_APPROVAL_REQUIRED_ACTION_UNRESOLVED",
  version: 1,
  category: "WORKFLOW_OPERATIONAL",
  name: "Approval-required action unresolved beyond the allowed period",
  description:
    "An automation action is AWAITING_APPROVAL past its linked aiActionRequests.expiresAt, or — when no linked request exists yet — a default 7-day review window from when the action entered that state.",
  triggerEventTypes: ["AI_ACTION_APPROVAL_REQUIRED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ action: automationActions, event: domainEvents })
      .from(automationActions)
      .innerJoin(automationExecutions, eq(automationActions.executionId, automationExecutions.id))
      .innerJoin(domainEvents, eq(automationExecutions.triggeringEventId, domainEvents.id))
      .where(and(eq(automationExecutions.brokerageId, brokerageId), eq(automationActions.status, "AWAITING_APPROVAL")));

    const propertyIds = [...new Set(rows.map((r) => r.event.propertyId).filter((id): id is number => id !== null))];
    const propertyById = await propertyMapFor(propertyIds);

    const requestIds = rows.map((r) => r.action.aiActionRequestId).filter((id): id is number => id !== null);
    const requestRows = requestIds.length ? await db.select().from(aiActionRequests).where(inArray(aiActionRequests.id, requestIds)) : [];
    const requestById = new Map(requestRows.map((r) => [r.id, r]));

    const findings: RiskFinding[] = [];
    for (const { action, event } of rows) {
      if (event.propertyId === null) continue;
      const property = propertyById.get(event.propertyId);
      if (!property) continue;
      const request = action.aiActionRequestId ? requestById.get(action.aiActionRequestId) : undefined;
      const dueDate = request?.expiresAt ?? new Date(action.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      const severity = severityForDeadline(now, dueDate, 2, 5);
      if (severity === "INFORMATION") continue; // still within the allowed review window
      const owner = resolveDefaultOwner(property, event.transactionId !== null);
      findings.push({
        ruleId: G38_APPROVAL_UNRESOLVED.ruleId,
        ruleVersion: G38_APPROVAL_UNRESOLVED.version,
        category: "WORKFLOW_OPERATIONAL",
        severity,
        title: "Approval-required action awaiting a decision",
        problemDescription: `Action ${action.actionKey} (automation action ${action.id}) has been awaiting approval since ${action.createdAt.toDateString()}.`,
        businessImpact: "An unresolved approval request means a workflow-proposed action is stalled and cannot execute until an authorised human decides.",
        detectedCause: "automationActions.status = AWAITING_APPROVAL beyond the allowed review period.",
        ...owner,
        propertyId: property.id,
        transactionId: event.transactionId,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 5),
        recommendedAction: "Review and approve or reject the pending action.",
        resolutionRequirements: "The automationActions row (via its linked aiActionRequests row, where present) reaches APPROVED, REJECTED, or another terminal status.",
        dismissible: false,
        sourceRecordType: "automation_action",
        sourceRecordId: String(action.id),
        dedupKey: dedupKey(G38_APPROVAL_UNRESOLVED.ruleId, brokerageId, action.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { automationActionId: action.id },
      });
    }
    return findings;
  },
};

const G39_MANDATORY_TASK_OVERDUE: RiskRule = {
  ruleId: "G39_WORKFLOW_TASK_OVERDUE",
  version: 1,
  category: "WORKFLOW_OPERATIONAL",
  name: "Workflow-generated mandatory task overdue",
  description:
    "An ACTIVE automation task's due date has passed. Excludes any task already tracked by settlementClosure.ts's F30 — a task due on or before an approaching/overdue settlement is that rule's more specific territory (it evaluates the whole settlement, not one task) — so the same fact is never described by two rules at once.",
  triggerEventTypes: ["TASK_OVERDUE"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ task: automationTasks, property: properties })
      .from(automationTasks)
      .innerJoin(properties, eq(automationTasks.propertyId, properties.id))
      .where(and(eq(automationTasks.brokerageId, brokerageId), eq(automationTasks.status, "ACTIVE"), lt(automationTasks.dueAt, now)));

    const transactionIds = [...new Set(rows.map((r) => r.task.transactionId).filter((id): id is number => id !== null))];
    const transactionRows = transactionIds.length ? await db.select().from(transactions).where(inArray(transactions.id, transactionIds)) : [];
    const transactionById = new Map(transactionRows.map((t) => [t.id, t]));

    const findings: RiskFinding[] = [];
    for (const { task, property } of rows) {
      if (!task.dueAt) continue;
      const transaction = task.transactionId ? transactionById.get(task.transactionId) : undefined;
      if (transaction?.settlementDate && !transaction.settlementCompletedAt && task.dueAt.getTime() <= transaction.settlementDate.getTime()) {
        continue; // F30's territory
      }
      const severity = severityForDeadline(now, task.dueAt, 0, 7);
      const owner = resolveDefaultOwner(property, task.transactionId !== null);
      findings.push({
        ruleId: G39_MANDATORY_TASK_OVERDUE.ruleId,
        ruleVersion: G39_MANDATORY_TASK_OVERDUE.version,
        category: "WORKFLOW_OPERATIONAL",
        severity,
        title: `Task "${task.title}" is overdue`,
        problemDescription: `The task "${task.title}" was due ${task.dueAt.toDateString()} and is still ACTIVE.`,
        businessImpact: "An overdue mandatory task means a required step in this property's or transaction's workflow has not been done.",
        detectedCause: "automationTasks.status = ACTIVE and dueAt is in the past.",
        ...owner,
        propertyId: property.id,
        transactionId: task.transactionId,
        dueAt: task.dueAt,
        escalatesAt: escalatesAtFor(task.dueAt, 7),
        recommendedAction: "Complete the overdue task, or reassign it if it is no longer the right owner.",
        resolutionRequirements: "The automationTasks row reaches status COMPLETED (or is superseded by a materially updated task).",
        dismissible: false,
        sourceRecordType: "automation_task",
        sourceRecordId: String(task.id),
        dedupKey: dedupKey(G39_MANDATORY_TASK_OVERDUE.ruleId, brokerageId, task.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { automationTaskId: task.id, dueDate: task.dueAt.toISOString() },
      });
    }
    return findings;
  },
};

export const WORKFLOW_OPERATIONAL_RULES: RiskRule[] = [
  G36_EXECUTION_FAILED_OR_ATTENTION_UNRESOLVED,
  G37_EXECUTION_STALE,
  G38_APPROVAL_UNRESOLVED,
  G39_MANDATORY_TASK_OVERDUE,
];
