CREATE TABLE "financial_reconciliation_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"property_id" integer,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"provider_event_row_id" integer,
	"provider_request_ref" text,
	"amount_cents" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"refund_assessment" text,
	"resolution_reason" text,
	"resolved_by_user_id" integer,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pc_fee_collection_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"requested_by_user_id" integer,
	"requested_by_role" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"executed_by" text,
	"outcome" text,
	"refusal_code" text,
	"executed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_reconciliation_exceptions" ADD CONSTRAINT "financial_reconciliation_exceptions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_exceptions" ADD CONSTRAINT "financial_reconciliation_exceptions_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_exceptions" ADD CONSTRAINT "financial_reconciliation_exceptions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_exceptions" ADD CONSTRAINT "financial_reconciliation_exceptions_provider_event_row_id_financial_payment_provider_events_id_fk" FOREIGN KEY ("provider_event_row_id") REFERENCES "public"."financial_payment_provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_exceptions" ADD CONSTRAINT "financial_reconciliation_exceptions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_collection_requests" ADD CONSTRAINT "pc_fee_collection_requests_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_collection_requests" ADD CONSTRAINT "pc_fee_collection_requests_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_collection_requests" ADD CONSTRAINT "pc_fee_collection_requests_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_collection_requests" ADD CONSTRAINT "pc_fee_collection_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_reconciliation_exceptions_one_open_idx" ON "financial_reconciliation_exceptions" USING btree ("payment_request_id","kind") WHERE "financial_reconciliation_exceptions"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "financial_reconciliation_exceptions_brokerage_status_idx" ON "financial_reconciliation_exceptions" USING btree ("brokerage_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pc_fee_collection_requests_one_open_idx" ON "pc_fee_collection_requests" USING btree ("payment_request_id") WHERE "pc_fee_collection_requests"."status" in ('PENDING', 'EXECUTING');--> statement-breakpoint
CREATE INDEX "pc_fee_collection_requests_brokerage_status_idx" ON "pc_fee_collection_requests" USING btree ("brokerage_id","status");