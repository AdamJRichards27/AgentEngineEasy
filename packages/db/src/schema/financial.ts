// Agent Engine 2.0 — Financial Transaction Engine (Priority 9).
//
// AE's financial CONTROL AND EVIDENCE layer for a property transaction —
// deliberately not a trust-account ledger, not a bank, not a payment
// processor, not a general ledger, and not licensed trust-accounting
// software. Every table here answers some part of: what money is
// expected, what has been authorised, what has been reported/recorded,
// what evidence supports it, and what remains outstanding.
//
// Deliberately reused rather than duplicated (mandatory starting
// procedure, Priority 9 spec Section 2 item 9):
//   - agencyAgreementTerms (documents.ts) stays exactly as-is: the
//     single-row, pre-listing, editable-in-place commission terms capture
//     it always was. commissionAgreements below is the NEW, versioned,
//     transaction-scoped, approval-gated record the code comment on
//     agencyAgreementTerms itself already earmarked ("real negotiation/
//     version history belongs to the Transaction once one exists") — it
//     can be *seeded* from agencyAgreementTerms's captured rate/fee, but
//     is its own append-only-versioned lifecycle from there.
//   - transactions.grossCommissionCents/gstCents/commissionCalculatedAt/
//     fundsReceivedCents/fundsReceivedAt/agentPaidAt (transaction.ts) are
//     UNCHANGED. lib/transactions.ts's calculateCommission()/
//     recordFundsReceived()/recordAgentPaid() keep working exactly as
//     before for their existing callers (workflowSteps.ts, homeSummary.ts,
//     timeline.ts, PropertyWorkspace.tsx). This build's finalisation step
//     (lib/financial/settlement.ts) additionally writes the richer,
//     versioned commissionCalculations result back onto those same
//     transactions columns once a commissionAgreement exists and is
//     APPROVED, so every existing reader sees the more accurate number
//     without needing to change — but it never requires an agreement to
//     exist, so a transaction with no financial engine data yet keeps
//     behaving exactly as the legacy flat calculation always has.
//   - Launch's launchPlans.budgetCents/budgetSpentCents and
//     campaignItems.costCents/vendorApprovals stay the single source of
//     truth for marketing budget/spend/approval. marketingPaymentRecords
//     below is a thin overlay (one optional row per campaignItem, exactly
//     mirroring pit_crew_assignments' proven "overlay table on an existing
//     table" pattern) that adds ONLY invoice/payment/reconciliation
//     status — never a second budget or cost figure.
//   - riskExceptions (exceptions.ts) stays the one exception system —
//     financial findings get a new "FINANCIAL" category (additive text
//     value, no migration) and reuse RISK_EXCEPTION_OWNER_TYPES/severities
//     unchanged, per Section 22.
//   - auditLogs (audit.ts) is still called via logAudit() for every
//     sensitive mutation, exactly as every other domain in this app does.
//     financialLedgerEvents below is additionally domain-specific
//     (amounts, calculation versions, rule versions) in the same way
//     riskExceptionTransitions/launchPlanTransitions are additionally
//     domain-specific over the generic auditLogs table.
//
// Money: integer cents throughout (commerce.ts/transaction.ts/launch.ts
// convention) — never a float. Rates: integer basis points
// (agencyAgreementTerms.commissionRateBps convention), e.g. 690 = 6.90%.
// GST: AU 10% (GST_RATE_BPS = 1000, transactions.ts's existing constant)
// is the default, but every calculation snapshot records the exact bps
// used — never assumed silently at read time — and the rate itself lives
// in brokerage-level financialSettings, not hardcoded a second time here.
//
// Custody boundary (Section 3): nothing in this file represents AE as
// holding, transferring, or disbursing money. "ExternalHolder"/
// "reported"/"evidence"/"reconciled" language is used throughout —
// never "held"/"AE trust balance"/"disbursed by AE".

import { pgTable, serial, integer, text, boolean, jsonb, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";
import { paymentMethods } from "./commerce";

// ---------------------------------------------------------------------
// Shared vocabularies
// ---------------------------------------------------------------------

export interface CommissionTier {
  upToCents: number | null;
  rateBps: number;
}

export interface RoundingAdjustment {
  step: string;
  exactCents: number;
  roundedCents: number;
  adjustmentCents: number;
}

export const COMMISSION_METHODS = ["FIXED_AMOUNT", "PERCENTAGE", "TIERED", "MANUAL_WITH_REASON"] as const;
export type CommissionMethod = (typeof COMMISSION_METHODS)[number];

export const COMMISSION_AGREEMENT_STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "SUPERSEDED", "CANCELLED"] as const;
export type CommissionAgreementStatus = (typeof COMMISSION_AGREEMENT_STATUSES)[number];

// Section 11: distinct financial-snapshot states, applied to both
// commissionCalculations and pcFeeCalculations.
export const FINANCIAL_SNAPSHOT_STATES = ["ESTIMATE", "PROVISIONAL", "CONFIRMED", "FINALISED", "SUPERSEDED"] as const;
export type FinancialSnapshotState = (typeof FINANCIAL_SNAPSHOT_STATES)[number];

export const PC_FEE_BASES = ["PERCENTAGE_OF_GCI", "FIXED_AMOUNT", "NONE", "MANUAL_WITH_REASON"] as const;
export type PcFeeBasis = (typeof PC_FEE_BASES)[number];

export const PC_FEE_AUTHORITY_PAYMENT_METHODS = ["GENERAL_ACCOUNT_DEBIT_MANDATE", "STORED_CARD"] as const;
export type PcFeeAuthorityPaymentMethod = (typeof PC_FEE_AUTHORITY_PAYMENT_METHODS)[number];
export const PC_FEE_AUTHORITY_PAYER_TYPES = ["Agent", "Brokerage"] as const;
export type PcFeeAuthorityPayerType = (typeof PC_FEE_AUTHORITY_PAYER_TYPES)[number];

export const PC_FEE_AUTHORITY_STATUSES = ["NOT_PROVIDED", "PENDING", "ACTIVE", "EXPIRED", "REVOKED", "REPLACED", "INVALID"] as const;
export type PcFeeAuthorityStatus = (typeof PC_FEE_AUTHORITY_STATUSES)[number];

