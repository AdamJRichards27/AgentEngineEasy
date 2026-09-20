import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type ClientBase, type PoolConfig } from "pg";
import * as schema from "./schema/index";
import migrationJournal from "../migrations/meta/_journal.json";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set. AgentEngineEasy uses its own database — " +
      "do not point this at AgentEngineStaging's database. See .env.example.",
  );
}

/**
 * AE GROW Pilot Readiness WP2a — UTC session guarantee.
 *
 * Every timestamp column in this schema is `timestamp without time zone`.
 * drizzle serialises/parses those values as UTC wall-clock, but anything the
 * DATABASE computes (defaultNow(), now(), CURRENT_TIMESTAMP, interval
 * cut-offs written in SQL) uses the SESSION TimeZone. On a non-UTC session
 * every such value silently shifts by the UTC offset — entitlement windows,
 * cut-offs and retention clocks drift by hours.
 *
 * So every new pool connection runs `SET TIME ZONE 'UTC'` in pg-pool's
 * awaited `onConnect` hook — the connection is only handed to a caller
 * after the SET has completed (no reliance on pg's deprecated implicit
 * query queueing). If the SET fails, that connection is discarded and the
 * checkout fails: better an error than a query silently running in the
 * wrong zone. PgBouncer tracks TimeZone as a reported parameter and
 * re-applies it across server connections, but some poolers reject or
 * discard session SETs; for those an operator may opt out with
 *
 *   DB_SET_SESSION_TIMEZONE=false
 *
 * in which case the database/role DEFAULT time zone must itself be UTC
 * (`ALTER DATABASE <db> SET timezone TO 'UTC'`). apps/api verifies the
 * effective session time zone at startup (apps/api/src/lib/dbTimezone.ts)
 * and refuses to start in production if it is not UTC, whichever path is
 * used. Any value other than the literal string "false" keeps the SET on.
 *
 * DEPENDENCY FLOOR (independent-review remediation): `onConnect` only exists
 * in recent pg/pg-pool. This package and apps/api therefore declare
 * `"pg": "^8.16.0"`, not the older `^8.13.0` — under the old range a
 * non-frozen install could resolve a pg without `onConnect`, in which case
 * the option below would be accepted, ignored, and every connection would
 * silently skip `SET TIME ZONE 'UTC'` with no error anywhere. Keep both
 * package.json ranges and the lockfile in step when changing this.
 */
export function isSessionTimezoneSetEnabled(): boolean {
  return process.env.DB_SET_SESSION_TIMEZONE !== "false";
}

export const SESSION_TIMEZONE_SQL = "SET TIME ZONE 'UTC'";

/**
 * Structured one-line report for pool-level problems. packages/db has no
 * dependency on @aee/events, so this writes the same single-line JSON shape
 * directly to stderr. Only the error's class, code and message are included
 * — never the connection string, credentials, or query parameters.
 */
export function reportPoolProblem(event: string, err: unknown): void {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const line = JSON.stringify({
    level: "error",
    event,
    time: new Date().toISOString(),
    errorName: typeof e?.name === "string" ? e.name : undefined,
    errorCode: typeof e?.code === "string" ? e.code : undefined,
    errorMessage:
      typeof e?.message === "string"
        ? e.message.replace(/postgres(ql)?:\/\/\S+/gi, "[redacted-connection-string]")
        : undefined,
  });
  console.error(line);
}

/**
 * pg-pool `onConnect` hook applying the UTC session time zone (see above).
 * Exported so tests (and any other pool in this repository) use exactly the
 * same behaviour.
 */
export async function applySessionTimezone(client: Pick<ClientBase, "query">): Promise<void> {
  try {
    await client.query(SESSION_TIMEZONE_SQL);
  } catch (err) {
    reportPoolProblem("db_session_timezone_set_failed", err);
    throw err;
  }
}

/**
 * Builds a Pool with the process-safety behaviour every pg Pool in this
 * repository must have:
 *
 * - an 'error' listener: pg emits 'error' on the pool when an IDLE client
 *   loses its connection (DB restart, failover, network drop). With no
 *   listener Node treats it as an unhandled 'error' event and crashes the
 *   whole process. The pool already discards the broken client, so logging
 *   is all that is needed; the next checkout opens a fresh connection.
 * - the UTC session time zone on every new connection, unless opted out.
 * - an optional PG_POOL_MAX size cap (see configuredPoolMax).
 */
