# Authentication Threat Model — Critical Blocker Remediation, Phase 1

Status: **Reverification complete.** This document reproduces and documents the B1 finding from
`docs/OPERATIONAL_READINESS_GATE_REPORT.md` §2 before any remediation code is written, per the
AE Project Owner's "AE Operational Readiness — Critical Blocker Remediation" instruction, Phase 1.

No credentials, secret values, session tokens, or hash outputs appear anywhere in this document.
Every claim below is grounded in a `file:line` citation against
`feat/operational-readiness-pilot-gate` (branch head at the time of this reverification:
`1a4bc462787f1c1f10a1664f7fb45d876ebed3d7`) and/or a locally-executed command.

## 1. Reproduction of the blocker

### 1.1 Unauthenticated impersonation via `POST /auth/dev-login`

`apps/api/src/routes/auth.ts:65-135` defines the only sign-in endpoint in the codebase:

- Accepts a JSON body of `{ email, firstName, lastName, brokerageName }` (`devLoginSchema`,
  `auth.ts:49-55`) with no password, token, OTP, or any other proof of identity.
- Finds a user by `email` (`auth.ts:79-84`) or creates one if none exists.
- Signs the caller in as that user via `setSessionCookie` (`session.ts:117-122`).
- The only gate is `isDevAuthEnabled()` (`env.ts:28-30`), which is a single environment flag
  (`ALLOW_DEV_AUTH === "true"`), forced off whenever `NODE_ENV === "production"`
  (`env.ts:9-18`, confirmed by `apps/api/src/lib/__tests__/env.test.ts:53-58`).

**Reproduction (local, `ALLOW_DEV_AUTH=true`, matching how every pilot deployment would need to
run it today since this is the only login path):**

```
POST /api/auth/dev-login
Content-Type: application/json

{"email":"victim@realagency.com.au","firstName":"Victim","lastName":"Agent","brokerageName":"Any Agency"}
```

returns `201`/`200` with a valid, fully-privileged `aee_session` cookie for `victim@realagency.com.au` —
an account the caller does not own and has proven no ownership of. This is confirmed by the
existing test at `apps/api/src/routes/__tests__/auth.test.ts:80-118`, which asserts the endpoint
succeeds and returns a real session for an arbitrary attacker-supplied email once the flag is on.

**Why this is structural, not incidental:** every tenant-isolation control elsewhere in this
codebase (role checks in `requireRole`, brokerage-scoping in query filters, the entire AI
Governance/Authority layer, financial entitlement checks) assumes the session in front of it
belongs to who it claims to. `dev-login` breaks that assumption at its root: possession of any
real user's email address — visible in every email footer, business card, CRM export, or the
`known-users` response below — is sufficient to become that user.

### 1.2 Unauthenticated enumeration via `GET /auth/known-users`

`apps/api/src/routes/auth.ts:30-47` returns `id, email, firstName, lastName, brokerageName` for
**every user in the database**, with no pagination, no scoping, and no auth check beyond the same
`isDevAuthEnabled()` flag (`auth.ts:35-40`). Combined with 1.1, this is a ready-made attacker
worklist: enumerate every user, then impersonate any of them.

### 1.3 No other bypass exists (repository-wide search, this session)

Searched `apps/**/*.ts(x)` and `packages/**/*.ts` for each of the following; results below.

| Pattern searched | Result |
|---|---|
| `dev-login`, `devLogin` | Only `auth.ts` (route) and `Login.tsx` (frontend caller). No second definition. |
| `known-users`, `knownUsers` | Only `auth.ts` (route) and `Login.tsx` (frontend caller). |
| Bootstrap/seed users, hardcoded identities | None found outside test fixtures (`__tests__/**`, which run against an isolated test database and are not reachable in a running deployment). |
| Default passwords | None — the codebase has no password field anywhere yet (see §2). |
| Auth bypasses / dev-only flags | Only `ALLOW_DEV_AUTH`, gated as above. `isInsecureCookieExplicitlyAllowed()` (`env.ts`) affects only the cookie's `Secure` attribute in non-production, not authentication itself. |
| Mock users | None outside `__tests__/**`. |
| Token creation outside the canonical service | `createSessionToken`/`sign` exist only in `apps/api/src/lib/session.ts`. `createHmac` also appears in `apps/api/src/lib/communications/webhooks.ts`, `apps/api/src/lib/integrations/webhooks.ts`, and three `packages/integrations/*` adapters — all of those are inbound **webhook signature verification** for third-party callbacks (AML/e-sign/payments), an unrelated use of HMAC, not session/token issuance. |
| Second auth router / route registration | `apps/api/src/routes/index.ts:38` mounts exactly one `authRouter` at `/auth`, behind `authRateLimiter`. No other file calls `app.use(..."auth"...)`. |

**Conclusion: the two routes above are the entire blocker. There is no hidden third bypass.**

## 2. Current token issuance, refresh, revocation, and expiry behaviour

- **Issuance:** `createSessionToken(userId, epoch)` (`session.ts:69-72`) builds
  `base64url({uid, iat, epoch})` and HMAC-SHA256-signs it with `SESSION_SECRET` (min 32 chars,
  boot-time enforced via `assertSessionSecretConfigured()`, `session.ts:44-51`). Stateless — no
  server-side session table.
- **Cookie attributes:** `HttpOnly; SameSite=Lax; Max-Age=2592000` (30 days) and `Secure` unless an
  operator has explicitly opted out for local HTTP dev (`isInsecureCookieExplicitlyAllowed()`).
- **Verification:** `verifySessionToken` (`session.ts:75-97`) checks the HMAC in constant time
  (`timingSafeEqual`), rejects tokens older than 30 days server-side (not just via cookie
  `Max-Age`), and returns `{uid, epoch}`.
