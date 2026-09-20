/**
 * AE GROW Pilot Readiness WP2a (P0-3) — database session time zone check.
 *
 * Every timestamp column is `timestamp without time zone`; drizzle reads and
 * writes those as UTC wall-clock, while defaultNow()/now() evaluate in the
 * SESSION TimeZone. A non-UTC session therefore shifts every DB-computed
 * timestamp (entitlement windows, cut-offs, retention clocks) by the UTC
 * offset without any error. packages/db sets `TIME ZONE 'UTC'` on every new
 * pool connection (opt-out: DB_SET_SESSION_TIMEZONE=false); this check
 * verifies the EFFECTIVE result at startup, so a pooler that discards the
 * SET, or an operator who opted out on a non-UTC database, is caught before
 * traffic is accepted.
 *
 * Production: refuses to start (fail closed, same shape as the other
 * assert*Configured() checks in index.ts). Elsewhere: loud warning only.
 */
import { sql } from "drizzle-orm";
import { db } from "@aee/db";
import { logger } from "@aee/events";
import { isProductionEnvironment } from "./env.js";

/** Canonical names Postgres accepts for a zero-offset, no-DST zone. Compared case-insensitively. */
const UTC_EQUIVALENT_ZONES = new Set(
  [
    "UTC", "Etc/UTC", "UCT", "Etc/UCT", "Universal", "Etc/Universal", "Zulu", "Etc/Zulu",
    "GMT", "Etc/GMT", "GMT0", "Etc/GMT0", "GMT+0", "Etc/GMT+0", "GMT-0", "Etc/GMT-0",
    "Greenwich", "Etc/Greenwich",
  ].map((zone) => zone.toLowerCase()),
);

export function isUtcEquivalentZone(zone: string | null | undefined): boolean {
  if (typeof zone !== "string") return false;
  return UTC_EQUIVALENT_ZONES.has(zone.trim().toLowerCase());
}

export interface DatabaseTimezoneFacts {
  /** Effective session setting on a pooled connection (after the connect hook). */
  sessionTimeZone: string | null;
  /** The value the session would have WITHOUT the connect-time SET (database/role/server default). */
  defaultTimeZone: string | null;
}

export type DatabaseTimezoneQuery = () => Promise<DatabaseTimezoneFacts>;

export const defaultDatabaseTimezoneQuery: DatabaseTimezoneQuery = async () => {
  const result = await db.execute(sql`
    select current_setting('TimeZone') as session_time_zone,
           (select reset_val from pg_settings where name = 'TimeZone') as default_time_zone
  `);
  const row = (result.rows?.[0] ?? {}) as { session_time_zone?: string | null; default_time_zone?: string | null };
  return { sessionTimeZone: row.session_time_zone ?? null, defaultTimeZone: row.default_time_zone ?? null };
};

export const NON_UTC_OPERATOR_MESSAGE =
  "The database session time zone is not UTC. AgentEngineEasy stores every timestamp as " +
  "`timestamp without time zone` in UTC; a non-UTC session shifts entitlements, cut-offs and " +
  "time windows. Set the database default time zone to UTC " +
  "(ALTER DATABASE <database> SET timezone TO 'UTC'; reconnect) and, unless your connection " +
  "pooler rejects it, leave DB_SET_SESSION_TIMEZONE unset so each connection also runs SET TIME ZONE 'UTC'.";

/**
 * Throws (production) or warns (elsewhere) when the effective session time
 * zone is not UTC. Also warns — never throws — when the session is UTC only
 * because of the connect-time SET while the database default is not: that
 * is correct today but one pooler change away from silent drift.
 */
export async function assertDatabaseSessionTimezoneUtc(
  query: DatabaseTimezoneQuery = defaultDatabaseTimezoneQuery,
): Promise<DatabaseTimezoneFacts> {
  let facts: DatabaseTimezoneFacts;
  try {
    facts = await query();
  } catch (err) {
    // Cannot verify: fail closed in production (same as the production
    // document-storage readiness check in index.ts); elsewhere keep today's
    // "boot without the database" behaviour, with a warning.
    if (isProductionEnvironment()) {
      throw new Error(
        `Could not verify the database session time zone at startup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    logger.warn("database_session_timezone_check_failed", { error: err instanceof Error ? err.message : String(err) });
    return { sessionTimeZone: null, defaultTimeZone: null };
  }
  if (!isUtcEquivalentZone(facts.sessionTimeZone)) {
    if (isProductionEnvironment()) {
      throw new Error(`${NON_UTC_OPERATOR_MESSAGE} (observed session TimeZone: ${facts.sessionTimeZone ?? "unknown"})`);
    }
    logger.warn("database_session_timezone_not_utc", {
      sessionTimeZone: facts.sessionTimeZone,
      defaultTimeZone: facts.defaultTimeZone,
      operatorAction: NON_UTC_OPERATOR_MESSAGE,
    });
    return facts;
  }
  if (facts.defaultTimeZone !== null && !isUtcEquivalentZone(facts.defaultTimeZone)) {
    logger.warn("database_default_timezone_not_utc", {
      sessionTimeZone: facts.sessionTimeZone,
      defaultTimeZone: facts.defaultTimeZone,
      operatorAction:
        "Sessions are UTC only because of the connect-time SET TIME ZONE. Set the database default " +
        "time zone to UTC (ALTER DATABASE <database> SET timezone TO 'UTC') so correctness does not depend on it.",
    });
  }
  return facts;
}
