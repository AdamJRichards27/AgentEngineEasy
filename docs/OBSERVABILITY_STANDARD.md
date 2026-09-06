# Observability Standard

Agent Engine 2.0, Step 2. This document previously described structured logging,
correlation propagation, and metrics as entirely unimplemented specifications. That is no
longer accurate: all three now exist as real code with real tests, described below with
file citations. What remains genuinely unimplemented is narrower than before and is called
out explicitly in §4–§6, rather than implied to still be the whole picture. As with the rest
of this step's documentation, the original governing instruction's verbatim field lists and
flow enumerations were not recoverable across an earlier context compaction; this revision
keeps the same reasoned-equivalent field list and expands the flow count from five to six
(all six now implemented and proven, not just specified), flagged for a human reviewer to
diff against the original spec if it becomes available.

## 1. Structured logging — implemented

`packages/events/src/logger.ts` exports `logger.debug/info/warn/error(message, fields?)`.
Every call writes exactly one JSON object per line to `stdout` (debug/info) or `stderr`
(warn/error) — no dependency added (no pino/winston), since the surface area needed
(single-line JSON, level filtering via `LOG_LEVEL`, no transports/formatters to configure)
is small enough to implement directly without touching `package.json`/`pnpm-lock.yaml`
again. Real field shape, built by the exported (and directly tested) `buildLogEntry`:

| Field | Present when | Source |
|---|---|---|
| `timestamp` | Always | `new Date().toISOString()` |
| `level` | Always | `debug`/`info`/`warn`/`error` |
| `message` | Always | The call site's own event name (a stable string like `readiness_check_failed`, `publish_domain_event_failed` — not free-form prose) |
| `correlationId` | Only when an ambient one is active | `getActiveCorrelationId()` (`context.ts`) — omitted entirely (not `null`) when absent, so a log consumer can distinguish "no context was active" from "context was active with an empty id" |
| `causationId` | Only when an ambient one is active | `getActiveCausationId()` (`context.ts`) |
| *(caller-supplied fields)* | Whatever the call site passes | Passed through `redactForLog` (§2) before being spread into the entry — a caller cannot bypass redaction by naming a field something the redaction list didn't anticipate |

`LOG_LEVEL` (env var, default `info`) filters by rank (`debug` < `info` < `warn` < `error`)
before an entry is even built. Proven by `packages/events/src/__tests__/logger.test.ts`
(8 tests): entry shape, valid single-line JSON with no embedded newlines, correct
correlationId/causationId omission-vs-presence, redaction of nested fields, and that the
caller's input object is never mutated.

## 2. Central redaction — implemented, the never-log list

`packages/events/src/redaction.ts`'s `redactForLog` is called on every `fields` argument
`logger.*` receives — no call site can opt out or hand-roll its own filtering. Two layers,
both proven by `packages/events/src/__tests__/redaction.test.ts` (17 tests):

1. **`NEVER_LOG_KEY_PATTERNS`** — field *names* (case-insensitive) that are always fully
   redacted to `"[REDACTED]"` regardless of nesting depth or what they contain. This is the
   authoritative never-log list: session/auth secrets (`password`, anything matching
   `secret`/`token`/`apikey`/`privatekey`/`hmac`/`webhooksecret`/`signature`, `cookie`,
   `authorization`), payment/banking fields (`cardnumber`, `cvv`/`cvc`, `accountnumber`,
   `bsb`, `iban`, `routingnumber`), government/identity fields (`ssn`, `taxfilenumber`/`tfn`,
   `medicarenumber`, `passportnumber`, `driverlicen[cs]e`, `dateofbirth`/`dob`), AML/e-sign
   document content (`documentcontent`, `documentbase64`, `signedpdf`), raw request/response
   bodies that might embed any of the above (`rawbody`, `rawresponse`, `requestbody`), and
   full communication content (`body`, `messagebody`, `smsbody`, `emailbody` — the fact a
   message was sent is loggable, what it said is not, matching the PII carve-out already
   documented in `DATA_CLASSIFICATION_AND_PROTECTION.md`).
