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

Leave every other `.env.example`-listed variable (AML, e-sign, payment, property-data provider
credentials, Stripe keys, etc.) **unset**. Unset means each provider factory falls back to its
mock/sandbox implementation — see `docs/INTEGRATION_FALLBACK_MATRIX.md` — which is the required
state for this pilot (§5).

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

## 6. Migrate the database — once, before first boot, and again after any schema change

**Never let the application boot itself run migrations automatically.** Run this explicitly, as
its own step, against the pilot's `DATABASE_URL`:

```
DATABASE_URL="<the pilot's own connection string>" pnpm --filter @aee/db run db:migrate
```

Confirm it reports success with no errors before proceeding. This is idempotent — safe to re-run
if a later deploy adds new migrations, and a no-op if there is nothing new to apply.

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
2. Confirm the deployment target shows `autoscale` (a small always-on Reserved VM deployment is
   an equally valid choice for a 5–10 participant pilot with steady, low traffic — either works
   with the same build/run commands; the choice is an operational cost/latency trade-off, not a
   functional one).
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
mirrors). If `/api/health/ready` reports `unavailable`, do not proceed — the database connection
is not working; check `DATABASE_URL` before doing anything else.

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

## 11. What this runbook does not authorise

Per the AE Project Owner's explicit constraints for this remediation pass: this runbook does not
authorise actually publishing the deployment, inviting any pilot participant, or configuring any
real external-service credential. It exists so that once the renewed gate decision (Phase 12)
says otherwise, deployment is a matter of following the steps above — not inventing them under
time pressure.
