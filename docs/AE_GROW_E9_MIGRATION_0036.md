# E-9 migration 0036 — tenant columns

**Status:** prepared. Not applied to any non-CI database. E-9 stays **PARTIAL**.
**Owner act:** OA-E9-1 approves preparing and opening this migration PR only. It does not approve apply, and it does not close E-9.
**Design source:** [`AE_GROW_E9_LATENT_TENANCY_NOTE.md`](./AE_GROW_E9_LATENT_TENANCY_NOTE.md) (#171). No separate 0036 planning draft was in the repo. The decisions below are that note's recommended remediation, labelled D-1..D-9 for this migration.

Do not run `db:migrate` against staging, pilot, or production from this pull request. CI's clean-database check is the only apply.

## Decisions

| ID | Note | This migration |
|---|---|---|
| D-1 | Decision 2 | Change `appraisals` and `communication_participants` together. |
| D-2 | Decision 2, child tables | `appraisal_comparable_sales` and `appraisal_market_competition` are not given `brokerage_id`. They stay scoped through the parent appraisal. |
| D-3 | Checklist 1–2 | Additive `brokerage_id integer`, `NOT NULL` after backfill, foreign key to `brokerages`. No other column changes. |
| D-4 | Checklist 2 | Backfill `appraisals` from `properties.brokerage_id` via `property_id`, and `communication_participants` from `communication_threads.brokerage_id` via `thread_id`. A missing parent stops the migration. |
| D-5 | Checklist 3 | `appraisals_property_brokerage_fk` and `communication_participants_thread_brokerage_fk` keep the stored brokerage equal to the parent. |
| D-6 | Decision 4 | When `party_id` is not null, `appraisals_party_brokerage_fk` and `communication_participants_party_brokerage_fk` require `parties.brokerage_id` to match. A null `party_id` (manual participant, property-only appraisal) is allowed. |
| D-7 | Decision 6 | Existing property, thread, and party indexes stay, including `appraisals_property_follow_up_idx`, `appraisals_property_deferred_outcome_idx`, and `appraisals_property_updated_at_idx`. `appraisals_brokerage_idx` and `communication_participants_brokerage_idx` are the brokerage-leading indexes for a direct tenant predicate. |
| D-8 | Checklist 4 | Inserts set `brokerage_id` from the parent row already loaded for the tenancy check. |
| D-9 | Decision 7 | This PR is the migration file. Apply on a named database is a later Owner act. Merge to `staging` does not apply it. |

Reads listed in the design note already join the parent brokerage (#177, #178, #193, #207). They do not all add `brokerage_id =` on the child yet. That is why E-9 stays **PARTIAL**.

Parent unique constraints `properties_id_brokerage_uq`, `parties_id_brokerage_uq`, and `communication_threads_id_brokerage_uq` exist only so Postgres can target `(id, brokerage_id)`. They add no column.

## Before apply

Against the database you intend to migrate, and nowhere else:

```bash
DATABASE_URL="<that database>" pnpm --filter @aee/db run db:preflight
```

0036's section prints row counts and fails, without writing, when:

- an appraisal has no property, or a participant has no thread
- the parent's `brokerage_id` is null
- `party_id` is set and that party belongs to a different brokerage than the parent
- the new column is already present and still null

A failure means fix or remove those rows. Do not invent a brokerage. The migration raises the same stops if preflight was skipped.

## Rollback

This repository's migrator has no down files. Drizzle will not run the SQL below. It is the operator plan if OA-E9-1's later apply act is reversed on a named database that has already applied 0036.

Take a backup first. Roll back the application that writes `brokerage_id` in the same window as the SQL. Leaving the new application on a database without the column makes inserts fail. Leaving the column in place without the application is safe: the column is unused by older code.

The SQL drops only what 0036 added. It does not delete appraisal or participant rows.

```sql
BEGIN;
ALTER TABLE communication_participants DROP CONSTRAINT IF EXISTS communication_participants_party_brokerage_fk;
ALTER TABLE communication_participants DROP CONSTRAINT IF EXISTS communication_participants_thread_brokerage_fk;
ALTER TABLE communication_participants DROP CONSTRAINT IF EXISTS communication_participants_brokerage_id_brokerages_id_fk;
DROP INDEX IF EXISTS communication_participants_brokerage_idx;
ALTER TABLE communication_participants DROP COLUMN IF EXISTS brokerage_id;

ALTER TABLE appraisals DROP CONSTRAINT IF EXISTS appraisals_party_brokerage_fk;
ALTER TABLE appraisals DROP CONSTRAINT IF EXISTS appraisals_property_brokerage_fk;
ALTER TABLE appraisals DROP CONSTRAINT IF EXISTS appraisals_brokerage_id_brokerages_id_fk;
DROP INDEX IF EXISTS appraisals_brokerage_idx;
ALTER TABLE appraisals DROP COLUMN IF EXISTS brokerage_id;

ALTER TABLE communication_threads DROP CONSTRAINT IF EXISTS communication_threads_id_brokerage_uq;
ALTER TABLE parties DROP CONSTRAINT IF EXISTS parties_id_brokerage_uq;
ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_id_brokerage_uq;

DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<hash of 0036_e9_tenant_brokerage_id.sql>';
COMMIT;
```

Confirm the hash from `drizzle.__drizzle_migrations` before the delete. Do not delete any other journal row. After this SQL, redeploy the application revision from before 0036.

Drizzle applies every pending migration, including 0036, in one transaction. The `--> statement-breakpoint` markers in the SQL file only split statements for the migrator. They do not commit. A failure anywhere in that transaction rolls the statements and the journal insert back together. Do not run the rollback SQL in that case. Run preflight, fix the rows it names, and apply again.
