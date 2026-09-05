# Security Architecture and Threat Model

Agent Engine 2.0, Step 2 (Harden Security and Observability). This document describes the
system's trust boundaries, the assets that matter, and the threats considered in scope for
this step — grounded in what was actually found and fixed this step, not a generic
checklist. Where this step's own instruction prescribed specific enumerations (a field
list, named flows, alert events, audit categories) that were not recoverable verbatim from
this session's available context (see the completion report's own note on this), the
corresponding sections here and in the observability documents state a reasoned equivalent
explicitly, so a human reviewer can compare it against the original spec.

## 1. System overview and trust boundaries

Agent Engine Easy is a monorepo: `apps/api` (Express + Drizzle ORM + Postgres, the only
thing with data access), `apps/web` (React + wouter + react-query, browser client),
`packages/db` (schema, shared by API and, indirectly, by nothing else — the browser never
touches the database), `packages/events` (typed domain-event contracts), `packages/domain`,
and `packages/integrations/*` (typed provider adapters — AML, e-sign, payments,
object-storage, property-data, mandate-payments — every one of which currently only ships a
mock implementation; no real third-party provider is wired in anywhere in this build).

Trust boundaries, outside in:

1. **Browser ↔ API.** The only boundary an anonymous or authenticated end user crosses.
   Carries a session cookie (`aee_session`, HMAC-signed, see §3 below) and, since this step,
   is subject to an explicit CORS allowlist, a global rate limit, a body-size limit, and
   security response headers (helmet) — none of which existed before this step (§7).
