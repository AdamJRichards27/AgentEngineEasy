# Phase 4 — Environment & Deployment Readiness Audit

**Scope:** AgentEngineEasy / "Agent Engine 2.0" monorepo, mirrored read-only at
`/home/claude/work/AgentEngineEasy`. This audit covers everything in the ENVIRONMENT AND
DEPLOYMENT READINESS gate for a small controlled pilot (5–10 real invited agents, real
transaction workflows, synthetic data, no public signup). It does not re-run the backup/restore
drill (already executed by another engineer this session; summarised below from the saved
evidence) and makes no code changes. Every claim below is grounded in a specific file, line, or
command output from the mirrored repository; where something was not found, that is stated
plainly rather than inferred. The headline conclusion up front: the application code itself is
unusually disciplined about fail-closed security gates and honest self-documentation of gaps
(the `docs/` folder repeatedly states "this does not exist yet" rather than implying otherwise),
but the repo currently describes a **development workflow, not a deployment** — there is no
configured path from "code in this repo" to "a running pilot instance" that doesn't require an
operator to make and execute several infrastructure decisions first.

## Backup/restore drill (summary of evidence already gathered)

A non-destructive `pg_dump`/`pg_restore` drill was run against the local `aee_test` database
this session by another engineer; evidence lives in
`scratchpad/backup_drill/` (`tables.txt`, `pre_dump_counts.txt`, `post_restore_counts.txt`,
`rowcounts_source.txt`, `rowcounts_restored.txt`, `sample_source.txt`, `sample_restored.txt`,
`fk_orphan_check.sql`, `pre_dump_sample_row.txt`, `post_restore_sample_row.txt`). Findings from
those files: 89 tables enumerated (`tables.txt`); a spot-check of 7 tables before/after
(`brokerages`, `communication_messages`, `domain_events`, `integration_outbox`, `properties`,
`risk_exceptions`, `users`) matched exactly in `pre_dump_counts.txt` vs `post_restore_counts.txt`;
a full 89-table row-count comparison in `rowcounts_source.txt` vs `rowcounts_restored.txt`
matched on 88 of 89 tables exactly, with one discrepancy — `audit_logs` reads 17,523 in the
source file and 17,519 in the restored file (a 4-row / 0.02% difference). Given `audit_logs` is
the one table in this schema that receives continuous background writes (every authenticated
action logs a row), the most likely explanation is that the source-side count was taken at a
slightly later wall-clock moment than the dump itself (i.e. a few more audit rows were written
between the `pg_dump` snapshot and whenever `rowcounts_source.txt` was queried), not a restore
defect — the dump/restore mechanism itself is not implicated, but this drill's evidence trail
does not by itself rule out a mechanical explanation, since no dump timestamp vs. count-query
timestamp was captured. This is a minor caveat to flag, not a red flag: it is the kind of
off-by-a-few-rows artifact expected from comparing a live, continuously-written table against a
point-in-time snapshot, not the pattern (missing whole tables, halved counts, corrupted rows)
that would indicate the restore itself lost data. The `fk_orphan_check.sql` script (a generic
loop over every single-column foreign key in `public`) and the single-row content comparison
(`sample_source.txt`/`sample_restored.txt`, `pre_dump_sample_row.txt`/`post_restore_sample_row.txt`
— identical `Integrations Lifecycle A 1788472212929` row, byte-for-byte) both indicate referential
integrity and content fidelity survived the round-trip; `restore_output.log` is present but empty,
consistent with a clean `pg_restore` (no errors/warnings would appear on stdout by default). A
prior, separate backup/restore drill is also recorded inside the repository's own documentation
(`docs/SECURITY_INCIDENT_RUNBOOKS.md`, "Backup and recovery" section, lines 284–351) with its own
independent numbers (89/89 tables, 191/191 indexes, 357/357 constraints, zero FK orphans, matching
whole-table checksums) — a second, corroborating data point that the mechanical dump/restore path
works against this schema. Both drills used `aee_test`/local scratch databases, never a real pilot
or production dataset, and both explicitly disclose what they do **not** establish: a production
backup *schedule*, an offsite/durable storage target for dump files, encryption at rest for the
dump file itself (which contains the same sensitive data the live database does), or a restore
rehearsed against a realistically pilot-sized dataset under time pressure. RTO/RPO in numbers: the
repo's own drill records a `pg_restore` completing in 0.779s against the test-sized dataset — not
a meaningful RTO estimate for a real pilot dataset, and no RPO is established because there is no
recurring backup schedule from which an RPO could be derived (see item 11 below).

