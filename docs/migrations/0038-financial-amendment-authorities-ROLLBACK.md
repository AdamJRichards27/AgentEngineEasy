# 0038 financial_amendment_authorities: ordering, data preservation and rollback

**Status:** The Owner approved writing this migration and testing it on local scratch databases (t174u, 25 Oct 2026). It is **NOT EXECUTED** on Replit, staging, production or any shared database. Running it anywhere else needs separate authorisation. It has only been run on local scratch PG16 databases on 127.0.0.1.

## What 0038 does
`packages/db/migrations/0038_financial_amendment_authorities.sql` is additive only. It creates one table, `financial_amendment_authorities`: a documented, revocable, expiring grant from a listing agent or a Brokerage Administrator to one Pit Crew member, for one transaction and one permitted amendment.

| Column | Notes |
|---|---|
| `id` serial PK | |
| `brokerage_id`, `property_id`, `transaction_id` | NOT NULL, FKs. The property is derived from the transaction by the API. |
| `grantee_user_id` | NOT NULL FK users. The API checks it is Pit Crew in the same brokerage. |
| `granted_by_user_id`, `granted_by_role` | NOT NULL. Taken from the session. CHECK role in (`Agent`, `Brokerage Administrator`). |
| `scope` | NOT NULL. CHECK in (`AGENCY_TERMS`, `CAMPAIGN_ITEM_COST`, `COMMISSION_AGREEMENT`, `COMMISSION_CALCULATION`): only the amendments that exist today. The last two were added in place on 25 Oct (t177u) while 0038 was still unexecuted anywhere shared; local scratch and test databases were recreated. |
| `target_record_type`, `target_record_id` | Optional single-record target. CHECK both null or both set. |
| `evidence_document_id` (FK documents), `evidence_note` | CHECK at least one is present (a document id or a non-blank note). |
| `expires_at` | NOT NULL. CHECK `expires_at > created_at`. The API caps it at `FINANCIAL_AMENDMENT_AUTHORITY_MAX_DAYS` (default **30**, Owner-confirmable, allowed range 1–90). |
| `created_at`, `revoked_at`, `revoked_by_user_id`, `revoke_reason` | CHECK revoked_at and revoked_by both null or both set |
| | CHECK `grantee_user_id <> granted_by_user_id` (no self-grant) |

Indexes:
- `(grantee_user_id, transaction_id, scope)`: the amendment-time lookup;
- `(transaction_id)`: listing;
- `(brokerage_id, created_at)`.

No existing table, column or row is altered. Grants never authorise payment, debit, refund, release, disbursement or authority routes; those stay Brokerage Administrator only.

## Numbering and journal `when` (silent-skip hazard)
- The staging journal ends at **0036** (`when` 1791843836237).
- **0037 is M3** (#270, `0037_m3_offer_share_links`, `when` 1792837396131 = 24 Oct 20:23 AEST).
- **This migration is 0038**, with journal idx 38 and `when` **1792883726127** (25 Oct 09:15 AEST). That is later than M3's and every other entry.
  - On this branch the journal goes from idx 36 straight to 38. When #270 merges, its idx 37 entry slots in between.
  - Drizzle reads entries in order by tag and applies one only when `when > max(created_at)`. The scratch harness proves that a database which has already recorded M3 still applies 0038.
  - `meta/0038_snapshot.json` currently chains (`prevId`) from 0036. After rebasing onto M3, re-chain it to M3's 0037 snapshot id, or regenerate with `db:generate` and keep the name, idx 38 and the `when`.
- **The refund ledger** (`local/run-refund-ledger` 934bc3c, `0037_payment_refunds`, hand-set `when` 1792530000000 = 21 Oct 07:00 AEST) **must become 0039 or later**, with a `when` greater than 1792883726127.
  - If it kept its 21 Oct `when`, any database that had applied 0037 (M3) or 0038 would skip it **silently and permanently**. That is the same hazard as 0035.
  - The PL-04 repair proposal (`0037_repair_0035…`) needs the same treatment if it is approved later.

## Pre-apply checks (for an authorised environment, later)
1. Take a backup or snapshot under the PH-7 backup/restore runbook.
2. `pnpm --filter @aee/db run db:preflight` must pass.
3. Confirm the target journal has 0037 (M3) applied, or is at 0036. Then check that `select max(created_at) from drizzle.__drizzle_migrations` is less than 1792883726127.
4. Record a baseline of the referenced tables:
   `select 'transactions', count(*), md5(string_agg(id::text||':'||property_id||':'||status, ',' order by id)) from transactions union all select 'documents', count(*), md5(string_agg(id::text, ',' order by id)) from documents;`

## Post-apply checks
1. The baseline query is unchanged.
2. `select count(*) from financial_amendment_authorities` = 0.
3. `select count(*) from pg_constraint where conrelid='financial_amendment_authorities'::regclass and contype='c'` = 7.
4. The three `fin_amend_auth_*` indexes exist.

The repeatable scratch harness is `packages/db/scripts/0038-scratch-up-down-check.mjs`. It refuses any database that is not on a loopback host or not named `scratch_0038*`. It covers:
- state 0036 → seed → simulated M3 bookkeeping row → up (applied, not skipped);
- the seven CHECKs and the FK;
- an idempotent re-run;
- down, then re-up.

Every referenced table's fingerprint is checked byte-identical at each step. The local result was **PASS 27/27**.

## Rollback procedure
1. **Deploy the pre-0038 application build first.** The new code reads the table; the old code (t173u behaviour: every Pit Crew amendment 403) ignores it.
2. Optionally export the grants for the record: `copy (select * from financial_amendment_authorities) to stdout with csv header`.
3. Run `packages/db/rollback/0038_financial_amendment_authorities.down.sql`:
   `psql -v m38_hash=<sha256 of 0038_financial_amendment_authorities.sql> -f …down.sql`
   It drops the table and deletes only 0038's `drizzle.__drizzle_migrations` row, in one transaction.
4. Re-run the baseline query. It must match.
5. **Audit history is kept.** The `financial_amendment_authority_granted` / `_revoked` and `financial_record_amended` rows stay in `audit_logs`.

**Data loss on rollback:** the grant rows themselves (who, scope, expiry, evidence link, revocation) except as copied in audit rows. No other data is affected. Re-applying recreates an empty table; grants are not restored automatically.

## Open details
- The 30-day maximum is a proposed default (Owner-confirmable), configurable per environment.
- Scopes: `AGENCY_TERMS`, `CAMPAIGN_ITEM_COST`, and (t177u) `COMMISSION_AGREEMENT` (draft a new commission-agreement version; a Brokerage Administrator still approves) and `COMMISSION_CALCULATION` (ESTIMATE or PROVISIONAL snapshots only). The legacy `POST /transactions/:id/calculate-commission`, CONFIRMED/FINALISED calculations, supersede and settlement finalisation stay Brokerage Administrator only. Admin and settlement fees have no record to amend yet. Once 0038 has been applied anywhere shared, adding a scope needs a CHECK change in a new migration.
- Invoicing, settlement statements, admin fees, adjustments and deductions, disbursements and balances are future requirements and are not built.
