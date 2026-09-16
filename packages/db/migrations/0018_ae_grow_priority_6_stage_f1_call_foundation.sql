CREATE TABLE "grow_call_recording_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"source" text NOT NULL,
	"jurisdiction" text,
	"consent_version" text,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"captured_by_user_id" integer NOT NULL,
	"expires_at" timestamp,
	"withdrawn_at" timestamp,
	"withdrawn_by_user_id" integer,
	"withdrawal_reason" text,
	"evidence_metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_call_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"initiated_by_user_id" integer NOT NULL,
	"destination_raw" text NOT NULL,
	"destination_normalized" text NOT NULL,
	"destination_country" text NOT NULL,
	"provider" text DEFAULT 'sandbox' NOT NULL,
	"provider_call_id" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"recording_requested" boolean DEFAULT false NOT NULL,
	"recording_permitted" boolean DEFAULT false NOT NULL,
	"recording_consent_id" integer,
	"recording_status" text DEFAULT 'NOT_REQUESTED' NOT NULL,
	"transcription_status" text DEFAULT 'NOT_APPLICABLE' NOT NULL,
	"confirmed_at" timestamp,
	"started_at" timestamp,
	"answered_at" timestamp,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"failure_reason" text,
	"cancelled_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_call_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"related_call_session_id" integer,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_status" text DEFAULT 'PENDING' NOT NULL,
	"processing_error" text
);
--> statement-breakpoint
ALTER TABLE "grow_call_recording_consents" ADD CONSTRAINT "grow_call_recording_consents_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_recording_consents" ADD CONSTRAINT "grow_call_recording_consents_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_recording_consents" ADD CONSTRAINT "grow_call_recording_consents_captured_by_user_id_users_id_fk" FOREIGN KEY ("captured_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_recording_consents" ADD CONSTRAINT "grow_call_recording_consents_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_sessions" ADD CONSTRAINT "grow_call_sessions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_sessions" ADD CONSTRAINT "grow_call_sessions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_sessions" ADD CONSTRAINT "grow_call_sessions_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_sessions" ADD CONSTRAINT "grow_call_sessions_recording_consent_id_grow_call_recording_consents_id_fk" FOREIGN KEY ("recording_consent_id") REFERENCES "public"."grow_call_recording_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_webhook_events" ADD CONSTRAINT "grow_call_webhook_events_related_call_session_id_grow_call_sessions_id_fk" FOREIGN KEY ("related_call_session_id") REFERENCES "public"."grow_call_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grow_call_recording_consents_brokerage_party_idx" ON "grow_call_recording_consents" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_call_recording_consents_brokerage_status_idx" ON "grow_call_recording_consents" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "grow_call_sessions_brokerage_party_idx" ON "grow_call_sessions" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_call_sessions_brokerage_status_idx" ON "grow_call_sessions" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "grow_call_sessions_provider_call_id_unique" ON "grow_call_sessions" USING btree ("provider","provider_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grow_call_webhook_events_dedup_idx" ON "grow_call_webhook_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "grow_call_webhook_events_related_call_session_idx" ON "grow_call_webhook_events" USING btree ("related_call_session_id");
