# PC fee authority duplicate detection (read-only)

Status: draft, CC #57 (PR #279). Detection only: it changes no data and no schema.

## Why

Before #279, `activatePcFeeAuthority` replaced only the first prior ACTIVE row a query happened to
return, outside any transaction. Concurrent activations, or rows set to ACTIVE directly, could leave an
agent with more than one ACTIVE authority, or one authority activated twice. #279 fixes the code path.
It cannot repair rows written before the fix. Duplicates matter because readers assume there is one
ACTIVE row. For example, `bootstrap.ts` bills settlement fees against whichever ACTIVE row the database
returns first (there is no ORDER BY), so with duplicates the rate charged is arbitrary.

## The script

`scripts/sql/pc-fee-authority-duplicate-check.sql` is a single `SELECT`. Each row is one finding, and an
empty result means nothing was found.

| check_name | Meaning | Key columns |
|---|---|---|
| `MULTIPLE_ACTIVE` | an agent has more than one `ACTIVE` authority | `agent_user_id`, `authority_ids`, `occurrences` |
| `ACTIVATED_TWICE_LEDGER` | one authority has more than one `PC_FEE_AUTHORITY_ACTIVATED` ledger event (`financial_ledger_events`, source type `PC_FEE_AUTHORITY`) | `authority_ids`, `ledger_event_ids`, `occurrences` |
| `SHARED_SUPERSEDES` | more than one authority has the same `supersedes_id`. Only activation writes `supersedes_id`, so two activations each replaced the same prior authority | `authority_ids`, `occurrences` |

Every row also carries `brokerage_id`. Output is internal IDs and counts only. The script reads no
names, emails, phone numbers, mandate or provider references, evidence references, reasons, metadata or
card details. A test enforces this list.

`SHARED_SUPERSEDES` is supporting evidence: on its own it can also flag hand-edited data. Read it
alongside the other two checks.

## Running it

Only against a database you are authorised to read, and only in a read-only session:

```sh
PGOPTIONS='-c default_transaction_read_only=on' \
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/pc-fee-authority-duplicate-check.sql
```

Running it against staging or production is an operator decision that needs Owner approval. Nothing in
this PR runs it there, and neither CI nor the app runs it. A non-empty result is an input to the
resolution step in `docs/PC_FEE_AUTHORITY_ACTIVE_UNIQUE_INDEX_DESIGN.md`. Do not fix duplicates by hand
without that review: which authority stays ACTIVE is a financial decision.

## Test

`apps/api/src/lib/financial/__tests__/pcFeeAuthorityDuplicateCheck.test.ts` covers the following.

- It refuses to run unless `NODE_ENV=test` and `DATABASE_URL` points at a loopback host (the local
  throwaway DB used by `scripts/run-api-tests.sh` and CI).
- Every execution happens inside `BEGIN TRANSACTION READ ONLY` and is rolled back. One check shows that a
  write to a real table in that transaction is refused.
- Exact cases run against empty session-temporary copies of the two tables, which shadow the real ones
  for that connection. Postgres permits writes to temporary tables in a read-only transaction. This
  covers clean data (empty output), empty tables (empty output), seeded duplicates of every kind (exact
  rows) and an orphan activation event.
- A real-table case uses this test's own brokerage: authorities activated through
  `activatePcFeeAuthority` report nothing, and two rows forced to ACTIVE directly are reported.
- Static checks: the file is exactly one `SELECT`, with no DML, DDL, locking, transaction control or
  `public.` qualification, and no customer-data columns.
