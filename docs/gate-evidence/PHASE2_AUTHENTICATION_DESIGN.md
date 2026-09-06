# Phase 2 — Invitation-Only Authentication Design

Status: design approved for implementation in this remediation pass (Phase 4). Supersedes nothing
in `docs/SECURITY_ARCHITECTURE_AND_THREAT_MODEL.md`; it fills the gap that document already flagged
as future scope ("real Clerk auth integration").

## 1. Principles

1. Use established, maintained libraries only. No invented cryptography.
2. Never trust client input for role/tenant assignment — always derive from server-held state.
3. Fail closed: missing configuration (secrets, email provider) must refuse to start or refuse to
   act, never silently downgrade to an insecure mode.
4. No secret material (passwords, raw tokens) is ever logged, stored in plaintext, returned in an
   API response beyond the single legitimate transport, or embedded in a URL after the token has
   been consumed.
5. Every security-relevant event is audited (reusing the existing `logAudit()` /
   `auditLogs` table — `apps/api/src/lib/audit.ts`, `packages/db/src/schema/audit.ts`) with no
   secret or full-PII payload.
6. Build on what already works: the HMAC session cookie + `sessionEpoch` revocation mechanism
   (`lib/session.ts`) is kept unchanged. Only how a session gets **issued** changes.

## 2. Password hashing

