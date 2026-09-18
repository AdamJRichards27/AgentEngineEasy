# AE GROW Priority 6 — Stage F3 final verification

Date: 2026-09-18. No commit, push, PR, staging operation, or production feature change was performed.

## Decision

**Not ready for commit/push.** The audit exposes a tenant-existence disclosure and an unresolved state-reachability requirement. These are not the previously excluded voice-recording or preview-runtime defects.

1. A cross-brokerage transcription initiation request for an existing foreign `(call_session_id, recording_reference)` receives HTTP 409 with `TENANT_MISMATCH` and “The transcription belongs to another brokerage.” The same foreign session with an absent tuple receives HTTP 404 with `CALL_NOT_FOUND`. No transcript content is returned and no foreign artifact or Timeline entry is modified, but the distinction discloses existence. The new regression requires uniform not-found behavior and is intentionally retained as failing.
2. `MEDIA_PROCESSING`, `DELETION_SCHEDULED`, and `DELETED` are accepted by the schema and recognized by consumers, but no production operation enters these states. Database fixture updates do not establish production reachability. Either implement and test the required lifecycle transitions or explicitly approve a narrower requirement for reserved states.

## Test-coverage audit

| Requirement | Real test evidence / conclusion |
|---|---|
| Table shape, defaults, JSONB, unique tuple | New `packages/db/src/schema/callTranscriptions.test.ts` exercises the migrated database, JSONB round-trips, CHECK rejection, default metadata, and duplicate tuple rejection. Review item shape, duplicates, and forged metadata are covered by the existing service review validation tests. |
| All processing states reachable | Seven production-entry states are exercised: PENDING, TRANSCRIBING, AWAITING_AGENT_REVIEW, APPROVED, PARTIALLY_APPROVED, DISCARDED, FAILED. The three additional states above remain an audit gap; enum storage tests are not presented as transition proof. |
| Call approval flag | New policy tests prove default false, literal-true semantics, and independence from voice/telephony approvals. Existing real service tests prove mock use without approval and real-provider rejection without approval. |
| Eligibility / entitlement / F2 evidence | Service tests deny missing/revoked entitlement, reject each denied or forged persisted F2 gate, and revalidate source access. New in-flight revocation tests cover actor access and removed/invalidated F2 evidence. The production implementation continues to use persisted F2 proof, not a new recording policy. |
| Idempotency | Real concurrent/replayed initiation tests and the new database uniqueness test cover the immutable call/recording tuple. |
| Failure reasons | All 18 policy reasons have triggering service/reconciliation/validation tests. New cases cover missing provider credentials, unknown provider configuration, and in-flight access/F2 changes; invalid-audio and audit-failure assertions now include terminal state and retry count. `INVALID_INPUT` and `RECORDING_REFERENCE_MISMATCH` are correctly rejected before artifact creation; claiming a terminal artifact for those initial denials would be incorrect. |
| Exact retry cap | Timeout, provider error, and malformed output tests assert exactly four attempts total, retryCount 3, terminal FAILED, no resubmission, and late-result protection. Non-retryable failures assert zero retries. |
| Reconciliation | Existing sweep tests seed abandoned MEDIA_PROCESSING and TRANSCRIBING artifacts and prove FAILED, counters/audits, and no provider resubmission. This proves recovery from those stored states, not production entry into MEDIA_PROCESSING. |
| AI drafting | Existing flag-off, success, provider error, timeout, malformed JSON/schema, and post-provider entitlement-revocation cases retain a reviewable transcript where appropriate. No vendor or action-capable AI path was introduced. |
| Human review | Five normal lifecycle labels are covered, plus “Recording unavailable” as an availability/deletion override. Independent undecided/accepted/rejected item tests and full/partial/discard API tests pass. New component-handler behavior coverage executes the actual component with controlled hook/query/API adapters, proves item decisions make zero writes, and proves explicit Save/Discard call their corresponding write routes. This is a component unit test, not browser E2E. |
| Timeline | Route tests prove source type/source ID/activity provenance, approved-only content, sequential/concurrent duplicate-save safety, atomic rollback/retry, and no pre-save/discard write. The expanded independence test preserves and reads the snapshot after actual recording destruction, transcript and draft/review redaction, transcription deletion, recording metadata deletion, and session deletion. |
| F4 boundary | Part G remains unchanged. Its tests remain part of the mandatory full API test command; no separate boundary-only re-run was requested or performed in this phase. |
| Tenant isolation | Recording/transcription/review/list/Timeline read/write denials and unchanged foreign state are exercised. The new initiation regression exposes the existence oracle above and fails; this requirement is not marked fully satisfied. |

### Failure-reason nuance

