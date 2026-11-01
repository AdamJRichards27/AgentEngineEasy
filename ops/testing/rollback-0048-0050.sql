-- testing/r1 rollback for the three promoted property_parties migrations (testing DB ONLY).
-- Reverse order. Pure DDL drops of an index / constraint / index: no row is changed.
-- Also removes their drizzle bookkeeping rows so db:migrate would re-apply them.
BEGIN;
ALTER TABLE property_parties DROP CONSTRAINT IF EXISTS property_parties_role_check;          -- 0050
DROP INDEX IF EXISTS property_parties_one_primary_per_role;                                  -- 0049
DROP INDEX IF EXISTS property_parties_property_party_role_unique;                            -- 0048
DELETE FROM drizzle.__drizzle_migrations WHERE created_at IN (SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3)
  AND (SELECT count(*) FROM drizzle.__drizzle_migrations) = 40;  -- only when exactly 0000–0050 (40 entries incl. 0048–0050) are recorded
COMMIT;
