# Security Incident Runbooks

Agent Engine 2.0, Step 2. Twelve incident types, each grounded in a real control this step
built or reviewed — not generic boilerplate. Roles below are operational (**On-Call
Engineer**, **Security Lead**, **Engineering Lead**, **Brokerage Contact** — whoever the
affected brokerage's point of contact is), never named individuals. As with the other
Part B/C documents, the instruction's own prescribed list of twelve incident types was not
recoverable verbatim from this session's available context; the twelve below are this
step's own reasoned selection, chosen because each corresponds to a control this step
actually implemented, fixed, or reviewed — flagged for comparison against the original
spec if it becomes available.

None of these runbooks assume a real third-party sandbox/production connection or a real
paging system — neither exists yet (see `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`).
Detection steps describe what a human should check manually today; where an alert
condition from that document would eventually automate the detection step, it's named.

---

## 1. Suspected cross-tenant data exposure (IDOR)

**Detection.** A user reports seeing data that isn't theirs, or an unusual pattern of
"not found" responses from one account against the tenant-isolation chokepoints (see
alert #5, `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`).

**Immediate action (On-Call Engineer).** Identify the specific route/function involved.
Check it against `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`'s matrix — if it's
a file marked PASS, confirm the live code still matches what's documented (a regression is
possible if it was touched since); if it's a route not yet in the matrix (e.g. new code
added after this step), audit it directly against the tenant-isolation convention in that
document's §3.

**Containment.** If a live exposure is confirmed: identify every affected brokerage pair,
determine what was read/written, and — if a write occurred (not just a read) — determine
whether it needs to be manually reversed (e.g. a forged Pit Crew overlay row, an incorrectly
linked party).

**Escalation.** Security Lead notified immediately on confirmation. Affected Brokerage
Contact(s) notified per the organisation's disclosure policy (this document does not set
that policy — it's a business decision, not an engineering one).

**Recovery.** Ship the fix following the exact pattern in
`AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` §3 (same-query brokerage filter,
identical not-found either way), with a regression test proving the specific exploit path
is closed, mirroring the nine fixes already on record in that document.

---

## 2. Compromised or leaked `SESSION_SECRET`

**Detection.** Secret found in a log, a committed file, a third-party breach notification,
or simply suspected after a credential-handling incident elsewhere.

**Immediate action.** Rotate `SESSION_SECRET` immediately (generate a new value, e.g.
`openssl rand -base64 48`, per `.env.example`'s own guidance) and redeploy. Because the
signing key changes, **every outstanding session token becomes invalid** the instant the
new secret is live — this is the blunt-instrument version of the per-user `sessionEpoch`
revocation (§4 below), applied to every user at once. All users will need to sign in again.

**Containment.** Confirm the process actually restarted with the new value —
`assertSessionSecretConfigured()` fails closed at boot if the new value is also too short/
unset, so a failed restart here is visible immediately as a boot failure, not a silent
fallback.

**Investigation.** Determine how the secret was exposed (log line, git history, a shared
terminal, a support ticket) and close that specific channel.

**Recovery.** Confirm via `GET /auth/me` with a pre-rotation token that it now correctly
401s, and that a fresh `POST /auth/dev-login` issues a working new token.

---

## 3. Leaked API key or integration credential reference

**Detection.** A provider API key (`AML_PROVIDER_API_KEY`, `ESIGN_PROVIDER_API_KEY`,
`STRIPE_SECRET_KEY`, `ANTHROPIC_API_KEY`) appears somewhere it shouldn't. Note: an
`integrationCredentials.secretIdentifier` value leaking is **not** equivalent to a real
provider secret leaking — by construction (`lib/integrations/credentials.ts`) it is an
opaque, self-generated reference, never a real credential (see
`SECURE_INTEGRATION_BOUNDARY.md` §1) — but its exposure still matters as a signal that
something in the credential-handling path is being read where it shouldn't be.

**Immediate action.** Rotate the affected key at the provider (real providers — currently
none are wired in, so today this step applies only to environment-variable hygiene, not a
live provider rotation). Update the environment variable and redeploy.

**Containment.** Check the provider's own access logs (once a real provider exists) for
unauthorized use of the compromised key in the window it was exposed.

**Recovery.** Confirm the relevant mock/real provider calls succeed again post-rotation.

---

## 4. Session token compromise (targeted user)

**Detection.** A user reports suspicious activity on their account, or a token is found
outside its expected location (a log, a shared device).

**Immediate action.** The affected user calls `POST /auth/logout` — or, if they can't
(device lost, account inaccessible), an operator triggers the same effect directly
(increment that user's `users.sessionEpoch`). This is exactly what this step's new
revocation mechanism exists for (see `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.
md` §1) — instantly invalidates every outstanding token for that user, not just the one
in the browser that clicked logout.

**Verification.** Confirm the old token now 401s on the next request (`loadSession`'s
epoch check) and that the user can sign in again normally.

**Escalation.** If the compromise resulted from a broader issue (XSS, a shared machine,
a phished credential), treat that root cause as its own incident.

---

## 5. CORS misconfiguration / open-origin incident

**Detection.** A response is observed carrying an unexpected `Access-Control-Allow-Origin`
value, or `assertCorsConfigured()` is found to have been bypassed somehow (e.g. a
non-production `NODE_ENV` value in an environment that should be production).

**Immediate action.** Check `CORS_ALLOWED_ORIGINS` against the actual deployed value —
confirm it's an explicit, correct allowlist, not empty (which only fails closed in
production — a non-production misconfiguration could silently fall back to the localhost
dev defaults in `lib/cors.ts`, which is safe for dev but would be a real gap if a
non-production-labeled environment were internet-reachable).

**Containment.** Update the env var, redeploy, and confirm via a direct request with a
disallowed `Origin` header that it's now rejected (no
`Access-Control-Allow-Origin` echoed back).

