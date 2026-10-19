// WS4-02 (F1, WS4 drill 19 Oct 2026): pg_restore 17.x into a PostgreSQL 16 target fails mid-restore with
// `unrecognized configuration parameter "transaction_timeout"`. CLI-SPEC §4 only required client >= server, so the
// preflight let that through. Restore now also refuses pg_restore NEWER than the restore target's server major:
// exit 69 (PREFLIGHT), before any download/decrypt/restore work. Backup keeps the existing rule (pg_dump >= server).
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EXIT, runCli } from "../cli.js";
import type { CommandSpec, OperationLog } from "../types.js";

const ARTIFACT = "aee-protected-20261019T095837Z-f96fc40e8bfa.tar.enc";
const TOOLS = ["pg_dump", "pg_restore", "psql", "tar", "encrypt", "decrypt", "upload", "download", "verify-download", "list", "remove", "alert"];

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "aee-ws4-pgver-"));
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  for (const t of TOOLS) {
    await writeFile(path.join(bin, t), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, t), 0o755);
  }
  await mkdir(path.join(root, "documents"), { recursive: true });
  const env: Record<string, string> = {
    PATH: bin,
    BACKUP_ENVIRONMENT: "production",
    DATABASE_URL: "postgresql://backup_user:synthetic-db-pass-ws4@db.invalid:5432/aee",
    BACKUP_DOCUMENT_DIRECTORY: path.join(root, "documents"),
    BACKUP_STAGING_DIRECTORY: path.join(root, "staging"),
    BACKUP_DESTINATION: "s3://vault/backups",
    BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: JSON.stringify(["encrypt", "{input}", "{output}", "{kmsProfile}"]),
    BACKUP_DECRYPT_COMMAND: JSON.stringify(["decrypt", "{input}", "{output}", "{kmsProfile}"]),
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["upload", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["download", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["list", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["remove", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["alert", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true",
    BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true",
    BACKUP_RESTORE_ENVIRONMENT_ID: "restore-ws4-pgver",
    BACKUP_RESTORE_ROOT: path.join(root, "restore-root"),
    BACKUP_RESTORE_DOCUMENT_DIRECTORY: path.join(root, "restore-root", "documents"),
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore_user:synthetic-restore-pass-ws4@restore.invalid:5432/aee_restore",
  };
  return { root, env };
}

async function run(kind: "backup" | "restore", versions: Record<string, string>, serverVersionNum: string) {
  const { root, env } = await setup();
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const runner = async (command: CommandSpec) => {
    calls.push(command.executable);
    if (command.args.includes("--version")) return { stdout: `${command.executable} (PostgreSQL) ${versions[command.executable] ?? "16.15"}\n`, stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("server_version_num"))) return { stdout: `${serverVersionNum}\n`, stderr: "" };
    if (command.executable === "alert") return { stdout: "", stderr: "" };
    throw new Error(`fake: ${command.executable} not available in this test`); // engine work fails fast after preflight
  };
  const code = await runCli(kind, {
    argv: kind === "restore" ? [`--artifact=${ARTIFACT}`, "--tier=daily", "--confirm-disposable"] : [],
    env,
    run: runner,
    log: (e) => logs.push(e),
    stderr: () => {},
    nodeVersion: "v24.22.0",
  });
  await rm(root, { recursive: true, force: true });
  return { code, calls, logs, preflight: logs.find((l) => l.event === "backup_preflight_failed") };
}

test("WS4 F1: restore refuses pg_restore 17 against a PG16 target with exit 69, before any download", async () => {
  const r = await run("restore", { pg_restore: "17.11", psql: "17.11" }, "160014");
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.equal(r.code, 69);
  assert.deepEqual([r.preflight?.tool, r.preflight?.found, r.preflight?.required], ["pg_restore", "17", "==16"]);
  assert.ok(!r.calls.includes("download") && !r.calls.includes("decrypt"), "no restore work after a failed preflight");
  assert.ok(r.calls.includes("alert"), "preflight failure is alerted (existing CLI behaviour)");
});

test("WS4 F1: restore with pg_restore 16 against a PG16 target passes preflight (engine work then runs)", async () => {
  const r = await run("restore", { pg_restore: "16.15", psql: "17.11" }, "160014");
  assert.equal(r.preflight, undefined, "no preflight failure");
  assert.notEqual(r.code, EXIT.PREFLIGHT);
  assert.ok(r.calls.includes("download"), "restore proceeded to download");
});

test("WS4 F1: restore still refuses pg_restore OLDER than the target (existing >= rule kept)", async () => {
  const r = await run("restore", { pg_restore: "15.8", psql: "16.15" }, "160014");
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.equal(r.preflight?.tool, "pg_restore");
});

test("WS4 F1: psql newer than the restore target is still allowed (only pg_restore emits version-specific SETs)", async () => {
  const r = await run("restore", { pg_restore: "16.15", psql: "17.11" }, "160014");
  assert.notEqual(r.code, EXIT.PREFLIGHT);
});

test("WS4 F1: backup keeps the existing rule — pg_dump 17 against a PG16 source is not refused by preflight", async () => {
  const r = await run("backup", { pg_dump: "17.11", psql: "17.11" }, "160014");
  assert.equal(r.preflight, undefined);
  assert.notEqual(r.code, EXIT.PREFLIGHT);
});

test("WS4 F1: unparseable pg_restore version against a known target fails closed (69)", async () => {
  const r = await run("restore", { pg_restore: "garbage" }, "160014");
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.equal(r.preflight?.tool, "pg_restore");
});
