// Owner t181u phase 2a item 5: automatic payment/refund reconciliation on
// settlement statements (gap G5).
//
// Design (fail closed, issued statements stay immutable): PAYMENT and REFUND
// entries are DERIVED ON READ for the ISSUED statement from the immutable
// financial_receipts of the PC service-fee requests the statement itemises,
// and cross-checked against the financial ledger. Nothing is written: no
// statement line, no new version, no status change (the 0041 trigger still
// refuses any line on an ISSUED statement). A correction remains the
// existing BA-only supersede flow and is never triggered from here.
// DRAFT and SUPERSEDED statements carry no reconciliation (null).
// Any inconsistency (ledger vs receipts, paid amount vs itemised fee, a
// receipt for a fee the statement does not itemise) sets NEEDS_REVIEW; the
// section never reports PAID/REFUNDED on inconsistent data.
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  financialLedgerEvents,
  financialPaymentRequests,
  financialReceipts,
  settlementStatementLines,
  type SettlementStatement,
  type SettlementStatementLine,
} from "@aee/db";

export type ReconciliationStatus = "UNPAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "NEEDS_REVIEW";
export interface ReconciliationEntry {
  kind: "PAYMENT" | "REFUND";
  effect: "CREDIT" | "DEBIT";
  amountCents: number;
  gstCents: number;
  paymentRequestId: number;
  receiptId: number;
  receiptNumber: string;
  paymentMethodType: string;
  paymentMethodLabel: string | null;
  issuedAt: Date;
}
export interface ReconciliationIssue {
  code: "LEDGER_RECEIPT_MISMATCH" | "PAYMENT_AMOUNT_MISMATCH" | "UNLISTED_RECEIPT" | "OVER_REFUNDED";
  paymentRequestId: number;
}
export interface StatementReconciliation {
  computed: true;
  persisted: false;
  basis: "receipts+ledger";
  asOf: string;
  statementId: number;
  statementVersion: number;
  status: ReconciliationStatus;
  entries: ReconciliationEntry[];
  totals: { itemisedServiceFeeCents: number; paidCents: number; refundedCents: number; netCollectedCents: number; balanceCents: number };
  issues: ReconciliationIssue[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function reconciliationForStatement(statement: SettlementStatement, lines?: SettlementStatementLine[]): Promise<StatementReconciliation | null> {
  if (statement.status !== "ISSUED") return null;
  const ls = lines ?? (await db.select().from(settlementStatementLines).where(eq(settlementStatementLines.statementId, statement.id)));
  const feeLines = ls.filter((l) => l.kind === "PC_SERVICE_FEE" && l.paymentRequestId != null);
  const itemised = new Map<number, number>();
  // The fee line is itemised ex-GST with its GST alongside; the payer is charged the GST-inclusive total.
  for (const l of feeLines) itemised.set(l.paymentRequestId!, (itemised.get(l.paymentRequestId!) ?? 0) + l.amountCents + l.gstCents);

  // Every PC fee request on this transaction (brokerage-scoped), so an unlisted payment is caught.
  const requests = await db
    .select({ id: financialPaymentRequests.id })
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.brokerageId, statement.brokerageId), eq(financialPaymentRequests.transactionId, statement.transactionId), eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE")));
  const requestIds = [...new Set([...requests.map((r) => r.id), ...itemised.keys()])];
  const receipts = requestIds.length
    ? await db
        .select()
        .from(financialReceipts)
        .where(and(eq(financialReceipts.brokerageId, statement.brokerageId), inArray(financialReceipts.paymentRequestId, requestIds), inArray(financialReceipts.kind, ["PAYMENT_SUCCEEDED", "REFUND"])))
        .orderBy(financialReceipts.issuedAt, financialReceipts.id)
    : [];
  const ledger = requestIds.length
    ? await db
        .select()
        .from(financialLedgerEvents)
        .where(
          and(
            eq(financialLedgerEvents.brokerageId, statement.brokerageId),
            eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"),
            inArray(financialLedgerEvents.sourceRecordId, requestIds.map(String)),
            inArray(financialLedgerEvents.eventType, ["PC_FEE_PAID", "PC_FEE_CARD_REFUNDED", "PC_FEE_PAYMENT_REVERSED"]),
          ),
        )
    : [];

  const issues: ReconciliationIssue[] = [];
  const entries: ReconciliationEntry[] = [];
  let paidCents = 0;
  let refundedCents = 0;
  for (const id of requestIds) {
    const rc = receipts.filter((r) => r.paymentRequestId === id);
    const le = ledger.filter((e) => e.sourceRecordId === String(id));
    if (!itemised.has(id)) {
      if (rc.length > 0) issues.push({ code: "UNLISTED_RECEIPT", paymentRequestId: id });
      continue;
    }
    const paidRc = rc.filter((r) => r.kind === "PAYMENT_SUCCEEDED");
    const cardRefundRc = rc.filter((r) => r.kind === "REFUND" && r.sourceType === "financial_card_refund");
    const reversalRc = rc.filter((r) => r.kind === "REFUND" && r.sourceType !== "financial_card_refund");
    const ledgerPaid = le.some((e) => e.eventType === "PC_FEE_PAID");
    const ledgerReversed = le.some((e) => e.eventType === "PC_FEE_PAYMENT_REVERSED");
    const ledgerCardRefunded = le.filter((e) => e.eventType === "PC_FEE_CARD_REFUNDED").reduce((s, e) => s + num((e.metadata as Record<string, unknown> | null)?.refundAmountCents), 0);
    const rcCardRefunded = cardRefundRc.reduce((s, r) => s + r.amountCents, 0);
    if (ledgerPaid !== paidRc.length > 0 || ledgerReversed !== reversalRc.length > 0 || ledgerCardRefunded !== rcCardRefunded || paidRc.length > 1) {
      issues.push({ code: "LEDGER_RECEIPT_MISMATCH", paymentRequestId: id });
    }
    const paid = paidRc.reduce((s, r) => s + r.amountCents, 0);
    const refunded = rcCardRefunded + reversalRc.reduce((s, r) => s + r.amountCents, 0);
    if (paid > 0 && paid !== itemised.get(id)) issues.push({ code: "PAYMENT_AMOUNT_MISMATCH", paymentRequestId: id });
    if (refunded > paid) issues.push({ code: "OVER_REFUNDED", paymentRequestId: id });
    paidCents += paid;
    refundedCents += refunded;
    for (const r of rc) {
      entries.push({
        kind: r.kind === "REFUND" ? "REFUND" : "PAYMENT",
        effect: r.kind === "REFUND" ? "DEBIT" : "CREDIT",
        amountCents: r.amountCents,
        gstCents: r.gstCents,
        paymentRequestId: id,
        receiptId: r.id,
        receiptNumber: r.receiptNumber,
        paymentMethodType: r.paymentMethodType,
        paymentMethodLabel: r.paymentMethodLabel,
        issuedAt: r.issuedAt,
      });
    }
  }
  entries.sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime() || a.receiptId - b.receiptId);
  const itemisedServiceFeeCents = [...itemised.values()].reduce((s, v) => s + v, 0);
  const netCollectedCents = paidCents - refundedCents;
  const status: ReconciliationStatus =
    issues.length > 0
      ? "NEEDS_REVIEW"
      : paidCents === 0
        ? "UNPAID"
        : refundedCents === 0
          ? "PAID"
          : refundedCents < paidCents
            ? "PARTIALLY_REFUNDED"
            : "REFUNDED";
  return {
    computed: true,
    persisted: false,
    basis: "receipts+ledger",
    asOf: new Date().toISOString(),
    statementId: statement.id,
    statementVersion: statement.version,
    status,
    entries,
    totals: { itemisedServiceFeeCents, paidCents, refundedCents, netCollectedCents, balanceCents: itemisedServiceFeeCents - netCollectedCents },
    issues,
  };
}
