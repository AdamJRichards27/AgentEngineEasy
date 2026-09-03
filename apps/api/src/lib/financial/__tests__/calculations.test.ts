import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeCommission } from "../calculations.js";
import type { CommissionAgreement } from "@aee/db";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// Pure-function tests for the deterministic commission calculation
// formula (Sections 10-11, Section 35.A) — no database needed, since
// computeCommission never touches it. DB-backed versioning/persistence
// tests (createCommissionCalculation) and the settlement-idempotency flow
// live in settlement.test.ts, which needs real property/transaction
// fixtures.

function makeAgreement(overrides: Partial<CommissionAgreement> = {}): CommissionAgreement {
  return {
    id: 1,
    brokerageId: 1,
    propertyId: 1,
    transactionId: 1,
    version: 1,
    status: "APPROVED",
    supersedesId: null,
    currency: "AUD",
    method: "PERCENTAGE",
    rateBps: 220,
    fixedAmountCents: null,
    tiers: null,
    minimumAmountCents: null,
    manualReason: null,
    gstApplicable: true,
    gstRateBps: 1000,
    referralFeeCents: 0,
    brokerageSplitBps: null,
    agentSplitBps: null,
    seededFromAgencyAgreementTermsId: null,
    sourceDocumentRef: null,
    effectiveDate: null,
    approvedByUserId: null,
    approvedAt: null,
    cancelledByUserId: null,
    cancelledAt: null,
    cancelReason: null,
    notes: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CommissionAgreement;
}

describe("computeCommission — PERCENTAGE", () => {
  test("applies rateBps to sale price and computes GST on the ex-GST amount", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 220 });
    const result = computeCommission(agreement, 80_000_000); // $800,000.00
    assert.equal(result.grossCommissionCents, 1_760_000); // 800000 * 2.20%
    assert.equal(result.commissionExGstCents, 1_760_000);
    assert.equal(result.gstCents, 176_000); // 10% of ex-GST
    assert.equal(result.minimumAppliedCents, null);
  });

  test("records a rounding adjustment when the exact percentage isn't a whole cent", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 233 }); // 2.33%
    const result = computeCommission(agreement, 100_001); // deliberately not a round multiple
    const exact = (100_001 * 233) / 10000;
    assert.equal(result.grossCommissionCents, Math.round(exact));
    assert.ok(result.roundingAdjustments.some((a) => a.step === "percentage-of-sale-price"));
  });
});

describe("computeCommission — FIXED_AMOUNT", () => {
  test("uses fixedAmountCents directly, no rounding evidence needed", () => {
    const agreement = makeAgreement({ method: "FIXED_AMOUNT", rateBps: null, fixedAmountCents: 1_500_000 });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.grossCommissionCents, 1_500_000);
    assert.equal(result.roundingAdjustments.length, 0);
  });
});

describe("computeCommission — TIERED", () => {
  test("applies a marginal bracket schedule, not a single flat rate for the whole price", () => {
    const agreement = makeAgreement({
      method: "TIERED",
      rateBps: null,
      tiers: [
        { upToCents: 50_000_000, rateBps: 275 }, // 2.75% on the first $500k
        { upToCents: 100_000_000, rateBps: 220 }, // 2.20% on the next $500k
        { upToCents: null, rateBps: 165 }, // 1.65% above $1M
      ],
    });
    const result = computeCommission(agreement, 120_000_000); // $1,200,000
    const expected = Math.round(50_000_000 * 0.0275) + Math.round(50_000_000 * 0.022) + Math.round(20_000_000 * 0.0165);
    assert.equal(result.grossCommissionCents, expected);
  });

  test("a price entirely within the first tier never touches later tiers", () => {
    const agreement = makeAgreement({
      method: "TIERED",
      rateBps: null,
      tiers: [
        { upToCents: 50_000_000, rateBps: 275 },
        { upToCents: null, rateBps: 165 },
      ],
    });
    const result = computeCommission(agreement, 20_000_000); // $200,000 — well inside tier 1
    assert.equal(result.grossCommissionCents, Math.round(20_000_000 * 0.0275));
  });

  test("an empty tiers array is rejected", () => {
    const agreement = makeAgreement({ method: "TIERED", rateBps: null, tiers: [] });
    assert.throws(() => computeCommission(agreement, 10_000_000), /missing its tiers array/);
  });
});

describe("computeCommission — MANUAL_WITH_REASON", () => {
  test("requires a non-empty manualReason", () => {
    const agreement = makeAgreement({ method: "MANUAL_WITH_REASON", rateBps: null, fixedAmountCents: 900_000, manualReason: null });
    assert.throws(() => computeCommission(agreement, 80_000_000), /missing manualReason/);
  });

  test("uses fixedAmountCents once a reason is present", () => {
    const agreement = makeAgreement({
      method: "MANUAL_WITH_REASON",
      rateBps: null,
      fixedAmountCents: 900_000,
      manualReason: "Negotiated flat fee per vendor agreement.",
    });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.grossCommissionCents, 900_000);
  });
});

describe("computeCommission — minimum amount override", () => {
  test("overrides a formula result that falls below the floor, and records minimumAppliedCents", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 100, minimumAmountCents: 500_000 });
    const result = computeCommission(agreement, 20_000_000); // 1% of $200k = $2,000 < $5,000 floor
    assert.equal(result.grossCommissionCents, 500_000);
    assert.equal(result.minimumAppliedCents, 500_000);
  });

  test("leaves minimumAppliedCents null when the formula result already clears the floor", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 220, minimumAmountCents: 500_000 });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.minimumAppliedCents, null);
  });
});

describe("computeCommission — referral fee and brokerage/agent split", () => {
  test("subtracts the referral fee before computing GST and the split", () => {
    const agreement = makeAgreement({
      method: "PERCENTAGE",
      rateBps: 220,
      referralFeeCents: 100_000,
      brokerageSplitBps: 3000, // 30% to brokerage
    });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.grossCommissionCents, 1_760_000);
    assert.equal(result.referralFeeCents, 100_000);
    assert.equal(result.commissionExGstCents, 1_660_000); // gross - referral
    assert.equal(result.gstCents, 166_000); // 10% of the post-referral ex-GST figure
    assert.equal(result.brokerageComponentCents, Math.round(1_660_000 * 0.3));
    // The agent's component is always the exact remainder, so the two
    // components sum to commissionExGstCents with no cent lost to rounding.
    assert.equal(result.brokerageComponentCents! + result.agentComponentCents!, result.commissionExGstCents);
  });

  test("a referral fee larger than the gross commission is rejected", () => {
    const agreement = makeAgreement({ method: "FIXED_AMOUNT", rateBps: null, fixedAmountCents: 100_000, referralFeeCents: 200_000 });
    assert.throws(() => computeCommission(agreement, 80_000_000), /referralFeeCents cannot exceed/);
  });

  test("brokerageComponentCents/agentComponentCents stay null when no split is configured", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 220, brokerageSplitBps: null });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.brokerageComponentCents, null);
    assert.equal(result.agentComponentCents, null);
  });
});

describe("computeCommission — GST and input validation", () => {
  test("gstCents is zero when gstApplicable is false, regardless of gstRateBps", () => {
    const agreement = makeAgreement({ method: "PERCENTAGE", rateBps: 220, gstApplicable: false });
    const result = computeCommission(agreement, 80_000_000);
    assert.equal(result.gstCents, 0);
  });

  test("a negative sale price is rejected", () => {
    const agreement = makeAgreement();
    assert.throws(() => computeCommission(agreement, -1), /cannot be negative/);
  });
});
