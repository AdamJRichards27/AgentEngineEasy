import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computePcFee } from "../pcFeeCalculations.js";
import type { PcFeeAuthority, CommissionCalculation } from "@aee/db";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// Pure-function tests for the PC success-fee calculation formula
// (Section 12, Section 35.A) — no database needed.

function makeAuthority(overrides: Partial<PcFeeAuthority> = {}): PcFeeAuthority {
  return {
    id: 1,
    brokerageId: 1,
    agentUserId: 1,
    version: 1,
    supersedesId: null,
    status: "ACTIVE",
    feeBasis: "PERCENTAGE_OF_GCI",
    rateBps: 690,
    fixedAmountCents: null,
    gciDefinition: "COMMISSION_EX_GST",
    gstApplicable: true,
    paymentTrigger: "SETTLEMENT_COMPLETED",
    authorisedPaymentMethod: "GENERAL_ACCOUNT_DEBIT_MANDATE",
    mandateProviderRef: null,
    mandateProvider: null,
    maximumAmountCents: null,
    noticeRequiredDays: 7,
    signedEvidenceRef: null,
    effectiveDate: null,
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokeReason: null,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as PcFeeAuthority;
}

function makeCommissionCalculation(overrides: Partial<CommissionCalculation> = {}): CommissionCalculation {
  return {
    id: 1,
    brokerageId: 1,
    propertyId: 1,
    transactionId: 1,
    commissionAgreementId: 1,
    calculationVersion: 1,
    state: "FINALISED",
    supersedesId: null,
    supersededReason: null,
    salePriceCentsInput: 80_000_000,
    methodUsed: "PERCENTAGE",
    rateBpsUsed: 220,
    tiersUsed: null,
    grossCommissionCents: 1_760_000,
    minimumAppliedCents: null,
    referralFeeCents: 0,
    commissionExGstCents: 1_760_000,
    gstCents: 176_000,
    gstRateBpsUsed: 1000,
    brokerageComponentCents: null,
    agentComponentCents: null,
    roundingAdjustments: [],
    calculationRuleVersion: 1,
    calculatedByUserId: null,
    calculatedAt: new Date(),
    finalisedAt: new Date(),
    correlationId: null,
    ...overrides,
  } as CommissionCalculation;
}

describe("computePcFee — PERCENTAGE_OF_GCI", () => {
  test("applies rateBps to the commission-ex-GST figure by default", () => {
    const authority = makeAuthority({ rateBps: 690 });
    const calc = makeCommissionCalculation({ commissionExGstCents: 1_760_000 });
    const result = computePcFee(authority, calc);
    assert.equal(result.gciBasisCents, 1_760_000);
    assert.equal(result.grossFeeCents, Math.round(1_760_000 * 0.069));
    assert.equal(result.totalFeeCents, result.grossFeeCents + result.gstCents);
  });

  test("gciDefinition COMMISSION_INC_GST bases the fee on ex-GST + GST instead", () => {
    const authority = makeAuthority({ rateBps: 690, gciDefinition: "COMMISSION_INC_GST" });
    const calc = makeCommissionCalculation({ commissionExGstCents: 1_760_000, gstCents: 176_000 });
    const result = computePcFee(authority, calc);
    assert.equal(result.gciBasisCents, 1_936_000);
  });

  test("maximumAmountCents caps a formula result that exceeds it", () => {
    const authority = makeAuthority({ rateBps: 690, maximumAmountCents: 50_000 });
    const calc = makeCommissionCalculation({ commissionExGstCents: 1_760_000 });
    const result = computePcFee(authority, calc);
    assert.equal(result.grossFeeCents, 50_000);
  });
});

describe("computePcFee — FIXED_AMOUNT and NONE", () => {
  test("FIXED_AMOUNT ignores the GCI basis entirely", () => {
    const authority = makeAuthority({ feeBasis: "FIXED_AMOUNT", rateBps: null, fixedAmountCents: 80_000 });
    const calc = makeCommissionCalculation();
    const result = computePcFee(authority, calc);
    assert.equal(result.grossFeeCents, 80_000);
  });

  test("NONE always produces a zero fee", () => {
    const authority = makeAuthority({ feeBasis: "NONE", rateBps: null });
    const calc = makeCommissionCalculation();
    const result = computePcFee(authority, calc);
    assert.equal(result.grossFeeCents, 0);
    assert.equal(result.totalFeeCents, 0);
  });
});

describe("computePcFee — GST", () => {
  test("gstCents is zero when gstApplicable is false", () => {
    const authority = makeAuthority({ gstApplicable: false });
    const calc = makeCommissionCalculation();
    const result = computePcFee(authority, calc);
    assert.equal(result.gstCents, 0);
    assert.equal(result.totalFeeCents, result.grossFeeCents);
  });
});
