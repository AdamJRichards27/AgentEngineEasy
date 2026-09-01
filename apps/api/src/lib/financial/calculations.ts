// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// Deterministic commission-calculation service (Sections 10-11). Every
// calculation this module produces is a NEW, immutable
// commissionCalculations row — never an edit of a prior one (mirrors
// commissionAgreements' own Section 9 versioning rule). A correction
// always supersedes.
//
// Rounding (Section 8/10 — "deterministic rounding evidence"): every
// cents-level rounding this module performs is Math.round (round-half-up,
// JS's own convention, matching lib/transactions.ts's calculateCommission())
// and is recorded as a {step, exactCents, roundedCents, adjustmentCents}
// entry in roundingAdjustments whenever rounding actually changed the
// value, so a stored calculation is always traceable back to its
// unrounded inputs — nothing is silently rounded away.
//
// calculationRuleVersion (currently 1) identifies the exact formula
// version below. Bump it, and branch this module's logic on it, if the
// calculation rules themselves ever change — a stored calculation always
// keeps the rule version that actually produced it, so a past snapshot is
// never silently reinterpreted under new rules.

import { eq, and } from "drizzle-orm";
import { db, commissionAgreements, commissionCalculations } from "@aee/db";
import type { CommissionAgreement, InsertCommissionCalculation, CommissionCalculation } from "@aee/db";

export const CALCULATION_RULE_VERSION = 1;

export interface RoundingAdjustment {
  step: string;
  exactCents: number;
  roundedCents: number;
  adjustmentCents: number;
}

export interface CommissionCalculationResult {
  grossCommissionCents: number;
  minimumAppliedCents: number | null;
  referralFeeCents: number;
  commissionExGstCents: number;
  gstCents: number;
  gstRateBpsUsed: number;
  brokerageComponentCents: number | null;
  agentComponentCents: number | null;
  roundingAdjustments: RoundingAdjustment[];
}

function roundCents(exact: number, step: string, adjustments: RoundingAdjustment[]): number {
  const rounded = Math.round(exact);
  if (rounded !== exact) {
    adjustments.push({ step, exactCents: exact, roundedCents: rounded, adjustmentCents: rounded - exact });
  }
  return rounded;
}

/**
 * Marginal/bracket tiered commission — the standard AU real-estate
 * "tiered commission" structure (e.g. 2.75% on the first $500k, 2.20% on
 * the next $500k, 1.65% above $1M), the same shape as an income-tax
 * bracket table rather than a single flat rate chosen by which band the
 * total price falls into. tiers is evaluated in the order given; a tier
 * with upToCents: null is the final, uncapped band.
 */
function calculateTieredCommission(
  salePriceCents: number,
  tiers: Array<{ upToCents: number | null; rateBps: number }>,
  adjustments: RoundingAdjustment[],
): number {
  let total = 0;
  let lowerBound = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const upperBound = tier.upToCents ?? Infinity;
    const portionInTier = Math.max(0, Math.min(salePriceCents, upperBound) - lowerBound);
    if (portionInTier > 0) {
      const exact = (portionInTier * tier.rateBps) / 10000;
      total += roundCents(exact, `tier[${i}] ${portionInTier}c @ ${tier.rateBps}bps`, adjustments);
    }
    lowerBound = upperBound;
    if (lowerBound >= salePriceCents) break;
  }
  return total;
}

/**
 * Pure function — takes an agreement (DRAFT is fine for an ESTIMATE;
 * APPROVED is required before a caller marks a calculation FINALISED,
 * enforced by createCommissionCalculation's caller, not here) and a sale
 * price, and returns every field a commissionCalculations row needs.
 * Never touches the database.
 */
export function computeCommission(agreement: CommissionAgreement, salePriceCents: number): CommissionCalculationResult {
  if (salePriceCents < 0) throw new Error("salePriceCents cannot be negative.");
  const adjustments: RoundingAdjustment[] = [];

  let formulaResultCents: number;
  switch (agreement.method) {
    case "FIXED_AMOUNT": {
      if (agreement.fixedAmountCents == null) throw new Error("FIXED_AMOUNT agreement is missing fixedAmountCents.");
      formulaResultCents = agreement.fixedAmountCents;
      break;
    }
    case "PERCENTAGE": {
      if (agreement.rateBps == null) throw new Error("PERCENTAGE agreement is missing rateBps.");
      const exact = (salePriceCents * agreement.rateBps) / 10000;
      formulaResultCents = roundCents(exact, "percentage-of-sale-price", adjustments);
      break;
    }
    case "TIERED": {
      const tiers = (agreement.tiers ?? []) as Array<{ upToCents: number | null; rateBps: number }>;
      if (!Array.isArray(tiers) || tiers.length === 0) throw new Error("TIERED agreement is missing its tiers array.");
      formulaResultCents = calculateTieredCommission(salePriceCents, tiers, adjustments);
      break;
    }
    case "MANUAL_WITH_REASON": {
      if (agreement.fixedAmountCents == null) throw new Error("MANUAL_WITH_REASON agreement is missing fixedAmountCents.");
      if (!agreement.manualReason || agreement.manualReason.trim().length === 0) {
        throw new Error("MANUAL_WITH_REASON agreement is missing manualReason.");
      }
      formulaResultCents = agreement.fixedAmountCents;
      break;
    }
    default:
      throw new Error(`Unknown commission method: ${agreement.method}`);
  }

  // Minimum-amount override (Section 10): minimumAppliedCents stays null
  // on every calculation where the formula's own result already cleared
  // the floor — it is only ever set when the minimum actually changed
  // the outcome, so its presence alone is meaningful evidence.
  let grossCommissionCents = formulaResultCents;
  let minimumAppliedCents: number | null = null;
  if (agreement.minimumAmountCents != null && formulaResultCents < agreement.minimumAmountCents) {
    grossCommissionCents = agreement.minimumAmountCents;
    minimumAppliedCents = agreement.minimumAmountCents;
  }

  const referralFeeCents = agreement.referralFeeCents ?? 0;
  if (referralFeeCents > grossCommissionCents) {
    throw new Error("referralFeeCents cannot exceed grossCommissionCents.");
  }
  const commissionExGstCents = grossCommissionCents - referralFeeCents;

  const gstRateBpsUsed = agreement.gstRateBps ?? 1000;
  const gstCents = agreement.gstApplicable ? roundCents((commissionExGstCents * gstRateBpsUsed) / 10000, "gst", adjustments) : 0;

  let brokerageComponentCents: number | null = null;
  let agentComponentCents: number | null = null;
  if (agreement.brokerageSplitBps != null) {
    const exactBrokerage = (commissionExGstCents * agreement.brokerageSplitBps) / 10000;
    brokerageComponentCents = roundCents(exactBrokerage, "brokerage-split", adjustments);
    // The agent's share is always the exact remainder, never independently
    // rounded — this guarantees the two components sum to
    // commissionExGstCents exactly, with no cent unaccounted for.
    agentComponentCents = commissionExGstCents - brokerageComponentCents;
  }

  return {
    grossCommissionCents,
    minimumAppliedCents,
    referralFeeCents,
    commissionExGstCents,
    gstCents,
    gstRateBpsUsed,
    brokerageComponentCents,
    agentComponentCents,
    roundingAdjustments: adjustments,
  };
}

