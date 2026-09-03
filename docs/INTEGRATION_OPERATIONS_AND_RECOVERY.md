# Integration Operations and Recovery

Dead-letter replay, connection health, the migration-history finding from this step's own
work, and what an operator or a later engineer needs to know to run and extend this
foundation.

## 1. Migration history — a pre-existing finding, and how this step handled it

While generating this step's own migration, `drizzle-kit generate` produced a migration
that unexpectedly tried to **recreate `financial_payment_outbox`** — a table that already
exists in every environment this repository runs in. Investigating rather than shipping
that migration as-is found the actual cause, confirmed with direct evidence (not
assumed):

- `packages/db/migrations/0009_tired_warbird.sql` (committed on
  `remediation/financial-verification-step2`, already an ancestor of `staging` before
  this step began) creates `financial_payment_outbox` and a `financial_reconciliations`
  unique index.
- `packages/db/migrations/meta/_journal.json`, however, stops at index 8
  (`0008_striped_reaper`) — it has no entry for `0009_tired_warbird` at all. The file is
  git-tracked and real; the journal simply never recorded it.
- Confirmed live: `SELECT to_regclass('public.financial_payment_outbox')` returns the
  table on a database that has these migrations applied, while
  `drizzle.__drizzle_migrations` (the tracking table `drizzle-kit migrate` would normally
  use) has **zero rows** — this repository's actual dev/test workflow applies schema via
  `drizzle-kit push` (direct schema-to-database diffing), not the file-based
  migrate/journal pipeline. `db:push` doesn't consult the journal at all, so this
  inconsistency has been silently harmless for that workflow the whole time.
