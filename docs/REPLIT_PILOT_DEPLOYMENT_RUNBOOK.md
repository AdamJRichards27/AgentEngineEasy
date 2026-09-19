# Replit Pilot Deployment Runbook — Agent Engine 2.0

`docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md`

**Status of this document: preparation only.** This runbook describes exactly how an AE
Backend Engineering operator would deploy a private, production-mode pilot instance of Agent
Engine 2.0 on Replit, once the renewed Operational Readiness Gate decision (Phase 12 of "AE
Operational Readiness — Critical Blocker Remediation") authorises doing so. **Writing this
runbook does not deploy anything, and nothing in it should be executed against a real pilot
database until that renewed decision is in hand.** Per the AE Project Owner's explicit
instruction for this remediation pass: do not deploy publicly, do not invite pilot participants.

This is Queensland, Australia pilot only — see `docs/gate-evidence/PHASE6_JURISDICTION_CORRECTION.md`.
Every external service stays test/sandbox mode only — see §5 below.

## 1. Architecture decision: one Replit deployment, API-served static frontend

Agent Engine 2.0's frontend (`apps/web`) has no configurable API base URL — every request goes
to a path-relative `/api/...` (see `apps/web/src/lib/api.ts`), which only resolves correctly when
the frontend and the API share an origin. Rather than run a separate Replit Static Deployment for
the built frontend (which would need a reverse-proxy rewrite or a frontend code change), this
pilot uses **one deployment**: the API process serves the built frontend directly as static files
in production mode (`apps/api/src/lib/staticWeb.ts` — see
`docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md` §1 for the full rationale and
verification). One Repl, one deployment, one public URL, once approved.

## 2. Before you start: what must already be true

- The renewed Operational Readiness Gate decision (Phase 12) is `READY FOR CONTROLLED PILOT` or
  `READY FOR CONTROLLED PILOT — CONDITIONS APPLY`. **Do not proceed past this point otherwise.**
- You have a dedicated, empty Postgres database for this pilot — never the shared development/
  test database. Replit's own managed Postgres, or an external managed Postgres instance, both
  work; only the `DATABASE_URL` connection string matters to this application.
- You have decided, and recorded somewhere durable (not in this repository), who the first
  Brokerage Administrator will be (name, email, brokerage name) — you will create that account
  yourself in §7, before anyone else can sign in.

## 3. Secrets to set in Replit (never commit any of these)

Set every one of these in the Repl's **Secrets** pane (not `.env`, not `.replit`, never
committed to git). Names must match exactly — the application fails closed (refuses to boot) if
a required one is missing or malformed; see `apps/api/src/index.ts`'s boot-time assertions.

