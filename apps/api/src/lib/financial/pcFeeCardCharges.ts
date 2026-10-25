// Owner t180u(3) (slice 6): stored-card collection of the AE Pit Crew service
// fee against the SINGLE payment method nominated on the PC fee authority
// (D8, no fallback), under the agent's own authority or a brokerage authority
// approved by a Brokerage Administrator (D3). Called ONLY from
// lib/pitCrewServiceFee.ts after every collection gate has passed (issued
// statement, settlement, both written confirmations, finalised fee, valid
// authority, notice period). It is the only path that charges a card for the
// service fee; Pit Crew still cannot charge service orders or anything else.
//
// No double debit:
//   * the payment request row is locked (SELECT ... FOR UPDATE) while a
//     PENDING financial_card_charges row is written and the request moves to
//     PROCESSING; a concurrent caller then sees PROCESSING and gets
//     already_in_progress;
//   * partial unique indexes allow one SUCCEEDED and one PENDING/UNKNOWN
//     charge per request; the per-attempt idempotency key is also the
//     provider idempotency key;
//   * a provider error (no definite answer) leaves the charge UNKNOWN and the
//     request PROCESSING: never retried automatically (the card may have been
//     charged); a Brokerage Administrator resolves it.
// A declined charge moves the request to RETRY_SCHEDULED (or FAILED after
// max_retries) and issues a failure receipt; a retry is a new attempt only on
// an explicit, fully re-gated collect call. A card failure never falls back
// to the direct-debit mandate, and a direct-debit authority never charges a card.
//
// Mock/test providers only (t180u): anything other than MockPaymentProvider is
// refused before any row is written. No card data anywhere: provider tokens
// are read from payment_methods only to call the provider and are never
// logged, audited, returned or put on a receipt (label at most).
import { and, eq, inArray } from "drizzle-orm";
import { cardRetryDue, nextCardRetryAt } from "./retryBackoff.js";
import { MockPaymentProvider } from "@aee/integration-payments";
import {
  db,
  financialCardCharges,
  financialLedgerEvents,
  financialPaymentRequests,
  type FinancialCardCharge,
  type FinancialPaymentRequest,
  type PcFeeAuthority,
} from "@aee/db";
import { logger } from "@aee/events";
import { paymentProvider } from "../paymentProvider.js";
import { logAudit } from "../audit.js";
import { emitFinancialEvent } from "./events.js";
import { nominatedPaymentMethodFor } from "./pcFeeAuthorities.js";
import { collectionTimingFor } from "./pcFeeTerms.js";
import { sanitiseFailureMessage, syncReceiptsForPaymentRequest } from "./receipts.js";

export type CardChargeTrigger = "collect" | "statement_issued" | "scheduler";
export type CardChargeOutcome = "card_charged" | "card_failed_retry_scheduled" | "card_failed_final" | "card_outcome_unknown" | "already_in_progress" | "already_paid";

export class CardChargeRefusal extends Error {
  constructor(public readonly code: "PROVIDER_NOT_PERMITTED" | "METHOD_INVALID" | "NOT_CHARGEABLE" | "RETRY_NOT_DUE", message?: string) {
    super(message ?? code);
    this.name = "CardChargeRefusal";
  }
}

/** t180u: mock or test providers only. A live provider is refused (fail closed). */
export function cardProviderPermitted(): boolean {
  return paymentProvider instanceof MockPaymentProvider;
}

export function cardIdempotencyKey(paymentRequestId: number, attemptNo: number): string {
  return `pcfee-card:${paymentRequestId}:${attemptNo}`;
}

async function ledger(req: FinancialPaymentRequest, eventType: string, reason?: string | null, actorUserId?: number | null) {
  await db.insert(financialLedgerEvents).values({
    brokerageId: req.brokerageId,
    propertyId: req.propertyId,
    transactionId: req.transactionId,
    eventType,
    amountCents: req.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(req.id),
    actorType: actorUserId ? "USER" : "SYSTEM",
    actorUserId: actorUserId ?? null,
    reason: reason ?? null,
  });
}

const PAID = ["PAID", "RECONCILED"];
const CHARGEABLE = ["NOTICE_SENT", "RETRY_SCHEDULED"];

export interface CardChargeResult {
  outcome: CardChargeOutcome;
  paymentRequest: FinancialPaymentRequest;
  charge: FinancialCardCharge | null;
}

