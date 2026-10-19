// WS4-06: refuse a restore whose pg_dump archive is NEWER than the pg_restore client can read, before restoring.
// pg_dump custom-format archives start "PGDMP" + archive version bytes (major, minor, rev). pg_restore reads every
// archive up to its own K_VERS_MAX (pg_backup_archiver.h): PG12-15 -> 1.14, PG16 -> 1.15, PG17 and PG18 -> 1.16.
// Backup now records the archive version in the artifact manifest; restore compares it (before decrypt) when the
// manifest has it, and always re-reads the extracted dump header before pg_restore runs. Refusal = exit 69.
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EXIT, runCli } from "../cli.js";
import { runCommand } from "../commands.js";
import { createBackup, restoreBackup } from "../engine.js";
import {
  DumpArchiveIncompatibleError,
  assertArchiveReadable,
  maxReadableArchiveMinor,
  parseCustomDumpHeader,
} from "../dumpFormat.js";
import type { CommandRunner, CommandSpec, OperationLog } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

const header = (minor: number, rev = 0): Buffer => Buffer.concat([Buffer.from("PGDMP"), Buffer.from([1, minor, rev, 4, 8, 1]), Buffer.from("rest-of-archive")]);

test("parseCustomDumpHeader reads PGDMP major.minor.rev; anything else is null", () => {
  assert.equal(parseCustomDumpHeader(header(15)), "1.15.0");
  assert.equal(parseCustomDumpHeader(header(16, 2)), "1.16.2");
  assert.equal(parseCustomDumpHeader(Buffer.from("dump")), null);
  assert.equal(parseCustomDumpHeader(Buffer.from("PGDMP")), null);
  assert.equal(parseCustomDumpHeader(Buffer.from("-- PostgreSQL database dump\n")), null);
});

test("maxReadableArchiveMinor follows pg_backup_archiver.h K_VERS_MAX per pg_restore major", () => {
  assert.equal(maxReadableArchiveMinor(12), 14);
  assert.equal(maxReadableArchiveMinor(15), 14);
  assert.equal(maxReadableArchiveMinor(16), 15);
  assert.equal(maxReadableArchiveMinor(17), 16);
  assert.equal(maxReadableArchiveMinor(18), 16);
  assert.equal(maxReadableArchiveMinor(11), undefined, "unsupported / unknown client -> undefined (fail closed)");
});

test("assertArchiveReadable: newer archive than the client is refused; same or older is accepted", () => {
  assert.throws(() => assertArchiveReadable("1.16.0", 16, "manifest"), (e: unknown) => {
    assert.ok(e instanceof DumpArchiveIncompatibleError);
    assert.equal(e.tool, "pg_restore");
    assert.equal(e.found, "archive 1.16.0");
    assert.equal(e.required, "archive<=1.15 (pg_restore 16)");
    assert.equal(e.source, "manifest");
    return true;
  });
  assertArchiveReadable("1.15.0", 16, "header");
  assertArchiveReadable("1.14.0", 16, "header");
  assertArchiveReadable("1.16.0", 17, "header");
  assertArchiveReadable("1.16.0", 18, "header");
  assert.throws(() => assertArchiveReadable("1.17.0", 18, "header"), DumpArchiveIncompatibleError);
  assert.throws(() => assertArchiveReadable("2.0.0", 18, "header"), DumpArchiveIncompatibleError);
  assert.throws(() => assertArchiveReadable("1.14.0", 11, "header"), DumpArchiveIncompatibleError, "unknown client fails closed");
  assert.throws(() => assertArchiveReadable("garbage", 16, "header"), DumpArchiveIncompatibleError);
});

// ---------- engine ----------
async function backupWithHeader(minor: number | null) {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true });
  const run: CommandRunner = async (command, replacements, operation) => {
    if (command.executable === "pg_dump") {
      await writeFile(command.args[command.args.indexOf("--file") + 1]!, minor === null ? Buffer.from("dump") : header(minor));
      return { stdout: "", stderr: "" };
    }
    return remote.run(command, replacements, operation);
  };
  await createBackup(remote.config, { run, now: () => new Date("2026-03-01T00:00:00Z"), log: () => undefined });
  const artifact = [...remote.uploaded.keys()].find((k) => k.endsWith(".tar.enc"))!;
  const manifest = JSON.parse(remote.uploaded.get(`${artifact}.sha256.json`)!.toString("utf8")) as Record<string, unknown>;
  return { remote, artifact, manifest };
}

