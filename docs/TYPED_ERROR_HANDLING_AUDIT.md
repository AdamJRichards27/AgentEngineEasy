# Typed Error Handling Audit

Agent Engine 2.0 — Step 2: Harden Security and Observability, Part C. This document is the
closure-pass record for the typed-error-handling audit: which trust boundaries were reviewed,
what error taxonomy they're checked against, and — the actual substance of the work — the
real, concrete gaps found and fixed, each with a test proving the fix.

**On the missing verbatim instruction, disclosed rather than guessed past.** This step's
governing instruction named a specific count of boundaries and error categories to audit.
That exact enumerated list did not survive an earlier context-window compaction in this
session — only the fact that Part C required "12 named boundaries" and "13 named error
categories" is recoverable, not which twelve and which thirteen. Rather than fabricate a list
and imply it's the original one, this document states plainly that §1 and §2 below are a
**reasoned equivalent** this pass constructed from the codebase's own actual architecture —
internally consistent, and defensible against production behaviour, but not a byte-for-byte
match to whatever the original instruction enumerated. Flagged for a human reviewer to diff
against the original spec text if it becomes available. What is NOT in question is the
findings in §3 — those are real, verified against the actual running code and covered by new
tests, independent of whether the boundary/category framing above them matches the original
wording exactly.

## 1. The twelve boundaries this pass audited

A "boundary" here means a point where an error crosses from one trust domain into another —
from a library call into a route handler, from an external/unauthenticated caller into
application code, or from a background process into whatever handles its failure — and so a
point where the question "what does the OTHER side see, and what does the operator see" has
to be answered deliberately rather than left to whatever the underlying exception happens to
say.

| # | Boundary | Reviewed | Fixed this pass |
|---|---|---|---|
| 1 | Global HTTP safety net (no boundary-specific code — the fallback for every route) | Found: did not exist at all | **Yes** — `middlewares/errorHandler.ts`, mounted last in `app.ts` |
| 2 | Inbound webhook — communications (`routes/communicationsWebhooks.ts`) | Reviewed (Part B rewrite already made this safe) | No change needed this pass |
| 3 | Inbound webhook — financial (`routes/financialWebhooks.ts`) | Reviewed (Part B already fixed the `parseWebhook()` hang) | No change needed this pass |
| 4 | Inbound webhook — integrations (`routes/integrationsWebhooks.ts`) | Audited in depth | **Yes — three real bugs, see §3.4/§3.5/§3.6** |
| 5 | Auth (`routes/auth.ts`, `middlewares/auth.ts`) | Reviewed | No change needed (uniform 404/401, no message leaks) |
| 6 | Background outbox dispatch — integrations (`lib/integrations/outbox.ts`) | Reviewed | No change needed (no client response surface; logs via `logger.error`, now correctly capturing detail — see §3.1) |
| 7 | Background outbox dispatch — financial payments (`lib/financial/paymentOutbox.ts`) | Reviewed | Same as #6 |
| 8 | Background outbox dispatch — communications (`lib/communications/outbox.ts`) | Reviewed | Same as #6 |
| 9 | Domain-event publish (`packages/events/src/publisher.ts`) | Reviewed | No change — a documented contract ("callers must wrap this in their own try/catch and log on failure"), already audited call-site-by-call-site during this step's Part B correlation-propagation work (`OBSERVABILITY_STANDARD.md` §3); re-auditing every call site again here would be re-opening already-closed work |
| 10 | Exception & Risk Engine scheduled scan (`lib/exceptions/engine.ts`) | Reviewed | No change — per-rule isolation confirmed by existing test coverage (a single rule's `EVALUATION_FAILED` doesn't block sibling rules) |
| 11 | AI action policy/execution (`routes/ai-actions.ts`, `lib/ai/policyEngine.ts`) | Reviewed | No change needed (generic message + full log, already the safe pattern) |
| 12 | Route-level "plain Error" fallbacks (`routes/financial.ts`'s `handlePlainError`, `routes/communications.ts`'s inline fallback) | Audited in depth | **Yes — see §3.2/§3.3** |

