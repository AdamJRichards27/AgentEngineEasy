# Phase 9 — Production-Mode Replit Deployment Readiness Audit

`docs/gate-evidence/PHASE9_DEPLOYMENT_READINESS_AUDIT.md`

**Owner instruction this document implements:** "AE Operational Readiness — Critical Blocker
Remediation," Phase 9: *"Production-mode deployment readiness audit/prep + runbook."* Owner
decision this phase operates under: *"Deployment: prepare a private, production-mode pilot
environment in Replit, but do not deploy or admit users until the gate is rerun and approved."*
**Nothing in this document deploys anything publicly, admits any user, or configures a real
external-service credential.** Every change below was verified locally, against a fresh,
disposable Postgres database, never against any live Replit deployment.

This phase directly follows on from the original gate's blocker **B4** ("No configured path from
this repository to a running pilot instance... no code anywhere serves the built web frontend in
any mode" — `docs/OPERATIONAL_READINESS_GATE_REPORT.md` §5) and closes it, together with two
further gaps this audit discovered while doing so (below).

## 1. B4 — no static-file serving existed anywhere

**Finding, confirmed by direct code reading:** `apps/api/src/app.ts` was, before this phase, a
pure JSON API with no `express.static` call anywhere, and `apps/web` only had a Vite dev server
(`vite`) and a production build command (`vite build`) — nothing in this repository ever served
the built `apps/web/dist` output. `apps/web/src/lib/api.ts`'s `apiFetch()` calls
`fetch(\`/api${path}\`, ...)` — a **path-relative** URL, which only resolves to this API correctly
when the built frontend and this API are served from the **same origin**; there is no
configurable API base URL anywhere in the frontend.

**Decision made by this phase (the original gate explicitly left this as an open architecture
choice — "API-served static vs. separate host... this report does not make unilaterally"):**
**API-served static.** Given the frontend's existing same-origin assumption, this is the option
that requires no frontend change at all, versus a separate Replit Static Deployment for
`apps/web/dist` — which would need either a reverse-proxy rewrite or a new configurable API base
URL added to the frontend, a broader change than closing an existing readiness gap justifies.

**Implementation (`apps/api/src/lib/staticWeb.ts`, new; `apps/api/src/app.ts`, edited):**

- `mountStaticWebIfPresent(app)` is a no-op unless `NODE_ENV=production`, and a no-op even then
  unless a built `apps/web/dist/index.html` is actually present at boot (checked once, not per
  request) — an API-only production deployment (see the runbook's "two-deployment" alternative)
  boots and behaves exactly as before this phase: a pure JSON API.
- When active, it serves `apps/web/dist` as static files (`express.static`, `index: false`) and
  falls back to `index.html` for any GET request that is not under `/api` (a regex explicitly
  excludes `/api` and `/api/*`) — the SPA's own client-side router (`apps/web/src/App.tsx`'s
  wouter `<Switch>`) takes it from there.
- An explicit JSON 404 handler (`app.use("/api", (_req, res) => res.status(404).json(...))`) is
  mounted immediately after `apiRouter`, before static-web serving, so every `/api/*` request is
  fully resolved — matched route, or this JSON 404 — before the SPA-fallback code is ever reached.
  This is defence in depth: the SPA-fallback route's own regex already excludes `/api/*`
  independently.