2. **`VALUE_SHAPE_PATTERNS`** — field *values* redacted regardless of the key they're under,
   catching a secret embedded somewhere the never-log list didn't anticipate (a provider's
   freeform error string that happens to echo an `Authorization` header): a `Bearer <token>`
   shape, a JWT shape (three base64url segments joined by `.`), a PEM private-key header.
   Proven to redact only when the value genuinely matches the full shape, not merely
   mentions the word "Bearer" in prose (the test suite has a dedicated case for each).

Depth-bounded (`MAX_DEPTH = 6`), array-capped (`MAX_ARRAY_ITEMS = 20`, with a
`"…N more items truncated"` marker), and string-truncated (`MAX_STRING_LENGTH = 2000`) —
so a redaction bug can never turn into a multi-megabyte log line or hang on a cyclic object.
Genuinely safe fields (ids, statuses, counts, capability names) pass through unredacted,
also proven by the same test file.

## 3. Correlation propagation — implemented and proven across six named flows

`packages/events/src/context.ts` provides ambient correlation/causation ids via
`node:async_hooks`'s `AsyncLocalStorage`: `runWithCorrelationId(id, fn, causationId?)`
establishes context for the duration of `fn` (including across awaited hops inside it);
`currentCorrelationId()` reads the active id or mints a fresh one if none is active;
`getActiveCorrelationId()`/`getActiveCausationId()` are the read-only accessors `logger.ts`
and `metrics` label calls use internally. Proven by
`packages/events/src/__tests__/context.test.ts` (10 tests): synchronous establishment,
propagation across multiple awaited hops, no leakage between concurrent `Promise.all`
branches, correct nested re-entry and restoration, and no leakage after the wrapping call
returns.

`middlewares/requestId.ts`'s `requestId` mints one id per HTTP request, echoes it as the
`X-Correlation-Id` response header, and wraps the entire rest of the request
(`runWithCorrelationId`) — mounted first in `app.ts`, right after `helmet()`, ahead of every
middleware that can reject a request, so every response (successful or not) carries an id.

**The actual hard problem — and where this step found two real bugs — is not the
synchronous request path above; it's anything dispatched later, outside any request
context at all** (a background `setInterval` scheduler tick has no ambient correlation
context to inherit). The correct pattern for that case, established by
`lib/integrations/outbox.ts` (which already did this correctly and served as the reference
implementation): store the triggering correlationId on the row *at creation time*, then
re-establish it via `runWithCorrelationId(row.correlationId, ...)` *at dispatch time*, no
matter how much later dispatch happens or what triggered it.

**Bug found and fixed #1 — communications.** `communicationMessages.correlationId` was a
schema column that was never written anywhere; `lib/communications/outbox.ts`'s
`publishCommunicationEvent` always read `message.correlationId ?? currentCorrelationId()`,
which silently fell through to `currentCorrelationId()` every time, meaning any *deferred*
send (past quiet hours, a `RETRY_SCHEDULED` backoff — exactly what `bootstrap.ts`'s
`dispatchDueMessages()` scheduler sweep processes on a bare `setInterval`, with no ambient
context) started a brand-new, disconnected correlationId chain instead of continuing the
original drafting request's. Fixed in `lib/communications/messages.ts`'s
`createDraftMessage`: the insert now sets `correlationId: currentCorrelationId()` at draft
time. Proven by `routes/__tests__/communicationsCorrelationPropagation.test.ts`: drafts a
message over real HTTP, captures the request's own `X-Correlation-Id`, confirms it was
persisted on the row, manually queues the message, then calls `dispatchMessage()` directly —
deliberately *not* inside any `runWithCorrelationId` wrapper, exactly matching how the
scheduler calls it — and asserts the resulting `COMMUNICATION_MESSAGE_SENT` domain event
still carries the original drafting request's id, not a freshly minted one.

**Bug found and fixed #2 — financial payment scheduling.**
`lib/financial/paymentOutbox.ts`'s `scheduleDebitForPaymentRequest` already accepted a
`correlationId` parameter correctly (the parameter-threading variant of the same pattern),
but the one route that calls it, `routes/financial.ts`'s `schedule-debit` handler, never
passed one in — so the stored value was always `undefined`, falling back the same way as
bug #1. Fixed by passing `correlationId: currentCorrelationId()` from the route. Proven by
a new `describe` block in `lib/financial/__tests__/paymentWebhooks.test.ts`: builds a real
payment-request fixture, POSTs to the mandate-payments webhook, captures the response's
`x-correlation-id`, and asserts the resulting `FINANCIAL_PAYMENT_PAID` domain event's
correlationId matches it.

