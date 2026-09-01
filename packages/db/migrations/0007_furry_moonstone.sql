CREATE TABLE "communication_consent" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"party_id" integer,
	"destination" text NOT NULL,
	"channel" text NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"transactional_opt_out" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"recorded_by_user_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_cost_ledger" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" integer NOT NULL,
	"period_key" text NOT NULL,
	"channel" text NOT NULL,
	"message_count" integer DEFAULT 0 NOT NULL,
	"cost_estimate_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_delivery_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"attempt_number" integer NOT NULL,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"provider_response_code" text,
	"provider_response_summary" text,
	"error_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"classification" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"sender_user_id" integer,
	"send_on_behalf_of_user_id" integer,
	"recipient_participant_id" integer,
	"recipient_display_name" text,
	"recipient_destination" text,
	"template_id" integer,
	"template_version" integer,
	"provider" text,
	"provider_message_id" text,
	"idempotency_key" text,
	"reply_to_message_id" integer,
	"scheduled_at" timestamp,
	"sent_at" timestamp,
	"delivered_at" timestamp,
	"failed_at" timestamp,
	"failure_category" text,
	"failure_detail" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 3 NOT NULL,
	"cost_estimate_cents" integer,
	"cost_actual_cents" integer,
	"correlation_id" uuid,
	"causation_id" uuid,
	"created_by_user_id" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"party_id" integer,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"mobile" text,
	"is_manual_entry" boolean DEFAULT false NOT NULL,
	"manual_entry_reason" text,
	"added_by_user_id" integer,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"time_zone" text,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"sms_soft_threshold_cents" integer DEFAULT 5000 NOT NULL,
	"sms_hard_threshold_cents" integer DEFAULT 20000 NOT NULL,
	"transactional_opt_out_allowed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "communication_settings_brokerage_id_unique" UNIQUE("brokerage_id")
);
--> statement-breakpoint
CREATE TABLE "communication_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"channel" text NOT NULL,
	"classification" text NOT NULL,
	"category" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"subject" text,
	"body_text" text NOT NULL,
	"body_html" text,
	"placeholders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"activated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "communication_threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer,
	"subject" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"related_message_id" integer,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"processing_status" text DEFAULT 'PENDING' NOT NULL,
	"processing_error" text
);
--> statement-breakpoint
ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_consent" ADD CONSTRAINT "communication_consent_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_cost_ledger" ADD CONSTRAINT "communication_cost_ledger_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_delivery_attempts" ADD CONSTRAINT "communication_delivery_attempts_message_id_communication_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."communication_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_thread_id_communication_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."communication_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_send_on_behalf_of_user_id_users_id_fk" FOREIGN KEY ("send_on_behalf_of_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_recipient_participant_id_communication_participants_id_fk" FOREIGN KEY ("recipient_participant_id") REFERENCES "public"."communication_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_template_id_communication_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."communication_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_reply_to_message_id_communication_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."communication_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_messages" ADD CONSTRAINT "communication_messages_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_thread_id_communication_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."communication_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_participants" ADD CONSTRAINT "communication_participants_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_settings" ADD CONSTRAINT "communication_settings_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_templates" ADD CONSTRAINT "communication_templates_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_templates" ADD CONSTRAINT "communication_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_threads" ADD CONSTRAINT "communication_threads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_webhook_events" ADD CONSTRAINT "communication_webhook_events_related_message_id_communication_messages_id_fk" FOREIGN KEY ("related_message_id") REFERENCES "public"."communication_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "communication_consent_destination_idx" ON "communication_consent" USING btree ("brokerage_id","destination","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_cost_ledger_scope_idx" ON "communication_cost_ledger" USING btree ("brokerage_id","scope_type","scope_id","period_key","channel");--> statement-breakpoint
CREATE INDEX "communication_delivery_attempts_message_idx" ON "communication_delivery_attempts" USING btree ("message_id","attempted_at");--> statement-breakpoint
CREATE INDEX "communication_messages_thread_idx" ON "communication_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "communication_messages_property_idx" ON "communication_messages" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "communication_messages_brokerage_status_idx" ON "communication_messages" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_messages_idempotency_key_idx" ON "communication_messages" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "communication_participants_thread_idx" ON "communication_participants" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "communication_templates_key_version_idx" ON "communication_templates" USING btree ("template_key","version");--> statement-breakpoint
CREATE INDEX "communication_templates_brokerage_status_idx" ON "communication_templates" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "communication_threads_property_idx" ON "communication_threads" USING btree ("property_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "communication_threads_brokerage_idx" ON "communication_threads" USING btree ("brokerage_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_webhook_events_dedup_idx" ON "communication_webhook_events" USING btree ("provider","provider_event_id");