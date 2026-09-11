import { pgTable, serial, integer, text, numeric, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { properties, parties } from "./property";
import { users } from "./users";

/**
 * AE GROW Priority 4 - Appraisal Workspace status lifecycle (directive Sec.6).
 * Deliberately a validated free-text column, not a Postgres enum type, so the
 * list can grow later without a migration - the same discipline already used
 * for growOpportunities.stage/status. Kept in one place so the API and any
 * future consumer share a single source of truth.
 */
export const APPRAISAL_STATUSES = [
  "DRAFT",
  "PREPARING",
  "READY",
  "SENT",
  "VIEWED",
  "APPOINTMENT_SCHEDULED",
  "PRESENTED",
  "FOLLOW_UP",
  "WON",
  "LOST",
  "DEFERRED",
  "ARCHIVED",
] as const;

/** Sec.18 - structured, extensible outcome reasons. Free text, not a DB enum. */
export const APPRAISAL_OUTCOME_REASONS = [
  "selected_another_agent",
  "fee_commission",
  "pricing_disagreement",
  "marketing_proposal",
  "relationship",
  "decided_not_to_sell",
  "timing_delayed",
  "unable_to_contact",
  "other",
] as const;

export const appraisals = pgTable("appraisals", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),

  // AE GROW Priority 4 - Appraisal Workspace (Grow -> Run). partyId /
  // opportunityId / ownerUserId / createdByUserId are additive and nullable
  // so every RUN-tier appraisal created before this change keeps working
  // unmodified (Stage A's property-keyed flow never captured a contact or
  // opportunity at all).
  partyId: integer("party_id").references(() => parties.id),
  // Deliberately NOT a DB-level foreign key: packages/db/src/schema/grow.ts
  // already imports `appraisals` from this file for its own (enforced)
  // convertedAppraisalId reference, so a `.references(() => growOpportunities.id)`
  // here would create a circular module import between grow.ts and this
  // file. Referential integrity for this side is enforced in application
  // code (apps/api/src/lib/growAppraisals.ts) instead - the same
  // enforce-in-code tradeoff already accepted elsewhere in this schema.
  // growOpportunities.convertedAppraisalId remains the DB-enforced half of
  // this relationship.
  opportunityId: integer("opportunity_id"),
  ownerUserId: integer("owner_user_id").references(() => users.id),
  createdByUserId: integer("created_by_user_id").references(() => users.id),

  status: text("status").notNull().default("DRAFT"),

  priceRangeLow: numeric("price_range_low", { precision: 12, scale: 2 }),
  priceRangeHigh: numeric("price_range_high", { precision: 12, scale: 2 }),
  priceRangeCurrency: text("price_range_currency").notNull().default("AUD"),
  pricingCommentary: text("pricing_commentary"),
  marketPositionNarrative: text("market_position_narrative"),

  sellingStrategy: text("selling_strategy"),
  marketingProposal: text("marketing_proposal"),
  commissionRatePercent: numeric("commission_rate_percent", { precision: 5, scale: 2 }),
  commissionProposal: text("commission_proposal"),
  recommendedNextSteps: text("recommended_next_steps"),

  appointmentAt: timestamp("appointment_at"),
  presentationAt: timestamp("presentation_at"),
  sentAt: timestamp("sent_at"),
  viewedAt: timestamp("viewed_at"),

  followUpAt: timestamp("follow_up_at"),
  followUpNotes: text("follow_up_notes"),

  outcome: text("outcome"), // WON | LOST | DEFERRED | null while undecided
  outcomeReason: text("outcome_reason"),
  outcomeNotes: text("outcome_notes"),
  outcomeAt: timestamp("outcome_at"),

  // Stage A (RUN) fields - unchanged.
  comparableSales: jsonb("comparable_sales"),
  isFinalised: boolean("is_finalised").notNull().default(false),
  // Immutable snapshot on finalisation - pattern kept from Agent Engine Staging's appraisals.ts.
  finalisedSnapshot: jsonb("finalised_snapshot"),
  shareToken: text("share_token").unique(),

  // Sec.13/Sec.14 - presentation output reuses the canonical `documents` table
  // (packages/db/src/schema/documents.ts) instead of a second document
  // store; this column is just a soft pointer to the latest generated
  // presentation document (not a DB-enforced FK, for the same
  // avoid-a-new-import-cycle reasoning as opportunityId above).
  presentationDocumentId: integer("presentation_document_id"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Sec.10 - Comparable property (manual first, Priority 5 provider-injection
 * ready). source/sourceProvenance exist from day one so a future
 * PriceFinder/Domain/Landchecker integration can populate the same columns
 * without a schema redesign.
 */
export const appraisalComparableSales = pgTable("appraisal_comparable_sales", {
  id: serial("id").primaryKey(),
  appraisalId: integer("appraisal_id").notNull().references(() => appraisals.id),
  address: text("address").notNull(),
  salePrice: numeric("sale_price", { precision: 12, scale: 2 }),
  saleDate: timestamp("sale_date"),
  bedrooms: integer("bedrooms"),
  bathrooms: integer("bathrooms"),
  carSpaces: integer("car_spaces"),
  landSizeSqm: numeric("land_size_sqm", { precision: 10, scale: 2 }),
  propertyType: text("property_type"),
  notes: text("notes"),
  imageUrl: text("image_url"),
  source: text("source").notNull().default("manual"), // manual | pricefinder | domain | landchecker
  sourceProvenance: text("source_provenance"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** Sec.10 - current market competition (manual first, same provenance discipline). */
export const appraisalMarketCompetition = pgTable("appraisal_market_competition", {
  id: serial("id").primaryKey(),
  appraisalId: integer("appraisal_id").notNull().references(() => appraisals.id),
  address: text("address").notNull(),
  askingPriceDisplay: text("asking_price_display"), // e.g. "$800,000" or "Auction - Guide $750,000"
  askingPriceLow: numeric("asking_price_low", { precision: 12, scale: 2 }),
  askingPriceHigh: numeric("asking_price_high", { precision: 12, scale: 2 }),
  status: text("status"), // e.g. Active | UnderOffer | Sold | Withdrawn
  daysOnMarket: integer("days_on_market"),
  attributesSummary: text("attributes_summary"),
  notes: text("notes"),
  source: text("source").notNull().default("manual"),
  sourceProvenance: text("source_provenance"),
  displayOrder: integer("display_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAppraisalSchema = createInsertSchema(appraisals).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAppraisal = z.infer<typeof insertAppraisalSchema>;
export type Appraisal = typeof appraisals.$inferSelect;

export const insertAppraisalComparableSaleSchema = createInsertSchema(appraisalComparableSales).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAppraisalComparableSale = z.infer<typeof insertAppraisalComparableSaleSchema>;
export type AppraisalComparableSale = typeof appraisalComparableSales.$inferSelect;

export const insertAppraisalMarketCompetitionSchema = createInsertSchema(appraisalMarketCompetition).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAppraisalMarketCompetition = z.infer<typeof insertAppraisalMarketCompetitionSchema>;
export type AppraisalMarketCompetition = typeof appraisalMarketCompetition.$inferSelect;
