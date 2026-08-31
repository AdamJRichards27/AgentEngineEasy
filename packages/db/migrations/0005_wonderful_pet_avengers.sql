CREATE TABLE "campaign_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"launch_plan_id" uuid NOT NULL,
	"property_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"item_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'TO_ORGANISE' NOT NULL,
	"responsible_owner_type" text DEFAULT 'UNASSIGNED_QUEUE' NOT NULL,
	"responsible_user_id" integer,
	"vendor_name" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"cost_approval_required" boolean DEFAULT false NOT NULL,
	"cost_approved_at" timestamp,
	"cost_approved_by" integer,
	"lead_days" integer,
	"due_at" timestamp,
	"completed_at" timestamp,
	"blocked_at" timestamp,
	"blocked_reason" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "launch_plan_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"launch_plan_id" uuid NOT NULL,
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
CREATE TABLE "launch_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"workflow_id" integer,
	"template_type" text NOT NULL,
	"status" text DEFAULT 'PLANNING' NOT NULL,
	"target_launch_date" timestamp,
	"actual_launch_date" timestamp,
	"budget_cents" integer DEFAULT 0 NOT NULL,
	"budget_spent_cents" integer DEFAULT 0 NOT NULL,
	"budget_set_at" timestamp,
	"budget_set_by" integer,
	"market_ready_evaluated_at" timestamp,
	"market_ready_blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"market_ready_overridden_at" timestamp,
	"market_ready_overridden_by" integer,
	"market_ready_override_reason" text,
	"listing_live_confirmed_at" timestamp,
	"listing_live_confirmed_by" integer,
	"paused_at" timestamp,
	"paused_by" integer,
	"pause_reason" text,
	"cancelled_at" timestamp,
	"cancelled_by" integer,
	"cancel_reason" text,
	"created_by" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"launch_plan_id" uuid NOT NULL,
	"property_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"portal_name" text NOT NULL,
	"status" text DEFAULT 'NOT_STARTED' NOT NULL,
	"submitted_at" timestamp,
	"submitted_by" integer,
	"live_confirmed_at" timestamp,
	"live_confirmed_by" integer,
	"failure_reason" text,
	"listing_url" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"launch_plan_id" uuid NOT NULL,
	"campaign_item_id" uuid,
	"property_id" integer NOT NULL,
	"brokerage_id" integer NOT NULL,
	"approval_type" text NOT NULL,
	"requested_amount_cents" integer DEFAULT 0 NOT NULL,
	"approved_amount_cents" integer,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by" integer NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"decided_by" integer,
	"decided_at" timestamp,
	"decision_notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_items" ADD CONSTRAINT "campaign_items_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_items" ADD CONSTRAINT "campaign_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_items" ADD CONSTRAINT "campaign_items_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_items" ADD CONSTRAINT "campaign_items_responsible_user_id_users_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_items" ADD CONSTRAINT "campaign_items_cost_approved_by_users_id_fk" FOREIGN KEY ("cost_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plan_transitions" ADD CONSTRAINT "launch_plan_transitions_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plan_transitions" ADD CONSTRAINT "launch_plan_transitions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plan_transitions" ADD CONSTRAINT "launch_plan_transitions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_budget_set_by_users_id_fk" FOREIGN KEY ("budget_set_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_market_ready_overridden_by_users_id_fk" FOREIGN KEY ("market_ready_overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_listing_live_confirmed_by_users_id_fk" FOREIGN KEY ("listing_live_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launch_plans" ADD CONSTRAINT "launch_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_destinations" ADD CONSTRAINT "portal_destinations_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_destinations" ADD CONSTRAINT "portal_destinations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_destinations" ADD CONSTRAINT "portal_destinations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_destinations" ADD CONSTRAINT "portal_destinations_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_destinations" ADD CONSTRAINT "portal_destinations_live_confirmed_by_users_id_fk" FOREIGN KEY ("live_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_launch_plan_id_launch_plans_id_fk" FOREIGN KEY ("launch_plan_id") REFERENCES "public"."launch_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_campaign_item_id_campaign_items_id_fk" FOREIGN KEY ("campaign_item_id") REFERENCES "public"."campaign_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_approvals" ADD CONSTRAINT "vendor_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_items_launch_plan_idx" ON "campaign_items" USING btree ("launch_plan_id");--> statement-breakpoint
CREATE INDEX "campaign_items_property_status_idx" ON "campaign_items" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "campaign_items_due_at_idx" ON "campaign_items" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "launch_plan_transitions_launch_plan_occurred_idx" ON "launch_plan_transitions" USING btree ("launch_plan_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "launch_plans_property_idx" ON "launch_plans" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "launch_plans_brokerage_status_idx" ON "launch_plans" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE INDEX "portal_destinations_launch_plan_idx" ON "portal_destinations" USING btree ("launch_plan_id");--> statement-breakpoint
CREATE INDEX "portal_destinations_property_status_idx" ON "portal_destinations" USING btree ("property_id","status");--> statement-breakpoint
CREATE INDEX "vendor_approvals_launch_plan_idx" ON "vendor_approvals" USING btree ("launch_plan_id");--> statement-breakpoint
CREATE INDEX "vendor_approvals_brokerage_status_idx" ON "vendor_approvals" USING btree ("brokerage_id","status");