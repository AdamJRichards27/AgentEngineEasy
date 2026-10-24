// Per-file test database lifecycle (PH-7 R29c): src/test/perFileDatabase.mjs must drop the copy it created when the
// test file's process exits (pass or fail), never fail the run if that drop fails, keep the idle sweep as a backstop
// that touches only names the helper itself generates, and honour a configurable name prefix (default aee_t_).
// Each case runs a tiny fixture under `node --import <helper> --test` against a private source database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../test/perFileDatabase.mjs");
const baseUrl = process.env.DATABASE_URL;
const skip = !baseUrl ? "DATABASE_URL not set" : false;
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

// apps/api has no @types/pg (adding it would change the lockfile), so pg is loaded untyped behind a minimal interface.
interface AdminClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}
const pgModule = "pg";
let admin: AdminClient;
let work: string;
const source = `pfdb_src_${process.pid}`;
const created = new Set<string>();

function urlFor(db: string): string {
  const url = new URL(baseUrl!);
  url.pathname = `/${db}`;
  return url.href;
}
async function exists(db: string): Promise<boolean> {
  const { rows } = await admin.query("select 1 from pg_database where datname = $1", [db]);
  return rows.length === 1;
}
async function dropIfExists(db: string): Promise<void> {
  await admin.query(`drop database if exists ${quote(db)} with (force)`);
}

const FIXTURE = `
import { test } from "node:test";
import { writeFileSync } from "node:fs";
test("fixture", () => {
  writeFileSync(process.env.PFDB_OUT, decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)));
  if (process.env.PFDB_FAIL === "1") throw new Error("intentional fixture failure");
});
`;

function runFixture(extra: Record<string, string> = {}) {
  const out = path.join(work, `out-${Math.random().toString(16).slice(2)}.txt`);
  const child = spawnSync(process.execPath, ["--import", pathToFileURL(helper).href, "--test", path.join(work, "fixture.test.mjs")], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DATABASE_URL: urlFor(source), PFDB_OUT: out, ...extra },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: child.status, stderr: child.stderr, stdout: child.stdout, out };
}
async function cloneName(out: string): Promise<string> {
  const name = (await readFile(out, "utf8")).trim();
  created.add(name);
  return name;
}

before(async () => {
  if (skip) return;
  const adminUrl = new URL(baseUrl!);
  adminUrl.pathname = "/postgres";
  const pg = ((await import(pgModule)) as { default: { Client: new (options: { connectionString: string }) => AdminClient } }).default;
  admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();
  await dropIfExists(source);
  await admin.query(`create database ${quote(source)}`);
  work = await mkdtemp(path.join(tmpdir(), "pfdb-"));
  await writeFile(path.join(work, "fixture.test.mjs"), FIXTURE);
});

after(async () => {
  if (skip) return;
  for (const db of created) await dropIfExists(db).catch(() => undefined);
  await dropIfExists(source).catch(() => undefined);
  await admin.end();
  await rm(work, { recursive: true, force: true });
});

test("PFDB1 the per-file copy is dropped when a passing test file finishes", { skip }, async () => {
  const r = runFixture();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const clone = await cloneName(r.out);
  assert.match(clone, /^aee_t_\d+_\d+$/, "default prefix unchanged");
  assert.equal(await exists(clone), false, `copy ${clone} must be dropped at exit`);
});

test("PFDB2 the copy is dropped when the test file FAILS, and the failure exit code is kept", { skip }, async () => {
  const r = runFixture({ PFDB_FAIL: "1" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const clone = await cloneName(r.out);
  assert.equal(await exists(clone), false, `copy ${clone} must be dropped after a failing file`);
});

test("PFDB3 AEE_TEST_DB_PREFIX sets the copy name prefix; an invalid prefix is refused", { skip }, async () => {
  const r = runFixture({ AEE_TEST_DB_PREFIX: "pfdb_x_" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const clone = await cloneName(r.out);
  assert.match(clone, /^pfdb_x_\d+_\d+$/);
  assert.equal(await exists(clone), false);
  const bad = runFixture({ AEE_TEST_DB_PREFIX: "Bad-Prefix;" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /AEE_TEST_DB_PREFIX/);
});

test("PFDB4 a failed drop is best-effort: warning only, the run's exit code is unchanged", { skip }, async () => {
  const r = runFixture({ AEE_TEST_DB_DROP_TIMEOUT_MS: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const clone = await cloneName(r.out);
  // node --test relays the file process's stderr through the runner, so look at both streams.
  assert.match(r.stdout + r.stderr, /perFileDatabase: could not drop test database copy/);
  assert.ok(!(r.stdout + r.stderr).includes(urlFor(source)), "the warning never contains a connection URL");
  await dropIfExists(clone);
});

test("PFDB5 the idle sweep stays as a backstop but drops only helper-shaped names", { skip }, async () => {
  const stale = "aee_t_1_1"; // helper-shaped, epoch 1970: dropped by the sweep
  const lookalike = "aee_tc_1_1"; // matches LIKE 'aee_t_%' via wildcards but is not a helper name: must survive
  for (const db of [stale, lookalike]) {
    created.add(db);
    await dropIfExists(db);
    await admin.query(`create database ${quote(db)}`);
  }
  const r = runFixture();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  await cloneName(r.out);
  assert.equal(await exists(stale), false, "stale helper copy dropped by the sweep");
  assert.equal(await exists(lookalike), true, "non-helper lookalike name never dropped");
});
