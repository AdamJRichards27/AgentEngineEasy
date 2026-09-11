import { pgTable, serial, text, integer, boolean, timestamp, jsonb, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties, properties } from "./property";
import { growOpportunities } from "./grow";

// AE GROW Priority 5 — Data & Property Intelligence.
//
// Deliberately does NOT introduce a parallel contact table, a parallel
// property table, a second timeline, a second entitlement resolver, or a
// second audit log — see docs/AE_GROW_PRIORITY_5_DATA_PROPERTY_INTELLIGENCE_
// REPORT.md §3 for the full Duplication Stop Condition analysis. What this
// file adds is the three genuinely new pieces that audit found missing:
//
//   - propertyExternalIdentifiers: links a provider's own record for a
//     property (Pricefinder/Domain/Landchecker/etc. — or, today, only the
//     mock/Google-Places provider) to our canonical `properties` row, with
//     an explicit confidence + human-reviewable PendingReview/Confirmed/
//     Rejected status. Generalises apps/api/src/lib/ownership.ts's existing
//     "review, not block" philosophy into a reusable matching primitive —
//     never a silent auto-merge on a name match alone.
//   - propertyProviderObservations: raw, provider-shaped facts (sales
//     history, market activity, planning/development, valuation/equity,
//     mortgage/refinancing, ownership, address candidates), stored
//     SEPARATELY from canonical agent-controlled data and never merged into
//     it. A refresh inserts a new row and flips the previous current row's
//     isCurrent flag rather than overwriting anything — unlike
//     properties.ownershipData (a single mutable jsonb column with no
//     history), a provider observation's history is never destroyed by a
//     later refresh, and removing a provider later never corrupts a
//     canonical record because canonical data never lived in this table.
//   - growOpportunitySignals: the canonical, provider-neutral "selling
//     opportunity indicator" model. Deliberately NOT the same thing as
//     growOpportunities (grow.ts): growOpportunities is an agent-owned
//     pipeline entity (owner, stage, close outcome); a signal is a
//     system-generated, evidence-backed, dismissable INDICATOR that an
//     agent has not yet acted on. A signal may be manually promoted into a
//     real growOpportunities row (promotedOpportunityId) — nothing in this
//     file ever creates one automatically, and nothing in this file ever
//     creates an appraisal, campaign, or transaction, or contacts a
//     consumer. See lib/propertyIntelligence/signals.ts for the
//     deterministic rule engine that populates this table.

export const PROPERTY_EXTERNAL_IDENTIFIER_STATUSES = ["PendingReview", "Confirmed", "Rejected"] as const;
export type PropertyExternalIdentifierStatus = (typeof PROPERTY_EXTERNAL_IDENTIFIER_STATUSES)[number];

// One row per (provider, externalId) — a provider's own record for a
// property, linked to our canonical property once matched. matchConfidence/
// matchReasons are always human-readable factors (e.g. "exact postcode +
// street number match"), never a raw/opaque model score, matching the
// house style already established for growRelationships.confidenceScore
// and growOpportunities.scoreExplanation.
export const propertyExternalIdentifiers = pgTable(
  "property_external_identifiers",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    provider: text("provider").notNull(), // "mock" | "google_places" | future: "pricefinder" | "domain" | "landchecker" | ...
    externalId: text("external_id").notNull(),
    matchConfidence: numeric("match_confidence"), // 0..1; null = not scored (manual link)
    matchReasons: jsonb("match_reasons"), // string[] of human-readable contributing factors
    status: text("status").notNull().default("PendingReview"),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at"),
    rejectedReason: text("rejected_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePropertyIdx: index("property_external_identifiers_brokerage_property_idx").on(table.brokerageId, table.propertyId),
    brokerageStatusIdx: index("property_external_identifiers_brokerage_status_idx").on(table.brokerageId, table.status),
    providerExternalIdUnique: uniqueIndex("property_external_identifiers_provider_external_id_unique").on(table.provider, table.externalId),
  }),
);

export const PROPERTY_OBSERVATION_TYPES = [
  "ownership",
  "sales_history",
  "market_activity",
  "planning_development",
  "valuation_equity",
  "mortgage_refinancing",
  "address_candidate",
] as const;
export type PropertyObservationType = (typeof PROPERTY_OBSERVATION_TYPES)[number];

// Append-only per (propertyId, observationType, provider): a refresh inserts
// a new row and the caller flips the prior current row's isCurrent to
// false, so "what did this provider say, and when" is always reconstructible
// — see lib/propertyIntelligence/observations.ts's recordObservation().
// supersededByObservationId is a plain nullable integer (no FK constraint)
// rather than a self-referencing FK, keeping this table's own migration
// simple; application code is the sole writer of this column.
export const propertyProviderObservations = pgTable(
  "property_provider_observations",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    propertyId: integer("property_id").notNull().references(() => properties.id),
    observationType: text("observation_type").notNull(),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference"),
    payload: jsonb("payload").notNull(), // raw provider-shaped facts — never merged into canonical fields
    sourceTimestamp: timestamp("source_timestamp"), // when the provider says the fact was true/observed
    retrievedAt: timestamp("retrieved_at").notNull().defaultNow(),
    supersededByObservationId: integer("superseded_by_observation_id"),
    isCurrent: boolean("is_current").notNull().default(true),
    licenceExpiresAt: timestamp("licence_expires_at"),
    retentionExpiresAt: timestamp("retention_expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePropertyIdx: index("property_provider_observations_brokerage_property_idx").on(table.brokerageId, table.propertyId),
    propertyTypeCurrentIdx: index("property_provider_observations_property_type_current_idx").on(
      table.propertyId,
      table.observationType,
      table.isCurrent,
    ),
  }),
);

