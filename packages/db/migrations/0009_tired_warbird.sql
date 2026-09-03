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
ALTER TABLE "financial_payment_outbox" ADD CONSTRAINT "financial_payment_outbox_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_payment_outbox" ADD CONSTRAINT "financial_payment_outbox_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_payment_outbox_payment_request_action_idx" ON "financial_payment_outbox" USING btree ("payment_request_id","action");--> statement-breakpoint
CREATE INDEX "financial_payment_outbox_status_next_attempt_idx" ON "financial_payment_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_reconciliations_legacy_commission_unique_idx" ON "financial_reconciliations" USING btree ("brokerage_id","record_id") WHERE "financial_reconciliations"."record_type" = 'LEGACY_TRANSACTION_COMMISSION';