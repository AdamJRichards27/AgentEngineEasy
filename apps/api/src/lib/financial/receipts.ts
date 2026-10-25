// Owner t180u(2) (slice 5): AE Pit Crew service-fee receipts. In-app and
// PDF only (D5). `syncReceiptsForPaymentRequest` is idempotent (dedup_key)
// and is called after every payment-request transition (provider webhook,
// outbox exhaustion, reversal, reconciliation evidence, stored-card charge)
// and again before any receipt read, so a missed hook can never lose a
// receipt and a replay can never duplicate one.
//
// Never stores card or bank data: the method label is the label already on
// the payment method ("Visa ending 4242") or "Direct debit mandate"; the
// provider reference is the debit/charge reference, never a token, mandate
// or account reference. Provider failure text is sanitised (long digit
// runs masked) and truncated.
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  financialCardRefunds,
  db,
  financialPaymentRequests,
  financialReceipts,
  financialReconciliations,
  paymentMethods,
  pcFeeAuthorities,
  pcFeeCalculations,
  settlementStatements,
  type FinancialPaymentRequest,
  type FinancialReceipt,
  type FinancialReceiptKind,
} from "@aee/db";
import { logger } from "@aee/events";
import { logAudit } from "../audit.js";
/** Same value as mockPaymentStatusSync.PAYMENT_REQUEST_SOURCE_RECORD_TYPE (inlined to avoid an import cycle). */
const PAYMENT_REQUEST_SOURCE_RECORD_TYPE = "financial_payment_request";

export const RECEIPT_POLICY = "t180u";

export function sanitiseFailureMessage(msg: string | null | undefined): string {
  const base = (msg ?? "Payment failed").replace(/\d[\d\s-]{5,}\d/g, "[redacted]").replace(/\s+/g, " ").trim();
  return base.slice(0, 200) || "Payment failed";
}

export interface ReceiptEventExtra {
  /** Stored-card attempts (slice 6) pass their own facts. */
  paymentMethodType?: "GENERAL_ACCOUNT_DEBIT_MANDATE" | "STORED_CARD";
  paymentMethodLabel?: string | null;
  payer?: { payerType: "Agent"; userId: number } | { payerType: "Brokerage"; brokerageId: number };
  provider?: string | null;
  providerReference?: string | null;
  attemptNo?: number | null;
  sourceType?: string;
  sourceId?: string;
}

interface Draft {
  kind: FinancialReceiptKind;
  dedupKey: string;
  statusSnapshot: string;
  amountCents: number;
  gstCents: number;
  failureMessage?: string | null;
  retryScheduled?: boolean;
  attemptNo?: number | null;
  sourceType: string;
  sourceId: string;
  providerReference?: string | null;
}

async function contextFor(req: FinancialPaymentRequest) {
  const [authority] = req.pcFeeAuthorityId ? await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, req.pcFeeAuthorityId)) : [];
  const [calc] = req.pcFeeCalculationId ? await db.select({ gstCents: pcFeeCalculations.gstCents }).from(pcFeeCalculations).where(eq(pcFeeCalculations.id, req.pcFeeCalculationId)) : [];
  const [statement] = await db
    .select({ id: settlementStatements.id })
    .from(settlementStatements)
    .where(and(eq(settlementStatements.transactionId, req.transactionId), eq(settlementStatements.status, "ISSUED")));
  // t180u(3): a stored-card receipt shows the label already stored on the nominated card ("Visa ending 4242"), nothing more.
  let cardLabel: string | null = null;
  if (authority?.authorisedPaymentMethod === "STORED_CARD" && authority.paymentMethodId != null) {
    const [pm] = await db.select({ label: paymentMethods.label }).from(paymentMethods).where(eq(paymentMethods.id, authority.paymentMethodId));
    cardLabel = pm?.label ?? "Saved card";
  }
  return { authority, cardLabel, gstCents: Math.min(calc?.gstCents ?? 0, req.amountCents), statementId: statement?.id ?? null };
}

