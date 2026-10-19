/**
 * Test-only (plain JS so it needs no type declarations): give every test FILE
 * its own database, cloned from the migrated DATABASE_URL database (CI:
 * `aee_ci`) used as a template.
 *
 * WHY. `node --test` runs files in parallel processes. Several suites take
 * database-wide resources -- e.g. the signal sweep's session advisory lock
 * (lib/propertyIntelligence/sweep.ts, (0x41455351, 1)) and system-wide work
 * over shared rows -- so two files running at once can refuse or mutate each
 * other's work ("A signal sweep is already running", 409 version conflicts).
 * Advisory locks and rows are per-database, so a database per file removes
 * the interference without touching app locking, assertions or parallelism.
 *
 * HOW. Loaded with `tsx --import` by the API `test` script; node:test applies
 * it in each test-file process (NODE_TEST_CONTEXT is set there). Before any
 * test module -- and so @aee/db's pool -- is imported, it runs
 *   CREATE DATABASE aee_t_<epoch>_<pid> TEMPLATE <base>
 * and points DATABASE_URL at the clone. Child processes a test spawns inherit
 * the clone URL and are left alone. Idle clones older than 3 h are dropped
 * (no FORCE). Active only when NODE_ENV=test; opt out: AEE_TEST_DB_PER_FILE=0.
 */
import pg from "pg";

const PREFIX = "aee_t_";
const STALE_SECONDS = 3 * 3600;
const quote = (name) => `"${name.replace(/"/g, '""')}"`;

async function withAdmin(url, fn) {
  const admin = new URL(url.href);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const enabled =
  process.env.NODE_ENV === "test" &&
  process.env.AEE_TEST_DB_PER_FILE !== "0" &&
  Boolean(process.env.NODE_TEST_CONTEXT) &&
  Boolean(process.env.DATABASE_URL);

if (enabled) {
  const base = new URL(process.env.DATABASE_URL);
  const baseName = decodeURIComponent(base.pathname.replace(/^\//, ""));
  if (!baseName.startsWith(PREFIX)) {
    const now = Math.floor(Date.now() / 1000);
    const clone = `${PREFIX}${now}_${process.pid}`;
    await withAdmin(base, async (client) => {
      // CREATE DATABASE ... TEMPLATE fails while another session is connected
      // to the template (e.g. a sibling's clone in progress): retry briefly.
      for (let attempt = 1; ; attempt++) {
        try {
          await client.query(`create database ${quote(clone)} template ${quote(baseName)}`);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt >= 50 || !/being accessed by other users/.test(message)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 150)));
        }
      }
      const { rows } = await client.query("select datname from pg_database where datname like $1", [`${PREFIX}%`]);
      for (const { datname } of rows) {
        const epoch = Number(datname.slice(PREFIX.length).split("_")[0]);
        if (Number.isFinite(epoch) && now - epoch > STALE_SECONDS) {
          await client.query(`drop database if exists ${quote(datname)}`).catch(() => undefined);
        }
      }
    });
    const next = new URL(base.href);
    next.pathname = `/${clone}`;
    process.env.DATABASE_URL = next.href;
  }
}
