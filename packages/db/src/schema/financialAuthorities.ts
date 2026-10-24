// Owner t174u — Pit Crew financial amendment authority (PR #271, CC #34).
//
// A narrowly scoped, documented, revocable, expiring grant from the listing
// agent of a property (or a Brokerage Administrator, the brokerage's
// authorised approval role per t174u) to ONE Pit Crew member, for ONE
// transaction, permitting ONE kind of amendment that already exists in the
// API (optionally narrowed to one record). It never authorises a payment,
// debit, refund, release or disbursement: those routes stay Brokerage
// Administrator only regardless of any grant.
//
// Migration 0038_financial_amendment_authorities (additive: one new table;
// no existing table is altered). Rollback: docs/migrations/
// 0038-financial-amendment-authorities-ROLLBACK.md.
import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { brokerages, users } from "./users";
import { properties } from "./property";
import { transactions } from "./transaction";
import { documents } from "./documents";

/** The amendments a grant can permit — only those already routed today. */
export const FINANCIAL_AMENDMENT_SCOPES = ["AGENCY_TERMS", "CAMPAIGN_ITEM_COST"] as const;
export type FinancialAmendmentScope = (typeof FINANCIAL_AMENDMENT_SCOPES)[number];

/** The record type a scope's optional single-record target must name. */
export const FINANCIAL_AMENDMENT_SCOPE_TARGET_TYPE: Record<FinancialAmendmentScope, string> = {
  AGENCY_TERMS: "agency_agreement_terms",
  CAMPAIGN_ITEM_COST: "campaign_item",
};

export const financialAmendmentAuthorities = pgTable(
  "financial_amendment_authorities",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    // Derived from the transaction at grant time and checked against it.
    propertyId: integer("property_id").notNull().references(() => properties.id),
    transactionId: integer("transaction_id").notNull().references(() => transactions.id),
    granteeUserId: integer("grantee_user_id").notNull().references(() => users.id),
    // Always the signed-in grantor; never taken from a request body.
    grantedByUserId: integer("granted_by_user_id").notNull().references(() => users.id),
    grantedByRole: text("granted_by_role").notNull(),
    scope: text("scope").notNull(),
    targetRecordType: text("target_record_type"),
    targetRecordId: text("target_record_id"),
    evidenceDocumentId: integer("evidence_document_id").references(() => documents.id),
    evidenceNote: text("evidence_note"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    revokedAt: timestamp("revoked_at"),
    revokedByUserId: integer("revoked_by_user_id").references(() => users.id),
    revokeReason: text("revoke_reason"),
  },
  (table) => ({
    granteeLookupIdx: index("fin_amend_auth_grantee_txn_scope_idx").on(table.granteeUserId, table.transactionId, table.scope),
    transactionIdx: index("fin_amend_auth_transaction_idx").on(table.transactionId),
    brokerageCreatedIdx: index("fin_amend_auth_brokerage_created_idx").on(table.brokerageId, table.createdAt),
    scopeCheck: check("fin_amend_auth_scope_check", sql`${table.scope} in ('AGENCY_TERMS', 'CAMPAIGN_ITEM_COST')`),
    grantorRoleCheck: check("fin_amend_auth_grantor_role_check", sql`${table.grantedByRole} in ('Agent', 'Brokerage Administrator')`),
    targetPairCheck: check(
      "fin_amend_auth_target_pair_check",
      sql`(${table.targetRecordType} is null) = (${table.targetRecordId} is null)`,
    ),
    evidenceCheck: check(
      "fin_amend_auth_evidence_check",
      sql`${table.evidenceDocumentId} is not null or length(btrim(coalesce(${table.evidenceNote}, ''))) > 0`,
    ),
    expiryCheck: check("fin_amend_auth_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
    revokePairCheck: check(
      "fin_amend_auth_revoke_pair_check",
      sql`(${table.revokedAt} is null) = (${table.revokedByUserId} is null)`,
    ),
    selfGrantCheck: check("fin_amend_auth_no_self_grant_check", sql`${table.granteeUserId} <> ${table.grantedByUserId}`),
  }),
);

export type FinancialAmendmentAuthority = typeof financialAmendmentAuthorities.$inferSelect;