Storage tests accept all documented reason strings on FAILED rows, but runtime proof comes from the separate service/reconciliation tests, not those inserts. A strict audit outage during an ambiguous provider-failure transition intentionally leaves the claim TRANSCRIBING and does not resubmit; reconciliation is the recovery boundary. That fail-closed case is not claimed to have reached a terminal state immediately.

## Full-suite instability

The earlier privacy teardown FK/listener leak is already fixed in the current code: shared brokerage cleanup runs in a `try` and server closure in `finally`. That historical defect is not asserted to be the cause of the later Part D setup-hook timeouts.

The original Part D timeout logs are unavailable in this environment, so their exact cause cannot be conclusively reconstructed. For this final run the mitigation is explicit serial file execution (`--test-concurrency=1`), Node 24, a fresh migrated database, a sanitized test environment, and the original 120000 ms timeout. No timeout increase, test filtering, force-exit flag, or setup-hook bypass is used.

The final invocation completed from 07:22:36 to 07:43:30 UTC (about 20m54s): **1190 passed, 1 failed, 1 skipped, 0 cancelled**, with no setup-hook timeout or hook failure. Its only failure is the new F3 tenant regression. This demonstrates a complete run with the mitigation; it does not establish the historical timeout's root cause.

An earlier attempt was interrupted by a workspace restart before producing final totals and is not counted as a completed gate. Final-run logs are preserved under `.local/f3-final-gates-run/` rather than ephemeral `/tmp`.

## Gate results

Counts for command gates refer to checks/commands, not invented unit-test totals. Suite selections overlap and must not be summed.

| Gate | Passed | Failed | Skipped | Detail |
|---|---:|---:|---:|---|
| Workspace typecheck | 12 | 0 | 0 | All workspace typecheck scripts; latest web and DB tests also rechecked. |
| Clean migration and replay | 2 | 0 | 0 | 25 migration journal entries; clean application and idempotent replay. |
| Schema drift | 1 | 0 | 0 | Generate against an isolated copy of migration snapshots; no changes, byte-identical tree. |
| Schema contract tests | 4 | 0 | 0 | New PostgreSQL-backed contract suite. |
| Full API suite | 1190 | 1 | 1 | One complete invocation across all 134 files selected by the package script; 1192 tests, 82 suites, zero cancellations. |
| Additional API coaching tests | 90 | 0 | 0 | All four existing API test files omitted by the package script, run separately on another disposable database. |
| API build | 1 | 0 | 0 | Production esbuild bundle. |
| Web build | 1 | 0 | 0 | Production Vite bundle; size warning only. |
| Synthetic production startup | 1 | 0 | 0 | Existing CI script; encrypted S3-compatible lifecycle and readiness both pass. |
| Security / tenant selection | 123 | 1 | 0 | Only failure is the new F3 initiation disclosure regression. |
| Full web tests (additional evidence) | 57 | 1 | 0 | Only failure is the excluded zero-byte voiceRecording defect. |

The API skip is the existing test “entitlement restriction: no currently registered action requires a paid entitlement.” Its declared reason is that none of the three demonstration actions sets `requiredEntitlementKey`; entitlement routing has separate direct tests. It was not introduced or skipped by this audit. The additional coaching files are `metrics`, `period`, `responseBuilder`, and `timezone` under `apps/api/src/lib/ai/coaching/__tests__/`. The package script was not changed.

### Reproduction and environment controls

- Runtime: Node 24.13.0, pnpm 8.15.5, PostgreSQL 16.10.
- Full API command: the exact `apps/api/package.json` test selection, with `--test-concurrency=1 --test-reporter=tap` added; all configured globs are retained.
- Security selection: env/session/auth, middleware, webhook freshness, auth routes, AML tenant scoping, privacy, Grow calls, and F3 review/Timeline routes.
- All database-backed commands use separately created disposable local databases. The configured development database and staging were not queried or migrated.
- Synthetic startup uses the repository CI harness, local HTTPS mocks, dummy credentials and legal documents, and false live-approval settings. Unit tests exercise flag permutations only within synthetic test processes.
- An initial startup attempt selected the wrong pnpm major after environment sanitization. The original lock/workspace files were restored exactly, dependencies restored with the frozen lockfile, and the temporary runner explicitly pinned to pnpm 8.15.5 before the final gates. No package/configuration diff remains.
- The normal Node 20/argon2 preview defect was neither exercised nor repaired. Normal preview workflows remain untouched.

## Scope of changes

Changes are new/strengthened tests, this verification report, and agent notes about isolated gate tooling. Production implementation, migrations, package manifests/lockfile, workflows, live flags, and staging remain unchanged. The failing security regression is preserved, not skipped or weakened.
