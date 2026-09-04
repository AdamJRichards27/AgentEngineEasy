# Observability Standard

Agent Engine 2.0, Step 2. This document is split deliberately into two kinds of content,
labeled throughout: **implemented and verified this step** (real code, real tests, cited by
file), and **specified but not yet implemented** (a concrete target this codebase should be
built against, honestly marked as not done). This step's instruction prescribed a specific
structured-logging field list, five named flows to prove tracing through, and SLIs/SLOs
across eleven areas; the exact verbatim enumerations from that instruction were not
recoverable from this session's available context (lost across an earlier context
compaction in this same task). Rather than fabricate a verbatim recollection, the
specification sections below are this step's own reasoned equivalent, built from this
codebase's actual subsystems — flagged clearly so a human reviewer can diff it against the
original spec if the original text is available elsewhere.

## 1. Implemented and verified this step

**Per-request correlation id.** `middlewares/requestId.ts`'s `requestId` — generates one id
per HTTP request (`newCorrelationId()`, a `randomUUID()` wrapper from `@aee/events`),
attaches it to `req.correlationId`, and echoes it as the `X-Correlation-Id` response header.
Mounted first in `app.ts` (right after `helmet()`), ahead of every other middleware and
route — including ones that later reject the request (CORS, rate limiting, an oversized
body) — so every response, successful or not, carries an id a client can report back for
support correlation. This closes the "front door" half of tracing: every HTTP request now
has an id. It does **not** yet thread that same id through to the per-domain-event
correlation ids already generated ad hoc across this codebase (`lib/communications/
outbox.ts`, `lib/transactions.ts`, `lib/offers.ts`, and others, each calling their own
`newCorrelationId()` when publishing a domain event) — see §3's flow-by-flow accounting for
exactly where that connection does and doesn't hold today.

**Health check.** `GET /api/health` now performs `await db.execute(sql\`select 1\`)` and
returns `503 {status:"degraded", database:"unreachable"}` on failure, versus the prior
unconditional static `200 {status:"ok"}`. This is a liveness+basic-readiness check in one
(the process is up AND its one hard dependency, Postgres, is reachable); there is no
separate readiness-vs-liveness distinction because this API has no warm-up state or
background dependency beyond the database it already checks.

