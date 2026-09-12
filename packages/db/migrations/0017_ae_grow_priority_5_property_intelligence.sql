CREATE TABLE "grow_opportunity_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer,
	"property_id" integer,
	"signal_type" text NOT NULL,
	"title" text NOT NULL,
	"explanation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"source" text NOT NULL,
	"source_timestamp" timestamp,
	"computed_at" timestamp DEFAULT now() NOT NULL,
	"confidence_band" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"dedupe_key" text NOT NULL,
	"expires_at" timestamp,
	"dismissed_reason" text,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp,
	"promoted_opportunity_id" integer,
	"score_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_external_identifiers" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"match_confidence" numeric,
	"match_reasons" jsonb,
	"status" text DEFAULT 'PendingReview' NOT NULL,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp,
	"rejected_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_provider_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"observation_type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"payload" jsonb NOT NULL,
	"source_timestamp" timestamp,
	"retrieved_at" timestamp DEFAULT now() NOT NULL,
	"superseded_by_observation_id" integer,
	"is_current" boolean DEFAULT true NOT NULL,
	"licence_expires_at" timestamp,
	"retention_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "latitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "longitude" numeric(10, 7);--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "data_quality_status" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "last_enriched_at" timestamp;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD CONSTRAINT "grow_opportunity_signals_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD CONSTRAINT "grow_opportunity_signals_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD CONSTRAINT "grow_opportunity_signals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD CONSTRAINT "grow_opportunity_signals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_opportunity_signals" ADD CONSTRAINT "grow_opportunity_signals_promoted_opportunity_id_grow_opportunities_id_fk" FOREIGN KEY ("promoted_opportunity_id") REFERENCES "public"."grow_opportunities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_external_identifiers" ADD CONSTRAINT "property_external_identifiers_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_external_identifiers" ADD CONSTRAINT "property_external_identifiers_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_external_identifiers" ADD CONSTRAINT "property_external_identifiers_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_provider_observations" ADD CONSTRAINT "property_provider_observations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_provider_observations" ADD CONSTRAINT "property_provider_observations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_property_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","property_id");--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_party_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_opportunity_signals_brokerage_status_idx" ON "grow_opportunity_signals" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "grow_opportunity_signals_dedupe_key_unique" ON "grow_opportunity_signals" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "property_external_identifiers_brokerage_property_idx" ON "property_external_identifiers" USING btree ("brokerage_id","property_id");--> statement-breakpoint
CREATE INDEX "property_external_identifiers_brokerage_status_idx" ON "property_external_identifiers" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "property_external_identifiers_provider_external_id_unique" ON "property_external_identifiers" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "property_provider_observations_brokerage_property_idx" ON "property_provider_observations" USING btree ("brokerage_id","property_id");--> statement-breakpoint
CREATE INDEX "property_provider_observations_property_type_current_idx" ON "property_provider_observations" USING btree ("property_id","observation_type","is_current");
