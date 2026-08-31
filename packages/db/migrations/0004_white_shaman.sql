CREATE TABLE "risk_exception_scan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"trigger" text DEFAULT 'SCHEDULED' NOT NULL,
	"brokerages_scanned" integer DEFAULT 0 NOT NULL,
	"rules_evaluated" integer DEFAULT 0 NOT NULL,
	"exceptions_created" integer DEFAULT 0 NOT NULL,
	"exceptions_updated" integer DEFAULT 0 NOT NULL,
	"exceptions_auto_resolved" integer DEFAULT 0 NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "risk_exception_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exception_id" uuid NOT NULL,
	"brokerage_id" integer NOT NULL,
	"transition_type" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"reason" text,
	"actor_type" text NOT NULL,
	"actor_user_id" integer,
	"rule_version" integer,
	"metadata" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer,
	"rule_id" text NOT NULL,
	"rule_version" integer DEFAULT 1 NOT NULL,
	"category" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"problem_description" text NOT NULL,
	"business_impact" text NOT NULL,
	"detected_cause" text NOT NULL,
	"owner_type" text DEFAULT 'UNASSIGNED_QUEUE' NOT NULL,
	"owner_user_id" integer,
	"reassignment_count" integer DEFAULT 0 NOT NULL,
	"detected_at" timestamp DEFAULT now() NOT NULL,
	"due_at" timestamp,
	"escalates_at" timestamp,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"recommended_action" text NOT NULL,
	"resolution_requirements" text NOT NULL,
	"dismissible" boolean DEFAULT false NOT NULL,
	"resolution_evidence" jsonb,
	"resolved_at" timestamp,
	"resolved_by_user_id" integer,
	"resolution_method" text,
	"dismissal_reason" text,
	"source_record_type" text NOT NULL,
	"source_record_id" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"causation_id" uuid,
	"related_task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_execution_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"open_dedup_key" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"last_detected_at" timestamp DEFAULT now() NOT NULL,
	"last_evaluated_at" timestamp DEFAULT now() NOT NULL,
	"previous_occurrence_id" uuid,
	"metadata" jsonb,
	"requires_financial_entitlement" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_exception_transitions" ADD CONSTRAINT "risk_exception_transitions_exception_id_risk_exceptions_id_fk" FOREIGN KEY ("exception_id") REFERENCES "public"."risk_exceptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exception_transitions" ADD CONSTRAINT "risk_exception_transitions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exception_transitions" ADD CONSTRAINT "risk_exception_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exceptions" ADD CONSTRAINT "risk_exceptions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exceptions" ADD CONSTRAINT "risk_exceptions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exceptions" ADD CONSTRAINT "risk_exceptions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exceptions" ADD CONSTRAINT "risk_exceptions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_exceptions" ADD CONSTRAINT "risk_exceptions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "risk_exception_transitions_exception_occurred_idx" ON "risk_exception_transitions" USING btree ("exception_id","occurred_at");--> statement-breakpoint
CREATE INDEX "risk_exception_transitions_brokerage_occurred_idx" ON "risk_exception_transitions" USING btree ("brokerage_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "risk_exceptions_open_dedup_key_idx" ON "risk_exceptions" USING btree ("open_dedup_key");--> statement-breakpoint
CREATE INDEX "risk_exceptions_brokerage_status_idx" ON "risk_exceptions" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "risk_exceptions_property_status_idx" ON "risk_exceptions" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "risk_exceptions_transaction_status_idx" ON "risk_exceptions" USING btree ("transaction_id","status");--> statement-breakpoint
CREATE INDEX "risk_exceptions_brokerage_severity_idx" ON "risk_exceptions" USING btree ("brokerage_id","severity","status");--> statement-breakpoint
CREATE INDEX "risk_exceptions_due_at_idx" ON "risk_exceptions" USING btree ("due_at");