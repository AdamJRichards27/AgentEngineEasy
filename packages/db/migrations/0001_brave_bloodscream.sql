CREATE TABLE "automation_attention_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer,
	"reason_code" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"resolved_by_user_id" integer,
	"resolved_at" timestamp,
	"resolution_note" text,
	"originating_event_id" uuid,
	"originating_execution_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer,
	"task_key" text NOT NULL,
	"kind" text DEFAULT 'TASK' NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"assigned_role" text,
	"due_at" timestamp,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"superseded_by_task_id" uuid,
	"originating_event_id" uuid,
	"originating_execution_id" uuid,
	"originating_field" text,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_originating_event_id_domain_events_id_fk" FOREIGN KEY ("originating_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_attention_items" ADD CONSTRAINT "automation_attention_items_originating_execution_id_automation_executions_id_fk" FOREIGN KEY ("originating_execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_originating_event_id_domain_events_id_fk" FOREIGN KEY ("originating_event_id") REFERENCES "public"."domain_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_tasks" ADD CONSTRAINT "automation_tasks_originating_execution_id_automation_executions_id_fk" FOREIGN KEY ("originating_execution_id") REFERENCES "public"."automation_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_attention_items_transaction_reason_idx" ON "automation_attention_items" USING btree ("transaction_id","reason_code","status");--> statement-breakpoint
CREATE INDEX "automation_attention_items_property_reason_idx" ON "automation_attention_items" USING btree ("property_id","reason_code","status");--> statement-breakpoint
CREATE INDEX "automation_tasks_transaction_task_key_idx" ON "automation_tasks" USING btree ("transaction_id","task_key","status");--> statement-breakpoint
CREATE INDEX "automation_tasks_property_task_key_idx" ON "automation_tasks" USING btree ("property_id","task_key","status");