## 2. The thirteen error categories every boundary above is checked against

Also a reasoned equivalent (see the disclosure above) — this is the taxonomy this pass
actually used to ask "is this boundary's handling of X correct" for each boundary in §1:

1. Validation error (zod schema failure) → 400, safe by construction (zod's own flattened
   error never contains anything beyond field names/constraint descriptions).
2. Not found / cross-tenant (uniform 404) → never distinguishable from a genuine 404, per
   the tenant-isolation convention established throughout this codebase.
3. Tenant mismatch (an explicit typed reason, e.g. `IntegrationError`'s `TENANT_MISMATCH`) →
   folded into the uniform 404 above, never its own distinguishable response.
4. Authorization/entitlement denied → 403, safe (a fixed, non-parameterised message).
5. Authentication required/invalid session → 401, safe (a fixed message).
6. Conflict / duplicate / idempotency violation → 409, message sourced from a dedicated typed
   error class's own deliberately-written string (`PitCrewConcurrencyError`,
   `CommunicationConcurrencyError`, `FinancialControlError`, etc.).
7. Rate limited → 429, safe (a fixed message, `middlewares/rateLimit.ts`).
8. Malformed webhook payload / signature invalid → 400, either zod's own error or a fixed
   string — never the underlying parse exception's own message (this is exactly what Part
   B's financial-webhook fix and this pass's integrations-webhook fix both closed).
9. Replay/duplicate delivery → 200 with `processed:false` (webhook routers) or 409
   (authenticated mutation routes) — idempotent by design, never itself an error state that
   needs its own leak analysis.
10. Upstream/provider transient failure → logged and classified (`integration_connection_degraded_total`,
    Part B), never surfaced as if it were the caller's own mistake.
11. Business-rule/domain invariant violation (a dedicated typed error class per domain:
    `CommunicationTransitionError`, `RiskExceptionError`, `AutomationValidationError`, etc.)
    → the class's own message, deliberately written to be safe, echoed back at 409/422.
12. Unexpected/unclassified server fault → 500, a fixed generic message, full detail logged.
    This is what §3.1's fix restores the DIAGNOSTIC half of, and what §1.1's new global
    handler is the safety net for on the CLIENT-RESPONSE half.
13. A boundary that used to hang forever on an uncaught async rejection → now either fixed at
    its own call site (Part B's financial-webhook fix; this pass's integrations-webhook fix)
    or, for anything not yet individually audited, no longer defaults to "response never
    sent" for a SYNCHRONOUS throw specifically, now that a global handler exists — though see
    the explicit limitation in §4 about what the global handler does and does not catch.

## 3. Findings and fixes, in the order they were found

### 3.1 — Every `logger.error(..., { error: err })` call in this codebase was logging an empty object, not the actual error

The single highest-value finding of this pass, and not one anywhere close to what the
boundary-by-boundary review above was looking for — it surfaced while writing this audit's
own tests. `packages/events/src/redaction.ts`'s `redactValue` iterated `Object.entries(value)`
for anything that reached its generic-object branch. A plain JavaScript `Error` instance's
`message` and `stack` are **non-enumerable** own properties, so `Object.entries(new
Error("..."))` — and therefore `JSON.stringify(err)` — returns `{}`. Every one of the several
dozen existing `logger.error("some_event", { error: err })` call sites across this codebase
(the grep for this pattern in `apps/api/src/routes/**` alone returns 27 matches, before
counting `lib/**`) was consequently writing a structured log line with an empty `error: {}`
field — discarding the actual diagnostic content (message, stack, and any custom properties
like `.reason`/`.status`/`.type`) every single time, silently, since this repository's
structured logger was first introduced.

