ALTER TABLE "automation_actions" ADD COLUMN "failure_classification" text;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "next_retry_eligible_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "cancelled_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "resolved_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "last_failure_classification" text;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "next_retry_eligible_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "cancelled_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "resolved_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD COLUMN "resolved_at" timestamp;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_actions" ADD CONSTRAINT "automation_actions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;