**The six named flows, all proven, not merely specified:**

1. **Mock Property Launch publication.** HTTP `POST .../actions/publish-listing` → the
   `integration_outbox` row it enqueues → the outbox dispatch attempt → Launch's own
   `recordPortalSubmission` write → `PORTAL_SUBMISSION_RECORDED`. This flow was already
   correct by construction (single call path, already wrapped end-to-end by `requestId`).
   Proven by `lib/integrations/__tests__/launchPublicationCorrelationPropagation.test.ts`,
   asserting both the outbox row and the resulting domain event carry the triggering
   request's id.
2. **Mock Communications delivery.** The bug-#1 fix above, proven specifically for the
   no-ambient-context scheduler-dispatch case, not just the easier inline case.
3. **Mock Financial status processing.** The bug-#2 fix above, proven via the real webhook
   route.
4. **Retry-to-dead-letter.** An `INTEGRATION_COMMAND_DEAD_LETTERED` domain event, asserted
   (in `lib/exceptions/__tests__/integrationOperational.test.ts`, "Proof D") to carry the
   same correlationId as the command that was dead-lettered.
5. **Authorised replay.** The same test file's assertion that `replayDeadLetteredCommand`'s
   result carries the original command's correlationId, not a fresh one.
6. **Workflow-to-Risk escalation.** A deliberate, documented exception to "one shared
   correlationId end-to-end" — see the note below.

**Design note, not a bug: the risk-exception scan intentionally uses its own correlationId.**
`lib/exceptions/engine.ts`'s `scanBrokerageForExceptions` wraps itself in its own fresh
`runWithCorrelationId`, independent of whatever incident it discovers. This is correct: a
single scheduled scan pass can discover many unrelated dead-lettered commands or stuck
records in one run, so it cannot meaningfully adopt any *one* of their correlationIds as its
own. The scan's resulting risk-exception rows link back to the originating incident by
*reference* (`metadata.integrationOutboxId` and similar fields, already asserted in Proof D)
rather than by a shared correlationId. Flow #6 above is therefore proven at the level that
is actually true of this architecture — reference-linked, not correlationId-shared — rather
than forcing an incorrect universal-correlationId claim to make the flow list uniform.

## 4. Bounded metrics — implemented

See `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` for the full registry, the eleven SLI areas,
and the twenty-one alert-ready conditions. In short: `packages/events/src/metrics.ts`
declares nine counters/histograms, each with its full allowed label-value set enforced at
call time (out-of-set throws in test/dev, coerces to `"other"` with a one-time warning log
in production), exposed as Prometheus text at `GET /api/internal/metrics` behind a bearer
token that fails closed at boot in production. Proven by
`packages/events/src/__tests__/metrics.test.ts` (16 tests).

## 5. Operational alerts — bounded webhook boundary, not evidenced paging

`apps/api/src/lib/operationalAlerts.ts` provides an `operationalAlerts` webhook boundary
for defined signals including `BACKUP_FAILURE`, readiness failure, authentication anomaly,
integration webhook failure, reconciliation variance, and tenant-security signal. Its
policies identify logical ownership labels and runbook names; those labels are not named
people or external contacts.

In production, boot fails closed unless `OPERATIONAL_ALERTS_ENABLED=true`,
`OPERATIONAL_ALERTS_PROVIDER=webhook`, a valid **HTTPS**
`OPERATIONAL_ALERTS_WEBHOOK_URL`, and an `OPERATIONAL_ALERTS_TOKEN` of at least 16
characters are configured. Receiver and token administration is owner-controlled
deployment configuration. The accountable external receiver/token owner is currently
**unassigned** and must be recorded by the operating organisation without adding secrets
to this repository.