export const PROPERTY_SIGNAL_TYPES = [
  "long_ownership_tenure",
  "recent_nearby_sales_activity",
  "estimated_equity_band",
  "mortgage_refinancing_indicator",
  "development_planning_activity",
  "land_use_zoning_change",
  "property_ownership_change",
  "stale_previous_appraisal",
  "lease_tenancy_milestone",
  "past_buyer_interest",
  "agent_recorded_motivation",
  "re_engagement_opportunity",
] as const;
export type PropertySignalType = (typeof PROPERTY_SIGNAL_TYPES)[number];

// Deliberately bands, never a raw percentage/score — see Build Brief-style
// precedent already set by growOpportunities.confidenceScore/
// scoreExplanation (never read as a bare number anywhere in this codebase).
export const PROPERTY_SIGNAL_CONFIDENCE_BANDS = ["Emerging", "WorthReviewing", "StrongIndicator"] as const;
export type PropertySignalConfidenceBand = (typeof PROPERTY_SIGNAL_CONFIDENCE_BANDS)[number];

export const PROPERTY_SIGNAL_STATUSES = ["Active", "Reviewed", "Dismissed", "Expired", "Superseded"] as const;
export type PropertySignalStatus = (typeof PROPERTY_SIGNAL_STATUSES)[number];

export const growOpportunitySignals = pgTable(
  "grow_opportunity_signals",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    partyId: integer("party_id").references(() => parties.id),
    propertyId: integer("property_id").references(() => properties.id),
    signalType: text("signal_type").notNull(),
    title: text("title").notNull(),
    explanation: text("explanation").notNull(), // plain-language, careful non-deterministic wording — never asserted as fact
    evidence: jsonb("evidence").notNull(), // contributing factors + provider/internal source references
    source: text("source").notNull(), // "internal" | a provider id from PROPERTY_OBSERVATION_TYPES' provider column
    sourceTimestamp: timestamp("source_timestamp"),
    computedAt: timestamp("computed_at").notNull().defaultNow(),
    confidenceBand: text("confidence_band").notNull(),
    status: text("status").notNull().default("Active"),
    // Stable per (brokerageId, propertyId/partyId, signalType, underlying-event) — see
    // lib/propertyIntelligence/signals.ts's buildDedupeKey(). Unique-indexed so recalculation is
    // idempotent (an upsert on conflict, never a duplicate insert) and so two signals for the
    // same underlying event can never coexist, even across two independent recalculation runs.
    dedupeKey: text("dedupe_key").notNull(),
    expiresAt: timestamp("expires_at"),
    dismissedReason: text("dismissed_reason"),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => users.id),
    reviewedAt: timestamp("reviewed_at"),
    // Set only by an explicit agent action (POST .../promote) — never written by the signal
    // engine itself. See §"Opportunity signals — decision" in the Priority 5 report.
    promotedOpportunityId: integer("promoted_opportunity_id").references(() => growOpportunities.id),
    scoreVersion: integer("score_version").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokeragePropertyIdx: index("grow_opportunity_signals_brokerage_property_idx").on(table.brokerageId, table.propertyId),
    brokeragePartyIdx: index("grow_opportunity_signals_brokerage_party_idx").on(table.brokerageId, table.partyId),
    brokerageStatusIdx: index("grow_opportunity_signals_brokerage_status_idx").on(table.brokerageId, table.status),
    dedupeKeyUnique: uniqueIndex("grow_opportunity_signals_dedupe_key_unique").on(table.dedupeKey),
  }),
);

export const insertPropertyExternalIdentifierSchema = createInsertSchema(propertyExternalIdentifiers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPropertyProviderObservationSchema = createInsertSchema(propertyProviderObservations).omit({
  id: true,
  createdAt: true,
});
export const insertGrowOpportunitySignalSchema = createInsertSchema(growOpportunitySignals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPropertyExternalIdentifier = z.infer<typeof insertPropertyExternalIdentifierSchema>;
export type InsertPropertyProviderObservation = z.infer<typeof insertPropertyProviderObservationSchema>;
export type InsertGrowOpportunitySignal = z.infer<typeof insertGrowOpportunitySignalSchema>;

export type PropertyExternalIdentifier = typeof propertyExternalIdentifiers.$inferSelect;
export type PropertyProviderObservation = typeof propertyProviderObservations.$inferSelect;
export type GrowOpportunitySignal = typeof growOpportunitySignals.$inferSelect;

export type InsertPropertyExternalIdentifier = z.infer<typeof insertPropertyExternalIdentifierSchema>;
