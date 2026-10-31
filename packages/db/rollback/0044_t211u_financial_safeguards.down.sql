-- Rollback for 0044_t211u_financial_safeguards (Owner t211u item 1). LOCAL/scratch only until the
-- Owner approves a staging apply (t211u item 6). Restores the 0041/0042 trigger functions exactly,
-- drops every 0044 trigger, function, index and column, and removes the journal row.
-- Data impact: held_by_user_id / held_at values are lost (the hold audit rows keep the raiser).
BEGIN;
DROP TRIGGER IF EXISTS financial_payment_requests_adjustment_guard_trg ON "financial_payment_requests";
DROP FUNCTION IF EXISTS financial_payment_requests_adjustment_guard();
DROP TRIGGER IF EXISTS pc_fee_authorities_guard_trg ON "pc_fee_authorities";
DROP FUNCTION IF EXISTS pc_fee_authorities_guard();
DROP TRIGGER IF EXISTS settlement_statement_lines_no_delete_trg ON "settlement_statement_lines";
DROP FUNCTION IF EXISTS settlement_statement_lines_no_delete();
DROP TRIGGER IF EXISTS settlement_statements_no_delete_trg ON "settlement_statements";
DROP TRIGGER IF EXISTS financial_receipts_no_delete_trg ON "financial_receipts";
DROP TRIGGER IF EXISTS financial_ledger_events_guard_trg ON "financial_ledger_events";
DROP FUNCTION IF EXISTS financial_ledger_events_guard();
DROP FUNCTION IF EXISTS financial_record_no_delete();
-- 0041 body, verbatim.
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
-- 0042 body, verbatim.
CREATE OR REPLACE FUNCTION financial_receipts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial receipt % is immutable', OLD.id USING ERRCODE = 'check_violation';
END;
$$;
DROP FUNCTION IF EXISTS financial_correction_authorised(text, integer);
DROP INDEX IF EXISTS "pc_fee_authorities_one_active_per_agent_idx";
ALTER TABLE "financial_payment_outbox" DROP CONSTRAINT IF EXISTS "financial_payment_outbox_held_by_user_id_users_id_fk";
ALTER TABLE "financial_payment_outbox" DROP COLUMN IF EXISTS "held_at";
ALTER TABLE "financial_payment_outbox" DROP COLUMN IF EXISTS "held_by_user_id";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792926000000;
COMMIT;