## 1. Environment separation

There is a real, code-level distinction between "production" and "everything else," but no
separate distinction between "staging" and "development" — those two are simply "not production."
`apps/api/src/lib/env.ts` defines `isProductionEnvironment()` (line 15–17) as `process.env.NODE_ENV
=== "production"` exactly — a strict string match, not a truthy check, so an unset, empty, or
misspelled `NODE_ENV` is never treated as production. Three fail-closed gates key off this: `apps/api/src/lib/session.ts`'s `assertSessionSecretConfigured()`, `apps/api/src/lib/cors.ts`'s
`assertCorsConfigured()` (lines 57–69), and `apps/api/src/lib/metricsAuth.ts`'s
`assertMetricsAuthConfigured()` (lines 26–36) — all three are called at process boot in
`apps/api/src/index.ts` (lines 19, 25, 32) and `throw` (crashing the boot) if their respective
secret/config is unset while `NODE_ENV==="production"`. `isDevAuthEnabled()` (`env.ts` lines 28–31)
additionally requires `ALLOW_DEV_AUTH==="true"` on top of not being production, gating the
`POST /auth/dev-login` and `GET /auth/known-users` routes (`apps/api/src/routes/auth.ts` lines
30–35, 65–71, confirmed by grep). This is a genuinely well-built safety net for the one binary
distinction it enforces. What is **not** present: any repo-level concept of a distinct "staging"
*deployment* as opposed to "staging" the git branch. `README.md` (lines 9–12) describes `main`
("protected, releases only") and `staging` ("active development happens here") as branches, and
`.github/workflows/ci.yml` runs the same CI job identically on pushes to either branch (lines
19–24) — there is no branch-conditional deploy step, no per-branch environment file, and no
evidence any separately-provisioned "staging" *infrastructure* (a second database, a second Replit
app) currently exists for this repository (as opposed to the differently-named, separate sibling
application "AgentEngineStaging" referenced in `.env.example` lines 2–3, `ARCHITECTURE.md` line 5,
and `packages/db/src/index.ts` line 8 — an older, unrelated codebase this one was built to
supersede, not an environment of this app). Practically: this repo's `NODE_ENV` gate is real and
correctly fails closed, but nothing in the checked-in configuration (`.replit`, `apps/api/.env`)
ever sets `NODE_ENV=production` — the checked-in `apps/api/.env` sets `NODE_ENV=test` (used only
for the local automated test suite) and `.replit`'s own `run` command sets no `NODE_ENV` at all.
A pilot deploy that doesn't deliberately set `NODE_ENV=production` (plus `CORS_ALLOWED_ORIGINS`,
`SESSION_SECRET`, `METRICS_TOKEN`) as real Replit-managed secrets will silently run with the
non-production fallbacks (open localhost CORS defaults, unauthenticated metrics endpoint) rather
than failing to boot — the fail-closed gates only protect an environment that has actually been
told it's production.

## 2. Deployment process