// Section 15: the PC fee payment lifecycle. Reused as-is (not re-declared)
// by financialPaymentRequests.status for any future non-PC payment request
// this table also ends up carrying — the vocabulary is generic enough.
export const PAYMENT_REQUEST_STATUSES = [
  "NOT_CALCULATED",
  "ESTIMATED",
  "CALCULATED",
  "AWAITING_AUTHORITY",
  "READY_TO_INVOICE",
  "INVOICED",
  "NOTICE_SENT",
  "DEBIT_SCHEDULED",
  "PROCESSING",
  "PAID",
  "FAILED",
  "RETRY_SCHEDULED",
  "DISPUTED",
  "WAIVED",
  "REVERSED",
  "WRITTEN_OFF",
  "RECONCILED",
] as const;
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number];

export const PAYMENT_REQUEST_KINDS = ["PC_SUCCESS_FEE"] as const; // extensible: kept singular-purpose for this build
export type PaymentRequestKind = (typeof PAYMENT_REQUEST_KINDS)[number];

// Stage D (Section 31): the durable payment outbox's own action/status
// vocabulary — distinct from PAYMENT_REQUEST_STATUSES above. A payment
// request's status describes the PC success fee's business lifecycle; an
// outbox row describes the narrower, mechanical question of whether ONE
// specific call to the external provider has been reliably delivered yet.
export const OUTBOX_ACTIONS = ["SCHEDULE_DEBIT", "CANCEL_DEBIT", "REVERSE_DEBIT"] as const;
export type OutboxAction = (typeof OUTBOX_ACTIONS)[number];

