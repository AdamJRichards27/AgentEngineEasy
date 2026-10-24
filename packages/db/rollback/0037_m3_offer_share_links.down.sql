-- Rollback for migration 0037_m3_offer_share_links (M3). Run ONLY under the
-- procedure in docs/migrations/M3-offer-share-links-ROLLBACK.md and with the
-- same approval as the up migration. Not run by the migrator.
--
-- Effect: the app returns to pre-M3 behaviour, where offers.share_token is the
-- only link. offers rows are untouched by both directions.
-- * Links reissued under M3 stop working (their tokens exist only here).
-- * Revocations are lost: a revoked ORIGINAL token would work again. Step 2
--   of the procedure (optional, separately approved) handles that first.
BEGIN;
DROP TABLE IF EXISTS "offer_share_links";
DELETE FROM "drizzle"."__drizzle_migrations"
 WHERE "hash" = :'m3_hash';
COMMIT;