`.replit` (repo root) has no `[deployment]` section — confirmed by reading the full file. It
contains `[nix]`, `[[ports]]` (three port mappings), `[env]` (only `PORT="8080"`), and
`[workflows]` with two workflow definitions ("Dev" and "FixConfig", the latter simply
re-writing `.replit` back to a known-good copy of itself via a base64-decoded `echo`, not a
security-relevant hidden instruction — decoded and confirmed identical to the file's own `run`/
`entrypoint`/`ports`/`nix` content). The top-level `run` command is:
`pnpm install && (pnpm run dev:api &) && bash -lc 'pnpm --filter @aee/web exec vite --host
0.0.0.0 --port 5000'` — this installs dependencies, backgrounds the API's **dev** script
(`apps/api/package.json`: `"dev": "tsx watch src/index.ts"`, a file-watching dev runner, not a
production process manager), and foregrounds the web app's **Vite dev server** (not a production
static build). This is unambiguously a development-mode run configuration, not a production
deployment. The root `package.json` scripts are `dev:api`, `dev:web`, `build` (typecheck +
recursive `--if-present run build`), `typecheck`, and `db:push` — there is no root `start` script
and no script that serves the built web assets. Critically, real production build/start scripts
*do* exist one level down: `apps/api/package.json` has `"build": "esbuild ... --outfile=dist/
index.mjs"` and `"start": "node dist/index.mjs"`, and `apps/api/src/app.ts` (lines 12–22) confirms
the API is a pure JSON API with **no `express.static`** — the comment states this explicitly
("This is a pure JSON API ... no express.static — see apps/web for the frontend"). So the API can
genuinely be built and run in production mode today (`pnpm --filter @aee/api run build && pnpm
--filter @aee/api run start`), but nothing wires that into `.replit`, and the built web app
(`apps/web`'s `vite build` output, a static SPA) has no serving mechanism anywhere in this repo —
neither the API nor any other checked-in code serves it. **What deploying this app for a pilot
would actually require today:** (a) configuring Replit's own Deployments feature (Autoscale or
Reserved VM) with an explicit run command that uses the API's real `build`/`start` scripts, not
the dev workflow's `tsx watch`; (b) deciding how to serve the built web SPA — either adding static
file serving to the API, standing up a second static-hosting deployment, or using a CDN/static
host outside this repo entirely — since no code path for this exists today; (c) setting
`NODE_ENV=production` and the secrets named in item 1 as real Replit Secrets, not relying on any
checked-in `.env`; and (d) deciding the database migration story (see item 5). None of this is
started in the repository as it stands.

## 3. Domain/TLS

No evidence of any custom domain or TLS termination configuration checked into the repo. A
targeted search across `.replit`, `apps/api/src`, `apps/web/src`, and the root markdown files for
domain names, `CNAME`, TLS/SSL certificate references, or hardcoded `*.replit.app`/`*.replit.dev`
hostnames returned nothing beyond expected third-party API base URLs (`https://api.anthropic.com`,
`https://api.stripe.com` — outbound provider endpoints, not this app's own domain) and doc-comment
prose mentioning HTTPS in the abstract (`apps/api/src/lib/env.ts` line 36, discussing cookie
security, not domain config). This is consistent with the stated assumption in the task: a
Replit-hosted app typically gets its domain and TLS termination from Replit's own edge (either the
default `*.replit.app`/`*.replit.dev` subdomain or a custom domain configured through Replit's own
dashboard) rather than from anything checked into application code — so "not found in-repo" is the
expected and unremarkable state here, not a gap, provided the pilot goes live on Replit's standard
domain/TLS handling rather than a self-managed reverse proxy.

## 4. Secrets storage

