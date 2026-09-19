# AE GROW Priority 6 — Stage F3 final verification

Branch: `feat/ae-grow-priority-6-stage-f3-transcription-review` (PR #43). Updated 2026-09-19 after the independent-review remediation (findings A–D below).

## Status

**Pending independent re-review.** This report does not claim merge readiness. No push, merge, staging operation, live-flag change, or production deployment is described or implied by this document.

## Scope of changes on this branch

Stage F3 is not a test-only change. The branch adds:

- Production API code: call transcription initiation (`apps/api/src/lib/telephony/callTranscriptions.ts`), shared policy vocabulary (`callTranscriptionPolicy.ts`), AI drafting (`callTranscriptionDrafts.ts`), human review persistence (`callTranscriptionReview.ts`), the approved `call_summary` Timeline write-through (`callTranscriptionTimeline.ts`), stale-processing reconciliation (`callTranscriptionReconciliation.ts`, `callTranscriptionReconciler.ts`), and the transcription routes in `apps/api/src/routes/growCalls.ts`.
- Database schema and migrations: `packages/db/src/schema/callTranscriptions.ts` with migrations `0023_natural_lorna_dane.sql` and `0024_flaky_masked_marvel.sql` (plus their Drizzle snapshots/journal entries).
- Web review panel and helpers, tests, and this report.

The remediation described below changed production API code and tests only. It added **no** migration, schema change, dependency, package manifest/lockfile change, workflow change, or live-flag change. The durable `failure_reason` column is unconstrained `text`; the failure vocabulary is a TypeScript allowlist, so the one new reason (`CONSENT_WITHDRAWN`) needs no migration.

## Tenant isolation of initiation (earlier finding, resolved)

An earlier draft of this report recorded that a cross-brokerage initiation for an existing foreign `(call_session_id, recording_reference)` tuple returned HTTP 409 `TENANT_MISMATCH`, which disclosed existence. That is no longer the behaviour: cross-brokerage initiation is uniformly HTTP 404 `CALL_NOT_FOUND` ("Call session not found in this brokerage.") for existing and absent tuples and for absent calls, with identical bodies and headers. Covered by `apps/api/src/routes/__tests__/callTranscriptionReview.test.ts` ("cross-brokerage transcription initiation is uniformly not found for existing and absent recording tuples") and the service test "rejects an existing foreign artifact as CALL_NOT_FOUND without mutating it".

## Remediation (independent review findings A–D)

### A — Same-brokerage ownership before any existing transcription is read or transitioned

Defect: `initiateCallTranscription` loaded the existing row for the call/recording tuple before checking call ownership. A same-brokerage, non-privileged agent holding `grow.calling.transcription` could receive a terminal row (transcript and drafts) as-is, and for PENDING/TRANSCRIBING rows the caller's own `ACCESS_DENIED` went through `failOwned`, marking the owner's row FAILED.

Fix (`apps/api/src/lib/telephony/callTranscriptions.ts`):

- After the actor/tenant/entitlement checks and **before** the existing-row lookup, the service resolves the call with `getCallSessionForBrokerage(…, actor)`. This uses the same rule as every other call read (initiator or brokerage-admin role). Not found maps to `CALL_NOT_FOUND` (404) and unauthorised maps to `ACCESS_DENIED` (403). Both are strict-audited rejections against the call session, never state transitions of the row.
- `isActorSpecificDenial` (`ACCESS_DENIED`, `ENTITLEMENT_REQUIRED`, `TENANT_MISMATCH`, `INVALID_INPUT`) now makes the pre-claim PENDING/TRANSCRIBING paths rethrow instead of calling `failOwned`. Source-validity failures (recording deleted/unavailable, reference mismatch, F2 evidence missing/invalid, consent withdrawn) can still fail an owned row when an authorised caller discovers them, as before.
- A recording-loader `RECORDING_ACCESS_DENIED` (caller-specific owner/recording-entitlement denial) is now surfaced as `ACCESS_DENIED` rather than being disguised as `RECORDING_UNAVAILABLE`, so it cannot become a durable source failure.
- The route (`POST /grow/calls/:id/transcription`) maps `ACCESS_DENIED` to 403 and `CALL_NOT_FOUND` to 404, matching `transcriptionReviewErrorStatus` for the other transcription routes. The body is `{ error, code }` only, with no row.
- Unchanged: after an authorised caller has claimed the row itself, a mid-flight loss of that caller's own access or entitlement still fails the caller's own claim. This is existing, tested behaviour ("actor access revoked while the provider is in flight…", "rechecks entitlement before every retry…").

Tests:

- `apps/api/src/lib/telephony/__tests__/callTranscriptions.test.ts`: "same-brokerage non-owner is denied for completed, approved, pending, and transcribing owner rows without data or mutation". It covers owner rows in AWAITING_AGENT_REVIEW, APPROVED, PENDING, and TRANSCRIBING. For each: `ACCESS_DENIED`; the error carries no transcript or draft text; the owner row is identical, including the raw `updated_at::text` token, `processingState`, `retryCount`, transcript, drafts, and `failureReason`; no transition audit is written for the row; zero transcription-provider and zero AI-gateway calls. An owner replay control still receives the unchanged terminal row.
- `apps/api/src/routes/__tests__/callTranscriptionReview.test.ts`: "same-brokerage non-owner POST transcription is denied with no row data and no owner-row mutation in any state". This is the HTTP equivalent: 403, a body containing only `code`/`error`, no transcript or draft content, a byte-identical owner row, no Timeline entry, and zero provider/AI calls.

### B — Withdrawn consent blocks any new transcription or AI processing (deny by default)

Defect: `assertPersistedF2Evidence` verified the consent *as captured* but never the consent's current withdrawal state. `recomputeSessionRecordingPermission` deliberately leaves terminal calls unchanged. That is an F2 fix and was not modified. As a result, a withdrawal after the call ended did not stop later transcription.

Fix (`apps/api/src/lib/telephony/callTranscriptions.ts`):

- `assertRecordingConsentNotWithdrawn` re-reads the current persisted capture consent (`grow_call_recording_consents` by capture consent id, brokerage, and party). A missing row, `status = 'WITHDRAWN'`, or a non-null `withdrawn_at` rejects with `CONSENT_WITHDRAWN`. It runs inside `validateSource`, so it executes:
  - before a new or existing-PENDING initiation;
  - at the start of **every** provider attempt, including each bounded retry;
  - after the provider returns and **before** the transcript is sent to AI drafting;
  - after AI drafting and before commit.
- The commit transaction (`lockActiveRecordingForCommit`) also locks the consent row `FOR UPDATE` and re-checks it. A withdrawal that commits while AI drafting is in flight therefore cannot be overtaken by the transcript/draft commit.
- A withdrawal found during an attempt fails that attempt durably with `failureReason = CONSENT_WITHDRAWN`. It is non-retryable and stores no transcript or drafts. A new initiation with no row is rejected (HTTP 409) and creates no row.
- `CONSENT_WITHDRAWN` was added to `CallTranscriptionFailureReason` / `CALL_TRANSCRIPTION_FAILURE_REASONS` in `callTranscriptionPolicy.ts` and to the error-code union. The policy and schema vocabulary tests were updated.
- Nothing is deleted: the recording, its document version, the consent row, F2 evidence, and any existing transcript remain.
- The stale-processing reconciler never calls a transcription provider or the AI gateway (it only fails abandoned rows), so it needs no consent gate.

Tests (`apps/api/src/lib/telephony/__tests__/callTranscriptions.test.ts`):

- "withdrawn consent after capture denies new initiation without a provider call, row, or deletion; active consent still transcribes". Covers withdrawal after the call completed via `withdrawRecordingConsent`: rejected with `CONSENT_WITHDRAWN` and strict-audited, no row, zero provider calls, recording still Active, consent row retained. An existing owned PENDING row fails with `CONSENT_WITHDRAWN` without a provider call. The non-withdrawn control completes normally.
- "consent withdrawn during transcription stops before AI drafting and stores no transcript": one provider call, zero AI-gateway calls, FAILED/`CONSENT_WITHDRAWN`, retryCount 0.
- "consent withdrawn during AI drafting prevents the transcript and drafts from being committed".
- "consent withdrawn before a retry stops the next provider submission": exactly one provider call, retryCount 1, FAILED/`CONSENT_WITHDRAWN`.

### C — Strict in-transaction audit for agent Save and Discard

Fix (`apps/api/src/lib/telephony/callTranscriptionReview.ts`):

- `strictReviewAuditInTransaction` writes through `logAudit(…, { strict: true, write: writeAuditInTransaction(tx, …) })`, the same strict in-transaction pattern F3 uses elsewhere.
  - Save writes `grow_call_transcription_review_saved`. Its audit is written after the Timeline `call_summary` snapshot, in the same transaction.
  - Discard writes `grow_call_transcription_discarded`.
- Recorded fields:
  - Actor `userId`, `brokerageId`, `recordType = grow_call_transcription`, `recordId = transcriptionId`, and `previousValue` (prior processing state).
  - `providerReference = call:<callSessionId>:recording:<recordingReference>`.
  - `updatedValue` as JSON: `transcriptionId`, `callSessionId`, `partyId`, and the new `processingState`. Save also records `decisionCounts`: approved, rejected, and total, plus per-item-type approved/rejected counts.
  - The timestamp is the audit row's `createdAt`.
  - IDs, states, and counts only: no transcript, edited text, rejection reason, or contact PII.
- Save now sets `updatedAt` (to the review timestamp); Discard sets `updatedAt`.
- An audit failure throws `CallTranscriptionReviewError("AUDIT_FAILURE")` inside the transaction (HTTP 409 via the existing review error mapping). The state change, the Timeline activity (Save), and the audit all roll back together.

Tests (`apps/api/src/lib/telephony/__tests__/callTranscriptionReview.test.ts`):

- "save and discard each write exactly one strict audit row with ids, states, and decision counts only".
- "a strict review audit outage rolls back save (including its Timeline snapshot) and discard". It uses the existing test-only strict-audit outage seam (`setCallTranscriptionAuditFailureForTests`) and proves the transcription row, Timeline activities, and audits are unchanged and that an error surfaces. A recovery control proves Save then commits state, Timeline, and audit together.
- The existing Save/Discard column test was retitled to reflect `updatedAt`.

### D — This report

Rewritten to remove the stale "Not ready for commit/push" decision, the stale `TENANT_MISMATCH` 409 description, and the incorrect claim that production code and migrations were unchanged. Adds this remediation section and the product decisions below.

## Product decisions recorded

- **Withdrawn consent** blocks any *new* transcription or AI processing attempt (deny by default). It does **not** imply deletion of recordings, transcripts, drafts, reviews, Timeline entries, or evidence. Retention and deletion after withdrawal is a separate, still-open product/legal decision.
- **Timeline visibility**: saved `call_summary` Timeline entries (approved content snapshot only) follow the existing brokerage/contact Timeline permissions. Transcript, draft, and review data remain restricted to the call owner and brokerage administrators (the call-session ownership rule). No transcript access was broadened.

## Known open items (unchanged, explicitly out of scope of this remediation)

- `MEDIA_PROCESSING`, `DELETION_SCHEDULED`, and `DELETED` are accepted by the schema and handled by consumers/reconciliation, but no production operation enters them. Reachability needs either an implemented lifecycle or an approved narrower requirement for reserved states.
- The remediation deliberately did not change these deferred items: webhook payload passthrough, permanent-failure HTTP status mapping, inline retries/backoff timer, deletion states, UTC timestamp debt, multer, and the zero-byte voice recording defect.

## Test-coverage map

| Requirement | Covering suites |
|---|---|
| Table shape, defaults, JSONB, CHECKs, unique tuple, failure vocabulary | `packages/db/src/schema/callTranscriptions.test.ts`; `apps/api/src/lib/telephony/__tests__/callTranscriptionPolicy.test.ts` |
| F2 evidence, entitlement, source revalidation, retries, idempotency, provider gating | `apps/api/src/lib/telephony/__tests__/callTranscriptions.test.ts` |
| Same-brokerage ownership on initiation (A) | `callTranscriptions.test.ts`; `apps/api/src/routes/__tests__/callTranscriptionReview.test.ts` |
| Consent withdrawal before transcription, retries, AI drafting, and commit (B) | `callTranscriptions.test.ts` |
| AI drafting (flag, schema, failures, prompt-injection framing) | `callTranscriptionDrafts.test.ts`, `callTranscriptions.test.ts` |
| Reconciliation of abandoned processing (no resubmission) | `callTranscriptionReconciler.test.ts` |
| Human review validation, owner scoping, Save/Discard audit and rollback (C) | `apps/api/src/lib/telephony/__tests__/callTranscriptionReview.test.ts`; `apps/api/src/routes/__tests__/callTranscriptionReview.test.ts` |
| Timeline snapshot provenance, duplicate safety, rollback, independence | `apps/api/src/routes/__tests__/callTranscriptionReview.test.ts` |
| Tenant isolation across calls/recording/transcription routes | `apps/api/src/routes/__tests__/growCalls.test.ts`, `callTranscriptionReview.test.ts` |
| F4 boundary (no commitments/actions/communications/tasks) | `apps/api/src/routes/__tests__/callTranscriptionBoundary.test.ts`, `apps/api/src/lib/telephony/__tests__/callTranscriptionBoundaryImports.test.ts` |
| F2 consent/recording regressions | `consentRegression.test.ts`, `recordingGates.test.ts`, `recordingStorage.test.ts` |

## Verification results

Final test and typecheck results for this revision are recorded in the PR #43 / CI run rather than in this document. No counts are asserted here. Run database-backed suites serially (`--test-concurrency=1`) against a freshly created and migrated disposable PostgreSQL database in UTC. Several suites use fixed IDs and cross-tenant reconciler fixtures that clash on a reused database or under parallel file execution.

### Reproduction and environment controls

- Runtime: Node 24, pnpm 8.15.5, PostgreSQL 16.
- All database-backed commands use disposable local databases. The configured development database and staging are not queried or migrated.
- Unit tests exercise live-approval flag permutations only within synthetic test processes. Transcription providers and the AI gateway are replaced through test-only seams that throw outside `NODE_ENV=test`.
