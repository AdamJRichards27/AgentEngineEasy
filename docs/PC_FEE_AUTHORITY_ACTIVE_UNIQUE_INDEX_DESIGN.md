# Design note: one ACTIVE PC fee authority per agent, enforced by a partial unique index

Status: DRAFT DESIGN ONLY (CC #57, PR #279). There is no migration file and no schema change, and
nothing here has been applied anywhere. Building it needs a separate, Owner-approved change. Migration
0038 stays unapplied and this note does not depend on it.

## Proposal

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pc_fee_authorities_one_active_per_agent_idx
  ON pc_fee_authorities (agent_user_id)
  WHERE status = 'ACTIVE';
```

#279 enforces "one ACTIVE per agent" in application code: activation runs in one transaction under a
per-agent advisory lock and replaces every prior ACTIVE row. The index would make the database refuse a
second ACTIVE row from any path, including direct writes, scripts, future code or a reverted lock. It
backs up the application rule and does not replace it.

The Drizzle definition would be
`uniqueIndex("pc_fee_authorities_one_active_per_agent_idx").on(table.agentUserId).where(sql\`${table.status} = 'ACTIVE'\`)`.
That is only needed once a migration is approved.

## Open question for the Owner first: is the invariant really per agent?

- Production code on staging (`a7b2b0e`), on #245 (`8a09c75`) and on #279 treats it as one per agent:
  activation replaces any ACTIVE authority for the agent, whatever its payment method or payer.
- The #245 service-fee fixtures don't agree. The scheduler test (after the 8a09c75 flake fix) activates
  a stored-card authority and then forces a direct-debit authority to ACTIVE for the same agent, so both
  are ACTIVE together.
- If card and direct-debit authorities are meant to coexist, the key should be something like
  `(agent_user_id, authorised_payment_method)` or `(agent_user_id, payer_type)`, and activation must
  change to match. If they aren't, the fixtures are modelling a state production can't produce.

Do not build the index until this is decided.

## Prerequisites

1. **Ship the application fix (#279) first.** Without it, normal concurrent activations would hit the
   index and fail with a unique-violation error. With it, activation replaces prior rows inside the
   transaction before it sets the target ACTIVE, so the index sees at most one ACTIVE row at each
   statement. (A non-deferrable unique index is checked per row as each statement runs, so that order
   matters and must be kept. #245's current activation also replaces first, then activates.)
2. **Reconcile #279 with #245.** The two conflict in `activatePcFeeAuthority`. The merged version must
   keep the single transaction, the advisory lock, the "replace every prior ACTIVE" step and the
   replace-then-activate order, plus #245's card and brokerage-approval logic.
3. **Detect existing duplicates.** Run `scripts/sql/pc-fee-authority-duplicate-check.sql` read-only on
   the target database (Owner-approved operator step, see
   `docs/PC_FEE_AUTHORITY_DUPLICATE_DETECTION.md`). The index build fails if any agent has two ACTIVE
   rows.
4. **Resolve them as a reviewed financial decision**, not a script default. For each `MULTIPLE_ACTIVE`
   agent, a Brokerage Administrator confirms which authority is current. Calculations, payment requests
   or collections may already reference the others: check `financial_payment_requests.pc_fee_authority_id`
   and the PC fee calculations before changing anything. The rest move to `REPLACED`, each with a ledger
   event and an audit reason. `ACTIVATED_TWICE_LEDGER` findings do not block the index, but they need the
   same review, because a duplicate activation event may have triggered duplicate downstream work.
5. **Fix the test fixtures** that create a second ACTIVE row for an agent (see Risks). Otherwise CI fails
   as soon as the index exists in the test schema.
6. **Re-run the check right before the build.** It must return no `MULTIPLE_ACTIVE` rows.

## CONCURRENTLY considerations

- A plain `CREATE UNIQUE INDEX` takes a SHARE lock and blocks every write to `pc_fee_authorities` while
  it builds. The table is small, so this would probably take milliseconds (the 0026/0027 migrations
  accepted the same trade-off). `CONCURRENTLY` avoids blocking writes and is still the safer default for
  a live financial table.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. `packages/db/src/migrate.ts` uses
  Drizzle's migrator, which runs pending migrations inside a transaction. A CONCURRENTLY statement in a
  normal migration file would therefore fail. Options:
  a. a plain (non-concurrent) `CREATE UNIQUE INDEX IF NOT EXISTS` in a migration, accepting the short
     write lock, as 0026/0027 do;
  b. an operator runs the `CONCURRENTLY` statement by hand first, and the migration then uses
     `IF NOT EXISTS` so it becomes a no-op (the pattern described in 0026);
  c. a separate non-transactional migration step. The repo has no such mechanism today.
- If a concurrent build fails (for example on a duplicate that appeared mid-build), it leaves an
  **INVALID** index. That index still costs write overhead and `IF NOT EXISTS` will skip over it. Check
  `pg_index.indisvalid`, then `DROP INDEX CONCURRENTLY` and rebuild once the duplicate is resolved.
- A concurrent build waits for every open transaction that could write the table, so a long-running
  transaction delays it. Run it at a quiet time with a `lock_timeout`.
- Rollback is `DROP INDEX CONCURRENTLY IF EXISTS pc_fee_authorities_one_active_per_agent_idx`. No data
  changes.

## Risks

Evidence: on a throwaway loopback database only (deleted afterwards, nothing committed), the API suite
was run with this index created by hand after migrations.

| Head | Result with index | Failures caused by the index |
|---|---|---|
| #279 `9792d0d` + this PR's new test | 2491/2530 pass, 20 fail | `paymentOutbox` (15 failing entries incl. suites), `paymentWebhooks` (17), `settlement.test.ts:249`, `pcFeeAuthorityActivationRace.test.ts:101` and `pcFeeAuthorityDuplicateCheck.test.ts:229`. The last two force duplicate ACTIVE rows on purpose. The `sweep*` failures are the known staging baseline and are unrelated. |
| #245 `8a09c75` | 2780/2809 pass, 10 fail | `paymentOutbox`, `paymentWebhooks`, `settlement:249`, `serviceFeeCollectionScheduler` (161, 235, 249), `serviceFeeCollectionTiming` (98, 111), `serviceFeeRecovery` (179, 248, 293), `serviceFeeCardPayments:310` |

All of these are unique violations from fixtures that write `status: "ACTIVE"` directly for an agent
that already has an ACTIVE authority:

- **#245 `serviceFeeStatementFixtures.ts` `activeDebitAuthority()`** forces a direct-debit authority to
  ACTIVE without going through `activatePcFeeAuthority`. This is the same fixture behind the
  `serviceFeeCollectionScheduler.test.ts:161` flake fixed in 8a09c75. With the index, every caller that
  already has an ACTIVE authority for that agent fails. That includes the scheduler's deliberate card
  plus direct-debit pair, which depends on the open question above.
- `paymentOutbox.test.ts` / `paymentWebhooks.test.ts` insert a fresh ACTIVE authority for the same
  agent in each scenario.
- `settlement.test.ts:249` inserts version 3 as ACTIVE while an earlier version is still ACTIVE.
- `pcFeeAuthorityActivationRace.test.ts` (multiple prior ACTIVE) and
  `pcFeeAuthorityDuplicateCheck.test.ts` (real-table case) create the legacy duplicate state on purpose.
  Once the index exists, they need to switch to temporary tables (as the detection test's exact cases
  already do) or assert that the database refuses the duplicate.

Production risks:

- **Activation errors instead of duplicates.** Any code path that sets ACTIVE before replacing the prior
  row now fails with a unique-violation error. That is the intended trade, but the error must map to a
  clear refusal and not a 500. Today `activatePcFeeAuthority` (both versions) replaces first.
- **Readers with no ORDER BY.** `bootstrap.ts` takes the first ACTIVE row with no ordering. The index
  makes that deterministic. Until the index exists, duplicates make the billed authority arbitrary,
  which is why detection should run before go-live regardless.
- **Duplicates resolved wrongly.** Choosing the wrong survivor changes which rate or mandate is
  charged. Prerequisite 4 must stay a reviewed Brokerage Administrator decision with ledger and audit
  records.
- **INVALID index left behind** after a failed concurrent build (see above).
- **Scope mismatch.** If the Owner decides card and direct-debit authorities can coexist, this
  per-agent index would block legitimate data. Settle the open question first.
