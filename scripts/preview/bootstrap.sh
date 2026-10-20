#!/usr/bin/env bash
# PREVIEW-ONLY. Run once in the NEW isolated preview Repl's Shell, after its own
# Replit PostgreSQL database has been created (DATABASE_URL set by Replit).
# Applies all migrations (0000..0036) to that EMPTY database, then seeds
# synthetic demo data. Refuses if the DB already has users.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${DATABASE_URL:?DATABASE_URL not set — create the preview Repl's own database first}"
if [[ "${AE_PREVIEW_REPL:-}" != "true" ]]; then
  echo "Refusing: set AE_PREVIEW_REPL=true in this preview Repl's Secrets first (guards against running in the dev Repl)." >&2; exit 1
fi
export PATH="$HOME/.local/bin:$PATH"
pnpm install --frozen-lockfile
pnpm --filter @aee/db run db:migrate
CRED="$PWD/.preview-credentials"
( cd apps/api && AE_PREVIEW_DEMO_SEED=true AE_PREVIEW_ALLOW_ANY_DB_NAME=true AE_PREVIEW_CREDENTIALS_FILE="$CRED" NODE_ENV=development npx tsx src/scripts/previewDemoSeed.ts )
echo "Done. Demo sign-ins are in .preview-credentials (open it in the Files pane; do not paste it into chat)."
