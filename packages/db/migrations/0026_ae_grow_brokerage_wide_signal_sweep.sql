-- AE GROW "Brokerage-wide Signal Sweep" — stage 1 (FOUNDATION).
--
-- STRICTLY ADDITIVE. Every statement in this file is one of: CREATE TABLE,
-- ADD COLUMN (nullable, or NOT NULL with a constant DEFAULT), ADD FOREIGN KEY
-- on a table created by this same migration, or CREATE INDEX. There is no
-- DROP, no RENAME, no type change, no NOT NULL added to an existing column,
-- and no data rewrite — an existing database can apply this with rows in
-- place and every pre-existing grow_opportunity_signals row keeps working
-- unmodified (the five new columns default to NULL / 0).
--
-- grow_opportunity_signals.property_id is deliberately NOT altered: it was
-- already nullable (packages/db/src/schema/propertyIntelligence.ts has never
-- declared .notNull() on it, and the live schema agrees), so contact-anchored
-- signals need no column change at all — only the party-anchored dedupe-key
-- convention and the index below.
--
-- WHY EACH INDEX (the sweep and Grow Today both read these tables
-- brokerage-scoped; grow_relationships, grow_activities, grow_opportunities
-- and appraisals had NO indexes whatsoever before this migration):
--
--   properties_brokerage_idx
--     `appraisals` carries no brokerage_id of its own — it is tenant-scoped
--     only through properties. Every brokerage-scoped appraisal read is
--     therefore driven from `properties where brokerage_id = $1`, which was
--     a full table scan. This index is what makes the three appraisal
--     indexes below reachable.
--
--   appraisals_property_follow_up_idx (partial, status = 'FOLLOW_UP')
--     Serves the stale_previous_appraisal rule's FOLLOW_UP branch and Grow
--     Today Rule E (appraisal follow-ups due), which read exactly this slice.
--   appraisals_property_deferred_outcome_idx (partial, outcome = 'DEFERRED')
--     Serves the stale_previous_appraisal rule's DEFERRED branch.
--   appraisals_property_updated_at_idx
--     Serves the sweep's per-brokerage change-detection probe
--     (max(appraisals.updated_at) over that brokerage's properties).
--
--   grow_relationships_brokerage_status_type_idx
--     long_ownership_tenure and past_buyer_interest both scan
--     (brokerage_id, status='Active') and discriminate on relationship_type;
--     Grow Today Rule D reads the same slice.
--   grow_relationships_brokerage_updated_at_idx
--     Change-detection probe (max(updated_at) for one brokerage).
--   grow_relationships_brokerage_party_idx
--     Contact-anchored evaluation (property-less relationships) and the
--     Contact 360 / Relationship Timeline reads.
--
--   grow_activities_brokerage_party_occurred_idx
--     Grow Today folds every activity in a brokerage down to a
--     last-activity-per-party map; this turns that into one brokerage's
--     slice in party/recency order.
--   grow_activities_brokerage_recorded_at_idx
--     Change-detection probe (grow_activities is append-only and has no
--     updated_at, so recorded_at is its mutation high-water mark).
--
--   grow_opportunities_brokerage_party_property_idx
--     past_buyer_interest's "does this (party, property) already have an
--     opportunity?" test — previously one SELECT per candidate against an
--     unindexed table, now a single set-based anti-join per brokerage.
--   grow_opportunities_brokerage_status_idx
--     Grow Today Rules A/B/C read (brokerage_id, status='Open') per request.
--   grow_opportunities_brokerage_updated_at_idx
--     Change-detection probe.
--
--   grow_opportunity_signals_brokerage_status_expires_idx
--     Sweep-driven, brokerage-wide expiry (Active rows past expires_at),
--     replacing the per-property lazy read-time expiry.
--   grow_opportunity_signals_brokerage_party_status_idx (partial, party_id NOT NULL)
--     Contact-anchored reads and the sweep's contactability filter.
--   grow_opportunity_signals_brokerage_next_review_idx (partial, next_review_at NOT NULL)
--     The bounded re-review scan. NULL next_review_at is permanently
--     terminal and must never be scanned, hence the partial index.
--
-- OPERATIONAL NOTE: these CREATE INDEX statements take a brief ACCESS
-- EXCLUSIVE lock (drizzle's migrator runs them in a transaction, so
-- CONCURRENTLY is not available). On the pilot's data volumes that is
-- milliseconds; on a large persistent database, build them out-of-band with
-- CREATE INDEX CONCURRENTLY first and this migration then becomes a no-op
-- for those statements.
CREATE TABLE "grow_signal_sweep_cursors" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"source_high_water_marks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_evaluated_at" timestamp,
	"last_full_evaluation_at" timestamp,
	"last_sweep_run_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_signal_sweep_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"trigger" text DEFAULT 'SCHEDULED' NOT NULL,
	"brokerages_considered" integer DEFAULT 0 NOT NULL,
	"brokerages_evaluated" integer DEFAULT 0 NOT NULL,
	"brokerages_skipped_unchanged" integer DEFAULT 0 NOT NULL,
	"candidates_evaluated" integer DEFAULT 0 NOT NULL,
	"signals_created" integer DEFAULT 0 NOT NULL,
	"signals_updated" integer DEFAULT 0 NOT NULL,
	"signals_re_raised" integer DEFAULT 0 NOT NULL,
	"signals_expired" integer DEFAULT 0 NOT NULL,
	"candidates_suppressed" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD COLUMN "next_review_at" timestamp;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD COLUMN "last_swept_at" timestamp;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD COLUMN "evidence_fingerprint" text;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD COLUMN "re_raise_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD COLUMN "prior_decision" jsonb;--> statement-breakpoint
ALTER TABLE "grow_signal_sweep_cursors" ADD CONSTRAINT "grow_signal_sweep_cursors_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grow_signal_sweep_cursors_brokerage_unique" ON "grow_signal_sweep_cursors" USING btree ("brokerage_id");--> statement-breakpoint
CREATE INDEX "properties_brokerage_idx" ON "properties" USING btree ("brokerage_id");--> statement-breakpoint
CREATE INDEX "appraisals_property_follow_up_idx" ON "appraisals" USING btree ("property_id","follow_up_at") WHERE "appraisals"."status" = 'FOLLOW_UP';--> statement-breakpoint
CREATE INDEX "appraisals_property_deferred_outcome_idx" ON "appraisals" USING btree ("property_id","outcome_at") WHERE "appraisals"."outcome" = 'DEFERRED';--> statement-breakpoint
CREATE INDEX "appraisals_property_updated_at_idx" ON "appraisals" USING btree ("property_id","updated_at");--> statement-breakpoint
CREATE INDEX "grow_activities_brokerage_party_occurred_idx" ON "grow_activities" USING btree ("brokerage_id","party_id","occurred_at");--> statement-breakpoint
CREATE INDEX "grow_activities_brokerage_recorded_at_idx" ON "grow_activities" USING btree ("brokerage_id","recorded_at");--> statement-breakpoint
CREATE INDEX "grow_opportunities_brokerage_party_property_idx" ON "grow_opportunities" USING btree ("brokerage_id","party_id","property_id");--> statement-breakpoint
CREATE INDEX "grow_opportunities_brokerage_status_idx" ON "grow_opportunities" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "grow_opportunities_brokerage_updated_at_idx" ON "grow_opportunities" USING btree ("brokerage_id","updated_at");--> statement-breakpoint
CREATE INDEX "grow_relationships_brokerage_status_type_idx" ON "grow_relationships" USING btree ("brokerage_id","status","relationship_type");--> statement-breakpoint
CREATE INDEX "grow_relationships_brokerage_updated_at_idx" ON "grow_relationships" USING btree ("brokerage_id","updated_at");--> statement-breakpoint
CREATE INDEX "grow_relationships_brokerage_party_idx" ON "grow_relationships" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_status_expires_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_party_status_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","party_id","status") WHERE "grow_opportunity_signals"."party_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_next_review_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","next_review_at") WHERE "grow_opportunity_signals"."next_review_at" IS NOT NULL;