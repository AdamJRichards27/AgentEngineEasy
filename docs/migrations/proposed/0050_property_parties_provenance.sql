-- t244u PROPOSED. UNAPPLIED. Disposable DBs only until separately approved.
-- Additive, nullable provenance on property_parties, so that a converted link
-- preserves what grow_relationships knew. No new permanent relationship table;
-- grow_relationships itself is never edited or deleted. Existing rows and all
-- current writers are unaffected (every column is nullable, with no default
-- behaviour change). Signal rules and import paths are unchanged: they keep
-- reading grow_relationships.
ALTER TABLE property_parties
  ADD COLUMN IF NOT EXISTS relationship_status text,            -- Active | Historical | PendingReview (as in Grow)
  ADD COLUMN IF NOT EXISTS valid_from timestamp,
  ADD COLUMN IF NOT EXISTS valid_to timestamp,
  ADD COLUMN IF NOT EXISTS ownership_start_date timestamp,
  ADD COLUMN IF NOT EXISTS confidence_score numeric,
  ADD COLUMN IF NOT EXISTS role_detail text,                    -- Grow free-text role refinement
  ADD COLUMN IF NOT EXISTS source_grow_relationship_ids integer[]; -- provenance for audit and rollback

-- ROLLBACK (exact; drops only what this proposal added):
-- ALTER TABLE property_parties
--   DROP COLUMN IF EXISTS source_grow_relationship_ids, DROP COLUMN IF EXISTS role_detail,
--   DROP COLUMN IF EXISTS confidence_score, DROP COLUMN IF EXISTS ownership_start_date,
--   DROP COLUMN IF EXISTS valid_to, DROP COLUMN IF EXISTS valid_from, DROP COLUMN IF EXISTS relationship_status;
