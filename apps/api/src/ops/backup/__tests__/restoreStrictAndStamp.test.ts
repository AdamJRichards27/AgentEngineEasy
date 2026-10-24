// WS4-13: (1) opt-in strict restore — refuse a manifest with no dumpArchiveVersion before the dump is downloaded;
// (3) build stamp — a bundled backup/restore/sweep CLI built from source that no longer matches refuses to run.
// Synthetic fixtures only: fake remote, fake tools, temp directories. No real remote, bucket or dump.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { EXIT, parseCliArgs, runCli } from "../cli.js";
import { runCommand } from "../commands.js";
import { createBackup, restoreBackup } from "../engine.js";
import { DumpArchiveIncompatibleError } from "../dumpFormat.js";
import {
  BUILD_STAMP_EXPECTED_DIGEST_ENV, BUILD_STAMP_SOURCE_ROOT_ENV, BuildStampError, checkBuildStamp, computeInputsDigest, type BuildStamp,
} from "../buildStamp.js";
import { STRICT_ARCHIVE_VERSION_ENV, restoreStrictFromEnv } from "../restoreArgs.js";
import type { CommandRunner, CommandSpec, OperationLog } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../../../..");
const repoRoot = path.resolve(apiRoot, "../..");
const header = (minor: number): Buffer => Buffer.concat([Buffer.from("PGDMP"), Buffer.from([1, minor, 0, 4, 8, 1]), Buffer.from("rest-of-archive")]);

// ---------------- (1) strict legacy-manifest refusal: engine ----------------
async function legacyBackup(minor = 15, keepVersion = false) {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true });
  const run: CommandRunner = async (command, replacements, operation) => {
    if (command.executable === "pg_dump") { await writeFile(command.args[command.args.indexOf("--file") + 1]!, header(minor)); return { stdout: "", stderr: "" }; }
    return remote.run(command, replacements, operation);
  };
  await createBackup(remote.config, { run, now: () => new Date("2026-03-01T00:00:00Z"), log: () => undefined });
  const artifact = [...remote.uploaded.keys()].find((k) => k.endsWith(".tar.enc"))!;
  if (!keepVersion) {
    const key = `${artifact}.sha256.json`;
    const m = JSON.parse(remote.uploaded.get(key)!.toString("utf8")) as Record<string, unknown>;
    delete m.dumpArchiveVersion;
    remote.uploaded.set(key, Buffer.from(JSON.stringify(m) + "\n"));
  }
  return { remote, artifact };
}
async function engineRestore(b: Awaited<ReturnType<typeof legacyBackup>>, requireArchiveVersion: boolean | undefined, pgRestoreMajor?: number) {
  const downloads: string[] = []; const calls: string[] = []; const logs: OperationLog[] = [];
  const run: CommandRunner = async (command, replacements, operation) => {
    calls.push(command.executable);
    if (command.executable === "download") downloads.push(replacements!.object!);
    if (command.executable === "decrypt") { await copyFile(replacements!.input!, replacements!.output!); return { stdout: "", stderr: "" }; }
    if (command.executable === "pg_restore") return { stdout: "", stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
    return b.remote.run(command, replacements, operation);
  };
  const error = await restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true, ...(requireArchiveVersion === undefined ? {} : { requireArchiveVersion }) },
    { run, log: (e) => logs.push(e), ...(pgRestoreMajor ? { pgRestoreMajor } : {}) }).then(() => undefined, (e: unknown) => e as Error);
  return { error, downloads, calls, logs };
}

test("strict: a legacy manifest is refused BEFORE the dump download (with and without a known pg_restore)", async () => {
  for (const major of [16, undefined]) {
    const b = await legacyBackup();
    try {
      const r = await engineRestore(b, true, major);
      assert.ok(r.error instanceof DumpArchiveIncompatibleError, String(r.error));
      assert.equal(r.error.source, "manifest");
      assert.equal(r.error.found, "archive version not recorded (legacy manifest)");
      assert.match(r.error.required, /--require-archive-version/);
      assert.deepEqual(r.downloads, [`${b.artifact}.sha256.json`], "only the manifest was downloaded");
      assert.equal(r.logs.find((l) => l.event === "failed")?.stage, "archive_version_check");
    } finally { await b.remote.cleanup(); }
  }
});

