-- Rollback for 0040_transaction_fees (LOCAL / scratch only; shared environments need Owner approval).
-- Refuses if any TRANSACTION_FEE grant exists (narrowing the CHECK would fail); revoke-and-delete is
-- a separate, explicit decision. Drops transaction_fees and fee_schedule_versions (fee history lost;
-- audit_logs keep every fee and schedule event) and removes the journal row so a re-run re-applies 0040.
BEGIN;
ALTER TABLE "financial_amendment_authorities" DROP CONSTRAINT "fin_amend_auth_scope_check";
ALTER TABLE "financial_amendment_authorities" ADD CONSTRAINT "fin_amend_auth_scope_check" CHECK ("financial_amendment_authorities"."scope" in ('AGENCY_TERMS', 'CAMPAIGN_ITEM_COST', 'COMMISSION_AGREEMENT', 'COMMISSION_CALCULATION'));
DROP TABLE IF EXISTS "transaction_fees";
DROP TABLE IF EXISTS "fee_schedule_versions";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792911600000;
COMMIT;
