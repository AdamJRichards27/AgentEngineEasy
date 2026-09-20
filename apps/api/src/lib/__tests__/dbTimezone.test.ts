// AE GROW Pilot Readiness WP2a (P0-3) — UTC database sessions.
//
// Proves:
//   - the application pool's connections run in UTC;
//   - createSafePool's connect hook forces UTC even when the connection's
//     own default is NOT UTC (simulated without superuser by passing a
//     non-UTC TimeZone as a libpq startup option, which is exactly what a
//     non-UTC database/role default looks like to the session), and that
//     DB_SET_SESSION_TIMEZONE=false really opts out;
//   - the pool has an 'error' listener, so an idle-client error cannot
//     crash the process, and the log line never contains the connection
//     string;
//   - assertDatabaseSessionTimezoneUtc() fails closed in production and
//     only warns elsewhere (injected query results).

import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, pool, createSafePool, isSessionTimezoneSetEnabled } from "@aee/db";
import {
  assertDatabaseSessionTimezoneUtc,
  isUtcEquivalentZone,
  type DatabaseTimezoneFacts,
} from "../dbTimezone.js";

const DATABASE_URL = process.env.DATABASE_URL as string;

async function withNodeEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

async function showTimeZone(p: typeof pool): Promise<string> {
  const result = await p.query<{ TimeZone: string }>("SHOW TimeZone");
  return result.rows[0].TimeZone;
}

const brisbaneStartup = { options: "-c TimeZone=Australia/Brisbane" };

test("the application pool's connections report SHOW TimeZone = UTC", async () => {
  assert.equal(await showTimeZone(pool), "UTC");
  const result = await db.execute(sql`select current_setting('TimeZone') as tz`);
  assert.equal((result.rows[0] as { tz: string }).tz, "UTC");
});