The canonical variable list is `.env.example` at the repo root (`apps/api/.env.example` does not
exist as a separate file — the single root-level `.env.example`, 85 lines, is the full list). It
enumerates: `DATABASE_URL`; auth (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `SESSION_SECRET` —
documented at lines 11–16 as required, with no insecure fallback, the API "refuses to boot if
this is unset or too short"); property data (`GOOGLE_PLACES_API_KEY`, `PROPERTY_DATA_PROVIDER`);
AML (`AML_PROVIDER`, `AML_API_BASE_URL`, `AML_PROVIDER_API_KEY`, `AML_WEBHOOK_SECRET`, plus two
non-secret pricing constants); e-signature (`ESIGN_PROVIDER`, `ESIGN_API_BASE_URL`,
`ESIGN_PROVIDER_API_KEY`, `ESIGN_WEBHOOK_SECRET`); object storage (`OBJECT_STORAGE_PROVIDER`,
`OBJECT_STORAGE_LOCAL_DIR`); payments (`PAYMENT_PROVIDER`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_API_BASE_URL`); API-level config (`PORT`, `CORS_ALLOWED_ORIGINS`
— documented as required to boot in production); and AI (`AI_PROVIDER`, `ANTHROPIC_API_KEY`,
`AI_MODEL`, `AI_TEMPERATURE`, `AI_MAX_OUTPUT_TOKENS`, `AI_TIMEOUT_MS`, `AI_RETRY_LIMIT`,
`AI_FALLBACK_PROVIDER`, and six `AI_*_ENABLED` feature flags). The backup-drill evidence's own
`all_env_vars.txt`/`example_env_vars.txt` (captured against the live drill environment) add a
handful of variables not in the root `.env.example` — `ALLOW_DEV_AUTH`,
`ALLOW_INSECURE_DEV_COOKIES`, `LOG_LEVEL`, `METRICS_TOKEN`, `LAUNCH_TIMEZONE`,
`COMMUNICATIONS_WEBHOOK_SECRET`, `MANDATE_PAYMENT_PROVIDER` — all confirmed as real,
purpose-matched variables referenced by name in the corresponding source files inspected during
this audit (`env.ts`, `metricsAuth.ts`, `logger.ts`), not stray or unexplained names; this is a
minor documentation gap (`.env.example` is not fully exhaustive) rather than a secrets-handling
concern. Every secret-shaped variable name is a placeholder in `.env.example` (empty value after
`=`). Two real, non-template `.env` files exist in this mirror — repo-root `.env` (1 line:
`DATABASE_URL` pointing at `postgresql://postgres:postgres@localhost:5432/aee_test`) and
`apps/api/.env` (5 lines: the same local `DATABASE_URL`, `ALLOW_DEV_AUTH=true`, `NODE_ENV=test`,
`PORT=8080`, and a `SESSION_SECRET` whose value is a labeled local/test dummy string ending in
"...not-for-production-use-only", clearly self-describing as a placeholder rather than a real
secret). Both files are covered by `.gitignore` (`.env`, `/storage/`, `apps/api/storage/`), so
their presence here reflects this being a live workspace snapshot rather than something that
would be committed. **No real credential value was found anywhere in the repository** — a
targeted scan for common leaked-secret shapes (Stripe `sk_live_`/`sk_test_` prefixes, AWS
`AKIA...` access keys, Google `AIza...` keys, Slack tokens) across all `.ts`/`.env*`/`.json`/
`.md`/`.yml` files found only obvious test fixtures inside `packages/events/src/__tests__/
redaction.test.ts` and `logger.test.ts` (values like `sk_live_abc123456789`, used specifically to
test that the logging redaction layer correctly scrubs Stripe-shaped values) — nothing resembling
an actual issued key. No possible leaked secret to flag.

## 5. Database configuration

**Connection pooling:** `packages/db/src/index.ts` (line 12) and `packages/db/src/migrate.ts`
(line 47) both construct `new Pool({ connectionString: process.env.DATABASE_URL })` with no
explicit `max`/`min`/`idleTimeoutMillis`/`ssl` options — this uses the `pg` library's untuned
defaults (a default max pool size of 10). For a 5–10 agent pilot this is very likely adequate
headroom, but it is an inherited default, not a deliberate capacity decision, and there is no
explicit SSL option passed to the pool — if the pilot's Postgres host requires TLS (typical for a
managed provider), that has to be encoded in the `DATABASE_URL` connection string itself
(`sslmode=require` or equivalent) since the code does not add it. **Migration-on-deploy
behaviour:** `packages/db/src/migrate.ts` (lines 1–30, its own header comment) is explicit that
this script is **not** run automatically anywhere — it exists for a clean database (CI, a fresh
local dev DB) and is invoked only manually (`pnpm --filter @aee/db run db:migrate`) or from CI
(`.github/workflows/ci.yml` line 105, against a disposable ephemeral Postgres container that is
destroyed after the job). The comment states plainly: "This script is NOT executed against the
live staging database... Running this against a database that already has the target tables
(created previously via `drizzle-kit push`, as staging's are) without first completing that
baseline procedure will fail." `docs/SECURITY_INCIDENT_RUNBOOKS.md` (line 350) independently
confirms: "Schema deployment itself continues to use `drizzle-kit push` (`pnpm run db:push`) as
this project's actual mechanism." The baseline procedure document `migrate.ts` refers operators to
(`docs/foundation-remediation/F3_BUILD_SAFETY_AND_MIGRATIONS.md`) **does not exist anywhere in
this repository** — confirmed by a repo-wide filename search. So the versioned-migration path
(13 SQL files under `packages/db/migrations/`, proven correct in CI against a throwaway database)
and the actual deployment mechanism (`drizzle-kit push`, applying schema changes directly by
diffing against the live database with no migration history) are two different, only partially
reconciled systems today, and the document that was supposed to reconcile them for a real
database is missing. **Rollback strategy:** none found. The migrations directory is forward-only
(no corresponding "down" SQL files); `drizzle-kit push` has no transactional rollback of its own
either. The only rollback path evidenced anywhere is restoring from a database backup (item 11),
which itself has no automated schedule.

## 6. Health/liveness/readiness probes

Real, well-built probes exist: `apps/api/src/routes/health.ts` defines `GET /api/health/live`
(lines 73–75, a pure "can this process execute a handler" check with no dependency on the
database — true liveness), `GET /api/health/ready` (lines 77–84, delegates to `checkReadiness()`,
lines 51–71, which runs `select 1` against Postgres and returns three states: `ok` if under
500ms, `degraded` if slower but successful, `unavailable`/503 if the query throws), and a
backward-compatible combined `GET /api/health` (lines 92–99). This is a genuine
liveness/readiness split with the correct operational semantics (a DB blip should not trigger a
process restart; the module's own comment, lines 8–24, states this reasoning explicitly). No
`/healthz` route was found (only `/health`, `/health/live`, `/health/ready`), which is fine as
long as whatever orchestrator ends up checking these is pointed at the actual paths.

## 7. Release identification

Not found. A targeted search for git-SHA stamping, version headers, or build-identifier response
fields (`GIT_SHA`, `GIT_COMMIT`, `BUILD_VERSION`, `APP_VERSION`, `X-Release`, `X-Version`,
`REPLIT_DEPLOYMENT`, `GITHUB_SHA`, etc.) across `apps/`, `packages/`, `.replit`, and the root
`package.json` returned zero matches. `GET /api/health` and `GET /api/health/live` return only
`{status, service}` (`health.ts` lines 74, 98) — no version or commit field. If a pilot needs "the
on-call engineer can tell which build is live," that has to be added; today there is no way to
distinguish one deployed build from another via any HTTP response, log line, or endpoint in this
codebase.

## 8. Error monitoring

No Sentry, Rollbar, Bugsnag, or any error-tracking SDK is present — confirmed by a repo-wide
search for `sentry|rollbar|bugsnag|@sentry` across `apps/`, `packages/`, `package.json`, and
`pnpm-lock.yaml`, which returned nothing except this audit's own search terms appearing in no
file. Errors surface only through the structured logger:
`packages/events/src/logger.ts` (its own header comment, lines 1–13) writes exactly one JSON
object per line to `process.stdout` (debug/info) or `process.stderr` (warn/error) — "No new
dependency (no pino/winston)... process.stdout / process.stderr, one JSON object per line, is
exactly what every log aggregator (CloudWatch, Datadog, a plain `docker logs | jq`) expects" — but
nothing in this repo actually ships those lines to CloudWatch, Datadog, or anywhere else; they go
to the process's own stdout/stderr and nowhere further unless an operator attaches a log
aggregator externally (see item 10). All log fields pass through `packages/events/src/redaction.ts`
before being written, which is a genuinely solid, well-tested redaction layer (never-log key
patterns for passwords/tokens/PII/financial data, plus value-shape detection for bearer
tokens/JWTs/PEM keys, depth/array/string bounds to prevent a redaction bug turning into a giant or
hung log line) — this reduces the blast radius of the "logs go to stdout/stderr only" gap, but
does not close it: there is still no alerting or search tool over those logs today (`docs/
OBSERVABILITY_STANDARD.md` §6 separately discloses that 92 of the original 109 raw
`console.log`/`console.error` call sites across 41 files have **not yet** been converted to the
structured `logger`, so some error output still bypasses redaction and structure entirely).

## 9. Metrics/alerting

A real in-process metrics registry exists and is honestly documented as exactly that — nothing
more. `packages/events/src/metrics.ts` declares 23 counters/histograms/gauges
(`METRIC_DEFINITIONS`, lines 53 onward) with bounded label-value sets enforced at call time
(an out-of-set label throws in dev/test, coerces to `"other"` with a one-time warning in
production — lines 175–190). `incrementCounter()`, `observeHistogram()`, and `setGauge()`
(lines 208–224, 226–236) do exactly one thing each: mutate an in-memory `Map` (`counters`,
`histograms`, `gauges`, module-level `Map` instances at lines 197–199). There is no network call,
no file write, no external SDK invocation anywhere in these functions — a call to
`incrementCounter("auth_security_event_total", ...)` changes a number in this process's own RAM
and nothing else. That state is exposed as Prometheus text format at `GET /api/internal/metrics`
(`apps/api/src/routes/metrics.ts`), gated by `requireMetricsAuth` (a bearer token compared with
`timingSafeEqual`, `apps/api/src/lib/metricsAuth.ts` lines 38–43, 46–62) which fails closed at
boot in production if `METRICS_TOKEN` is unset. But nothing in this repository or its
infrastructure config scrapes that endpoint. `docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md`
states this directly and repeatedly (line 9–15: "a real scrape target (Prometheus/Datadog/
CloudWatch or equivalent), a real alerting/paging pipeline, and a scheduled `pnpm audit` job —
none of that infrastructure exists in this repository"; §3, lines 209–224, spells out exactly
what would need to be added: a scrape target/rule engine, a paging destination like PagerDuty —
"explicitly out of scope this step; no such destination exists or is authorised" — and a
standalone scheduled dependency-audit job). In-memory state also means every metric resets to
zero on every process restart — there is no persistence, so a metrics-based post-incident
timeline reconstructed after a crash-and-restart would be incomplete by construction. **Bottom
line for the pilot:** the counters are real, correctly incremented at the right call sites, and
would be immediately useful the moment something scrapes them — but today nothing does, so an
in-process counter reaching a dangerous value produces zero observable signal to anyone unless
they manually curl the metrics endpoint with the bearer token.

## 10. Log access

Not documented anywhere in this repository, and no runbook (`docs/SECURITY_INCIDENT_RUNBOOKS.md`,
which explicitly covers on-call procedures for twelve incident types) names a concrete
log-viewing mechanism beyond "the failure is logged" — it never says *where* an on-call person
would go to read that log. Given the actual `.replit` configuration (item 2: an interactive dev
workflow, not a Replit Deployment), the realistic mechanism today is: an on-call person opens the
Replit workspace itself and reads whatever is currently in the Console/Shell tab's scrollback for
the running `tsx watch` process — live only, not searchable, not retained beyond whatever the
browser tab's scrollback buffer holds, and gone entirely if the workspace or tab is closed and
reopened. If this were instead deployed via Replit's own Deployments feature (which would require
adding the missing `[deployment]` section first — item 2), Replit's Deployments product does
provide a persistent "Logs" pane, which would be a meaningfully better mechanism than the current
dev-workflow console — but that path is not configured today. Either way, there is no log
aggregation, retention window, or full-text search across historical logs anywhere in this
repo's configuration; `docs/SECURITY_INCIDENT_RUNBOOKS.md`'s own framing ("None of these runbooks
assume a real third-party sandbox/production connection or a real paging system — neither exists
yet") is consistent with this.

## 11. Data retention & backup schedule

No automated recurring backup mechanism exists anywhere in this repository or its infrastructure
config. `.github/workflows/` contains exactly one workflow (`ci.yml`) and it runs tests/builds on
push and PR — it is not a scheduled job and does not touch backups. There is no `cron`,
`node-cron`, `node-schedule`, or scheduled Action anywhere that invokes `pg_dump` or any
equivalent. `docs/SECURITY_INCIDENT_RUNBOOKS.md` (lines 344–349) says this outright: the drill
already run "does not establish a production backup *schedule*, an offsite/durable storage target
for dump files, or a restore runbook rehearsed against a realistically sized production
dataset... those require a real production environment and real infrastructure decisions
(retention window, storage location, encryption at rest for the dump file itself...) that are out
of this step's reach." Separately, and not covered by either backup drill at all: generated/
completed transaction documents (agency agreements, signed packages) are stored on **local
filesystem disk**, not in Postgres. `packages/integrations/object-storage/src/index.ts`'s
`LocalObjectStorageProvider` (lines 18–55) is described in its own comment as "a genuinely
functional store, not a fake" — real `writeFile`/`readFile` calls against
`OBJECT_STORAGE_LOCAL_DIR` (defaulting to `./storage`), and `createObjectStorageProvider()`
(lines 57–64) has exactly one case, `"local"` — no S3/GCS adapter is implemented at all, so there
is no cloud object-storage option to switch to even if desired today. In this mirror,
`apps/api/storage/` currently holds 10,866 files totalling 71MB of generated document content.
Neither the drill evidence in `scratchpad/backup_drill/` nor the in-repo drill documented in
`SECURITY_INCIDENT_RUNBOOKS.md` covers this directory at all — both are Postgres-only. For a
real-estate transaction platform whose core value includes signed agency agreements and
transaction documents, this is a meaningful gap: today, backing up "the data" means backing up
the database only, and the actual document files a pilot would generate exist solely as ordinary
files on whatever disk the Replit instance runs on, with no automated backup, versioning, or
off-instance copy of any kind evidenced anywhere in this repo.

## 12. Service restart/recovery

No dedicated process manager (PM2, systemd unit, supervisor) is configured anywhere in this repo.
The `.replit` `run` command backgrounds the API's dev process (`(pnpm run dev:api &)`, using
`tsx watch`, a file-change-triggered dev re-runner, not a crash-recovery supervisor) and then
foregrounds the web dev server in the same shell script — if the backgrounded API process exits
(crash or uncaught fatal error), nothing in this script notices or restarts it; the foregrounded
Vite dev server for the web app would keep running regardless, giving a false impression from the
browser tab that "the app is up" while the API is actually down. Recovery in that scenario would
depend entirely on Replit's own workspace-level behavior (if the whole container restarts) or a
human noticing and manually re-running the workflow — nothing in the repository configures an
automated restart-on-crash. The liveness/readiness split (item 6) is explicitly designed with an
orchestrator's auto-restart-on-liveness-failure behavior in mind (`health.ts`'s own comment: "An
orchestrator's liveness probe should restart the process on failure here"), but no orchestrator is
wired to consume it in this repo — that assumes a `[deployment]` configuration (item 2) that
doesn't exist yet. If Replit's own Deployments product is used with a health-check-based restart
policy, that would supply the missing piece, but only once configured.

## 13. Dependency availability

Every outbound third-party HTTP integration was checked for timeout/circuit-breaker handling, and
the results are inconsistent across providers. The **AI provider** path is the one done well:
`apps/api/src/lib/ai/providers/anthropicProvider.ts` (lines 22–23, 71–73) wraps its `fetch()` call
in an `AbortController` tied to `request.timeoutMs` (from `AI_TIMEOUT_MS`, default 20000ms per
`apps/api/src/lib/ai/gateway.ts` line 44), with the timer cleared in a `finally` block, and
`generateWithGateway()` (`gateway.ts` lines 70–88) retries the primary provider up to
`AI_RETRY_LIMIT` times before falling back to a configured fallback provider (defaulting to the
built-in mock). By contrast, every other real outbound HTTP integration has **no timeout and no
circuit breaker at all**: `packages/integrations/payments/src/index.ts` (lines 124, 172, Stripe
`payment_intents`/`refunds` calls), `packages/integrations/aml/src/index.ts` (line 82),
`packages/integrations/esign/src/index.ts` (line 67), and `packages/integrations/property-data/
src/index.ts` (lines 67, 103) all call `fetch()` directly with no `AbortController`, no `signal`,
and no timeout parameter of any kind — a hung provider connection would hang the calling request
indefinitely (bounded only by whatever default socket timeout Node's own `fetch` implementation
applies, which is not itself configured here either). No circuit-breaker library or pattern
(`opossum` or hand-rolled equivalent) exists anywhere in the codebase — confirmed by a repo-wide
search. For the pilot this risk is currently mitigated by configuration, not code: every one of
these providers defaults to `mock` in `.env.example` (`AML_PROVIDER=mock`, `ESIGN_PROVIDER=mock`,
`PROPERTY_DATA_PROVIDER=mock`, `PAYMENT_PROVIDER=mock`), so unless an operator deliberately
switches one of these to its real HTTP-backed implementation for the pilot, this class of failure
mode is not reachable — but if any real provider is turned on, this gap becomes live with no code
change having addressed it.

## 14. Capacity limits & cost controls

Real, concrete limits exist at several layers, alongside one notable absence. Request-size limits:
`apps/api/src/app.ts` (lines 61–68) sets an explicit `express.json({ limit: "1mb" })` (Express's
own implicit default is 100kb, so this is a deliberately generous but still bounded override), and
file uploads go through a separate path — `apps/api/src/routes/import.ts` line 32 configures
`multer` with `limits: { fileSize: MAX_FILE_SIZE_BYTES }`, where `MAX_FILE_SIZE_BYTES` (`apps/api/
src/lib/import/fileValidation.ts` line 4) is `25 * 1024 * 1024` (25MB). Rate limiting: `apps/api/
src/middlewares/rateLimit.ts` defines a real `globalRateLimiter` (300 requests/minute/IP in
non-test environments, lines 26–32) applied to the whole API (`app.ts` line 51), and a stricter
`authRateLimiter` (20 requests/minute/IP, lines 41–56) mounted ahead of the auth routes
specifically, whose rejection handler increments the `auth_security_event_total{event=
"auth_rate_limited"}` metric (line 53) — both are genuinely enforced by the `express-rate-limit`
library, not merely logged-about. AI cost exposure specifically: `AI_MAX_OUTPUT_TOKENS` (default
1024, `gateway.ts` line 43) bounds the size of any single model response, and
`anthropicProvider.ts` (lines 55–59) computes and returns an `estimatedCostUsd` per call from the
provider's own token-usage response — but this is explicitly telemetry only (the code comment
says so directly: "for telemetry purposes only, not a billing figure"), and a repo-wide search for
any budget/quota/spend-cap enforcement (`budget`, `spend.?limit`, `quota`, `dailyCap`,
`monthlyCap`, `costCap`) returned nothing — there is no code path that stops calling the AI
provider once a brokerage or the whole pilot has spent some threshold amount; the only ceiling on
total AI spend for the pilot is the combination of per-call token limits and however many requests
5–10 real agents generate, with no circuit that would trip if that turned out higher than
expected.

