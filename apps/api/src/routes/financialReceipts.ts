// Owner t180u(2) (slice 5): in-app + downloadable PDF receipts for the AE
// Pit Crew service fee (D5: no email). Readable by the Brokerage
// Administrator, the listing agent and assigned Pit Crew (same rule as the
// other transaction financials); everyone else 404. Every read first runs
// the idempotent receipt sync so a missed hook cannot hide a receipt.
import { Router } from "express";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { db, financialLedgerEvents, financialPaymentRequests, financialReceipts, type FinancialReceipt } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logAudit } from "../lib/audit.js";
import { listReceiptsForTransaction, RECEIPT_POLICY, sanitiseFailureMessage, syncReceiptsForPaymentRequest, withStatementLinks } from "../lib/financial/receipts.js";
import { renderReceiptPdf } from "../lib/financial/receiptPdf.js";
import { canReadTransactionFinancials } from "./financialFees.js";

export const financialReceiptsRouter = Router();
const reader = [requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES, "Agent", ...PIT_CREW_ROLES), requireEntitlement("run.access")] as const;

const KIND_LABEL: Record<string, string> = {
  PAYMENT_SUCCEEDED: "Payment receipt",
  PAYMENT_FAILED: "Failed payment notice",
  REFUND: "Refund receipt",
  RECONCILIATION: "Reconciliation receipt",
};
const money = (cents: number, currency: string) => `${currency} ${(cents / 100).toFixed(2)}`;
const aest = (d: Date) => `${d.toLocaleString("en-AU", { timeZone: "Australia/Brisbane", hour12: false })} AEST`;

async function syncTransaction(brokerageId: number, transactionId: number) {
  const reqs = await db
    .select({ id: financialPaymentRequests.id })
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.brokerageId, brokerageId), eq(financialPaymentRequests.transactionId, transactionId)));
  for (const r of reqs) await syncReceiptsForPaymentRequest(r.id);
}

// Owner t183u item 2: waivers and write-offs are adjustments, not receipt activity. Their ledger events
// (the formal adjustment records) are kept out of every receipt view (detail history and PDF) and are
// read from GET /financial/payment-requests/:id/adjustments instead.
const ADJUSTMENT_EVENT_TYPES = ["PC_FEE_WAIVED", "PC_FEE_WRITTEN_OFF"];

async function historyFor(receipt: FinancialReceipt) {
  const rows = await db
    .select()
    .from(financialLedgerEvents)
    .where(
      and(
        eq(financialLedgerEvents.brokerageId, receipt.brokerageId),
        inArray(financialLedgerEvents.sourceRecordType, ["PAYMENT_REQUEST", "financial_payment_request"]),
        eq(financialLedgerEvents.sourceRecordId, String(receipt.paymentRequestId)),
        notInArray(financialLedgerEvents.eventType, ADJUSTMENT_EVENT_TYPES),
      ),
    )
    .orderBy(asc(financialLedgerEvents.id));
  return rows.map((e) => ({ eventType: e.eventType, at: e.occurredAt, amountCents: e.amountCents, reason: e.reason ? sanitiseFailureMessage(e.reason) : null }));
}

async function loadReadable(req: { authedUser?: { id: number; role: string; brokerageId: number } }, id: number) {
  const user = req.authedUser!;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [receipt] = await db.select().from(financialReceipts).where(and(eq(financialReceipts.id, id), eq(financialReceipts.brokerageId, user.brokerageId)));
  if (!receipt) return null;
  const access = await canReadTransactionFinancials(user as never, receipt.transactionId);
  return access ? receipt : null;
}

financialReceiptsRouter.get("/financial/receipts", ...reader, async (req, res) => {
  const user = req.authedUser!;
  const access = await canReadTransactionFinancials(user, Number(req.query.transactionId));
  if (!access) return void res.status(404).json({ error: "Not found" });
  await syncTransaction(user.brokerageId, access.transactionId);
  res.json({ receipts: await withStatementLinks(await listReceiptsForTransaction(user.brokerageId, access.transactionId)) });
});

financialReceiptsRouter.get("/financial/receipts/:id", ...reader, async (req, res) => {
  const receipt = await loadReadable(req, Number(req.params.id));
  if (!receipt) return void res.status(404).json({ error: "Not found" });
  const [linked] = await withStatementLinks([receipt]);
  res.json({ receipt: linked, history: await historyFor(receipt) });
});

financialReceiptsRouter.get("/financial/receipts/:id/pdf", ...reader, async (req, res) => {
  const user = req.authedUser!;
  const receipt = await loadReadable(req, Number(req.params.id));
  if (!receipt) return void res.status(404).json({ error: "Not found" });
  const history = await historyFor(receipt);
  const [{ settlementStatement: st }] = await withStatementLinks([receipt]);
  const lines: Array<[string, string]> = [
    ["Receipt number", receipt.receiptNumber],
    ["Issued", aest(receipt.issuedAt)],
    ["Status", receipt.statusSnapshot],
    ["Amount (incl. GST)", money(receipt.amountCents, receipt.currency)],
    ["GST", money(receipt.gstCents, receipt.currency)],
    ["For", "AE Pit Crew service fee"],
    ["Transaction", `#${receipt.transactionId} (property #${receipt.propertyId})`],
    ["Settlement statement", st ? `#${st.id} version ${st.version}` : receipt.settlementStatementId ? `#${receipt.settlementStatementId}` : "-"],
    ["Payment request", `#${receipt.paymentRequestId}`],
    ["Payer", receipt.payerType === "Brokerage" ? `Brokerage #${receipt.payerBrokerageId}` : `Agent #${receipt.payerUserId}`],
    ["Payment method", receipt.paymentMethodLabel ?? receipt.paymentMethodType],
    ["Payment reference", receipt.providerReference ?? "-"],
  ];
  if (receipt.attemptNo != null) lines.push(["Attempt", String(receipt.attemptNo)]);
  if (receipt.kind === "PAYMENT_FAILED") {
    lines.push(["Failure", receipt.failureMessage ?? "Payment failed"]);
    lines.push(["Next step", receipt.retryScheduled ? "A controlled retry is scheduled; you will not be charged twice." : "No automatic retry. A Brokerage Administrator will follow up."]);
  }
  const pdf = renderReceiptPdf({
    title: `Agent Engine - ${KIND_LABEL[receipt.kind] ?? "Receipt"}`,
    lines,
    history: history.map((h) => `${aest(h.at)}  ${h.eventType}${h.amountCents != null ? `  ${money(h.amountCents, receipt.currency)}` : ""}${h.reason ? `  ${h.reason}` : ""}`),
    footer: "Issued in-app by Agent Engine. AE does not hold trust or client money. Synthetic environment.",
  });
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "financial_receipt_downloaded",
    recordType: "financial_receipt",
    recordId: String(receipt.id),
    propertyId: receipt.propertyId,
    updatedValue: JSON.stringify({ receiptNumber: receipt.receiptNumber, format: "pdf", policy: RECEIPT_POLICY }),
  });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${receipt.receiptNumber}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(pdf);
});