| Secret | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | The pilot's own dedicated Postgres connection string. Never point this at any other environment's database. |
| `NODE_ENV` | Yes | Must be exactly `production`. This is what activates every fail-closed gate below, and what activates static-web serving (§1). |
| `SESSION_SECRET` | Yes | A random string of at least 32 characters (e.g. `openssl rand -base64 48`). The process refuses to boot without this. |
| `CORS_ALLOWED_ORIGINS` | Yes | The exact pilot deployment URL (e.g. `https://your-repl-name.replit.app`) — comma-separated if more than one. The process refuses to boot without this in production. Same-origin requests (the SPA calling its own `/api`) do not strictly need CORS, but this is still required to boot, and matters for any legitimate direct API caller. |
| `METRICS_TOKEN` | Yes | A random value. Required so `GET /api/internal/metrics` isn't exposed unauthenticated. The process refuses to boot without this. |
| `AUTH_EMAIL_PROVIDER` | One of this or the next row | Set to a real, approved provider name once one exists. **Not available for this pilot** — no real email provider has been approved (Owner decision: test/sandbox external services only). |
| `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED` | One of this or the row above | Set to exactly `true` to boot with the sandbox (non-delivering) email provider, consistent with the Owner's explicit sandbox-only decision. **Read §5 before setting this** — it has a direct operational consequence for onboarding. |
| `FRONTEND_BASE_URL` | Yes | The exact pilot deployment URL (same value as `CORS_ALLOWED_ORIGINS`, without a trailing slash) — this is what invitation/reset links are built against (`apps/api/src/routes/auth.ts`'s `frontendBaseUrl()`). Left unset, it defaults to `http://localhost:5173`, which would make every invitation/reset link useless. |
| `PORT` | No | Defaults to `8080`. Only set if Replit's own port wiring requires a specific value. |
| `WEB_DIST_DIR` | No | Only set if the built frontend ends up somewhere other than the default `apps/web/dist` relative to the built API bundle — see `apps/api/src/lib/staticWeb.ts`. Leave unset for the standard build layout. |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error`; defaults to `info`, and any unrecognised value also falls back to `info` (`packages/events/src/logger.ts`). Note §5 — the hand-deliverable invitation link is emitted at `warn`, so it survives the default level. |

### 3.1 Operational alerts — required for production boot

`assertOperationalAlertsConfigured()` (`apps/api/src/lib/operationalAlerts.ts`, called from
`apps/api/src/index.ts`) throws in production unless **all four** of these are set. There is no
"alerts off" production mode.

| Secret | Required | Notes |
|---|---|---|
| `OPERATIONAL_ALERTS_ENABLED` | Yes | Must be exactly `true`. |
| `OPERATIONAL_ALERTS_PROVIDER` | Yes | Must be exactly `webhook` — the only provider implemented. |
| `OPERATIONAL_ALERTS_WEBHOOK_URL` | Yes | Must parse as a URL and, in production, must be `https:`. This is the receiver that gets readiness/storage/process-safety alerts. |
| `OPERATIONAL_ALERTS_TOKEN` | Yes | At least 16 characters; sent as `Authorization: Bearer <token>`. |
| `OPERATIONAL_ALERTS_COOLDOWN_SECONDS` | No | 1–86400, defaults to 300. Per-process, in-memory deduplication only — see §11. |
| `OPERATIONAL_ALERTS_ALLOW_TEST` | No | Leave unset/`false`; test dispatch is a separate explicit opt-in. |

Configuring a receiver is not evidence that anyone is paged — see
`docs/PILOT_SUPPORT_AND_ESCALATION.md` §5, which keeps the manual daily review path regardless.

### 3.2 Active legal artifacts — required for production boot

`assertApprovedLegalVersionsConfigured()` (`apps/api/src/lib/auth/legalVersions.ts`) throws in
production unless all five are set and consistent. These are engineering integrity inputs, not
evidence of legal review; an assigned authority must have approved the non-draft artifacts
separately.

| Secret | Required | Notes |
|---|---|---|
| `LEGAL_DOCUMENTS_APPROVED` | Yes | Must be exactly `true`; approval is never inferred from the files being present. |
| `APPROVED_TERMS_ARTIFACT_PATH` | Yes | Filesystem path readable by the API process at boot. |
| `APPROVED_TERMS_SHA256` | Yes | Lowercase 64-hex SHA-256 of those exact bytes. A mismatch refuses startup; the digest also becomes the recorded version identity (`sha256:<hash>`). |
| `APPROVED_PRIVACY_ARTIFACT_PATH` | Yes | As above, for the Privacy Policy. |
| `APPROVED_PRIVACY_SHA256` | Yes | As above. |

Startup also refuses any artifact whose content contains the marker
`DRAFT — LEGAL REVIEW REQUIRED`.

### 3.3 Durable document storage — required for production boot

`assertDocumentStorageConfigured()` (`apps/api/src/lib/documentStorage.ts`, plus
`createObjectStorageProvider()` in `packages/integrations/object-storage/src/index.ts`) throws in
production unless object storage is a real S3-compatible bucket. Local disk is development/test
only. `apps/api/src/index.ts` additionally runs `checkDocumentStorageReadiness()` in production and
refuses to start if it fails, so the bucket must be reachable and writable at boot — not just
configured.

| Secret | Required | Notes |
|---|---|---|
| `OBJECT_STORAGE_PROVIDER` | Yes | Must be exactly `s3` in production. |
| `OBJECT_STORAGE_ENDPOINT` | Yes | Must be an HTTPS URL with no credentials, query string, or fragment. |
| `OBJECT_STORAGE_REGION` | Yes | e.g. `ap-southeast-2`. |
| `OBJECT_STORAGE_BUCKET` | Yes | Private bucket; name is character-validated. |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | Yes | |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | Yes | |
| `OBJECT_STORAGE_SESSION_TOKEN` | No | Only for temporary credentials. |
| `OBJECT_STORAGE_PREFIX` | No | Optional key prefix. |
| `OBJECT_STORAGE_SERVER_SIDE_ENCRYPTION` | No | `AES256` (default) or `aws:kms`. |
| `OBJECT_STORAGE_KMS_KEY_ID` | Conditional | Required when server-side encryption is `aws:kms`. |
| `DOCUMENT_STORAGE_SIGNING_SECRET` | Yes | Production refuses to start without it; at least 32 bytes. Outside production it silently falls back to `SESSION_SECRET`, so a production deployment must set it explicitly. |

The known-good combination of §§3–3.3 is exercised on every CI run by
`.github/scripts/synthetic-production-startup.sh`, which boots `apps/api/dist/index.mjs` with
`NODE_ENV=production` against a disposable localhost HTTPS mock and requires
`GET /api/health/ready` to report `"status":"ok"`. Use that script's env block as the reference
list when a production boot fails: if a variable is not in it and not in the tables above, it is
not part of the minimum startup set. (That script relies on `DATABASE_URL` and `SESSION_SECRET`
coming from the surrounding workflow environment — see `.github/workflows/ci.yml` — so both are
still required even though the script does not restate them.)

Leave every other `.env.example`-listed variable (AML, e-sign, payment, property-data provider
credentials, Stripe keys, etc.) **unset**. Unset means each provider factory falls back to its
mock/sandbox implementation — see `docs/INTEGRATION_FALLBACK_MATRIX.md` — which is the required
state for this pilot (§5), and see §5.1 for the flags that must specifically stay unset.

## 4. Build

From the Repl shell, or as the Replit deployment's configured build step (see §8):

```
pnpm install --frozen-lockfile
pnpm --filter @aee/web run build
pnpm --filter @aee/api run build
```

This produces `apps/web/dist` (the static frontend) and `apps/api/dist/index.mjs` (the bundled
API, which now also serves the frontend in production mode — see §1). Confirm both complete with
no errors before proceeding; `pnpm --filter @aee/api run build` must show no warning about
missing workspace-package resolution (if it does, do not proceed — see
`docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md` §2 for what that would mean).

## 5. External services stay test/sandbox only — read this before setting the pilot-mode flag

Per the Owner's explicit instruction for this remediation pass, **no real AML, email, SMS,
e-signature, payment, or property-data action is authorised for this pilot.** Leaving every
provider env var unset (§3) achieves this for AML/e-sign/payment/property-data automatically —
they default to mock/sandbox with no further action needed.

Email is the one exception requiring a decision, because the API's own fail-closed boot check
(`assertAuthEmailProviderConfigured`) refuses to start in production without either a real
provider or the explicit `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true` flag (§3). If
you set that flag:

- **No invitation or password-reset email is ever actually sent to a participant's inbox.** The
  link is generated, and — because the flag is set — additionally written to the application's
  own structured logs as a `pilot_mode_sandbox_email_link` warning (recipient, template, and the
  full link). An operator with access to those logs (Replit's own console, or wherever logs are
  shipped) retrieves the link from there and hand-delivers it to the participant out of band
  (phone call, an already-verified separate channel — never by posting it somewhere public).
- This is a real, accepted operational limitation for this pilot, not a bug — see
  `docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md` §3 for the full reasoning. Configure a
  real, approved email provider (`AUTH_EMAIL_PROVIDER`) before any wider launch; doing so also
  makes the pilot-mode log line disappear automatically (the code path that emits it only runs
  when the flag is set).

### 5.1 Flags that must remain unset or false for this pilot

Every flag below is fail-closed: the guarded behaviour is unreachable unless the flag is set to
the **literal string** `true` (or, for the ingress pairs, `true` **and** a secret is provisioned).
Leaving them blank is the configured state for the pilot. Setting any of them is a separate
decision for the Project Owner, not a deployment detail.

| Flag | What setting it to `true` would enable | Scope |
|---|---|---|
| `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` | Unlocks real (non-mock) billing, payment, AML, e-signature and property-data providers — `mustForceMockExternalProvider()` in `apps/api/src/lib/env.ts` and the matching local check in each `packages/integrations/*` factory. | Production only |
| `LIVE_AI_PROVIDER_APPROVED` | Lets `apps/api/src/lib/ai/gateway.ts` construct a real model provider, so brokerage/contact context leaves the system. Without it, any non-mock `AI_PROVIDER` falls back to the mock provider with a logged warning. | Every environment |
| `LIVE_VOICE_TRANSCRIPTION_APPROVED` | Lets a real (Deepgram) provider receive a user's recorded voice note. Without it the voice gateway throws a typed `live_provider_disabled` error rather than silently mocking. | Every environment |
| `LIVE_CALL_TRANSCRIPTION_APPROVED` | Lets recorded **call** audio be sent to a real transcription provider. Deliberately independent of the voice-note flag above. | Every environment |
| `LIVE_TELEPHONY_APPROVED` | Kill switch reserved for a future real telephony adapter. No such adapter exists in this build — only `SandboxTelephonyProvider`, which never dials a real number. Even once one exists, activation also requires a provider selection, credentials and an entitlement. | Every environment |
| `LIVE_RECORDING_APPROVED` | Satisfies the operational-approval gate in the five-gate recording conjunction (`apps/api/src/lib/telephony/recordingGates.ts`). The other four gates — `grow.calling.recording` entitlement, legal policy, consent/disclosure, adapter capability — must all pass independently, so this flag alone never enables recording. | Every environment |

Webhook/ingress pairs — each is fail-closed and requires **both** the enable flag and a secret, so
leaving either blank keeps the ingress closed:

| Pair | What enabling it would accept |
|---|---|
| `AML_WEBHOOKS_ENABLED` + `AML_WEBHOOK_SECRET` | Inbound AML provider callbacks that mutate AML, billing, workflow and event state. |
| `MANDATE_PAYMENT_WEBHOOKS_ENABLED` + `MANDATE_PAYMENT_WEBHOOK_SECRET` | Inbound mandate/direct-debit payment lifecycle callbacks. |
| `COMMUNICATIONS_WEBHOOK_INGRESS_ENABLED` + `COMMUNICATIONS_WEBHOOK_SECRET` | Inbound communications delivery/status callbacks. |
| `GROW_CALLS_WEBHOOK_INGRESS_ENABLED` + `GROW_CALLS_WEBHOOK_SECRET` | Simulated sandbox call-lifecycle events; no live external provider integration exists here. |

Signature verification on any of these is not proof of durable byte ingestion, checksum
verification, or artifact provenance — treat enabling an ingress as its own reviewed change.

## 6. Migrate the database — once, before first boot, and again after any schema change

**Never let the application boot itself run migrations automatically.** The database steps run in
this order, as their own explicit steps, against the pilot's `DATABASE_URL`.

### 6.1 Pre-flight check — run this before `db:migrate`, every time, on every persistent database

```
DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/db run db:preflight
```

`packages/db/scripts/preflight-migrations.mjs` checks the preconditions for the migrations that
can only fail against a database that already holds rows — `0020` (INFERRED consent rows must
carry complete reviewed evidence), `0022` (every document is either property-backed or logically
owned), `0024` (one transcription per call session + recording reference), and `0025` (one open
`CREATE_GROW_COMMITMENT` proposal per brokerage + resource).

- It is **read-only**: it opens one connection, runs `select` counts, and changes nothing. It is
  safe to run against a live database at any time.
- It prints `OK` / `SKIP` / `FAIL` per check, plus the remedy for each failure.
- It exits **non-zero** if any check would block (`1`), or if it could not run at all — no
  `DATABASE_URL`, or a connection/query error (`2`).
- A non-zero exit means **do not run `db:migrate`**. Fix the offending data first; the point of
  this step is that the data problem is found and resolved deliberately, not discovered halfway
  through a deployment.

Run it on staging and on the pilot database separately — passing on one says nothing about the
other, because it is checking rows, not schema.

### 6.2 Set the database default time zone to UTC, and verify it

Every timestamp column in this schema is `timestamp without time zone` holding UTC. Anything the
**database** computes (`defaultNow()`, `now()`, `CURRENT_TIMESTAMP`, SQL interval cut-offs)
evaluates in the **session** `TimeZone`, so a non-UTC session silently shifts entitlement windows,
cut-offs and retention clocks by the UTC offset with no error anywhere.

```
psql "$DATABASE_URL" -c "ALTER DATABASE \"<database name>\" SET timezone TO 'UTC';"
# reconnect, then confirm:
psql "$DATABASE_URL" -c "SHOW TimeZone;"
```

`SHOW TimeZone` must report `UTC` (or an equivalent zero-offset, no-DST name — the check in
`apps/api/src/lib/dbTimezone.ts` accepts `Etc/UTC`, `GMT`, `Zulu` and similar, case-insensitively).

Independently of the database default, `packages/db/src/index.ts` runs `SET TIME ZONE 'UTC'` on
every new pool connection, in pg-pool's awaited `onConnect` hook; a connection whose `SET` fails is
discarded rather than handed to a caller. Leave `DB_SET_SESSION_TIMEZONE` **unset**. Set it to the
literal string `false` only for a connection pooler that rejects or discards session `SET`s — and
in that case the database default above is the only thing keeping timestamps correct, so it is
mandatory rather than belt-and-braces.

**Production startup check.** `apps/api/src/index.ts` calls `assertDatabaseSessionTimezoneUtc()`
before it accepts traffic. In production it **refuses to start** if the effective session time zone
is not UTC, or if it could not verify the setting at all; outside production it logs a
`database_session_timezone_not_utc` warning and continues. It additionally logs
`database_default_timezone_not_utc` — a warning, never a failure — when sessions are UTC only
because of the connect-time `SET` while the database default is something else, which is correct
today but one pooler change away from silent drift. Setting the database default clears that
warning.

### 6.3 Apply the migrations

```
DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/db run db:migrate
```

Confirm it reports success with no errors before proceeding. This is idempotent — safe to re-run
if a later deploy adds new migrations, and a no-op if there is nothing new to apply.

### 6.4 Push-managed databases must be baselined before readiness passes in production

`GET /api/health/ready` now also compares drizzle's own `drizzle.__drizzle_migrations` bookkeeping
table against the migration journal embedded in the build (`apps/api/src/routes/health.ts`,
`EXPECTED_MIGRATIONS` in `packages/db/src/index.ts`):

- **Behind** — the table has at least one row but fewer than expected, or its newest row predates
  the build's newest migration: readiness is `unavailable` (503) in **every** environment.
- **Untracked** — the table is missing or empty, which is what a `drizzle-kit push`-managed
  database looks like: readiness is `unavailable` (503) in **production**; outside production the
  instance stays ready, the `/ready` body carries
  `"migrations": "untracked (push-managed database)"`, and a
  `readiness_migrations_untracked` warning is logged once per process.

So a database whose schema was created with `drizzle-kit push` will never pass readiness in
production until it has completed the documented baseline procedure — inspect that the live schema
matches `packages/db/migrations/0000_baseline_schema.sql`, then record that baseline migration as
applied, per `docs/foundation-remediation/F3_BUILD_SAFETY_AND_MIGRATIONS.md` ("Baseline procedure
required for the existing staging database"). Do not work around this by disabling the check;
readiness failing here means the schema this build expects has not been provably applied.

## 7. Bootstrap the first Brokerage Administrator

A brand-new pilot database has zero users, so nothing can invite the first admin — invitations
are always issued **by** an existing admin. This one-time script is the deliberate exception (see
`apps/api/src/scripts/bootstrapAdmin.ts`'s own header comment and
`docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md` §7):

```
DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/api run bootstrap-admin -- \
  --email admin@youragency.com.au --brokerage "Your Agency Name"
```

It prompts for a password interactively (never accepted as a CLI argument — never lands in shell
history or a process list). It refuses to run with no flags, refuses to overwrite an existing
user or a brokerage that already has a user, and enforces the same password policy as every other
account-creation path. Run this once per pilot brokerage, before that brokerage's admin needs to
sign in.

## 8. Configure and prepare the Replit deployment

A `[deployment]` section has already been added to `.replit` by this readiness pass:

```
[deployment]
deploymentTarget = "autoscale"
build = ["sh", "-c", "pnpm install --frozen-lockfile && pnpm --filter @aee/web run build && pnpm --filter @aee/api run build"]
run = ["sh", "-c", "node apps/api/dist/index.mjs"]
```

This is configuration only — it does not deploy anything by itself. To actually prepare (but not
yet publish) the deployment:

1. In the Replit UI, open the Deployments pane for this Repl.
2. Confirm the deployment target with the Project Owner **before** publishing. The `[deployment]`
   section currently in `.replit` names `autoscale`; §11 sets out why this application needs a
   single, always-on instance instead, and why scale-to-zero or more than one replica changes its
   behaviour. Treat the target as a deployment-configuration decision to be confirmed, not a
   cost/latency preference — and do not change `.replit` as part of following this runbook.
3. Set every Secret from §3 in the deployment's own Secrets (Replit deployments have their own
   Secrets store, separate from the Repl's development Secrets — confirm both are set correctly
   and do not assume one implies the other).
4. Run a build (per the deployment UI) and confirm it completes cleanly.
5. **Do not click "Deploy" / do not publish it yet.** Complete §§6–7 (migration, admin bootstrap)
   against the pilot database first — ideally from the Repl's own shell, using the same
   `DATABASE_URL` the deployment will use, so the schema and first admin already exist the moment
   the deployment starts accepting traffic.
6. Once the renewed gate decision authorises proceeding, publish the deployment, then immediately
   verify per §9 before telling anyone the URL.

## 9. Post-deploy verification (every deploy, not just the first)

```
curl https://<your-deployment-url>/api/health/live
curl https://<your-deployment-url>/api/health/ready
curl -I https://<your-deployment-url>/
```

Expect: `{"status":"ok",...}` from both health endpoints, and a `200` with
`content-type: text/html` from the root (confirms the built frontend is being served — see
`docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md` §4 for the full local verification this
mirrors).

If `/api/health/ready` returns `503 unavailable`, do not proceed — read the `reasons` array in the
response body rather than assuming a database outage. It distinguishes, among others:

| `reasons` entry | What it means |
|---|---|
| `database unreachable` | The `select 1` probe failed — check `DATABASE_URL` first. |
| `database migration status unavailable` | The bookkeeping table could not be read at all. |
| `database migrations not fully applied (N of M recorded)` | This build is ahead of the database — run §6.3. |
| `database migrations untracked: ... (production requires db:migrate)` | Push-managed database, never baselined — see §6.4. |
| `startup task failed: <name>` | A readiness-tracked boot task (entitlement catalogue seed, `run.access` backfill, Stage 2 workflow catalogue seed) failed; it was already logged and alerted at failure time. |
| `document storage unreachable` | The S3 bucket configured in §3.3 is not reachable or not writable. |

A `200` with `"status": "degraded"` means a dependency check succeeded but exceeded the 500 ms
threshold — keep routing traffic, but treat it as a signal worth investigating. A `200` carrying
`"migrations": "untracked (push-managed database)"` can only occur outside production; seeing it
means `NODE_ENV` is not `production`.

Sign in as the bootstrapped admin (§7), confirm `/settings/users` loads, and send yourself a test
invitation to a second address you control, to confirm the full loop (§5's hand-delivery process)
before ever inviting a real participant.

## 10. Rollback

Replit deployments keep prior build artifacts; use the deployment UI's own rollback/redeploy
mechanism to return to a previous build if a new one misbehaves. Because migrations (§6) are run
as an explicit, separate step — never automatically on boot — a rollback to an older application
build does not itself undo a schema migration; if a deploy that included a new migration needs to
be rolled back, treat the database migration and the application rollback as two separate
decisions, and consult `docs/BACKUP_AND_RESTORE_RUNBOOK.md` if a schema rollback is genuinely
needed.

## 10.1 Proxy trust (`TRUST_PROXY`) — required behind a load balancer

Rate limiting identifies a client by `req.ip`. Express trusts no proxy by default, so when the
API is reached through a load balancer or reverse proxy (any Replit deployment is), every
request appears to come from the balancer and **the whole user base shares one rate-limit
budget** — the first users to sign in can exhaust it for everyone else.

- Set `TRUST_PROXY` to the number of proxy hops in front of the API — normally `TRUST_PROXY=1`.
- Leave it unset (or `false`) only when clients reach the API directly.
- Do not set `true` unless every hop is trusted: a client can then spoof `X-Forwarded-For` and
  bypass rate limiting entirely. `express-rate-limit` deliberately warns about that value.
- Unset, empty, `false` and unparseable values all fail safe to trusting nothing, which is the
  behaviour before this setting existed. The effective value is logged once at boot as
  `trust_proxy_configured` (or `trust_proxy_invalid_value_ignored`) — confirm it in the boot log
  after deploying.

## 11. Operations: the API must run as a single, always-on instance

This is a **deployment configuration requirement to confirm with the Project Owner**, not a
preference. It follows from what is in the code today; it is not a statement that any particular
hosting plan has been approved or purchased.

**Why one instance.** Several pieces of recurring work run *inside* the API process, started at
boot from `apps/api/src/index.ts`, each on a plain `setInterval` whose handle is `.unref()`'d:

- the Exception & Risk scan (`lib/exceptions/bootstrap.ts`, every 15 minutes);
- the communications outbox sweep (`lib/communications/bootstrap.ts`, every 60 seconds);
- the financial and integrations outbox sweeps (`lib/financial/bootstrap.ts`,
  `lib/integrations/bootstrap.ts`);
- the document-storage reconciler (`lib/documentStorageReconciler.ts`);
- the call-transcription reconciler (`lib/telephony/callTranscriptionReconciler.ts`);
- the stuck-`EXECUTING` AI action sweep, which has no scheduler of its own and instead piggybacks
  on the automation engine's per-event processing, at most once per five minutes **per process**
  (`lib/automation/engine.ts`, `sweepStuckAiActionRequestsIfDue()`).

Two consequences follow:

- **Scale-to-zero stops them.** An instance that is suspended between requests runs no sweeps at
  all: deferred messages are not dispatched, abandoned transcriptions and pending document
  versions are never reconciled, stale `EXECUTING` AI actions are never recovered, and no
  time-driven exception is ever raised. Nothing errors — the work simply does not happen, and the
  first symptom is usually a stuck record noticed by a participant.
- **More than one instance is not safe for all of this work.** The Exception & Risk scan does hold
  a Postgres advisory lock for single-flight (`lib/exceptions/engine.ts`), so it is the one
  exception. The reconcilers guard overlap with a module-level `running` flag and carry their
  batch cursor in a module-level `nextCursor`, both per-process; the stuck-action sweep throttle
  is a per-process timestamp. Two replicas each keep their own copies and sweep independently.
- **Per-process rate limiters and alert cooldowns multiply.** The global and `/auth`
  `express-rate-limit` limiters in `middlewares/rateLimit.ts` use the default in-memory store
  (300 and 20 requests/minute per IP), `lib/ai/growRateLimiter.ts` (20/minute per brokerage) and
  `lib/ai/voice/voiceRateLimiter.ts` hold their counters in module-level maps, and
  `lib/operationalAlerts.ts` deduplicates by a `dedupKey` in an in-memory `Map` bounded by
  `OPERATIONAL_ALERTS_COOLDOWN_SECONDS`. With N instances the effective request allowance is
  roughly N times the documented limit, every counter resets on every restart or redeploy, and the
  same condition can page N times inside one cooldown window.

**What to confirm with the Project Owner**, before publishing: that the deployment runs as a
single, always-on instance with no scale-to-zero and no horizontal replicas, and that the
consequences above are accepted for the duration of the pilot. If the answer is more than one
instance, the schedulers and limiters need a shared coordination mechanism first — that is
engineering work, not a configuration change.

### 11.1 Restart behaviour the deployment supervisor must provide

`installProcessSafetyHandlers()` (`apps/api/src/lib/processSafety.ts`) is the very first thing
`apps/api/src/index.ts` runs, and it splits the two failure modes deliberately:

- **Unhandled promise rejection** — logged as `process_unhandled_rejection` and dispatched as an
  operational alert; **the process stays alive**. Installing this listener opts out of Node's
  default (since v15) of crashing, so one failed background task does not become an outage for
  every participant. These alerts must be treated as real defects even though nothing restarted.
- **Uncaught exception** — logged as `process_uncaught_exception`, alerted, then the process
  **exits with code 1** after a bounded grace period (about 2 seconds, so the alert has a chance to
  be delivered; a hung alert transport cannot keep the process alive past it).

The second behaviour assumes the deployment **restarts the process automatically** on a non-zero
exit. Confirm that the chosen deployment target does so — with the always-on, single-instance
configuration above, an exit that is not followed by a restart is a full outage, and every
in-process scheduler in §11 stops with it.

## 12. Grow pilot: entitlements and the calling surface

Entitlements are granted **per brokerage** (the catalogue lives in
`apps/api/src/lib/billing/catalogue.ts`; routes enforce them via `requireEntitlement(...)`).
Granting a key is what makes the corresponding surface reachable for that brokerage's users — it is
a per-brokerage product decision, not part of deploying the build.

Three keys govern the calling/transcription/follow-up surface:

| Entitlement key | What granting it enables |
|---|---|
| `grow.calling.access` | Call session lifecycle (create/confirm/cancel), contact call-eligibility checks, and the recording disclosure/confirm/decline steps. |
| `grow.calling.recording` | Capturing, granting and withdrawing call-recording consent, and access to recording artifacts. Also one of the five gates in the recording conjunction (§5.1). |
| `grow.calling.transcription` | Transcribing a consented recording, reviewing and editing the draft summary, and proposing governed follow-ups from approved items (`routes/growCallFollowups.ts` requires it too). |

**Recommendation for a pilot: leave all three ungranted unless the Project Owner decides
otherwise.** The reason is a product gap, not a deployment defect, and it is worth stating
precisely because the gap is *not* in the data model.

The schema and the evaluation logic are both present: `packages/db/src/schema/consentControls.ts`
defines `grow_contact_dncr_statuses` (`CLEARED` / `LISTED` / `UNKNOWN` / `NOT_CHECKED`), versioned
consent-policy rows, and per-channel contact consents, and
`apps/api/src/lib/consentControls.ts` evaluates them into outcomes such as
`NO_VALID_DNCR_CLEARED_CONSENT`, `DNCR_LISTED` and `DNCR_STATUS_UNKNOWN`, which the eligibility
endpoint surfaces as a "Do Not Call check required" review state.

What is missing is any way to *populate* them:

- `recordDncrStatus()` / `recordDncrObservation()` and `recordConsentPolicy()` in
  `apps/api/src/lib/consentControlsPersistence.ts` have **no production caller** — no HTTP route,
  no CLI script in `apps/api/src/scripts/`, no scheduled job. Only tests call them.
- The call-recording consent endpoints that do exist (`POST /grow/calls/:id/consent`,
  `POST /grow/calls/contacts/:partyId/consent`, `POST /grow/calls/consent/:consentId/withdraw`)
  are not called from anywhere in `apps/web` — the only consent-related UI is the per-call
  disclosure/confirm/decline flow in `apps/web/src/pages/Grow.tsx`.

The practical effect is that an agent cannot record "this contact is on the Do Not Call Register",
cannot record a consent policy for the brokerage, and cannot clear a contact that eligibility has
parked in `DNCR_STATUS_UNKNOWN` — so granting `grow.calling.*` puts the obligation to track call
consent and Do Not Call status entirely outside the product, on whatever manual process the
brokerage runs. That is a decision for the Project Owner to make explicitly, with the gap in front
of them, not something a deployment should enable by default.

These entitlements are independent of the `LIVE_*_APPROVED` flags in §5.1: granting them opens the
surface, while those flags stay unset and keep every provider on its sandbox/mock implementation.

## 13. What this runbook does not authorise

Per the AE Project Owner's explicit constraints for this remediation pass: this runbook does not
authorise actually publishing the deployment, inviting any pilot participant, or configuring any
real external-service credential. It exists so that once the renewed gate decision (Phase 12)
says otherwise, deployment is a matter of following the steps above — not inventing them under
time pressure.
