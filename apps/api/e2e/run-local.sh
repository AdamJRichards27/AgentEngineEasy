#!/usr/bin/env bash
# GR-E2E local runner. Starts a throwaway PG16 on a free loopback port
# (unless DATABASE_URL is already set), applies the committed migrations to
# that scratch DB only, runs the Grow smoke, then stops and deletes the DB.
# Needs: PG16 server binaries in $PGBIN (initdb, pg_ctl), Chrome/Chromium in
# $CHROME_BIN (default google-chrome). No network services are contacted.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
api="$(cd "$here/.." && pwd)"
export NODE_ENV=test ALLOW_DEV_AUTH=true
export SESSION_SECRET="${SESSION_SECRET:-e2e-only-session-secret-placeholder-0123456789abcdef}"
cleanup() { :; }
if [ -z "${DATABASE_URL:-}" ]; then
  : "${PGBIN:?set PGBIN to a PostgreSQL 16 bin directory, or set DATABASE_URL}"
  port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  data="$(mktemp -d)"
  "$PGBIN/initdb" -D "$data" -U e2e --auth=trust >/dev/null
  "$PGBIN/pg_ctl" -D "$data" -o "-p $port -h 127.0.0.1 -k $data" -l "$data/pg.log" start -w >/dev/null
  cleanup() { "$PGBIN/pg_ctl" -D "$data" stop -m fast >/dev/null 2>&1 || true; rm -rf "$data"; }
  trap cleanup EXIT
  export DATABASE_URL="postgresql://e2e@127.0.0.1:$port/postgres"
fi
case "$DATABASE_URL" in *127.0.0.1*|*localhost*) ;; *) echo "refusing: DATABASE_URL is not loopback" >&2; exit 2;; esac
(cd "$api/../../packages/db" && npx tsx src/migrate.ts)
cd "$api" && npx tsx --test --test-timeout=180000 e2e/growSmoke.e2e.ts
