CREATE TABLE "grow_call_review_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"call_session_id" integer NOT NULL,
	"transcription_id" integer NOT NULL,
	"item_type" text NOT NULL,
	"item_id" text NOT NULL,
	"action_request_id" integer NOT NULL,
	"commitment_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "grow_call_review_links_item_type_check" CHECK ("grow_call_review_links"."item_type" in ('COMMITMENT', 'FOLLOWUP')),
	CONSTRAINT "grow_call_review_links_item_id_check" CHECK (length("grow_call_review_links"."item_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "grow_call_review_links" ADD CONSTRAINT "grow_call_review_links_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_review_links" ADD CONSTRAINT "grow_call_review_links_call_session_id_grow_call_sessions_id_fk" FOREIGN KEY ("call_session_id") REFERENCES "public"."grow_call_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_review_links" ADD CONSTRAINT "grow_call_review_links_transcription_id_grow_call_transcriptions_id_fk" FOREIGN KEY ("transcription_id") REFERENCES "public"."grow_call_transcriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_review_links" ADD CONSTRAINT "grow_call_review_links_action_request_id_ai_action_requests_id_fk" FOREIGN KEY ("action_request_id") REFERENCES "public"."ai_action_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grow_call_review_links" ADD CONSTRAINT "grow_call_review_links_commitment_id_grow_commitments_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."grow_commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grow_call_review_links_action_request_uidx" ON "grow_call_review_links" USING btree ("action_request_id");--> statement-breakpoint
CREATE INDEX "grow_call_review_links_item_idx" ON "grow_call_review_links" USING btree ("brokerage_id","transcription_id","item_type","item_id");--> statement-breakpoint
CREATE INDEX "grow_call_review_links_commitment_idx" ON "grow_call_review_links" USING btree ("commitment_id");
--> statement-breakpoint
-- One-time backfill of call-review proposals that were joined only by
-- resource_id. This is the only place that pattern is parsed. It does not
-- rewrite ai_action_requests, so input_payload hashes stay valid. Rows
-- whose transcription is not in the same brokerage are skipped.
INSERT INTO "grow_call_review_links" (
  "brokerage_id",
  "call_session_id",
  "transcription_id",
  "item_type",
  "item_id",
  "action_request_id",
  "commitment_id"
)
SELECT
  parsed.brokerage_id,
  transcription.call_session_id,
  transcription.id,
  parsed.parts[2],
  parsed.parts[3],
  parsed.action_request_id,
  commitment.id
FROM (
  SELECT
    ai_action_requests.id AS action_request_id,
    ai_action_requests.brokerage_id,
    ai_action_requests.execution_result,
    regexp_match(ai_action_requests.resource_id, '^transcription:([0-9]+):item:(COMMITMENT|FOLLOWUP):(.+)$') AS parts
  FROM ai_action_requests
  WHERE ai_action_requests.action_key = 'CREATE_GROW_COMMITMENT'
    AND ai_action_requests.resource_id ~ '^transcription:[0-9]+:item:(COMMITMENT|FOLLOWUP):.+$'
) parsed
JOIN grow_call_transcriptions transcription
  ON transcription.id = parsed.parts[1]::integer
 AND transcription.brokerage_id = parsed.brokerage_id
LEFT JOIN grow_commitments commitment
  ON commitment.brokerage_id = parsed.brokerage_id
 AND parsed.execution_result IS NOT NULL
 AND jsonb_typeof(parsed.execution_result) = 'object'
 AND (parsed.execution_result->>'id') ~ '^[0-9]+$'
 AND commitment.id = (parsed.execution_result->>'id')::integer;