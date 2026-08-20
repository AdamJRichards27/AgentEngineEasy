import { pgTable, serial, integer, text, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property";

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
});

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

  legalRepresentatives: jsonb("legal_representatives"), // { sellerSolicitor, buyerSolicitor }

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
});

export const insertOfferSchema = createInsertSchema(offers).omit({ id: true, createdAt: true });
export const insertTransactionSchema = createInsertSchema(transactions).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertOffer = z.infer<typeof insertOfferSchema>;
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Offer = typeof offers.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
