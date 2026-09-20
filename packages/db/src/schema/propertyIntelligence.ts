import { pgTable, serial, text, integer, boolean, timestamp, jsonb, numeric, index, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
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

    // ---------------------------------------------------------------
    // AE GROW "Brokerage-wide Signal Sweep" stage 1 — additive, all
    // nullable/defaulted, so every row written before this change keeps
    // working unmodified.
    // ---------------------------------------------------------------
    //
    // The earliest instant at which the sweep may re-raise this dedupeKey
    // after a human decided it. NULL means "never re-raise on this
    // dedupeKey" (the pre-change behaviour, and what promotion to an
    // opportunity leaves behind). Set by dismissSignal/reviewSignal — see
    // the re-review policy documented in
    // lib/propertyIntelligence/signals.ts's module header. A dismissal is
    // never silently overridden before this instant.
    nextReviewAt: timestamp("next_review_at"),
    // Last time the brokerage-wide sweep looked at this row's dedupeKey and
    // found its underlying evidence still present. Observability/debugging
    // only — no rule reads it.
    lastSweptAt: timestamp("last_swept_at"),
    // Deterministic, rule-defined digest of the MATERIAL inputs behind this
    // signal (never the whole evidence blob — see buildEvidenceFingerprint()
    // in lib/propertyIntelligence/evaluation.ts). Two evaluations that
    // produce an identical fingerprint for the same dedupeKey saw no
    // material change; a differing fingerprint is the "materially changed"
    // precondition the re-review policy requires before a human-decided
    // signal may be raised again.
    evidenceFingerprint: text("evidence_fingerprint"),
    // How many times this dedupeKey has been re-raised after a human
    // decision. 0 for every signal that has never been through the
    // re-review path.
    reRaiseCount: integer("re_raise_count").notNull().default(0),
    // Snapshot of the human decision that the most recent re-raise
    // superseded ({status, dismissedReason, reviewedByUserId, reviewedAt}).
    // Kept on the row so an Active signal never carries a stale
    // dismissedReason while still showing the reviewer what was decided
    // last time. The authoritative trail remains the audit log.
    priorDecision: jsonb("prior_decision"),
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
    // The single uniqueness path for BOTH anchors. A property-anchored key is
    // `${brokerageId}:${type}:${propertyId}:${sourceRowId}`; a party-anchored
    // key is `${brokerageId}:${type}:party:${partyId}:${sourceRowId}`. Because
    // the anchor is encoded in the key itself, one unique index over
    // dedupe_key keeps the existing property-anchored semantics byte-identical
    // AND makes a party-anchored row (property_id NULL) equally unique — no
    // second partial unique index is needed, and adding one would only create
    // a second way for the same invariant to be enforced.
    dedupeKeyUnique: uniqueIndex("grow_opportunity_signals_dedupe_key_unique").on(table.dedupeKey),
    // Sweep-driven expiry: "every Active row in this brokerage whose
    // expiresAt has passed", brokerage-wide rather than per property.
    brokerageStatusExpiresIdx: index("grow_opportunity_signals_brokerage_status_expires_idx").on(table.brokerageId, table.status, table.expiresAt),
    // Contact-anchored reads (Contact 360, Grow Today Rule F) and the
    // sweep's contactability filter, which loads the party ids a brokerage's
    // signals reference. Partial so it stays small on a tenant whose signals
    // are mostly observation-derived (party_id NULL).
    brokeragePartyStatusIdx: index("grow_opportunity_signals_brokerage_party_status_idx")
      .on(table.brokerageId, table.partyId, table.status)
      .where(sql`${table.partyId} IS NOT NULL`),
    // Re-review scan: "which human-decided signals in this brokerage are now
    // eligible to be reconsidered". Partial — a NULL next_review_at is
    // permanently terminal and must never be scanned.
    brokerageNextReviewIdx: index("grow_opportunity_signals_brokerage_next_review_idx")
      .on(table.brokerageId, table.nextReviewAt)
      .where(sql`${table.nextReviewAt} IS NOT NULL`),
  }),
);

/* ---------------------------------------------------------------------
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — run bookkeeping.
 *
 * Mirrors risk_exception_scan_runs (packages/db/src/schema/exceptions.ts)
 * deliberately, because lib/propertyIntelligence/sweep.ts is built on the
 * exact same single-flight advisory-lock pattern as the Exception & Risk
 * Engine's scheduled sweep: one global row per run, closed out COMPLETED or
 * FAILED, and any row left RUNNING by a process that died is recovered by
 * the next run that successfully TAKES THE LOCK — never by wall-clock
 * arithmetic ("this row looks older than N minutes"), which would be wrong
 * on a clock-skewed or slow host.
 * -----------------------------------------------------------------*/

