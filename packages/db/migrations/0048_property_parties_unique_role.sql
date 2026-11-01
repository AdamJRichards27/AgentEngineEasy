-- testing/r1 ONLY (Owner t246u): promoted from docs/migrations/proposed/0047_property_parties_unique_role.sql for the
-- dedicated testing database. NOT approved for staging or production. Fails closed
-- (aborts, changes nothing) if the guarded condition is violated.
-- PROPOSED, NOT APPLIED (t228u Priority 3). Not in migrations/meta/_journal.json,
-- so `db:migrate` cannot run it. Promote to packages/db/migrations/ with a journal
-- entry only after Owner approval AND a clean duplicate audit on the target DB
-- (packages/db/scripts/audit/property-parties-audit.sql, query D1 = 0 rows).
--
-- One link per (property, party, role). The API already refuses a duplicate
-- (POST /parties 409 PROPERTY_PARTY_LINK_EXISTS under a FOR UPDATE lock);
-- lib/offers.ts and lib/growAppraisalIntegrations.ts check-then-insert without
-- a lock. This index makes the rule hold for every writer.
--
-- Fails closed: if duplicates exist the migration aborts and changes nothing.
-- It never deletes or merges rows; duplicates are resolved by a separately
-- approved data step (see 0047-IMPACT.md "If D1 is not empty").
DO $$
DECLARE dup_groups integer;
BEGIN
  SELECT count(*) INTO dup_groups FROM (
    SELECT 1 FROM property_parties GROUP BY property_id, party_id, role HAVING count(*) > 1
  ) d;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION 'property_parties has % duplicate (property_id, party_id, role) group(s); resolve before applying 0047', dup_groups;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "property_parties_property_party_role_unique"
  ON "property_parties" USING btree ("property_id", "party_id", "role");
