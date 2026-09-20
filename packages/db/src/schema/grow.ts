import { pgTable, serial, text, integer, boolean, timestamp, jsonb, numeric, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { brokerages, users } from "./users";
import { parties, properties } from "./property";
import { appraisals } from "./appraisal";
import { transactions } from "./transaction";

// Grow Stage A - canonical relationship/activity/opportunity model (ARCHITECTURE.md Phase 10).
// Person and Organisation are NOT duplicated here - Grow reuses the existing `parties` table
// (partyType: Person | Organisation | Trust | Estate | Other) as its canonical person/org
// record, exactly as RUN does. What Grow adds is its OWN relationship model: RUN's
// `propertyParties` is a narrow, 5-role legal/transactional join (Seller/Buyer/Solicitor/
// PowerOfAttorney/Other, no history, no confidence, no source) and is left untouched.
// Grow's relationship taxonomy below is deliberately much richer and historical, so it gets
// its own table rather than stretching propertyParties past what it means in RUN.

export const GROW_RELATIONSHIP_TYPES = [
  "owner",
  "co_owner",
  "former_owner",
  "occupier",
  "tenant",
  "landlord",
  "buyer",
  "prospective_buyer",
  "seller",
  "prospective_seller",
  "appraisal_contact",
  "vendor",
  "investor",
  "developer",
  "referrer",
  "related_party",
  "unknown_pending_review",
] as const;
export type GrowRelationshipType = (typeof GROW_RELATIONSHIP_TYPES)[number];

// PERSON <-> RELATIONSHIP <-> PROPERTY. Many people to one property, one person to many
// properties, historical relationships preserved (status + validFrom/validTo) rather than
// overwritten, uncertain relationships land in PendingReview rather than being guessed.
export const growRelationships = pgTable("grow_relationships", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  partyId: integer("party_id").notNull().references(() => parties.id),
  // AE GROW Priority 0.5 — Workstream 6: propertyId is deliberately NOT .notNull(). The revised
  // Grow model (docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md §"Pre-Property Relationship
  // Decision") requires an agent to be able to record a relationship with a contact BEFORE AE
  // knows which property is relevant — prospecting and nurture naturally start with a person,
  // not a property. Confirmed safe: the import pipeline (lib/import/relationships.ts's
  // resolveRelationshipLinks) already only ever links a row that carries a real formatted
  // property address regardless of this column's nullability, so it never created — and still
  // never creates — a property-less row as an accidental side effect (see
  // lib/import/__tests__/relationships.test.ts). routes/grow.ts's POST /relationships accepts a
  // missing propertyId; GET /relationships uses a leftJoin (not innerJoin) against `properties`
  // so a property-less relationship is still returned, with a null property.
  propertyId: integer("property_id").references(() => properties.id),
  relationshipType: text("relationship_type").notNull(),
  role: text("role"), // free-text refinement, e.g. "Executor" when relationshipType = related_party
  status: text("status").notNull().default("Active"), // Active | Historical | PendingReview
  isPrimary: boolean("is_primary").notNull().default(false),
  confidenceScore: numeric("confidence_score"), // 0..1; null = not scored (manual entry)
  validFrom: timestamp("valid_from").notNull().defaultNow(),
  validTo: timestamp("valid_to"),
  sourceType: text("source_type").notNull().default("manual"), // manual | import | inferred | migration
  sourceId: text("source_id"),
  sourceEvidence: text("source_evidence"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
(table) => ({
  // AE GROW "Brokerage-wide Signal Sweep" stage 1. This table had NO indexes
  // at all before; every index below serves a query that already exists.
  //
  // Both internal signal rules (long_ownership_tenure, past_buyer_interest)
  // and Grow Today Rule D read exactly (brokerage_id, status='Active') and
  // then discriminate on relationship_type — so the sweep's brokerage-wide
  // set query and Rule D's per-brokerage read share one index instead of
  // sequential-scanning the whole tenant-mixed table.
  brokerageStatusTypeIdx: index("grow_relationships_brokerage_status_type_idx").on(table.brokerageId, table.status, table.relationshipType),
  // The sweep's per-brokerage change-detection probe is
  // `select max(updated_at) where brokerage_id = $1` — an index-only
  // backwards scan of one brokerage's slice rather than a full table scan
  // on every tick. This is what makes a steady-state sweep cheap.
  brokerageUpdatedAtIdx: index("grow_relationships_brokerage_updated_at_idx").on(table.brokerageId, table.updatedAt),
  // Contact-anchored evaluation (a property-less relationship belongs to a
  // party, not a property) and the Contact 360 / Relationship Timeline reads.
  brokeragePartyIdx: index("grow_relationships_brokerage_party_idx").on(table.brokerageId, table.partyId),
}));

export const GROW_ACTIVITY_TYPES = [
  "call",
  "call_summary",
  "email",
  "sms",
  "meeting",
  "appraisal",
  "note",
  "task_completion",
  "campaign_response",
  "property_enquiry",
  "offer_related",
  "system_event",
] as const;
export type GrowActivityType = (typeof GROW_ACTIVITY_TYPES)[number];

export const growActivities = pgTable("grow_activities", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  partyId: integer("party_id").references(() => parties.id),
  propertyId: integer("property_id").references(() => properties.id),
  opportunityId: integer("opportunity_id").references(() => growOpportunities.id),
  activityType: text("activity_type").notNull(),
  occurredAt: timestamp("occurred_at").notNull(), // actual occurrence, kept separate from recordedAt
  recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  summary: text("summary").notNull(),
  details: jsonb("details"),
  responsibleUserId: integer("responsible_user_id").references(() => users.id),
  source: text("source").notNull().default("manual"),
  sourceId: text("source_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
},
(table) => ({
  // Grow Today reads every activity for a brokerage and folds it down to a
  // last-activity-per-party map (lib/growToday.ts). Leading with
  // (brokerage_id, party_id, occurred_at) turns that from a full scan of a
  // tenant-mixed table into one brokerage's slice in party/recency order.
  brokeragePartyOccurredIdx: index("grow_activities_brokerage_party_occurred_idx").on(table.brokerageId, table.partyId, table.occurredAt),
  // grow_activities is append-only (no updated_at), so recorded_at is its
  // mutation high-water mark for the sweep's change-detection probe.
  brokerageRecordedAtIdx: index("grow_activities_brokerage_recorded_at_idx").on(table.brokerageId, table.recordedAt),
}));

// A structured, explainable potential business outcome - never just an unexplained score.
export const growOpportunities = pgTable("grow_opportunities", {
  id: serial("id").primaryKey(),
  brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
  partyId: integer("party_id").notNull().references(() => parties.id),
  propertyId: integer("property_id").references(() => properties.id),
  opportunityType: text("opportunity_type").notNull(), // Listing | Appraisal | PropertyManagement | Other
  status: text("status").notNull().default("Open"), // Open | Converted | Lost | Closed
  stage: text("stage").notNull().default("New"), // New | Contacted | Qualified | AppraisalBooked | Converted | Lost
  ownerUserId: integer("owner_user_id").references(() => users.id),
  source: text("source").notNull().default("manual"),
  reason: text("reason"), // why this opportunity exists - required narrative, not just a score
  confidenceScore: numeric("confidence_score"),
  scoreExplanation: text("score_explanation"),
  scoreVersion: integer("score_version").notNull().default(1),
  recommendedNextAction: text("recommended_next_action"),
  nextActionDueAt: timestamp("next_action_due_at"),
  lastMeaningfulContactAt: timestamp("last_meaningful_contact_at"),
  expectedTimeframe: text("expected_timeframe"),
  // Conversion targets reuse RUN's real entities. "Listing" itself is not a separate table in
  // this app - it is the `properties.listingStatus` / `workflowStage` transition that RUN's
  // existing workflow engine already drives once an appraisal is finalised, so Grow's handoff
  // stops at creating the Appraisal and does not duplicate RUN's listing/transaction workflow.
  convertedAppraisalId: integer("converted_appraisal_id").references(() => appraisals.id),
  convertedTransactionId: integer("converted_transaction_id").references(() => transactions.id),
  lostReason: text("lost_reason"),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
},
(table) => ({
  // The past_buyer_interest rule asks "does this (party, property) already
  // have an opportunity?" — previously one SELECT per candidate relationship
  // against an unindexed table. The set-based rewrite does it as a single
  // anti-join per brokerage, which needs exactly this composite.
  brokeragePartyPropertyIdx: index("grow_opportunities_brokerage_party_property_idx").on(table.brokerageId, table.partyId, table.propertyId),
  // Grow Today Rules A/B/C read (brokerage_id, status='Open') on every
  // request; promoteSignal and the Opportunities surface read the same slice.
  brokerageStatusIdx: index("grow_opportunities_brokerage_status_idx").on(table.brokerageId, table.status),
  // The sweep's change-detection probe: a new or edited opportunity can
  // retire a past_buyer_interest signal, so opportunities are one of the
  // sources whose high-water mark decides whether a brokerage is re-evaluated.
  brokerageUpdatedAtIdx: index("grow_opportunities_brokerage_updated_at_idx").on(table.brokerageId, table.updatedAt),
}));

export const insertGrowRelationshipSchema = createInsertSchema(growRelationships).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGrowActivitySchema = createInsertSchema(growActivities).omit({ id: true, createdAt: true });
export const insertGrowOpportunitySchema = createInsertSchema(growOpportunities).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertGrowRelationship = z.infer<typeof insertGrowRelationshipSchema>;
export type InsertGrowActivity = z.infer<typeof insertGrowActivitySchema>;
export type InsertGrowOpportunity = z.infer<typeof insertGrowOpportunitySchema>;

export type GrowRelationship = typeof growRelationships.$inferSelect;
export type GrowActivity = typeof growActivities.$inferSelect;
export type GrowOpportunity = typeof growOpportunities.$inferSelect;
