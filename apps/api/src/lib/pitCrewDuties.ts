// Owner t171u (3) — D1–D4 duty-based permissions for confidential transaction
// financials. Code-level map only: NO schema, NO migration.
//
// ============================================================================
// EVERY DEFINITION IN THIS FILE IS PENDING OWNER CONFIRMATION.
// ============================================================================
// Basis (and only basis):
//   - t165u: "Offer prices: listing agent and authorised brokerage
//     administrators only." "Pit Crew: read only the buyer details required
//     for assigned, authorised transaction work; log access."
//   - t170u: "Allow Pit Crew access to the agreed contract purchase price only
//     where the user is assigned to the transaction and the information is
//     required for their duties."
//   - t171u: access requires BOTH an active transaction assignment AND the
//     appropriate duty; undeterminable duty = DENY.
//   - PITCREW-D1-D4-MATRIX-t165u: D2.3 covered categories are OPEN
//     (proposed: transaction exceptions, launch items, contract/condition
//     tracking, settlement prep, AML chasing, document collection, pre-listing
//     prep); D2.2 proposed exclusions include trust-account handling (OPEN);
//     D2.6 accepted contract price for Pit Crew was OPEN until t170u.
//   - Existing code: commission/funds/agent-paid figures are already a
//     Brokerage-Administrator-only "financial entitlement" on the Timeline and
//     the Exceptions API (routes/exceptions.ts canViewFinancials). No Pit Crew
//     duty below widens that.
//
// Where the duty comes from (existing data only): the Pit Crew work item is a
// pit_crew_assignments row with source_type EXCEPTION (the only writable Pit
// Crew source, R-F21). Its risk_exceptions.category is the only stored
// signal of what the work is. A category that is not in this map, a FINANCIAL
// exception, or any other source type yields NO duty, so NO financial field
// (fail closed).
//
// True duty modelling (a per-member service schedule, the #38 schedule, D2.3
// confirmed categories, the D2.4 transaction window) would need its own table:
// an M4-style migration that is NOT written here and NOT approved.

import type { Transaction } from "@aee/db";

/** Confidential transaction financial field groups (Owner t171u (1)). */
export const TRANSACTION_FINANCIAL_GROUPS = ["purchasePrice", "deposit", "commission", "funds"] as const;
export type TransactionFinancialGroup = (typeof TRANSACTION_FINANCIAL_GROUPS)[number];

/**
 * Which transaction-row keys each group covers. `funds` also covers the
 * derived `fundsReconciliation` object (expected = commission + GST), which
 * the transaction routes drop when `funds` is not visible.
 * commission: the gross commission and GST together reveal the price for
 * anyone who knows the rate; deposit: usually a fixed percentage of the price;
 * funds: received funds approximate commission + GST.
 */
export const TRANSACTION_FINANCIAL_GROUP_FIELDS = {
  purchasePrice: ["purchasePriceCents"],
  deposit: ["depositCents"],
  commission: ["grossCommissionCents", "gstCents"],
  funds: ["fundsReceivedCents"],
} as const satisfies Record<TransactionFinancialGroup, readonly (keyof Transaction)[]>;

export type FinancialVisibility = Record<TransactionFinancialGroup, boolean>;

export const ALL_FINANCIALS_VISIBLE: FinancialVisibility = Object.freeze({ purchasePrice: true, deposit: true, commission: true, funds: true });
export const NO_FINANCIALS_VISIBLE: FinancialVisibility = Object.freeze({ purchasePrice: false, deposit: false, commission: false, funds: false });

/** PENDING OWNER CONFIRMATION — proposed Pit Crew duty names. */
export const PIT_CREW_DUTIES = [
  "SETTLEMENT_PREPARATION",
  "CONTRACT_CONDITION_TRACKING",
  "AML_CHASING",
  "OFFER_SUPPORT",
  "PRE_LISTING_SUPPORT",
  "LISTING_SUPPORT",
  "LAUNCH_COORDINATION",
  "WORKFLOW_SUPPORT",
  "COMMUNICATION_SUPPORT",
] as const;
export type PitCrewDuty = (typeof PIT_CREW_DUTIES)[number];

/**
 * PENDING OWNER CONFIRMATION — risk_exceptions.category -> duty.
 * FINANCIAL is deliberately absent (financial entitlement is Brokerage
 * Administrator only; trust-account handling is a proposed D2.2 exclusion).
 * Anything absent maps to no duty (DENY).
 */
export const EXCEPTION_CATEGORY_DUTY: Readonly<Record<string, PitCrewDuty>> = Object.freeze({
  SETTLEMENT_CLOSURE: "SETTLEMENT_PREPARATION",
  CONTRACT_CONDITIONS: "CONTRACT_CONDITION_TRACKING",
  AML_CTF: "AML_CHASING",
  OFFERS: "OFFER_SUPPORT",
  APPRAISAL_AGREEMENT: "PRE_LISTING_SUPPORT",
  LISTING: "LISTING_SUPPORT",
  LAUNCH_CAMPAIGN: "LAUNCH_COORDINATION",
  WORKFLOW_OPERATIONAL: "WORKFLOW_SUPPORT",
  COMMUNICATION: "COMMUNICATION_SUPPORT",
});

/**
 * PENDING OWNER CONFIRMATION — duty -> confidential financial groups it may
 * see. Proposals:
 *   SETTLEMENT_PREPARATION: agreed contract price + deposit (settlement
 *     figures are built from them; t170u's "required for their duties").
 *   CONTRACT_CONDITION_TRACKING: deposit only (deposit-due condition). Whether
 *     it also needs the price (finance condition) is an Owner question.
 *   Every other duty: nothing. No duty ever gets commission or funds.
 * OFFER_SUPPORT gets nothing: t165u keeps offer prices from Pit Crew.
 */
export const DUTY_FINANCIAL_GROUPS: Readonly<Record<PitCrewDuty, readonly TransactionFinancialGroup[]>> = Object.freeze({
  SETTLEMENT_PREPARATION: ["purchasePrice", "deposit"],
  CONTRACT_CONDITION_TRACKING: ["deposit"],
  AML_CHASING: [],
  OFFER_SUPPORT: [],
  PRE_LISTING_SUPPORT: [],
  LISTING_SUPPORT: [],
  LAUNCH_COORDINATION: [],
  WORKFLOW_SUPPORT: [],
  COMMUNICATION_SUPPORT: [],
});

/** Duty for one assignment, or null (DENY). Only EXCEPTION sources carry one. */
export function dutyForAssignment(sourceType: string, exceptionCategory: string | null | undefined): PitCrewDuty | null {
  if (sourceType !== "EXCEPTION" || exceptionCategory == null) return null;
  return Object.prototype.hasOwnProperty.call(EXCEPTION_CATEGORY_DUTY, exceptionCategory)
    ? EXCEPTION_CATEGORY_DUTY[exceptionCategory]!
    : null;
}

/** Union of the groups the given duties may see. Unknown/null duties add nothing. */
export function financialVisibilityForDuties(duties: ReadonlyArray<PitCrewDuty | null>): FinancialVisibility {
  const out: FinancialVisibility = { ...NO_FINANCIALS_VISIBLE };
  for (const duty of duties) {
    if (duty === null) continue;
    for (const group of DUTY_FINANCIAL_GROUPS[duty] ?? []) out[group] = true;
  }
  return out;
}