---

## 6. Rate-limit bypass / credential-stuffing attempt on `/auth`

**Detection.** Alert #3/#4 (`METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`) — sustained 401/403
or 429 volume from one source against `/auth/*`.

**Immediate action.** Confirm `authRateLimiter` (20/min/IP in real environments — see
`middlewares/rateLimit.ts`) is actually mounted ahead of `authRouter`
(`routes/index.ts`'s `apiRouter.use("/auth", authRateLimiter, authRouter)`) and hasn't been
bypassed by a proxy/load-balancer misconfiguration that strips or spoofs the client IP
`express-rate-limit` keys on.

**Containment.** If IP-based limiting is being defeated by rotation across many IPs,
this is beyond what a single-dimension IP rate limiter can stop — escalate to Security
Lead for a broader response (e.g. temporary additional restriction on `/auth/dev-login`
specifically, since it's already dev/staging-only by design).

---

## 7. Webhook signature-verification bypass suspected

**Detection.** Alert #6 — signature failures spike, or (more seriously) a webhook-driven
state change is found that doesn't correspond to any real signed callback.

**Immediate action.** Confirm the relevant webhook secret (`AML_WEBHOOK_SECRET`, `ESIGN_
WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`, or the per-connection integration secret) hasn't
leaked (if it has, this is also incident #3). Confirm `req.rawBody` capture in `app.ts` is
still intact — the signature is computed over the exact raw bytes, and any change to body-
parsing middleware (this step added the 1 MB limit; a future change could accidentally
reorder or replace the parser) could silently break verification in a way that either
rejects all legitimate webhooks (availability issue) or — far worse — is bypassed entirely
if verification is accidentally short-circuited.

**Containment.** If bypass is confirmed, treat every webhook-driven write since the
suspected bypass window as unverified and manually reconcile against the actual provider
mock state (or, for a real provider in the future, that provider's own dashboard/API).

---

## 8. Dependency vulnerability disclosed

**Detection.** A `pnpm audit` run (manual today — see `SECURITY_ARCHITECTURE_AND_THREAT_
MODEL.md` §8; not yet a scheduled CI check, since no CI exists — see the completion
report) reports a new `high`/`critical` finding, or a public CVE is disclosed for a package
this repo depends on.

**Immediate action.** Check whether a fixed version is available via the npm registry. If
yes: bump directly (this step did exactly this for `qs`, via a `pnpm.overrides` pin — see
`package.json`). If no fixed registry version exists (this step's own disclosed situation
for `xlsx`): assess whether the vulnerable code path is reachable from an untrusted input
(for `xlsx`: yes, via the import pipeline, but behind the compensating controls in `DATA_
CLASSIFICATION_AND_PROTECTION.md` §5) and decide, with human sign-off, whether to accept
the risk, pin to a non-registry source, or replace the dependency.

**Recovery.** Re-run `pnpm audit`, confirm the finding count decreased, run the full
regression suite to confirm the change didn't break anything (this step did exactly this
after the `qs` override — see the completion report's test evidence).

---

## 9. Database connectivity / outage

**Detection.** Alert #1 — `GET /api/health` returning 503 for ≥ 2 consecutive checks.

**Immediate action.** Confirm whether this is the database itself being down, a network
partition, or a credentials issue (`DATABASE_URL` misconfigured on a redeploy). The health
check's own error is logged server-side (`console.error("GET /api/health: database check
failed", err)`) with the underlying driver error, which should indicate which.

**Containment.** The API remains up and serving `503` for health checks and will fail
individual requests that touch the database (every request does — there's no cached/
degraded-mode read path in this build), so this is a full outage from the user's
perspective, not a partial degradation, until the database is reachable again.

---

## 10. Data-import pipeline abuse (malicious file upload)

**Detection.** Alert #11 — import job rejection-at-validation spikes, or a specific
brokerage repeatedly submits files that fail `fileValidation.ts`'s checks.

**Immediate action.** Confirm the rejections are happening at the validation layer (25 MB
cap, extension allowlist, magic-byte check — see `DATA_CLASSIFICATION_AND_PROTECTION.md`
§5) and not reaching the `xlsx` parser at all — if they are being rejected pre-parse, the
control is working as designed and this is likely user error or exploratory probing, not a
successful attack. If a file is found to have passed validation but caused abnormal
resource use (memory/CPU) during parsing, treat as a possible `xlsx` ReDoS exploitation
attempt (the disclosed, unfixed advisory — see incident #8's dependency angle) and escalate
to Security Lead.

---

## 11. Dev-login surface exposed in an environment it shouldn't be

**Detection.** Alert #15 — `GET /auth/known-users` or `POST /auth/dev-login` returning
anything other than 404 in an environment believed to be production, or
`isDevAuthEnabled()` observed returning `true` unexpectedly.

**Immediate action.** This should be structurally impossible — `isDevAuthEnabled()`
(`lib/env.ts`) hard-disables both routes whenever `NODE_ENV==="production"`, with no
override. If it's happening anyway, the most likely cause is `NODE_ENV` itself being
misconfigured in the deployment (not set to `"production"` when it should be) — check that
first before assuming the auth-gating logic itself regressed.

**Containment.** If confirmed exposed: this is a full passwordless-account-creation
exposure — treat as an active incident, not a configuration warning. Fix the environment
variable and redeploy immediately; audit for any accounts created via the exposed route
during the exposure window.

---

## 12. Audit-log gap or tampering suspected

**Detection.** Alert #17 — a `logAudit` call observed to throw/fail silently, or a gap
found in the expected audit trail for a known action (e.g. a payment refund with no
corresponding `payment_refunded` audit row).

**Immediate action.** Confirm whether the gap is a genuine write failure (database issue,
concurrent with incident #9) or a code path that simply doesn't call `logAudit` for that
action (a coverage gap, not tampering — check the relevant route handler directly against
this codebase's existing convention of logging every state-changing action).

**Containment.** If tampering (a modified or deleted audit row) is suspected rather than a
coverage gap: this indicates either direct database access outside the application (an
infrastructure-level incident, escalate immediately to Security Lead and Engineering Lead
jointly) or an application-level bug allowing a delete/update against the audit table that
shouldn't be reachable at all (`auditLog` should have no `DELETE`/`UPDATE` route anywhere
in `apps/api/src/routes` — confirm this directly if tampering is suspected).

---

## Backup and recovery — verification boundary

This step's instruction is explicit that destructive restoration must not be run against
production, and no production environment exists for this build regardless. What was
verified this session, non-destructively: the schema is applied via `drizzle-kit push`
(`pnpm run db:push`, confirmed working against the local `aee_test` database this session
when the `sessionEpoch` migration was applied and verified via `information_schema.
columns`), and hand-written migration SQL files are maintained under `packages/db/
migrations/` for history/audit purposes even though `db:push` (not the file-based migrate
pipeline) is this project's actual deployment mechanism — a pre-existing, documented
inconsistency (see the completion report's entry-gate evidence), not something this step
introduced or resolved. A real backup/restore drill (snapshot a database, restore it,
verify data integrity) was not run — there is no backup tooling or snapshot mechanism
configured anywhere in this repository to exercise, and standing one up is infrastructure
work outside a local dev/test workspace's reach. Recorded as deferred, not fabricated.
