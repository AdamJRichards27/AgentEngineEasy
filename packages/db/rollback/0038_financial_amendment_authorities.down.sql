-- Rollback for migration 0038_financial_amendment_authorities (Owner t174u).
-- Run ONLY under docs/migrations/0038-financial-amendment-authorities-ROLLBACK.md
-- and with the same approval as the up migration. Not run by the migrator.
--
-- Effect: Pit Crew lose every documented-authority grant and return to the
-- t173u behaviour (all Pit Crew financial amendments 403). No existing table
-- is touched. Grant history stays in audit_logs
-- (financial_amendment_authority_granted / _revoked, financial_record_amended).
BEGIN;
DROP TABLE IF EXISTS "financial_amendment_authorities";
DELETE FROM "drizzle"."__drizzle_migrations"
 WHERE "hash" = :'m38_hash';
COMMIT;