test("default (not strict): a legacy manifest is still accepted — dump downloaded, restore completes", async () => {
  for (const flag of [undefined, false]) {
    const b = await legacyBackup();
    try {
      const r = await engineRestore(b, flag, 16);
      assert.equal(r.error, undefined, String(r.error));
      assert.deepEqual(r.downloads, [`${b.artifact}.sha256.json`, b.artifact]);
      assert.ok(r.calls.includes("pg_restore"));
    } finally { await b.remote.cleanup(); }
  }
});

test("strict + a manifest that records a compatible version proceeds normally", async () => {
  const b = await legacyBackup(15, true);
  try {
    const r = await engineRestore(b, true, 16);
    assert.equal(r.error, undefined, String(r.error));
    assert.ok(r.calls.includes("pg_restore"));
  } finally { await b.remote.cleanup(); }
});

test("strict env parsing: exact true/false; unset = default; anything else fails closed", () => {
  assert.equal(STRICT_ARCHIVE_VERSION_ENV, "BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION");
  assert.equal(restoreStrictFromEnv({}), false);
  assert.equal(restoreStrictFromEnv({ BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: "true" }), true);
  assert.equal(restoreStrictFromEnv({ BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: "false" }), false);
  for (const bad of ["", "TRUE", "True", "1", "0", "yes", "on", " true", "true ", "falsey"]) {
    assert.throws(() => restoreStrictFromEnv({ BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: bad }), /BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION must be exactly "true" or "false"/, JSON.stringify(bad));
  }
  assert.deepEqual(parseCliArgs("restore", ["--artifact=x", "--require-archive-version"]), { artifact: "x", confirmDisposable: false, requireArchiveVersion: true });
  assert.deepEqual(parseCliArgs("restore", ["--artifact=x"]), { artifact: "x", confirmDisposable: false });
  assert.throws(() => parseCliArgs("restore", ["--artifact=x", "--require-archive-version=true"]), /Unknown restore argument/);
});

