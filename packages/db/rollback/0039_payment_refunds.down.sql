-- Rollback for 0039_payment_refunds (LOCAL / scratch only; shared environments need Owner approval).
-- Drops the refund ledger and payments.refunded_cents, then removes the journal row so a re-run
-- re-applies 0039. Refund history in payment_refunds is lost; audit_logs keep refund events.
BEGIN;
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_refunded_cents_range";
ALTER TABLE "payments" DROP COLUMN IF EXISTS "refunded_cents";
DROP TABLE IF EXISTS "payment_refunds";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792908000000;
COMMIT;