function restoreRunner(remote: Awaited<ReturnType<typeof createFakeRemote>>, calls: string[]): CommandRunner {
  return async (command, replacements, operation) => {
    calls.push(command.executable);
    if (command.executable === "decrypt") { await copyFile(replacements!.input!, replacements!.output!); return { stdout: "", stderr: "" }; }
    if (command.executable === "pg_restore") return { stdout: "", stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
    return remote.run(command, replacements, operation);
  };
}

test("backup records dumpArchiveVersion in the manifest when the dump has a custom-format header", async () => {
  const b = await backupWithHeader(15);
  try { assert.equal(b.manifest.dumpArchiveVersion, "1.15.0"); } finally { await b.remote.cleanup(); }
  const legacy = await backupWithHeader(null);
  try { assert.equal("dumpArchiveVersion" in legacy.manifest, false, "unreadable header -> field omitted (manifest shape unchanged)"); } finally { await legacy.remote.cleanup(); }
});

test("restore with a known pg_restore 16 refuses a 1.16 archive from the MANIFEST, before decrypt", async () => {
  const b = await backupWithHeader(16);
  const calls: string[] = [];
  try {
    await assert.rejects(
      restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run: restoreRunner(b.remote, calls), log: () => undefined, pgRestoreMajor: 16 }),
      (e: unknown) => e instanceof DumpArchiveIncompatibleError && e.source === "manifest",
    );
    assert.ok(calls.includes("download"));
    assert.ok(!calls.includes("decrypt") && !calls.includes("pg_restore"), `no decrypt/restore: ${calls.join(",")}`);
  } finally { await b.remote.cleanup(); }
});

test("legacy manifest (no version) + 1.16 dump header: refused from the HEADER after extract, before pg_restore", async () => {
  const b = await backupWithHeader(16);
  const calls: string[] = [];
  try {
    // Simulate a pre-WS4-06 manifest: strip the field, keep sha/bytes valid.
    const key = `${b.artifact}.sha256.json`;
    const m = JSON.parse(b.remote.uploaded.get(key)!.toString("utf8")) as Record<string, unknown>;
    delete m.dumpArchiveVersion;
    b.remote.uploaded.set(key, Buffer.from(JSON.stringify(m) + "\n"));
    await assert.rejects(
      restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run: restoreRunner(b.remote, calls), log: () => undefined, pgRestoreMajor: 16 }),
      (e: unknown) => e instanceof DumpArchiveIncompatibleError && e.source === "header",
    );
    assert.ok(calls.includes("decrypt"));
    assert.ok(!calls.includes("pg_restore"), `pg_restore must not run: ${calls.join(",")}`);
  } finally { await b.remote.cleanup(); }
});

test("known pg_restore + unreadable dump header fails closed before pg_restore", async () => {
  const b = await backupWithHeader(null);
  const calls: string[] = [];
  try {
    await assert.rejects(
      restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run: restoreRunner(b.remote, calls), log: () => undefined, pgRestoreMajor: 16 }),
      (e: unknown) => e instanceof DumpArchiveIncompatibleError && e.found === "archive unreadable",
    );
    assert.ok(!calls.includes("pg_restore"));
  } finally { await b.remote.cleanup(); }
});

test("same-version archive (1.15 with pg_restore 16) proceeds to pg_restore", async () => {
  const b = await backupWithHeader(15);
  const calls: string[] = [];
  try {
    await restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run: restoreRunner(b.remote, calls), log: () => undefined, pgRestoreMajor: 16 });
    assert.ok(calls.includes("pg_restore"));
  } finally { await b.remote.cleanup(); }
});

test("engine called without pgRestoreMajor behaves as before (no version check)", async () => {
  const b = await backupWithHeader(null);
  const calls: string[] = [];
  try {
    await restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run: restoreRunner(b.remote, calls), log: () => undefined });
    assert.ok(calls.includes("pg_restore"));
  } finally { await b.remote.cleanup(); }
});

// ---------- CLI (exit code) ----------
const TOOLS = ["pg_dump", "pg_restore", "psql", "tar", "encrypt", "decrypt", "upload", "download", "verify-download", "list", "remove", "alert"];
const ARTIFACT = "aee-protected-20261019T120000Z-0123456789ab.tar.enc";

