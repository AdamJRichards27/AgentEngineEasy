-- 0038 financial_amendment_authorities (Owner t174u: APPROVED to write the
-- migration and test it on local scratch databases only). NOT EXECUTED on
-- Replit, staging, production or any shared database; running it there
-- needs separate authorisation.
--
-- Numbering: 0037 is taken by M3 (#270, 0037_m3_offer_share_links, journal
-- when 1792837396131). This migration is 0038 with journal idx 38 and when
-- 1792883726127 (25 Oct 2026 09:15 AEST), later than M3's, so a database
-- that has applied M3 applies this too (drizzle applies an entry only when
-- its when > max(created_at)). The local refund ledger (0037_payment_refunds,
-- when 1792530000000) must become 0039+ with a when later than this one, or
-- it would be skipped silently. When rebased onto M3, re-chain
-- meta/0038_snapshot.json prevId to M3's 0037 snapshot id.
--
-- t177u (25 Oct 2026): the scope CHECK was widened IN PLACE to add
-- COMMISSION_AGREEMENT and COMMISSION_CALCULATION. This is still the same
-- single, never-executed-on-any-shared-database migration (only local
-- scratch/test databases, which were recreated). No 0039 was added.
--
-- Additive only: one new table, its FKs, CHECKs and indexes. No existing
-- table or row is altered. Rollback: docs/migrations/
-- 0038-financial-amendment-authorities-ROLLBACK.md and
-- rollback/0038_financial_amendment_authorities.down.sql.
CREATE TABLE "financial_amendment_authorities" (
	"id" serial PRIMARY KEY NOT NULL,
	"brokerage_id" integer NOT NULL,
	"property_id" integer NOT NULL,
	"transaction_id" integer NOT NULL,
	"grantee_user_id" integer NOT NULL,
	"granted_by_user_id" integer NOT NULL,
	"granted_by_role" text NOT NULL,
	"scope" text NOT NULL,
	"target_record_type" text,
	"target_record_id" text,
	"evidence_document_id" integer,
	"evidence_note" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revoke_reason" text,
	CONSTRAINT "fin_amend_auth_scope_check" CHECK ("financial_amendment_authorities"."scope" in ('AGENCY_TERMS', 'CAMPAIGN_ITEM_COST', 'COMMISSION_AGREEMENT', 'COMMISSION_CALCULATION')),
	CONSTRAINT "fin_amend_auth_grantor_role_check" CHECK ("financial_amendment_authorities"."granted_by_role" in ('Agent', 'Brokerage Administrator')),
	CONSTRAINT "fin_amend_auth_target_pair_check" CHECK (("financial_amendment_authorities"."target_record_type" is null) = ("financial_amendment_authorities"."target_record_id" is null)),
	CONSTRAINT "fin_amend_auth_evidence_check" CHECK ("financial_amendment_authorities"."evidence_document_id" is not null or length(btrim(coalesce("financial_amendment_authorities"."evidence_note", ''))) > 0),
	CONSTRAINT "fin_amend_auth_expiry_check" CHECK ("financial_amendment_authorities"."expires_at" > "financial_amendment_authorities"."created_at"),
	CONSTRAINT "fin_amend_auth_revoke_pair_check" CHECK (("financial_amendment_authorities"."revoked_at" is null) = ("financial_amendment_authorities"."revoked_by_user_id" is null)),
	CONSTRAINT "fin_amend_auth_no_self_grant_check" CHECK ("financial_amendment_authorities"."grantee_user_id" <> "financial_amendment_authorities"."granted_by_user_id")
);
--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_brokerage_id_brokerages_id_fk" FOREIGN KEY ("brokerage_id") REFERENCES "public"."brokerages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_evidence_document_id_documents_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "financial_amendment_authorities_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fin_amend_auth_grantee_txn_scope_idx" ON "financial_amendment_authorities" USING btree ("grantee_user_id","transaction_id","scope");--> statement-breakpoint
CREATE INDEX "fin_amend_auth_transaction_idx" ON "financial_amendment_authorities" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "fin_amend_auth_brokerage_created_idx" ON "financial_amendment_authorities" USING btree ("brokerage_id","created_at");