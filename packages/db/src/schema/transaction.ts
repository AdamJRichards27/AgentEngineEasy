import { pgTable, serial, integer, text, numeric, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property";
import { users } from "./users";

// Offers are never overwritten in place — each change is a new row
// (revision-chain pattern proven in Agent Engine Staging's offers.ts).
export const offers = pgTable("offers", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  buyerPartyId: integer("buyer_party_id").references(() => parties.id),
  offerPriceCents: integer("offer_price_cents").notNull(),
  conditions: jsonb("conditions"),
  status: text("status").notNull().default("Received"), // Received | Accepted | Declined | Withdrawn
  shareToken: text("share_token").unique(), // public buyer-facing link, no sign-in required
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  // AE GROW Completion Wave 1 index batch. Offers are only ever read per
  // property, and this table had no index beyond its primary key and the
  // share-token unique.
  propertyIdx: index("offers_property_idx").on(table.propertyId),
}));

// M3 (Owner t165u: revocable offer links, approved for development and
// review; NOT executed outside local scratch without separate approval).
// One row per issued buyer status link. offers.share_token is left exactly
// as it was (data preservation): the migration copies every existing token
// here as an active, non-expiring link, so links already sent keep working
// until an agent revokes them. Reissue never overwrites: the old row is
// revoked (reason "reissued") and a new row is added (D8 "no silent
// replacement"). Rows are never deleted; ON DELETE CASCADE only follows the
// test-suite cleanup of offers. User ids are plain integers, like audit_logs.
export const offerShareLinks = pgTable("offer_share_links", {
  id: serial("id").primaryKey(),
  offerId: integer("offer_id").notNull().references(() => offers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  issuedAt: timestamp("issued_at").notNull().defaultNow(),
  issuedByUserId: integer("issued_by_user_id"),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id"),
  revokeReason: text("revoke_reason"), // "revoked" | "reissued"
}, (table) => ({
  offerIdx: index("offer_share_links_offer_idx").on(table.offerId),
}));

// Real structured fields from day one — not a single flat `commission` number
// (the clearest schema gap the prior Agent Engine audit found).
//
// Phase 7 (ARCHITECTURE.md §10): this table had zero rows anywhere in the
// app until offer acceptance actually created one, so the milestone columns
// below were added fresh rather than migrated — same "zero pre-existing
// rows, no migration risk" justification Phase 6 used for paymentMethods.
// status progresses ContractPreparation -> UnderContract ->
// SettlementScheduled -> Settled -> Closed; financeApprovedAt is informational
// (not every contract carries a finance condition) and never gates status.
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  acceptedOfferId: integer("accepted_offer_id").references(() => offers.id),
  sellerPartyIds: jsonb("seller_party_ids").notNull(), // int[]
  buyerPartyIds: jsonb("buyer_party_ids").notNull(), // int[]

  purchasePriceCents: integer("purchase_price_cents").notNull(),
  depositCents: integer("deposit_cents"),

  contractDate: timestamp("contract_date"),
  financeApprovedAt: timestamp("finance_approved_at"),
  settlementDate: timestamp("settlement_date"), // scheduled date
  settlementCompletedAt: timestamp("settlement_completed_at"), // actual completion

  // Stage E — Contract & Conditions (Agent Engine 2.0 — Run Transaction
  // Vertical Slice). Ordering follows the governing spec's stage list:
  // Contract Prep -> Exchange -> Unconditional. Both idempotent (see
  // lib/transactionConditions.ts), both null until recorded, both feed the
  // canonical CONTRACT_EXCHANGED / TRANSACTION_UNCONDITIONAL domain events,
  // which existed in the event registry with zero publishers before this.
  exchangedAt: timestamp("exchanged_at"),
  unconditionalAt: timestamp("unconditional_at"),

  // { sellerSolicitorPartyId, buyerSolicitorPartyId } — references parties
  // already linked to the property with role "Solicitor" (reuses the
  // existing party-capture UI; this column had zero real writers before
  // the Run Transaction Vertical Slice added lib/transactions.ts's
  // recordLegalRepresentatives()).
  legalRepresentatives: jsonb("legal_representatives"),

  status: text("status").notNull().default("ContractPreparation"),

  grossCommissionCents: integer("gross_commission_cents"),
  gstCents: integer("gst_cents"),
  commissionCalculatedAt: timestamp("commission_calculated_at"),

  // Manual bookkeeping records, not real fund movement — this app has no
  // trust-accounting ledger/provider; these are agent/brokerage-admin
  // confirmations (e.g. "the trust account statement shows this cleared"),
  // real trust-account integration is future scope.
  fundsReceivedCents: integer("funds_received_cents").notNull().default(0), // cumulative — may recur for partial payments
  fundsReceivedAt: timestamp("funds_received_at"),
  agentPaidAt: timestamp("agent_paid_at"),

  closedAt: timestamp("closed_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // AE GROW Completion Wave 1 index batch. "The transaction for this
  // property" is the single most common read of this table (the property
  // detail view, the timeline, the exception engine's own rules) and it had
  // no index beyond the primary key.
  propertyIdx: index("transactions_property_idx").on(table.propertyId),
}));

export const CONTRACT_CONDITION_STATUSES = ["Pending", "Satisfied", "Waived", "Failed", "NotApplicable"] as const;
export type ContractConditionStatus = (typeof CONTRACT_CONDITION_STATUSES)[number];

// Stage E — Contract & Conditions (Agent Engine 2.0 — Run Transaction
// Vertical Slice). One row per tracked condition — finance, building &
// pest, cooling-off, or a special condition carried forward from the
// accepted offer's free-form conditions text (see
// lib/transactions.ts's acceptOffer) — with a due date and a
// satisfied/waived/failed/not-applicable state, per the governing spec's
// Section 10. dueDateHistory is appended to, never rewritten in place, so
// every prior due date survives a reschedule (Section 16: "date changes
// must preserve audit history").
export const transactionConditions = pgTable("transaction_conditions", {
  id: serial("id").primaryKey(),
  transactionId: integer("transaction_id").notNull().references(() => transactions.id),
  description: text("description").notNull(),
  dueDate: timestamp("due_date"),
  dueDateHistory: jsonb("due_date_history").notNull().default(sql`'[]'::jsonb`), // Array<{ previousDueDate: string | null; changedAt: string; changedByUserId: number }>
  status: text("status").notNull().default("Pending"), // Pending | Satisfied | Waived | Failed | NotApplicable
  resolvedAt: timestamp("resolved_at"),
  resolvedByUserId: integer("resolved_by_user_id").references(() => users.id),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  // AE GROW Completion Wave 1 index batch. Conditions are always read as
  // "every condition on this transaction"; no index beyond the primary key
  // existed for it.
  transactionIdx: index("transaction_conditions_transaction_idx").on(table.transactionId),
}));

export const insertOfferSchema = createInsertSchema(offers).omit({ id: true, createdAt: true });
export const insertTransactionSchema = createInsertSchema(transactions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTransactionConditionSchema = createInsertSchema(transactionConditions).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertOffer = z.infer<typeof insertOfferSchema>;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type InsertTransactionCondition = z.infer<typeof insertTransactionConditionSchema>;
export type Offer = typeof offers.$inferSelect;
export type OfferShareLink = typeof offerShareLinks.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type TransactionCondition = typeof transactionConditions.$inferSelect;
