#!/usr/bin/env bash
#
# Canonical local runner for the @aee/api test suite.
#
# WHY THIS EXISTS
#
# The API tests need three environment values that CI supplies at job level
# (.github/workflows/ci.yml) but that nothing supplies in a fresh git worktree,
# because `apps/api/.env` is gitignored and therefore absent:
#
#   NODE_ENV=test        - without it the rate limiter stays at production
#                          settings and a full serial run produces spurious
#                          HTTP 429s partway through.
#   ALLOW_DEV_AUTH=true  - without it the dev-login endpoint 404s and every
#                          suite that authenticates fails with "dev-login 404".
#   SESSION_SECRET=...   - without it the fail-closed check in
#                          apps/api/src/lib/session.ts refuses to start.
#
# Each failure looks exactly like a real regression, which has repeatedly cost
# review time chasing defects that were never there. Running through this
# script makes a local run match CI instead.
#
# USAGE
#
#   DATABASE_URL=postgres://user:pass@host:port/db scripts/run-api-tests.sh
#       Runs the full suite, exactly as CI does.
#
#   DATABASE_URL=... scripts/run-api-tests.sh src/routes/__tests__/foo.test.ts
#       Runs only the given files (paths are relative to apps/api).
#
# NOTES
#
#   * DATABASE_URL is required and never defaulted. Pointing a test run at the
#     wrong database is not a mistake this script should make easy.
#   * Use a dedicated, disposable database. The suite is order- and
#     state-sensitive when several runs share one database, which produces
#     disjoint, non-reproducible failure sets.
#   * The server must be running with `-c timezone=UTC`. Entitlement columns are
#     `timestamp without time zone`, so a non-UTC session clock fails roughly
#     200 tests for reasons that have nothing to do with the code under test.
#   * Any value already exported in your shell wins, so this can be overridden
#     per run without editing the script.
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  cat >&2 <<'EOF'
error: DATABASE_URL is not set.

Set it to a dedicated, disposable test database, for example:

  DATABASE_URL=postgres://aee_ci:aee_ci_password@127.0.0.1:5432/aee_test \
    scripts/run-api-tests.sh

Apply the schema to a new database first with:

  DATABASE_URL=... pnpm --filter @aee/db run db:push
EOF
  exit 2
fi

# Mirrors .github/workflows/ci.yml. Same placeholder secret, which that
# workflow already documents as a non-credential that exists only to satisfy
# this repository's own fail-closed startup check. Nothing here is a real
# secret and nothing here is used outside a test run.
export NODE_ENV="${NODE_ENV:-test}"
export ALLOW_DEV_AUTH="${ALLOW_DEV_AUTH:-true}"
export SESSION_SECRET="${SESSION_SECRET:-ci-only-non-production-session-secret-value-not-a-real-secret}"

cd "$repo_root/apps/api"

if [[ $# -eq 0 ]]; then
  # No arguments: defer to the package's own test script so the file list stays
  # single-sourced in apps/api/package.json and cannot drift from CI.
  exec pnpm run test
fi

exec npx tsx --test --test-timeout=120000 "$@"