/** Insert one receipt if its dedup key is new. Returns the row (new or existing). */
export async function issueReceipt(req: FinancialPaymentRequest, d: Draft, extra: ReceiptEventExtra = {}, actorUserId: number | null = null): Promise<FinancialReceipt> {
  const [existing] = await db.select().from(financialReceipts).where(eq(financialReceipts.dedupKey, d.dedupKey));
  if (existing) return existing;
  const ctx = await contextFor(req);
  const authorityPayer = ctx.authority?.payerType === "Brokerage" ? "Brokerage" : "Agent";
  const payer =
    extra.payer ??
    (authorityPayer === "Brokerage"
      ? { payerType: "Brokerage" as const, brokerageId: req.brokerageId }
      : { payerType: "Agent" as const, userId: req.payerUserId ?? ctx.authority?.agentUserId ?? 0 });
  const methodType = extra.paymentMethodType ?? ((ctx.authority?.authorisedPaymentMethod as "STORED_CARD" | undefined) === "STORED_CARD" ? "STORED_CARD" : "GENERAL_ACCOUNT_DEBIT_MANDATE");
  const receiptNumber = `AER-${req.id}-${createHash("sha256").update(d.dedupKey).digest("hex").slice(0, 10).toUpperCase()}`;
  const [row] = await db
    .insert(financialReceipts)
    .values({
      brokerageId: req.brokerageId,
      propertyId: req.propertyId,
      transactionId: req.transactionId,
      paymentRequestId: req.id,
      settlementStatementId: ctx.statementId,
      receiptNumber,
      kind: d.kind,
      statusSnapshot: d.statusSnapshot,
      amountCents: d.amountCents,
      gstCents: Math.min(d.gstCents, d.amountCents),
      currency: req.currency,
      paymentMethodType: methodType,
      paymentMethodLabel: extra.paymentMethodLabel ?? (methodType === "GENERAL_ACCOUNT_DEBIT_MANDATE" ? "Direct debit mandate (general account)" : ctx.cardLabel),
      payerType: payer.payerType,
      payerUserId: payer.payerType === "Agent" ? payer.userId : null,
      payerBrokerageId: payer.payerType === "Brokerage" ? payer.brokerageId : null,
      provider: extra.provider ?? req.provider ?? null,
      providerReference: d.providerReference ?? extra.providerReference ?? req.providerRequestRef ?? null,
      attemptNo: d.attemptNo ?? extra.attemptNo ?? null,
      failureMessage: d.kind === "PAYMENT_FAILED" ? sanitiseFailureMessage(d.failureMessage) : null,
      retryScheduled: d.kind === "PAYMENT_FAILED" ? Boolean(d.retryScheduled) : false,
      sourceType: extra.sourceType ?? d.sourceType,
      sourceId: extra.sourceId ?? d.sourceId,
      dedupKey: d.dedupKey,
    })
    .onConflictDoNothing({ target: financialReceipts.dedupKey })
    .returning();
  if (!row) {
    const [again] = await db.select().from(financialReceipts).where(eq(financialReceipts.dedupKey, d.dedupKey));
    return again!;
  }
  await logAudit({
    brokerageId: row.brokerageId,
    userId: actorUserId,
    action: "financial_receipt_issued",
    recordType: "financial_receipt",
    recordId: String(row.id),
    propertyId: row.propertyId,
    updatedValue: JSON.stringify({
      receiptNumber: row.receiptNumber,
      kind: row.kind,
      paymentRequestId: row.paymentRequestId,
      amountCents: row.amountCents,
      statusSnapshot: row.statusSnapshot,
      attemptNo: row.attemptNo,
      retryScheduled: row.retryScheduled,
      policy: RECEIPT_POLICY,
    }),
  });
  return row;
}

