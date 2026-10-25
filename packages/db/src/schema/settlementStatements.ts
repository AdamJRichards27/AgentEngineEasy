// Owner t179u D1/D2 (slice 3, migration 0041): settlement statements.
//
// settlement_confirmations: the buyer's and the seller's legal
// representative's WRITTEN confirmation that settlement occurred, with
// evidence (a property document or a non-blank note). One ACTIVE per side;
// a correction supersedes (never edited, never deleted by the app).
//
// settlement_statements: versioned per transaction. DRAFT (lines derived
// server-side, regenerable) -> ISSUED (finalised and issued in one step;
// immutable, enforced by trigger) -> SUPERSEDED (by a later issued
// version). Issue by the assigned Pit Crew, the listing agent or a
// Brokerage Administrator, only when settlement is complete, both
// confirmations are on file, the re-derived lines still match and a payer
// is named. settlement_statement_lines are immutable once their statement
// leaves DRAFT.
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";
import { parties, properties } from "./property";
import { transactions } from "./transaction";
import { documents } from "./documents";
import { commissionCalculations, financialPaymentRequests } from "./financial";
import { transactionFees } from "./transactionFees";

export const SETTLEMENT_CONFIRMATION_SIDES = ["BUYER", "SELLER"] as const;
export type SettlementConfirmationSide = (typeof SETTLEMENT_CONFIRMATION_SIDES)[number];

export const settlementConfirmations = pgTable(
  "settlement_confirmations",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    side: text("side").notNull(),
    representativePartyId: integer("representative_party_id").notNull().references(() => parties.id),
    evidenceDocumentId: integer("evidence_document_id").references(() => documents.id),
    evidenceNote: text("evidence_note"),
    confirmedAt: timestamp("confirmed_at").notNull(),
    status: text("status").notNull().default("ACTIVE"),
    supersedesId: integer("supersedes_id"),
    recordedByUserId: integer("recorded_by_user_id").notNull().references(() => users.id),
    supersededAt: timestamp("superseded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    transactionIdx: index("settlement_confirmations_transaction_idx").on(t.transactionId, t.side),
    oneActive: uniqueIndex("settlement_confirmations_one_active_uq").on(t.transactionId, t.side).where(sql`${t.status} = 'ACTIVE'`),
    sideCheck: check("settlement_confirmations_side_check", sql`${t.side} in ('BUYER', 'SELLER')`),
    statusCheck: check("settlement_confirmations_status_check", sql`${t.status} in ('ACTIVE', 'SUPERSEDED')`),
    evidenceCheck: check(
      "settlement_confirmations_evidence_check",
      sql`${t.evidenceDocumentId} is not null or length(btrim(coalesce(${t.evidenceNote}, ''))) > 0`,
    ),
    supersededCheck: check("settlement_confirmations_superseded_check", sql`(${t.status} = 'SUPERSEDED') = (${t.supersededAt} is not null)`),
  }),
);
export type SettlementConfirmation = typeof settlementConfirmations.$inferSelect;

export const SETTLEMENT_STATEMENT_STATUSES = ["DRAFT", "ISSUED", "SUPERSEDED"] as const;
export type SettlementStatementStatus = (typeof SETTLEMENT_STATEMENT_STATUSES)[number];
export const SETTLEMENT_STATEMENT_PAYER_TYPES = ["Agent", "Brokerage"] as const;
export type SettlementStatementPayerType = (typeof SETTLEMENT_STATEMENT_PAYER_TYPES)[number];

