-- 0043 stored-card and brokerage payments for the AE Pit Crew service fee (Owner t180u slice 6, D8/D3).
-- Ordering: journal `when` 1792922400000 (25 Oct 2026 20:00 AEST), after 0042 (receipts).
-- pc_fee_authorities gains the SINGLE nominated payment method (no fallback): a direct-debit mandate or one
-- tokenised payment_methods row, and the payer (Agent | Brokerage). A brokerage payer is stored-card only and
-- cannot be ACTIVE without a Brokerage Administrator approval (not the drafter) under a signed mandate.
-- financial_card_charges records every card attempt PENDING before the provider call; partial unique indexes
-- allow one SUCCEEDED and one in-flight charge per payment request. Token references only (by FK).
-- Extended IN PLACE under Owner t181u (still unapplied on every shared database): agreement/mandate terms
-- versions on pc_fee_authorities (immediate collection only when both permit it), next_attempt_at on
-- financial_payment_requests (retry backoff) and the 'scheduler' card-charge trigger; phase 2a adds
-- financial_card_refunds (BA-only controlled refunds of a SUCCEEDED charge back to the original charge, capped
-- at the charged amount by trigger).
-- GATED: LOCAL development and scratch databases only. NOT applied to Replit, staging, any shared database or
-- production without separate Owner approval (t174u/t179u/t180u).
CREATE TABLE "financial_card_charges" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"pc_fee_authority_id" integer NOT NULL,
	"payment_method_id" integer NOT NULL,
	"payer_type" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"provider_charge_ref" text,
	"failure_message" text,
	"trigger" text NOT NULL,
	"initiated_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "financial_card_charges_status_check" CHECK ("financial_card_charges"."status" in ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "financial_card_charges_payer_check" CHECK ("financial_card_charges"."payer_type" in ('Agent', 'Brokerage')),
	CONSTRAINT "financial_card_charges_amount_check" CHECK ("financial_card_charges"."amount_cents" > 0 and "financial_card_charges"."attempt_no" >= 1),
	CONSTRAINT "financial_card_charges_trigger_check" CHECK ("financial_card_charges"."trigger" in ('collect', 'statement_issued', 'scheduler'))
);
--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "payer_type" text DEFAULT 'Agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "payment_method_id" integer;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "brokerage_card_approved_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "brokerage_card_approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "agreement_terms_version" text;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD COLUMN "mandate_terms_version" text;--> statement-breakpoint
ALTER TABLE "financial_payment_requests" ADD COLUMN "next_attempt_at" timestamp;--> statement-breakpoint
ALTER TABLE "financial_card_charges" ADD CONSTRAINT "financial_card_charges_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_charges" ADD CONSTRAINT "financial_card_charges_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_charges" ADD CONSTRAINT "financial_card_charges_pc_fee_authority_id_pc_fee_authorities_id_fk" FOREIGN KEY ("pc_fee_authority_id") REFERENCES "public"."pc_fee_authorities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_charges" ADD CONSTRAINT "financial_card_charges_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_charges" ADD CONSTRAINT "financial_card_charges_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_charges_idempotency_uq" ON "financial_card_charges" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_charges_attempt_uq" ON "financial_card_charges" USING btree ("payment_request_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_charges_one_succeeded_uq" ON "financial_card_charges" USING btree ("payment_request_id") WHERE "financial_card_charges"."status" = 'SUCCEEDED';--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_charges_one_in_flight_uq" ON "financial_card_charges" USING btree ("payment_request_id") WHERE "financial_card_charges"."status" in ('PENDING', 'UNKNOWN');--> statement-breakpoint
CREATE INDEX "financial_card_charges_brokerage_idx" ON "financial_card_charges" USING btree ("brokerage_id","created_at");--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_brokerage_card_approved_by_user_id_users_id_fk" FOREIGN KEY ("brokerage_card_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_method_check" CHECK ("pc_fee_authorities"."authorised_payment_method" in ('GENERAL_ACCOUNT_DEBIT_MANDATE', 'STORED_CARD'));--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_payer_type_check" CHECK ("pc_fee_authorities"."payer_type" in ('Agent', 'Brokerage'));--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_card_method_check" CHECK (("pc_fee_authorities"."authorised_payment_method" = 'STORED_CARD') = ("pc_fee_authorities"."payment_method_id" is not null));--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_brokerage_payer_check" CHECK ("pc_fee_authorities"."payer_type" = 'Agent' or "pc_fee_authorities"."authorised_payment_method" = 'STORED_CARD');--> statement-breakpoint
ALTER TABLE "pc_fee_authorities" ADD CONSTRAINT "pc_fee_authorities_brokerage_approval_check" CHECK ("pc_fee_authorities"."payer_type" = 'Agent' or "pc_fee_authorities"."status" <> 'ACTIVE' or ("pc_fee_authorities"."brokerage_card_approved_by_user_id" is not null and "pc_fee_authorities"."brokerage_card_approved_at" is not null and "pc_fee_authorities"."signed_evidence_ref" is not null and "pc_fee_authorities"."brokerage_card_approved_by_user_id" is distinct from "pc_fee_authorities"."created_by_user_id"));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION financial_card_charges_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'financial_card_charges row % is final (%); card charge history is immutable', OLD.id, OLD.status;
  END IF;
  IF NEW.payment_request_id <> OLD.payment_request_id OR NEW.pc_fee_authority_id <> OLD.pc_fee_authority_id
     OR NEW.payment_method_id <> OLD.payment_method_id OR NEW.payer_type <> OLD.payer_type OR NEW.attempt_no <> OLD.attempt_no
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency
     OR NEW.brokerage_id <> OLD.brokerage_id OR NEW.provider <> OLD.provider THEN
    RAISE EXCEPTION 'financial_card_charges row %: only status, provider_charge_ref, failure_message and completed_at may change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER financial_card_charges_guard BEFORE UPDATE ON "financial_card_charges" FOR EACH ROW EXECUTE FUNCTION financial_card_charges_guard();