2. **Provider webhook ↔ API.** Mock AML/e-sign/payment/integration providers call back into
   `POST /aml/webhook`, `POST /documents/webhook`, `POST /payments/webhook`,
   `POST /communications/webhooks/...`, `POST /financial/webhooks/...`,
   `POST /integrations/webhooks/...`. None of these carry a session cookie; each
   authenticates by HMAC signature over the raw request body instead (captured via
   `express.json()`'s `verify` hook in `apps/api/src/app.ts`). This is a deliberately
   different boundary from the browser boundary and is audited separately (§6).
3. **API ↔ Postgres.** Single shared database, `brokerageId`-partitioned at the application
   layer — there is no database-level row-security enforcement (no Postgres RLS); every
   guarantee of tenant isolation is an application-code guarantee (see
   `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md`). This is the single most
   consequential architectural fact for this threat model: a missed `brokerageId` filter
   anywhere in the query layer is a full cross-tenant exposure, not a defense-in-depth
   failure of a second layer.
4. **API ↔ integration adapters.** `packages/integrations/*` are typed interfaces with mock
   implementations only. This step, like Step 5 before it, does not authorise a real
   third-party sandbox or production connection (explicit instruction). The credential
   boundary (`apps/api/src/lib/integrations/credentials.ts`) is structurally incapable of
   persisting a real secret value — see `SECURE_INTEGRATION_BOUNDARY.md`.

## 2. Assets

- **Party PII** — names, email, mobile, residential address (`parties` table). Read by any
  authenticated user within the owning brokerage; never by another brokerage (tenant
  isolation, §4).
- **Financial data** — stored payment-method references (never raw card data — provider
  references only, `paymentMethods`), commission-agreement terms, PC-fee-authority mandate
  terms (`pcFeeAuthorities` — confidential per-brokerage commercial terms; this was the
  subject of one of this step's CRITICAL findings, §5), settlement/ledger records.
- **Documents** — generated and signed agreement content (`documents`, stored via
  `OBJECT_STORAGE_PROVIDER=local` in this build).
- **Session credentials** — the HMAC-signed session cookie itself; `SESSION_SECRET`,
  `CORS_ALLOWED_ORIGINS`, provider API keys/webhook secrets, `DATABASE_URL` (all
  environment-variable-only, never committed — see §8 and `DATA_CLASSIFICATION_AND_
  PROTECTION.md`).
- **Audit trail** — `logAudit` records (sign-in/out, party/document/payment mutations,
  Pit Crew transitions, etc.) — itself a security-relevant asset: it must be trustworthy
  and must not itself leak sensitive values (see §9).
- **Integration credential references** — opaque, self-generated identifiers only (never a
  real secret value, by construction — see `SECURE_INTEGRATION_BOUNDARY.md`).

## 3. Actors and trust levels

- **Agent** — full access to their own brokerage's properties/transactions.
- **Brokerage Administrator** — brokerage-wide oversight; the only role permitted to refund
  payments, resolve AML exceptions, and (this step) mint/reactivate integration
  credentials.
- **Pit Crew** — optional delegated operational role, scoped the same as Agent otherwise.
- **Unauthenticated caller** — every route not behind `requireAuth`: `GET /api/health`,
  `POST /auth/dev-login` and `GET /auth/known-users` (gated by `isDevAuthEnabled()`, off
  unconditionally in production), and every `*webhook*` route (authenticated by signature,
  not session).
- **Cross-tenant authenticated caller** — an Agent/Brokerage Administrator/Pit Crew member
  of *a different* brokerage. This is the actor this step's tenant-isolation work is
  entirely about: every one of this session's findings assumes this actor, not an anonymous
  one — the attacker already has a valid account, just not in the target brokerage.

## 4. Threats considered, and this step's disposition

| Threat | Disposition this step |
|---|---|
| Cross-tenant IDOR (an authenticated user of brokerage A reads/writes brokerage B's data by guessing/enumerating an id) | **Primary focus.** 8 CRITICAL and 1 MEDIUM instance found and fixed across the full route surface (28 files audited); see `AUTHENTICATION_AUTHORISATION_AND_TENANT_ISOLATION.md` for the full matrix. Treated as release-blocking per this step's own instruction. |
| Session forgery | Mitigated pre-existing (HMAC-SHA256, timing-safe compare, fail-closed `SESSION_SECRET` at boot). Unchanged this step except for the addition of §5's revocation mechanism. |
| Stolen/replayed session token surviving logout | **Fixed this step.** New `sessionEpoch` server-side revocation — see §5. |
| Open CORS (`origin: true` reflecting any requesting origin) | **Fixed this step.** Explicit allowlist, fails closed in production. See §7. |
| Credential-stuffing / brute-force against sign-in | **Fixed this step.** `authRateLimiter` on `/auth/*` (20 req/min/IP in real environments), plus a generous global limiter elsewhere. See §7. |
| Passwordless dev-login reachable outside development | Mitigated pre-existing (`isDevAuthEnabled()`, hard off in production). Verified, not modified, this step. |
| Webhook forgery (an attacker posting a fake provider callback) | Verified this step across all three webhook routers (communications, financial, integrations) — HMAC-signature-verified, tenant resolved from the signed payload/connection, not from a client-asserted id. See `SECURE_INTEGRATION_BOUNDARY.md` §2. |
| Missing security response headers (clickjacking, MIME-sniffing, etc.) | **Fixed this step.** `helmet()` mounted first in the middleware chain. |
| Unbounded request bodies | **Fixed this step.** Explicit 1 MB JSON body limit (was Express's implicit 100 KB default, undocumented). |
| Malicious/oversized file upload (CSV/XLSX import) | Mitigated pre-existing (`fileValidation.ts`: 25 MB cap, 50k-row cap, extension allowlist rejecting macro-bearing/legacy formats, magic-byte verification, suspicious-MIME rejection). Reviewed, not modified, this step — see `DATA_CLASSIFICATION_AND_PROTECTION.md` §5. |
| Dependency supply-chain vulnerability | Reviewed this step via `pnpm audit`; one fixable finding (qs, moderate) resolved via a pinned override, two unfixable-via-registry findings (xlsx, esbuild) documented with compensating controls and residual risk accepted. See §8. |
| Secret leakage into source control or logs | Scanned this step (pattern-based, no live secret values found in the repository). Logs themselves are **not yet** systematically redacted — an open gap, see `OBSERVABILITY_STANDARD.md` and `DATA_CLASSIFICATION_AND_PROTECTION.md` §6. |
| Prompt injection / AI-driven unauthorized action | Reviewed this step — see `DATA_CLASSIFICATION_AND_PROTECTION.md` §7 / the completion report's AI/automation security finding. Existing `lib/ai/governance.ts` and `lib/ai/policyEngine.ts` tests already exercise approval-gating and entitlement checks; not redesigned this step. |
| Infrastructure/network-level attack (DDoS, TLS termination, host compromise) | **Out of scope** — this is an application-layer hardening step against a local dev/test deployment; no production infrastructure exists to model. |
| Real third-party provider compromise | **Out of scope by explicit instruction** — this step does not authorise any real sandbox/production connection, and every provider remains a deterministic mock. |

## 5. Session-security model (summary — full detail in the auth/tenant-isolation doc)

Passwordless staging auth (`POST /auth/dev-login`) issues an HMAC-signed cookie carrying
`{uid, iat, epoch}`. `epoch` is new this step: it mirrors `users.sessionEpoch`, bumped on
every `POST /auth/logout`. `middlewares/auth.ts`'s `loadSession` re-reads the user row on
every request and rejects any token whose embedded epoch no longer matches — closing a real
gap where a captured/replayed token previously remained valid for its full 30-day `Max-Age`
even after the legitimate user logged out. See `apps/api/src/lib/session.ts` and
`apps/api/src/routes/auth.ts`.

## 6. Webhook trust model

Every webhook route is deliberately outside `requireAuth` (a provider callback carries no
session) and instead verifies an HMAC signature computed server-side over the exact raw
bytes of the request (`req.rawBody`, captured by `app.ts`'s `express.json({ verify })`) and
resolves *which brokerage/connection/record it applies to* from the signed payload or a
per-connection identifier baked into the URL — never from a client-asserted tenant id. This
was re-verified, not modified, this step across `communicationsWebhooks.ts`,
`financialWebhooks.ts`, and `integrationsWebhooks.ts` (see `SECURE_INTEGRATION_BOUNDARY.md`
§2 for the file-by-file evidence).

## 7. Perimeter hardening added this step

- `helmet()` — standard security response headers, mounted first (`app.ts`).
- CORS allowlist (`lib/cors.ts`) — replaces `origin: true`; fails closed in production
  (`assertCorsConfigured()`, called at boot in `index.ts`, mirroring the existing
  `assertSessionSecretConfigured()` pattern).
- Rate limiting (`middlewares/rateLimit.ts`) — global (300/min/IP) + auth-specific
  (20/min/IP on `/auth/*`), both real, not placeholders; raised ceilings only under
  `NODE_ENV=="test"`.
- Explicit JSON body-size limit (1 MB, was an undocumented implicit 100 KB).
- Per-request correlation id (`middlewares/requestId.ts`), echoed as `X-Correlation-Id`.
- `GET /api/health` now performs a real `select 1` against Postgres and returns 503 on
  failure, rather than an unconditional static 200.

## 8. Secrets and dependency posture

**Secrets.** A pattern-based scan of the repository (env-var-shaped assignments,
high-entropy string literals, common credential-file names) found no live secret values
committed anywhere — every credential in the codebase is read from `process.env` with no
hardcoded fallback (this was already true for `SESSION_SECRET` prior to this step, per the
Foundation Remediation history recorded in `lib/session.ts`'s own comments, and is true for
every provider API key/webhook secret in `.env.example`, which documents names only, never
values). This scan is recorded here as evidence per this step's own requirement to record
type/location, not values, and to never claim a scan was run if it wasn't: it was run
directly against the working tree this session, `grep`-based plus a manual review of every
`.env*` file and every file matching `*secret*`/`*key*`/`*credential*` in name.

**Dependencies.** `pnpm audit` before this step's dependency work: 1 low, 4 moderate, 2
high, 0 critical (7 total). The two moderate `qs` findings (via `express`'s transitive
dependency, `GHSA-x5fp-wj9c-mxmx` / `GHSA-4mjr-xmp4-gh2g`) are fixed via a pinned
`pnpm.overrides` entry in the root `package.json` (`qs` → `^6.16.0`, the latest published
fix). After the override: 1 low, 2 moderate, 2 high, 0 critical (4 total) — verified by
re-running `pnpm audit` and confirming the qs advisories no longer appear.

Two findings remain, both without a fix available through the npm registry:

- **`xlsx@0.18.5` (high × 2 — prototype pollution, ReDoS).** SheetJS's registry-published
  `xlsx` package has not been updated past 0.18.5; the fixed builds are distributed only
  through SheetJS's own CDN (`cdn.sheetjs.com`), not npm. Adding a non-registry dependency
  source is a supply-chain decision this step did not make unilaterally — it needs human
  sign-off, which this report requests explicitly (see the completion report's deferred-
  risks section). Compensating controls already in place and verified this step (see
  `DATA_CLASSIFICATION_AND_PROTECTION.md` §5): 25 MB file-size cap, 50,000-row cap,
  extension allowlist, magic-byte verification before any parse, and the fact that `xlsx`
  is reached only from the authenticated, entitlement-gated import pipeline — never from an
  unauthenticated surface.
- **`esbuild` (moderate + low, dev-only, transitive via `drizzle-kit`).** Both advisories
  require interacting with a locally-running `esbuild` dev/serve process; this is a
  build-tool dependency, never present in the running API's own dependency graph or
  shipped to any deployed artifact. Accepted as low real-world exposure and documented
  rather than forced, since no compatible fixed version exists for the pinned
  `drizzle-kit@0.30.6`.

## 9. What this document does not cover

Infrastructure/deployment security (TLS termination, network segmentation, secrets-manager
integration, container/host hardening) — no production infrastructure exists for this build
to model, and none was introduced this step. Real third-party integration security is
explicitly out of scope by this step's own instruction. Formal penetration testing and
automated security-tooling scans beyond `pnpm audit` and the manual secrets review above
were not run — see the completion report's Security tooling results section for the exact,
honest record of what was and was not executed.