export const OUTBOX_STATUSES = ["PENDING", "DISPATCHED", "FAILED", "CANCELLED"] as const; // CANCELLED: t212u item 4, provider-confirmed cancellation of pending retries
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DISPUTE_STATUSES = ["OPEN", "UNDER_REVIEW", "RESOLVED_PAYABLE", "RESOLVED_ADJUSTED", "RESOLVED_WAIVED", "CLOSED"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

// Section 18: deposit tracking is informational/evidentiary — never a
// trust-account ledger. Every status name below deliberately says
// "reported"/"evidence" rather than implying AE custody.
export const DEPOSIT_STATUSES = [
  "NOT_REQUIRED",
  "EXPECTED",
  "DUE",
  "REPORTED_PART_RECEIVED",
  "REPORTED_RECEIVED",
  "EVIDENCE_RECEIVED",
  "RECONCILED_EXTERNALLY",
  "REPORTED_RELEASED",
  "DISPUTED",
  "UNKNOWN",
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

export const RECONCILIATION_STATUSES = ["NOT_REQUIRED", "UNRECONCILED", "PARTIALLY_RECONCILED", "RECONCILED", "VARIANCE", "DISPUTED"] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

// What a reconciliation or a ledger event is about — polymorphic pointer,
// mirroring riskExceptions.sourceRecordType/sourceRecordId exactly.
//
// LEGACY_TRANSACTION_COMMISSION (Financial Transaction Engine Verification,
// Step 2, COHERENCE-001 remediation): a legacy transactions.grossCommissionCents
// figure that predates this brokerage's first commissionAgreement/
// commissionCalculation row and therefore has no Financial Engine record to
// reconcile against. Added additively (this is a `text` column, not a
// Postgres enum type, so no migration is required) — see
// lib/financial/legacyReconciliation.ts's module header for the full
// rationale and lib/financial/queries.ts's getPropertyFinancialSummary for
// where it surfaces.
export const FINANCIAL_RECORD_TYPES = [
  "COMMISSION_AGREEMENT",
  "COMMISSION_CALCULATION",
  "PC_FEE_AUTHORITY",
  "PC_FEE_CALCULATION",
  "PAYMENT_REQUEST",
  "MARKETING_PAYMENT_RECORD",
  "DEPOSIT",
  "LEGACY_TRANSACTION_COMMISSION",
] as const;
export type FinancialRecordType = (typeof FINANCIAL_RECORD_TYPES)[number];

export const MARKETING_EXPENSE_STATUSES = ["PLANNED", "AUTHORISED", "INVOICED", "REPORTED_PAID", "RECONCILED", "DISPUTED", "CANCELLED"] as const;
export type MarketingExpenseStatus = (typeof MARKETING_EXPENSE_STATUSES)[number];

// ---------------------------------------------------------------------
// A. Commission agreement (Section 9) — versioned, per transaction.
// ---------------------------------------------------------------------

export const commissionAgreements = pgTable(
  "commission_agreements",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),

    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("DRAFT"),
    // Every prior version stays exactly as it was approved — a new version
    // never edits an approved-and-used row in place (Section 9).
    supersedesId: integer("supersedes_id"),

    currency: text("currency").notNull().default("AUD"),
    method: text("method").notNull(), // COMMISSION_METHODS

    rateBps: integer("rate_bps"), // used by PERCENTAGE
    fixedAmountCents: integer("fixed_amount_cents"), // used by FIXED_AMOUNT
    // TIERED: [{ upToCents: number | null, rateBps: number }], evaluated in
    // order; upToCents: null means "and above". MANUAL_WITH_REASON stores
    // its resulting amount directly in fixedAmountCents plus manualReason.
    tiers: jsonb("tiers").$type<CommissionTier[]>(),
    minimumAmountCents: integer("minimum_amount_cents"),
    manualReason: text("manual_reason"),

    gstApplicable: boolean("gst_applicable").notNull().default(true),
    gstRateBps: integer("gst_rate_bps").notNull().default(1000), // AU 10%, transactions.ts's existing GST_RATE_BPS convention

    referralFeeCents: integer("referral_fee_cents").notNull().default(0),
    brokerageSplitBps: integer("brokerage_split_bps"), // of commission ex-GST after referral; null = not split
    agentSplitBps: integer("agent_split_bps"),

    // Seed provenance — which agencyAgreementTerms row (if any) this
    // agreement's initial draft was populated from. Never re-read live:
    // a later edit to agencyAgreementTerms must not retroactively change
    // an already-drafted/approved commission agreement.
    seededFromAgencyAgreementTermsId: integer("seeded_from_agency_agreement_terms_id"),

    sourceDocumentRef: text("source_document_ref"), // e.g. a documents.id or free-text reference

    effectiveDate: timestamp("effective_date"),
    approvedByUserId: integer("approved_by_user_id").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    cancelledByUserId: integer("cancelled_by_user_id").references(() => users.id),
    cancelledAt: timestamp("cancelled_at"),
    cancelReason: text("cancel_reason"),

    notes: text("notes"),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    transactionVersionIdx: uniqueIndex("commission_agreements_transaction_version_idx").on(table.transactionId, table.version),
    transactionStatusIdx: index("commission_agreements_transaction_status_idx").on(table.transactionId, table.status),
    brokerageStatusIdx: index("commission_agreements_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

// ---------------------------------------------------------------------
// B. Commission calculation snapshots (Sections 10-11) — deterministic,
//    immutable once written; a correction always supersedes, never edits.
// ---------------------------------------------------------------------

export const commissionCalculations = pgTable(
  "commission_calculations",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    commissionAgreementId: integer("commission_agreement_id").notNull().references(() => commissionAgreements.id),

    calculationVersion: integer("calculation_version").notNull().default(1),
    state: text("state").notNull().default("ESTIMATE"), // FINANCIAL_SNAPSHOT_STATES
    supersedesId: integer("supersedes_id"),
    supersededReason: text("superseded_reason"),

    // Inputs, snapshotted (never re-derived from a possibly-since-changed
    // transaction row) so a stored calculation is fully self-explaining.
    salePriceCentsInput: integer("sale_price_cents_input").notNull(),
    methodUsed: text("method_used").notNull(),
    rateBpsUsed: integer("rate_bps_used"),
    tiersUsed: jsonb("tiers_used").$type<CommissionTier[]>(),

    grossCommissionCents: integer("gross_commission_cents").notNull(),
    minimumAppliedCents: integer("minimum_applied_cents"), // set only when the minimum overrode the formula result
    referralFeeCents: integer("referral_fee_cents").notNull().default(0),
    commissionExGstCents: integer("commission_ex_gst_cents").notNull(),
    gstCents: integer("gst_cents").notNull().default(0),
    gstRateBpsUsed: integer("gst_rate_bps_used").notNull().default(1000),

    brokerageComponentCents: integer("brokerage_component_cents"),
    agentComponentCents: integer("agent_component_cents"),

    // Deterministic-rounding evidence (Section 8/10): every cents-level
    // rounding adjustment this calculation made, so the total is always
    // traceable back to its unrounded inputs.
    roundingAdjustments: jsonb("rounding_adjustments").$type<RoundingAdjustment[]>().notNull().default(sql`'[]'::jsonb`),

    calculationRuleVersion: integer("calculation_rule_version").notNull().default(1),

    calculatedByUserId: integer("calculated_by_user_id").references(() => users.id),
    calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
    finalisedAt: timestamp("finalised_at"),

    correlationId: text("correlation_id"),
  },
  (table) => ({
    transactionVersionIdx: uniqueIndex("commission_calculations_transaction_version_idx").on(table.transactionId, table.calculationVersion),
    transactionStateIdx: index("commission_calculations_transaction_state_idx").on(table.transactionId, table.state),
    brokerageIdx: index("commission_calculations_brokerage_idx").on(table.brokerageId, table.calculatedAt),
  }),
);

// ---------------------------------------------------------------------
// C. PC success-fee: authority (Sections 13-14) + calculation (Section 12)
// ---------------------------------------------------------------------

export const pcFeeAuthorities = pgTable(
  "pc_fee_authorities",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    agentUserId: integer("agent_user_id").notNull().references(() => users.id),

    version: integer("version").notNull().default(1),
    supersedesId: integer("supersedes_id"),
    status: text("status").notNull().default("NOT_PROVIDED"), // PC_FEE_AUTHORITY_STATUSES

    feeBasis: text("fee_basis").notNull().default("PERCENTAGE_OF_GCI"), // PC_FEE_BASES
    rateBps: integer("rate_bps"), // e.g. 690 = 6.90% — the current business default, but always configurable/stored, never hardcoded
    fixedAmountCents: integer("fixed_amount_cents"),
    gciDefinition: text("gci_definition").notNull().default("COMMISSION_EX_GST"), // COMMISSION_EX_GST | COMMISSION_INC_GST
    gstApplicable: boolean("gst_applicable").notNull().default(true),

    paymentTrigger: text("payment_trigger").notNull().default("SETTLEMENT_COMPLETED"),
    authorisedPaymentMethod: text("authorised_payment_method").notNull().default("GENERAL_ACCOUNT_DEBIT_MANDATE"),
    // Never a raw bank credential (Section 13/33) — a token/mandate
    // reference from a provider, or null in sandbox until one exists.
    mandateProviderRef: text("mandate_provider_ref"),
    mandateProvider: text("mandate_provider"), // e.g. "sandbox"
    // Owner t180u(3) (slice 6, migration 0043): the SINGLE nominated payment
    // method (D8, no fallback). GENERAL_ACCOUNT_DEBIT_MANDATE uses the mandate
    // above; STORED_CARD names exactly one tokenised payment_methods row
    // (provider tokens only, never card data). payer_type says whose
    // authority covers the charge: the agent's own, or the brokerage's (D3,
    // stored card only, Brokerage Administrator approval under a signed mandate).
    payerType: text("payer_type").notNull().default("Agent"), // PC_FEE_AUTHORITY_PAYER_TYPES
    paymentMethodId: integer("payment_method_id").references(() => paymentMethods.id),
    brokerageCardApprovedByUserId: integer("brokerage_card_approved_by_user_id").references(() => users.id),
    brokerageCardApprovedAt: timestamp("brokerage_card_approved_at"),
    // Owner t181u(A): the signed AE agreement and payment-mandate terms
    // versions this authority was executed under. Immediate collection on
    // final statement issue applies only when BOTH versions expressly permit
    // it (lib/financial/pcFeeTerms.ts); null = pre-versioned terms, which fail
    // closed to the notice period. A terms change is a new authority version.
    agreementTermsVersion: text("agreement_terms_version"),
    mandateTermsVersion: text("mandate_terms_version"),

    maximumAmountCents: integer("maximum_amount_cents"),
    noticeRequiredDays: integer("notice_required_days").notNull().default(7),

    signedEvidenceRef: text("signed_evidence_ref"), // a documents.id or object-storage key
    effectiveDate: timestamp("effective_date"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: integer("revoked_by_user_id").references(() => users.id),
    revokeReason: text("revoke_reason"),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    agentVersionIdx: uniqueIndex("pc_fee_authorities_agent_version_idx").on(table.agentUserId, table.version),
    agentStatusIdx: index("pc_fee_authorities_agent_status_idx").on(table.agentUserId, table.status),
    // Owner t211u (0044): at most one ACTIVE authority per agent, enforced by the database.
    oneActivePerAgent: uniqueIndex("pc_fee_authorities_one_active_per_agent_idx").on(table.agentUserId).where(sql`${table.status} = 'ACTIVE'`),
    brokerageStatusIdx: index("pc_fee_authorities_brokerage_status_idx").on(table.brokerageId, table.status),
    methodCheck: check("pc_fee_authorities_method_check", sql`${table.authorisedPaymentMethod} in ('GENERAL_ACCOUNT_DEBIT_MANDATE', 'STORED_CARD')`),
    payerTypeCheck: check("pc_fee_authorities_payer_type_check", sql`${table.payerType} in ('Agent', 'Brokerage')`),
    cardMethodCheck: check(
      "pc_fee_authorities_card_method_check",
      sql`(${table.authorisedPaymentMethod} = 'STORED_CARD') = (${table.paymentMethodId} is not null)`,
    ),
    brokeragePayerCheck: check("pc_fee_authorities_brokerage_payer_check", sql`${table.payerType} = 'Agent' or ${table.authorisedPaymentMethod} = 'STORED_CARD'`),
    brokerageApprovalCheck: check(
      "pc_fee_authorities_brokerage_approval_check",
      sql`${table.payerType} = 'Agent' or ${table.status} <> 'ACTIVE' or (${table.brokerageCardApprovedByUserId} is not null and ${table.brokerageCardApprovedAt} is not null and ${table.signedEvidenceRef} is not null and ${table.brokerageCardApprovedByUserId} is distinct from ${table.createdByUserId})`,
    ),
  }),
);

export const pcFeeCalculations = pgTable(
  "pc_fee_calculations",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    commissionCalculationId: integer("commission_calculation_id").references(() => commissionCalculations.id),
    pcFeeAuthorityId: integer("pc_fee_authority_id").references(() => pcFeeAuthorities.id),

    calculationVersion: integer("calculation_version").notNull().default(1),
    state: text("state").notNull().default("ESTIMATE"), // FINANCIAL_SNAPSHOT_STATES
    supersedesId: integer("supersedes_id"),

    feeBasisUsed: text("fee_basis_used").notNull(),
    gciBasisCents: integer("gci_basis_cents").notNull(), // the GCI figure the % was applied to
    rateBpsUsed: integer("rate_bps_used"),
    grossFeeCents: integer("gross_fee_cents").notNull(),
    gstCents: integer("gst_cents").notNull().default(0),
    totalFeeCents: integer("total_fee_cents").notNull(),

    isDisputed: boolean("is_disputed").notNull().default(false),
    isProvisional: boolean("is_provisional").notNull().default(true),

    calculatedByUserId: integer("calculated_by_user_id").references(() => users.id),
    calculatedAt: timestamp("calculated_at").notNull().defaultNow(),
    finalisedAt: timestamp("finalised_at"),

    correlationId: text("correlation_id"),
  },
  (table) => ({
    transactionVersionIdx: uniqueIndex("pc_fee_calculations_transaction_version_idx").on(table.transactionId, table.calculationVersion),
    transactionStateIdx: index("pc_fee_calculations_transaction_state_idx").on(table.transactionId, table.state),
  }),
);