--> statement-breakpoint
CREATE TABLE "financial_card_refunds" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"card_charge_id" integer NOT NULL,
	"request_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"provider_refund_ref" text,
	"failure_message" text,
	"reason" text NOT NULL,
	"requested_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "financial_card_refunds_status_check" CHECK ("financial_card_refunds"."status" in ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
	CONSTRAINT "financial_card_refunds_amount_check" CHECK ("financial_card_refunds"."amount_cents" > 0),
	CONSTRAINT "financial_card_refunds_reason_check" CHECK (length(btrim("financial_card_refunds"."reason")) >= 3)
);
--> statement-breakpoint
ALTER TABLE "financial_card_refunds" ADD CONSTRAINT "financial_card_refunds_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_refunds" ADD CONSTRAINT "financial_card_refunds_payment_request_id_financial_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."financial_payment_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_refunds" ADD CONSTRAINT "financial_card_refunds_card_charge_id_financial_card_charges_id_fk" FOREIGN KEY ("card_charge_id") REFERENCES "public"."financial_card_charges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_card_refunds" ADD CONSTRAINT "financial_card_refunds_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_refunds_idempotency_uq" ON "financial_card_refunds" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_card_refunds_request_key_uq" ON "financial_card_refunds" USING btree ("card_charge_id","request_key");--> statement-breakpoint
CREATE INDEX "financial_card_refunds_charge_idx" ON "financial_card_refunds" USING btree ("card_charge_id","status");--> statement-breakpoint
CREATE INDEX "financial_card_refunds_request_idx" ON "financial_card_refunds" USING btree ("payment_request_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION financial_card_refunds_cap() RETURNS trigger AS $$
DECLARE
  ch RECORD;
  reserved integer;
BEGIN
  -- Serialise refunds of one charge on the charge row, then re-read the committed total.
  SELECT id, status, amount_cents, payment_request_id, brokerage_id INTO ch FROM financial_card_charges WHERE id = NEW.card_charge_id FOR UPDATE;
  IF ch.id IS NULL OR ch.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'financial_card_refunds: card charge % is not a SUCCEEDED charge', NEW.card_charge_id;
  END IF;
  IF NEW.payment_request_id <> ch.payment_request_id OR NEW.brokerage_id <> ch.brokerage_id THEN
    RAISE EXCEPTION 'financial_card_refunds: refund does not belong to card charge %', NEW.card_charge_id;
  END IF;
  SELECT coalesce(sum(amount_cents), 0) INTO reserved FROM financial_card_refunds WHERE card_charge_id = NEW.card_charge_id AND status <> 'FAILED';
  IF reserved + NEW.amount_cents > ch.amount_cents THEN
    RAISE EXCEPTION 'financial_card_refunds: refunds would exceed the charged amount of card charge %', NEW.card_charge_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER financial_card_refunds_cap BEFORE INSERT ON "financial_card_refunds" FOR EACH ROW EXECUTE FUNCTION financial_card_refunds_cap();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION financial_card_refunds_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('SUCCEEDED', 'FAILED') THEN
    RAISE EXCEPTION 'financial_card_refunds row % is final (%); refund history is immutable', OLD.id, OLD.status;
  END IF;
  IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'financial_card_refunds row %: cannot return to PENDING', OLD.id;
  END IF;
  IF NEW.card_charge_id <> OLD.card_charge_id OR NEW.payment_request_id <> OLD.payment_request_id OR NEW.brokerage_id <> OLD.brokerage_id
     OR NEW.request_key <> OLD.request_key OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.provider <> OLD.provider OR NEW.reason <> OLD.reason OR NEW.requested_by_user_id <> OLD.requested_by_user_id THEN
    RAISE EXCEPTION 'financial_card_refunds row %: only status, provider_refund_ref, failure_message and completed_at may change', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER financial_card_refunds_guard BEFORE UPDATE ON "financial_card_refunds" FOR EACH ROW EXECUTE FUNCTION financial_card_refunds_guard();
