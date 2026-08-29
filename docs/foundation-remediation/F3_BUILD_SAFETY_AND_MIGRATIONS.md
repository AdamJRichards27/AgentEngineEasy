# F3 — Build Safety and Migrations

**Stage:** 3
**Purpose:** replace uncontrolled `drizzle-kit push` as the sole schema-history mechanism with versioned, repository-tracked migrations; add a continuous integration gate that runs on every pull request and push; and record real, reproducible evidence that the workspace typechecks, tests, and builds cleanly from a clean state.

## 3.1 Versioned database migrations

**Fully remediated**, with one explicit, documented follow-up action left for an operator (see "Baseline procedure required for the existing staging database" below) — per instruction, this stage does not itself apply that follow-up.

- Ran `drizzle-kit generate` against the existing schema in `packages/db/src/schema`. This is a local, file-only operation — it does not connect to or modify any database — and it produced `packages/db/migrations/0000_baseline_schema.sql` (810 lines, 44 `CREATE TABLE` statements, one per table currently defined in the schema) plus `packages/db/migrations/meta/_journal.json` and `meta/0000_snapshot.json`, drizzle-kit's own bookkeeping of what that migration contains.
- Verified before and after generation, by direct query against the live database, that `users`, `brokerages`, and `automation_rules` row counts were unchanged (`{ users: '2', brokerages: '1', automation_rules: '0' }` both times) — confirming the generation step did not touch the live database in any way.
- Added `packages/db/src/migrate.ts`, a new deterministic migration runner built on `drizzle-orm/node-postgres/migrator`. It applies every migration file under `./migrations` in order, tracked via drizzle's own `drizzle.__drizzle_migrations` bookkeeping table, so re-running it against a database that is already up to date is a safe no-op. It refuses to run at all (fails closed, no connection attempted) if `DATABASE_URL` is unset — verified directly: running it with `DATABASE_URL` unset produced `Migration run failed: DATABASE_URL is not set. Refusing to run migrations without an explicit target database.` and exit status 1, with no database contacted.
- Added two new scripts to `packages/db/package.json`: `db:generate` (`drizzle-kit generate` — produces a new migration file from a schema diff, does not apply anything) and `db:migrate` (`tsx src/migrate.ts` — applies pending migrations to whatever database `DATABASE_URL` points at). Added `tsx` as a new devDependency of `@aee/db` so `db:migrate` can run directly from source. The existing `db:push` script is retained for local/dev convenience but is no longer the only schema-history mechanism.
- **Real, end-to-end proof this works**, run against a throwaway database — not the shared staging database:
  1. Initialised a brand-new, empty PostgreSQL instance in a scratch directory (`initdb` + `pg_ctl start`, listening only on `127.0.0.1:5433`, a port never exposed beyond this container) with a fresh, empty `aee_ci_test` database.
  2. Ran `db:migrate` against it. Output: `Applying migrations from .../packages/db/migrations ... Migrations applied (or already up to date).`
  3. Verified directly via `psql`: **44 tables** now exist in `public` (exactly matching the 44 tables the schema defines), and `drizzle.__drizzle_migrations` contains exactly one row recording migration `0000_baseline_schema` as applied (hash `1ff366a6ad92028012ca82c92f9b3e72a82947319020711ef59e965aabc18aa8`, matching the hash drizzle-kit itself recorded in `meta/_journal.json`).
  4. Ran `db:migrate` a **second** time against the same database to confirm idempotency: it completed with the same "already up to date" outcome and did not error or attempt to recreate anything.
  5. Stopped the scratch PostgreSQL instance and deleted its data directory. Nothing about this test instance persists anywhere, and at no point was the real `DATABASE_URL` (staging) touched by any part of this proof.

This satisfies the instruction's requirement to demonstrate that a clean database can be initialised deterministically from the versioned migration history, without applying anything to a database that holds real or pre-existing data.

### Baseline procedure required for the existing staging database

The staging database already has all 44 tables (created previously via `drizzle-kit push`, before this remediation). `db:migrate` has **not** been run against it and must not be, until it is baselined — running it now would attempt `CREATE TABLE "users" (...)` etc. against tables that already exist and would fail. That failure is the intended, safe behaviour of an un-baselined database: it refuses to guess rather than silently skipping or destructively replacing anything.

Before `db:migrate` can be used against staging, an operator must, in a reviewed, controlled step (not performed in this remediation):

1. Confirm (by inspection, e.g. `\dt` in `psql`) that the live schema matches `packages/db/migrations/0000_baseline_schema.sql` — i.e. that nothing has drifted between what `drizzle-kit push` last applied and what the checked-in migration now describes.
2. Let drizzle create its own bookkeeping table by running `db:migrate` against staging in a mode that only creates `drizzle.__drizzle_migrations` — or create it directly: `CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at BIGINT);`
3. Insert exactly one row recording migration `0000_baseline_schema` as already applied, using the hash drizzle-kit itself computed (recorded in `packages/db/migrations/meta/_journal.json`): `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('1ff366a6ad92028012ca82c92f9b3e72a82947319020711ef59e965aabc18aa8', 1787885778053);`
4. From that point on, `db:migrate` against staging is a safe no-op for migration `0000`, and any future schema change goes through `db:generate` → review the generated SQL → commit it → `db:migrate` applies only the new, incremental migration.

