-- PROPOSED, NOT APPLIED (t234u item 2). Not in the journal; db:migrate cannot run it.
-- At most one primary contact per (property, role). "Other" is exempt (it groups
-- unrelated relationships), matching the API rule in PR #285. Primary is optional
-- and is a contact preference only: it carries NO legal or signing authority.
-- Blocking precondition: audit P1 (property-parties-audit.sql) returns 0 rows
-- for roles other than 'Other'. Fails closed; never edits or deletes rows.
DO $$
DECLARE clashes integer;
BEGIN
  SELECT count(*) INTO clashes FROM (
    SELECT 1 FROM property_parties WHERE is_primary AND role <> 'Other'
    GROUP BY property_id, role HAVING count(*) > 1
  ) d;
  IF clashes > 0 THEN
    RAISE EXCEPTION 'property_parties has % (property_id, role) group(s) with more than one primary; resolve before applying 0049', clashes;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "property_parties_one_primary_per_role"
  ON "property_parties" USING btree ("property_id", "role")
  WHERE "is_primary" AND "role" <> 'Other';
