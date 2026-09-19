// AE GROW Pilot Readiness WP2a — readiness also checks (a) the migration
// bookkeeping table against the journal embedded in this build:
//   behind (>= 1 row, but fewer / older than the build) → 503 everywhere;
//   untracked (table missing or empty, push-managed) → 503 in production,
//     200 with `migrations: "untracked (push-managed database)"` elsewhere;
//   up to date → 200;
// and (b) no readiness-tracked boot task (entitlement catalogue seed, run.access
// backfill, Stage 2 workflow catalogue seed) to have failed. GET
// /api/health/live stays dependency-free.
//
// The migration-table states that cannot be produced safely on the shared
// test database (missing table, fewer rows, stale latest row, unreadable)
// are simulated by intercepting ONLY the migration bookkeeping queries
// (matched by their SQL text) and delegating everything else to the real
// db.execute — the same substitution approach as health.test.ts.

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, EXPECTED_MIGRATIONS } from "@aee/db";
import {
  checkReadiness,
  checkMigrationStatus,
  UNTRACKED_MIGRATIONS_WARNING,
  __resetUntrackedMigrationsWarningForTesting,
} from "../health.js";
import {
  recordStartupTaskFailure,
  runTrackedStartupTask,
  failedStartupTaskNames,
  __resetStartupHealthForTesting,
} from "../../lib/startupHealth.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

let server: Server;
let baseUrl: string;