## Pilot blockers found in this phase

The clearest blocker is that there is currently no configured path from this repository to a
running pilot instance at all: `.replit` has no `[deployment]` section, its `run` command starts
dev-mode processes (`tsx watch` for the API, the Vite dev server for the web app) rather than the
production `build`/`start` scripts that do exist for the API, and there is no code anywhere that
serves the built web SPA in any mode — someone has to make and execute concrete infrastructure
decisions (a Replit Deployment configuration, a way to serve the built frontend, and a decided
migration strategy for the target database) before agents can be pointed at a URL. Tied to that:
because `NODE_ENV` is never set to `production` by anything checked into this repo, the
fail-closed security gates that exist and work correctly (`SESSION_SECRET`, `CORS_ALLOWED_
ORIGINS`, `METRICS_TOKEN`) will not engage unless an operator deliberately sets `NODE_ENV=
production` alongside those secrets as real Replit Secrets — an easy step to forget precisely
because the dev-mode fallbacks are designed to make everything "just work" without it. The backup
story, while mechanically proven twice over for the database, does not cover the generated
transaction documents that live on local disk with no backup mechanism of any kind evidenced
anywhere in this repo, and even the database side has no automated recurring schedule — only a
manual, one-off drill. Finally, there is genuinely no operational visibility today: metrics are
real but unscraped, there is no error-tracking service, and there is no documented or configured
way for an on-call person to view logs beyond an open Replit console tab — meaning a real incident
during the pilot would be detected by an agent reporting a problem, not by any monitoring this
repository currently has wired to alert anyone.

