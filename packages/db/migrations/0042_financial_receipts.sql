-- 0042 financial receipts (Owner t180u slice 5, D5: in-app + PDF only, no email).
-- Ordering: journal `when` 1792918800000 (25 Oct 2026 19:00 AEST), after 0041 (references
-- settlement_statements). Receipts are immutable: the trigger at the end refuses every UPDATE.
-- GATED: LOCAL development and scratch databases only. NOT applied to Replit, staging, any shared
-- database or production without separate Owner approval (t174u/t179u/t180u).
CREATE TABLE "financial_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"settlement_statement_id" integer,
	"receipt_number" text NOT NULL,
	"kind" text NOT NULL,
	"status_snapshot" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"payment_method_type" text NOT NULL,
	"payment_method_label" text,
	"payer_type" text NOT NULL,
	"payer_user_id" integer,
	"payer_brokerage_id" integer,
	"provider" text,
	"provider_reference" text,
	"attempt_no" integer,
	"failure_message" text,
	"retry_scheduled" boolean DEFAULT false NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"dedup_key" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "financial_receipts_kind_check" CHECK ("financial_receipts"."kind" in ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'REFUND', 'RECONCILIATION')),
	CONSTRAINT "financial_receipts_amount_check" CHECK ("financial_receipts"."amount_cents" >= 0 and "financial_receipts"."gst_cents" >= 0 and "financial_receipts"."gst_cents" <= "financial_receipts"."amount_cents"),
	CONSTRAINT "financial_receipts_method_check" CHECK ("financial_receipts"."payment_method_type" in ('GENERAL_ACCOUNT_DEBIT_MANDATE', 'STORED_CARD')),
	CONSTRAINT "financial_receipts_payer_check" CHECK (("financial_receipts"."payer_type" = 'Agent' and "financial_receipts"."payer_user_id" is not null) or ("financial_receipts"."payer_type" = 'Brokerage' and "financial_receipts"."payer_brokerage_id" is not null)),
	CONSTRAINT "financial_receipts_failure_check" CHECK ("financial_receipts"."kind" = 'PAYMENT_FAILED' or ("financial_receipts"."failure_message" is null and "financial_receipts"."retry_scheduled" = false))
);
--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_settlement_statement_id_settlement_statements_id_fk" FOREIGN KEY ("settlement_statement_id") REFERENCES "public"."settlement_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_receipts" ADD CONSTRAINT "financial_receipts_payer_brokerage_id_brokerages_id_fk" FOREIGN KEY ("payer_brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_receipts_receipt_number_uq" ON "financial_receipts" USING btree ("receipt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_receipts_dedup_uq" ON "financial_receipts" USING btree ("dedup_key");--> statement-breakpoint
CREATE INDEX "financial_receipts_request_idx" ON "financial_receipts" USING btree ("payment_request_id","issued_at");--> statement-breakpoint
CREATE INDEX "financial_receipts_transaction_idx" ON "financial_receipts" USING btree ("brokerage_id","transaction_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION financial_receipts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_receipts_immutable_trg BEFORE UPDATE ON "financial_receipts" FOR EACH ROW EXECUTE FUNCTION financial_receipts_immutable();