function configuredPoolMax(): number | undefined {
  const raw = process.env.PG_POOL_MAX?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function createSafePool(
  connectionString: string,
  opts?: { setSessionTimezone?: boolean; extra?: Omit<PoolConfig, "connectionString" | "onConnect"> },
): Pool {
  const setTimezone = opts?.setSessionTimezone ?? isSessionTimezoneSetEnabled();
  // pg's default of 10 clients suits one API process, but a test run starts a
  // pool per test file: on a many-core machine that can exceed the server's
  // max_connections, and a refused connection surfaces as a confusing 401
  // (the session lookup fails) rather than a connection error. PG_POOL_MAX
  // caps it; an absent or invalid value keeps pg's default.
  const poolMax = configuredPoolMax();
  const created = new Pool({
    ...opts?.extra,
    ...(poolMax === undefined ? {} : { max: poolMax }),
    connectionString,
    ...(setTimezone ? { onConnect: applySessionTimezone } : {}),
  });
  created.on("error", (err) => reportPoolProblem("db_pool_idle_client_error", err));
  return created;
}

export const pool = createSafePool(process.env.DATABASE_URL);

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — optional statement
 * observer.
 *
 * The sweep's central design claim is that it issues a BOUNDED number of
 * statements per brokerage regardless of how many candidates that brokerage
 * has (set queries + batched upserts, never a SELECT+UPDATE per candidate).
 * That claim is only worth making if it is asserted, so this package exposes
 * one pluggable observer that drizzle calls once per statement it issues.
 *
 * No observer is installed by default and the hook is a single optional call
 * through a module-local binding, so the production cost is nil. Statements
 * issued directly on `db.$client` (the sweep's dedicated advisory-lock
 * connection) are NOT seen here — those are a fixed two per run by
 * construction, which is exactly why they need no instrumentation.
 *
 * TEST-ONLY, AND GATED (independent-review remediation P2-5). An observer
 * installed here sees EVERY statement this process issues and its BIND
 * PARAMETERS — session and auth lookups, party PII, consent writes — for
 * every tenant, with no brokerage scope and no redaction. That is an
 * assertion seam, not an observability feature, so like
 * lib/propertyIntelligence/sweep.ts's tryHoldSignalSweepLockForTests() and
 * resetSweepResumePointForTests() it refuses to install outside
 * NODE_ENV === "test". Anything that wants production statement telemetry
 * must add something purpose-built that redacts parameters.
 */
export type DbQueryObserver = (query: string, params: unknown[]) => void;

let dbQueryObserver: DbQueryObserver | null = null;

/**
 * Installs the process-wide statement observer and returns its uninstall
 * function. Test-only; see above.
 *
 * Uninstall CLEARS the observer rather than restoring whatever was installed
 * before it. Restoring a captured `previous` looks tidier but is wrong under
 * out-of-order teardown: uninstalling an older handle would reinstate a stale
 * observer and leave the tap live for the rest of the process. There is no
 * legitimate use for nesting these, so clearing is both simpler and the only
 * behaviour with no way to leak.
 */
export function setDbQueryObserver(observer: DbQueryObserver | null): () => void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("setDbQueryObserver is a test-only seam and is unavailable outside tests.");
  }
  dbQueryObserver = observer;
  return () => {
    dbQueryObserver = null;
  };
}

export const db = drizzle(pool, {
  schema,
  logger: {
    // Reachable only when a test has installed an observer; setDbQueryObserver
    // refuses to install one outside NODE_ENV === "test", so in production
    // this is a null check per statement and nothing else can ever be handed
    // a query or its parameters.
    logQuery(query: string, params: unknown[]): void {
      dbQueryObserver?.(query, params);
    },
  },
});

/**
 * AE GROW Pilot Readiness WP2a — the migration journal shipped with this
 * build. Imported as JSON so esbuild inlines it into the API bundle:
 * readiness never depends on the migrations folder existing next to dist/
 * at runtime. apps/api/src/routes/health.ts compares
 * drizzle.__drizzle_migrations against this.
 */
export const EXPECTED_MIGRATIONS: Readonly<{ count: number; latestTag: string; latestWhen: number }> = (() => {
  const entries = (migrationJournal as { entries: Array<{ tag: string; when: number }> }).entries;
  const latest = entries[entries.length - 1];
  return { count: entries.length, latestTag: latest?.tag ?? "", latestWhen: latest?.when ?? 0 };
})();

export * from "./schema/index";
