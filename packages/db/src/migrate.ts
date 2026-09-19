/**
 * Deterministic migration runner for @aee/db.
 *
 * Foundation Remediation Stage 3.1 — this script is the versioned,
 * repository-tracked alternative to relying solely on `drizzle-kit push`
 * for schema changes. It applies the SQL migrations under ./migrations, in
 * order, recording each one in drizzle's own `__drizzle_migrations`
 * bookkeeping table so that re-running this script against a database that
 * is already up to date is a safe no-op.
 *
 * Usage: pnpm --filter @aee/db run db:migrate
 *
 * IMPORTANT — scope of this remediation:
 * This script is NOT executed against the live staging database as part of
 * Foundation Remediation. It exists so that:
 *   (a) a clean database (a CI test database, a fresh local dev database)
 *       can be initialised deterministically from the versioned migration
 *       history in ./migrations, and
 *   (b) an operator can later apply the same migration history to staging
 *       under a controlled, reviewed baseline procedure — see
 *       docs/foundation-remediation/F3_BUILD_SAFETY_AND_MIGRATIONS.md for
 *       the exact steps required before this is safe to run there.
 *
 * Running this against a database that already has the target tables
 * (created previously via `drizzle-kit push`, as staging's are) without
 * first completing that baseline procedure will fail, because the
 * generated 0000_baseline_schema.sql migration issues CREATE TABLE for
 * every table and drizzle has no record of it having already been applied.
 * That failure is the intended, safe behaviour: it refuses to guess.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type ClientBase } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "migrations");

// AE GROW Pilot Readiness WP2a: mirrors ./index.ts's createSafePool()
// deliberately inline rather than importing ./index.ts — importing it would
// construct the application pool as a side effect and replace this runner's
// own "Refusing to run migrations" DATABASE_URL message.
const SESSION_TIMEZONE_SQL = "SET TIME ZONE 'UTC'";

function reportPoolProblem(event: string, err: unknown): void {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  console.error(
    JSON.stringify({
      level: "error",
      event,
      time: new Date().toISOString(),
      errorName: typeof e?.name === "string" ? e.name : undefined,
      errorCode: typeof e?.code === "string" ? e.code : undefined,
      errorMessage:
        typeof e?.message === "string"
          ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "[redacted-connection-string]")
          : undefined,
    }),
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Refusing to run migrations without an explicit target database.",
    );
  }

  // AE GROW Pilot Readiness WP2a: same process-safety behaviour as the
  // application pool (./index.ts createSafePool) — an idle-client error must
  // not crash the runner with an unhandled 'error' event, and every
  // migration session runs in UTC (awaited onConnect hook) so any
  // now()/defaultNow() evaluated by a migration matches the application's
  // UTC wall-clock convention. Opt out with DB_SET_SESSION_TIMEZONE=false.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(process.env.DB_SET_SESSION_TIMEZONE !== "false"
      ? {
          onConnect: async (client: ClientBase) => {
            try {
              await client.query(SESSION_TIMEZONE_SQL);
            } catch (err) {
              reportPoolProblem("db_migrate_session_timezone_set_failed", err);
              throw err;
            }
          },
        }
      : {}),
  });
  pool.on("error", (err) => reportPoolProblem("db_migrate_pool_idle_client_error", err));
  const db = drizzle(pool);

  console.log(`Applying migrations from ${migrationsFolder} ...`);
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied (or already up to date). No destructive statement runs here beyond what each reviewed migration file itself contains.");

  await pool.end();
}

main().catch((err) => {
  console.error("Migration run failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
