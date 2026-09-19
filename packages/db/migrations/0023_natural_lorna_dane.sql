CREATE TABLE "grow_call_transcriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"call_session_id" integer NOT NULL,
	"party_id" integer NOT NULL,
	"recording_reference" integer NOT NULL,
	"processing_state" text DEFAULT 'PENDING' NOT NULL,
	"transcription_provider_reference" text,
	"transcript" text,
	"draft_summary" text,
	"draft_key_points" jsonb,
	"draft_commitments" jsonb,
	"draft_followups" jsonb,
	"review_state" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"retry_count" integer DEFAULT 0,
	"last_error" text,
	"approved_by" integer,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grow_call_transcriptions_processing_state_check" CHECK ("grow_call_transcriptions"."processing_state" in ('PENDING', 'MEDIA_PROCESSING', 'TRANSCRIBING', 'AWAITING_AGENT_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'DISCARDED', 'FAILED', 'DELETION_SCHEDULED', 'DELETED')),
	CONSTRAINT "grow_call_transcriptions_draft_key_points_array_check" CHECK (jsonb_typeof("grow_call_transcriptions"."draft_key_points") = 'array'),
	CONSTRAINT "grow_call_transcriptions_draft_commitments_array_check" CHECK (jsonb_typeof("grow_call_transcriptions"."draft_commitments") = 'array'),
	CONSTRAINT "grow_call_transcriptions_draft_followups_array_check" CHECK (jsonb_typeof("grow_call_transcriptions"."draft_followups") = 'array'),
	CONSTRAINT "grow_call_transcriptions_review_state_array_check" CHECK (jsonb_typeof("grow_call_transcriptions"."review_state") = 'array'),
	CONSTRAINT "grow_call_transcriptions_retry_count_check" CHECK ("grow_call_transcriptions"."retry_count" >= 0),
	CONSTRAINT "grow_call_transcriptions_approval_metadata_check" CHECK (("grow_call_transcriptions"."approved_by" is null) = ("grow_call_transcriptions"."approved_at" is null))
);
--> statement-breakpoint
ALTER TABLE "grow_call_transcriptions" ADD CONSTRAINT "grow_call_transcriptions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_transcriptions" ADD CONSTRAINT "grow_call_transcriptions_call_session_id_grow_call_sessions_id_fk" FOREIGN KEY ("call_session_id") REFERENCES "public"."grow_call_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_transcriptions" ADD CONSTRAINT "grow_call_transcriptions_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_transcriptions" ADD CONSTRAINT "grow_call_transcriptions_recording_reference_document_object_versions_id_fk" FOREIGN KEY ("recording_reference") REFERENCES "public"."document_object_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_transcriptions" ADD CONSTRAINT "grow_call_transcriptions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grow_call_transcriptions_brokerage_call_session_idx" ON "grow_call_transcriptions" USING btree ("brokerage_id","call_session_id");--> statement-breakpoint
CREATE INDEX "grow_call_transcriptions_brokerage_party_idx" ON "grow_call_transcriptions" USING btree ("brokerage_id","party_id");--> statement-breakpoint
CREATE INDEX "grow_call_transcriptions_brokerage_processing_state_idx" ON "grow_call_transcriptions" USING btree ("brokerage_id","processing_state");--> statement-breakpoint
CREATE INDEX "grow_call_transcriptions_recording_reference_idx" ON "grow_call_transcriptions" USING btree ("recording_reference");