// ---------------------------------------------------------------------
// D. Payment requests (Sections 14-16) — invoice/debit lifecycle. Built
//    PC-success-fee-only for this phase (PAYMENT_REQUEST_KINDS), but the
//    status vocabulary and provider linkage are generic on purpose.
// ---------------------------------------------------------------------

export const financialPaymentRequests = pgTable(
  "financial_payment_requests",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    kind: text("kind").notNull().default("PC_SUCCESS_FEE"), // PAYMENT_REQUEST_KINDS
    pcFeeCalculationId: integer("pc_fee_calculation_id").references(() => pcFeeCalculations.id),
    pcFeeAuthorityId: integer("pc_fee_authority_id").references(() => pcFeeAuthorities.id),
    payeeUserId: integer("payee_user_id").references(() => users.id), // the PC/agent the fee is owed to
    payerUserId: integer("payer_user_id").references(() => users.id), // the agent the fee is charged to

    status: text("status").notNull().default("NOT_CALCULATED"), // PAYMENT_REQUEST_STATUSES
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("AUD"),

    invoiceNumber: text("invoice_number"),
    invoiceIssuedAt: timestamp("invoice_issued_at"),
    noticeSentAt: timestamp("notice_sent_at"),
    noticeCommunicationMessageId: integer("notice_communication_message_id"), // communicationMessages.id — no FK across schema files by design, validated in app code

    // Provider-neutral (Section 31): "sandbox" until real credentials are
    // configured. providerRequestRef is the mandate/debit-request
    // reference returned by the provider adapter — never fabricated.
    provider: text("provider"), // "sandbox" | future real provider name
    providerRequestRef: text("provider_request_ref"),
    providerStatus: text("provider_status"),

    scheduledAt: timestamp("scheduled_at"),
    processingStartedAt: timestamp("processing_started_at"),
    paidAt: timestamp("paid_at"),
    failedAt: timestamp("failed_at"),
    failureReason: text("failure_reason"),
    retryCount: integer("retry_count").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(3),
    // Owner t181u(C): earliest time a RETRY_SCHEDULED stored-card fee may be
    // attempted again (exponential backoff, capped). Null = not scheduled.
    nextAttemptAt: timestamp("next_attempt_at"),

    reversedAt: timestamp("reversed_at"),
    reversalReason: text("reversal_reason"),
    waivedAt: timestamp("waived_at"),
    waivedByUserId: integer("waived_by_user_id").references(() => users.id),
    waiveReason: text("waive_reason"),
    writtenOffAt: timestamp("written_off_at"),
    writtenOffByUserId: integer("written_off_by_user_id").references(() => users.id),
    writeOffReason: text("write_off_reason"),

    reconciliationStatus: text("reconciliation_status").notNull().default("NOT_REQUIRED"), // RECONCILIATION_STATUSES
    reconciledAt: timestamp("reconciled_at"),

    idempotencyKey: text("idempotency_key"),

    createdByUserId: integer("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    transactionKindIdx: uniqueIndex("financial_payment_requests_transaction_kind_idx").on(table.transactionId, table.kind),
    brokerageStatusIdx: index("financial_payment_requests_brokerage_status_idx").on(table.brokerageId, table.status),
    idempotencyKeyIdx: uniqueIndex("financial_payment_requests_idempotency_key_idx").on(table.idempotencyKey),
  }),
);