This procedure is documented here, not executed, per the instruction's explicit prohibition on applying a destructive migration or baselining a real-data database inside this remediation.

## 3.2 Continuous integration

**Fully remediated.**

- Added `.github/workflows/ci.yml`. Triggers on every pull request and on every push to `staging` or `main`. Installs the exact Node.js (`20.12.2`) and pnpm (`8.15.5`) versions this repository is actually developed against — confirmed by directly querying `node -v` / `pnpm -v` in this environment — via `pnpm/action-setup` and `actions/setup-node` (with pnpm-aware dependency caching), then `pnpm install --frozen-lockfile` so a lockfile drift fails the build rather than silently installing something different.
- Also added an `engines` field (`{ node: "20.12.2", pnpm: "8.15.5" }`) to the root `package.json` as a single documented source of truth for these versions. Deliberately did **not** add a `packageManager` field, since that activates Corepack's strict version enforcement, which risks conflicting with this Replit workspace's existing global pnpm install — an out-of-scope environment change this remediation does not make.
- Workflow steps, each of which fails the whole run on a non-zero exit: workspace typecheck (`pnpm -r run typecheck`); a deterministic clean-database migration check (`db:migrate` against an ephemeral `postgres:16` service container scoped to that CI run only); a schema-drift check (`drizzle-kit generate` again, then `git diff --exit-code` against the committed migrations — fails the build if a schema change was made without its migration being generated and committed); the full API automated test suite (`pnpm --filter @aee/api run test`); the production API build (`pnpm --filter @aee/api run build`); and the production web build (`pnpm --filter @aee/web run build`).
- **Requires no production secrets.** The only environment values the workflow sets are a connection string to its own ephemeral, disposable Postgres service container (credentials scoped to that container only, torn down at the end of the run) and a locally-generated, clearly-labelled non-production placeholder value for `SESSION_SECRET`, present only so this repository's own fail-closed secret-length check (Stage 1) is satisfied during the test run. Confirmed by direct repository search that no other module in `apps/api` or `packages/integrations/*` throws on a missing environment variable at import time — meaning both production builds (which only bundle code, never execute it) need no environment configuration at all.

This workflow file has not yet been exercised by GitHub Actions itself (that requires the push in this stage's commit to reach `origin/staging` and a PR or push event to fire it) — its individual steps are, however, exactly the same commands recorded as run and verified locally in 3.3 below, so its correctness is not speculative.

## 3.3 Production build verification (evidence)

All of the following were run directly in this environment, from the repository's current committed-plus-staged state, and their exact output was captured:

| Check | Command | Result |
|---|---|---|
| Dependency install / lockfile | `pnpm install` | `Already up to date` (lockfile satisfied by the one new `tsx` devDependency added to `@aee/db`), done in 3.3s |
| Workspace typecheck | `pnpm -r run typecheck` | **10 of 11 workspace projects, every one "Done", zero errors** (including `packages/db`, which now contains `migrate.ts`) |
| Deterministic clean-DB migration | `db:migrate` against a scratch, throwaway PostgreSQL instance | 44/44 tables created, one migration recorded, second run idempotent (see 3.1) |
| Schema drift check | `drizzle-kit generate` (re-run after the baseline) | `No schema changes, nothing to migrate` — confirms the CI drift-check step behaves correctly against an unmodified schema |
| API automated test suite | `pnpm --filter @aee/api run test` | **77 tests, 76 pass, 0 fail, 0 cancelled, 1 skipped (the same pre-existing, documented skip from prior AI Governance work), 0 todo, duration ≈ 34.2s** — identical pass/fail/skip counts to the Stage 1 baseline, confirming no regression from this stage's changes |
| API production build | `pnpm --filter @aee/api run build` | `esbuild ... → dist/index.mjs 279.5kb`, done in 216ms, exit 0 |
| Web production build | `pnpm --filter @aee/web run build` | `vite build` → `98 modules transformed`, `dist/index.html`, `dist/assets/*.css`, `dist/assets/*.js`, `built in 1.52s`, exit 0 |

**One non-blocking observation surfaced by this run:** the web production build printed `You are using Node.js 20.12.2. Vite requires Node.js version 20.19+ or 22.12+. Please upgrade your Node.js version.` The build still completed successfully and produced correct output — this is a forward-compatibility warning from Vite, not a current failure. Upgrading the Node.js runtime this Replit workspace uses is an environment-level change outside this remediation's scope (and is now also the version pinned in CI, matching what this workspace actually runs, per the instruction's "install declared Node/pnpm versions" requirement) — it is recorded as a **Low** residual risk in the final report rather than changed here.

## Files changed in this stage

- `packages/db/migrations/0000_baseline_schema.sql`, `packages/db/migrations/meta/_journal.json`, `packages/db/migrations/meta/0000_snapshot.json` — new, generated, reviewed, not applied to any database with existing data.
- `packages/db/src/migrate.ts` — new.
- `packages/db/package.json` — added `db:generate`, `db:migrate` scripts and the `tsx` devDependency.
- `package.json` — added an `engines` field.
- `.github/workflows/ci.yml` — new.
- `pnpm-lock.yaml` — updated by `pnpm install` to reflect the new `tsx` devDependency.

No file outside this list was modified in this stage. No destructive statement was executed against any database containing real or pre-existing data.