**Argon2id**, via the `argon2` npm package (native binding, actively maintained, OWASP-recommended
default). Confirmed installable and functional in this repository's runtime this session
(`node --input-type=module` smoke test: hash/verify round-trip correct, wrong-password rejected).
Parameters: `memoryCost: 19456` (19 MiB), `timeCost: 2`, `parallelism: 1` — OWASP's current
minimum recommended Argon2id profile for an interactive login path; documented in code as
adjustable per deployment via env var without a schema change (the algorithm + all parameters are
embedded in the stored hash string itself, which is how Argon2id encodes salt and params — the
library's own comparison function only needs the stored hash and the candidate password, so
changing parameters for new hashes never invalidates old ones). Passwords are never logged; no code
path prints `req.body` for auth routes (checked as part of Phase 5's log-redaction test).

No MFA/SSO is implemented this pass — the architecture (a `credentials` concept separate from
`users`, see §3) does not preclude adding a second factor later without a breaking change, so this
is recorded as a pre-GA item in `docs/CONTROLLED_PILOT_PLAN.md` rather than blocking this gate.

## 3. Schema additions (Phase 4 migration)

`users` table gains:
- `passwordHash text` (nullable — null until the invitee sets a password)
- `emailVerifiedAt timestamp` (nullable; set the moment an invitation is accepted, since accepting
  requires possessing the invited mailbox)
- `failedLoginAttempts integer not null default 0`
- `lockedUntil timestamp` (nullable)
- a **unique index on `email`** (closes the existing gap noted in Phase 1 §3)

No new "disabled" column is added: `users.isActive` already exists (default `true`) and is already
checked by `loadSession`/dev-login's own 403 — disable/enable (§4.6) reuses it directly rather than
introducing a second, overlapping flag.

New `invitations` table: `id, brokerageId (FK), email, role, tokenHash (unique), invitedByUserId (FK),
expiresAt, acceptedAt (nullable), revokedAt (nullable), createdAt`. Single-use: `acceptedAt` or
`revokedAt` being non-null makes the token permanently unusable regardless of expiry.

New `passwordResetTokens` table: `id, userId (FK), tokenHash (unique), expiresAt, usedAt (nullable),
createdAt`. Single-use and short-lived (1 hour).

Both token tables store only a SHA-256 hash of the random token, never the token itself — mirroring
how `passwordHash` never stores the plaintext password. The random token is generated with
`crypto.randomBytes(32)` (Node's CSPRNG, already used elsewhere in the codebase's webhook-signature
code path), base64url-encoded for the URL/email, and only the hash is persisted. This means a
database read (backup, replica, admin query, log of a slow query) can never yield a usable token.

## 4. Flows

### 4.1 Invitation issuance (admin-only, tenant-scoped)

`POST /auth/admin/invitations` (new, `requireAuth` + `requireRole(BROKERAGE_ADMIN_ROLES)`):
brokerage admin supplies `{ email, role }`. Server generates the token, stores its hash with a
7-day expiry, and sends it through the email adapter (§6). Re-inviting an email with a pending,
unexpired invitation revokes the old one first (one live invitation per email at a time — prevents
token pile-up and confusing "which link is valid" support questions). Audited as
`invitation_created`.

### 4.2 Invitation acceptance → password creation → email verification

`GET /auth/invitations/:token/status` (public, rate-limited) — tells the frontend only "valid /
expired / already used" (no email or role echoed back, so a guessed/leaked token from a link
preview can't itself leak who was invited).

`POST /auth/invitations/:token/accept` — body `{ password }` only. Server:
1. Hashes the presented token, looks up an invitation with a matching hash, unexpired,
   unaccepted, unrevoked.
2. Validates password strength server-side (minimum length + a check against a small
   common-password denylist — not a full breach-corpus check, recorded as a pre-GA hardening
   item).
3. Creates (or, on rare re-invite-after-partial-signup race, updates) the user row with
   `passwordHash`, `emailVerifiedAt = now()`, `role`/`brokerageId` **taken from the invitation
   row, never from the request body**.
4. Marks the invitation `acceptedAt = now()`.
5. Logs the caller in immediately (same `setSessionCookie` as today).
6. Audits `invitation_accepted` and `user_signed_up` (email + userId + brokerageId only).

Email ownership is proven by possession of the invitation link, delivered only to the invited
address — the same trust model used by essentially every SaaS invitation flow.

### 4.3 Login

`POST /auth/login` — body `{ email, password }`. Server:
1. Looks up user by email. If absent, **or** `disabledAt` set, **or** `passwordHash` null (never
   completed an invitation), **or** password wrong, **or** currently locked
   (`lockedUntil > now()`) — return the **same** `401 { error: "Invalid email or password" }` in
   every case, same response shape and (as close as practical) response time, so none of these
   states is distinguishable from outside. This is the enumeration-resistance requirement.
2. On wrong password: increment `failedLoginAttempts`; if it crosses a threshold (5), set
   `lockedUntil = now() + 15m` and reset the counter on next successful login. Audited as
   `login_failed` (email only, never the attempted password) and, on lockout, `account_locked`.
3. On success: reset `failedLoginAttempts` to 0, issue the session cookie, audit `user_signed_in`
   (already exists; reused as-is).

`authRateLimiter` (existing, `middlewares/rateLimit.ts`, already mounted ahead of the whole
`/auth` router) continues to bound brute-force attempts per-IP; the per-account lockout above adds
a second, IP-independent layer.

### 4.4 Logout / session revocation

Unchanged — `POST /auth/logout` already bumps `sessionEpoch` (§ Phase 1 report §2). No new code
needed; Phase 5 adds coverage that this still works against a password-authenticated session, not
just a dev-login one.

### 4.5 Forgotten password / reset

`POST /auth/password-reset/request` — body `{ email }`. **Always** returns `202` regardless of
whether the email exists (no account-existence leak). If it does exist, generates a reset token
(§3), emails it, audits `password_reset_requested`.

`POST /auth/password-reset/confirm` — body `{ token, password }`. Validates the token (hash match,
unexpired, unused), sets the new `passwordHash`, marks the token `usedAt = now()`, **increments
`sessionEpoch`** (revoking every existing session for that user — a password reset must invalidate
any session an attacker may already hold), audits `password_reset_completed`. Generic error on any
invalid/expired/reused token, again to avoid leaking which case applies.

Password **change** (a logged-in user changing their own password, not via the forgot-password
flow) reuses the same "bump `sessionEpoch`" rule — implemented in Phase 4 as
`POST /auth/change-password` for completeness, requiring the current password.

### 4.6 Disabled / removed-tenant / role-change handling

`loadSession` (middleware) already checks `isActive` alongside the epoch check on every request,
rejecting with 401 exactly like a revoked session — this pre-dates this remediation and needed no
change. What Phase 4 adds is a real, tenant-scoped, audited way to *flip* that flag:
`POST /auth/admin/users/:id/disable` sets `isActive = false` **and** bumps `sessionEpoch` in the
same update, so an already-issued token is dead immediately, not just on its next epoch-check miss;
`POST /auth/admin/users/:id/enable` reverses it. Role changes take effect on the user's next request
automatically, since role is read fresh from the DB on every request (never cached in the token) —
no extra work needed.

## 5. Tenant / role model

No change to the existing flat per-brokerage role set. Invitations are always scoped to exactly one
`brokerageId` and one `role` from the existing `USER_ROLES` enum, chosen by the inviting admin —
never by the invitee. This preserves the existing "first user in a new brokerage becomes its admin"
bootstrap logic for **brand-new brokerages only** (a brokerage with zero users still needs a first
admin — see §7 for how that now happens for the pilot's very first tenant instead of relying on
dev-login).

## 6. Email delivery

New `apps/api/src/lib/auth/email.ts` — deliberately **not** under
`lib/communications/providers/`, and not built on that module's `EmailProvider`/`SendEmailInput`
interface: that interface is designed around the Communications Hub's outbox (idempotency keys,
quiet-hours deferral, retry/backoff scheduling), which is the wrong delivery model for a
synchronous, time-limited security token. `lib/auth/email.ts` mirrors the existing
`sandboxEmailProvider` *pattern* (`communications/providers/sandboxEmail.ts`) without reusing its
interface: a small interface (`sendInvitation`, `sendPasswordReset`) with one implementation for
this pilot —
`sandboxAuthEmailProvider`, which does **not** perform any real network delivery. In test/dev it
records the rendered message (recipient + template name only, never appended to any response body)
so tests can assert an email "was sent" without a real provider. **Production API responses never
return the token** — the sandbox provider is explicitly disallowed from being selected when
`isProductionEnvironment()` is true (Phase 3 fail-closed pattern reused): production startup
requires a real, approved email provider to be configured, or the process refuses to start
(`assertAuthEmailProviderConfigured()`, alongside the existing `assertSessionSecretConfigured()`
boot check). No real email provider is integrated in this pass — procuring/approving one is listed
as an outstanding external dependency in the final gate report (Phase 12), consistent with the
Owner's decision that only test/sandbox external services are authorised right now.