// Section 31: inbound payment-provider webhook dedup — mirrors
// billing_webhook_events / communication_webhook_events exactly.
export const financialPaymentProviderEvents = pgTable(
  "financial_payment_provider_events",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    paymentRequestId: integer("payment_request_id").references(() => financialPaymentRequests.id),
    eventType: text("event_type").notNull(), // PROCESSING | PAID | FAILED | REVERSED | DISPUTED
    payload: jsonb("payload"),
    receivedAt: timestamp("received_at").notNull().defaultNow(),
    processedAt: timestamp("processed_at"),
    processingStatus: text("processing_status").notNull().default("PENDING"), // PENDING | PROCESSED | FAILED | EXCEPTION | NO_CHANGE (t212u)
    processingError: text("processing_error"),
  },
  (table) => ({
    dedupIdx: uniqueIndex("financial_payment_provider_events_dedup_idx").on(table.provider, table.providerEventId),
  }),
);

// Stage D (Section 31): the durable payment outbox. One row per
// (paymentRequestId, action) — the unique index is both the dedup
// backstop AND the retry state: a failed dispatch attempt updates THIS
// row's attempts/nextAttemptAt/lastError rather than inserting a new one,
// so the row's own history is a complete record of every attempt. See
// lib/financial/paymentOutbox.ts's module header for the full rationale.
export const financialPaymentOutbox = pgTable(
  "financial_payment_outbox",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),

    action: text("action").notNull(), // OUTBOX_ACTIONS
    status: text("status").notNull().default("PENDING"), // OUTBOX_STATUSES

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    dispatchedAt: timestamp("dispatched_at"),
    // Owner t211u (0044): who raised a HELD_UNCERTAIN hold (null = system) and when; the resolver may not be the raiser.
    heldByUserId: integer("held_by_user_id").references(() => users.id),
    heldAt: timestamp("held_at"),

    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    paymentRequestActionIdx: uniqueIndex("financial_payment_outbox_payment_request_action_idx").on(table.paymentRequestId, table.action),
    statusNextAttemptIdx: index("financial_payment_outbox_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
  }),
);

// ---------------------------------------------------------------------
// E. Disputes (Section 16)
// ---------------------------------------------------------------------

export const financialDisputes = pgTable(
  "financial_disputes",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),

    disputedAmountCents: integer("disputed_amount_cents").notNull(),
    reason: text("reason").notNull(),
    raisedByUserId: integer("raised_by_user_id").references(() => users.id),
    raisedAt: timestamp("raised_at").notNull().defaultNow(),

    evidenceRef: text("evidence_ref"),
    internalOwnerUserId: integer("internal_owner_user_id").references(() => users.id),

    status: text("status").notNull().default("OPEN"), // DISPUTE_STATUSES
    resolution: text("resolution"),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    paymentRequestIdx: index("financial_disputes_payment_request_idx").on(table.paymentRequestId),
    brokerageStatusIdx: index("financial_disputes_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

// ---------------------------------------------------------------------
// F. Marketing payment overlay (Section 17) — one optional row per
//    campaignItem. Budget/planned-cost stays on launchPlans/campaignItems;
//    this table adds ONLY invoice/payment/reconciliation tracking.
// ---------------------------------------------------------------------

export const marketingPaymentRecords = pgTable(
  "marketing_payment_records",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    // Logical pointer to launch.campaignItems.id (a uuid). Kept as text
    // rather than a cross-file FK constraint — mirrors the same
    // no-cross-file-FK, app-validated convention used for
    // noticeCommunicationMessageId below.
    campaignItemId: text("campaign_item_id").notNull(),

    status: text("status").notNull().default("PLANNED"), // MARKETING_EXPENSE_STATUSES
    supplierName: text("supplier_name"),
    invoiceReference: text("invoice_reference"),
    invoicedAmountCents: integer("invoiced_amount_cents"),
    invoicedAt: timestamp("invoiced_at"),
    reportedPaidAmountCents: integer("reported_paid_amount_cents"),
    reportedPaidAt: timestamp("reported_paid_at"),
    paymentSource: text("payment_source"), // e.g. "Agent general account", "Brokerage account" — reported, not executed by AE
    evidenceRef: text("evidence_ref"),

    reconciliationStatus: text("reconciliation_status").notNull().default("NOT_REQUIRED"), // RECONCILIATION_STATUSES
    reconciledAt: timestamp("reconciled_at"),
    reconciledByUserId: integer("reconciled_by_user_id").references(() => users.id),

    recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    campaignItemIdx: uniqueIndex("marketing_payment_records_campaign_item_idx").on(table.campaignItemId),
    propertyStatusIdx: index("marketing_payment_records_property_status_idx").on(table.propertyId, table.status),
  }),
);

// ---------------------------------------------------------------------
// G. Sale deposit tracking (Section 18) — informational/evidentiary only.
// ---------------------------------------------------------------------

