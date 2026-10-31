-- 0041 settlement statements + lines + settlement confirmations (Owner t179u slice 3, D1/D2).
-- Ordering: journal `when` 1792915200000 (25 Oct 2026 18:00 AEST), after M3 0037, 0038, the refund
-- ledger 0039 (#245) and 0040. References 0040's transaction_fees, so it cannot run ahead of 0040.
-- Immutability: the triggers at the end refuse any change to an ISSUED/SUPERSEDED statement other
-- than ISSUED -> SUPERSEDED, and any line insert/update once its statement has left DRAFT.
-- GATED: LOCAL development and scratch databases only. NOT applied to Replit, staging, any shared
-- database or production without separate Owner approval (t174u/t179u).
CREATE TABLE "settlement_confirmations" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"side" text NOT NULL,
	"representative_party_id" integer NOT NULL,
	"evidence_document_id" integer,
	"evidence_note" text,
	"confirmed_at" timestamp NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"supersedes_id" integer,
	"recorded_by_user_id" integer NOT NULL,
	"superseded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_confirmations_side_check" CHECK ("settlement_confirmations"."side" in ('BUYER', 'SELLER')),
	CONSTRAINT "settlement_confirmations_status_check" CHECK ("settlement_confirmations"."status" in ('ACTIVE', 'SUPERSEDED')),
	CONSTRAINT "settlement_confirmations_evidence_check" CHECK ("settlement_confirmations"."evidence_document_id" is not null or length(btrim(coalesce("settlement_confirmations"."evidence_note", ''))) > 0),
	CONSTRAINT "settlement_confirmations_superseded_check" CHECK (("settlement_confirmations"."status" = 'SUPERSEDED') = ("settlement_confirmations"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "settlement_statement_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"statement_id" integer NOT NULL,
	"line_no" integer NOT NULL,
	"kind" text NOT NULL,
	"effect" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"commission_calculation_id" integer,
	"transaction_fee_id" integer,
	"payment_request_id" integer,
	CONSTRAINT "settlement_statement_lines_kind_check" CHECK ("settlement_statement_lines"."kind" in ('COMMISSION', 'COMMISSION_GST', 'MARKETING', 'AE_ADMIN_FEE', 'SETTLEMENT_FEE', 'PC_SERVICE_FEE', 'ADJUSTMENT', 'DEDUCTION', 'PAYMENT', 'REFUND')),
	CONSTRAINT "settlement_statement_lines_effect_check" CHECK ("settlement_statement_lines"."effect" in ('CREDIT', 'DEBIT')),
	CONSTRAINT "settlement_statement_lines_amount_check" CHECK ("settlement_statement_lines"."amount_cents" >= 0 and "settlement_statement_lines"."gst_cents" >= 0),
	CONSTRAINT "settlement_statement_lines_description_check" CHECK (length(btrim("settlement_statement_lines"."description")) > 0),
	CONSTRAINT "settlement_statement_lines_source_check" CHECK (("settlement_statement_lines"."kind" <> 'PC_SERVICE_FEE' or "settlement_statement_lines"."payment_request_id" is not null) and ("settlement_statement_lines"."kind" not in ('COMMISSION', 'COMMISSION_GST') or "settlement_statement_lines"."commission_calculation_id" is not null) and ("settlement_statement_lines"."kind" not in ('AE_ADMIN_FEE', 'SETTLEMENT_FEE', 'ADJUSTMENT', 'DEDUCTION') or "settlement_statement_lines"."transaction_fee_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "settlement_statements" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"supersedes_id" integer,
	"supersede_reason" text,
	"payer_type" text NOT NULL,
	"payer_user_id" integer,
	"payer_brokerage_id" integer,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"credits_cents" integer DEFAULT 0 NOT NULL,
	"debits_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"pc_service_fee_cents" integer,
	"lines_fingerprint" text NOT NULL,
	"prepared_by_user_id" integer NOT NULL,
	"prepared_at" timestamp DEFAULT now() NOT NULL,
	"issued_by_user_id" integer,
	"issued_at" timestamp,
	"buyer_confirmation_id" integer,
	"seller_confirmation_id" integer,
	"superseded_at" timestamp,
	"superseded_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_statements_status_check" CHECK ("settlement_statements"."status" in ('DRAFT', 'ISSUED', 'SUPERSEDED')),
	CONSTRAINT "settlement_statements_payer_check" CHECK (("settlement_statements"."payer_type" = 'Agent' and "settlement_statements"."payer_user_id" is not null and "settlement_statements"."payer_brokerage_id" is null) or ("settlement_statements"."payer_type" = 'Brokerage' and "settlement_statements"."payer_brokerage_id" is not null and "settlement_statements"."payer_user_id" is null)),
	CONSTRAINT "settlement_statements_totals_check" CHECK ("settlement_statements"."credits_cents" >= 0 and "settlement_statements"."debits_cents" >= 0 and "settlement_statements"."net_cents" = "settlement_statements"."credits_cents" - "settlement_statements"."debits_cents" and ("settlement_statements"."pc_service_fee_cents" is null or "settlement_statements"."pc_service_fee_cents" >= 0)),
	CONSTRAINT "settlement_statements_issued_check" CHECK (("settlement_statements"."status" = 'DRAFT') = ("settlement_statements"."issued_at" is null) and ("settlement_statements"."issued_at" is null) = ("settlement_statements"."issued_by_user_id" is null) and ("settlement_statements"."status" = 'DRAFT' or ("settlement_statements"."buyer_confirmation_id" is not null and "settlement_statements"."seller_confirmation_id" is not null))),
	CONSTRAINT "settlement_statements_superseded_check" CHECK (("settlement_statements"."status" = 'SUPERSEDED') = ("settlement_statements"."superseded_at" is not null) and ("settlement_statements"."superseded_at" is null) = ("settlement_statements"."superseded_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_representative_party_id_parties_id_fk" FOREIGN KEY ("representative_party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_evidence_document_id_documents_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_confirmations" ADD CONSTRAINT "settlement_confirmations_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_statement_id_settlement_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."settlement_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_commission_calculation_id_commission_calculations_id_fk" FOREIGN KEY ("commission_calculation_id") REFERENCES "public"."commission_calculations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_transaction_fee_id_transaction_fees_id_fk" FOREIGN KEY ("transaction_fee_id") REFERENCES "public"."transaction_fees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statement_lines" ADD CONSTRAINT "settlement_statement_lines_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_payer_brokerage_id_brokerages_id_fk" FOREIGN KEY ("payer_brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_prepared_by_user_id_users_id_fk" FOREIGN KEY ("prepared_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_buyer_confirmation_id_settlement_confirmations_id_fk" FOREIGN KEY ("buyer_confirmation_id") REFERENCES "public"."settlement_confirmations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_seller_confirmation_id_settlement_confirmations_id_fk" FOREIGN KEY ("seller_confirmation_id") REFERENCES "public"."settlement_confirmations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_superseded_by_user_id_users_id_fk" FOREIGN KEY ("superseded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "settlement_confirmations_transaction_idx" ON "settlement_confirmations" USING btree ("transaction_id","side");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_confirmations_one_active_uq" ON "settlement_confirmations" USING btree ("transaction_id","side") WHERE "settlement_confirmations"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statement_lines_statement_line_uq" ON "settlement_statement_lines" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statements_transaction_version_uq" ON "settlement_statements" USING btree ("transaction_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statements_one_draft_uq" ON "settlement_statements" USING btree ("transaction_id") WHERE "settlement_statements"."status" = 'DRAFT';--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_statements_one_issued_uq" ON "settlement_statements" USING btree ("transaction_id") WHERE "settlement_statements"."status" = 'ISSUED';--> statement-breakpoint
CREATE INDEX "settlement_statements_brokerage_idx" ON "settlement_statements" USING btree ("brokerage_id","status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settlement_statements_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'ISSUED' AND NEW.status = 'SUPERSEDED'
     AND NEW.superseded_at IS NOT NULL AND NEW.superseded_by_user_id IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['status','superseded_at','superseded_by_user_id','updated_at'])
       = (to_jsonb(OLD) - ARRAY['status','superseded_at','superseded_by_user_id','updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'settlement statement % is % and immutable', OLD.id, OLD.status USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_statements_immutable_trg BEFORE UPDATE ON "settlement_statements" FOR EACH ROW EXECUTE FUNCTION settlement_statements_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settlement_statement_lines_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT status INTO parent_status FROM settlement_statements WHERE id = NEW.statement_id;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement statement % is % and its lines are immutable', NEW.statement_id, parent_status USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.statement_id <> OLD.statement_id THEN
    RAISE EXCEPTION 'settlement statement lines cannot move between statements' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER settlement_statement_lines_immutable_trg BEFORE INSERT OR UPDATE ON "settlement_statement_lines" FOR EACH ROW EXECUTE FUNCTION settlement_statement_lines_immutable();
