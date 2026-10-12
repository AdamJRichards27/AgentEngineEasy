import { pgTable, serial, text, integer, boolean, timestamp, jsonb, numeric, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";

// The property progresses through this stage list; each stage is what
// determines "what needs to happen next" on the Property Workspace.
export const WORKFLOW_STAGES = [
  "Appraisal",
  "Ready to List",
  "Listed",
  "Under Offer",
  "Contract",
  "Settlement",
  "Closed",
] as const;

export const properties = pgTable("properties", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  agentId: integer("agent_id").notNull().references(() => users.id),

  // Address — captured once at Start Property (Build Brief §3).
  formattedAddress: text("formatted_address").notNull(),
  placeId: text("place_id"), // Google Places id, if resolved via provider
  suburb: text("suburb"),
  state: text("state"), // AU state/territory — drives document rules (§9)
  postcode: text("postcode"),
  isManualAddress: boolean("is_manual_address").notNull().default(false),

  workflowStage: text("workflow_stage").notNull().default("Appraisal"),

  // Denormalised status summaries for fast "what's next" reads —
  // source of truth remains the linked AMLVerification / DocumentPackage rows.
  amlStatusSummary: text("aml_status_summary").notNull().default("Not Started"),
  listingStatus: text("listing_status").notNull().default("Not Listed"),

  // Stage C — Listing preparation (Agent Engine 2.0 — Run Transaction
  // Vertical Slice). Purely descriptive/informational fields shown to the
  // agent ahead of Go Live — capturing them never publishes a listing,
  // orders a supplier, or incurs a cost (the governing spec's Section 8
  // explicitly excludes both from this build). Missing values are
  // surfaced by the workspace as a non-blocking prompt, the same
  // "review, not block" precedent already used for ownership review.
  salesMethod: text("sales_method"), // e.g. Auction | PrivateTreaty | Tender | ExpressionsOfInterest — free text, no fixed enum
  priceDisplay: text("price_display"), // e.g. "$800,000" or "Auction — Guide $750,000"
  campaignStartDate: timestamp("campaign_start_date"),
  campaignEndDate: timestamp("campaign_end_date"),

  // Ownership data from the property-data provider, compared against sellers
  // entered (Build Brief §8) — mismatch shown as a review prompt, not a hard block.
  ownershipData: jsonb("ownership_data"),
  ownershipReviewRequired: boolean("ownership_review_required").notNull().default(false),
  ownershipReviewedBy: integer("ownership_reviewed_by").references(() => users.id),
  ownershipReviewedAt: timestamp("ownership_reviewed_at"),
  ownershipReviewNotes: text("ownership_review_notes"),

  isDraft: boolean("is_draft").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  // AE GROW Priority 5 — Data & Property Intelligence. All four columns are
  // nullable and purely additive: geocode coordinates (set opportunistically
  // when a provider observation resolves them — see
  // lib/propertyIntelligence/observations.ts), and a coarse, human-readable
  // rollup of "how enriched is this property" (never a raw score) driven by
  // the same provider-observation pipeline. None of this is written by the
  // existing ownership-review flow above, and none of it feeds
  // ownershipReview* — enrichment quality and ownership review remain two
  // independent signals.
  latitude: numeric("latitude", { precision: 10, scale: 7 }),
  longitude: numeric("longitude", { precision: 10, scale: 7 }),
  dataQualityStatus: text("data_quality_status"), // null | "NotEnriched" | "Partial" | "Enriched" | "Stale"
  lastEnrichedAt: timestamp("last_enriched_at"),
},
(table) => ({
  // AE GROW "Brokerage-wide Signal Sweep" stage 1. `properties` had no index
  // on brokerage_id. Sweep and Grow Today reads are still driven from
  // `properties where brokerage_id = $1`. Migration 0036 also stores
  // `appraisals.brokerage_id`, kept equal to this column by
  // appraisals_property_brokerage_fk. This index stays.
  brokerageIdx: index("properties_brokerage_idx").on(table.brokerageId),
  // E-9 migration 0036. Composite foreign keys on appraisals reference
  // (id, brokerage_id). id is already the primary key; Postgres still
  // requires a unique constraint on the exact referenced column list.
  idBrokerageUq: unique("properties_id_brokerage_uq").on(table.id, table.brokerageId),
}));

export const PROPERTY_DATA_QUALITY_STATUSES = ["NotEnriched", "Partial", "Enriched", "Stale"] as const;
export type PropertyDataQualityStatus = (typeof PROPERTY_DATA_QUALITY_STATUSES)[number];

// Person / Organisation / Trust / Estate / Other — initial workflow stays
// simple; entity-specific fields requested only when partyType !== "Person" (§4).
export const PARTY_TYPES = ["Person", "Organisation", "Trust", "Estate", "Other"] as const;

export const parties = pgTable("parties", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  partyType: text("party_type").notNull().default("Person"),

  firstName: text("first_name"),
  middleName: text("middle_name"),
  lastName: text("last_name"),
  organisationName: text("organisation_name"), // used when partyType !== "Person"

  mobile: text("mobile"),
  email: text("email"),
  residentialAddress: text("residential_address"),

  // Populated only when the entity structure requires it (trust deed, ACN, etc.)
  entityDetails: jsonb("entity_details"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
(table) => ({
  // AE GROW "Brokerage-wide Signal Sweep" stage 2. `parties` had no index at
  // all beyond its primary key, yet the re_engagement_opportunity rule is the
  // first rule that is genuinely CONTACT-driven rather than property-driven:
  // its driving set is "every contact in this brokerage", so without this the
  // rule would sequential-scan a tenant-mixed table on every evaluated
  // brokerage. Same argument, and same shape, as properties_brokerage_idx.
  brokerageIdx: index("parties_brokerage_idx").on(table.brokerageId),
  // E-9 migration 0036. appraisals and communication_participants reference
  // (id, brokerage_id) when party_id is set.
  idBrokerageUq: unique("parties_id_brokerage_uq").on(table.id, table.brokerageId),
}));

// The join that makes "enter once, reuse everywhere" real. A seller entered
// against a property is never re-entered for AML, agency agreement, or contract.
export const PROPERTY_PARTY_ROLES = [
  "Seller",
  "Buyer",
  "Solicitor",
  "PowerOfAttorney",
  "Other",
] as const;

export const propertyParties = pgTable("property_parties", {
  id: serial("id").primaryKey(),
  propertyId: integer("property_id").notNull().references(() => properties.id),
  partyId: integer("party_id").notNull().references(() => parties.id),
  role: text("role").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  // AE GROW Completion Wave 1 index batch. This join table existed only to be
  // read as "who is linked to this property", and had no index beyond its
  // primary key — so every property detail view sequential-scanned it.
  propertyIdx: index("property_parties_property_idx").on(table.propertyId),
}));

export const insertPropertySchema = createInsertSchema(properties).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPartySchema = createInsertSchema(parties).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPropertyPartySchema = createInsertSchema(propertyParties).omit({ id: true, createdAt: true });

export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type InsertParty = z.infer<typeof insertPartySchema>;
export type InsertPropertyParty = z.infer<typeof insertPropertyPartySchema>;
export type Property = typeof properties.$inferSelect;
export type Party = typeof parties.$inferSelect;
export type PropertyPartyLink = typeof propertyParties.$inferSelect;