export async function chargeServiceFeeStoredCard(input: {
  paymentRequestId: number;
  authority: PcFeeAuthority;
  actorUserId: number | null;
  trigger: CardChargeTrigger;
}): Promise<CardChargeResult> {
  const { authority } = input;
  if (authority.authorisedPaymentMethod !== "STORED_CARD") throw new CardChargeRefusal("METHOD_INVALID", "Authority does not nominate a stored card (no fallback).");
  if (!cardProviderPermitted()) throw new CardChargeRefusal("PROVIDER_NOT_PERMITTED", "Only the mock/test payment provider may be charged (t180u).");
  const pm = await nominatedPaymentMethodFor(authority);
  if (!pm) throw new CardChargeRefusal("METHOD_INVALID", "The nominated card is not an active saved card of the authorised payer.");

  // 1. Durable intent under a row lock.
  const claimed = await db.transaction(async (tx) => {
    const [req] = await tx.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, input.paymentRequestId)).for("update");
    if (!req) throw new CardChargeRefusal("NOT_CHARGEABLE", "Payment request not found.");
    if (req.pcFeeAuthorityId !== authority.id) throw new CardChargeRefusal("NOT_CHARGEABLE", "Payment request is not covered by this authority.");
    if (PAID.includes(req.status)) return { kind: "already_paid" as const, req };
    if (!CHARGEABLE.includes(req.status)) {
      if (req.status === "PROCESSING" || req.status === "DEBIT_SCHEDULED") return { kind: "already_in_progress" as const, req };
      throw new CardChargeRefusal("NOT_CHARGEABLE", `Request is ${req.status}.`);
    }
    // t181u(A) defence in depth: never charge inside a contractual notice period.
    if (req.status === "NOTICE_SENT" && collectionTimingFor(authority).rule !== "IMMEDIATE_ON_STATEMENT_ISSUE") {
      const elapses = req.noticeSentAt ? req.noticeSentAt.getTime() + authority.noticeRequiredDays * 86_400_000 : Infinity;
      if (Date.now() < elapses) throw new CardChargeRefusal("NOT_CHARGEABLE", "The contractual notice period has not elapsed.");
    }
    const prior = await tx.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, req.id));
    if (prior.some((c) => c.status === "SUCCEEDED")) return { kind: "already_paid" as const, req };
    if (prior.some((c) => c.status === "PENDING" || c.status === "UNKNOWN")) return { kind: "already_in_progress" as const, req };
    if (req.status === "RETRY_SCHEDULED" && req.retryCount >= req.maxRetries) throw new CardChargeRefusal("NOT_CHARGEABLE", "Retries exhausted.");
    // t181u(C): never before the backoff elapses (fail closed when unset).
    if (req.status === "RETRY_SCHEDULED" && !cardRetryDue(req.nextAttemptAt)) throw new CardChargeRefusal("RETRY_NOT_DUE", "The next retry is not due yet.");
    const attemptNo = prior.reduce((m, c) => Math.max(m, c.attemptNo), 0) + 1;
    const [charge] = await tx
      .insert(financialCardCharges)
      .values({
        brokerageId: req.brokerageId,
        paymentRequestId: req.id,
        pcFeeAuthorityId: authority.id,
        paymentMethodId: pm.id,
        payerType: authority.payerType,
        attemptNo,
        idempotencyKey: cardIdempotencyKey(req.id, attemptNo),
        amountCents: req.amountCents,
        currency: req.currency,
        status: "PENDING",
        provider: pm.provider,
        trigger: input.trigger,
        initiatedByUserId: input.actorUserId,
      })
      .returning();
    const [processing] = await tx
      .update(financialPaymentRequests)
      .set({ status: "PROCESSING", processingStartedAt: new Date(), nextAttemptAt: null, provider: pm.provider, providerStatus: "CardChargePending", updatedAt: new Date() })
      .where(eq(financialPaymentRequests.id, req.id))
      .returning();
    return { kind: "claimed" as const, req: processing!, charge: charge! };
  });
  if (claimed.kind !== "claimed") return { outcome: claimed.kind, paymentRequest: claimed.req, charge: null };
  const { charge } = claimed;
  await ledger(claimed.req, "PC_FEE_CARD_CHARGE_ATTEMPTED", `attempt ${charge.attemptNo} (${pm.label ?? "saved card"})`, input.actorUserId);

  // 2. Provider call (outside the lock), tokens passed only to the provider.
  let outcome: CardChargeOutcome;
  let updatedReq: FinancialPaymentRequest;
  let updatedCharge: FinancialCardCharge;
  try {
    const result = await paymentProvider.chargeStoredMethod({
      paymentMethodProviderRef: pm.providerPaymentMethodRef,
      providerCustomerRef: pm.providerCustomerRef,
      amountCents: charge.amountCents,
      currency: "AUD",
      idempotencyKey: charge.idempotencyKey,
      description: `AE Pit Crew service fee, payment request #${charge.paymentRequestId}`,
    });
    if (result.status === "Succeeded") {
      [updatedCharge] = (await db
        .update(financialCardCharges)
        .set({ status: "SUCCEEDED", providerChargeRef: result.providerChargeRef, completedAt: new Date() })
        .where(and(eq(financialCardCharges.id, charge.id), eq(financialCardCharges.status, "PENDING")))
        .returning()) as [FinancialCardCharge];
      [updatedReq] = (await db
        .update(financialPaymentRequests)
        .set({ status: "PAID", paidAt: new Date(), providerRequestRef: result.providerChargeRef, providerStatus: "Succeeded", failureReason: null, updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, charge.paymentRequestId))
        .returning()) as [FinancialPaymentRequest];
      await ledger(updatedReq, "PC_FEE_PAID", `stored card, attempt ${charge.attemptNo}`);
      await emitFinancialEvent({
        eventType: "FINANCIAL_PAYMENT_PAID",
        brokerageId: updatedReq.brokerageId,
        propertyId: updatedReq.propertyId,
        transactionId: updatedReq.transactionId,
        actorType: "SYSTEM",
        source: "api:financial:pcFeeCardCharge",
        payload: { paymentRequestId: updatedReq.id, amountCents: updatedReq.amountCents, method: "STORED_CARD" },
      });
      outcome = "card_charged";
    } else {
      const failure = sanitiseFailureMessage(result.failureReason ?? "Card charge declined");
      [updatedCharge] = (await db
        .update(financialCardCharges)
        .set({ status: "FAILED", providerChargeRef: result.providerChargeRef || null, failureMessage: failure, completedAt: new Date() })
        .where(and(eq(financialCardCharges.id, charge.id), eq(financialCardCharges.status, "PENDING")))
        .returning()) as [FinancialCardCharge];
      const [cur] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, charge.paymentRequestId));
      const retryCount = cur!.retryCount + 1;
      const willRetry = retryCount < cur!.maxRetries;
      [updatedReq] = (await db
        .update(financialPaymentRequests)
        .set({ status: willRetry ? "RETRY_SCHEDULED" : "FAILED", retryCount, nextAttemptAt: willRetry ? nextCardRetryAt(new Date(), retryCount) : null, failedAt: willRetry ? null : new Date(), failureReason: failure, providerStatus: "Failed", updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, charge.paymentRequestId))
        .returning()) as [FinancialPaymentRequest];
      await ledger(updatedReq, "PC_FEE_PAYMENT_FAILED", `${failure} (stored card, attempt ${retryCount}/${cur!.maxRetries}${willRetry ? ", next attempt after backoff" : ", exhausted"})`);
      if (!willRetry) {
        await emitFinancialEvent({
          eventType: "FINANCIAL_PAYMENT_FAILED",
          brokerageId: updatedReq.brokerageId,
          propertyId: updatedReq.propertyId,
          transactionId: updatedReq.transactionId,
          actorType: "SYSTEM",
          source: "api:financial:pcFeeCardCharge",
          payload: { paymentRequestId: updatedReq.id, amountCents: updatedReq.amountCents, reason: failure, method: "STORED_CARD" },
        });
      }
      outcome = willRetry ? "card_failed_retry_scheduled" : "card_failed_final";
    }
  } catch {
    // No definite provider answer: the card MAY have been charged. Never retried automatically.
    logger.error("pc_fee_card_charge_outcome_unknown", { paymentRequestId: charge.paymentRequestId, chargeId: charge.id, attemptNo: charge.attemptNo });
    [updatedCharge] = (await db
      .update(financialCardCharges)
      // Fixed text: a provider error message may echo request fields, so it is never stored.
      .set({ status: "UNKNOWN", failureMessage: "Provider gave no definite answer" })
      .where(and(eq(financialCardCharges.id, charge.id), eq(financialCardCharges.status, "PENDING")))
      .returning()) as [FinancialCardCharge];
    [updatedReq] = (await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, charge.paymentRequestId))) as [FinancialPaymentRequest];
    await ledger(updatedReq, "PC_FEE_CARD_CHARGE_UNKNOWN", `attempt ${charge.attemptNo}: provider gave no definite answer; Brokerage Administrator review`);
    outcome = "card_outcome_unknown";
  }

  await syncReceiptsForPaymentRequest(charge.paymentRequestId);
  await logAudit({
    brokerageId: charge.brokerageId,
    userId: input.actorUserId,
    action: "pit_crew_service_fee_card_charge",
    recordType: "financial_payment_request",
    recordId: String(charge.paymentRequestId),
    propertyId: updatedReq.propertyId,
    updatedValue: JSON.stringify({
      outcome,
      trigger: input.trigger,
      chargeId: charge.id,
      attemptNo: charge.attemptNo,
      chargeStatus: updatedCharge?.status ?? null,
      requestStatus: updatedReq.status,
      amountCents: charge.amountCents,
      payerType: authority.payerType,
      paymentMethodLabel: pm.label ?? null,
      pcFeeAuthorityId: authority.id,
      policy: "t180u",
    }),
  });
  return { outcome, paymentRequest: updatedReq, charge: updatedCharge ?? null };
}

export async function listCardChargesForRequest(paymentRequestIds: number[]): Promise<FinancialCardCharge[]> {
  if (paymentRequestIds.length === 0) return [];
  return db.select().from(financialCardCharges).where(inArray(financialCardCharges.paymentRequestId, paymentRequestIds));
}
