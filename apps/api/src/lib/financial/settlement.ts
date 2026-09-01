// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// Settlement-triggered finalisation (Section 21). This module is the pure
// service layer Stage F's registerFinancialEngine() event subscriber
// calls when a SETTLEMENT_COMPLETED domain event arrives — it is not
// itself wired to the event bus (that wiring is Stage F's job), so it can
// be exercised directly and deterministically in tests.
//
// Settlement idempotency guarantee: a repeated SETTLEMENT_COMPLETED for
// the same transaction must never create a second PC_SUCCESS_FEE payment
// request. The DB-level uniqueness constraint
// (financial_payment_requests_transaction_kind_idx, on (transactionId,
// kind)) is the real backstop; ensurePcSuccessFeeRequest below
// additionally SELECTs-before-INSERTs and falls back to
// onConflictDoNothing + re-SELECT on a race — the same idiom
// lib/communications/webhooks.ts uses for inbound webhook dedup — so a
// caller never has to catch a unique-violation error itself.

import { eq, and } from "drizzle-orm";
import {
  db,
  transactions,
  commissionAgreements,
  commissionCalculations,
  pcFeeCalculations,
  financialPaymentRequests,
  financialLedgerEvents,
  type CommissionCalculation,
  type FinancialPaymentRequest,
} from "@aee/db";
import { createCommissionCalculation } from "./calculations.js";

async function recordLedgerEvent(input: {
  brokerageId: number;
  propertyId?: number | null;
  transactionId?: number | null;
  eventType: string;
  amountCents?: number | null;
  sourceRecordType: string;
  sourceRecordId: string;
  actorType: "SYSTEM" | "USER";
  actorUserId?: number | null;
  reason?: string | null;
  correlationId?: string | null;
}): Promise<void> {
  await db.insert(financialLedgerEvents).values({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId ?? null,
    transactionId: input.transactionId ?? null,
    eventType: input.eventType,
    amountCents: input.amountCents ?? null,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    reason: input.reason ?? null,
    correlationId: input.correlationId ?? null,
  });
}

export interface FinalizeCommissionForSettlementInput {
  transactionId: number;
  brokerageId: number;
  propertyId: number;
  salePriceCentsOverride?: number;
  correlationId?: string | null;
}

export interface FinalizeCommissionResult {
  calculation: CommissionCalculation | null;
  skippedReason?: string;
}

/**
 * Called once a transaction's settlement has completed. Requires an
 * APPROVED commissionAgreement to exist — if none does, this is a no-op
 * (the transaction falls back to lib/transactions.ts's own flat
 * calculateCommission(), exactly as financial.ts's header comment
 * describes: "it never requires an agreement to exist"). Idempotent per
 * transaction+agreement+sale-price: calling this again when a FINALISED
 * calculation already exists for the same agreement and sale price
 * returns that existing calculation rather than creating a duplicate
 * FINALISED snapshot; a genuinely different sale price (e.g. a corrected
 * figure) supersedes the prior FINALISED row instead of editing it.
 */
export async function finalizeCommissionForSettlement(input: FinalizeCommissionForSettlementInput): Promise<FinalizeCommissionResult> {
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, input.transactionId));
  if (!transaction) throw new Error(`Transaction ${input.transactionId} not found.`);

  const agreementRows = await db
    .select()
    .from(commissionAgreements)
    .where(and(eq(commissionAgreements.transactionId, input.transactionId), eq(commissionAgreements.status, "APPROVED")));
  // Latest-approved-by-version wins if more than one APPROVED row somehow
  // exists (shouldn't happen in the normal single-approval flow, but this
  // is defensive rather than assumed).
  const agreement = agreementRows.sort((a, b) => b.version - a.version)[0];
  if (!agreement) {
    return { calculation: null, skippedReason: "No APPROVED commission agreement exists for this transaction." };
  }

  const salePriceCents = input.salePriceCentsOverride ?? transaction.purchasePriceCents;

  const finalisedRows = await db
    .select()
    .from(commissionCalculations)
    .where(and(eq(commissionCalculations.transactionId, input.transactionId), eq(commissionCalculations.state, "FINALISED")));
  const existingFinalised = finalisedRows.sort((a, b) => b.calculationVersion - a.calculationVersion)[0];
  if (existingFinalised && existingFinalised.commissionAgreementId === agreement.id && existingFinalised.salePriceCentsInput === salePriceCents) {
    return { calculation: existingFinalised, skippedReason: "Already finalised for this agreement and sale price." };
  }

  const calculation = await createCommissionCalculation({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    commissionAgreementId: agreement.id,
    salePriceCentsInput: salePriceCents,
    state: "FINALISED",
    correlationId: input.correlationId ?? null,
    supersede: Boolean(existingFinalised),
    supersededReason: existingFinalised ? "Recalculated at settlement." : null,
  });

  // Write back onto the legacy flat transactions columns (financial.ts's
  // own header comment) so every existing reader — workflowSteps.ts,
  // homeSummary.ts, timeline.ts, PropertyWorkspace.tsx — sees the more
  // accurate, agreement-driven figure without needing to change.
  await db
    .update(transactions)
    .set({
      grossCommissionCents: calculation.grossCommissionCents,
      gstCents: calculation.gstCents,
      commissionCalculatedAt: calculation.calculatedAt,
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, input.transactionId));

  await recordLedgerEvent({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    eventType: "COMMISSION_FINALISED",
    amountCents: calculation.grossCommissionCents,
    sourceRecordType: "COMMISSION_CALCULATION",
    sourceRecordId: String(calculation.id),
    actorType: "SYSTEM",
    correlationId: input.correlationId ?? null,
  });

  return { calculation };
}