async function nextCommissionCalculationVersion(transactionId: number): Promise<number> {
  const rows = await db
    .select({ calculationVersion: commissionCalculations.calculationVersion })
    .from(commissionCalculations)
    .where(eq(commissionCalculations.transactionId, transactionId));
  const maxVersion = rows.reduce((max, r) => Math.max(max, r.calculationVersion), 0);
  return maxVersion + 1;
}

export interface CreateCommissionCalculationInput {
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  commissionAgreementId: number;
  salePriceCentsInput: number;
  state?: "ESTIMATE" | "PROVISIONAL" | "CONFIRMED" | "FINALISED";
  calculatedByUserId?: number | null;
  correlationId?: string | null;
  /** When true, marks the transaction's current FINALISED calculation (if any) as SUPERSEDED and records supersedesId on the new row. */
  supersede?: boolean;
  supersededReason?: string | null;
}

/**
 * Loads the given commissionAgreement, computes the result
 * deterministically, and persists it as the next calculationVersion for
 * this transaction. Never edits a prior row.
 */
export async function createCommissionCalculation(input: CreateCommissionCalculationInput): Promise<CommissionCalculation> {
  const [agreement] = await db.select().from(commissionAgreements).where(eq(commissionAgreements.id, input.commissionAgreementId));
  if (!agreement) throw new Error(`Commission agreement ${input.commissionAgreementId} not found.`);
  if (agreement.transactionId !== input.transactionId) {
    throw new Error(`Commission agreement ${input.commissionAgreementId} does not belong to transaction ${input.transactionId}.`);
  }

  const result = computeCommission(agreement, input.salePriceCentsInput);
  const calculationVersion = await nextCommissionCalculationVersion(input.transactionId);

  let supersedesId: number | null = null;
  if (input.supersede) {
    const finalisedRows = await db
      .select()
      .from(commissionCalculations)
      .where(and(eq(commissionCalculations.transactionId, input.transactionId), eq(commissionCalculations.state, "FINALISED")));
    // Only a FINALISED prior calculation is a meaningful "supersede"
    // target — an ESTIMATE/PROVISIONAL snapshot is expected to be
    // replaced freely as inputs change and is never itself superseded.
    const current = finalisedRows.sort((a, b) => b.calculationVersion - a.calculationVersion)[0];
    if (current) {
      supersedesId = current.id;
      await db.update(commissionCalculations).set({ state: "SUPERSEDED" }).where(eq(commissionCalculations.id, current.id));
    }
  }

  const values: InsertCommissionCalculation = {
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    commissionAgreementId: agreement.id,
    calculationVersion,
    state: input.state ?? "ESTIMATE",
    supersedesId,
    supersededReason: input.supersede ? (input.supersededReason ?? "Recalculated") : null,
    salePriceCentsInput: input.salePriceCentsInput,
    methodUsed: agreement.method,
    rateBpsUsed: agreement.rateBps ?? null,
    tiersUsed: agreement.method === "TIERED" ? agreement.tiers : null,
    grossCommissionCents: result.grossCommissionCents,
    minimumAppliedCents: result.minimumAppliedCents,
    referralFeeCents: result.referralFeeCents,
    commissionExGstCents: result.commissionExGstCents,
    gstCents: result.gstCents,
    gstRateBpsUsed: result.gstRateBpsUsed,
    brokerageComponentCents: result.brokerageComponentCents,
    agentComponentCents: result.agentComponentCents,
    roundingAdjustments: result.roundingAdjustments,
    calculationRuleVersion: CALCULATION_RULE_VERSION,
    calculatedByUserId: input.calculatedByUserId ?? null,
    finalisedAt: input.state === "FINALISED" ? new Date() : null,
    correlationId: input.correlationId ?? null,
  };

  const [calculation] = await db.insert(commissionCalculations).values(values).returning();
  return calculation;
}