test("the session time zone SET is on by default and opts out only on the literal 'false'", () => {
  const previous = process.env.DB_SET_SESSION_TIMEZONE;
  try {
    for (const value of [undefined, "", "true", "0", "no", "FALSE"]) {
      if (value === undefined) delete process.env.DB_SET_SESSION_TIMEZONE;
      else process.env.DB_SET_SESSION_TIMEZONE = value;
      assert.equal(isSessionTimezoneSetEnabled(), true, `value ${JSON.stringify(value)} must keep the SET on`);
    }
    process.env.DB_SET_SESSION_TIMEZONE = "false";
    assert.equal(isSessionTimezoneSetEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.DB_SET_SESSION_TIMEZONE;
    else process.env.DB_SET_SESSION_TIMEZONE = previous;
  }
});

test("control: a connection whose default time zone is non-UTC reports that zone when the hook is disabled", async () => {
  const p = createSafePool(DATABASE_URL, { setSessionTimezone: false, extra: brisbaneStartup });
  try {
    assert.equal(await showTimeZone(p), "Australia/Brisbane");
  } finally {
    await p.end();
  }
});

test("the connect hook forces UTC on every pooled connection even when the connection default is non-UTC, and defaultNow()-style now() matches UTC", async () => {
  const p = createSafePool(DATABASE_URL, { setSessionTimezone: true, extra: { ...brisbaneStartup, max: 3 } });
  try {
    const clients = await Promise.all([p.connect(), p.connect(), p.connect()]);
    try {
      for (const client of clients) {
        const tz = await client.query<{ TimeZone: string }>("SHOW TimeZone");
        assert.equal(tz.rows[0].TimeZone, "UTC");
        const reset = await client.query<{ reset_val: string }>("select reset_val from pg_settings where name = 'TimeZone'");
        assert.equal(reset.rows[0].reset_val, "Australia/Brisbane", "the underlying default really was non-UTC");
        const drift = await client.query<{ drift: string }>(
          "select abs(extract(epoch from (now()::timestamp - (now() at time zone 'UTC'))))::text as drift",
        );
        assert.equal(Number(drift.rows[0].drift), 0, "timestamp-without-time-zone now() must equal UTC wall-clock");
      }
    } finally {
      for (const client of clients) client.release();
    }
  } finally {
    await p.end();
  }
});

test("assertDatabaseSessionTimezoneUtc warns only (never throws) about a non-UTC default when the session itself is UTC", async () => {
  const p = createSafePool(DATABASE_URL, { setSessionTimezone: true, extra: brisbaneStartup });
  try {
    const facts = await withNodeEnv("production", () =>
      assertDatabaseSessionTimezoneUtc(async () => {
        const r = await p.query<{ s: string; d: string }>(
          "select current_setting('TimeZone') as s, (select reset_val from pg_settings where name = 'TimeZone') as d",
        );
        return { sessionTimeZone: r.rows[0].s, defaultTimeZone: r.rows[0].d };
      }),
    );
    assert.equal(facts.sessionTimeZone, "UTC");
    assert.equal(facts.defaultTimeZone, "Australia/Brisbane");
  } finally {
    await p.end();
  }
});

test("the pool has an 'error' listener: an idle-client error is logged without the connection string and does not crash", async () => {
  const p = createSafePool("postgresql://someone:hunter2-secret@127.0.0.1:1/nowhere", { setSessionTimezone: false });
  assert.ok(p.listenerCount("error") >= 1, "a pool without an 'error' listener crashes the process on idle-client errors");
  const originalConsoleError = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    // Emitting 'error' with no listener would throw synchronously here.
    p.emit("error", Object.assign(new Error("terminating connection due to administrator command postgresql://someone:hunter2-secret@db/x"), { code: "57P01" }));
  } finally {
    console.error = originalConsoleError;
    await p.end();
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(entry.event, "db_pool_idle_client_error");
  assert.equal(entry.errorCode, "57P01");
  assert.doesNotMatch(lines[0], /hunter2-secret/);
});

test("isUtcEquivalentZone accepts UTC/GMT equivalents only", () => {
  for (const zone of ["UTC", "utc", "Etc/UTC", "GMT", "Etc/GMT", "UCT", "Universal", "Zulu", "GMT0", "Etc/GMT+0", "Etc/GMT-0", "Greenwich"]) {
    assert.equal(isUtcEquivalentZone(zone), true, zone);
  }
  for (const zone of ["Australia/Brisbane", "Europe/London", "Etc/GMT+10", "+10", "localtime", "", null, undefined]) {
    assert.equal(isUtcEquivalentZone(zone as string), false, String(zone));
  }
});

const nonUtc = async (): Promise<DatabaseTimezoneFacts> => ({ sessionTimeZone: "Australia/Brisbane", defaultTimeZone: "Australia/Brisbane" });
const utc = async (): Promise<DatabaseTimezoneFacts> => ({ sessionTimeZone: "Etc/UTC", defaultTimeZone: "UTC" });

test("assertDatabaseSessionTimezoneUtc refuses to start in production on a non-UTC session, with an operator instruction", async () => {
  await withNodeEnv("production", async () => {
    await assert.rejects(() => assertDatabaseSessionTimezoneUtc(nonUtc), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /not UTC/);
      assert.match(err.message, /ALTER DATABASE <database> SET timezone TO 'UTC'/);
      assert.match(err.message, /Australia\/Brisbane/);
      return true;
    });
  });
});

test("assertDatabaseSessionTimezoneUtc only warns outside production on a non-UTC session", async () => {
  for (const env of ["test", "development", undefined]) {
    await withNodeEnv(env, async () => {
      const facts = await assertDatabaseSessionTimezoneUtc(nonUtc);
      assert.equal(facts.sessionTimeZone, "Australia/Brisbane");
    });
  }
});

test("assertDatabaseSessionTimezoneUtc passes a UTC-equivalent session in production", async () => {
  await withNodeEnv("production", async () => {
    const facts = await assertDatabaseSessionTimezoneUtc(utc);
    assert.equal(facts.sessionTimeZone, "Etc/UTC");
  });
});

test("assertDatabaseSessionTimezoneUtc fails closed in production (warns elsewhere) when the time zone cannot be read", async () => {
  const failing = async (): Promise<DatabaseTimezoneFacts> => {
    throw new Error("connect ECONNREFUSED");
  };
  await withNodeEnv("production", async () => {
    await assert.rejects(() => assertDatabaseSessionTimezoneUtc(failing), /Could not verify the database session time zone/);
  });
  await withNodeEnv("test", async () => {
    const facts = await assertDatabaseSessionTimezoneUtc(failing);
    assert.equal(facts.sessionTimeZone, null);
  });
});

test("assertDatabaseSessionTimezoneUtc with the real default query passes against the (UTC) test database in production mode", async () => {
  await withNodeEnv("production", async () => {
    const facts = await assertDatabaseSessionTimezoneUtc();
    assert.equal(isUtcEquivalentZone(facts.sessionTimeZone), true);
  });
});
