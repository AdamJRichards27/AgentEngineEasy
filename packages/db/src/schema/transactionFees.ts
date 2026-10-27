// Owner t179u D4 + D9 (slice 2, migration 0040; independent of 0038's table).
//
// fee_schedule_versions: the AE administration fee schedule incorporated into
// the signed AE agent/brokerage agreement. Each agreed version is retained
// (never edited once ACTIVE; a new version supersedes) so historical fees can
// be recalculated and audited against the version that applied.
//
// transaction_fees: AE admin fees, settlement fees, adjustments and
// deductions on one transaction. Versioned (a correction is a new version
// that supersedes the approved one), Brokerage Administrator approval with
// separation of duties (approver is never the creator). An ADMIN_FEE must
// name the schedule version it was calculated from.
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, boolean, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";
import { documents } from "./documents";

export const FEE_SCHEDULE_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED"] as const;
export type FeeScheduleStatus = (typeof FEE_SCHEDULE_STATUSES)[number];

export const feeScheduleVersions = pgTable(
  "fee_schedule_versions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    /** Null = the brokerage's AE agreement; set = an individual agent's AE agreement. */
    agentUserId: integer("agent_user_id").references(() => users.id),
    version: integer("version").notNull(),
    status: text("status").notNull().default("DRAFT"),
    currency: text("currency").notNull().default("AUD"),
    adminFeeCents: integer("admin_fee_cents").notNull(),
    adminFeeGstApplicable: boolean("admin_fee_gst_applicable").notNull().default(true),
    gstRateBps: integer("gst_rate_bps").notNull().default(1000),
    /** The signed AE agreement this schedule is incorporated into. */
    signedAgreementDocumentId: integer("signed_agreement_document_id").references(() => documents.id),
    signedAgreementRef: text("signed_agreement_ref"),
    signedAt: timestamp("signed_at").notNull(),
    effectiveFrom: timestamp("effective_from").notNull(),
    effectiveTo: timestamp("effective_to"),
    supersedesId: integer("supersedes_id"),
    createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
    activatedByUserId: integer("activated_by_user_id").references(() => users.id),
    activatedAt: timestamp("activated_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    brokerageIdx: index("fee_schedule_versions_brokerage_idx").on(t.brokerageId, t.agentUserId, t.status),
    versionUnique: uniqueIndex("fee_schedule_versions_party_version_uq").on(t.brokerageId, sql`coalesce(${t.agentUserId}, 0)`, t.version),
    oneActive: uniqueIndex("fee_schedule_versions_one_active_uq").on(t.brokerageId, sql`coalesce(${t.agentUserId}, 0)`).where(sql`${t.status} = 'ACTIVE'`),
    statusCheck: check("fee_schedule_versions_status_check", sql`${t.status} in ('DRAFT', 'ACTIVE', 'SUPERSEDED')`),
    amountCheck: check("fee_schedule_versions_amount_check", sql`${t.adminFeeCents} >= 0 and ${t.gstRateBps} between 0 and 10000`),
    evidenceCheck: check(
      "fee_schedule_versions_evidence_check",
      sql`${t.signedAgreementDocumentId} is not null or length(btrim(coalesce(${t.signedAgreementRef}, ''))) > 0`,
    ),
    activationCheck: check(
      "fee_schedule_versions_activation_check",
      sql`(${t.status} = 'DRAFT') = (${t.activatedAt} is null) and (${t.activatedAt} is null) = (${t.activatedByUserId} is null)`,
    ),
    dutiesCheck: check("fee_schedule_versions_duties_check", sql`${t.activatedByUserId} is null or ${t.activatedByUserId} <> ${t.createdByUserId}`),
    effectiveCheck: check("fee_schedule_versions_effective_check", sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  }),
);
export type FeeScheduleVersion = typeof feeScheduleVersions.$inferSelect;

export const TRANSACTION_FEE_KINDS = ["ADMIN_FEE", "SETTLEMENT_FEE", "ADJUSTMENT", "DEDUCTION"] as const;
export type TransactionFeeKind = (typeof TRANSACTION_FEE_KINDS)[number];
export const TRANSACTION_FEE_STATUSES = ["DRAFT", "APPROVED", "CANCELLED", "SUPERSEDED"] as const;
export type TransactionFeeStatus = (typeof TRANSACTION_FEE_STATUSES)[number];

export const transactionFees = pgTable(
  "transaction_fees",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    kind: text("kind").notNull(),
    description: text("description").notNull(),
    /** ADJUSTMENT may be negative (a credit); every other kind is >= 0. */
    amountCents: integer("amount_cents").notNull(),
    gstCents: integer("gst_cents").notNull().default(0),
    currency: text("currency").notNull().default("AUD"),
    feeScheduleVersionId: integer("fee_schedule_version_id").references(() => feeScheduleVersions.id),
    status: text("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    supersedesId: integer("supersedes_id"),
    createdByUserId: integer("created_by_user_id").notNull().references(() => users.id),
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    cancelledByUserId: integer("cancelled_by_user_id").references(() => users.id),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    transactionIdx: index("transaction_fees_transaction_idx").on(t.transactionId, t.status),
    kindCheck: check("transaction_fees_kind_check", sql`${t.kind} in ('ADMIN_FEE', 'SETTLEMENT_FEE', 'ADJUSTMENT', 'DEDUCTION')`),
    statusCheck: check("transaction_fees_status_check", sql`${t.status} in ('DRAFT', 'APPROVED', 'CANCELLED', 'SUPERSEDED')`),
    amountCheck: check("transaction_fees_amount_check", sql`(${t.kind} = 'ADJUSTMENT' or ${t.amountCents} >= 0) and ${t.gstCents} >= 0`),
    descriptionCheck: check("transaction_fees_description_check", sql`length(btrim(${t.description})) > 0`),
    scheduleCheck: check("transaction_fees_schedule_check", sql`${t.kind} <> 'ADMIN_FEE' or ${t.feeScheduleVersionId} is not null`),
    approvalCheck: check("transaction_fees_approval_check", sql`(${t.approvedAt} is null) = (${t.approvedByUserId} is null)`),
    dutiesCheck: check("transaction_fees_duties_check", sql`${t.approvedByUserId} is null or ${t.approvedByUserId} <> ${t.createdByUserId}`),
    cancelCheck: check("transaction_fees_cancel_check", sql`(${t.status} = 'CANCELLED') = (${t.cancelledAt} is not null)`),
  }),
);
export type TransactionFee = typeof transactionFees.$inferSelect;
