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

## 2a. Dead-letter recovery and the Exception and Risk Engine (Step 5 remediation, Proof D)

A dead letter sitting unresolved is not just an operator's problem to notice manually —
since the remediation pass, it also becomes a tracked, owned, escalating risk case,
through the same Exception and Risk Engine every other operational risk in AE already goes
through (`lib/exceptions/`), not a new, parallel alerting mechanism.

`lib/exceptions/rules/integrationOperational.ts` registers one rule,
`INTEGRATION_OPERATIONAL_COMMAND_DEAD_LETTERED`, triggered on the
`INTEGRATION_COMMAND_DEAD_LETTERED` event this document's companion,
`INTEGRATION_EVENT_AND_DELIVERY_MODEL.md`, already describes. The rule is generic across
every capability and provider registered in `registry.ts` — Proof A/B/C's mock adapters
all dispatch through the same `outbox.ts`, so one rule covers a dead-lettered portal
command, SMS send, or payment-status sync alike, without knowing anything about those
domains' internals. It resolves the affected property/transaction through
`lib/integrations/sourceRecordResolvers.ts`'s generic registry rather than importing
communications/financial/launch model code directly — keeping the same provider-neutral
discipline the rest of this foundation follows, now extended to the risk layer.

**Severity**: `AT_RISK` from the moment of dead-lettering (never a premature `CRITICAL` on
a single failure — the outbox already exhausted its own retry budget before this rule ever
sees the row, so `AT_RISK` is the correct starting point, not `INFORMATION`/`ATTENTION`),
escalating to `CRITICAL` after 24 hours unresolved. This ladder is platform-protected and
not exposed to brokerage configuration — no brokerage setting can loosen or disable it.

**Ownership and metadata**: the case carries a problem statement, cause, resolved owner
(via the same `resolveDefaultOwner` every other risk rule uses), severity, deadline, a
recommended action, a resolution path, and five allow-listed correlation fields
(`integrationOutboxId`, `integrationConnectionId`, `integrationCapability`,
`integrationSourceRecordType`, `integrationSourceRecordId`) — extending the
correlation/causation provenance chain `INTEGRATION_AND_DATA_EXCHANGE_FOUNDATION.md` §4
already requires into the Risk Engine itself.

**Not dismissible.** Unlike some risk findings, this one cannot be dismissed by an
operator clicking through it — the underlying integration failure is either genuinely
resolved (a successful replay) or it isn't; dismissing the case without resolving the
failure would hide a real, still-broken integration.

**Auto-resolution is real, not assumed.** The event-driven path
(`handleExceptionDomainEvent`) never auto-resolves a case on its own — by design, matching
every other rule in this registry, since only a full scheduled sweep across every rule can
safely conclude a condition actually cleared. `runScheduledScan()` does both create/update
*and* auto-resolve: once an authorised replay (`replayDeadLetteredCommand`, Section 2
above) genuinely succeeds — a real re-execution through the real dispatch path, not a
simulated result — the next scheduled scan finds the outbox row is no longer
`DEAD_LETTERED` and resolves the case with `resolutionMethod: "AUTO"` and
`resolutionEvidence.kind: "RULE_CONDITION_CLEARED"`.