- Helmet's default Content-Security-Policy (mounted first, unchanged) was checked against the
  actual `vite build` output (`apps/web/dist/index.html`): the built page loads its JS/CSS via
  same-origin `<script src>`/`<link href>` tags (no inline scripts) plus a Google Fonts
  `<link>`/`@font-face` pair. Helmet's defaults (`script-src 'self'`; `style-src 'self' https:
  'unsafe-inline'`; `font-src 'self' https: data:`) permit all of this with no configuration
  change — verified directly (§4 below), not just reasoned about.

**One incidental, non-blocking observation surfaced while verifying this (§4):** an unmatched
`/api/*` path does not always reach the new JSON 404 handler — several domain routers are mounted
on `apiRouter` without a path prefix (e.g. `apiRouter.use(integrationsRouter)`,
`apiRouter.use(financialRouter)`), and at least one of those applies a blanket
`router.use(requireAuth, ...)` with no path restriction, which runs for **any** request reaching
that point in the chain, matched or not. In practice this means an unauthenticated request to an
unmatched `/api/*` path returns `401 {"error":"Not authenticated"}` from that blanket gate rather
than this phase's new `404 {"error":"Not found."}`. This is not a regression (pre-existing
router composition, unrelated to this phase's change) and not a security concern (fail-closed,
does not leak route existence, and — critically — never reaches or returns the SPA's
`index.html`, which is the actual invariant this phase's change depends on). Recorded here for
completeness; not remediated, since it is outside this phase's scope (static-web serving) and
carries no operational risk for the pilot.

## 2. Discovered while verifying B4's fix: the API's own `build`/`start` scripts did not produce a runnable production artifact

**This is a pre-existing gap, not something this phase introduced** — it was only surfaced because
this phase is the first time anyone actually built and ran `node dist/index.mjs` end-to-end
against a real database, rather than running everything through `tsx` (which transpiles
TypeScript, including every workspace package, on the fly).

**Root cause:** every workspace package (`packages/db`, `packages/events`, every
`packages/integrations/*`) ships **raw TypeScript as its own package entry point**
(`"main": "src/index.ts"`, no compiled JS output, no build step in any of their `package.json`
scripts). `apps/api`'s build command was `esbuild ... --bundle --packages=external`, and
esbuild's `--packages=external` flag externalises **every** package resolved through
`node_modules` — including workspace packages resolved via pnpm's symlinks — not only genuine
third-party npm dependencies. The result: `dist/index.mjs` contained bare
`import ... from "@aee/integration-property-data"`-style specifiers, and when Node resolved them
at runtime it loaded the **raw `.ts` source file directly**, which fails outright — confirmed by
actually running it (`node apps/api/dist/index.mjs`): a `SyntaxError
[ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]` on a TypeScript constructor parameter property that Node's
own (Node ≥22.6) type-stripping does not support. On Node 20.12.2 — the version this repository's
own `.replit` actually declares (`packages = ["nodejs_20", ...]`) — the same import would fail
even earlier, with a plain syntax error, since Node 20 has no built-in TypeScript support at all.
**Conclusion: `pnpm --filter @aee/api run build && node dist/index.mjs` — this repository's own
documented production start path — has never actually produced a working process**, on any Node
version, once a workspace-package import needed anything beyond the plainest JS-compatible
syntax. This is the concrete mechanism behind the original gate's own B4 framing ("its run
command starts dev-mode processes only").

**Fix (`apps/api/package.json`, edited):** replaced the blanket `--packages=external` with an
explicit `--external:<pkg>` list naming only the packages that must stay real, installed npm
dependencies — `argon2` (native bindings — cannot be bundled), plus `cors`, `csv-parse`,
`drizzle-orm`, `drizzle-zod`, `express`, `express-rate-limit`, `helmet`, `multer`, `pg`, `xlsx`,
`zod`. Every workspace `@aee/*` package is now bundled directly into the single `dist/index.mjs`
output (confirmed: the bundle grew from ~1.0MB to ~1.3MB, and a direct string search of the
built output shows `GooglePlacesProvider` and other workspace-package code inlined as plain,
already-type-stripped JS, not a bare import). This list was derived by enumerating every
`dependencies` entry across `apps/api` and all `packages/*`/`packages/integrations/*`
`package.json` files (a repeatable, scriptable check, not a guess) and keeping only genuine
third-party names.

**A second, related gap this surfaced:** two of those externals — `pg` and `drizzle-zod` — were
dependencies of `packages/db` **only**, not of `apps/api` itself. Under pnpm's strict
(non-hoisted) `node_modules` layout, that means they were resolvable from
`packages/db/node_modules` but **not** from `apps/api/node_modules` — so keeping them external
while bundling `@aee/db`'s code into `apps/api`'s own output file broke module resolution at
runtime (`ERR_MODULE_NOT_FOUND: Cannot find package 'drizzle-zod'`, confirmed by actually running
it). Fixed by adding `drizzle-zod` and `pg` as direct dependencies of `apps/api/package.json`
(both already present as transitive resolutions in `pnpm-lock.yaml` at compatible versions — this
did not require a lockfile regeneration, only `pnpm install` to symlink them into
`apps/api/node_modules`). A repo-wide check (every `packages/*`/`packages/integrations/*`
`dependencies` entry, cross-referenced against `apps/api`'s own `dependencies`) confirms these
were the **only** two packages with this gap.

## 3. Discovered while preparing production-mode boot: a genuine conflict between two existing fail-closed gates and the Owner's own explicit pilot decision

**Finding:** `apps/api/src/lib/auth/email.ts`'s `assertAuthEmailProviderConfigured()` (built under
this same remediation pass's Phase 2/4) unconditionally refuses to boot in
`NODE_ENV=production` unless `AUTH_EMAIL_PROVIDER` names something other than `sandbox`/unset —
by design, since only a sandbox provider exists in code (`getAuthEmailProvider()` always returns
it regardless of what `AUTH_EMAIL_PROVIDER` is set to; no real provider integration exists). This
directly conflicts with the Owner's own explicit constraint for this remediation pass: *"External
services: test/sandbox modes only; no real AML/email/SMS/e-signature/payment/property-data action
authorised."* Taken together, these two decisions mean: **a production-mode pilot boot with only
sandbox external services — exactly what the Owner has asked this phase to prepare — was, before
this fix, impossible; the process would refuse to start at all.**

**Resolution:** rather than weaken `assertAuthEmailProviderConfigured()` itself (which would
silently permit sandbox email in **any** future production boot, pilot or not, defeating the
reason it exists), a second, separately-named, explicit environment flag —
`PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED` — is now required to reach the sandbox
fallback in production. Setting it to the literal string `"true"` does not change any other
behaviour; it only stops this one assertion from throwing, and does so while logging a loud,
structured `pilot_mode_sandbox_email_active` warning on **every single boot**, naming exactly
what is and is not happening (no real email delivery) and pointing at this document and the
runbook. Leaving it unset preserves the original fail-closed behaviour exactly as before this
phase, for every non-pilot production boot.

**A second, related gap this surfaced:** even with pilot mode acknowledged and the process
booting, there was still no way for anyone — including an operator with direct server/database
access — to ever retrieve an actual invitation or password-reset link. `routes/auth.ts`'s admin
invitation endpoint never returns the plaintext token in its HTTP response (only `{id, email,
role, expiresAt}`); only the token's **hash** is ever persisted (token-hash-at-rest, by design);
and the sandbox email provider's own log deliberately records only that a send was attempted,
never the token/URL (a real, existing test —
`the sandbox auth email provider never records the token/URL it was asked to send` —
asserts exactly this). Put together: a link generated while pilot mode is acknowledged would have
been **irrecoverable the instant it was generated**, making it structurally impossible to ever
onboard a pilot participant even with an Owner-approved, hand-delivered-out-of-band process —
exactly the gap `docs/CONTROLLED_PILOT_PLAN.md` §B.4 already anticipated ("A real, approved email
provider must be configured before this link reaches a genuine pilot participant's real inbox").

**Fix:** `sandboxAuthEmailProvider.sendInvitation`/`sendPasswordReset` now additionally log the
real, hand-deliverable link via `logger.warn("pilot_mode_sandbox_email_link", {...})`, but **only**
when `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED === "true"` — never by default, never in
ordinary test runs, and never touching the existing `sentLog`/`__getSandboxAuthEmailLog()`
test-only accessor (a separate channel), so the existing test asserting that accessor never
contains a URL is unaffected and was re-run and confirmed passing after this change (§4).

## 4. Verification performed this phase

All of the following were run locally against a fresh, disposable Postgres 16 database
(`aee_prod_smoke`, created and migrated specifically for this phase, never reused from any other
test run), never against any live or public deployment:

1. `pnpm --filter @aee/api run typecheck` — clean.
2. `pnpm --filter @aee/web run build` — clean (117 modules, unchanged from the last verified
   build).
3. `pnpm --filter @aee/api run build` — clean; bundle size increase (~1.0MB → ~1.3MB) confirmed
   as the expected effect of bundling workspace packages that were previously left as broken
   external references.
4. **Production-mode boot, fresh disposable database, all required secrets set including
   `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED=true`:** `node apps/api/dist/index.mjs`
   started cleanly and logged exactly the expected three lines (`pilot_mode_sandbox_email_active`
   warning, `static_web_mounted` info, `api_listening` info) — no error, no crash.
   - `GET /` → `200 text/html` (the built SPA's `index.html`).
   - `GET /assets/index-<hash>.js` → `200 application/javascript` (a real built asset, served by
     `express.static`).
   - `GET /settings` (a client-side-only route, not a real file) → `200 text/html` (SPA fallback
     correctly served `index.html`, not a 404).
   - `GET /api/health/live` → `200 {"status":"ok", ...}`.
   - `GET /api/health/ready` → `200 {"status":"ok", "reasons":[]}` (real database connectivity
     check against the fresh disposable database succeeded).
   - `GET /api/nonexistent` → `401 {"error":"Not authenticated"}` (see §1's incidental finding —
     resolved by a pre-existing blanket auth gate elsewhere in `apiRouter`, not this phase's new
     404 handler, but confirmed to never fall through to the SPA's `index.html`).
   - `HEAD /` response headers include Helmet's default CSP header exactly as expected —
     confirmed directly, not just reasoned about, closing the concern raised in §1.
5. **Negative/fail-closed verification:** the same boot command, with
   `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED` unset and no real `AUTH_EMAIL_PROVIDER`
   set, correctly refused to start — `Error: AUTH_EMAIL_PROVIDER is not configured for
   production...`, process exit code 1 — confirming the fail-closed gate from §3 still fully
   applies to every non-pilot production boot.
6. **Targeted regression suite** (auth, auth-security, auth/password, and the console-usage
   hygiene check — the areas this phase's code changes touch): `44/44` passing, including the
   specific existing test asserting the sandbox email provider never records a token/URL (§3's
   change does not weaken that guarantee, confirmed by this test still passing with
   `PILOT_MODE_SANDBOX_EXTERNAL_SERVICES_ACKNOWLEDGED` unset in the test environment).
7. **Not run this phase, deliberately deferred:** the complete `apps/api` test suite (664 tests,
   ~13 minutes at the last full run — see `docs/OPERATIONAL_READINESS_GATE_REPORT.md` §13). That
   full run against a fresh disposable database is explicitly Phase 12's own mandated
   verification step; re-running it here would duplicate, not add to, that later, more
   comprehensive pass. This phase's targeted suite (#6 above) is sufficient evidence that this
   phase's own changes introduce no regression in the areas they touch.

## 5. `.replit` — deployment configuration prepared, nothing deployed

A `[deployment]` section was added to `.replit` (build: install + build both workspaces; run:
`NODE_ENV=production node apps/api/dist/index.mjs`, relying on this phase's static-web serving to
also serve the built frontend from the same origin/port). **This is configuration only.** Adding
or editing a `[deployment]` section in a `.replit` file does not itself deploy anything — a human
must still explicitly trigger a Replit deployment from the Replit UI/CLI, set the required
Secrets (never committed — see the runbook), and choose to make it accessible, none of which this
phase does or could do from this environment. This satisfies the Owner's instruction to "prepare"
without "deploying."

## 6. What this phase does not do

- Does not deploy anything publicly or privately on Replit — no deployment was triggered from
  this environment (this environment has no access to trigger one; the change is limited to
  files in this repository).
- Does not configure, or claim to configure, any real AML/email/SMS/e-signature/payment/
  property-data credential — every external service remains mock/sandbox, consistent with the
  Owner's explicit instruction.
- Does not admit, or prepare to admit, any pilot participant — that remains explicitly out of
  scope per the Owner's closing constraints for this entire remediation pass.
- Does not re-run the full test/build/CI verification suite — that is Phase 12's own mandated,
  separate step, using a fresh disposable database of its own.
- Does not change, weaken, or bypass any existing fail-closed security gate
  (`assertSessionSecretConfigured`, `assertCorsConfigured`, `assertMetricsAuthConfigured`) — only
  `assertAuthEmailProviderConfigured()` gained a new, narrow, explicitly-named, loudly-logged
  escape hatch, and only for the one condition (sandbox email in production) the Owner has
  already explicitly authorised for this pilot.

See `docs/REPLIT_PILOT_DEPLOYMENT_RUNBOOK.md` for the concrete, step-by-step deployment procedure
a human operator would follow once the renewed gate decision (Phase 12) authorises proceeding.
