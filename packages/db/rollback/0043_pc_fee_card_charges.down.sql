-- Rollback for 0043_pc_fee_card_charges (Owner t180u slice 6). LOCAL/scratch only.
-- Refuses if any stored-card or brokerage authority exists (dropping its columns would silently turn it into a
-- direct-debit agent authority). Drops the card-charge attempt history (audit_logs and ledger events keep it).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pc_fee_authorities WHERE authorised_payment_method <> 'GENERAL_ACCOUNT_DEBIT_MANDATE' OR payer_type <> 'Agent') THEN
    RAISE EXCEPTION '0043 rollback refused: stored-card or brokerage PC fee authorities exist';
  END IF;
END $$;
DROP TABLE IF EXISTS "financial_card_charges";
DROP FUNCTION IF EXISTS financial_card_charges_guard();
ALTER TABLE "pc_fee_authorities" DROP CONSTRAINT IF EXISTS "pc_fee_authorities_brokerage_approval_check";
ALTER TABLE "pc_fee_authorities" DROP CONSTRAINT IF EXISTS "pc_fee_authorities_brokerage_payer_check";
ALTER TABLE "pc_fee_authorities" DROP CONSTRAINT IF EXISTS "pc_fee_authorities_card_method_check";
ALTER TABLE "pc_fee_authorities" DROP CONSTRAINT IF EXISTS "pc_fee_authorities_payer_type_check";
ALTER TABLE "pc_fee_authorities" DROP CONSTRAINT IF EXISTS "pc_fee_authorities_method_check";
ALTER TABLE "financial_payment_requests" DROP COLUMN IF EXISTS "next_attempt_at";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "mandate_terms_version";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "agreement_terms_version";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "brokerage_card_approved_at";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "brokerage_card_approved_by_user_id";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "payment_method_id";
ALTER TABLE "pc_fee_authorities" DROP COLUMN IF EXISTS "payer_type";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792922400000;
COMMIT;
