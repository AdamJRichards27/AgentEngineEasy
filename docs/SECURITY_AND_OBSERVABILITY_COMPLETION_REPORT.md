# Security and Observability Completion Report

Agent Engine 2.0 — Step 2: Harden Security and Observability. This is the final,
evidence-based report for this step, prepared against `AdamJRichards27/AgentEngineEasy`,
branch `feat/security-observability-hardening`, PR #25 against `staging`.

**A note on this report's own limitation, disclosed up front rather than buried.** This
step's original governing instruction was extremely long and formally structured, and its
literal text was lost across multiple context-window compactions during this session. The
retained summary preserved the instruction's *structure* (Parts A–E, the specific
release-blocking treatment of tenant isolation, the "no real third-party sandbox/production
connection," "do not redesign unless closing a verified gap," and "never report a scan as
clean if not executed" constraints, and the requirement to close with one of a defined set
of decision labels) but not every verbatim enumerated list inside it — specific field
names, named-flow counts, alert-condition counts, incident-runbook counts, and the exact
wording of the decision-label set itself. Every document produced this step states this
plainly wherever it applies and substitutes a reasoned equivalent, flagged for a human
reviewer to diff against the original spec text if it's available outside this session.
This revision of the report additionally incorporates work completed in later session
windows that a stale, byte-identical-to-original copy of this document had not yet
reflected: the observability implementation itself (structured logging, correlation
propagation, bounded metrics — Part B), a real non-destructive backup/restore drill
(Part C), a clean full-regression-suite run, and the resolution of the lockfile gap
previously disclosed in §10. The decision label below is unchanged from the earlier
revision — it is still chosen from the label the retained summary explicitly named and
reasoned about (`PARTIALLY COMPLETE — REMEDIATION REQUIRED`) — but its supporting rationale
is updated to reflect how much smaller the remaining gap now is. The one label that *is*
recoverable with certainty is `BLOCKED — TENANT ISOLATION FAILURE`, because the
instruction's own treatment of that condition (release-blocking, triggered specifically by
unresolved cross-tenant exposure) was retained clearly enough across compactions to know it
does not apply here.

## 1. Decision

**PARTIALLY COMPLETE — REMEDIATION REQUIRED**

Every item this step's instruction would treat as release-blocking — unresolved cross-tenant
(IDOR) exposure — has been found, fixed, and verified with regression tests; the
tenant-isolation gate is closed (§5). This is explicitly **not**
`BLOCKED — TENANT ISOLATION FAILURE`. It is also not a clean `COMPLETE`, but the remaining
gap is now materially narrower than an earlier revision of this report recorded. Part B
(structured logging, correlation propagation, bounded metrics) is now substantially
**implemented** with real code and real tests, not merely specified (§6) — this is the
single biggest change since the previous revision of this decision. Part C's backup/restore
drill has been run for real, non-destructively, with real numbers (§8). The lockfile gap
disclosed in an earlier revision's §10 is resolved and confirmed pushed. What remains open
is disclosed by name, with a location and an owner-facing next step, in §6–§9 below and in
the standalone documents they summarize: a partial (not complete) `console.*`-to-structured-
logger migration, a handful of named metrics gaps, a typed-error-handling audit not yet
performed, no CI pipeline, and two dependency advisories (`xlsx`, `esbuild`) with no
registry fix available, pending human sign-off. Nothing is silently dropped from the
record.

## 2. Entry-gate evidence

Verified in an earlier session window and re-confirmed via `mcp__GitHub_MCP__list_branches`:
PR #24 (the prior step) was merged into `staging`; branch
`feat/security-observability-hardening` was created from `staging` HEAD with 35 files
spot-checked byte-identical to `staging` before any of this step's work began; `staging`'s
own tests/typecheck/build were confirmed passing prior to branching. This repository has no
`.github/workflows/` directory — there is no CI pipeline to gate against, confirmed
directly by directory listing, not assumed.

## 3. Security work (Part A)

Full detail and file-by-file citations live in `SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md`
(system overview, trust boundaries, assets, the full threat table, session-security and
webhook-trust models, perimeter hardening, secrets/dependency posture) and
`DATA_CLASSIFICATION_AND_PROTECTION.md` (data-category inventory, access control, the
formal secrets-scan record, file/upload security, the sensitive-data-in-logs gap, AI/
automation data handling). Summary of what changed this step, all real code with real
tests, not placeholders:

