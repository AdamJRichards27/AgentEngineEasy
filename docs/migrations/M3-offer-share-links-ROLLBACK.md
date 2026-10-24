# M3 revocable offer links: migration 0037, data preservation and rollback

**Status:** The Owner approved this for development and review as a pre-pilot capability (t165u). It is **NOT EXECUTED** in staging or production. Running it anywhere other than a local scratch database needs **separate Owner approval**. It has only been run on local scratch PG16 databases.

## What 0037 does
- `packages/db/migrations/0037_m3_offer_share_links.sql` is additive only:
  - `CREATE TABLE offer_share_links` with `offer_id` (FK to `offers.id`, ON DELETE CASCADE), a unique `token`, `issued_at`, `issued_by_user_id`, `expires_at`, `revoked_at`, `revoked_by_user_id` and `revoke_reason`, plus an index on `offer_id`.
  - A backfill that adds one active link with no expiry for every `offers.share_token` that is not null. Each link's `issued_at` is the offer's `created_at`.
- It does **not** alter, rewrite or delete any `offers` row or column. Links already sent to buyers keep working until an agent revokes them.
- **Number 0037 is a development placeholder.** The local, unpublished refund ledger (`0037_payment_refunds`, M5) and the PL-04 0035 repair proposal (`0037_repair_0035…`) also use 0037. Whichever is approved second must be regenerated (`pnpm --filter @aee/db run db:generate`) to the next number before merge. The journal `when` (1792837396131) is later than every existing entry, including 0034–0036, so the out-of-order 0035 `when` does not affect it.

## Pre-apply checks (for the approved environment, later)
1. Take a backup or snapshot, following the PH-7 backup/restore runbook.
2. `pnpm --filter @aee/db run db:preflight` must pass.
3. Record the baseline:
   `select count(*), count(share_token), md5(string_agg(id||':'||coalesce(share_token,'')||':'||status||':'||offer_price_cents, ',' order by id)) from offers;`
4. Confirm there are no duplicate tokens: `select share_token from offers where share_token is not null group by 1 having count(*)>1;` must return nothing. The column is already unique.

## Post-apply data-preservation checks
1. The `offers` baseline query returns exactly the same values.
2. `select count(*) from offer_share_links` equals `count(share_token)` from step 3.
3. `select count(*) from offer_share_links l join offers o on o.id=l.offer_id where l.token<>o.share_token or l.issued_at<>o.created_at or l.expires_at is not null or l.revoked_at is not null` is 0.
4. Spot-check: a pre-existing public link `GET /api/offers/public/<token>` still returns 200.

The repeatable scratch harness for all of this is `packages/db/scripts/m3-scratch-up-down-check.mjs`. It refuses any database that is not on a loopback host or not named `scratch_m3*`. It covers 0036 → seed → up → idempotent re-run → down → re-up, and checks that the `offers` fingerprint is byte-identical throughout. The local result was PASS 15/15.

## Rollback procedure
Rolling back reverts the app to pre-M3 behaviour, where `offers.share_token` is the only link.
1. **Deploy the pre-M3 application build first.** The M3 code reads `offer_share_links`; the old code ignores it.
2. **Decide about revoked links.** This step is optional and needs separate approval. After the table is dropped, any original token that an agent revoked would work again, and every reissued token would stop working. If revoked links must stay dead, then *before* dropping the table, rotate those offers' original tokens (this is a data change to `offers`):
   `update offers o set share_token = encode(gen_random_bytes(16),'hex') from offer_share_links l where l.offer_id=o.id and l.token=o.share_token and l.revoked_at is not null;`
   This needs pgcrypto, or generate the tokens in the app. Record which offer ids were changed.
3. Run `packages/db/rollback/0037_m3_offer_share_links.down.sql` with psql:
   `psql -v m3_hash=<sha256 of 0037_m3_offer_share_links.sql> -f …down.sql`
   It drops the table and removes 0037's `drizzle.__drizzle_migrations` row in one transaction.
4. Re-run the baseline query from pre-apply step 3. It must match, unless step 2 was approved and run, in which case only the recorded token values differ.
5. **Audit history is kept.** The `offer_share_link_revoked` and `offer_share_link_reissued` rows stay in `audit_logs`; they never contain token values.

Re-applying after a rollback reproduces the backfill exactly (proven on scratch).

## Open details (not decided here)
- The default link expiry: BE-Q1 detail. The code issues no expiry unless `expiresInDays` (1–90) is given on reissue. A 7-day default was proposed in the spec but not decided.
- The listing-agent rule uses `properties.agent_id`. Multi-agent listings are R-01.