**No duplicate cases.** The rule's dedup key scopes on `(brokerageId, ruleId,
sourceRecordId)`; repeated scans of the same still-unresolved dead letter update the
existing case's `occurrenceCount` rather than creating a second case.

**Skips rather than guesses.** A dead-lettered command whose `sourceRecordType` has no
registered resolver, or whose resolver can't find a same-tenant record, is skipped — the
same discipline other rules in this registry already apply to malformed or ambiguous
triggering data, rather than fabricating a case against a guess.

All of the above is proven by `apps/api/src/lib/exceptions/__tests__/
integrationOperational.test.ts`'s 6-test suite — see
`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` §E, scenario 15, for the exact assertions.

**A second, sibling risk rule** was wired in for Proof C in the same pass:
`FIN05_RECONCILIATION_VARIANCE_UNRESOLVED` (`rules/financial.ts`) turns an unresolved
`VARIANCE` row in `financial_reconciliations` (written by
`lib/financial/mockPaymentStatusSync.ts`, Section 2a's Proof C companion) into a
dismissible, `ATTENTION`-severity risk case. Unlike H01, it is purely scheduled-scan-driven
(`triggerEventTypes: []` — `mockPaymentStatusSync.ts` publishes no domain event of its own)
and it is dismissible (a reconciliation variance can be a genuinely benign provider-side
quirk a human judges and waves off, unlike a confirmed integration failure). This rule
existed, fully wired, with zero test coverage until a gap was found and closed — see
`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` §D.3 for the full account, and the new
`financialReconciliationVariance.test.ts` for the proof.

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
`getOrCreateCommunicationSettings`). Since the remediation pass, a Brokerage Administrator
can read and update this same settings row directly from the Overview tab of Settings →
Integrations (`GET`/`PUT /integrations/settings`), rather than only through a script or a
database console — the UI is a thin, RBAC-gated surface over the exact same
`settings.ts` functions, not a second settings path. There is no single named "Brokerage Rules and
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

## 6. Bugs found and fixed during this step (both passes), one test-coverage gap closed, and one bug left deliberately unfixed

Every one of these was found by a real, executed test or a real, driven browser session —
never by inspection alone — and every fix is a genuine code change, not a test weakened to
pass. Disclosed here in full because two of them have a wider blast radius than the file
they were found in.

**1. `resolveActiveConnection` tenant-check ordering (original pass).** Checked
brokerage-level settings and entitlement *before* verifying the connection belonged to the
caller's own brokerage — a cross-tenant caller got `ENTITLEMENT_DENIED` (about their *own*
brokerage) instead of the required uniform `NOT_FOUND`. Fixed by moving the tenant/
existence check first. Scope: this file only (`registry.ts`).

**2. `failCommand` dead-letter event idempotency key (original pass).** Published
`INTEGRATION_COMMAND_DEAD_LETTERED` with an idempotency key keyed only on the outbox row
id. A replay that fails again permanently calls `failCommand` a second time for the same
row, and the second publish collided with the first on `domain_events`' own unique
constraint — silently losing the second dead-letter event. Fixed by including the attempt
number in the key. Scope: this file only (`outbox.ts`).

**3. `severityForDeadline` sign inversion (remediation pass) — wide blast radius.**
`lib/exceptions/rules/shared.ts`'s `severityForDeadline(now, dueDate, approachingDays,
criticalAfterDays)` had a sign error in how it computed days-until-due versus
days-overdue, such that a freshly-due or recently-overdue finding could read as more
severe than it actually was (in some inputs, immediately `CRITICAL` instead of `ATTENTION`
or `AT_RISK`). This function is not specific to Proof D — it is the shared severity-ladder
helper roughly 18 different risk rules across the entire Exception and Risk Engine call,
covering essentially every deadline-driven risk category in AE, not just integration
operational failures. **Found** while building and testing Proof D's own severity-ladder
assertions (a fresh dead-letter must read `AT_RISK`, never a premature `CRITICAL`) —
without that specific test, this would have shipped unnoticed. **Fixed** by correcting the
sign convention: `daysUntilDue = daysBetween(dueDate, now)`; `> approachingDays` →
`INFORMATION`; `> 0` → `ATTENTION`; otherwise `daysOverdue = -daysUntilDue`, `>=
criticalAfterDays` → `CRITICAL`, else `AT_RISK`. Verified directly by
`integrationOperational.test.ts` (a fresh dead-letter reads `AT_RISK`; after backdating
`updatedAt` by more than 24h, the *same* case reads `CRITICAL`) and by the full existing
regression suite passing unchanged afterward (564/564), which is the strongest available
evidence that every other rule's own severity behaviour was already relying on the
*corrected* convention, not the buggy one — i.e. this was a true latent bug, not a
convention every other rule had already quietly worked around.

**4. `recordMapping` Postgres conflict-error-shape check (remediation pass).**
`lib/integrations/mapping.ts`'s `recordMapping` catches a Postgres `23505` (unique
violation) to detect an ambiguous mapping and convert it to a typed
`MappingConflictError` rather than letting a raw DB error surface. It checked only
`err?.code === "23505"`, but the actual driver error in this codebase's Postgres client is
sometimes wrapped, exposing the code at `err?.cause?.code` instead — meaning some genuine
mapping conflicts were falling through as an unhandled, un-typed error instead of the
intended, catchable `MappingConflictError`. **Fixed** by checking both `err?.code` and
`err?.cause?.code`. Scope: this file only (`mapping.ts`) — `recordMapping` is the only
function in this codebase using this specific catch pattern against this specific
constraint.

**5. `ConnectionsTab` frontend prefill race condition (remediation pass) — found by live
browser testing, not a unit test.** Full writeup and fix in
`INTEGRATION_FOUNDATION_COMPLETION_REPORT.md` §D.2. Summary: a loading-gated early return
in the admin UI's Connections tab prevented the create-connection form from existing on
its first render, while a mount-time effect had already cleared the parent's copy of the
provider-to-prefill id — so clicking "Connect…" from the Overview tab opened an empty,
unprefilled form instead of the intended pre-populated one. Fixed structurally (the form
now always renders on first paint) and defensively (a captured local copy of the prefill
prop, immune to the parent clearing its own state later).

**6. `FIN05_RECONCILIATION_VARIANCE_UNRESOLVED` had zero test coverage (remediation pass)
— a test-coverage gap, not a code defect.** This second new risk rule (Section 2a above)
was fully implemented and wired into `FINANCIAL_RULES`/`registry.ts` — live in every
scheduled scan — but no test anywhere exercised it, found while double-checking Proof C's
own "routed for manual review" claim. **Closed**, not just flagged: a new 4-test file,
`financialReconciliationVariance.test.ts`, proves the rule end to end (opens on a real
variance, never duplicates, auto-resolves on a later matching event, respects
`dismissible: true`, isolates cross-tenant) — all 4 passed on the first real run, meaning
the rule's own logic was already correct; only its test coverage was missing. `FIN01-04`
(pre-existing risk rules, unrelated to this step) have this same absence of dedicated
rule-level tests and were deliberately left untouched — extending coverage to them is
outside this step's remit.

**Left deliberately unfixed — the same `err?.code`-only pattern as bug 4, found but out of
scope.** The narrow `err?.code === "23505"`-only check (missing the `err?.cause?.code`
fallback that turned out to matter in `mapping.ts`) also exists, unfixed, in at least
`lib/integrations/outbox.ts` (its own idempotent-enqueue conflict handling) and
`lib/launch/model.ts` (a pre-existing, pre-Step-5 conflict-handling call site, unrelated to
this step's own work). Both are **latent, not proven-broken** — unlike `mapping.ts`, no
test in either area has yet exercised a real wrapped-error case to confirm the fallthrough
actually happens there too. Fixing `mapping.ts` alone (the file this step's own Proof B/C/D
work actually touches and depends on) and flagging the same pattern elsewhere, rather than
opportunistically patching every occurrence found while reading unrelated code, is a
deliberate scope decision: those two files belong to areas outside this step's own remit
(the general outbox conflict path, and pre-existing Launch code), and a drive-by fix there
without dedicated tests for that specific code path would be exactly the kind of
unreviewed, unproven change this program's own discipline argues against.

## 7. Admin UI: known, disclosed limitations

- **The two "operational test action" forms take a raw numeric AE record id, not a guided
  picker.** The connection detail view's "Send test SMS" and "Link payment reference"
  actions (visible only on an `ACTIVE` connection matching the relevant provider) are thin
  wrappers around Proof B's and Proof C's own domain-proof action endpoints
  (`POST .../actions/send-sms`, `POST .../actions/link-payment-reference`), intended for an
  operator who already knows the specific `communicationMessageId` or
  `paymentRequestId`/`connectionId` (payment context) to manually verify a live connection
  — not a discovery workflow for finding the right record. Building a search/picker control
  for either was judged out of scope for an administration surface whose primary job is
  connection lifecycle and recovery, not record lookup; AE's existing per-domain UIs
  (Communications Hub, Financial Operations) already are the guided way to find those ids.
- **Connection health does not reflect ongoing dispatch outcomes**, per Section 3 above —
  the admin UI's health pill shows exactly what `validateConnection()` last recorded,
  nothing more.
- **No standing reconciliation-run history** — the Reconciliation tab computes and shows a
  live, on-demand snapshot each time it's opened, not a stored history of past snapshots to
  compare against.