- **CORS**: explicit allowlist (`lib/cors.ts`) replacing `origin: true`; fails closed in
  production via `assertCorsConfigured()`, called at boot.
- **Rate limiting**: `middlewares/rateLimit.ts` — global (300/min/IP) and a tighter
  auth-specific limiter (20/min/IP on `/auth/*`), both real limiters, raised ceilings only
  under `NODE_ENV==="test"`.
- **Security headers**: `helmet()` mounted first in `app.ts`'s middleware chain.
- **Request body size**: explicit 1 MB JSON limit, replacing Express's undocumented
  implicit 100 KB default.
- **Session revocation**: new `users.sessionEpoch` column (migration
  `0011_session_epoch_revocation.sql`), embedded in the session token and re-checked on
  every request; `POST /auth/logout` bumps it, instantly invalidating every other
  outstanding token for that user — closes a real gap where a captured/replayed token
  previously stayed valid for its full 30-day lifetime after logout.
- **Health check**: split into liveness/readiness/degraded (§6) — a real `select 1` against
  Postgres, returning 503 on genuine failure, replacing an unconditional static 200.
- **Dependency fix**: `qs` (transitive via `express`) pinned to `^6.16.0` via a root
  `pnpm.overrides` entry, resolving `GHSA-x5fp-wj9c-mxmx`/`GHSA-4mjr-xmp4-gh2g`.
- **Integration security re-verification**: `mintMockAuthFlow` — the one integration-admin
  handler with no tenant check — fixed; every webhook router (communications, financial,
  integrations) re-verified signature-authentic and tenant-resolved-from-payload, not from
  a client-asserted id (`SECURE_INTEGRATION_BOUNDARY.md`).
- **AI/automation security**: reviewed, not modified — `lib/ai/governance.ts`/
  `policyEngine.ts`/`executionGateway.ts` already gate state-changing AI actions behind an
  explicit human-approval step, and the context-assembly functions are tenant-scoped
  (`DATA_CLASSIFICATION_AND_PROTECTION.md` §7).
- **File/upload security**: reviewed, not modified — pre-existing `fileValidation.ts`
  already enforces a 25 MB/50k-row cap, extension allowlist, magic-byte verification, and
  suspicious-MIME rejection ahead of any parser (`DATA_CLASSIFICATION_AND_PROTECTION.md`
  §5).

**By far the largest body of work in Part A is the tenant-isolation audit** — see §4/§5.

## 4. Findings and remediation