async function cliRestore(opts: { archiveMinor: number; manifestVersion: boolean; pgRestore: string; server: string }) {
  const root = await mkdtemp(path.join(tmpdir(), "aee-ws4-06-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const t of TOOLS) { await writeFile(path.join(bin, t), "#!/bin/sh\nexit 0\n"); await chmod(path.join(bin, t), 0o755); }
  // Build a payload exactly like createBackup does: database.dump + inventory.json + documents.tar in payload.tar.
  const build = path.join(root, "build");
  await mkdir(path.join(build, "docs"), { recursive: true });
  await writeFile(path.join(build, "database.dump"), header(opts.archiveMinor));
  await writeFile(path.join(build, "inventory.json"), JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: [] }) + "\n");
  await runCommand({ executable: "tar", args: ["--create", "--file", path.join(build, "documents.tar"), "--directory", path.join(build, "docs"), "."] });
  const payload = path.join(root, "artifact.bin");
  await runCommand({ executable: "tar", args: ["--create", "--file", payload, "--directory", build, "database.dump", "inventory.json", "documents.tar"] });
  const bytes = await readFile(payload);
  const manifest: Record<string, unknown> = { version: 1, artifact: ARTIFACT, createdAt: "2026-10-19T02:00:00.000Z", sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  if (opts.manifestVersion) manifest.dumpArchiveVersion = `1.${opts.archiveMinor}.0`;
  await mkdir(path.join(root, "documents"), { recursive: true });
  const env: Record<string, string> = {
    PATH: bin, BACKUP_ENVIRONMENT: "production",
    DATABASE_URL: "postgresql://backup_user:synthetic-ws4-06@db.invalid:5432/aee",
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
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-ws4-06",
    BACKUP_RESTORE_ROOT: path.join(root, "restore-root"),
    BACKUP_RESTORE_DOCUMENT_DIRECTORY: path.join(root, "restore-root", "documents"),
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore_user:synthetic-ws4-06-r@restore.invalid:5432/aee_restore",
  };
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const runner = async (command: CommandSpec, replacements: Record<string, string> = {}) => {
    // Version probes are recorded separately so "pg_restore" in `calls` means a real restore run.
    calls.push(command.args.includes("--version") ? `${command.executable}:version` : command.executable);
    if (command.args.includes("--version")) return { stdout: `${command.executable} (PostgreSQL) ${command.executable === "pg_restore" ? opts.pgRestore : "16.15"}\n`, stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("server_version_num"))) return { stdout: `${opts.server}\n`, stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
    if (command.executable === "download") {
      if (replacements.object!.endsWith(".sha256.json")) await writeFile(replacements.destination!, JSON.stringify(manifest) + "\n");
      else await copyFile(payload, replacements.destination!);
      return { stdout: "", stderr: "" };
    }
    if (command.executable === "decrypt") { await copyFile(replacements.input!, replacements.output!); return { stdout: "", stderr: "" }; }
    if (command.executable === "tar") return runCommand(command);
    if (command.executable === "alert") return { stdout: "", stderr: "" };
    if (command.executable === "pg_restore") return { stdout: "", stderr: "" };
    throw new Error(`fake: ${command.executable} not available`);
  };
  const code = await runCli("restore", { argv: [`--artifact=${ARTIFACT}`, "--confirm-disposable"], env, run: runner as never, log: (e) => logs.push(e), stderr: () => {}, nodeVersion: "v24.22.0" });
  await rm(root, { recursive: true, force: true });
  return { code, calls, logs, preflight: logs.find((l) => l.event === "backup_preflight_failed") };
}

test("CLI: a 1.16 archive (manifest) with pg_restore 16 exits 69 before decrypt, naming the archive version", async () => {
  const r = await cliRestore({ archiveMinor: 16, manifestVersion: true, pgRestore: "16.15", server: "160014" });
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.deepEqual([r.preflight?.tool, r.preflight?.found, r.preflight?.required], ["pg_restore", "archive 1.16.0", "archive<=1.15 (pg_restore 16)"]);
  assert.ok(!r.calls.includes("decrypt") && !r.calls.includes("pg_restore"), r.calls.join(","));
});

test("CLI: a 1.16 archive with a legacy manifest exits 69 after decrypt but before pg_restore", async () => {
  const r = await cliRestore({ archiveMinor: 16, manifestVersion: false, pgRestore: "16.15", server: "160014" });
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.equal(r.preflight?.found, "archive 1.16.0");
  assert.ok(r.calls.includes("decrypt") && !r.calls.includes("pg_restore"), r.calls.join(","));
});

test("CLI: a 1.15 archive with pg_restore 16 is not refused for the archive version", async () => {
  const r = await cliRestore({ archiveMinor: 15, manifestVersion: true, pgRestore: "16.15", server: "160014" });
  assert.equal(r.preflight, undefined, JSON.stringify(r.logs));
  assert.ok(r.calls.includes("pg_restore"), r.calls.join(","));
});
