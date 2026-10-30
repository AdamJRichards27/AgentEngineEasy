-- Rollback for 0042_financial_receipts (Owner t180u slice 5). LOCAL/scratch only.
-- Drops receipts (receipt history lost; audit_logs and financial_ledger_events keep every payment event).
BEGIN;
DROP TABLE IF EXISTS "financial_receipts";
DROP FUNCTION IF EXISTS financial_receipts_immutable();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792918800000;
COMMIT;
