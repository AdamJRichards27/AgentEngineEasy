# F1 — Authentication Remediation

**Stage:** 1
**Governing finding:** the prior Architecture & Build-State Audit's Critical Finding 1 — `POST /api/auth/dev-login` and `GET /api/auth/known-users` together let anyone reachable to the API become an authenticated user of any brokerage, using nothing but an email address.

## 1.1 Removed production exposure of development authentication

**Fully remediated.**

- New module `apps/api/src/lib/env.ts` adds `isDevAuthEnabled()`: returns `true` only when `process.env.ALLOW_DEV_AUTH === "true"` **and** `NODE_ENV !== "production"`. Every other case — the variable unset, empty, misspelled, `"1"`, `"yes"`, or any value other than the exact literal string `"true"` — evaluates to `false`. `NODE_ENV=production` always wins and disables the gate even if `ALLOW_DEV_AUTH` is set. This satisfies the instruction's specific requirement that these routes "cannot be activated merely by omitting an environment variable": omission is the disabled state, not the enabled one.
- `apps/api/src/routes/auth.ts`: both `POST /dev-login` and `GET /known-users` now call `isDevAuthEnabled()` as the first line of their handlers and return a bare `404` (not `403`) when it is false, so a locked-down environment gives no signal that the routes exist at all.
- The guard is enforced entirely server-side, inside the Express route handler — not in any frontend conditional, not via hiding a button. A direct `curl`/`fetch` against either route from any client gets the same `404` the browser would.
- `apps/web/src/pages/Login.tsx` already contained a manual sign-in form as a fallback path (`showForm || !knownUsers || knownUsers.length === 0`); this was **not new code**, it pre-existed. What changed: the `known-users` query now sets `retry: false`, so a disabled environment fails fast to that existing fallback instead of retrying three times against a route that will never succeed. The frontend does not depend on `known-users` being reachable — a disabled backend simply means the picker list never populates and the manual form is what a visitor sees.
- **Temporarily contained, not eliminated:** `GET /known-users` remains an *unauthenticated* endpoint by design when `ALLOW_DEV_AUTH=true`, because it exists to let a not-yet-signed-in visitor pick an identity before any session exists — there is no session to authenticate it against at that point in the flow. The instruction's phrasing allows "removed or protected by authentication and an appropriate administrator role"; neither option is available without redesigning the login flow, which is out of scope for this stage. The environment gate is the containment: the route is only reachable at all in an explicitly-declared development environment, never in staging or production by default. This is recorded as a contained risk, not a fully closed one, in the final report's risk register.

## 1.2 Session-secret enforcement

**Fully remediated.**

- `apps/api/src/lib/session.ts`: the hardcoded fallback secret has been removed entirely. `secret()` now throws if `SESSION_SECRET` is unset **or** shorter than 32 characters.
- `apps/api/src/index.ts` now calls a new exported function, `assertSessionSecretConfigured()`, before `configureEvents()`/`app.listen()` — i.e. during process boot, before the server accepts any traffic. If the secret is missing or weak, the process throws and exits rather than starting in a state where every session it signs is untrustworthy.
- No secret value is logged, printed, or included in any error message — the thrown error describes the requirement (minimum length, a suggested generation command) but never echoes back whatever value (if any) was actually set.
- This repository's own Replit workspace already has `SESSION_SECRET` configured as an environment variable (confirmed present by name only during Stage 0; its value and strength were never read directly — only checked programmatically by the new length guard, which the test suite exercises). No new secret was invented or written into any file.

## 1.3 Cookie security

**Fully remediated**, with one explicit, documented trade-off.

- `setSessionCookie()`/`clearSessionCookie()` in `apps/api/src/lib/session.ts` now append `; Secure` to the `Set-Cookie` header by default.
- A new escape hatch, `isInsecureCookieExplicitlyAllowed()` (`apps/api/src/lib/env.ts`), lets an operator explicitly opt out via `ALLOW_INSECURE_DEV_COOKIES=true` for a genuine plain-`http://localhost` setup with no TLS — and, matching `isDevAuthEnabled()`, this can never be set to `true` when `NODE_ENV=production`. Nothing in this repository sets that variable; the default everywhere, including this Replit workspace (which is served over HTTPS even in development), is `Secure`.
- `HttpOnly`, `SameSite=Lax`, `Path=/`, and the existing 30-day `Max-Age` were already correctly configured and are unchanged.
- **Residual, out-of-scope observation (not fixed in this stage):** `apps/api/src/app.ts` configures CORS as `cors({ origin: true, credentials: true })` — it reflects any request origin and allows credentialed requests. This is a broader trust decision than the cookie attributes alone and was not something this instruction's checklist named explicitly (`HttpOnly`/`SameSite`/`Secure`/lifetime/path). Narrowing it correctly requires knowing which origins are actually legitimate for this deployment, which is operational knowledge this remediation does not have. It is recorded as a residual risk in the final report rather than changed here, to avoid guessing at an allowlist and breaking a legitimate frontend origin.