// ---------------- (1) strict: CLI ----------------
const TOOLS = ["pg_dump", "pg_restore", "psql", "tar", "encrypt", "decrypt", "upload", "download", "verify-download", "list", "remove", "alert"];
const ARTIFACT = "aee-protected-20261019T120000Z-0123456789ab.tar.enc";
function baseEnv(root: string, bin: string): Record<string, string> {
  return {
    PATH: bin, BACKUP_ENVIRONMENT: "production",
    DATABASE_URL: "postgresql://backup_user:synthetic-ws4-13@db.invalid:5432/aee",
    BACKUP_DOCUMENT_DIRECTORY: path.join(root, "documents"), BACKUP_STAGING_DIRECTORY: path.join(root, "staging"),
    BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: JSON.stringify(["encrypt", "{input}", "{output}", "{kmsProfile}"]),
    BACKUP_DECRYPT_COMMAND: JSON.stringify(["decrypt", "{input}", "{output}", "{kmsProfile}"]),
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["upload", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["download", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["list", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["remove", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["alert", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-ws4-13",
    BACKUP_RESTORE_ROOT: path.join(root, "restore-root"),
    BACKUP_RESTORE_DOCUMENT_DIRECTORY: path.join(root, "restore-root", "documents"),
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore_user:synthetic-ws4-13-r@restore.invalid:5432/aee_restore",
  };
}
async function cliRestore(opts: { argv?: string[]; env?: Record<string, string>; manifestVersion: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "aee-ws4-13-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const t of TOOLS) { await writeFile(path.join(bin, t), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, t), 0o755); }
  const build = path.join(root, "build");
  await mkdir(path.join(build, "docs"), { recursive: true });
  await writeFile(path.join(build, "database.dump"), header(15));
  await writeFile(path.join(build, "inventory.json"), JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: [] }) + "\n");
  await runCommand({ executable: "tar", args: ["--create", "--file", path.join(build, "documents.tar"), "--directory", path.join(build, "docs"), "."] });
  const payload = path.join(root, "artifact.bin");
  await runCommand({ executable: "tar", args: ["--create", "--file", payload, "--directory", build, "database.dump", "inventory.json", "documents.tar"] });
  const bytes = await readFile(payload);
  const manifest: Record<string, unknown> = { version: 1, artifact: ARTIFACT, createdAt: "2026-10-19T02:00:00.000Z", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  if (opts.manifestVersion) manifest.dumpArchiveVersion = "1.15.0";
  await mkdir(path.join(root, "documents"), { recursive: true });
  const calls: string[] = []; const downloads: string[] = []; const logs: OperationLog[] = [];
  const runner = async (command: CommandSpec, replacements: Record<string, string> = {}) => {
    calls.push(command.args.includes("--version") ? `${command.executable}:version` : command.executable);
    if (command.args.includes("--version")) return { stdout: `${command.executable} (PostgreSQL) 16.15\n`, stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("server_version_num"))) return { stdout: "160014\n", stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
    if (command.executable === "download") {
      downloads.push(replacements.object!);
      if (replacements.object!.endsWith(".sha256.json")) await writeFile(replacements.destination!, JSON.stringify(manifest) + "\n");
      else await copyFile(payload, replacements.destination!);
      return { stdout: "", stderr: "" };
    }
    if (command.executable === "decrypt") { await copyFile(replacements.input!, replacements.output!); return { stdout: "", stderr: "" }; }
    if (command.executable === "tar") return runCommand(command);
    if (["alert", "pg_restore"].includes(command.executable)) return { stdout: "", stderr: "" };
    throw new Error(`fake: ${command.executable} not available`);
  };
  const code = await runCli("restore", {
    argv: [`--artifact=${ARTIFACT}`, "--confirm-disposable", ...(opts.argv ?? [])], env: { ...baseEnv(root, bin), ...(opts.env ?? {}) },
    run: runner as never, log: (e) => logs.push(e), stderr: () => {}, nodeVersion: "v24.22.0",
  });
  await rm(root, { recursive: true, force: true });
  return { code, calls, downloads, logs };
}

test("CLI strict: --require-archive-version or BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION=true refuses a legacy manifest (exit 69, manifest only)", async () => {
  for (const variant of [{ argv: ["--require-archive-version"] }, { env: { BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: "true" } }, { argv: ["--require-archive-version"], env: { BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: "false" } }]) {
    const r = await cliRestore({ ...variant, manifestVersion: false });
    assert.equal(r.code, EXIT.PREFLIGHT, JSON.stringify(variant));
    assert.deepEqual(r.downloads, [`${ARTIFACT}.sha256.json`]);
    const line = r.logs.find((l) => l.event === "backup_preflight_failed");
    assert.equal(line?.found, "archive version not recorded (legacy manifest)");
  }
});

test("CLI default and =false: a legacy manifest is accepted — dump downloaded, header checked, pg_restore runs", async () => {
  for (const env of [{}, { BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: "false" }] as Record<string, string>[]) {
    const r = await cliRestore({ env, manifestVersion: false });
    // The fake has no inventory psql, so the run ends after pg_restore (exit 1); what matters is that it got there.
    assert.notEqual(r.code, EXIT.PREFLIGHT);
    assert.notEqual(r.code, EXIT.CONFIG);
    assert.deepEqual(r.downloads, [`${ARTIFACT}.sha256.json`, ARTIFACT]);
    assert.ok(r.calls.includes("pg_restore"), r.calls.join(","));
    assert.ok(r.logs.some((l) => l.event === "manifest_without_archive_version"));
  }
});

test("CLI: a malformed BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION fails closed (exit 78) before any download", async () => {
  for (const bad of ["TRUE", "1", "yes", ""]) {
    const r = await cliRestore({ env: { BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION: bad }, manifestVersion: true });
    assert.equal(r.code, EXIT.CONFIG, JSON.stringify(bad));
    assert.deepEqual(r.downloads, []);
    assert.match(String(r.logs.find((l) => l.event === "backup_config_refused")?.error), /BACKUP_RESTORE_REQUIRE_ARCHIVE_VERSION/);
  }
});

// ---------------- (3) build stamp: unit ----------------
const inputs = [{ path: "apps/api/src/ops/backup/a.ts", sha256: "a".repeat(64) }, { path: "apps/api/src/ops/backup/b.ts", sha256: "b".repeat(64) }];
const stampOf = (overrides: Partial<BuildStamp> = {}): BuildStamp => ({ schema: 1, commit: "c".repeat(40), inputs, digest: computeInputsDigest(inputs), esbuild: "0.28.2", builtAt: "2026-10-20T00:00:00.000Z", ...overrides });
const kindOf = (fn: () => unknown) => { try { fn(); return "passed"; } catch (e) { assert.ok(e instanceof BuildStampError, String(e)); return `${e.kind}:${e.exitCode}`; } };

test("stamp: digest is order-independent sha256 over 'sha256  path' lines", () => {
  assert.equal(computeInputsDigest([...inputs].reverse()), computeInputsDigest(inputs));
  const expected = createHash("sha256").update(inputs.map((i) => `${i.sha256}  ${i.path}\n`).join("")).digest("hex");
  assert.equal(computeInputsDigest(inputs), expected);
});

test("stamp: source (tsx) runs are not checked; an unstamped bundle refuses (69)", () => {
  assert.deepEqual(checkBuildStamp({ stamp: undefined, entryUrl: "file:///x/apps/api/src/ops/backup/restore.ts", env: {} }), { status: "source" });
  assert.equal(kindOf(() => checkBuildStamp({ stamp: undefined, entryUrl: "file:///opt/bundle/backup-restore.mjs", env: {} })), "unstamped:69");
});

test("stamp: expected digest — match runs, mismatch (stale) refuses 69, malformed/missing expectation refuses 78", () => {
  const s = stampOf();
  const url = "file:///opt/bundle/backup-restore.mjs";
  assert.equal(BUILD_STAMP_EXPECTED_DIGEST_ENV, "BACKUP_CLI_EXPECTED_DIGEST");
  assert.equal(BUILD_STAMP_SOURCE_ROOT_ENV, "BACKUP_CLI_SOURCE_ROOT");
  assert.deepEqual(checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_EXPECTED_DIGEST: s.digest } }), { status: "ok", digest: s.digest, via: "expected_digest" });
  assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_EXPECTED_DIGEST: "d".repeat(64) } })), "stale:69");
  for (const bad of ["", "abc", s.digest.toUpperCase(), ` ${s.digest}`, "g".repeat(64)]) {
    assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_EXPECTED_DIGEST: bad } })), "config:78", JSON.stringify(bad));
  }
  assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: {} })), "config:78", "no expectation configured -> fail closed");
  assert.equal(kindOf(() => checkBuildStamp({ stamp: stampOf({ digest: "e".repeat(64) }), entryUrl: url, env: { BACKUP_CLI_EXPECTED_DIGEST: "e".repeat(64) } })), "inconsistent:69", "stamp digest must match its own inputs");
  assert.equal(kindOf(() => checkBuildStamp({ stamp: { ...s, schema: 2 } as never, entryUrl: url, env: { BACKUP_CLI_EXPECTED_DIGEST: s.digest } })), "inconsistent:69");
});

