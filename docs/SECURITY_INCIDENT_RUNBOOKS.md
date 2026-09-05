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
alert #8, `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`).

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

**Detection.** Alert #6/#7 (`METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`) — sustained 401/403
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

**Detection.** Alert #9 — signature failures spike (`integration_webhook_total{outcome=
"rejected"}` — currently only wired for the integrations webhook router, not comms/
financial, see `METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md` §4), or (more seriously) a
webhook-driven
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

**Detection.** Alert #1 (`METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`) —
`health_check_duration_ms{status="unavailable"}` recorded (i.e. `GET /api/health/ready`
returning 503) for ≥ 2 consecutive scrape intervals. Alert #2 covers the related but
distinct **degraded** case: the database is reachable but slow (query latency sustained
above the 500 ms threshold in `routes/health.ts`) — still 200, traffic still routes, but is
its own signal and should not be confused with an outright outage.

**Immediate action.** Check `GET /api/health/live` first — if it's also failing (or timing
out), the process itself is wedged, not just its database connection, and this is a
liveness/restart situation, not a readiness one; see the module comment in `routes/
health.ts` for why the two are deliberately split. If liveness is fine and only readiness is
failing, confirm whether this is the database itself being down, a network partition, or a
credentials issue (`DATABASE_URL` misconfigured on a redeploy). The failure is logged
server-side via the structured logger, not `console.error` —
`logger.error("readiness_check_failed", { error, durationMs })` — with the underlying driver
error message in the `error` field and, per `packages/events/src/redaction.ts`'s never-log
list, nothing from that error is redacted unless it happens to embed something shaped like a
secret (a raw connection string containing a password would be — driver error messages are
not guaranteed never to include one, so treat the logged `error` field itself with the same
care as any other log line, not as automatically safe). `checkReadiness()`'s own returned
`reasons` array deliberately never includes the raw error message
(`["database unreachable"]` only) — that fixed, non-leaky reason is what reaches any client
calling `/ready` directly; the raw error is only in the server-side log line.

**Containment.** The API remains up and serving `503` from `/ready` (and the backward-
compatible `/health`) and will fail individual requests that touch the database (every
request does — there's no cached/degraded-mode read path in this build), so an
**unavailable** reading is a full outage from the user's perspective, not a partial
degradation, until the database is reachable again. A sustained **degraded** reading is not
an outage — requests are succeeding — but should be investigated before it becomes one.

---

## 10. Data-import pipeline abuse (malicious file upload)

**Detection.** Alert #21 — import job rejection-at-validation spikes, or a specific
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

**Detection.** Alert #17 — `GET /auth/known-users` or `POST /auth/dev-login` returning
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

**Detection.** Alert #19 — a `logAudit` call observed to throw/fail silently, or a gap
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

## Backup and recovery — real drill executed, non-destructively

This step's instruction is explicit that destructive restoration must not be run against
production, and no production environment exists for this build regardless. A prior
revision of this document recorded the backup/restore drill as deferred, on the reasoning
that "there is no backup tooling or snapshot mechanism configured anywhere in this
repository to exercise." That reasoning was wrong: `pg_dump`/`pg_restore` are the standard
Postgres backup/restore tools, ship with any Postgres client installation (confirmed present
at `/usr/bin/pg_dump`/`/usr/bin/pg_restore` in this workspace), require no project-specific
configuration to exercise, and are exactly what "backup tooling" means for a Postgres-backed
service without a managed provider's own snapshot feature. A real, complete, non-destructive
drill was run against the local `aee_test` database (never a production database, none
exists for this build) and is recorded below with real numbers, not a plan for one.

**Procedure and results, run in full this session:**

1. **Dump.** `pg_dump -Fc "$DATABASE_URL" -f source.dump` — custom-format dump of the entire
   `aee_test` database, completed in 0.219s, producing a 906,975-byte file. `pg_dump`'s
   custom format captures a transactionally-consistent snapshot as of the moment the dump
   starts, which matters for the row-count note below.
2. **Restore.** A fresh scratch database (`aee_backup_drill`, created via `CREATE DATABASE`,
   never reused from a prior drill) was restored into via
   `pg_restore --no-owner --no-privileges -d aee_backup_drill source.dump`, completed in
   0.779s with zero errors or warnings on stderr.
3. **Schema parity.** Table count: 89 in both the source and the restored database. Index
   count: 191 in both (`pg_indexes`, `schemaname='public'`). Constraint count: 357 in both
   (`pg_constraint` joined to `pg_namespace`), of which 256 are foreign keys.
4. **Row-count parity, per table.** All 89 tables matched exactly, with one expected and
   explained exception: `audit_logs` showed 17,523 rows in the live source database at
   verification time versus 17,519 in the restored snapshot. This is not a restore defect —
   the full regression suite (`pnpm run test`, a genuinely separate, concurrently-running
   process on this same shared workspace at drill time — see the completion report's test
   evidence) was actively writing audit-log rows to `aee_test` throughout the several
   minutes between the dump being taken and the row-count comparison being run against the
   now-further-along live source. `pg_dump`'s consistent-snapshot behavior means the four
   rows written to the source *after* the snapshot correctly do not appear in a restore made
   *from* that snapshot — this is the tool working exactly as designed, not a data-loss
   finding, and is recorded honestly here rather than quietly re-running the drill against a
   frozen table to manufacture a cleaner-looking diff.
5. **Referential-integrity verification.** A generic script iterated all 256 single-column
   foreign-key constraints in the restored database (via `pg_constraint`) and checked each
   for orphaned child rows (a non-null foreign-key value with no matching parent row).
   Result: **0 orphaned rows across all 256 constraints.**
6. **Row-level identity verification.** The `brokerages` table (unaffected by the
   concurrently-running test suite, which does not touch tenant records after test-fixture
   setup) was checked two ways: its minimum-id row (`id`, `name`, `created_at`) was
   byte-identical between source and restored; separately, an order-stable MD5 checksum of
   every row in the table (`md5(string_agg(t::text, '' order by id))`) was computed against
   both databases and matched exactly
   (`049fff24b806d8ee175d68ed5059910f` in both) — a stronger identity proof than a single
   sampled row, covering the entire table's content in one comparison.
7. **Cleanup.** `aee_backup_drill` was dropped (`DROP DATABASE aee_backup_drill`) immediately
   after verification, confirmed absent via a follow-up query against `pg_database`. No
   scratch database or dump file was left behind on disk after the drill.

**What this drill proves and what it doesn't.** It proves the mechanical backup/restore
path works correctly against this schema today — a real dump can be taken and a real restore
from it reconstructs an identical, referentially-intact copy of the database, verified
structurally (tables/indexes/constraints), relationally (zero FK orphans across every
single-column foreign key), and by content (an exact table checksum), not merely asserted.
It does not establish a production backup *schedule*, an offsite/durable storage target for
dump files, or a restore runbook rehearsed against a realistically-sized production dataset
— those require a real production environment and real infrastructure decisions (retention
window, storage location, encryption at rest for the dump file itself, which contains the
same sensitive data the live database does) that are out of this step's reach and are not
claimed to be settled by this drill. Schema deployment itself continues to use
`drizzle-kit push` (`pnpm run db:push`) as this project's actual mechanism, with
hand-written migration SQL files under `packages/db/migrations/` maintained for history/
audit purposes — a pre-existing, documented inconsistency (see the completion report's
entry-gate evidence), unchanged by this drill.