before(async () => {
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  __resetStartupHealthForTesting();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterEach(() => {
  __resetStartupHealthForTesting();
});

async function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

// checkDocumentStorageReadiness() is environment-aware; the production
// branches below only need the migration outcome, which is decided before
// storage is consulted, so every production-mode assertion here is on an
// "unavailable" migration result.
const NON_PRODUCTION_ENVS = ["test", "development"] as const;

type DbExecute = typeof db.execute;
type Rows = { rows: Array<Record<string, unknown>> };

function sqlText(query: unknown): string {
  const dialect = (db as unknown as { dialect: { sqlToQuery: (q: unknown) => { sql: string } } }).dialect;
  try {
    return dialect.sqlToQuery(query).sql;
  } catch {
    return String(query);
  }
}

async function withMigrationTable<T>(
  fake: { regclass?: () => Rows; counts?: () => Rows },
  fn: () => Promise<T>,
): Promise<T> {
  const original = db.execute.bind(db) as (q: unknown) => Promise<unknown>;
  (db as { execute: DbExecute }).execute = (async (query: unknown) => {
    const text = sqlText(query);
    if (fake.regclass && text.includes("to_regclass('drizzle.__drizzle_migrations')")) return fake.regclass();
    if (fake.counts && text.includes("from drizzle.__drizzle_migrations")) return fake.counts();
    return original(query);
  }) as unknown as DbExecute;
  try {
    return await fn();
  } finally {
    (db as { execute: DbExecute }).execute = original as unknown as DbExecute;
  }
}

test("the embedded migration journal is non-empty and matches the migrations shipped in packages/db", async () => {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const journal = JSON.parse(
    readFileSync(path.resolve(here, "../../../../../packages/db/migrations/meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  assert.ok(EXPECTED_MIGRATIONS.count > 0);
  assert.equal(EXPECTED_MIGRATIONS.count, journal.entries.length);
  assert.equal(EXPECTED_MIGRATIONS.latestTag, journal.entries[journal.entries.length - 1].tag);
});

test("checkMigrationStatus reports the fully-migrated test database as up to date", async () => {
  const status = await checkMigrationStatus();
  assert.equal(status.upToDate, true, JSON.stringify(status));
  assert.ok(status.applied >= EXPECTED_MIGRATIONS.count);
});

test("readiness is ok against the fully-migrated test database with no failed startup tasks", async () => {
  const result = await checkReadiness();
  assert.equal(result.status, "ok", JSON.stringify(result));
});

const behindByCount = () => ({ rows: [{ applied: EXPECTED_MIGRATIONS.count - 1, latest: String(EXPECTED_MIGRATIONS.latestWhen - 1) }] });
const behindByLatest = () => ({ rows: [{ applied: EXPECTED_MIGRATIONS.count, latest: String(EXPECTED_MIGRATIONS.latestWhen - 1) }] });
const oneRowOnly = () => ({ rows: [{ applied: 1, latest: "1787885778053" }] });

for (const env of [...NON_PRODUCTION_ENVS, "production"]) {
  test(`behind (fewer rows than the build's journal) → 503 with NODE_ENV=${env}`, async () => {
    await withNodeEnv(env, () =>
      withMigrationTable({ counts: behindByCount }, async () => {
        const res = await fetch(`${baseUrl}/api/health/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { status: string; reasons: string[]; migrations?: string };
        assert.equal(body.status, "unavailable");
        assert.equal(body.migrations, undefined);
        assert.deepEqual(body.reasons, [
          `database migrations not fully applied (${EXPECTED_MIGRATIONS.count - 1} of ${EXPECTED_MIGRATIONS.count} recorded)`,
        ]);
        const legacy = await fetch(`${baseUrl}/api/health`);
        assert.equal(legacy.status, 503);
        assert.deepEqual(await legacy.json(), { status: "degraded", service: "agent-engine-easy-api", database: "unreachable" });
      }),
    );
  });

  test(`behind (row count matches but newest recorded migration is older) → unavailable with NODE_ENV=${env}`, async () => {
    await withNodeEnv(env, () =>
      withMigrationTable({ counts: behindByLatest }, async () => {
        const result = await checkReadiness();
        assert.equal(result.status, "unavailable");
        assert.match(result.reasons[0], /database migrations not fully applied/);
      }),
    );
  });

  test(`behind (a single baseline row only) is NOT treated as untracked → unavailable with NODE_ENV=${env}`, async () => {
    await withNodeEnv(env, () =>
      withMigrationTable({ counts: oneRowOnly }, async () => {
        const result = await checkReadiness();
        assert.equal(result.status, "unavailable");
        assert.equal(result.migrations, undefined);
        assert.deepEqual(result.reasons, [`database migrations not fully applied (1 of ${EXPECTED_MIGRATIONS.count} recorded)`]);
      }),
    );
  });
}

const untrackedVariants = [
  { name: "bookkeeping table missing", fake: { regclass: () => ({ rows: [{ present: false }] }) } },
  { name: "bookkeeping table empty", fake: { counts: () => ({ rows: [{ applied: 0, latest: null }] }) } },
];

for (const variant of untrackedVariants) {
  test(`untracked (${variant.name}) → 503 in production with an explicit db:migrate reason`, async () => {
    await withNodeEnv("production", () =>
      withMigrationTable(variant.fake, async () => {
        const status = await checkMigrationStatus();
        assert.equal(status.applied, 0);
        assert.equal(status.untracked, true);
        assert.equal(status.upToDate, false);
        const res = await fetch(`${baseUrl}/api/health/ready`);
        assert.equal(res.status, 503);
        const body = (await res.json()) as { status: string; reasons: string[]; migrations?: string };
        assert.equal(body.status, "unavailable");
        assert.equal(body.migrations, undefined);
        assert.equal(body.reasons.length, 1);
        assert.match(body.reasons[0], /untracked.*0 of \d+ recorded; production requires db:migrate/);
        const legacy = await fetch(`${baseUrl}/api/health`);
        assert.equal(legacy.status, 503);
        assert.deepEqual(await legacy.json(), { status: "degraded", service: "agent-engine-easy-api", database: "unreachable" });
      }),
    );
  });

  for (const env of NON_PRODUCTION_ENVS) {
    test(`untracked (${variant.name}) → 200 with a migrations warning field with NODE_ENV=${env}; legacy /api/health shape unchanged`, async () => {
      await withNodeEnv(env, () =>
        withMigrationTable(variant.fake, async () => {
          const res = await fetch(`${baseUrl}/api/health/ready`);
          assert.equal(res.status, 200);
          const body = (await res.json()) as { status: string; reasons: string[]; migrations?: string };
          assert.equal(body.status, "ok");
          assert.deepEqual(body.reasons, []);
          assert.equal(body.migrations, UNTRACKED_MIGRATIONS_WARNING);
          assert.equal(body.migrations, "untracked (push-managed database)");
          const legacy = await fetch(`${baseUrl}/api/health`);
          assert.equal(legacy.status, 200);
          assert.deepEqual(await legacy.json(), { status: "ok", service: "agent-engine-easy-api" });
        }),
      );
    });
  }
}

test("the untracked-migrations warning is logged once per process, not on every readiness probe", async () => {
  __resetUntrackedMigrationsWarningForTesting();
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalErrWrite = process.stderr.write.bind(process.stderr);
  const capture = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  (process.stdout as { write: unknown }).write = capture;
  (process.stderr as { write: unknown }).write = capture;
  try {
    await withNodeEnv("test", () =>
      withMigrationTable({ regclass: () => ({ rows: [{ present: false }] }) }, async () => {
        for (let i = 0; i < 3; i++) assert.equal((await checkReadiness()).migrations, UNTRACKED_MIGRATIONS_WARNING);
      }),
    );
  } finally {
    (process.stdout as { write: unknown }).write = originalWrite;
    (process.stderr as { write: unknown }).write = originalErrWrite;
  }
  assert.equal(lines.filter((line) => line.includes("readiness_migrations_untracked")).length, 1);
});

test("up to date → 200 with no migrations warning field, in production mode too", async () => {
  const upToDate = () => ({ rows: [{ applied: EXPECTED_MIGRATIONS.count, latest: String(EXPECTED_MIGRATIONS.latestWhen) }] });
  for (const env of [...NON_PRODUCTION_ENVS, "production"]) {
    await withNodeEnv(env, () =>
      withMigrationTable({ counts: upToDate }, async () => {
        const status = await checkMigrationStatus();
        assert.equal(status.upToDate, true);
        assert.equal(status.untracked, false);
      }),
    );
  }
  const res = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; migrations?: string };
  assert.equal(body.status, "ok");
  assert.equal("migrations" in body, false);
});

test("readiness is unavailable with a fixed, non-leaky reason when the migration status query fails", async () => {
  await withMigrationTable(
    {
      counts: () => {
        throw new Error('permission denied for schema drizzle (user "secret_user")');
      },
    },
    async () => {
      const result = await checkReadiness();
      assert.equal(result.status, "unavailable");
      assert.deepEqual(result.reasons, ["database migration status unavailable"]);
    },
  );
});

test("a failed readiness-tracked startup task makes readiness unavailable and names the task", async () => {
  await recordStartupTaskFailure("entitlement_catalogue_seed", new Error("duplicate key"));
  const res = await fetch(`${baseUrl}/api/health/ready`);
  assert.equal(res.status, 503);
  const body = (await res.json()) as { status: string; reasons: string[] };
  assert.equal(body.status, "unavailable");
  assert.deepEqual(body.reasons, ["startup task failed: entitlement_catalogue_seed"]);
  assert.doesNotMatch(JSON.stringify(body), /duplicate key/);
});

test("runTrackedStartupTask never rejects, records failures, and clears on success", async () => {
  await runTrackedStartupTask("run_access_backfill", async () => {
    throw new Error("simulated seed failure");
  });
  assert.deepEqual(failedStartupTaskNames(), ["run_access_backfill"]);
  assert.equal((await checkReadiness()).status, "unavailable");
  await runTrackedStartupTask("run_access_backfill", async () => undefined);
  assert.deepEqual(failedStartupTaskNames(), []);
  assert.equal((await checkReadiness()).status, "ok");
});

test("GET /api/health/live stays 200 while migrations are behind and a startup task has failed", async () => {
  await recordStartupTaskFailure("entitlement_catalogue_seed", new Error("x"));
  await withMigrationTable({ counts: behindByCount }, async () => {
    const res = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok", service: "agent-engine-easy-api" });
  });
});