export interface EnsurePcSuccessFeeRequestInput {
  transactionId: number;
  brokerageId: number;
  propertyId: number;
  /** A pcFeeCalculation already produced for this transaction — callers resolve the correct agent/authority (Stage E/F's job) and call createPcFeeCalculation before this. */
  pcFeeCalculationId: number;
  payeeUserId?: number | null;
  payerUserId?: number | null;
  correlationId?: string | null;
}

export interface EnsurePcSuccessFeeRequestResult {
  paymentRequest: FinancialPaymentRequest;
  created: boolean;
  skippedReason?: string;
}

/**
 * THE settlement-idempotency chokepoint (Section 21): a repeated
 * SETTLEMENT_COMPLETED for the same transaction must never create a
 * second PC_SUCCESS_FEE payment request. SELECT-before-INSERT, then
 * onConflictDoNothing + re-SELECT on a race — mirrors
 * lib/communications/webhooks.ts's processInboundWebhook exactly.
 */
export async function ensurePcSuccessFeeRequest(input: EnsurePcSuccessFeeRequestInput): Promise<EnsurePcSuccessFeeRequestResult> {
  const [existingRequest] = await db
    .select()
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.transactionId, input.transactionId), eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE")));
  if (existingRequest) {
    return {
      paymentRequest: existingRequest,
      created: false,
      skippedReason: "A PC_SUCCESS_FEE payment request already exists for this transaction (settlement idempotency).",
    };
  }

  const [pcFeeCalculation] = await db.select().from(pcFeeCalculations).where(eq(pcFeeCalculations.id, input.pcFeeCalculationId));
  if (!pcFeeCalculation) throw new Error(`PC fee calculation ${input.pcFeeCalculationId} not found.`);
  if (pcFeeCalculation.transactionId !== input.transactionId) {
    throw new Error(`PC fee calculation ${input.pcFeeCalculationId} does not belong to transaction ${input.transactionId}.`);
  }

  const idempotencyKey = `pc-success-fee:${input.transactionId}`;

  const [inserted] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId,
      kind: "PC_SUCCESS_FEE",
      pcFeeCalculationId: pcFeeCalculation.id,
      pcFeeAuthorityId: pcFeeCalculation.pcFeeAuthorityId,
      payeeUserId: input.payeeUserId ?? null,
      payerUserId: input.payerUserId ?? null,
      status: "CALCULATED",
      amountCents: pcFeeCalculation.totalFeeCents,
      idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Someone else's insert won the race between our SELECT and our
    // INSERT (or the idempotencyKey collided) — re-select rather than
    // error, exactly like processInboundWebhook's race handling.
    const [raceWinner] = await db
      .select()
      .from(financialPaymentRequests)
      .where(and(eq(financialPaymentRequests.transactionId, input.transactionId), eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE")));
    if (!raceWinner) throw new Error("Failed to create or find a PC_SUCCESS_FEE payment request.");
    return { paymentRequest: raceWinner, created: false, skippedReason: "Already created (concurrent settlement delivery)." };
  }

  await recordLedgerEvent({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    eventType: "PC_FEE_CALCULATED",
    amountCents: inserted.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(inserted.id),
    actorType: "SYSTEM",
    correlationId: input.correlationId ?? null,
  });

  return { paymentRequest: inserted, created: true };
}
