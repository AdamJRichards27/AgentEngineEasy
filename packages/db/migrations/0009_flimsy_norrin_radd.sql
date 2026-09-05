CREATE TABLE "financial_payment_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp,
	"idempotency_key" text NOT NULL,
	"correlation_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connection_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"brokerage_id" integer NOT NULL,
	"transition_type" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_user_id" integer,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"purpose" text NOT NULL,
	"environment_classification" text DEFAULT 'MOCK' NOT NULL,
	"requested_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" integer NOT NULL,
	"requested_at" timestamp,
	"approved_by" integer,
	"approved_at" timestamp,
	"rejected_by" integer,
	"rejected_at" timestamp,
	"reject_reason" text,
	"authority_user_id" integer,
	"last_validated_at" timestamp,
	"last_validation_result" jsonb,
	"activated_at" timestamp,
	"activated_by" integer,
	"suspended_at" timestamp,
	"suspended_by" integer,
	"suspend_reason" text,
	"revoked_at" timestamp,
	"revoked_by" integer,
	"revoke_reason" text,
	"expired_at" timestamp,
	"health_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"health_checked_at" timestamp,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"reference_type" text NOT NULL,
	"secret_identifier" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" integer,
	"revoked_at" timestamp,
	"revoked_by" integer,
	CONSTRAINT "integration_credentials_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "integration_dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"reason" text NOT NULL,
	"payload_snapshot" jsonb NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"replayed_at" timestamp,
	"replayed_by" integer,
	"replay_result" text,
	"replay_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_external_mappings" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"brokerage_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"internal_id" text NOT NULL,
	"external_id" text NOT NULL,
	"external_ref" jsonb,
	"sync_cursor" text,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"brokerage_id" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_status" text DEFAULT 'PENDING' NOT NULL,
	"processing_error" text,
	"related_outbox_id" uuid
);
--> statement-breakpoint
CREATE TABLE "integration_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"command_payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"last_error" text,
	"dispatched_at" timestamp,
	"idempotency_key" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"source_record_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_outbox_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"outbox_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"provider_response_summary" text,
	"error_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"environment_classification" text DEFAULT 'MOCK' NOT NULL,
	"is_built_in" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_active_connections" integer DEFAULT 10 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "integration_settings_brokerage_id_unique" UNIQUE("brokerage_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "session_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "financial_payment_outbox" ADD CONSTRAINT "financial_payment_outbox_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_outbox" ADD CONSTRAINT "financial_payment_outbox_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_transitions" ADD CONSTRAINT "integration_connection_transitions_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_transitions" ADD CONSTRAINT "integration_connection_transitions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connection_transitions" ADD CONSTRAINT "integration_connection_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_provider_id_integration_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."integration_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_authority_user_id_users_id_fk" FOREIGN KEY ("authority_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_dead_letters" ADD CONSTRAINT "integration_dead_letters_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_dead_letters" ADD CONSTRAINT "integration_dead_letters_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_dead_letters" ADD CONSTRAINT "integration_dead_letters_replayed_by_users_id_fk" FOREIGN KEY ("replayed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_external_mappings" ADD CONSTRAINT "integration_external_mappings_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_external_mappings" ADD CONSTRAINT "integration_external_mappings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_inbox" ADD CONSTRAINT "integration_inbox_related_outbox_id_integration_outbox_id_fk" FOREIGN KEY ("related_outbox_id") REFERENCES "public"."integration_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_outbox" ADD CONSTRAINT "integration_outbox_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_outbox" ADD CONSTRAINT "integration_outbox_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_outbox_attempts" ADD CONSTRAINT "integration_outbox_attempts_outbox_id_integration_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."integration_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_settings" ADD CONSTRAINT "integration_settings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_payment_outbox_payment_request_action_idx" ON "financial_payment_outbox" USING btree ("payment_request_id","action");--> statement-breakpoint
CREATE INDEX "financial_payment_outbox_status_next_attempt_idx" ON "financial_payment_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_connection_transitions_connection_occurred_idx" ON "integration_connection_transitions" USING btree ("connection_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_connections_brokerage_status_idx" ON "integration_connections" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "integration_connections_provider_idx" ON "integration_connections" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "integration_dead_letters_brokerage_occurred_idx" ON "integration_dead_letters" USING btree ("brokerage_id","occurred_at");--> statement-breakpoint
CREATE INDEX "integration_dead_letters_connection_idx" ON "integration_dead_letters" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_external_mappings_internal_idx" ON "integration_external_mappings" USING btree ("connection_id","entity_type","internal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_external_mappings_external_idx" ON "integration_external_mappings" USING btree ("connection_id","entity_type","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_inbox_dedup_idx" ON "integration_inbox" USING btree ("connection_id","provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "integration_inbox_connection_received_idx" ON "integration_inbox" USING btree ("connection_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_outbox_idempotency_key_idx" ON "integration_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_outbox_status_next_attempt_idx" ON "integration_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "integration_outbox_connection_idx" ON "integration_outbox" USING btree ("connection_id","status");--> statement-breakpoint
CREATE INDEX "integration_outbox_attempts_outbox_idx" ON "integration_outbox_attempts" USING btree ("outbox_id","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_reconciliations_legacy_commission_unique_idx" ON "financial_reconciliations" USING btree ("brokerage_id","record_id") WHERE "financial_reconciliations"."record_type" = 'LEGACY_TRANSACTION_COMMISSION';