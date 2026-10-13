// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// Small helpers shared across every rule module — deliberately NOT a
// generic rule-interpreter (Build Instructions §8 forbids that); just the
// handful of calculations (dedup keys, deadline-based severity, default
// ownership) every deterministic date/status comparison in this catalogue
// needs, kept in one place so they're computed the same way everywhere.

import { WORKFLOW_STAGES, type Property } from "@aee/db";
import type { RiskExceptionOwnerType, RiskExceptionSeverity } from "../types.js";

/** Stages a live-listing rule still scans. Appraisal and Ready to List are outside this window. */
export const LISTED_ONWARD_STAGES: readonly string[] = WORKFLOW_STAGES.filter(
  (stage) => stage !== "Appraisal" && stage !== "Ready to List",
);

/** Stages seller AML still scans. Appraisal is outside this window. */
export const AFTER_APPRAISAL_STAGES: readonly string[] = WORKFLOW_STAGES.filter((stage) => stage !== "Appraisal");

export function dedupKey(ruleId: string, brokerageId: number, scope: string | number): string {
  return `${ruleId}:${brokerageId}:${scope}`;
}

/**
 * The only owner this app's merged baseline can safely resolve without
 * guessing (Build Instructions §12: "never assign solely because a user
 * initiated the triggering API request"; "unassigned operational queue
 * where no safe owner determinable") — properties.agentId is NOT NULL, so
 * this only falls through to UNASSIGNED_QUEUE if the property row itself
 * couldn't be loaded, which callers should treat as a bug, not a normal
 * path. hasTransaction just changes the label (LISTING_AGENT vs
 * TRANSACTION_OWNER) — see the module comment on why they resolve to the
 * same underlying user in this schema.
 */
export function resolveDefaultOwner(property: Pick<Property, "agentId"> | undefined, hasTransaction: boolean): { ownerType: RiskExceptionOwnerType; ownerUserId: number | null } {
  if (!property?.agentId) return { ownerType: "UNASSIGNED_QUEUE", ownerUserId: null };
  return { ownerType: hasTransaction ? "TRANSACTION_OWNER" : "LISTING_AGENT", ownerUserId: property.agentId };
}

export function daysBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * The deadline-proximity ladder used by every "approaching / overdue"
 * rule in this catalogue (conditions, settlement, AML, signature). Below
 * `approachingDays` from the deadline is ATTENTION; past the deadline is
 * AT_RISK; past `criticalAfterDays` beyond the deadline (or immediately,
 * when criticalAfterDays is 0) is CRITICAL. Kept as one function so every
 * rule's escalation timing is reviewable in one place rather than
 * hand-rolled per rule (Build Instructions §6: "Severity must be assigned
 * through explicit rules").
 */
export function severityForDeadline(now: Date, dueDate: Date, approachingDays: number, criticalAfterDays: number | null): RiskExceptionSeverity {
  // AE Step 5 remediation — Proof D surfaced this: daysBetween(dueDate, now)
  // is already "days until due, positive = still time left" on its own
  // (dueDate later than now => positive) — the extra `* -1` that used to be
  // here inverted that, so every deadline-based rule in this catalogue
  // (offers/listing/contractConditions/amlCtf/appraisalAgreement/
  // launchCampaign/workflowOperational/financial FIN03-FIN04, and this
  // build's new integrationOperational H01) was assigning severity on the
  // WRONG side of "approaching" and "overdue": a brand-new deadline days in
  // the future could read as AT_RISK, and a genuinely overdue one could
  // read as ATTENTION or even INFORMATION. Verified against every existing
  // caller's own inline comments/tests (e.g. offers.ts's C12 "still within
  // the normal handoff window" skip, which the inverted sign silently
  // defeated) before removing the negation — no caller's own dueDate
  // convention needed to change, this was purely the shared helper's own
  // sign bug.
  const daysUntilDue = daysBetween(dueDate, now);
  if (daysUntilDue > approachingDays) return "INFORMATION";
  if (daysUntilDue > 0) return "ATTENTION";
  const daysOverdue = -daysUntilDue;
  if (criticalAfterDays !== null && daysOverdue >= criticalAfterDays) return "CRITICAL";
  return "AT_RISK";
}

export function escalatesAtFor(dueDate: Date, criticalAfterDays: number): Date {
  return new Date(dueDate.getTime() + criticalAfterDays * 24 * 60 * 60 * 1000);
}