**Audit log additions.** `user_signed_in`/`user_signed_out` now recorded via the existing
`logAudit` mechanism (`routes/auth.ts`) — see `AUTHENTICATION_AUTHORISATION_AND_TENANT_
ISOLATION.md` §1. This extends the pre-existing audit log (already covering party/document/
payment/Pit Crew mutations and more — see §5's category accounting) rather than
introducing a second logging path.

## 2. Not yet implemented — structured logging

**Current state, disclosed plainly:** there is no structured logger anywhere in this
codebase. `apps/api/src/**` contains 109 raw `console.log`/`console.error`/`console.warn`
call sites outside test files (surveyed via `grep` this session), each an ad hoc
`console.error("some message", err)` call with no consistent shape, no log level beyond
which `console.*` method was called, and no automatic attachment of `req.correlationId`
even where one is available. This is real, unaddressed technical debt, not an oversight
being hidden — see `DATA_CLASSIFICATION_AND_PROTECTION.md` §6 for the redaction-risk
angle specifically.

**Target field list (proposed, not yet enforced anywhere):**

| Field | Purpose | Redaction rule |
|---|---|---|
| `timestamp` | When | — |
| `level` | `debug`/`info`/`warn`/`error` | — |
| `service` | `agent-engine-easy-api` (future-proofs a multi-service split) | — |
| `correlationId` | `req.correlationId` when available, else the domain-event correlation id | — |
| `route` / `method` | e.g. `POST /payments/:id/refund` (the route pattern, not the raw URL with real ids interpolated, to keep log volume/cardinality sane) | — |
| `statusCode` | Response status | — |
| `durationMs` | Request/operation duration | — |
| `userId` | The internal integer id, never the email | Never log `email`, `firstName`, `lastName` |
| `brokerageId` | Tenant context, essential for triage of a tenant-isolation-adjacent incident | — |
| `errorType` / `errorMessage` | For error-level entries — the typed error's name/class (see §4) and its own message | Never include a raw stack trace containing interpolated request-body content; never include the value of any field in the "never log" column below |
| **Never logged, full stop** | — | `SESSION_SECRET`, any session cookie/token value, any provider API key/webhook secret, `paymentMethods.providerPaymentMethodRef`/`providerCustomerRef` in full (an obfuscated tail, e.g. last 4 characters, is acceptable if ever needed — not implemented), any party's email/mobile/residentialAddress, any full financial amount tied to a specific transaction beyond what's needed for the specific error being logged (an aggregate/count is fine; a full ledger row is not) |

**Recommended next step, not undertaken this session:** introduce a single thin logger
module (e.g. `apps/api/src/lib/logger.ts`) implementing the shape above, and migrate the
highest-value call sites first (unhandled route errors, auth events, webhook signature
failures, rate-limit rejections) rather than a wholesale mechanical replacement of all 109
sites in one pass — the instruction governing this step explicitly cautions against
redesigning existing engines beyond what's needed to close a verified gap, and a rushed,
unreviewed mass rewrite of every log call site risks introducing exactly the kind of
inconsistent, unverified change that guidance warns against. This is recorded as deferred
work in the completion report, not claimed as done.

## 3. Not yet implemented — distributed tracing, proven through named flows

The instruction called for tracing proven through five named flows. Absent the verbatim
original list, these five are chosen because they are this codebase's actual highest-value,
multi-hop, cross-module request/event chains — each already has a natural correlation id at
its start, and each is where a real incident would most need end-to-end traceability:

1. **Sign-in → session issuance → first authenticated request.** `req.correlationId` exists
   from the first hop; not yet attached to the `logAudit` row `POST /auth/dev-login` writes.
2. **Property → AML initiation → exception scan → Pit Crew work item.** `lib/aml.ts`'s
   `initiateAmlIfNeeded` → domain event → `lib/exceptions/engine.ts`'s scan → (if flagged)
   a `pitCrewAssignments` overlay row. Domain events already carry their own
   `correlationId`/`causationId` chain (verified working — see
   `lib/automation/__tests__/stage2Engine.test.ts`'s "audit continuity" test, which asserts
   exactly this chain holds) but that chain is not yet the *same* id as the originating
   HTTP request's `req.correlationId`.
3. **Document package → send-for-signature → e-sign webhook → audit log.** Two different
   id spaces meet here today: the HTTP request that calls `POST /packages/:id/send-for-
   signature` gets an `X-Correlation-Id`; the resulting webhook callback is a *separate*
   HTTP request with its *own* new `X-Correlation-Id` — nothing today links the two beyond
   the shared `packageId`/`providerReference` values visible in the audit row itself.
4. **Payment charge → provider webhook → reconciliation.** Same shape as #3 — the charge
   request and its eventual webhook confirmation are correlation-id-disjoint today, linked
   only by `providerChargeRef`.
5. **Import job upload → parse → row-level processing → completion.** `lib/import/pipeline.
   ts` processes a job across many rows/steps; each step does not currently propagate a
   single tracing id distinct from the job's own database id.

**Honest assessment:** correlation exists *within* a single HTTP request-response cycle
(new this step) and separately *within* a single domain-event causation chain (pre-
existing, already tested). What's missing — and is the actual definition of "distributed
tracing" for this architecture — is stitching those two id spaces together so a support
engineer given one `X-Correlation-Id` from a browser error can find every downstream
webhook, event, and audit row that resulted from it. This is a real, non-trivial gap,
disclosed as deferred work, not attempted this session given the size of the remaining
scope and the risk of a rushed change to how correlation ids are threaded through code
this step did not otherwise need to touch.

## 4. Not yet implemented — typed error handling

No typed error-handling audit was completed this step beyond what surfaced incidentally
during the tenant-isolation fixes (e.g. the new `PitCrewAssigneeMismatchError`,
matching the existing `PitCrewPropertyMismatchError`/`PitCrewTransitionError`/
`PitCrewConcurrencyError` convention already in `lib/pitCrew/assignment.ts`). This
codebase already has a consistent-looking pattern of small, named `Error` subclasses per
domain (`IntegrationError`, `CommunicationTenancyError`, the Pit Crew errors above,
`PitCrewPropertyMismatchError`, etc.) — a systematic audit of whether every route's
catch-all (`if (!handlePlainError(err, res)) throw err;`-style patterns visible in
`routes/financial.ts`, `routes/documents.ts`, and others) correctly distinguishes typed
domain errors (safe to surface a message for) from unexpected errors (should be a generic
500, never leaking internals) was not performed. Recorded as open scope.

## 5. Audit log — current category coverage (informational, not a gap list)

The pre-existing `logAudit` mechanism already covers, by direct inspection this step: user
sign-in/sign-out (new this step), party creation/link-removal, agency-agreement-terms
updates, document-package send-for-signature, payment-method add/remove, service-order
charge, payment refund, Pit Crew status transitions (claim/assign/start/wait/return/
complete/release/handoff), and more, each recording actor, action, record type/id, and
relevant before/after values — never credential or full-financial-detail values (spot-
checked this step; see `DATA_CLASSIFICATION_AND_PROTECTION.md` §6). A full audit against
every category the instruction's original 16-category list may have named was not possible
without that verbatim list (see this document's opening note); what's recorded above is a
direct, evidence-based inventory of what the log actually captures today, which a human
reviewer can diff against the original 16 categories once available.

## 6. Bounded metrics — not implemented

No metrics collection (counters/histograms/gauges) exists in this codebase and none was
added this step. See `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` for the target SLI/SLO
areas and alert-ready conditions this should eventually be built against.
