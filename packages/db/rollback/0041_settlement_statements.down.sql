-- Rollback for 0041_settlement_statements (Owner t179u slice 3). LOCAL/scratch only.
-- Drops statements, lines and confirmations (history lost; audit_logs keep every event).
BEGIN;
DROP TABLE IF EXISTS "settlement_statement_lines";
DROP TABLE IF EXISTS "settlement_statements";
DROP TABLE IF EXISTS "settlement_confirmations";
DROP FUNCTION IF EXISTS settlement_statement_lines_immutable();
DROP FUNCTION IF EXISTS settlement_statements_immutable();
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792915200000;
COMMIT;