The boundary POSTs an authenticated JSON envelope and makes no more than three bounded
in-process attempts (with a five-second request timeout). Cooldown/deduplication is an
in-memory, process-local map; a restart loses it. There is no durable alert outbox, and a
failed delivery is only returned/logged for a caller to handle at its own safe boundary.
Consequently, it is incorrect to claim durable paging, external delivery, or human
acknowledgement: external delivery and acknowledgement have **not yet been evidenced**.
Manual metric, admin-view, and log review remains required.

Backup scripts are independently provider-neutral and use their configured
`BACKUP_ALERT_COMMAND`; they do not create a scheduler. See
`BACKUP_AND_RESTORE_RUNBOOK.md` for the external daily scheduler contract, retention and
integrity verification, and disposable-only restore preflight.

## 6. Health check — liveness/readiness/degraded split, implemented

`routes/health.ts` replaces the prior single combined check with three:

- `GET /api/health/live` — liveness. Never touches the database; true as soon as the
  process can execute a handler at all. An orchestrator's liveness probe should restart the
  process on failure here — and only here, since a database blip is not a reason to
  kill-and-restart an otherwise-healthy process.
- `GET /api/health/ready` — readiness, three states: `ok` (query succeeded within 500 ms),
  `degraded` (succeeded but slower — still 200, still routes traffic, but is a real signal:
  see alert #2 in the metrics document), `unavailable` (query threw — 503, genuinely not
  ready). `checkReadiness()` is exported and directly tested, independent of the HTTP layer.
- `GET /api/health` — kept byte-for-byte identical to its pre-Step-2 response shape for
  backward compatibility, folding `degraded` into `ok` (only `unavailable` still 503s).

Every readiness check observes `health_check_duration_ms{status}` and, on failure, logs via
`logger.error`/`logger.warn` rather than `console.error` — closing the specific gap the
prior revision of this document flagged in incident runbook #9. Proven by
`routes/__tests__/health.test.ts` (11 tests), including the two states (degraded, hard
failure) that are impractical to trigger against a real local Postgres connection —
exercised by temporarily substituting `db.execute` for the duration of one assertion and
restoring the true original immediately after.

## 7. What is still genuinely not done — disclosed, not implied away

- **The `console.*` sweep is partial, not complete.** At the start of this step's
  observability work, 109 raw `console.log`/`console.error`/`console.warn` call sites
  existed outside test files. This step converted the correlation-propagation-adjacent call
  sites in `lib/communications/*` (the module where the propagation bugs were found) plus
  everywhere already wired for metrics/health/requestId, and 40 files across `apps/api/src`
  now import `@aee/events`'s `logger`. **92 raw `console.*` call sites remain**, across 41
  files (several of those files use both — a partial per-file migration, e.g. `lib/aml.ts`,
  `lib/documents.ts`, `lib/offers.ts`, `lib/transactions.ts`). A full mechanical sweep of the
  remainder was judged lower-value than finding and fixing the two real correlation bugs
  above, and riskier to do unreviewed in one pass — recorded as open follow-up work, not
  claimed as done. `grep -rn "console\.\(log\|error\|warn\)" apps/api/src --include="*.ts"`
  (excluding `__tests__`) reproduces the count.
- **No dedicated tenant-isolation-rejection metric.** SLI #10 and alert #8 in the metrics
  document are still log-based, not counter-based — see that document's §4 for the specific
  gap.
- **`communicationsWebhooks.ts` and `financialWebhooks.ts` don't emit
  `integration_webhook_total`.** Only the integrations webhook router does today — see the
  metrics document's §4.
- **Typed error handling audit.** Unchanged from the prior revision of this document: no
  systematic audit was performed beyond what surfaced incidentally during the tenant-
  isolation work (documented in `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`).
  Recorded as open scope, not attempted this step.
- **Audit log category coverage.** Unchanged from the prior revision — see that section's
  original content, carried forward: the pre-existing `logAudit` mechanism's coverage was
  inventoried by direct inspection, not against a verbatim original category list (not
  recoverable across the compaction), and is not itself part of the structured-logging work
  above (it's a separate, older mechanism, still in active use, not superseded by
  `logger.ts`).
- **External alert evidence.** The webhook boundary is implemented, but no evidence records
  a production receiver's external delivery or a responder's acknowledgement. Its external
  receiver/token ownership is unassigned, its deduplication is process-local, and it has no
  durable outbox.