export const financialDeposits = pgTable(
  "financial_deposits",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),

    status: text("status").notNull().default("EXPECTED"), // DEPOSIT_STATUSES
    requiredAmountCents: integer("required_amount_cents"),
    dueDate: timestamp("due_date"),

    reportedReceivedAmountCents: integer("reported_received_amount_cents").notNull().default(0),
    reportedReceivedAt: timestamp("reported_received_at"),

    externalHolderType: text("external_holder_type"), // e.g. "SellerSolicitor", "BuyerSolicitor", "Agency Trust Account", "Other"
    externalHolderName: text("external_holder_name"),
    externalTrustAccountRef: text("external_trust_account_ref"),

    evidenceRef: text("evidence_ref"),

    reportedReleasedAt: timestamp("reported_released_at"),
    disbursementReference: text("disbursement_reference"),

    reconciliationStatus: text("reconciliation_status").notNull().default("UNRECONCILED"), // RECONCILIATION_STATUSES
    reconciledAt: timestamp("reconciled_at"),

    recordedByUserId: integer("recorded_by_user_id").references(() => users.id),
    verifiedByUserId: integer("verified_by_user_id").references(() => users.id),
    verifiedAt: timestamp("verified_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    transactionIdx: uniqueIndex("financial_deposits_transaction_idx").on(table.transactionId),
    brokerageStatusIdx: index("financial_deposits_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);

// ---------------------------------------------------------------------
// H. Reconciliation records (Section 19) — polymorphic over the record
//    types above, generic rather than one reconciliation table per domain.
// ---------------------------------------------------------------------
//
// FIN-001 (Step 3 integration-readiness brief, Section 4): reconcileLegacyCommission
// (lib/financial/legacyReconciliation.ts) does a SELECT-before-INSERT. Two
// concurrent calls for the same (brokerageId, transactionId) can both pass
// that SELECT before either INSERT commits. That race would duplicate a
// LEGACY_TRANSACTION_COMMISSION reconciliation row for one transaction.
// It is the same class of race ensurePcSuccessFeeRequest
// (lib/financial/settlement.ts) already closed via
// financial_payment_requests_transaction_kind_idx.
//
// legacyCommissionUniqueIdx below declares the fix at the schema level: a
// PARTIAL unique index, scoped to recordType = 'LEGACY_TRANSACTION_COMMISSION'
// only, on (brokerageId, recordId) where recordId holds the transaction's id
// (as text). A partial index is deliberate, not a blanket unique index across
// all FINANCIAL_RECORD_TYPES:
//   - Every OTHER row shape stored in this table via recordType (COMMISSION_
//     AGREEMENT, PC_FEE_AUTHORITY, PAYMENT_REQUEST, ...) reconciles rows that
//     point at an underlying table which is itself already versioned
//     (commissionAgreements/commissionCalculations/pcFeeAuthorities all carry
//     version/supersedesId). More than one financial_reconciliations row per
//     (brokerageId, recordId) is expected and legitimate there — e.g. a
//     re-reconciliation after a superseding version is calculated.
//   - financial_reconciliations itself has no version/supersedesId columns of
//     its own, and the LEGACY_TRANSACTION_COMMISSION recordType exists
//     specifically as a one-shot "flag this legacy transaction for review"
//     marker (see legacyReconciliation.ts's module header) — for THIS record
//     type only, more than one row per (brokerageId, transactionId) is never
//     a legitimate second version, it is always a duplicate of the same flag.
//
// Applied by migration 0009_flimsy_norrin_radd
// (packages/db/migrations/0009_flimsy_norrin_radd.sql, journal idx 9).
// That migration creates financial_reconciliations_legacy_commission_unique_idx
// as a unique btree on (brokerage_id, record_id) WHERE
// record_type = 'LEGACY_TRANSACTION_COMMISSION', the same columns and
// predicate as legacyCommissionUniqueIdx below. `.onConflictDoNothing()`
// in reconcileLegacyCommission (legacyReconciliation.ts) is the active
// race guard against that index.

export const financialReconciliations = pgTable(
  "financial_reconciliations",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    recordType: text("record_type").notNull(), // FINANCIAL_RECORD_TYPES
    recordId: text("record_id").notNull(),

    expectedAmountCents: integer("expected_amount_cents"),
    reportedAmountCents: integer("reported_amount_cents"),
    evidenceAmountCents: integer("evidence_amount_cents"),
    differenceCents: integer("difference_cents"),

    status: text("status").notNull().default("UNRECONCILED"), // RECONCILIATION_STATUSES
    source: text("source"),
    externalReference: text("external_reference"),
    evidenceRef: text("evidence_ref"),
    notes: text("notes"),

    reconciledByUserId: integer("reconciled_by_user_id").references(() => users.id),
    reconciledAt: timestamp("reconciled_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    recordIdx: index("financial_reconciliations_record_idx").on(table.recordType, table.recordId),
    brokerageStatusIdx: index("financial_reconciliations_brokerage_status_idx").on(table.brokerageId, table.status),
    // FIN-001 fix — see the module comment directly above this table for
    // full rationale. Scoped (partial) unique index: only enforces
    // uniqueness of (brokerageId, recordId) among rows where recordType is
    // the legacy one-shot flag, leaving every other recordType free to have
    // multiple reconciliation rows per record (expected for versioned
    // financial records). Created by migration 0009_flimsy_norrin_radd —
    // see the rationale above.
    legacyCommissionUniqueIdx: uniqueIndex("financial_reconciliations_legacy_commission_unique_idx")
      .on(table.brokerageId, table.recordId)
      .where(sql`${table.recordType} = 'LEGACY_TRANSACTION_COMMISSION'`),
  }),
);

// ---------------------------------------------------------------------
// I. Immutable financial ledger (Section 20) — append-only, mirrors
//    riskExceptionTransitions/launchPlanTransitions exactly.
// ---------------------------------------------------------------------

export const FINANCIAL_LEDGER_EVENT_TYPES = [
  "COMMISSION_AGREEMENT_APPROVED",
  "SALE_PRICE_CONFIRMED",
  "COMMISSION_CALCULATED",
  "COMMISSION_CALCULATION_SUPERSEDED",
  "COMMISSION_FINALISED",
  "PC_FEE_CALCULATED",
  "PC_FEE_AUTHORITY_ACTIVATED",
  "PC_FEE_AUTHORITY_REVOKED",
  "PC_FEE_INVOICED",
  "PC_FEE_NOTICE_SENT",
  "PC_FEE_DEBIT_SCHEDULED",
  "PC_FEE_PAYMENT_PROCESSING",
  "PC_FEE_PAID",
  "PC_FEE_PAYMENT_FAILED",
  // Stage D addition: no dedicated "reversed" ledger event existed from
  // Stage B — a REVERSED payment request (either provider-reported via a
  // webhook, or admin-initiated via reverseDebit) is a genuinely distinct,
  // auditable outcome from a plain PAYMENT_FAILED, so it gets its own
  // additive vocabulary entry rather than overloading that one.
  "PC_FEE_PAYMENT_REVERSED",
  "PC_FEE_DISPUTED",
  "PC_FEE_DISPUTE_RESOLVED",
  "PC_FEE_WAIVED",
  "PC_FEE_WRITTEN_OFF",
  "PC_FEE_RECONCILED",
  "MARKETING_INVOICE_RECORDED",
  "MARKETING_PAYMENT_REPORTED",
  "MARKETING_RECONCILED",
  "DEPOSIT_REPORTED_RECEIVED",
  "DEPOSIT_EVIDENCE_RECEIVED",
  "DEPOSIT_RECONCILED",
  "DEPOSIT_REPORTED_RELEASED",
  "SETTLEMENT_FINANCIALS_FINALISED",
  "AUDIT_RETURN_REMINDER_SENT",
  "AUDIT_RETURN_SUBMITTED",
  // Financial Transaction Engine Verification, Step 2, COHERENCE-001
  // remediation: recorded when a Brokerage Administrator (or the
  // idempotent backfill script) flags a pre-existing legacy transaction
  // commission for reconciliation because it predates this brokerage's
  // first Financial Engine commissionAgreement — see
  // lib/financial/legacyReconciliation.ts.
  "LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION",
] as const;
export type FinancialLedgerEventType = (typeof FINANCIAL_LEDGER_EVENT_TYPES)[number];

export const financialLedgerEvents = pgTable(
  "financial_ledger_events",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").references(() => properties.id),
    transactionId: integer("transaction_id").references(() => transactions.id),

    eventType: text("event_type").notNull(), // FINANCIAL_LEDGER_EVENT_TYPES
    amountCents: integer("amount_cents"),
    currency: text("currency").notNull().default("AUD"),

    sourceRecordType: text("source_record_type").notNull(), // FINANCIAL_RECORD_TYPES
    sourceRecordId: text("source_record_id").notNull(),

    actorType: text("actor_type").notNull(), // SYSTEM | USER
    actorUserId: integer("actor_user_id").references(() => users.id),
    reason: text("reason"),

    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
    reversalOfEventId: integer("reversal_of_event_id"),

    metadata: jsonb("metadata"),

    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => ({
    brokerageOccurredIdx: index("financial_ledger_events_brokerage_occurred_idx").on(table.brokerageId, table.occurredAt),
    transactionOccurredIdx: index("financial_ledger_events_transaction_occurred_idx").on(table.transactionId, table.occurredAt),
    sourceRecordIdx: index("financial_ledger_events_source_record_idx").on(table.sourceRecordType, table.sourceRecordId),
  }),
);

// ---------------------------------------------------------------------
// J. Annual audit-return reminders (Section 23)
// ---------------------------------------------------------------------

export const AUDIT_RETURN_STATUSES = ["SCHEDULED", "REMINDER_SENT", "DUE", "OVERDUE", "SUBMITTED"] as const;
export type AuditReturnStatus = (typeof AUDIT_RETURN_STATUSES)[number];

export const auditReturnReminders = pgTable(
  "audit_return_reminders",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),

    jurisdiction: text("jurisdiction").notNull().default("AU"),
    reportingEntityName: text("reporting_entity_name"),
    reportingPeriodStart: timestamp("reporting_period_start").notNull(),
    reportingPeriodEnd: timestamp("reporting_period_end").notNull(),
    dueDate: timestamp("due_date").notNull(),

    // Configurable reminder offsets in days-before-due, e.g. [60,30,14,7] —
    // never hardcoded (Section 23).
    reminderOffsetsDays: jsonb("reminder_offsets_days").notNull().default(sql`'[60,30,14,7]'::jsonb`),
    remindersSent: jsonb("reminders_sent").notNull().default(sql`'[]'::jsonb`), // Array<{ offsetDays: number; sentAt: string }>

    responsibleUserId: integer("responsible_user_id").references(() => users.id),
    status: text("status").notNull().default("SCHEDULED"), // AUDIT_RETURN_STATUSES

    requiredRecordsNote: text("required_records_note"),
    submissionReference: text("submission_reference"),
    submittedAt: timestamp("submitted_at"),
    submittedByUserId: integer("submitted_by_user_id").references(() => users.id),
    evidenceRef: text("evidence_ref"),
    notes: text("notes"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePeriodIdx: uniqueIndex("audit_return_reminders_brokerage_period_idx").on(table.brokerageId, table.reportingPeriodStart, table.reportingPeriodEnd),
    brokerageStatusIdx: index("audit_return_reminders_brokerage_status_idx").on(table.brokerageId, table.status),
    dueDateIdx: index("audit_return_reminders_due_date_idx").on(table.dueDate),
  }),
);