test("stamp: source-root mode rehashes the stamped inputs; any changed or missing file is stale (69)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-ws4-13-src-"));
  try {
    await mkdir(path.join(root, "apps/api/src/ops/backup"), { recursive: true });
    await writeFile(path.join(root, "apps/api/src/ops/backup/a.ts"), "export const a = 1;\n");
    await writeFile(path.join(root, "apps/api/src/ops/backup/b.ts"), "export const b = 2;\n");
    const real = await Promise.all(["a.ts", "b.ts"].map(async (f) => ({ path: `apps/api/src/ops/backup/${f}`, sha256: createHash("sha256").update(await readFile(path.join(root, "apps/api/src/ops/backup", f))).digest("hex") })));
    const s = stampOf({ inputs: real, digest: computeInputsDigest(real) });
    const url = "file:///opt/bundle/backup-restore.mjs";
    assert.equal(checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: root } }).status, "ok");
    await writeFile(path.join(root, "apps/api/src/ops/backup/b.ts"), "export const b = 3;\n");
    assert.throws(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: root } }), (e: unknown) => e instanceof BuildStampError && e.kind === "stale" && /apps\/api\/src\/ops\/backup\/b\.ts/.test(e.message));
    await rm(path.join(root, "apps/api/src/ops/backup/b.ts"));
    assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: root } })), "stale:69");
    assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: "relative/path" } })), "config:78");
    assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: path.join(root, "nope") } })), "config:78");
    assert.equal(kindOf(() => checkBuildStamp({ stamp: s, entryUrl: url, env: { BACKUP_CLI_SOURCE_ROOT: root, BACKUP_CLI_EXPECTED_DIGEST: s.digest } })), "config:78", "exactly one expectation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runCli: a stale stamp refuses before argument parsing, config or any command (exit 69, one line)", async () => {
  const s = stampOf();
  const logs: OperationLog[] = []; const calls: string[] = [];
  const code = await runCli("restore", {
    argv: ["--bogus"], env: { BACKUP_CLI_EXPECTED_DIGEST: "d".repeat(64) }, run: (async (c: CommandSpec) => { calls.push(c.executable); return { stdout: "", stderr: "" }; }) as never,
    log: (e) => logs.push(e), nodeVersion: "v24.22.0", buildStamp: { stamp: s, entryUrl: "file:///opt/bundle/backup-restore.mjs" },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.deepEqual(calls, []);
  const line = logs.find((l) => l.event === "backup_build_stamp_refused");
  assert.deepEqual([line?.kind, line?.found, line?.required], ["stale", s.digest, "d".repeat(64)]);
});

// ---------------- (3) build stamp: end to end with a real esbuild bundle ----------------
test("bundle e2e: build script stamps the bundle; matching digest / source root pass the stamp, stale and unstamped refuse", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "aee-ws4-13-bundle-"));
  try {
    const node = process.execPath;
    const build = spawnSync(node, [path.join(apiRoot, "src/ops/backup/bundle/build.mjs"), `--out=${out}`, "--allow-dirty-for-tests"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
    assert.equal(build.status, 0, build.stderr + build.stdout);
    const info = JSON.parse(await readFile(path.join(out, "BUILD.json"), "utf8")) as { digest: string; dirty: boolean; files: Record<string, string>; inputs: { path: string }[] };
    assert.equal(info.dirty !== undefined, true);
    for (const f of ["backup-backup.mjs", "backup-restore.mjs", "backup-sweep.mjs"]) {
      assert.equal(info.files[f], createHash("sha256").update(await readFile(path.join(out, f))).digest("hex"), f);
    }
    const bundle = path.join(out, "backup-restore.mjs");
    const runIt = (env: Record<string, string>) => spawnSync(node, [bundle, "--bogus"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", TZ: "UTC", ...env } });
    // Matching digest: stamp passes, the CLI then proceeds to argument/config handling (usage error 64 here — proof it ran).
    assert.equal(runIt({ BACKUP_CLI_EXPECTED_DIGEST: info.digest }).status, EXIT.USAGE);
    assert.equal(runIt({ BACKUP_CLI_SOURCE_ROOT: repoRoot }).status, EXIT.USAGE, "source root = this checkout: current");
    const stale = runIt({ BACKUP_CLI_EXPECTED_DIGEST: "0".repeat(64) });
    assert.equal(stale.status, EXIT.PREFLIGHT, stale.stderr + stale.stdout);
    assert.match(stale.stderr + stale.stdout, /backup_build_stamp_refused/);
    assert.equal(runIt({}).status, EXIT.CONFIG, "no expectation -> fail closed");
    // A changed source file in a copy of the checkout makes the same bundle stale.
    const copyRoot = await mkdtemp(path.join(tmpdir(), "aee-ws4-13-copy-"));
    try {
      for (const input of info.inputs) {
        await mkdir(path.dirname(path.join(copyRoot, input.path)), { recursive: true });
        await copyFile(path.join(repoRoot, input.path), path.join(copyRoot, input.path));
      }
      assert.equal(runIt({ BACKUP_CLI_SOURCE_ROOT: copyRoot }).status, EXIT.USAGE, "identical copy is current");
      await writeFile(path.join(copyRoot, "apps/api/src/ops/backup/engine.ts"), "// changed after the build\n", { flag: "a" });
      const r = runIt({ BACKUP_CLI_SOURCE_ROOT: copyRoot });
      assert.equal(r.status, EXIT.PREFLIGHT, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, /engine\.ts/);
    } finally { await rm(copyRoot, { recursive: true, force: true }); }
    // An unstamped bundle of the same source (built without the define) refuses.
    const esbuild = path.join(apiRoot, "node_modules/.bin/esbuild");
    const plain = path.join(out, "unstamped-restore.mjs");
    const pb = spawnSync(esbuild, [path.join(apiRoot, "src/ops/backup/restore.ts"), "--bundle", "--platform=node", "--format=esm", "--target=node24", `--outfile=${plain}`, "--log-level=warning",
      "--banner:js=import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);"], { encoding: "utf8" });
    assert.equal(pb.status, 0, pb.stderr);
    const u = spawnSync(node, [plain, "--bogus"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", BACKUP_CLI_EXPECTED_DIGEST: info.digest } });
    assert.equal(u.status, EXIT.PREFLIGHT, u.stderr + u.stdout);
    assert.match(u.stderr + u.stdout, /"kind":"unstamped"/);
    // Sweep bundle honours the same check.
    const sw = spawnSync(node, [path.join(out, "backup-sweep.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", BACKUP_CLI_EXPECTED_DIGEST: "0".repeat(64) } });
    assert.equal(sw.status, EXIT.PREFLIGHT, sw.stderr + sw.stdout);
  } finally { await rm(out, { recursive: true, force: true }); }
});