## 7. Admin bootstrap

A brand-new pilot database has zero users, so nothing can invite the first admin. Phase 4 adds a
one-time, explicit CLI command — `pnpm --filter @aee/api run bootstrap-admin -- --email <e> --brokerage <name>`
— documented in full in the deployment runbook (Phase 9). It:
- Refuses to run unless invoked explicitly with all required flags (never runs as part of ordinary
  `npm start`/boot).
- Prompts for a password via a non-echoing stdin read (never accepted as a CLI argument, so it
  never lands in shell history or process-list output).
- Refuses if a user already exists for that email, and refuses if the target brokerage already has
  an admin — it cannot silently recreate or overwrite an existing admin account.
- Creates the brokerage (if new) and the admin user with `emailVerifiedAt` set (an operator running
  a deliberate CLI command on a trusted machine is a different trust boundary than an unverified
  public signup).
- Writes an audit record (`admin_bootstrapped`) so the action is traceable.

## 8. What is explicitly out of scope this pass

- MFA/SSO (recorded as pre-GA, §2).
- A production email provider integration (external approval required — Owner decision).
- Self-service brokerage signup (invitations remain admin-issued only, matching "invitation-only"
  in the Owner's own framing).
- Full breach-corpus password-strength checking (denylist + length only).

## 9. Audit events introduced

`invitation_created`, `invitation_revoked`, `invitation_accepted`, `login_failed`,
`account_locked`, `password_reset_requested`, `password_reset_completed`, `password_changed`,
`account_disabled`, `account_enabled`, `admin_bootstrapped` — all via the existing `logAudit()`
helper, `recordType: "user"` or `"invitation"`, never carrying a password, token, or token hash in
`previousValue`/`updatedValue` (only counters, booleans, or ids, matching the existing
`sessionEpoch` audit precedent already in `auth.test.ts:270-273`).
