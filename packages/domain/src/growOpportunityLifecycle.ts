/**
 * Manual lifecycle for a Grow opportunity.
 *
 * Stored values are the ones named on grow_opportunities in
 * packages/db/src/schema/grow.ts. This module does not add statuses or stages.
 *
 * status: Open | Converted | Lost | Closed
 * stage:  New | Contacted | Qualified | AppraisalBooked | Converted | Lost
 *
 * An agent may move stage among New, Contacted and Qualified, in either
 * direction. AppraisalBooked and Converted are set by the appraisal flow.
 * Marking lost stores status Lost, stage Lost and a reason. Closing stores
 * status Closed. There is no Closed stage. The domain has no transition
 * that reopens a Lost or Closed opportunity.
 */

export const GROW_OPPORTUNITY_STATUSES = ["Open", "Converted", "Lost", "Closed"] as const;
export type GrowOpportunityStatus = (typeof GROW_OPPORTUNITY_STATUSES)[number];

export const GROW_OPPORTUNITY_STAGES = ["New", "Contacted", "Qualified", "AppraisalBooked", "Converted", "Lost"] as const;
export type GrowOpportunityStage = (typeof GROW_OPPORTUNITY_STAGES)[number];

/** Stages an agent may set by hand. Backwards moves among these are allowed. */
export const GROW_OPPORTUNITY_MANUAL_STAGES = ["New", "Contacted", "Qualified"] as const;
export type GrowOpportunityManualStage = (typeof GROW_OPPORTUNITY_MANUAL_STAGES)[number];

export const GROW_OPPORTUNITY_LOST_REASON_MAX = 2000;

export const OPPORTUNITY_APPRAISAL_BOOKED_MANUAL =
  "AppraisalBooked is set when an appraisal is linked. It cannot be set manually.";
export const OPPORTUNITY_CONVERTED_MANUAL =
  "Converted is set when an appraisal is won. It cannot be set manually.";
export const OPPORTUNITY_REOPEN_UNSUPPORTED = "A lost or closed opportunity cannot be reopened.";
export const OPPORTUNITY_CONVERTED_LOCKED =
  "A converted opportunity follows its appraisal and cannot be changed manually.";
export const OPPORTUNITY_ACTIVE_APPRAISAL =
  "This opportunity is linked to an active appraisal. Change the appraisal instead of the opportunity.";
export const OPPORTUNITY_LOST_REASON_REQUIRED = "lostReason is required when marking an opportunity lost";

export type GrowOpportunityLifecycleCommand =
  | { kind: "stage"; stage: GrowOpportunityManualStage }
  | { kind: "lost"; lostReason: string }
  | { kind: "close" };

export type GrowOpportunityLifecycleRefusal = { ok: false; status: 400 | 409; error: string };

export function parseGrowOpportunityLifecycleRequest(
  body: unknown,
): { ok: true; command: GrowOpportunityLifecycleCommand } | GrowOpportunityLifecycleRefusal {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "stage or status is required" };
  }
  const record = body as Record<string, unknown>;
  const hasStage = Object.prototype.hasOwnProperty.call(record, "stage");
  const hasStatus = Object.prototype.hasOwnProperty.call(record, "status");
  const hasReason = Object.prototype.hasOwnProperty.call(record, "lostReason");
  if (hasStage && hasStatus) {
    return { ok: false, status: 400, error: "Send stage or status, not both" };
  }
  if (!hasStage && !hasStatus) {
    return { ok: false, status: 400, error: "stage or status is required" };
  }
  if (hasStage) {
    if (hasReason) {
      return { ok: false, status: 400, error: "lostReason is only used when marking an opportunity lost" };
    }
    if (record.stage === "AppraisalBooked") {
      return { ok: false, status: 409, error: OPPORTUNITY_APPRAISAL_BOOKED_MANUAL };
    }
    if (record.stage === "Converted") {
      return { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_MANUAL };
    }
    if (record.stage === "Lost") {
      return { ok: false, status: 400, error: "Mark an opportunity lost with status Lost and a lostReason" };
    }
    if (
      typeof record.stage === "string" &&
      (GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(record.stage)
    ) {
      return { ok: true, command: { kind: "stage", stage: record.stage as GrowOpportunityManualStage } };
    }
    return { ok: false, status: 400, error: "stage must be one of New, Contacted, Qualified" };
  }
  if (record.status === "Converted") {
    return { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_MANUAL };
  }
  if (record.status === "Open") {
    return { ok: false, status: 409, error: OPPORTUNITY_REOPEN_UNSUPPORTED };
  }
  if (record.status === "Lost") {
    if (typeof record.lostReason !== "string" || record.lostReason.trim().length === 0) {
      return { ok: false, status: 400, error: OPPORTUNITY_LOST_REASON_REQUIRED };
    }
    const lostReason = record.lostReason.trim();
    if (lostReason.length > GROW_OPPORTUNITY_LOST_REASON_MAX) {
      return {
        ok: false,
        status: 400,
        error: `lostReason must be ${GROW_OPPORTUNITY_LOST_REASON_MAX} characters or fewer`,
      };
    }
    return { ok: true, command: { kind: "lost", lostReason } };
  }
  if (record.status === "Closed") {
    if (hasReason) {
      return { ok: false, status: 400, error: "lostReason is only used when marking an opportunity lost" };
    }
    return { ok: true, command: { kind: "close" } };
  }
  return { ok: false, status: 400, error: "status must be Lost or Closed" };
}

export type GrowOpportunityLifecyclePatch = {
  status: "Open" | "Lost" | "Closed";
  stage: GrowOpportunityStage;
  lostReason?: string;
  /** True when closedAt must be set to the time of this write. */
  close: boolean;
};

/**
 * Apply a parsed command to the current row. Reopening is refused: nothing
 * in this module moves Lost, Closed or Converted back to Open.
 * `activeAppraisalLinked` is true when a non-terminal appraisal is linked.
 */
export function applyGrowOpportunityLifecycle(input: {
  command: GrowOpportunityLifecycleCommand;
  status: string;
  stage: string;
  activeAppraisalLinked: boolean;
}): { ok: true; patch: GrowOpportunityLifecyclePatch } | GrowOpportunityLifecycleRefusal {
  if (input.status === "Converted" || input.stage === "Converted") {
    return { ok: false, status: 409, error: OPPORTUNITY_CONVERTED_LOCKED };
  }
  if (input.status === "Lost" || input.status === "Closed" || input.stage === "Lost") {
    return { ok: false, status: 409, error: OPPORTUNITY_REOPEN_UNSUPPORTED };
  }
  if (input.activeAppraisalLinked) {
    return { ok: false, status: 409, error: OPPORTUNITY_ACTIVE_APPRAISAL };
  }
  if (input.status !== "Open") {
    return { ok: false, status: 409, error: "This opportunity cannot be changed manually." };
  }
  if (input.command.kind === "stage") {
    return {
      ok: true,
      patch: { status: "Open", stage: input.command.stage, close: false },
    };
  }
  if (input.command.kind === "lost") {
    return {
      ok: true,
      patch: { status: "Lost", stage: "Lost", lostReason: input.command.lostReason, close: true },
    };
  }
  // Close sets status Closed. There is no Closed stage, so the current stage stays.
  return { ok: true, patch: { status: "Closed", stage: input.stage as GrowOpportunityStage, close: true } };
}
