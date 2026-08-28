# F0 — Environment and Repository State Report

**Stage:** 0 (read-only inspection, no changes made in this stage)
**Scope:** Agent Engine 2.0 Foundation Remediation — Authentication, Build Safety and Event-Consumer Proof

## Repository state

- Branch: `staging` (HEAD), matches the branch this entire remediation is scoped to work on.
- Latest commit at the start of this stage: `60eda42` — "Add AI Governance, Grow entitlements/billing, and CSV/Excel import pipeline".
- Remotes: `origin` → `https://github.com/AdamJRichards27/AgentEngineEasy.git` (fetch+push), `gitsafe-backup` → `git://gitsafe:5418/backup.git` (fetch+push).
- Working tree at the start of this stage was **not clean**: 3 modified files and 10 untracked items, all attributable to the prior, uncommitted Workflow Automation Engine schema work from an earlier session (event-type catalogue extension, `domainEvents` schema extension, `packages/db/src/schema/automation.ts`, `docs/stage-wf/`, and six generated `tsconfig.tsbuildinfo` files). Nothing in that set was foreign, unexplained, or touched during this inspection. It is preserved and checkpointed in Stage 2 of this remediation, per instruction.
- No branch switching, pulling, merging, rebasing, or pushing was performed during this stage.

## Deployment and exposure