Nine real tenant-isolation defects were found and fixed this step across the full route
surface: eight CRITICAL (full cross-tenant read and/or write of another brokerage's data)
and one MEDIUM (a write-side reference-integrity gap with no confirmed read leak). Every
finding was verified by personally reading the actual vulnerable query — never inferred
from a description — and every fix was personally re-read against the live file after
implementation, before being counted as closed.

| # | Domain | Defect | Fix |
|---|---|---|---|
| 1 | Payments | `chargeServiceOrder`/`refundPayment`/`listPaymentsForServiceOrder` loaded by id with no brokerage filter. | New brokerage-scoped chokepoints; 9/9 new tests pass. |
| 2 | Documents | Agency terms, package populate, send-for-signature, and document content all loaded by id/propertyId with no brokerage check — including real signed-contract content. | New tenant-scoped chokepoints in `lib/documents.ts`; 12/12 new tests pass. |
| 3 | AML | Retry/resolve-exception had no brokerage check; two by-property GETs leaked cross-tenant. | Brokerage-scoped joins throughout; 12/12 tests pass (6 new + 6 existing). |
| 4 | Parties | Create/list/delete party-property links trusted a client-supplied id with no ownership check — cross-tenant PII read and cross-tenant write with real side effects. | Every handler checks `properties.brokerageId` in the same query; 4/4 new tests pass. |
| 5 | Financial (PC fee) | Fee-authority lookup filtered by id only — could disclose another brokerage's confidential commission mandate terms. | Single filtered query (`id AND brokerageId`); 7/7 tests pass. |
| 6 | Integrations | `mintMockAuthFlow` had no brokerage parameter at all — could mint/reactivate any brokerage's credential, including un-revoking one. | Now routes through the same `loadConnectionInBrokerage` chokepoint every sibling handler already used; 7/7 tests pass (2 new + 5 existing). |
| 7/7b | Pit Crew | Work-item overlay validated `propertyId` but not the foreign `sourceRecordId`, nor the assignee's brokerage. | New `assertSourceRecordOnPropertyInBrokerage`/`assertUserInBrokerage` guards; 37/37 tests pass. |
| 8 | Grow | `POST /activities` accepted `partyId`/`propertyId`/`opportunityId` with no ownership check (MEDIUM — write-side gap, no confirmed read leak). | Each optional field checked against the caller's brokerage before insert; 10/10 tests pass (2 new + 8 existing). |

Full defect descriptions, before/after code shape, and the complete 28-file
tenant-isolation matrix are in `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` —
this report summarizes it, not replaces it.

## 5. Tenant-isolation matrix — summary

28 route files audited in total: 8 required a fix for a CRITICAL finding (now PASS, all
with new regression tests), 1 required a fix for a MEDIUM finding (now PASS, with new
tests), 13 were already correctly scoped with no change needed, 3 are webhook routers
verified correct by design (signature-authenticated, tenant resolved from the verified
payload/connection, never a session), and 3 have no tenant-scoped id-lookup surface at all.
Two low-severity, non-blocking items are deferred rather than fixed this step (a
distinguishable-403 existence leak on payment-method delete, and an unvalidated-but-
unread solicitor-party-id field on transactions) — see §9. The full per-file verdict table
with evidence citations is `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` §5.

**This is the basis for the decision in §1 that `BLOCKED — TENANT ISOLATION FAILURE` does
not apply**: every CRITICAL/MEDIUM finding this step's instruction would classify as
release-blocking has a verified fix and a passing regression test, not a self-report.

## 6. Observability work (Part B) — now implemented, not merely specified

Full detail in `OBSERVABILITY_STANDARD.md` and `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`.
An earlier revision of this report recorded Part B as "specified but not implemented." That
is no longer accurate — the following is real code, backed by real tests, not a
specification for a future team:

- **Structured logging with central redaction.** `packages/events/src/logger.ts` exports
  `logger.debug/info/warn/error`, writing single-line JSON with `timestamp`/`level`/
  `message` plus the ambient `correlationId`/`causationId` when active. Every field passed
  through `packages/events/src/redaction.ts`'s `redactForLog` first — a never-log key-name
  list (secrets, payment/banking fields, government-id fields, document/communication
  content) plus value-shape detection (bearer tokens, JWTs, PEM headers) that a caller
  cannot opt out of. Proven by 8 tests (`logger.test.ts`) and 17 tests (`redaction.test.ts`).
- **Correlation propagation, proven across six named flows, with two real bugs found and
  fixed.** `packages/events/src/context.ts`'s `AsyncLocalStorage`-based ambient
  correlation/causation context, established per-request by `middlewares/requestId.ts` and
  echoed as `X-Correlation-Id`. This step found and fixed two genuine gaps where a
  *deferred* operation (outside any request context — a scheduler tick) silently started a
  disconnected correlationId chain instead of continuing the originating request's:
  communications' deferred/scheduled message dispatch (`lib/communications/messages.ts`),
  and financial payment-debit scheduling (`routes/financial.ts`'s `schedule-debit` route).
  Both are proven by dedicated tests exercising the actual no-ambient-context dispatch path,
  not just the easier inline case. Beyond those two specific bugs, this step also completed
  a consistency pass across effectively every remaining `publishDomainEvent` call site in
  `apps/api/src/lib/**` and `apps/api/src/routes/**` (documents, offers, AML, appraisals,
  transaction conditions, billing sync, AI action events, integration connection lifecycle,
  the SMS communications proof, launch, transactions, go-live, properties, and grow) so that
  every domain event across the codebase — not only the six named proof flows — resolves
  its correlationId via `currentCorrelationId()` rather than omitting the field or silently
  defaulting to a disconnected fresh id. The six named flows (Mock Property Launch
  publication, Mock Communications delivery, Mock Financial status processing,
  Retry-to-dead-letter, Authorised replay, and Workflow-to-Risk escalation) are each proven
  by a dedicated test asserting the same correlationId ties the whole chain together — full
  detail, including the one flow (#6) that is deliberately reference-linked rather than
  correlationId-shared and why, is in `OBSERVABILITY_STANDARD.md` §3.
- **Bounded-cardinality metrics.** `packages/events/src/metrics.ts` declares nine
  counters/histograms with fully bounded label-value sets (out-of-set values throw in
  test/dev, coerce to `"other"` in production), exposed as Prometheus text at
  `GET /api/internal/metrics` behind a bearer token that fails closed at boot in
  production. Backs 11 SLI areas and 21 alert-ready conditions (19 metric-backed, 2 still
  log-based and named as such) — full registry in
  `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`. Proven by 16 tests (`metrics.test.ts`).
- **Health check split.** `routes/health.ts`'s liveness/readiness/degraded three-way split
  (§3 above), observing `health_check_duration_ms{status}` on every check and logging via
  the structured logger rather than `console.error`. Proven by 11 tests
  (`health.test.ts`).

**What remains genuinely unimplemented in Part B, disclosed rather than implied away** (full
detail in `OBSERVABILITY_STANDARD.md` §6 and `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §4):

- The `console.*`-to-structured-logger migration is **partial**: of 109 raw `console.*`
  call sites outside test files at the start of this step's observability work, 92 remain
  across 41 files (several files use both, a per-file partial migration — e.g. `lib/aml.ts`,
  `lib/documents.ts`, `lib/offers.ts`, `lib/transactions.ts`).
- No dedicated tenant-isolation-rejection metric — SLI #10/alert #8 are still log-based.
- `communicationsWebhooks.ts` and `financialWebhooks.ts` don't yet emit
  `integration_webhook_total` — only the integrations webhook router does.
- No dedicated payment or import-job metrics — alerts #20/#21 are real but log-based.
- Per-rule exception-engine failures are not separately counted (only scan-level).
- A typed-error-handling audit was not systematically performed beyond what surfaced
  incidentally during the tenant-isolation work.

## 7. Security tooling results

Recorded exactly, per this step's own "never report a scan as clean if not executed"
constraint:

- **`pnpm audit`**: executed. Before this step's dependency work: 1 low, 4 moderate, 2
  high, 0 critical (7 total). After the `qs` override: 1 low, 2 moderate, 2 high, 0
  critical (4 total) — the two `qs` advisories no longer appear, confirmed by re-running
  the audit, not assumed. The two remaining findings (`xlsx@0.18.5` ×2 high;
  `esbuild` moderate+low, dev-only/transitive) have no fix available through the npm
  registry and are documented with compensating controls and a request for human sign-off
  on next steps (`SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §8).
- **Secrets scan**: executed — a pattern-based scan of the full working tree (high-entropy
  literals, provider-specific key prefixes, PEM headers, JWT shapes, any non-`.env.example`
  `.env` file, any hardcoded credential fallback) plus a manual review of every `.env*`
  file and every file matching `*secret*`/`*key*`/`*credential*` in name. No live secret
  values found anywhere in the repository. Git-history scanning and any secret store
  external to the repository remain out of scope (no local `.git` directory in this
  session's working environment). Full record: `DATA_CLASSIFICATION_AND_PROTECTION.md` §4.
- **Not run, disclosed rather than omitted silently**: no SAST/DAST tool, no dependency
  license scan, and no formal penetration test were executed this step. No such tooling is
  configured in this repository, and standing one up was judged outside this step's scope
  of hardening existing engines. This is a real gap for a future step, not a claim of
  coverage that wasn't earned.

## 8. Test-and-build evidence

Every new test file listed in §4/§5 was run and confirmed passing as part of this step's
own implementation discipline (not merely written and assumed correct) — the completion
figures cited per-finding in §4 (9/9, 12/12, 12/12, 4/4, 7/7, 7/7, 37/37, 10/10) are direct
counts from those runs.

**The full regression suite — final, clean run, this step's own headline test evidence.**
The complete `node:test` suite across `apps/api` was run in the background
(`nohup pnpm run test > logfile 2>&1 &`), monitored via `tail`/`wc -l`, and confirmed
complete once its process (PID) had exited. Final tally, read directly from the TAP
summary, not paraphrased or estimated:

```
1..560
# tests 637
# suites 82
# pass 636
# fail 0
# cancelled 0
# skipped 1
# todo 0
# duration_ms 816741.15869
```

**637 tests, 636 passing, 0 failing, 1 skipped, ~13.6 minutes total.** This run post-dates
every correlationId-propagation fix and every tenant-isolation fix described in this
report, and includes a genuine test-fragility fix found and closed during this step's own
testing work: `lib/automation/__tests__/stage2Engine.test.ts`'s "duplicate delivery" test
queried `domainEvents` filtered only by `brokerageId`, which could nondeterministically
select a different event than the intended `OFFER_ACCEPTED` row whenever more than one
domain event existed for that brokerage in the test's fixture data — a test-suite flake,
not a production defect. Fixed by filtering the same query by `eventType` as well
(mirroring the identical, already-correct pattern used elsewhere in the same file's "audit
continuity" test). The clean 637/636/0/1 result above confirms that fix is correct and
introduced no regressions elsewhere in the suite.

`tsc --noEmit` (the `typecheck` script) and the `esbuild` production build were both run
clean after the `qs` override, confirming the dependency change didn't break anything.

**This report's own limitation on reproducing raw transcripts, disclosed rather than
glossed over:** because this session's working environment does not persist raw command
output verbatim across a context compaction, the exact terminal bytes of every individual
run are not reproducible in this document — what's stated above (the TAP summary block) is
transcribed directly from the log file this step's own background test run produced, at the
time that run completed, not a fabricated or reconstructed re-run. No claim in this report
states a scan or test run happened that didn't.

## 9. Deferred and accepted risks

Every item below was a deliberate decision, not an oversight, and each is cross-referenced
to the document that carries its full reasoning:

- **`xlsx@0.18.5`** — two high-severity advisories (prototype pollution, ReDoS) with no
  npm-registry fix available. Compensating controls in place (size/row caps, extension
  allowlist, magic-byte check, authenticated-only reach). Needs human sign-off on whether
  to adopt SheetJS's non-registry CDN build or migrate parsers
  (`SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §8, `DATA_CLASSIFICATION_AND_PROTECTION.md`
  §5).
- **`esbuild`** — dev-only, transitive via a pinned `drizzle-kit` version with no
  compatible fix; never present in the running API's own dependency graph.
- **The partial `console.*` sweep** (92 of an original 109 raw call sites remain, across 41
  files) — see §6. Judged lower-value to finish mechanically this step than finding and
  fixing the two real correlation-propagation bugs, and riskier to sweep unreviewed in one
  pass. Recorded as open follow-up work, not claimed as done.
- **The named metrics gaps in §6** (no dedicated tenant-isolation/payment/import metrics,
  two webhook routers not yet emitting `integration_webhook_total`, no per-rule
  exception-scan metric) — each a straightforward, scoped addition, deliberately not made
  this pass so this step's metrics work stayed focused on wiring the gaps its own
  correlation-propagation proof work actually surfaced, not opening every plausible new
  instrumentation surface at once.
- **Typed error handling audit** — not systematically performed beyond what surfaced
  incidentally during the tenant-isolation work. Recorded as open scope.
- **`DELETE /payment-methods/:id`** — returns a distinguishable 403 (row exists, wrong
  owner) rather than the uniform 404 pattern used everywhere else; an existence-leak, not a
  data leak. Low severity, flagged not fixed.
- **`recordLegalRepresentatives`** (`lib/transactions.ts`) — stores a client-supplied
  solicitor-party id with no ownership check, but nothing currently reads it back
  cross-tenant. Low severity, flagged not fixed.
- **Sensitive webhook-payload redaction for a future real provider** — `integration_inbox.
  payload` stores whatever a webhook sends, in full, for audit/replay; today's three mock
  providers never send anything sensitive, but the new central redaction module (§6) applies
  to structured *log* lines, not to this persisted raw payload column — a distinct, still-
  open concern for whenever a real (non-mock) provider is connected
  (`SECURE_INTEGRATION_BOUNDARY.md` §5).
- **No CI pipeline exists** in this repository (`.github/workflows/` absent) to enforce
  `--frozen-lockfile`, run `pnpm audit` on a schedule, or gate a merge on the test suite.
  This is a pre-existing condition, not something this step introduced, but it means every
  piece of evidence in this report is a manually-executed, point-in-time record rather
  than a continuously-enforced guarantee.

**Resolved since an earlier revision of this report, no longer open:**

- **A real backup/restore drill.** An earlier revision recorded this as not run. It has
  since been run in full, non-destructively, against the local `aee_test` database (never
  production — none exists for this build): a `pg_dump`/`pg_restore` cycle with verified
  schema parity (89/89 tables, 191/191 indexes, 357/357 constraints), zero orphaned rows
  across all 256 foreign-key constraints, and a matching whole-table MD5 checksum on an
  unaffected table, with the scratch database and dump file cleaned up afterward. Full
  procedure and numbers: `SECURITY_INCIDENT_RUNBOOKS.md`, "Backup and recovery" section.
- **The `pnpm-lock.yaml` gap.** An earlier revision recorded the regenerated lockfile as
  deliberately not pushed, out of concern for transcription error in a large file full of
  integrity hashes. It has since been pushed and is confirmed present on
  `feat/security-observability-hardening` at the expected size, matching the local
  working copy exactly (100,559 bytes, both sides independently checked this session).

## 10. Git-and-PR-state

This session's working environment has no local `.git` directory for this repository and
no working git/API credential shaped like a real GitHub PAT/App-token for direct git
operations against it. All repository writes this step went through the sanctioned
`mcp__GitHub_MCP__push_files` tool. Every file pushed was personally re-read from the local
working copy immediately before being included in its push — never taken on trust from an
earlier summary or assumed unchanged — and, for the correlationId-propagation consistency
pass in particular, each file's byte-size difference from its already-pushed remote version
was independently confirmed (via `mcp__GitHub_MCP__get_file_contents`) before spending a
push on it, so no push in this step was wasted re-sending an already-identical file.

**Branch state.** `feat/security-observability-hardening` was created from `staging` HEAD
(§2) and has since received, across this step's full working history:

1. Core security-hardening middleware/routes (CORS, rate limiting, helmet, requestId,
   session-epoch revocation, health check, `.env.example`, the `qs` override) and the
   round-1/round-2 tenant-scoping route and library fixes summarized in §4/§5, each with
   its own regression tests.
2. Part E documentation (`SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md`,
   `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`,
   `DATA_CLASSIFICATION_AND_PROTECTION.md`, `INTEGRATION_SECURITY_BOUNDARY.md`).
3. The regenerated `pnpm-lock.yaml`, closing the lockfile gap noted in §9.
4. The Part B observability implementation itself: `packages/events`'s logger, redaction,
   context, and metrics modules and their test suites; the health-check split; the
   correlation-propagation fixes and their proof tests across communications, financial,
   integrations (outbox, webhooks, connection lifecycle, the comms/SMS proof), exceptions
   (engine and its dead-letter/replay proof), launch, transactions, documents, offers, AML,
   appraisals, transaction conditions, billing sync, AI action events, go-live, properties,
   and grow — each file's diff independently size-verified against the already-pushed
   remote version before its push, as described above.
5. The Part B/C documentation rewrites: `OBSERVABILITY_STANDARD.md`,
   `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`, `SECURITY_INCIDENT_RUNBOOKS.md` (including
   the real backup/restore drill section), and `SECURE_INTEGRATION_BOUNDARY.md`.
6. This completion report.

PR #25 against `staging` carries this step's full scope and is updated in place (via
`mcp__GitHub_MCP__update_pull_request`) to reflect this revision's decision and evidence,
rather than a new pull request being opened — no duplicate PR was created and no merge was
performed without explicit authorization.

## 11. Next-step recommendation

For whoever reviews or continues this work:

1. **Human sign-off needed**: the `xlsx` dependency decision (§9) — accept the residual
   risk behind the existing compensating controls, adopt SheetJS's non-registry patched
   build, or migrate to a different parsing library.
2. **Finish the `console.*`-to-structured-logger sweep** — 92 of the original 109 call
   sites remain, across 41 files (`OBSERVABILITY_STANDARD.md` §6 names the exact grep to
   reproduce the count). The highest-value remaining files are the ones already
   partially migrated (`lib/aml.ts`, `lib/documents.ts`, `lib/offers.ts`,
   `lib/transactions.ts`), since finishing those closes out files that are already halfway
   converted rather than opening new ones.
3. **Close the remaining named metrics gaps** (`METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`
   §4): wire `integration_webhook_total` into `communicationsWebhooks.ts` and
   `financialWebhooks.ts`, add a dedicated tenant-isolation-rejection counter, and add
   dedicated payment-outcome/import-job metrics to back alerts #20/#21 with real counters
   instead of log-based detection.
4. **Stand up CI** (`.github/workflows/`) so this report's manually-executed evidence
   (test suite, `pnpm audit`, typecheck) becomes a continuously-enforced gate instead of a
   point-in-time record — this would also structurally enforce `--frozen-lockfile` against
   the now-current, correctly-pushed lockfile (§9).
5. **Typed error handling audit** — not systematically performed this step beyond what
   surfaced incidentally during the tenant-isolation work; a dedicated pass is real
   follow-up scope.
6. **SAST/DAST/penetration testing** — none configured or run in this repository; a real
   gap for a future step once real infrastructure and a third-party engagement are
   authorized.
7. Compare every "reasoned equivalent" flagged throughout this step's documents (field
   lists, named flows, alert/incident counts, and this report's own decision-label choice
   in §1) against the original instruction text if it is available outside this session,
   and correct any material divergence.