export const GROW_SIGNAL_SWEEP_RUN_STATUSES = ["RUNNING", "COMPLETED", "FAILED"] as const;
export type GrowSignalSweepRunStatus = (typeof GROW_SIGNAL_SWEEP_RUN_STATUSES)[number];

export const GROW_SIGNAL_SWEEP_TRIGGERS = ["SCHEDULED", "MANUAL"] as const;
export type GrowSignalSweepTrigger = (typeof GROW_SIGNAL_SWEEP_TRIGGERS)[number];

export const growSignalSweepRuns = pgTable("grow_signal_sweep_runs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("RUNNING"),
  trigger: text("trigger").notNull().default("SCHEDULED"),
  brokeragesConsidered: integer("brokerages_considered").notNull().default(0),
  brokeragesEvaluated: integer("brokerages_evaluated").notNull().default(0),
  brokeragesSkippedUnchanged: integer("brokerages_skipped_unchanged").notNull().default(0),
  candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
  signalsCreated: integer("signals_created").notNull().default(0),
  signalsUpdated: integer("signals_updated").notNull().default(0),
  signalsReRaised: integer("signals_re_raised").notNull().default(0),
  signalsExpired: integer("signals_expired").notNull().default(0),
  candidatesSuppressed: integer("candidates_suppressed").notNull().default(0),
  // True when at least one brokerage hit MAX_CANDIDATES_PER_BROKERAGE, i.e.
  // that brokerage's candidate set was NOT authoritative this run, so the
  // "no longer supported -> Expired" pass was deliberately skipped for it.
  truncated: boolean("truncated").notNull().default(false),
  errors: integer("errors").notNull().default(0),
  errorMessage: text("error_message"),
});

/* ---------------------------------------------------------------------
 * Per-brokerage change-detection cursor (cost control).
 *
 * The sweep is not allowed to re-evaluate every brokerage's entire candidate
 * universe on every tick. Before evaluating a brokerage it probes the max
 * mutation timestamp of each source table it reads and compares it to the
 * high-water marks recorded here; if nothing moved and no signal is due for
 * expiry or re-review, the brokerage's evaluation is skipped entirely.
 * sourceHighWaterMarks is jsonb rather than one column per source so a later
 * stage can add a source without another migration.
 * -----------------------------------------------------------------*/
export const growSignalSweepCursors = pgTable(
  "grow_signal_sweep_cursors",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    // { growRelationships: ISO, growOpportunities: ISO, appraisals: ISO, propertyProviderObservations: ISO }
    sourceHighWaterMarks: jsonb("source_high_water_marks").notNull().default(sql`'{}'::jsonb`),
    lastEvaluatedAt: timestamp("last_evaluated_at"),
    // The last evaluation that was NOT short-circuited by the cursor — the
    // anchor for FULL_SWEEP_INTERVAL_MS's periodic "evaluate regardless".
    lastFullEvaluationAt: timestamp("last_full_evaluation_at"),
    // Soft pointer (no FK, keeping this migration simple — the same tradeoff
    // propertyProviderObservations.supersededByObservationId already takes).
    lastSweepRunId: uuid("last_sweep_run_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    brokerageUnique: uniqueIndex("grow_signal_sweep_cursors_brokerage_unique").on(table.brokerageId),
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
export const insertGrowSignalSweepRunSchema = createInsertSchema(growSignalSweepRuns).omit({ id: true, startedAt: true });
export const insertGrowSignalSweepCursorSchema = createInsertSchema(growSignalSweepCursors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPropertyExternalIdentifier = z.infer<typeof insertPropertyExternalIdentifierSchema>;
export type InsertPropertyProviderObservation = z.infer<typeof insertPropertyProviderObservationSchema>;
export type InsertGrowOpportunitySignal = z.infer<typeof insertGrowOpportunitySignalSchema>;

export type InsertGrowSignalSweepRun = z.infer<typeof insertGrowSignalSweepRunSchema>;
export type InsertGrowSignalSweepCursor = z.infer<typeof insertGrowSignalSweepCursorSchema>;

export type PropertyExternalIdentifier = typeof propertyExternalIdentifiers.$inferSelect;
export type PropertyProviderObservation = typeof propertyProviderObservations.$inferSelect;
export type GrowOpportunitySignal = typeof growOpportunitySignals.$inferSelect;
export type GrowSignalSweepRun = typeof growSignalSweepRuns.$inferSelect;
export type GrowSignalSweepCursor = typeof growSignalSweepCursors.$inferSelect;
