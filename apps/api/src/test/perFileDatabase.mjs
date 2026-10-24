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
 * the clone URL and are left alone. Active only when NODE_ENV=test; opt out:
 * AEE_TEST_DB_PER_FILE=0.
 *
 * CLEANUP (PH-7 R29c). When the test-file process exits -- tests passed or
 * failed -- its own clone is dropped (WITH FORCE) by perFileDatabaseDrop.mjs,
 * run synchronously from the `exit` handler (bounded by
 * AEE_TEST_DB_DROP_TIMEOUT_MS, default 15000). Best-effort: a failed drop
 * prints one warning (no URL) and never changes the exit code.
 * AEE_TEST_DB_KEEP=1 keeps the clone for debugging. A process killed by a
 * signal cannot run the handler, so the idle sweep stays as the backstop:
 * clones older than 3 h are dropped (no FORCE), matching ONLY names this
 * helper generates (<prefix><epoch>_<pid>).
 *
 * PREFIX. AEE_TEST_DB_PREFIX (default "aee_t_"): lower-case letters, digits
 * and "_", starting with a letter, at most 30 characters.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PREFIX = process.env.AEE_TEST_DB_PREFIX ?? "aee_t_";
const STALE_SECONDS = 3 * 3600;
const quote = (name) => `"${name.replace(/"/g, '""')}"`;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapeLike = (text) => text.replace(/[\\%_]/g, "\\$&");
const helperName = new RegExp(`^${escapeRegExp(PREFIX)}(\\d+)_(\\d+)$`);

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

if (enabled && !/^[a-z][a-z0-9_]{0,29}$/.test(PREFIX)) {
  throw new Error("AEE_TEST_DB_PREFIX must be lower-case letters, digits or _, start with a letter, and be at most 30 characters");
}

/** Synchronous best-effort drop of this process's own clone (see CLEANUP). */
function dropOnExit(adminUrl, clone) {
  if (process.env.AEE_TEST_DB_KEEP === "1") return;
  const timeout = Number(process.env.AEE_TEST_DB_DROP_TIMEOUT_MS ?? 15_000);
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./perFileDatabaseDrop.mjs", import.meta.url))], {
      env: { PATH: process.env.PATH ?? "", AEE_TEST_DB_DROP_ADMIN_URL: adminUrl, AEE_TEST_DB_DROP_NAME: clone },
      encoding: "utf8",
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 15_000,
    });
    if (result.status !== 0) {
      const reason = result.error ? result.error.message : (result.stderr || `exit ${result.status ?? result.signal}`).trim();
      process.stderr.write(`perFileDatabase: could not drop test database copy ${clone} (${reason.slice(0, 200)}); the idle sweep will remove it later\n`);
    }
  } catch (error) {
    process.stderr.write(`perFileDatabase: could not drop test database copy ${clone} (${error instanceof Error ? error.message : String(error)})\n`);
  }
}

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
      const { rows } = await client.query("select datname from pg_database where datname like $1", [`${escapeLike(PREFIX)}%`]);
      for (const { datname } of rows) {
        const match = helperName.exec(datname);
        if (!match) continue; // not a name this helper generates: never touched
        const epoch = Number(match[1]);
        if (datname !== clone && now - epoch > STALE_SECONDS) {
          await client.query(`drop database if exists ${quote(datname)}`).catch(() => undefined);
        }
      }
    });
    const next = new URL(base.href);
    next.pathname = `/${clone}`;
    process.env.DATABASE_URL = next.href;
    const adminUrl = new URL(base.href);
    adminUrl.pathname = "/postgres";
    process.once("exit", () => dropOnExit(adminUrl.href, clone));
  }
}
