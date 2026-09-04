// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// PC (Pit Crew) success-fee calculation service (Section 12). Reads an
// ACTIVE pcFeeAuthority and the transaction's own commission calculation
// to determine the GCI basis, then applies the authority's feeBasis
// deterministically. Like commissionCalculations, every result is a new,
// immutable pcFeeCalculations row — never an edit of a prior one.

import { and, eq } from "drizzle-orm";
import { db, pcFeeAuthorities, pcFeeCalculations, commissionCalculations } from "@aee/db";
import type { PcFeeAuthority, CommissionCalculation, InsertPcFeeCalculation, PcFeeCalculation } from "@aee/db";
import type { RoundingAdjustment } from "./calculations.js";

// AU 10% — same convention as commissionAgreements.gstRateBps's default
// and lib/transactions.ts's own GST_RATE_BPS constant. pcFeeAuthorities
// doesn't carry its own configurable GST rate (Section 12 doesn't call
// for one, only a gstApplicable flag), so this is fixed here rather than
// invented as a second, unused "rate used" column would require.
const GST_RATE_BPS = 1000;

export interface PcFeeCalculationResult {
  gciBasisCents: number;
  rateBpsUsed: number | null;
  grossFeeCents: number;
  gstCents: number;
  totalFeeCents: number;
  roundingAdjustments: RoundingAdjustment[];
}

function roundCents(exact: number, step: string, adjustments: RoundingAdjustment[]): number {
  const rounded = Math.round(exact);
  if (rounded !== exact) adjustments.push({ step, exactCents: exact, roundedCents: rounded, adjustmentCents: rounded - exact });
  return rounded;
}

/**
 * gciDefinition (Section 12) picks which commission figure the PC fee is
 * a percentage of: COMMISSION_EX_GST (the default) or COMMISSION_INC_GST.
 */
function resolveGciBasis(authority: PcFeeAuthority, commissionCalculation: CommissionCalculation): number {
  return authority.gciDefinition === "COMMISSION_INC_GST"
    ? commissionCalculation.commissionExGstCents + commissionCalculation.gstCents
    : commissionCalculation.commissionExGstCents;
}

/** Pure function — never touches the database. */
export function computePcFee(authority: PcFeeAuthority, commissionCalculation: CommissionCalculation): PcFeeCalculationResult {
  const adjustments: RoundingAdjustment[] = [];
  const gciBasisCents = resolveGciBasis(authority, commissionCalculation);

  let grossFeeCents: number;
  let rateBpsUsed: number | null = null;
  switch (authority.feeBasis) {
    case "PERCENTAGE_OF_GCI": {
      if (authority.rateBps == null) throw new Error("PERCENTAGE_OF_GCI authority is missing rateBps.");
      rateBpsUsed = authority.rateBps;
      grossFeeCents = roundCents((gciBasisCents * authority.rateBps) / 10000, "percentage-of-gci", adjustments);
      break;
    }
    case "FIXED_AMOUNT": {
      if (authority.fixedAmountCents == null) throw new Error("FIXED_AMOUNT authority is missing fixedAmountCents.");
      grossFeeCents = authority.fixedAmountCents;
      break;
    }
    case "NONE": {
      grossFeeCents = 0;
      break;
    }
    case "MANUAL_WITH_REASON": {
      if (authority.fixedAmountCents == null) throw new Error("MANUAL_WITH_REASON authority is missing fixedAmountCents.");
      grossFeeCents = authority.fixedAmountCents;
      break;
    }
    default:
      throw new Error(`Unknown PC fee basis: ${authority.feeBasis}`);
  }

  if (authority.maximumAmountCents != null && grossFeeCents > authority.maximumAmountCents) {
    grossFeeCents = authority.maximumAmountCents;
  }

  const gstCents = authority.gstApplicable ? roundCents((grossFeeCents * GST_RATE_BPS) / 10000, "gst", adjustments) : 0;
  const totalFeeCents = grossFeeCents + gstCents;

  return { gciBasisCents, rateBpsUsed, grossFeeCents, gstCents, totalFeeCents, roundingAdjustments: adjustments };
}

async function nextPcFeeCalculationVersion(transactionId: number): Promise<number> {
  const rows = await db
    .select({ calculationVersion: pcFeeCalculations.calculationVersion })
    .from(pcFeeCalculations)
    .where(eq(pcFeeCalculations.transactionId, transactionId));
  const maxVersion = rows.reduce((max, r) => Math.max(max, r.calculationVersion), 0);
  return maxVersion + 1;
}

export interface CreatePcFeeCalculationInput {
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  pcFeeAuthorityId: number;
  commissionCalculationId: number;
  state?: "ESTIMATE" | "PROVISIONAL" | "CONFIRMED" | "FINALISED";
  calculatedByUserId?: number | null;
  correlationId?: string | null;
}

/**
 * Requires the authority to be ACTIVE (Section 13 — a PC fee cannot be
 * calculated against an authority that was never provided, has expired,
 * or was revoked). Persists the result as the next calculationVersion for
 * this transaction. Never edits a prior row.
 */
export async function createPcFeeCalculation(input: CreatePcFeeCalculationInput): Promise<PcFeeCalculation> {
  const [authority] = await db
    .select()
    .from(pcFeeAuthorities)
    .where(and(eq(pcFeeAuthorities.id, input.pcFeeAuthorityId), eq(pcFeeAuthorities.brokerageId, input.brokerageId)));
  // Deliberately identical to a nonexistent id — a foreign brokerage's
  // authority (and its confidential mandate terms) must never be
  // distinguishable from one that simply doesn't exist.
  if (!authority) throw new Error(`PC fee authority ${input.pcFeeAuthorityId} not found.`);
  if (authority.status !== "ACTIVE") {
    throw new Error(`PC fee authority ${input.pcFeeAuthorityId} is ${authority.status}, not ACTIVE — cannot calculate a fee against it.`);
  }

  const [commissionCalculation] = await db
    .select()
    .from(commissionCalculations)
    .where(eq(commissionCalculations.id, input.commissionCalculationId));
  if (!commissionCalculation) throw new Error(`Commission calculation ${input.commissionCalculationId} not found.`);
  if (commissionCalculation.transactionId !== input.transactionId) {
    throw new Error(`Commission calculation ${input.commissionCalculationId} does not belong to transaction ${input.transactionId}.`);
  }

  const result = computePcFee(authority, commissionCalculation);
  const calculationVersion = await nextPcFeeCalculationVersion(input.transactionId);
  const isFinal = input.state === "FINALISED" || input.state === "CONFIRMED";

  const values: InsertPcFeeCalculation = {
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    commissionCalculationId: commissionCalculation.id,
    pcFeeAuthorityId: authority.id,
    calculationVersion,
    state: input.state ?? "ESTIMATE",
    feeBasisUsed: authority.feeBasis,
    gciBasisCents: result.gciBasisCents,
    rateBpsUsed: result.rateBpsUsed,
    grossFeeCents: result.grossFeeCents,
    gstCents: result.gstCents,
    totalFeeCents: result.totalFeeCents,
    isProvisional: !isFinal,
    isDisputed: false,
    calculatedByUserId: input.calculatedByUserId ?? null,
    finalisedAt: input.state === "FINALISED" ? new Date() : null,
    correlationId: input.correlationId ?? null,
  };

  const [calculation] = await db.insert(pcFeeCalculations).values(values).returning();
  return calculation;
}
