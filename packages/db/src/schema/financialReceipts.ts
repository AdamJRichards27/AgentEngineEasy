// Owner t180u(2) (slice 5, migration 0042): receipts for the AE Pit Crew
// service fee. In-app + downloadable PDF only (D5, no email). One row per
// payment event: PAYMENT_SUCCEEDED, PAYMENT_FAILED (each failed attempt,
// with whether a retry is scheduled), REFUND (reversal) and RECONCILIATION
// (each reconciliation record). Immutable (trigger); deduplicated by
// dedup_key so a replayed webhook, sweep or retry never issues twice.
// Never holds card or bank data: payment_method_label is the label already
// stored on the payment method (e.g. "Visa ending 4242") or a generic
// "Direct debit mandate"; provider_reference is a charge / debit reference,
// never a token, mandate or account reference.
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";
import { financialPaymentRequests } from "./financial";
import { settlementStatements } from "./settlementStatements";

export const FINANCIAL_RECEIPT_KINDS = ["PAYMENT_SUCCEEDED", "PAYMENT_FAILED", "REFUND", "RECONCILIATION"] as const;
export type FinancialReceiptKind = (typeof FINANCIAL_RECEIPT_KINDS)[number];

export const financialReceipts = pgTable(
  "financial_receipts",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),
    settlementStatementId: integer("settlement_statement_id").references(() => settlementStatements.id),
    receiptNumber: text("receipt_number").notNull(),
    kind: text("kind").notNull(),
    statusSnapshot: text("status_snapshot").notNull(),
    amountCents: integer("amount_cents").notNull(),
    gstCents: integer("gst_cents").notNull().default(0),
    currency: text("currency").notNull().default("AUD"),
    paymentMethodType: text("payment_method_type").notNull(),
    paymentMethodLabel: text("payment_method_label"),
    payerType: text("payer_type").notNull(),
    payerUserId: integer("payer_user_id").references(() => users.id),
    payerBrokerageId: integer("payer_brokerage_id").references(() => brokerages.id),
    provider: text("provider"),
    providerReference: text("provider_reference"),
    attemptNo: integer("attempt_no"),
    failureMessage: text("failure_message"),
    retryScheduled: boolean("retry_scheduled").notNull().default(false),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    dedupKey: text("dedup_key").notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
  },
  (t) => ({
    receiptNumberUnique: uniqueIndex("financial_receipts_receipt_number_uq").on(t.receiptNumber),
    dedupUnique: uniqueIndex("financial_receipts_dedup_uq").on(t.dedupKey),
    requestIdx: index("financial_receipts_request_idx").on(t.paymentRequestId, t.issuedAt),
    transactionIdx: index("financial_receipts_transaction_idx").on(t.brokerageId, t.transactionId),
    kindCheck: check("financial_receipts_kind_check", sql`${t.kind} in ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'REFUND', 'RECONCILIATION')`),
    amountCheck: check("financial_receipts_amount_check", sql`${t.amountCents} >= 0 and ${t.gstCents} >= 0 and ${t.gstCents} <= ${t.amountCents}`),
    methodCheck: check("financial_receipts_method_check", sql`${t.paymentMethodType} in ('GENERAL_ACCOUNT_DEBIT_MANDATE', 'STORED_CARD')`),
    payerCheck: check(
      "financial_receipts_payer_check",
      sql`(${t.payerType} = 'Agent' and ${t.payerUserId} is not null) or (${t.payerType} = 'Brokerage' and ${t.payerBrokerageId} is not null)`,
    ),
    failureCheck: check("financial_receipts_failure_check", sql`${t.kind} = 'PAYMENT_FAILED' or (${t.failureMessage} is null and ${t.retryScheduled} = false)`),
  }),
);
export type FinancialReceipt = typeof financialReceipts.$inferSelect;
