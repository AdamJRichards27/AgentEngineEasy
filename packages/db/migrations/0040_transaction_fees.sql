-- 0040 transaction fees + AE fee schedule versions (Owner t179u slice 2, D4 + D9).
-- Separate from 0038 (D4): two new tables. The only touch on 0038's table is widening its scope
-- CHECK to add TRANSACTION_FEE (drop + re-add, same name). That statement fails loudly if 0038 has
-- not been applied, so 0040 can never run ahead of it.
-- Ordering: journal `when` 1792911600000 (25 Oct 2026 17:00 AEST), after M3 0037 (1792837396131),
-- 0038 (1792883726127) and the refund ledger 0039 (1792908000000, on #245).
-- GATED: LOCAL development and scratch databases only. NOT applied to Replit, staging, pilot or
-- production; shared environments need separate Owner approval.
-- Rollback: packages/db/rollback/0040_transaction_fees.down.sql.
CREATE TABLE "fee_schedule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"agent_user_id" integer,
	"version" integer NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"admin_fee_cents" integer NOT NULL,
	"admin_fee_gst_applicable" boolean DEFAULT true NOT NULL,
	"gst_rate_bps" integer DEFAULT 1000 NOT NULL,
	"signed_agreement_document_id" integer,
	"signed_agreement_ref" text,
	"signed_at" timestamp NOT NULL,
	"effective_from" timestamp NOT NULL,
	"effective_to" timestamp,
	"supersedes_id" integer,
	"created_by_user_id" integer NOT NULL,
	"activated_by_user_id" integer,
	"activated_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "fee_schedule_versions_status_check" CHECK ("fee_schedule_versions"."status" in ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
	CONSTRAINT "fee_schedule_versions_amount_check" CHECK ("fee_schedule_versions"."admin_fee_cents" >= 0 and "fee_schedule_versions"."gst_rate_bps" between 0 and 10000),
	CONSTRAINT "fee_schedule_versions_evidence_check" CHECK ("fee_schedule_versions"."signed_agreement_document_id" is not null or length(btrim(coalesce("fee_schedule_versions"."signed_agreement_ref", ''))) > 0),
	CONSTRAINT "fee_schedule_versions_activation_check" CHECK (("fee_schedule_versions"."status" = 'DRAFT') = ("fee_schedule_versions"."activated_at" is null) and ("fee_schedule_versions"."activated_at" is null) = ("fee_schedule_versions"."activated_by_user_id" is null)),
	CONSTRAINT "fee_schedule_versions_duties_check" CHECK ("fee_schedule_versions"."activated_by_user_id" is null or "fee_schedule_versions"."activated_by_user_id" <> "fee_schedule_versions"."created_by_user_id"),
	CONSTRAINT "fee_schedule_versions_effective_check" CHECK ("fee_schedule_versions"."effective_to" is null or "fee_schedule_versions"."effective_to" >= "fee_schedule_versions"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "transaction_fees" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"gst_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"fee_schedule_version_id" integer,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" integer,
	"created_by_user_id" integer NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp,
	"cancelled_by_user_id" integer,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_fees_kind_check" CHECK ("transaction_fees"."kind" in ('ADMIN_FEE', 'SETTLEMENT_FEE', 'ADJUSTMENT', 'DEDUCTION')),
	CONSTRAINT "transaction_fees_status_check" CHECK ("transaction_fees"."status" in ('DRAFT', 'APPROVED', 'CANCELLED', 'SUPERSEDED')),
	CONSTRAINT "transaction_fees_amount_check" CHECK (("transaction_fees"."kind" = 'ADJUSTMENT' or "transaction_fees"."amount_cents" >= 0) and "transaction_fees"."gst_cents" >= 0),
	CONSTRAINT "transaction_fees_description_check" CHECK (length(btrim("transaction_fees"."description")) > 0),
	CONSTRAINT "transaction_fees_schedule_check" CHECK ("transaction_fees"."kind" <> 'ADMIN_FEE' or "transaction_fees"."fee_schedule_version_id" is not null),
	CONSTRAINT "transaction_fees_approval_check" CHECK (("transaction_fees"."approved_at" is null) = ("transaction_fees"."approved_by_user_id" is null)),
	CONSTRAINT "transaction_fees_duties_check" CHECK ("transaction_fees"."approved_by_user_id" is null or "transaction_fees"."approved_by_user_id" <> "transaction_fees"."created_by_user_id"),
	CONSTRAINT "transaction_fees_cancel_check" CHECK (("transaction_fees"."status" = 'CANCELLED') = ("transaction_fees"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" DROP CONSTRAINT "fin_amend_auth_scope_check";--> statement-breakpoint
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_signed_agreement_document_id_documents_id_fk" FOREIGN KEY ("signed_agreement_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedule_versions" ADD CONSTRAINT "fee_schedule_versions_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_fee_schedule_version_id_fee_schedule_versions_id_fk" FOREIGN KEY ("fee_schedule_version_id") REFERENCES "public"."fee_schedule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_fees" ADD CONSTRAINT "transaction_fees_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fee_schedule_versions_brokerage_idx" ON "fee_schedule_versions" USING btree ("brokerage_id","agent_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_schedule_versions_party_version_uq" ON "fee_schedule_versions" USING btree ("brokerage_id",coalesce("agent_user_id", 0),"version");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_schedule_versions_one_active_uq" ON "fee_schedule_versions" USING btree ("brokerage_id",coalesce("agent_user_id", 0)) WHERE "fee_schedule_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "transaction_fees_transaction_idx" ON "transaction_fees" USING btree ("transaction_id","status");--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "fin_amend_auth_scope_check" CHECK ("financial_amendment_authorities"."scope" in ('AGENCY_TERMS', 'CAMPAIGN_ITEM_COST', 'COMMISSION_AGREEMENT', 'COMMISSION_CALCULATION', 'TRANSACTION_FEE'));