## 1.4 Genuine identity verification

**Classified as a blocking external dependency, not fabricated.**

- Stage 0 confirmed: no Clerk (or any other identity-provider) package is present in either `apps/api/package.json` or `apps/web/package.json`, and no Clerk-related environment variable exists. Clerk is referenced only as documented future scope in code comments.
- Per instruction, no Clerk (or other) credentials were invented, and no speculative provider-specific integration code was written.
- What already existed, and remains true after this stage: `apps/api/src/middlewares/auth.ts::loadSession()` derives `req.authedUser` (`id`, `role`, `brokerageId`) entirely from a fresh database lookup keyed by the verified session's `uid` — never from anything the client sends in a request body, header, or query string. A caller cannot manufacture their own role or brokerage today, independent of whichever identity mechanism issues the session in the first place; this was verified by direct code review and is now also covered by an automated test (`a second dev-login against the same brokerage is never granted admin, even if it asks for one`, see 1.5).
- **This remains a genuine, unresolved blocker**: until a real identity provider (Clerk or otherwise) is wired in, no deployment of this application can honestly claim strong authentication, regardless of how well-contained `/dev-login` now is. This is called out explicitly, and without qualification, in the final report's risk register as a **Critical, still-open** item — this stage reduced its blast radius, it did not close it.

## 1.5 Authentication tests

**Fully remediated** — all required proof points are covered by new, passing, automated tests.

New files: `apps/api/src/lib/__tests__/env.test.ts`, `apps/api/src/lib/__tests__/session.test.ts`, `apps/api/src/routes/__tests__/auth.test.ts`. Wired into `pnpm run test` via two new globs added to `apps/api/package.json`'s `test` script (`src/lib/__tests__/*.test.ts`, `src/routes/__tests__/*.test.ts`), so they run as part of the standard test command, not as a separate, easy-to-forget step.

| Requirement | Covered by |
|---|---|
| Development login disabled outside development | `env.test.ts` (unit, all non-`"true"` values); `auth.test.ts` (HTTP-level: `POST /api/auth/dev-login is unavailable (404) when ALLOW_DEV_AUTH is unset`, and confirms no user row is created) |
| Known-user enumeration inaccessible to unauthenticated callers by default | `auth.test.ts` (`GET /api/auth/known-users is unavailable (404) when ALLOW_DEV_AUTH is unset`) |
| Missing required session configuration fails closed | `session.test.ts` (`assertSessionSecretConfigured throws when SESSION_SECRET is absent` / `...is too short`) |
| Forged or malformed sessions are rejected | `session.test.ts` (tampered payload, wrong signature); `auth.test.ts` (`GET /api/auth/me rejects a forged session cookie`, `...a well-formed but wrongly-signed session cookie`) |
| Expired sessions are rejected | `session.test.ts` (`...rejects an expired session (older than 30 days)`, plus a future-`iat`/clock-skew case) |
| Secure cookie attributes present in staging/production configuration | `auth.test.ts` (`dev-login... ` asserts `Secure`, `HttpOnly`, `SameSite=Lax` all present on the `Set-Cookie` header returned by a real HTTP response) |
| A user cannot select or manufacture their own role or brokerage | `auth.test.ts` (`dev-login remains functional when explicitly enabled, and the caller cannot choose their own role or brokerage`; `a second dev-login against the same brokerage is never granted admin, even if it asks for one` — both send a spoofed `role`/`brokerageId` in the request body and assert the server ignored it) |
| Tenant and role middleware operate from verified server-side identity | Confirmed by code review of `middlewares/auth.ts::loadSession()` (unchanged, already correct) and exercised indirectly by the same two tests above |

**Test results:** `cd apps/api && pnpm run test` → **77 tests total, 76 pass, 0 fail, 0 cancelled, 1 skipped (the same pre-existing, documented skip from the prior session's AI Governance work — unrelated to this stage), 0 todo. Duration ≈ 35.9s.** Full monorepo typecheck (`pnpm -r run typecheck`, and individually `apps/api`/`apps/web`) passed clean, zero errors, both before and after this stage's changes.

## Summary against the instruction's own categories

- **Fully remediated:** insecure fallback secret removed and boot-time enforcement added (1.2); Secure/HttpOnly/SameSite cookie attributes (1.3, with one documented residual CORS observation); server-side environment gating of both dangerous routes (1.1); role/brokerage derivation already server-side, now test-covered (part of 1.4/1.5); expired and forged sessions now rejected server-side (1.5).
- **Temporarily contained:** `GET /known-users` stays unauthenticated-by-design when explicitly enabled for development, gated only by environment (1.1).
- **External dependency, not resolved:** genuine identity-provider integration (Clerk or equivalent) — not configured, not fabricated, explicitly flagged as a blocker (1.4).
- **Remaining production blocker:** this application cannot be honestly described as having strong authentication until 1.4 is closed by a real identity provider. Everything else in this stage reduces risk in the meantime; none of it substitutes for that.
