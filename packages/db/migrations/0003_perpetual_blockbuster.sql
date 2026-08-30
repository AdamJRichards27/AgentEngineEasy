CREATE TABLE "transaction_conditions" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"description" text NOT NULL,
	"due_date" timestamp,
	"due_date_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_user_id" integer,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "sales_method" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "price_display" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "campaign_start_date" timestamp;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "campaign_end_date" timestamp;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "exchanged_at" timestamp;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "unconditional_at" timestamp;--> statement-breakpoint
ALTER TABLE "transaction_conditions" ADD CONSTRAINT "transaction_conditions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_conditions" ADD CONSTRAINT "transaction_conditions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;