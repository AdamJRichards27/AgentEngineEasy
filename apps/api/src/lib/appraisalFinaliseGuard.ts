/**
 * E-5 Option B — the one appraisal finalise rule for Grow and Run.
 *
 * Finalising freezes pricing. It does not close the opportunity.
 * WON, LOST, DEFERRED and ARCHIVED close the lifecycle. Both write
 * paths call enforceAppraisalPricingRule, so neither can invent a
 * second meaning for isFinalised.
 */

export const APPRAISAL_PRICING_LOCKED_CODE = "APPRAISAL_PRICING_LOCKED";
export const APPRAISAL_LIFECYCLE_CLOSED_CODE = "APPRAISAL_LIFECYCLE_CLOSED";

/** Terminal business outcomes. Finalisation is not one of them. */
export const APPRAISAL_LIFECYCLE_CLOSED_STATUSES = ["WON", "LOST", "DEFERRED", "ARCHIVED"] as const;

export class AppraisalPricingLockedError extends Error {
  readonly code = APPRAISAL_PRICING_LOCKED_CODE;
  constructor(propertyId: number) {
    super(`Appraisal for property ${propertyId} is already finalised and cannot be edited.`);
    this.name = "AppraisalPricingLockedError";
  }
}

export class AppraisalLifecycleClosedError extends Error {
  readonly code = APPRAISAL_LIFECYCLE_CLOSED_CODE;
  constructor(status: string, message?: string) {
    super(message ?? `Appraisal is ${status} and is no longer editable`);
    this.name = "AppraisalLifecycleClosedError";
  }
}

export function appraisalLifecycleClosed(status: string): boolean {
  return (APPRAISAL_LIFECYCLE_CLOSED_STATUSES as readonly string[]).includes(status);
}

export interface AppraisalPricingSnapshot {
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  priceRangeCurrency: string | null;
  pricingCommentary: string | null;
  commissionRatePercent: string | null;
  commissionProposal: string | null;
  comparableSales?: unknown;
}

/** Fields a caller may send. Omitted keys are not a change. */
export interface AppraisalPricingPatch {
  priceRangeLow?: string | null;
  priceRangeHigh?: string | null;
  priceRangeCurrency?: string | null;
  pricingCommentary?: string | null;
  commissionRatePercent?: string | null;
  commissionProposal?: string | null;
  comparableSales?: unknown;
}

function sameText(stored: string | null | undefined, next: string | null | undefined): boolean {
  return (stored ?? null) === (next ?? null);
}

function sameDecimal(stored: string | null | undefined, next: string | null | undefined): boolean {
  if (stored == null && next == null) return true;
  if (stored == null || next == null) return false;
  const left = Number(stored);
  const right = Number(next);
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right;
  return stored === next;
}

export function pricingPatchChanges(current: AppraisalPricingSnapshot, patch: AppraisalPricingPatch): boolean {
  if (patch.priceRangeLow !== undefined && !sameDecimal(current.priceRangeLow, patch.priceRangeLow)) return true;
  if (patch.priceRangeHigh !== undefined && !sameDecimal(current.priceRangeHigh, patch.priceRangeHigh)) return true;
  if (patch.priceRangeCurrency !== undefined && !sameText(current.priceRangeCurrency, patch.priceRangeCurrency)) return true;
  if (patch.pricingCommentary !== undefined && !sameText(current.pricingCommentary, patch.pricingCommentary)) return true;
  if (patch.commissionRatePercent !== undefined && !sameDecimal(current.commissionRatePercent, patch.commissionRatePercent)) return true;
  if (patch.commissionProposal !== undefined && !sameText(current.commissionProposal, patch.commissionProposal)) return true;
  if (
    patch.comparableSales !== undefined &&
    JSON.stringify(current.comparableSales ?? null) !== JSON.stringify(patch.comparableSales ?? null)
  ) {
    return true;
  }
  return false;
}

export interface AppraisalPricingSubject extends AppraisalPricingSnapshot {
  isFinalised: boolean;
  status: string;
  propertyId: number;
}

/**
 * Refuse a pricing write.
 *
 * Pass a patch for a mixed workspace update: an unchanged price is not a
 * write, so follow-up fields in the same request can still be saved.
 * Omit the patch when the whole call is a pricing mutation (Run's update,
 * comparable sales, market competition). A finalised row then always refuses.
 * A closed lifecycle refuses even when the row was never finalised.
 */
export function enforceAppraisalPricingRule(appraisal: AppraisalPricingSubject, patch?: AppraisalPricingPatch): void {
  const pricingWrite = patch === undefined || pricingPatchChanges(appraisal, patch);
  if (appraisal.isFinalised && pricingWrite) {
    throw new AppraisalPricingLockedError(appraisal.propertyId);
  }
  if (appraisalLifecycleClosed(appraisal.status)) {
    throw new AppraisalLifecycleClosedError(appraisal.status);
  }
}