export const settlementStatements = pgTable(
  "settlement_statements",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("DRAFT"),
    supersedesId: integer("supersedes_id"),
    supersedeReason: text("supersede_reason"),
    payerType: text("payer_type").notNull(),
    payerUserId: integer("payer_user_id").references(() => users.id),
    payerBrokerageId: integer("payer_brokerage_id").references(() => brokerages.id),
    currency: text("currency").notNull().default("AUD"),
    creditsCents: integer("credits_cents").notNull().default(0),
    debitsCents: integer("debits_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    pcServiceFeeCents: integer("pc_service_fee_cents"),
    linesFingerprint: text("lines_fingerprint").notNull(),
    preparedByUserId: integer("prepared_by_user_id").notNull().references(() => users.id),
    preparedAt: timestamp("prepared_at").notNull().defaultNow(),
    issuedByUserId: integer("issued_by_user_id").references(() => users.id),
    issuedAt: timestamp("issued_at"),
    buyerConfirmationId: integer("buyer_confirmation_id").references(() => settlementConfirmations.id),
    sellerConfirmationId: integer("seller_confirmation_id").references(() => settlementConfirmations.id),
    supersededAt: timestamp("superseded_at"),
    supersededByUserId: integer("superseded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    versionUnique: uniqueIndex("settlement_statements_transaction_version_uq").on(t.transactionId, t.version),
    oneDraft: uniqueIndex("settlement_statements_one_draft_uq").on(t.transactionId).where(sql`${t.status} = 'DRAFT'`),
    oneIssued: uniqueIndex("settlement_statements_one_issued_uq").on(t.transactionId).where(sql`${t.status} = 'ISSUED'`),
    brokerageIdx: index("settlement_statements_brokerage_idx").on(t.brokerageId, t.status),
    statusCheck: check("settlement_statements_status_check", sql`${t.status} in ('DRAFT', 'ISSUED', 'SUPERSEDED')`),
    payerCheck: check(
      "settlement_statements_payer_check",
      sql`(${t.payerType} = 'Agent' and ${t.payerUserId} is not null and ${t.payerBrokerageId} is null) or (${t.payerType} = 'Brokerage' and ${t.payerBrokerageId} is not null and ${t.payerUserId} is null)`,
    ),
    totalsCheck: check(
      "settlement_statements_totals_check",
      sql`${t.creditsCents} >= 0 and ${t.debitsCents} >= 0 and ${t.netCents} = ${t.creditsCents} - ${t.debitsCents} and (${t.pcServiceFeeCents} is null or ${t.pcServiceFeeCents} >= 0)`,
    ),
    issuedCheck: check(
      "settlement_statements_issued_check",
      sql`(${t.status} = 'DRAFT') = (${t.issuedAt} is null) and (${t.issuedAt} is null) = (${t.issuedByUserId} is null) and (${t.status} = 'DRAFT' or (${t.buyerConfirmationId} is not null and ${t.sellerConfirmationId} is not null))`,
    ),
    supersededCheck: check(
      "settlement_statements_superseded_check",
      sql`(${t.status} = 'SUPERSEDED') = (${t.supersededAt} is not null) and (${t.supersededAt} is null) = (${t.supersededByUserId} is null)`,
    ),
  }),
);
export type SettlementStatement = typeof settlementStatements.$inferSelect;

export const SETTLEMENT_STATEMENT_LINE_KINDS = [
  "COMMISSION",
  "COMMISSION_GST",
  "MARKETING",
  "AE_ADMIN_FEE",
  "SETTLEMENT_FEE",
  "PC_SERVICE_FEE",
  "ADJUSTMENT",
  "DEDUCTION",
  "PAYMENT",
  "REFUND",
] as const;
export type SettlementStatementLineKind = (typeof SETTLEMENT_STATEMENT_LINE_KINDS)[number];

export const settlementStatementLines = pgTable(
  "settlement_statement_lines",
  {
    id: serial("id").primaryKey(),
    statementId: integer("statement_id")
      .notNull()
      .references(() => settlementStatements.id, { onDelete: "cascade" }),
    lineNo: integer("line_no").notNull(),
    kind: text("kind").notNull(),
    effect: text("effect").notNull(),
    description: text("description").notNull(),
    amountCents: integer("amount_cents").notNull(),
    gstCents: integer("gst_cents").notNull().default(0),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    commissionCalculationId: integer("commission_calculation_id").references(() => commissionCalculations.id),
    transactionFeeId: integer("transaction_fee_id").references(() => transactionFees.id),
    paymentRequestId: integer("payment_request_id").references(() => financialPaymentRequests.id),
  },
  (t) => ({
    lineUnique: uniqueIndex("settlement_statement_lines_statement_line_uq").on(t.statementId, t.lineNo),
    kindCheck: check(
      "settlement_statement_lines_kind_check",
      sql`${t.kind} in ('COMMISSION', 'COMMISSION_GST', 'MARKETING', 'AE_ADMIN_FEE', 'SETTLEMENT_FEE', 'PC_SERVICE_FEE', 'ADJUSTMENT', 'DEDUCTION', 'PAYMENT', 'REFUND')`,
    ),
    effectCheck: check("settlement_statement_lines_effect_check", sql`${t.effect} in ('CREDIT', 'DEBIT')`),
    amountCheck: check("settlement_statement_lines_amount_check", sql`${t.amountCents} >= 0 and ${t.gstCents} >= 0`),
    descriptionCheck: check("settlement_statement_lines_description_check", sql`length(btrim(${t.description})) > 0`),
    sourceCheck: check(
      "settlement_statement_lines_source_check",
      sql`(${t.kind} <> 'PC_SERVICE_FEE' or ${t.paymentRequestId} is not null) and (${t.kind} not in ('COMMISSION', 'COMMISSION_GST') or ${t.commissionCalculationId} is not null) and (${t.kind} not in ('AE_ADMIN_FEE', 'SETTLEMENT_FEE', 'ADJUSTMENT', 'DEDUCTION') or ${t.transactionFeeId} is not null)`,
    ),
  }),
);
export type SettlementStatementLine = typeof settlementStatementLines.$inferSelect;
