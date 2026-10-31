-- Rollback for 0045_t212u_collection_requests_reconciliation (Owner t212u).
-- Drops the two tables 0045 created (their indexes and FKs go with them) and the journal row.
-- DATA LOSS: collection-request history and reconciliation exceptions (including any OPEN
-- Paid-after-adjustment / unconfirmed-cancellation reviews). Export them first:
--   \copy pc_fee_collection_requests TO 'pc_fee_collection_requests.csv' CSV HEADER
--   \copy financial_reconciliation_exceptions TO 'financial_reconciliation_exceptions.csv' CSV HEADER
-- Run 0045 down BEFORE 0044 down.
BEGIN;
DROP TABLE IF EXISTS "financial_reconciliation_exceptions";
DROP TABLE IF EXISTS "pc_fee_collection_requests";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792929600000;
COMMIT;