- This is not new or caused by this step: an earlier branch in this repository's own
  history, `chore/migration-snapshot-repair` (commit `5036bded`, "fix(db): restore
  missing migrations/meta/0000_snapshot.json"), shows this exact class of migration/
  snapshot drift has happened before, on an unrelated part of the history.

**What this step did about it**: did not hand-edit the shared, already-committed
`_journal.json`/snapshot lineage to "fix" a problem that predates this branch and is
unrelated to it — that risk (corrupting migration tooling other engineers rely on, based
on a guess about intent) outweighs the benefit. Instead:

1. The generated migration was filtered to remove the six statements belonging to
   `financial_payment_outbox`/the `financial_reconciliations` index (verified
   programmatically: the resulting file contains exactly the ten `CREATE TABLE
   integration_*` statements and their associated indexes/FKs, zero mentions of
   `financial`), and saved as `packages/db/migrations/0010_integration_and_data_exchange_foundation.sql`
   — a clean, standalone, hand-verified migration containing only this step's own tables.
2. The schema was applied to and verified against a real Postgres 16 database via
   `pnpm run db:push` — the same mechanism this repository's own dev/test workflow
   already relies on — confirming all ten new tables, and every pre-existing table
   including `financial_payment_outbox`, coexist with zero conflicts (89 tables total;
   `\dt integration_*` and `\d integration_connections` both verified directly).
3. This finding is recorded here rather than silently absorbed, per this step's own
   instruction to stop and report a discovered defect in a system it depends on rather
   than paper over it. It does not block this step's own completion — `db:push` gives a
   real, verified path to a correct database state — but a future engineer running
   `drizzle-kit generate` again will hit the same "unexpectedly wants to recreate
   `financial_payment_outbox`" result until the journal/snapshot lineage is properly
   repaired (likely by constructing a correct `0009_snapshot.json` for
   `0009_tired_warbird`'s actual effect and re-pointing the journal at it). That repair is
   explicitly out of scope for this step and is not attempted here.

## 2. Dead-letter replay

Both outbox commands and inbound webhooks share one dead-letter store
(`integration_dead_letters`, `sourceType: "OUTBOX" | "INBOX"`), with controlled replay:

- **`replayDeadLetteredCommand(deadLetterId, brokerageId, actor)`** (`outbox.ts`) — resets
  the original outbox row from `DEAD_LETTERED` back to `PENDING`, then calls the same
  `dispatchCommand()` every normal dispatch uses. This is a genuine re-execution, not a
  simulated result — if the underlying cause of failure is still present (proven directly
  by a test where the payload's `__forcePermanentRejection` flag is still set), the replay
  fails again, for real, and is dead-lettered again (as its own, distinctly-audited event
  — see the event-model document §2 on why the idempotency key includes the attempt
  number).
- **`replayDeadLetteredWebhook(deadLetterId, brokerageId, actor)`** (`webhooks.ts`) —
  re-enters the real, currently-registered effect handler for that
  `(provider, eventType)` pair. Proven with a test that registers a handler which throws
  on the first attempt (producing the original dead letter), then registers a
  succeeding handler and confirms the replay actually invokes it and succeeds — not a
  canned "replay always succeeds" stub.

Both replay functions call `markReplayed(deadLetterId, actorUserId, result, error?)`,
which records who replayed it, when, and the outcome — satisfying the brief's requirement
that replay be authorised, audited, and preserve the original event. `deadLetters.ts`
itself has no dependency on `outbox.ts` or `webhooks.ts` (avoiding a circular import); the
actual re-execution logic lives in those two files, which call back into
`deadLetters.ts`'s `markReplayed`.

Every dead-letter endpoint in `routes/integrations.ts` is behind the same
`requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES)` gate as every other admin operation
in this build — there is no separate, weaker authorization path for replay.

## 3. Connection health

`integration_connections.healthStatus` (`INTEGRATION_HEALTH_STATUSES`: `UNKNOWN`,
`HEALTHY`, `DEGRADED`, `UNAVAILABLE`, `AUTHENTICATION_REQUIRED`, `CONFIGURATION_ERROR`,
`RATE_LIMITED`, `SUSPENDED`) plus `healthCheckedAt`. `validateConnection()` sets
`healthStatus: "HEALTHY"` on a successful validation probe. There is no ongoing health
polling in this build — health only updates at validation time and does not currently
reflect the outcome of routine dispatch attempts (e.g. a string of `RATE_LIMITED` outbox
failures does not automatically flip the connection to `DEGRADED`). This is a real gap:
full observability and health-driven alerting is explicitly the next program stage
(brief §12), not this one.

## 4. Brokerage configuration and entitlements

`integration_settings` (one row per brokerage: `enabled`, `maxActiveConnections`) is
managed through `settings.ts`'s `getOrCreateIntegrationSettings`/`updateIntegrationSettings`
— the same lazy-create, race-safe pattern every other per-domain settings resolver in this
codebase already uses (e.g. `lib/communications/settings.ts`'s
`getOrCreateCommunicationSettings`). There is no single named "Brokerage Rules and
Configuration Engine" class anywhere in this codebase to integrate against literally; this
repeated, reviewed pattern is the actual configuration-resolution mechanism the brief's
Section 2 prerequisite check is describing, and this step's connection lifecycle uses it
the same way every other engine does.

Entitlement (`integrations.access`) is checked separately from brokerage-enablement, and
both are checked separately from role (`requireRole(...BROKERAGE_ADMIN_ROLES)` at the
route layer) — matching the brief's Section 5.18 instruction that possessing one of these
never implies another. `maxActiveConnections` exists as a column but is not yet enforced
anywhere in `model.ts` — a real, minor gap (nothing in this build's own connection count
ever approaches a limit worth enforcing, but the enforcement itself is not written).

## 5. Activating a real sandbox connection later

Not done in this build, and nothing here should be read as a shortcut past whatever
separate approval process the program's next stage defines. Mechanically, once a real
adapter and provider catalogue entry exist (`INTEGRATION_ADAPTER_CONTRACTS.md` §6), the
same lifecycle this build's mock connections already go through applies unchanged: create
a `DRAFT` connection with a specific declared purpose and requested scopes, request
approval, have a Brokerage Administrator approve it with the actual (possibly narrower)
scopes and record an `authorityUserId`, mint a real credential reference, configure, and
validate. The one behavioural difference for a real environment: `resolveActiveConnection`
currently hard-rejects anything but `environmentClassification: "MOCK"` — that specific
check is the deliberate gate stopping a real connection from ever becoming usable through
this build's code as it stands, and removing or widening it is exactly the kind of change
that belongs to an explicit, reviewed, later decision, not something this step does or
enables silently.
