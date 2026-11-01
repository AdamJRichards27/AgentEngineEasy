#!/usr/bin/env bash
# testing/r1: back up, wipe and rebuild the DEDICATED TESTING DB (synthetic data only).
# Refuses unless the DB carries ae_env.marker for itself and CONFIRM_DB matches.
# Usage: CONFIRM_DB=<db name> ops/testing/reset-testing-db.sh   (DATABASE_URL from the testing Repl's Secrets)
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL not set}"; : "${CONFIRM_DB:?CONFIRM_DB not set}"
q() { psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }
name=$(q "select current_database()")
[ "$name" = "$CONFIRM_DB" ] || { echo "Refusing: CONFIRM_DB does not match the connected database"; exit 1; }
[ "$(q "select count(*) from ae_env.marker where env='testing' and db_name=current_database()" 2>/dev/null || echo 0)" = "1" ] || { echo "Refusing: not flagged as the testing DB"; exit 1; }
[ "$(q "select count(*) from users where email not like '%@'||coalesce(nullif('${SEED_EMAIL_DOMAIN:-}',''),'agentengine-testing.invalid')" 2>/dev/null || echo 0)" = "0" ] || { echo "Refusing: non-synthetic users present"; exit 1; }
mkdir -p "$HOME/ae-testing-backups"; umask 077
out="$HOME/ae-testing-backups/$name-$(date +%Y%m%dT%H%M%S%z).dump"
pg_dump "$DATABASE_URL" -Fc -f "$out"; echo "backup: $out"
q "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;"
pnpm --filter @aee/db run db:preflight
pnpm --filter @aee/db run db:migrate
echo "Schema rebuilt. Now run: SEED_TESTING_ENV_CONFIRM=$name SEED_CREDENTIALS_FILE=\$HOME/.ae-testing-credentials-\$(date +%s) pnpm --filter @aee/api run seed-testing-env"
# Restore instead of reseed: pg_restore --clean --if-exists -d "$DATABASE_URL" <dump>