- `.replit` defines a single `Dev` workflow (`pnpm dev:api` plus a Vite dev server on port 5000, mapped 5000→80) and a second, inert `FixConfig` workflow (a benign, previously-verified `.replit` repair payload, not a security concern).
- **No `[deployment]` section exists in `.replit`.** There is no configured Replit Deployment target for this repository — no evidenced persistent, independently-addressed public production URL is defined by this repo's own configuration.
- Replit workspaces are nonetheless served over HTTPS during development (the workspace preview/webview), and workspace reachability outside the owning account depends on Replit account/workspace visibility settings, which are not stored in this repository and cannot be verified from inside the container. **This could not be conclusively verified either way — UNVERIFIED — manual confirmation required** from whoever administers the Replit account (is this workspace public or private under Replit's own sharing settings?).
- No CI/CD configuration exists (`.github/workflows` is absent), so there is no automated deployment pipeline from this repository either.

## Database contents (classification only — no records printed)

A direct, read-only, non-destructive query against the live database connected via `DATABASE_URL` returned:

- `users` row count: **2**
- `brokerages` row count: **1**
- Distinct email domains among those users: **2**
- Earliest user `created_at`: 2026-08-21 01:35:38 UTC
- Latest user `created_at`: 2026-08-21 19:51:05 UTC

Both timestamps fall within an 18-hour window on a single day, immediately preceding this remediation. Combined with the very small row counts, this is consistent with recent development/test activity and **inconsistent with an established production or real-customer dataset**. No user records, email addresses, or other field values were printed or logged as part of this check.

## Identity provider configuration

- No Clerk (or any other third-party identity provider) package reference exists in `apps/api/package.json` or `apps/web/package.json`. Clerk is referenced only in code comments as documented *future* scope, never as a wired dependency or configuration.
- No Clerk-related environment variables were found among configured environment variable names (see below).
- **Conclusion: Clerk is not configured.** Per instruction, no Clerk or other identity-provider credentials were invented or fabricated during this remediation.

## Secrets and environment variables (names only — no values recorded)

The following environment-variable **names** relevant to this remediation are present in this container (values were not read, printed, or logged):

- `DATABASE_URL` — present.
- `PGDATABASE` — present.
- `SESSION_SECRET` — present (its length and strength were checked programmatically by code introduced in Stage 1, not read or printed here).
- `REPLIT_SESSION`, `REPLIT_ASKPASS_PID2_SESSION` — Replit-internal, unrelated to application session handling.
- `NODE_ENV` — **not set** (confirmed: zero-length/unset). `.replit`'s `[env]` section is empty; no workflow sets `NODE_ENV`.
- `ALLOW_DEV_AUTH`, `ALLOW_INSECURE_DEV_COOKIES` — not set prior to this remediation (these are new flags introduced by Stage 1; see F1 report).

## Current authentication surface (before Stage 1 changes)

- `POST /api/auth/dev-login` (`apps/api/src/routes/auth.ts`) — present, mounted, and reachable with no environment gate of any kind.
- `GET /api/auth/known-users` (`apps/api/src/routes/auth.ts`) — present, mounted, unauthenticated, and reachable with no environment gate of any kind.
- Confirmed via direct grep of `apps/api/src/routes/auth.ts` and `apps/api/src/routes/index.ts`: **zero** matches for `NODE_ENV`, `isProd`, or any other environment/production check anywhere in the auth route file or its mount point (`apiRouter.use("/auth", authRouter)`, unconditional).
- `apps/web/src/pages/Login.tsx` depends on both endpoints as its only sign-in mechanism (an unauthenticated "known users" picker plus a manual-entry form that also posts to `/dev-login`). This is the frontend dependency that Stage 1 had to account for when gating the backend routes.

## Session mechanism (before Stage 1 changes)

- `apps/api/src/lib/session.ts`: HMAC-SHA256-signed cookie, cookie name `aee_session`, 30-day `Max-Age`.
- `secret()` fell back to a **hardcoded, publicly-visible-in-source default secret** (`"aee-dev-insecure-default-secret-set-SESSION_SECRET-in-env"`) whenever `process.env.SESSION_SECRET` was unset, rather than refusing to start.
- The signed cookie was set with `Path=/; HttpOnly; SameSite=Lax; Max-Age=<30 days>` — **no `Secure` attribute**.
- `verifySessionToken()` checked the HMAC signature (correctly, in constant time) but performed **no server-side expiry check** against the token's own `iat` timestamp — a captured or replayed token would remain valid indefinitely from the server's point of view, regardless of the cookie's own `Max-Age`.

## Migration method

- `packages/db/drizzle.config.ts` nominally points `out` at `./migrations`, but **that directory does not exist anywhere in the repository** (confirmed: `ls` reports "No such file or directory").
- The only schema-application mechanism in use is `drizzle-kit push` (`pnpm --filter @aee/db run db:push`), a live schema-diff-and-apply tool with no persisted migration history, no forward/rollback record, and no staged review step.

## CI configuration

- `.github/workflows` does not exist. There is no automated build, typecheck, or test gate on any push or pull request today.

## Uncommitted Workflow Automation Engine files (identified, not modified in this stage)

Confirmed present and unchanged since the start of this stage:

- Modified: `packages/db/src/schema/events.ts`, `packages/db/src/schema/index.ts`, `packages/events/src/types.ts`.
- Untracked: `docs/stage-wf/`, `packages/db/src/schema/automation.ts`, and six generated `*/tsconfig.tsbuildinfo` files across `packages/db`, `packages/events`, and four `packages/integrations/*` workspaces.

These are addressed under Stage 2 (checkpointing), not this stage.

## Environment classification

**`PRIVATE STAGING`** (working classification for the purposes of the mandatory safety gate below), with one point left **UNVERIFIED — manual confirmation required**: whether this Replit workspace's preview/webview is reachable by anyone outside the owning Replit account under Replit's own workspace-sharing settings. No configured Replit Deployment target exists, no CI/CD exists, and the database contents are consistent with small-scale recent test activity rather than production data — but Replit account-level visibility is outside this repository's own configuration and could not be conclusively confirmed from inside the container.

Per instruction, since exposure could not be fully verified, this remediation proceeded as though the environment **could** be reachable beyond the immediate trusted developer — i.e. the safer configuration was used throughout Stage 1, regardless of this classification.

## Mandatory safety gate

Applying the instruction's gate ("if the environment is publicly reachable or contains real data" / "if exposure cannot be verified, treat it as potentially public and use the safer configuration"):

1. `POST /api/auth/dev-login` has been hard-gated to refuse (404) unless an operator has explicitly set `ALLOW_DEV_AUTH=true` — see F1 report. **Done.**
2. `GET /api/auth/known-users` has been hard-gated the same way. **Done.**
3. No deployment was performed at any point in this remediation.
4. This exposure assessment is reported above and repeated in the F1 and final reports.
5. Remediation continued only with repository-level, non-destructive changes; no real data was read, exported, modified, or deleted.