**Fixed** in `redactValue` (`packages/events/src/redaction.ts`): an `Error` instance is now
normalised to a plain object (`name`, `message`, `stack`, plus any additional own enumerable
properties) before the generic object handling runs — so it still gets the SAME never-log-key
and value-shape redaction as everything else (an error message that happens to embed a
never-log-named field, or an exactly-secret-shaped string, is still redacted). Proven by 5 new
tests in `packages/events/src/__tests__/redaction.test.ts`, including one confirming a
never-log-named custom property on an Error (e.g. `.password`) is still redacted, and one
honestly documenting the pre-existing limitation this fix does NOT change (value-shape
detection is whole-string-match, not substring extraction — an error message that merely
*embeds* a token-shaped fragment among other text passes through unredacted, same as it always
has for any other logged string).

This fix is retroactive for every existing call site with zero code changes elsewhere — the
fix is at the shared root, not at each of the several dozen individual `logger.error({ error:
err })` calls.

### 3.2 — No global Express error-handling middleware existed at all

Confirmed by reading `app.ts` in full: no 4-argument error-handling middleware was mounted
anywhere. Consequence: a synchronous throw (or an error explicitly passed to `next(err)`, a
pattern several routes already use correctly when falling through an unrecognised error) fell
through to Express's own default handler, which — whenever `NODE_ENV` is anything other than
the literal string `"production"` — returns the error's message AND full stack trace directly
in the HTTP response body. This repository's own `.replit` "Dev" workflow runs `pnpm run
dev:api` (`tsx watch src/index.ts`), which never sets `NODE_ENV` at all, meaning this is the
actual, currently-live behaviour of the deployed "staging" environment today, not a
hypothetical.

**Fixed**: `apps/api/src/middlewares/errorHandler.ts`, mounted last in `app.ts`. Logs full
detail via the (now-fixed, §3.1) structured logger, and returns one of three safe responses:
413 for an oversized body, 400 for a malformed-JSON body (both body-parser failure shapes safe
to disclose precisely because they describe the caller's own request, not server internals),
or a fixed generic 500 message for everything else — never the underlying error's own message
or stack. Proven by 6 tests, including two real end-to-end HTTP tests (not just direct
function calls) confirming a real thrown error and a real oversized body each produce the safe
shape over an actual request/response cycle.

**Explicit limitation, not glossed over**: this is a synchronous-throw and explicit-`next(err)`
safety net. Express 4 (this app's version) does **not** automatically forward an async route
handler's rejected promise to error-handling middleware — an `async (req, res) => {...}`
handler that awaits a rejecting promise with no try/catch of its own still hangs the request
forever, exactly as before this fix, regardless of the new global handler existing. This
pass did not add a codebase-wide async-rejection safety net (e.g. wrapping every route
registration, or adding the `express-async-errors` package) — that would mean either touching
every route file individually (against this pass's "do not conduct another whole-of-app
audit" constraint) or adding a new runtime dependency during a security-hardening step without
separately justifying and risk-assessing it, neither of which this bounded pass judged
appropriate to do unilaterally. What this pass DID do instead is find and fix three concrete,
real instances of exactly this hang pattern (Part B's financial-webhook fix, and this pass's
own §3.6 integrations-webhook fix) — closing verified gaps, not the whole class speculatively.
**Recommended follow-up, not done this step**: either adopt `express-async-errors` (mature,
zero-transitive-dependency, single-line integration) after a human accepts it as a new
dependency, or systematically audit every remaining `async (req, res) => {...}` handler for an
unguarded `await` ahead of its own try/catch — the same technique that found the three
instances already fixed.

### 3.3 — Two "trust any Error's message" fallbacks had no diagnostic logging at all

`routes/financial.ts`'s `handlePlainError` and `routes/communications.ts`'s inline fallback (in
the manual-participant route) both caught any `Error` and returned its own `.message` directly
to the client at a real HTTP status (409/422) — a deliberate, documented design decision for
these two spots (the comment in `financial.ts` explains: "Existing Stage C/D service functions
throw plain Error for precondition failures... never a raw 500 for a caller mistake"). That
assumption was not re-verified against every function reachable through these two fallbacks in
this pass (doing so would mean re-auditing those functions' entire call graphs, out of this
bounded pass's scope) — but what WAS a clear, fixable gap, found by comparing these two
fallbacks against the equivalent pattern in `routes/pitCrew.ts`, `routes/import.ts`, and
`routes/automationOps.ts` (each of which logs the full error before falling back to a generic
or typed message): neither of these two logged anything at all. If the "every Error here is a
deliberate, safe message" assumption is ever wrong — a genuine bug, or a raw
infrastructure/driver error surfacing unexpectedly — there would have been zero server-side
diagnostic trail.

**Fixed**: both now call `logger.warn(...)` / already had access to `logger` added, with the
full error, before responding — with **no change to the response contract** any existing
caller depends on (still the same status code and `err.message` as before). Confirmed via the
existing `financialReconciliationVariance` and `communications`/`financial` route test suites
still passing unchanged.

### 3.4 — The integrations webhook route was completely unreachable by its real caller

`POST /api/integrations/webhooks/:connectionId/:provider` had **zero existing HTTP-level test
coverage** before this pass (every existing test drove `processInboundWebhook()` directly,
bypassing the route entirely) — writing the first one for this audit surfaced a severe,
pre-existing bug: every request to this path returned 401, regardless of body shape, even
though the route's own module comment states it is "mounted OUTSIDE requireAuth... a provider
callback carries no session cookie."

Root cause: `routes/index.ts` mounted `integrationsRouter` (which applies
`requireAuth`/`requireRole` via a single **unprefixed** `integrationsRouter.use(requireAuth,
requireRole(...))` — see `routes/integrations.ts`'s own module comment on why per-route gating
is used everywhere else in this codebase specifically to avoid this) **before**
`integrationsWebhooksRouter`. Express dispatches routers mounted via `apiRouter.use(...)` with
no path in registration order, over every request reaching `apiRouter`, regardless of whether
that request's path matches any route the router itself declares — so an unauthenticated
webhook request was intercepted and rejected by `integrationsRouter`'s blanket gate before it
ever reached `integrationsWebhooksRouter`'s own route. This is functionally a total outage of
inbound integration webhook processing: no real (mock) provider callback could ever have
succeeded against this endpoint.

**Fixed**: swapped the mount order in `routes/index.ts` so `integrationsWebhooksRouter` is
registered before `integrationsRouter`. Confirmed safe — `integrationsWebhooksRouter`'s only
route (`/integrations/webhooks/:connectionId/:provider`) does not overlap with any of
`integrationsRouter`'s own paths (`/integrations/connections/...`,
`/integrations/dead-letters/...`, `/integrations/settings`, `/integrations/overview`, etc.).
Proven by the new `routes/__tests__/integrationsWebhooks.test.ts` (which failed with 401 on
every test before this fix) and confirmed non-regressive against the full existing
`integrationsAdmin.test.ts` suite (7/7 still passing).

### 3.5 — Once reachable, the same route hung forever on a malformed connectionId

Discovered immediately after fixing §3.4, while extending the new test file: a
`connectionId` that isn't a valid UUID (trivially sent by any caller, since this route is
deliberately unauthenticated) caused the request to hang indefinitely rather than fail fast.
Root cause: `getSecretIdentifierForSigning(connectionId)` was called and awaited **outside**
the route's own `try {}` block — an unhandled promise rejection in an async Express handler,
the exact same bug class as the financial-webhook hang Part B already found and fixed
elsewhere in this same closure pass, now found a third time in a different file.

**Fixed**: moved the secret lookup and signature verification inside the existing try block.
Proven by a dedicated test that hung indefinitely against the pre-fix code and now completes
in milliseconds with a safe response (see §3.6 for what that response actually contains).

### 3.6 — The same route's catch block echoed a raw database error to the client

With §3.5's hang fixed, the underlying error (Postgres's own `invalid input syntax for type
uuid: "..."`, thrown because `connectionId` is compared against a `uuid` column with no format
pre-check) now reached the route's catch block — which, before this pass, logged nothing and
returned ANY caught `Error`'s own `.message` verbatim to the caller. That would have disclosed
raw database/driver error text to an unauthenticated caller.

**Fixed**: the catch block now always logs the full error server-side first, and only echoes
back a message when the error is a recognised `IntegrationError` (the two deliberate,
safe-to-disclose throws this function makes: `NOT_FOUND` for an unknown connection,
`VALIDATION` for an oversized payload) — every other error, including this one, gets the fixed
generic message `"Webhook processing failed."` instead. Proven by a test asserting the exact
generic message and that no database-error-shaped text (`uuid`, `syntax`, `postgres`, `invalid
input`) appears anywhere in the response.

## 4. What this pass did NOT do, disclosed rather than implied

- **No codebase-wide async-rejection safety net.** See §3.2's explicit limitation. This pass
  fixed three concrete, verified hang instances (two in this document, one in Part B); it did
  not audit every remaining route for the same latent pattern, and does not claim to have
  found every instance that may exist.
- **No re-verification of every "Stage C/D service function"** reachable through
  `routes/financial.ts`'s `handlePlainError` or the equivalent `routes/communications.ts`
  fallback. The logging gap at those two chokepoints is fixed (§3.3); whether every function
  behind them genuinely only throws safe, deliberate messages was not re-audited function by
  function.
- **No change to `packages/events/src/publisher.ts`'s domain-event dispatch contract** — its
  callers were already audited individually during this step's Part B correlation-propagation
  work; re-auditing them again here would be redoing already-closed work, which this pass's
  governing instruction explicitly rules out.
- **No new npm dependency was added** (e.g. `express-async-errors`) despite it being the most
  direct fix for the async-rejection gap named in §3.2 — left as a named, scoped recommendation
  for a human to accept, consistent with this step's general posture of not introducing new
  dependency risk unilaterally during a security-hardening pass (see also
  `SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md` §8 / the `xlsx`/`esbuild` risk-acceptance record
  for the same posture applied to existing dependencies).
- **This is not a claim that every one of the app's ~28 route files was individually
  re-audited for a leaking error message.** The boundaries in §1 were chosen because they are
  either the highest-exposure surfaces (unauthenticated webhook routes) or because a specific,
  concrete pattern (a bare `if (err instanceof Error)` fallback with no typed discrimination)
  was grep-searched for across the whole `apps/api/src` tree and every match was reviewed —
  that grep is reproducible (`if (err instanceof Error)` in `apps/api/src`) and returned
  exactly the two sites fixed in §3.3, so this document is not silently narrower than its own
  grep's actual reach for that one specific pattern. Every OTHER route's own typed-error
  handling (the dozens of `instanceof <SpecificError>` chains this codebase already has) was
  spot-checked, not exhaustively re-verified line by line.

## 5. Test evidence

All new/modified tests from this pass, run and confirmed passing (not merely written):

- `packages/events/src/__tests__/redaction.test.ts` — 5 new tests (63/63 total in the package's
  full suite, 0 failures).
- `apps/api/src/middlewares/__tests__/errorHandler.test.ts` — 6 new tests, all passing,
  including 2 real end-to-end HTTP tests.
- `apps/api/src/routes/__tests__/integrationsWebhooks.test.ts` — 4 new tests, all passing
  (all 4 failed before this pass's fixes: 3 with 401 from the mount-order bug, the 4th hanging
  indefinitely from the unhandled-rejection bug).
- `apps/api/src/routes/financial.ts` / `apps/api/src/routes/communications.ts` — no new tests
  (behavioural contract unchanged), confirmed non-regressive via the existing
  `financial.test.ts`, `communications.test.ts`, and `financialReconciliationVariance.test.ts`
  suites.
- Full `apps/api` regression suite re-run in 4 sequential chunks after all of this pass's
  changes: 662 tests, 661 passing, 0 failing, 1 skipped — no regressions introduced by the
  redaction fix, the new global error handler, or the router mount-order change.
