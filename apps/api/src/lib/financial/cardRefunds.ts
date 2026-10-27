// Owner t181u phase 2a item 3: controlled card refunds of the AE Pit Crew
// service fee (gap G3).
//
//   * Brokerage Administrator only (route gate); another brokerage's charge is
//     404. Pit Crew and agents are 403 at the role gate.
//   * Only a SUCCEEDED stored-card charge on a PAID/RECONCILED request.
//   * Back to the ORIGINAL charge only: the provider refund is addressed by
//     the charge's provider reference; the API accepts no destination,
//     payment method or reference of any kind (strict body).
//   * Mock provider only (same rule as charging); refused otherwise.
//   * Mandatory reason and evidence (same rules as the other recovery
//     actions); value-free audit; reason in the ledger and on the row.
//   * Never more than the charged amount: the request and charge rows are
//     locked, PENDING/UNKNOWN/SUCCEEDED refunds reserve their amount, and a
//     DB trigger refuses any row that would exceed the charge (0043).
//   * Separation of duties: whoever initiated the charge never refunds it
//     (system-initiated charges: any BA).
//   * Idempotent: one provider idempotency key per refund row, derived from
//     the BA's request key; the same key replays, a different amount under
//     the same key is refused.
//   * Outcomes: Succeeded -> SUCCEEDED + REFUND receipt; definite rejection or
//     Failed -> FAILED (reservation released); anything else (no answer,
//     Pending) -> UNKNOWN, amount stays reserved and is never retried
//     automatically.
// The payment request status is not changed: the fee was collected; refunds
// are tracked per charge and shown on receipts and the statement
// reconciliation section.
import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, financialCardCharges, financialCardRefunds, financialLedgerEvents, type FinancialCardRefund, type FinancialPaymentRequest } from "@aee/db";
import { lookupCardRefundProviderStatus, mockRefundRefFor, refundOutcomeForProviderStatus, type CardRefundProviderStatus } from "./cardRefundStatus.js";
import { RefundRejectedError } from "@aee/integration-payments";
import { paymentProvider } from "../paymentProvider.js";
import { cardProviderPermitted } from "./pcFeeCardCharges.js";
import { sanitiseFailureMessage, syncReceiptsForPaymentRequest } from "./receipts.js";
import {
  auditTx,
  auditValue,
  cleanReason,
  evidenceFor,
  ledgerTx,
  lockRequest,
  RecoveryRefusal,
  type RecoveryActor,
  type RecoveryInput,
} from "./recovery.js";

export const RESERVING_REFUND_STATUSES = ["PENDING", "UNKNOWN", "SUCCEEDED"] as const;
const REFUNDABLE_REQUEST_STATUSES = new Set(["PAID", "RECONCILED"]);

export interface CardRefundInput extends RecoveryInput {
  amountCents: number;
  requestKey: string;
}
export interface CardRefundResult {
  idempotent: boolean;
  refund: PublicCardRefund;
  refundedCents: number;
  refundableCents: number;
}
export type PublicCardRefund = Omit<FinancialCardRefund, "idempotencyKey" | "requestKey">;

export function publicRefund(r: FinancialCardRefund): PublicCardRefund {
  const { idempotencyKey: _k, requestKey: _r, ...rest } = r;
  return rest;
}

function providerKey(chargeId: number, requestKey: string): string {
  return `pcf-card-refund:${chargeId}:${createHash("sha256").update(requestKey).digest("hex").slice(0, 32)}`;
}

async function totals(q: Pick<typeof db, "select">, chargeId: number, chargedCents: number) {
  const rows = await q.select({ amountCents: financialCardRefunds.amountCents, status: financialCardRefunds.status }).from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, chargeId));
  const refundedCents = rows.filter((r) => r.status === "SUCCEEDED").reduce((s, r) => s + r.amountCents, 0);
  const reservedCents = rows.filter((r) => (RESERVING_REFUND_STATUSES as readonly string[]).includes(r.status)).reduce((s, r) => s + r.amountCents, 0);
  return { refundedCents, reservedCents, refundableCents: Math.max(0, chargedCents - reservedCents) };
}