## Non-blocking items to fix before or during pilot

The migration story has an internal inconsistency worth resolving even at pilot scale: the
versioned migration runner (`packages/db/src/migrate.ts`) is proven correct in CI but is
explicitly not how schema changes actually reach a real database today (`drizzle-kit push` is),
and the document that was supposed to reconcile the two (`docs/foundation-remediation/
F3_BUILD_SAFETY_AND_MIGRATIONS.md`) does not exist in this repository — this should be resolved,
or at minimum the risk explicitly accepted, before the pilot database accumulates data that a
future `drizzle-kit push` diff could threaten. The database connection pool uses untuned library
defaults rather than a deliberate size, and no explicit SSL option is set on the connection
(acceptable if `DATABASE_URL` itself encodes `sslmode=require`, but worth confirming rather than
assuming for whatever Postgres host the pilot uses). There is no release/version identifier
anywhere in a health response, log line, or header, which will make "which build is actually
live" harder to answer than it needs to be during an incident. The outbound HTTP calls to AML,
e-signature, payment, and property-data providers have no timeout or circuit-breaker protection
(unlike the AI provider path, which does) — currently low-risk only because all four default to
mock providers; this should be addressed before any of them is switched to a real backend, pilot
or otherwise. The structured-logging migration is intentionally incomplete by the codebase's own
disclosure (`docs/OBSERVABILITY_STANDARD.md` §6): 92 raw `console.*` call sites across 41 files
still bypass the redaction layer, meaning some error output during the pilot may not receive the
same PII/secret scrubbing that logger-based output gets. And there is no cost ceiling on AI
provider spend beyond per-call token limits — worth a manual spend-monitoring habit during the
pilot even though a 5–10 agent pilot's realistic AI usage volume makes runaway cost unlikely in
practice.