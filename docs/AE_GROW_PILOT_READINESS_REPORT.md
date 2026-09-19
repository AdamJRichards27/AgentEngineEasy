# AE GROW — Pilot Readiness & Technical Hardening

Canonical record for the readiness phase that follows AE GROW Priority 6 (Stages B–F, complete). This phase adds no product features: it asks whether the completed Grow product is *technically* ready to put in front of controlled-pilot users, excluding everything that needs legal, commercial, provider or production authorisation.

## Status

**Technical readiness work complete; pending independent review, GitHub CI on the final head, and the Project Owner's merge decision.** Nothing here authorises a pilot, a deployment, or any live provider.

- Base: `staging` at `82906353cf...` (F4 merged; post-merge CI #358 green).
- Branch: `feat/ae-grow-pilot-readiness-hardening`; draft PR #45.

## 1. How the work was scoped

Four read-only reviews ran in parallel over the current staging tree — documented pilot requirements, cross-stage security/entitlement/audit, runtime/startup/observability, and test-isolation/UTC — followed by a live headless-browser smoke run of the whole Grow journey against a local non-production stack (mock AI, sandbox telephony, no outbound messaging). Every documented item was re-verified against current code before being actioned; historical TODOs that no longer exist were not "fixed".

Findings were classified P0 (security, tenant isolation, data integrity or pilot blocker), P1 (core workflow broken or materially unreliable), P2 (meaningful usability/reliability defect), P3 (polish or non-blocking debt). P0 and P1 are resolved; P2 items were resolved where low-risk; P3 items are listed in §6.

## 2. P0 — resolved

| Finding | Evidence | Resolution |
|---|---|---|
| Any async route error terminated the API process. Express 4 does not forward a rejected handler promise, and Node 24 exits on an unhandled rejection, so **one malformed id from any signed-in user took the whole API down** (reproduced live, and independently in a child process). | Smoke defect D1 | Handler rejections now reach the global error handler; process-level handlers log and alert (unhandled rejection: continue; uncaught exception: alert then exit for a clean restart). |
| A dropped idle database connection crashed the process — the pg pool had no `error` listener. | Runtime review | `error` listener on both the application and migrator pools; logs never include the connection string. |
| Timestamp columns are `timestamp without time zone` and are read as UTC, while `defaultNow()` writes the **database session's** zone. On a non-UTC database, entitlements, cutoffs and date windows shift silently (locally this produced ~200 spurious test failures). | Test/UTC review | Every connection sets `TimeZone=UTC` (opt-out `DB_SET_SESSION_TIMEZONE=false` for poolers that reject it); production refuses to start unless the session resolves to UTC; other environments warn. No schema change. |

## 3. P1 — resolved

- **Grow Appraisals had no Grow entitlement check.** Every route had only `requireAuth`, so a Starter/Run-only brokerage could create appraisals, run AI generation and send them to contacts (confirmed live: brokerage without Grow created appraisal #20). Now `grow.access` on every route, `grow.opportunities.manage` on all 15 mutations, `run.access` retained on the Run handoff.
- **Cross-tenant appraisal owner.** `ownerUserId` was written unvalidated and joined without a tenant filter, leaking another brokerage's agent name into the pipeline and generated presentations. Now validated and tenant-scoped in both lookups.
- **The per-tier daily AI cap was never enforced** (`maxAiRequestsPerDay` was referenced nowhere). Now enforced from durable interaction rows since 00:00 UTC, before any provider call, returning 429 and auditing the refusal.
- **A valid session was bounced to the login screen** once the strict per-IP auth limit was reached, because the SPA's session probe consumed the credential budget. The probe now has its own generous limiter. Proxy trust is explicit (`TRUST_PROXY`) so a pilot behind a balancer rate-limits per client IP instead of sharing one budget; it fails safe to trusting nothing.
- **The exception scan lock was a check-then-insert race** between the manual ops trigger and the interval timer. Now a session-level advisory lock held for the whole sweep, with crash recovery that no longer depends on wall-clock arithmetic.
- **Sign-in could leave the app on the login screen** until an unrelated refetch (the session cache was written in the wrong shape).

## 4. P2 — resolved

Entitlement and audit: `grow.ai.use` enforced for Grow AI surfaces; Grow thread message mutations require `grow.contacts.manage`; contact role, relationship and commitment mutations audited (ids only); commitment complete/cancel is a conditional update in one transaction with its activity row (409 on a lost race), so concurrent completes cannot double-write the timeline; relationship status/role validated; malformed ids return 400 rather than 500.

Governance and integrations: the Stage D tamper hash is a keyed HMAC, so database write access alone cannot forge it; telephony webhooks return 422 with `retryable: false` for permanently unprocessable events so a provider stops retrying; Ask AE no longer re-proposes a commitment that was already created.

Runtime and support: a database error during session lookup returns 503 instead of silently signing the user out; readiness verifies applied migrations; startup seed failures alert and mark readiness failed; live voice/telephony locks apply in every environment and a real AI provider additionally requires `LIVE_AI_PROVIDER_APPROVED`; swallowed error causes are logged.

Web: error boundaries at the app root and around each major region; global session-expiry handling; support references from `X-Correlation-Id` (also exposed through CORS); error and retry states for the four Grow regions that previously rendered blank on failure; the Performance tab explains when the coach is off; the proposal card heading reflects the created state; contact names replace raw `contact #N`; the stale "coming soon" voice card is gone; and the voice control no longer sticks on "stopping" after an empty or failed recording — a real defect behind a long-standing red test.

Dependencies and operations: `multer` 2.2.0 → 2.4.0 clears all four advisories (`pnpm audit --prod` clean); `db:preflight` verifies migration preconditions before `db:migrate`; `.env.example` and the deployment runbook document every variable the code reads, the flags that must stay off, the UTC database requirement, the real readiness reasons and the single always-on instance requirement.

Test reliability: advisory-locked and tenant-scopeable sweeps, per-run webhook event ids, orphan receipt cleanup, and an optional `PG_POOL_MAX` (a parallel run opened more connections than the server allowed, which surfaced as unexplained 401s).

## 5. Verification

| Check | Result |
|---|---|
| API suite (CI command, fresh database) | 1407 passed, 0 failed, 1 skipped |
| Web suite | 135 passed, 0 failed |
| Workspace typecheck | Clean |
| API and web production builds | Clean |
| Clean-database migration + schema drift | Clean; `db:preflight` passes |
| Synthetic production startup | Passed |
| `pnpm audit --prod` | No known vulnerabilities |
| Live browser smoke journey | See §7 |

## 6. Remaining non-blocking technical debt

- Grow Today does not surface commitments, so an overdue commitment never appears there (product behaviour, not changed here).
- A message author can approve their own marketing message (no separation of duties); consent is still enforced at send.
- Rate limiters, alert cooldowns and the in-process sweeps are per-process, so they assume a single always-on instance (documented in the runbook).
- Roughly 110 further route-parameter sites in non-Grow routers still parse ids without an explicit guard; several already return 400 downstream. Worth one shared helper in a later pass.
- `MEDIA_PROCESSING` and `DELETION_SCHEDULED` transcription states remain unreachable; webhook payload passthrough stores provider fields verbatim; backup scheduling and an external alert receiver are deployment contracts with no owner yet.
- Consent questions A (contact-wide withdrawal) and B (human save after withdrawal) remain open product/legal decisions.

## 7. Live smoke journey

The full journey was exercised in a real browser against a local stack: login and the Grow tabs, Today, Contact 360 (including commitments and the Relationship Timeline), communications with consent gating, appraisals, Ask AE and the Business Coach with Stage D proposals, voice input, the sandbox calling lifecycle, transcription review, governed follow-ups, and cross-user/cross-tenant probes. Tenant isolation held in every check, including 18 cross-tenant id probes. The defects it found are recorded above; the re-run against this branch is recorded on PR #45.

## 8. External blockers to an actual live pilot (not technical)

Legal artifact approval (production startup refuses to boot without approved, non-draft artifacts), the AU/NZ call-recording legal review, telephony provider selection, live transcription approval, an email provider decision, named owners for backups, the alert receiver and storage/KMS, pilot authorisation itself, and the production deployment decision. Migration 0025 additionally requires its documented duplicate check before running anywhere persistent.

Calling has no product path to record call consent, Do Not Call status or consent policy — the schema and decision logic exist, but nothing populates them. Unless the Project Owner decides otherwise, the `grow.calling.*` entitlements should stay ungranted for a pilot; that needs no code change.

## 9. What this report does not claim

It does not claim the product is legally or commercially approved for a pilot, that a pilot is authorised, or that any deployment has been made. Technical readiness is a precondition, not permission.