async function peekCharge(actor: RecoveryActor, chargeId: number) {
  if (!Number.isSafeInteger(chargeId) || chargeId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [row] = await db.select().from(financialCardCharges).where(and(eq(financialCardCharges.id, chargeId), eq(financialCardCharges.brokerageId, actor.brokerageId)));
  if (!row) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  return row;
}

export async function listCardRefunds(actor: RecoveryActor, chargeId: number) {
  const charge = await peekCharge(actor, chargeId);
  const rows = await db.select().from(financialCardRefunds).where(eq(financialCardRefunds.cardChargeId, charge.id)).orderBy(financialCardRefunds.id);
  const t = await totals(db, charge.id, charge.status === "SUCCEEDED" ? charge.amountCents : 0);
  return { chargeId: charge.id, chargeStatus: charge.status, chargedCents: charge.amountCents, refundedCents: t.refundedCents, refundableCents: t.refundableCents, refunds: rows.map(publicRefund) };
}

export async function refundCardCharge(actor: RecoveryActor, chargeId: number, input: CardRefundInput): Promise<CardRefundResult> {
  const peek = await peekCharge(actor, chargeId);
  if (peek.initiatedByUserId != null && peek.initiatedByUserId === actor.id) {
    throw new RecoveryRefusal("CARD_REFUND_REFUNDER_IS_INITIATOR", "The person who started this charge cannot refund it; another Brokerage Administrator must.", peek.paymentRequestId);
  }
  if (!cardProviderPermitted()) throw new RecoveryRefusal("CARD_REFUND_PROVIDER_NOT_PERMITTED", "Card refunds are not enabled for this environment.", peek.paymentRequestId);
  const idempotencyKey = providerKey(peek.id, input.requestKey);

  // 1. Durable intent under row locks (request, then charge: same order as the charge path).
  const claimed = await db.transaction(async (tx) => {
    const pr = await lockRequest(tx, actor, peek.paymentRequestId);
    const [charge] = await tx.select().from(financialCardCharges).where(eq(financialCardCharges.id, peek.id)).for("update");
    if (!charge || charge.brokerageId !== actor.brokerageId || charge.paymentRequestId !== pr.id) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
    const [existing] = await tx.select().from(financialCardRefunds).where(and(eq(financialCardRefunds.cardChargeId, charge.id), eq(financialCardRefunds.requestKey, input.requestKey)));
    if (existing) {
      if (existing.amountCents !== input.amountCents) throw new RecoveryRefusal("CARD_REFUND_KEY_REUSED", "This request key was already used for a different refund.", pr.id, pr.propertyId);
      return { kind: "replay" as const, pr, charge, refund: existing };
    }
    if (charge.status !== "SUCCEEDED" || !charge.providerChargeRef || !REFUNDABLE_REQUEST_STATUSES.has(pr.status)) {
      throw new RecoveryRefusal("CARD_REFUND_CHARGE_NOT_REFUNDABLE", "Only a succeeded card charge on a paid fee can be refunded.", pr.id, pr.propertyId);
    }
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    const t = await totals(tx, charge.id, charge.amountCents);
    if (input.amountCents > t.refundableCents) throw new RecoveryRefusal("CARD_REFUND_EXCEEDS_REFUNDABLE", "The refund would exceed the amount charged (less refunds already made or in progress).", pr.id, pr.propertyId);
    const [row] = await tx
      .insert(financialCardRefunds)
      .values({
        brokerageId: pr.brokerageId,
        paymentRequestId: pr.id,
        cardChargeId: charge.id,
        requestKey: input.requestKey,
        idempotencyKey,
        amountCents: input.amountCents,
        currency: charge.currency,
        status: "PENDING",
        provider: charge.provider,
        reason,
        requestedByUserId: actor.id,
      })
      .returning();
    await ledgerTx(tx, pr, "PC_FEE_CARD_REFUND_REQUESTED", actor, reason, { recoveryAction: "refund_card_charge", chargeId: charge.id, refundId: row!.id, refundAmountCents: input.amountCents, evidence });
    await auditTx(tx, actor, "financial_card_refund_requested", pr, auditValue({ paymentRequestId: pr.id, chargeId: charge.id, refundId: row!.id, status: "PENDING" }, evidence));
    return { kind: "claimed" as const, pr, charge, refund: row! };
  });

  if (claimed.kind === "replay") {
    const t = await totals(db, claimed.charge.id, claimed.charge.amountCents);
    return { idempotent: true, refund: publicRefund(claimed.refund), ...t };
  }

  // 2. Provider call outside any lock, to the original charge only.
  const { pr, charge } = claimed;
  let status: "SUCCEEDED" | "FAILED" | "UNKNOWN";
  let providerRefundRef: string | null = null;
  let failureMessage: string | null = null;
  try {
    const result = await paymentProvider.refund({ providerChargeRef: charge.providerChargeRef!, amountCents: claimed.refund.amountCents, idempotencyKey, aeRefundId: claimed.refund.id });
    providerRefundRef = result.providerRefundRef || null;
    if (result.status === "Succeeded") status = "SUCCEEDED";
    else if (result.status === "Failed") {
      status = "FAILED";
      failureMessage = sanitiseFailureMessage(result.failureReason ?? "Refund declined by the provider");
    } else status = "UNKNOWN";
  } catch (err) {
    if (err instanceof RefundRejectedError) {
      status = "FAILED";
      failureMessage = "Refund rejected by the provider";
    } else {
      status = "UNKNOWN"; // fixed text only; provider error text may carry references
      failureMessage = "No definite answer from the provider";
    }
  }

  // 3. Record the outcome (conditional on PENDING so a replay never double-writes).
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(financialCardRefunds)
      .set({ status, providerRefundRef, failureMessage, completedAt: status === "UNKNOWN" ? null : new Date() })
      .where(and(eq(financialCardRefunds.id, claimed.refund.id), eq(financialCardRefunds.status, "PENDING")))
      .returning();
    if (!row) {
      const [cur] = await tx.select().from(financialCardRefunds).where(eq(financialCardRefunds.id, claimed.refund.id));
      return cur!;
    }
    const event = status === "SUCCEEDED" ? "PC_FEE_CARD_REFUNDED" : status === "FAILED" ? "PC_FEE_CARD_REFUND_FAILED" : "PC_FEE_CARD_REFUND_UNKNOWN";
    await ledgerTx(tx, pr as FinancialPaymentRequest, event, actor, row.reason, { recoveryAction: "refund_card_charge", chargeId: charge.id, refundId: row.id, refundAmountCents: row.amountCents, status });
    await auditTx(tx, actor, `financial_card_refund_${status.toLowerCase()}`, pr as FinancialPaymentRequest, auditValue({ paymentRequestId: pr.id, chargeId: charge.id, refundId: row.id, status, providerReferenceRecorded: providerRefundRef != null }));
    return row;
  });
  if (updated.status === "SUCCEEDED") await syncReceiptsForPaymentRequest(pr.id);
  const t = await totals(db, charge.id, charge.amountCents);
  return { idempotent: false, refund: publicRefund(updated), ...t };
}

