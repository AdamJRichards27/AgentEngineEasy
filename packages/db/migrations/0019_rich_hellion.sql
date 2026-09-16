CREATE TABLE "grow_consent_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"channel" text NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent_id" integer,
	"dncr_status_id" integer,
	"suppression_id" integer,
	"policy_version_id" integer,
	"jurisdiction" text,
	"policy_version" text,
	"evaluated_at" timestamp DEFAULT now() NOT NULL,
	"decided_by_user_id" integer,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_consent_policy_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"jurisdiction" text NOT NULL,
	"version" text NOT NULL,
	"effective_at" timestamp NOT NULL,
	"retired_at" timestamp,
	"allow_inferred_consent" boolean DEFAULT false NOT NULL,
	"dncr_required" boolean DEFAULT true NOT NULL,
	"suppression_enabled" boolean DEFAULT true NOT NULL,
	"time_zone" text,
	"allowed_hours_start" text,
	"allowed_hours_end" text,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"policy_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_contact_channel_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'UNKNOWN' NOT NULL,
	"source" text NOT NULL,
	"captured_at" timestamp DEFAULT now() NOT NULL,
	"capture_method" text NOT NULL,
	"purpose" text NOT NULL,
	"scope" text NOT NULL,
	"evidence_reference" text,
	"evidence" jsonb,
	"jurisdiction" text,
	"recorded_by_user_id" integer NOT NULL,
	"expires_at" timestamp,
	"review_at" timestamp,
	"withdrawn_at" timestamp,
	"withdrawn_by_user_id" integer,
	"withdrawal_reason" text,
	"inferred_reasoning" text,
	"relationship_evidence" jsonb,
	"not_required_justification" text,
	"supersedes_consent_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grow_contact_channel_consents_inferred_evidence_check" CHECK (state <> 'INFERRED' OR (
        length(trim(coalesce(inferred_reasoning, ''))) > 0
        AND length(trim(coalesce(evidence_reference, ''))) > 0
        AND relationship_evidence IS NOT NULL
      )),
	CONSTRAINT "grow_contact_channel_consents_not_required_justification_check" CHECK (state <> 'NOT_REQUIRED' OR length(trim(coalesce(not_required_justification, ''))) > 0),
	CONSTRAINT "grow_contact_channel_consents_withdrawal_fields_check" CHECK (state <> 'WITHDRAWN' OR (
        withdrawn_at IS NOT NULL
        AND withdrawn_by_user_id IS NOT NULL
        AND length(trim(coalesce(withdrawal_reason, ''))) > 0
      ))
);
--> statement-breakpoint
CREATE TABLE "grow_contact_channel_suppressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'SUPPRESSED' NOT NULL,
	"reason" text NOT NULL,
	"effective_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"reference" text,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grow_contact_dncr_statuses" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"channel" text NOT NULL,
	"jurisdiction" text,
	"status" text DEFAULT 'NOT_CHECKED' NOT NULL,
	"checked_at" timestamp DEFAULT now() NOT NULL,
	"valid_until" timestamp,
	"review_at" timestamp,
	"source" text NOT NULL,
	"reference" text,
	"response_metadata" jsonb,
	"recorded_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grow_contact_dncr_statuses_cleared_reference_check" CHECK (status <> 'CLEARED' OR length(trim(coalesce(reference, ''))) > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "brokerage_id" integer;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_consent_id_grow_contact_channel_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."grow_contact_channel_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_dncr_status_id_grow_contact_dncr_statuses_id_fk" FOREIGN KEY ("dncr_status_id") REFERENCES "public"."grow_contact_dncr_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_suppression_id_grow_contact_channel_suppressions_id_fk" FOREIGN KEY ("suppression_id") REFERENCES "public"."grow_contact_channel_suppressions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_policy_version_id_grow_consent_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."grow_consent_policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_decisions" ADD CONSTRAINT "grow_consent_decisions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_policy_versions" ADD CONSTRAINT "grow_consent_policy_versions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_consent_policy_versions" ADD CONSTRAINT "grow_consent_policy_versions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_withdrawn_by_user_id_users_id_fk" FOREIGN KEY ("withdrawn_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_consents" ADD CONSTRAINT "grow_contact_channel_consents_supersedes_consent_id_grow_contact_channel_consents_id_fk" FOREIGN KEY ("supersedes_consent_id") REFERENCES "public"."grow_contact_channel_consents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_suppressions" ADD CONSTRAINT "grow_contact_channel_suppressions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_suppressions" ADD CONSTRAINT "grow_contact_channel_suppressions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_channel_suppressions" ADD CONSTRAINT "grow_contact_channel_suppressions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_dncr_statuses" ADD CONSTRAINT "grow_contact_dncr_statuses_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_dncr_statuses" ADD CONSTRAINT "grow_contact_dncr_statuses_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_contact_dncr_statuses" ADD CONSTRAINT "grow_contact_dncr_statuses_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grow_consent_decisions_brokerage_party_channel_idx" ON "grow_consent_decisions" USING btree ("brokerage_id","party_id","channel","evaluated_at");--> statement-breakpoint
CREATE INDEX "grow_consent_decisions_brokerage_decision_idx" ON "grow_consent_decisions" USING btree ("brokerage_id","decision");--> statement-breakpoint
CREATE UNIQUE INDEX "grow_consent_policy_versions_brokerage_jurisdiction_version_unique" ON "grow_consent_policy_versions" USING btree ("brokerage_id","jurisdiction","version");--> statement-breakpoint
CREATE INDEX "grow_consent_policy_versions_brokerage_jurisdiction_effective_idx" ON "grow_consent_policy_versions" USING btree ("brokerage_id","jurisdiction","effective_at");--> statement-breakpoint
CREATE INDEX "grow_contact_channel_consents_brokerage_party_channel_idx" ON "grow_contact_channel_consents" USING btree ("brokerage_id","party_id","channel","captured_at");--> statement-breakpoint
CREATE INDEX "grow_contact_channel_consents_brokerage_state_idx" ON "grow_contact_channel_consents" USING btree ("brokerage_id","state");--> statement-breakpoint
CREATE INDEX "grow_contact_channel_suppressions_brokerage_party_channel_idx" ON "grow_contact_channel_suppressions" USING btree ("brokerage_id","party_id","channel","effective_at");--> statement-breakpoint
CREATE INDEX "grow_contact_dncr_statuses_brokerage_party_channel_idx" ON "grow_contact_dncr_statuses" USING btree ("brokerage_id","party_id","channel","checked_at");--> statement-breakpoint
CREATE INDEX "grow_contact_dncr_statuses_brokerage_status_idx" ON "grow_contact_dncr_statuses" USING btree ("brokerage_id","status");--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_brokerage_idx" ON "audit_logs" USING btree ("brokerage_id","created_at");