// ---------------------------------------------------------------------
// K. Per-brokerage financial settings (rates, thresholds) — one row per
//    brokerage, created lazily on first read (mirrors communicationSettings).
// ---------------------------------------------------------------------

export const financialSettings = pgTable("financial_settings", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id).unique(),

  defaultGstRateBps: integer("default_gst_rate_bps").notNull().default(1000), // AU 10%
  defaultPcFeeRateBps: integer("default_pc_fee_rate_bps").notNull().default(690), // current business default (6.90%), fully overridable per pcFeeAuthorities row
  defaultPcFeeGciDefinition: text("default_pc_fee_gci_definition").notNull().default("COMMISSION_EX_GST"),
  defaultPcFeeNoticeRequiredDays: integer("default_pc_fee_notice_required_days").notNull().default(7),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ---------------------------------------------------------------------
// Zod insert schemas + row types
// ---------------------------------------------------------------------

export const insertCommissionAgreementSchema = createInsertSchema(commissionAgreements).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCommissionCalculationSchema = createInsertSchema(commissionCalculations).omit({ id: true, calculatedAt: true });
export const insertPcFeeAuthoritySchema = createInsertSchema(pcFeeAuthorities).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPcFeeCalculationSchema = createInsertSchema(pcFeeCalculations).omit({ id: true, calculatedAt: true });
export const insertFinancialPaymentRequestSchema = createInsertSchema(financialPaymentRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFinancialPaymentProviderEventSchema = createInsertSchema(financialPaymentProviderEvents).omit({ id: true, receivedAt: true });
export const insertFinancialPaymentOutboxSchema = createInsertSchema(financialPaymentOutbox).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFinancialDisputeSchema = createInsertSchema(financialDisputes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertMarketingPaymentRecordSchema = createInsertSchema(marketingPaymentRecords).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFinancialDepositSchema = createInsertSchema(financialDeposits).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFinancialReconciliationSchema = createInsertSchema(financialReconciliations).omit({ id: true, createdAt: true });
export const insertFinancialLedgerEventSchema = createInsertSchema(financialLedgerEvents).omit({ id: true, occurredAt: true });
export const insertAuditReturnReminderSchema = createInsertSchema(auditReturnReminders).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFinancialSettingsSchema = createInsertSchema(financialSettings).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertCommissionAgreement = z.infer<typeof insertCommissionAgreementSchema>;
export type InsertCommissionCalculation = z.infer<typeof insertCommissionCalculationSchema>;
export type InsertPcFeeAuthority = z.infer<typeof insertPcFeeAuthoritySchema>;
export type InsertPcFeeCalculation = z.infer<typeof insertPcFeeCalculationSchema>;
export type InsertFinancialPaymentRequest = z.infer<typeof insertFinancialPaymentRequestSchema>;
export type InsertFinancialPaymentProviderEvent = z.infer<typeof insertFinancialPaymentProviderEventSchema>;
export type InsertFinancialPaymentOutbox = z.infer<typeof insertFinancialPaymentOutboxSchema>;
export type InsertFinancialDispute = z.infer<typeof insertFinancialDisputeSchema>;
export type InsertMarketingPaymentRecord = z.infer<typeof insertMarketingPaymentRecordSchema>;
export type InsertFinancialDeposit = z.infer<typeof insertFinancialDepositSchema>;
export type InsertFinancialReconciliation = z.infer<typeof insertFinancialReconciliationSchema>;
export type InsertFinancialLedgerEvent = z.infer<typeof insertFinancialLedgerEventSchema>;
export type InsertAuditReturnReminder = z.infer<typeof insertAuditReturnReminderSchema>;
export type InsertFinancialSettings = z.infer<typeof insertFinancialSettingsSchema>;

export type CommissionAgreement = typeof commissionAgreements.$inferSelect;
export type CommissionCalculation = typeof commissionCalculations.$inferSelect;
// Native drizzle insert type (NOT the zod-derived InsertCommissionCalculation
// above) -- used wherever a caller assigns tiersUsed/roundingAdjustments
// directly, because drizzle-zod's createInsertSchema does not honour a
// jsonb column's .$type<>() override and would otherwise widen both
// fields back to its own generic recursive Json type.
export type NewCommissionCalculation = typeof commissionCalculations.$inferInsert;
export type PcFeeAuthority = typeof pcFeeAuthorities.$inferSelect;
export type PcFeeCalculation = typeof pcFeeCalculations.$inferSelect;
export type FinancialPaymentRequest = typeof financialPaymentRequests.$inferSelect;
export type FinancialPaymentProviderEvent = typeof financialPaymentProviderEvents.$inferSelect;
export type FinancialPaymentOutbox = typeof financialPaymentOutbox.$inferSelect;
export type FinancialDispute = typeof financialDisputes.$inferSelect;
export type MarketingPaymentRecord = typeof marketingPaymentRecords.$inferSelect;
export type FinancialDeposit = typeof financialDeposits.$inferSelect;
export type FinancialReconciliation = typeof financialReconciliations.$inferSelect;
export type FinancialLedgerEvent = typeof financialLedgerEvents.$inferSelect;
export type AuditReturnReminder = typeof auditReturnReminders.$inferSelect;
export type FinancialSettingsRow = typeof financialSettings.$inferSelect;

// Re-exported so callers that only import from this file can still type
// against the domains it references, mirroring commerce.ts's own pattern.
export type { Transaction } from "./transaction";
export type { CampaignItem } from "./launch";

// ---------------------------------------------------------------------
// Owner t212u (0045): collection REQUESTS vs execution, and BA reconciliation exceptions.
// ---------------------------------------------------------------------

/**
 * t212u item 1: a collection request (Pit Crew, a Brokerage Administrator, the statement-issue
 * trigger or the scheduler). Recording never calls a provider; the system payment workflow
 * executes it after re-validating every gate. One open (PENDING/EXECUTING) request per fee.
 */
export const pcFeeCollectionRequests = pgTable(
  "pc_fee_collection_requests",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),
    requestedByUserId: integer("requested_by_user_id").references(() => users.id),
    requestedByRole: text("requested_by_role").notNull(),
    trigger: text("trigger").notNull(), // collect | statement_issued | scheduler
    status: text("status").notNull().default("PENDING"), // PENDING | EXECUTING | EXECUTED | REFUSED | FAILED
    executedBy: text("executed_by"), // SYSTEM_PAYMENT_WORKFLOW
    outcome: text("outcome"),
    refusalCode: text("refusal_code"),
    executedAt: timestamp("executed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    oneOpenPerRequest: uniqueIndex("pc_fee_collection_requests_one_open_idx")
      .on(table.paymentRequestId)
      .where(sql`${table.status} in ('PENDING', 'EXECUTING')`),
    brokerageStatusIdx: index("pc_fee_collection_requests_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);
export type PcFeeCollectionRequest = typeof pcFeeCollectionRequests.$inferSelect;

/**
 * t212u items 3-4: provider outcomes AE must not apply to a locked record (a "Paid" after a waiver
 * or write-off) and unconfirmed provider cancellations. Reviewed and resolved by a Brokerage
 * Administrator (refund assessment); the financial records themselves are never mutated here.
 */
export const financialReconciliationExceptions = pgTable(
  "financial_reconciliation_exceptions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    paymentRequestId: integer("payment_request_id").notNull().references(() => financialPaymentRequests.id),
    propertyId: integer("property_id").references(() => properties.id),
    kind: text("kind").notNull(), // PAID_AFTER_WAIVER | PAID_AFTER_WRITE_OFF | CANCELLATION_UNCONFIRMED
    source: text("source").notNull(), // WEBHOOK | RECONCILIATION | RECOVERY
    providerEventRowId: integer("provider_event_row_id").references(() => financialPaymentProviderEvents.id),
    providerRequestRef: text("provider_request_ref"),
    amountCents: integer("amount_cents"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("OPEN"), // OPEN | RESOLVED
    refundAssessment: text("refund_assessment"), // REFUND_REQUIRED | NO_REFUND_REQUIRED | NOT_APPLICABLE
    resolutionReason: text("resolution_reason"),
    resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    oneOpenPerKind: uniqueIndex("financial_reconciliation_exceptions_one_open_idx")
      .on(table.paymentRequestId, table.kind)
      .where(sql`${table.status} = 'OPEN'`),
    brokerageStatusIdx: index("financial_reconciliation_exceptions_brokerage_status_idx").on(table.brokerageId, table.status),
  }),
);
export type FinancialReconciliationException = typeof financialReconciliationExceptions.$inferSelect;