/** Derive and issue every receipt the payment request's current state implies. Idempotent; never throws. */
export async function syncReceiptsForPaymentRequest(paymentRequestId: number): Promise<FinancialReceipt[]> {
  try {
    const [req] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, paymentRequestId));
    if (!req || req.kind !== "PC_SUCCESS_FEE") return [];
    const out: FinancialReceipt[] = [];
    const { gstCents } = await contextFor(req);
    const src = { sourceType: "financial_payment_request", sourceId: String(req.id) };
    if (req.paidAt && ["PAID", "RECONCILED", "REVERSED"].includes(req.status)) {
      out.push(await issueReceipt(req, { kind: "PAYMENT_SUCCEEDED", dedupKey: `paid:${req.id}`, statusSnapshot: "PAID", amountCents: req.amountCents, gstCents, ...src }));
    }
    if (req.status === "RETRY_SCHEDULED" || req.status === "FAILED") {
      out.push(
        await issueReceipt(req, {
          kind: "PAYMENT_FAILED",
          dedupKey: `failed:${req.id}:${req.retryCount}:${req.status}`,
          statusSnapshot: req.status,
          amountCents: req.amountCents,
          gstCents,
          failureMessage: req.failureReason,
          retryScheduled: req.status === "RETRY_SCHEDULED",
          attemptNo: req.retryCount,
          ...src,
        }),
      );
    }
    if (req.status === "REVERSED") {
      out.push(await issueReceipt(req, { kind: "REFUND", dedupKey: `reversed:${req.id}`, statusSnapshot: "REVERSED", amountCents: req.amountCents, gstCents, ...src }));
    }
    // t181u phase 2a: one REFUND receipt per confirmed stored-card refund (partial refunds each get one).
    const cardRefunds = await db
      .select()
      .from(financialCardRefunds)
      .where(and(eq(financialCardRefunds.paymentRequestId, req.id), eq(financialCardRefunds.status, "SUCCEEDED")))
      .orderBy(financialCardRefunds.id);
    for (const r of cardRefunds) {
      out.push(
        await issueReceipt(
          req,
          {
            kind: "REFUND",
            dedupKey: `card-refund:${r.id}`,
            statusSnapshot: "REFUNDED",
            amountCents: r.amountCents,
            gstCents: req.amountCents > 0 ? Math.floor((gstCents * r.amountCents) / req.amountCents) : 0,
            sourceType: "financial_card_refund",
            sourceId: String(r.id),
            providerReference: r.providerRefundRef ?? null,
          },
          { paymentMethodType: "STORED_CARD" },
          r.requestedByUserId,
        ),
      );
    }
    const recons = await db
      .select()
      .from(financialReconciliations)
      .where(and(eq(financialReconciliations.brokerageId, req.brokerageId), eq(financialReconciliations.recordType, PAYMENT_REQUEST_SOURCE_RECORD_TYPE), eq(financialReconciliations.recordId, String(req.id))))
      .orderBy(financialReconciliations.id);
    for (const r of recons) {
      out.push(
        await issueReceipt(req, {
          kind: "RECONCILIATION",
          dedupKey: `reconciliation:${r.id}`,
          statusSnapshot: r.status,
          amountCents: Math.max(0, r.evidenceAmountCents ?? r.reportedAmountCents ?? 0),
          gstCents: 0,
          sourceType: "financial_reconciliation",
          sourceId: String(r.id),
          providerReference: r.externalReference ?? null,
        }),
      );
    }
    return out;
  } catch (err) {
    logger.error("financial_receipt_sync_failed", { paymentRequestId, error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function listReceiptsForTransaction(brokerageId: number, transactionId: number): Promise<FinancialReceipt[]> {
  return db
    .select()
    .from(financialReceipts)
    .where(and(eq(financialReceipts.brokerageId, brokerageId), eq(financialReceipts.transactionId, transactionId)))
    .orderBy(desc(financialReceipts.issuedAt), desc(financialReceipts.id));
}