// ---------------------------------------------------------------------------
// Owner t181u phase 2b (G15): Brokerage Administrator resolution of an
// UNKNOWN card refund, mirroring card-charge resolution (N46/N47):
//   * read-only, namespaced mock provider status (lib/financial/cardRefundStatus.ts);
//   * the resolution must match the provider; no definite answer -> refused;
//   * the BA who requested the refund never resolves it;
//   * SUCCEEDED -> PC_FEE_CARD_REFUNDED + REFUND receipt; FAILED -> the
//     reserved amount is released (no receipt);
//   * idempotent (a replay of the applied resolution is 200 idempotent:true);
//   * never calls the provider refund again; value-free audit.
export type CardRefundResolution = "SUCCEEDED" | "FAILED";

async function peekRefund(actor: RecoveryActor, refundId: number) {
  if (!Number.isSafeInteger(refundId) || refundId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [row] = await db.select().from(financialCardRefunds).where(and(eq(financialCardRefunds.id, refundId), eq(financialCardRefunds.brokerageId, actor.brokerageId)));
  if (!row) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  return row;
}

/** BA work queue of card refunds (no provider or request keys). */
export async function listCardRefundsForBrokerage(brokerageId: number, status?: string) {
  const conds = [eq(financialCardRefunds.brokerageId, brokerageId)];
  if (status) conds.push(inArray(financialCardRefunds.status, [status]));
  const rows = await db.select().from(financialCardRefunds).where(and(...conds)).orderBy(desc(financialCardRefunds.id)).limit(200);
  return rows.map(publicRefund);
}

export async function cardRefundProviderStatusFor(actor: RecoveryActor, refundId: number) {
  const row = await peekRefund(actor, refundId);
  const providerStatus: CardRefundProviderStatus | null = row.status === "UNKNOWN" ? lookupCardRefundProviderStatus(row.idempotencyKey) : null;
  return {
    refundId: row.id,
    chargeId: row.cardChargeId,
    refundStatus: row.status,
    providerStatus,
    suggestedOutcome: providerStatus ? refundOutcomeForProviderStatus(providerStatus) : null,
    callerMayResolve: row.requestedByUserId !== actor.id,
  };
}

export async function resolveUnknownCardRefund(actor: RecoveryActor, refundId: number, outcome: CardRefundResolution, input: RecoveryInput) {
  const peek = await peekRefund(actor, refundId);
  if (peek.requestedByUserId === actor.id) {
    throw new RecoveryRefusal("CARD_REFUND_RESOLVER_IS_REQUESTER", "The person who requested this refund cannot resolve it; another Brokerage Administrator must.", peek.paymentRequestId);
  }
  // Read-only provider answer, outside any lock (mock only; anything else fails closed below).
  const providerStatus: CardRefundProviderStatus = peek.status === "UNKNOWN" ? lookupCardRefundProviderStatus(peek.idempotencyKey) : "Unavailable";
  const providerRef = peek.status === "UNKNOWN" ? mockRefundRefFor(peek.idempotencyKey) : null;

  const result = await db.transaction(async (tx) => {
    // Lock order: request, charge, refund (same as the refund path).
    const pr = await lockRequest(tx, actor, peek.paymentRequestId);
    await tx.select({ id: financialCardCharges.id }).from(financialCardCharges).where(eq(financialCardCharges.id, peek.cardChargeId)).for("update");
    const [row] = await tx.select().from(financialCardRefunds).where(eq(financialCardRefunds.id, peek.id)).for("update");
    if (!row || row.brokerageId !== actor.brokerageId) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
    if (row.status !== "UNKNOWN") {
      const events = await tx
        .select({ metadata: financialLedgerEvents.metadata })
        .from(financialLedgerEvents)
        .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(pr.id)), eq(financialLedgerEvents.eventType, "PC_FEE_CARD_REFUND_RESOLVED")));
      const byUs = events.find((e) => (e.metadata as { refundId?: number } | null)?.refundId === row.id);
      if (!byUs) throw new RecoveryRefusal("CARD_REFUND_NOT_UNKNOWN", "Only a refund with an UNKNOWN outcome is resolved here.", pr.id, pr.propertyId);
      if (row.status === outcome) return { idempotent: true as const, pr, refund: row };
      throw new RecoveryRefusal("CARD_REFUND_ALREADY_FINAL", "This refund has already been resolved.", pr.id, pr.propertyId);
    }
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    const expected = refundOutcomeForProviderStatus(providerStatus);
    if (expected == null) throw new RecoveryRefusal("CARD_REFUND_PROVIDER_STATUS_UNAVAILABLE", "The payment provider has no definite answer for this refund; it stays unresolved and reserved.", pr.id, pr.propertyId);
    if (expected !== outcome) throw new RecoveryRefusal("CARD_REFUND_OUTCOME_MISMATCH", `The payment provider reports this refund as ${providerStatus}; the resolution must match it.`, pr.id, pr.propertyId);
    const [updated] = await tx
      .update(financialCardRefunds)
      .set({
        status: outcome,
        providerRefundRef: outcome === "SUCCEEDED" ? (providerRef ?? row.providerRefundRef) : row.providerRefundRef,
        failureMessage: outcome === "FAILED" ? "Refund not taken by the provider (confirmed by a Brokerage Administrator)" : null,
        completedAt: new Date(),
      })
      .where(and(eq(financialCardRefunds.id, row.id), eq(financialCardRefunds.status, "UNKNOWN")))
      .returning();
    const meta = { recoveryAction: "resolve_card_refund", chargeId: row.cardChargeId, refundId: row.id, refundAmountCents: row.amountCents, status: outcome };
    // The same outcome events as the direct refund path, so receipts and the statement reconciliation see one source.
    await ledgerTx(tx, pr, outcome === "SUCCEEDED" ? "PC_FEE_CARD_REFUNDED" : "PC_FEE_CARD_REFUND_FAILED", actor, reason, meta);
    await ledgerTx(tx, pr, "PC_FEE_CARD_REFUND_RESOLVED", actor, reason, { ...meta, outcome, providerStatus, evidence });
    await auditTx(
      tx,
      actor,
      "financial_card_refund_resolved",
      pr,
      auditValue({ paymentRequestId: pr.id, chargeId: row.cardChargeId, refundId: row.id, outcome, providerStatus, statusBefore: "UNKNOWN", statusAfter: outcome }, evidence),
    );
    return { idempotent: false as const, pr, refund: updated! };
  });
  if (!result.idempotent && result.refund.status === "SUCCEEDED") await syncReceiptsForPaymentRequest(result.pr.id);
  const [charge] = await db.select({ amountCents: financialCardCharges.amountCents }).from(financialCardCharges).where(eq(financialCardCharges.id, result.refund.cardChargeId));
  const t = await totals(db, result.refund.cardChargeId, charge?.amountCents ?? 0);
  return { idempotent: result.idempotent, refund: publicRefund(result.refund), ...t, paymentRequestId: result.pr.id };
}