- **Revocation:** `loadSession`/`requireAuth` (`middlewares/auth.ts`) re-read the user row on
  *every* request and compare the token's `epoch` against the user's live `sessionEpoch` column.
  `POST /auth/logout` (`auth.ts:162-...`) increments `sessionEpoch`, which invalidates every
  outstanding token for that user immediately — proven by
  `auth.test.ts:172-223` ("a session token that was valid before logout is rejected... afterward").
  There is currently no *other* revocation trigger (e.g. password change, admin disable) because
  there is no password and no disable flag yet — both are added in Phase 4.
- **Expiry:** 30 days, fixed, non-configurable per-session (acceptable for a controlled pilot;
  recorded as a pre-GA follow-up in the Phase 2 design doc rather than solved here).

This mechanism (HMAC cookie + epoch revocation) is sound and is **kept** by the Phase 2/4 design —
only the *issuance* step (currently "any email, no proof") changes.

## 3. Current user, tenant, and role schema

`packages/db/src/schema/users.ts` (as of this reverification):

- `brokerages`: `id, name, createdAt` — the tenant boundary.
- `users`: `id, brokerageId (FK), email, firstName, lastName, role, sessionEpoch (default 0), createdAt`.
  `authProviderId` carries a **unique** constraint; `email` does **not** — meaning two rows can
  currently share an email at the schema level (in practice `dev-login` looks up by email first,
  so duplicates are avoided by that route's own logic, not by the database).
- `USER_ROLES`: a small fixed set of flat, brokerage-scoped roles (no cross-brokerage / platform-admin
  role exists yet). No `passwordHash`, `emailVerifiedAt`, `failedLoginAttempts`, `lockedUntil`, or
  `disabledAt` columns exist. These are added in the Phase 4 migration.

## 4. Current authentication middleware and frontend assumptions

- `middlewares/auth.ts`: `loadSession` (reads/validates the cookie, attaches `AuthedUser` or
  nothing), `requireAuth` (401s if absent), `requireRole` (403s if role not in an allow-list;
  `BROKERAGE_ADMIN_ROLES` / `PIT_CREW_ROLES` groupings). All of this operates on **whatever user
  the cookie claims to be** — it has no way to know that claim was never proven, which is exactly
  the gap Phase 2/4 closes.
- `apps/web/src/pages/Login.tsx`: fetches `/auth/known-users` to offer a one-click "continue as"
  list, and falls back to a free-text name/email/brokerage form that calls `/auth/dev-login`. Every
  other authenticated screen in the SPA assumes `GET /auth/me` (`auth.ts:137-...`) has already
  produced a real, trustworthy session — the frontend performs no password/credential handling
  anywhere today, so Phase 4's new Login/Accept-Invitation/Reset-Password screens are additive, not
  a rework of existing authenticated pages.

## 5. Threat model for the new (Phase 2/4) design

| # | Threat | Current state | Mitigation (Phase 2/4) |
|---|---|---|---|
| T1 | Identity impersonation via known email | **Exploitable today** (§1.1) | Password required; password never guessable/derivable from email; Argon2id hashing |
| T2 | User-roster enumeration | **Exploitable today** (§1.2) | `known-users` stays dev-only/fail-closed; no unauthenticated directory endpoint ships for the pilot |
| T3 | Credential stuffing / brute force | N/A today (no passwords) | `authRateLimiter` (existing) + per-account failed-attempt lockout (new `failedLoginAttempts`/`lockedUntil`) |
| T4 | Account enumeration via login/reset error messages | N/A today | Generic "invalid email or password" / generic "if that address exists..." responses on both paths |
| T5 | Invitation token guessing/replay | N/A today (no invitations) | Cryptographically random tokens, hashed at rest, single-use, time-limited, tenant+role bound |
| T6 | Password-reset token leakage via logs/analytics/Referer | N/A today | Token never logged, never returned in API responses beyond the one-time email, single-use, short expiry, consumed token cannot appear in a later redirect URL |
| T7 | Stolen/replayed session surviving a password change | Partially solved (logout works) | Password change/reset explicitly bumps `sessionEpoch`, exactly like logout, revoking all other sessions |
| T8 | Privilege escalation via client-supplied role/tenant | Already mitigated for dev-login (`auth.test.ts:120-141`, server derives role) | Same invariant carried into invitation acceptance: role/tenant come only from the invitation record created by an admin, never from the acceptance request body |
| T9 | Disabled/removed user retaining access | No disable flag exists yet | New `disabledAt` check in `loadSession`, plus a `sessionEpoch` bump on disable |
| T10 | Cross-tenant admin bootstrap risk | No bootstrap process exists yet | One-time, explicit CLI bootstrap command (Phase 4), refuses on ordinary `npm start`, cannot silently re-run against an existing admin |

## 6. Scope note carried into later phases

`dev-login` / `known-users` remain, unchanged in behaviour, as **local-development and automated-test
fixtures only** — every one of the ~50 existing test files across `apps/api/src/**/__tests__/*`
constructs its authenticated fixtures via `ALLOW_DEV_AUTH=true` + `dev-login`. Ripping that out
would require rewriting the entire existing test suite's fixture layer, which is out of the bounded
scope of this remediation and would risk regressions in unrelated, already-verified functionality.
The two routes already satisfy Phase 3's requirement ("unregistered **or** 404 in production,
fail-closed, proven by tests") today; Phase 3's evidence section documents this rather than
re-implementing it. What changes is that **the pilot's real Login screen stops depending on either
route** — it is rebuilt on the invitation/password flow specified in Phase 2.
