import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY } from "../artifacts.js";
import { buildChildEnv, createScopedRunner } from "../commands.js";
import { loadProductionBackupConfig } from "../config.js";
import { restoreBackup } from "../engine.js";
import type { BackupOperation, CommandSpec } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

// PH-7 R11 (LOCAL, unpublished, separate from PR #229): separate database allowlists for backup (pg_dump + source
// inventory) and restore (psql preflight, pg_restore, restored-inventory). Inert sentinel names only.

function envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const command = JSON.stringify(["tool", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db.invalid/aee",
    BACKUP_DOCUMENT_DIRECTORY: "/tmp/x/documents", BACKUP_STAGING_DIRECTORY: "/tmp/x/staging",
    BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command, BACKUP_DECRYPT_COMMAND: command,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["u", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["d", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["l", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["r", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["a", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: "/tmp/x/restore-root", BACKUP_RESTORE_DOCUMENT_DIRECTORY: "/tmp/x/restore-root/documents",
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore",
    BACKUP_ENV_ISOLATION: "true",
    BACKUP_ENV_DATABASE_ALLOW: "SENTINEL_DB_BACKUP_*",
    BACKUP_ENV_RESTORE_DATABASE_ALLOW: "SENTINEL_DB_RESTORE_*",
    ...extra,
  };
}

const ambient: NodeJS.ProcessEnv = {
  PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp",
  SENTINEL_DB_BACKUP_USER: "b", SENTINEL_DB_BACKUP_PASS: "b", SENTINEL_DB_RESTORE_USER: "r", SENTINEL_DB_RESTORE_PASS: "r",
};

test("D1 config: restore_database has its own allowlist and may not overlap the backup database allowlist", () => {
  const p = loadProductionBackupConfig(envFor()).envIsolation!;
  assert.deepEqual(p.operations.database, ["SENTINEL_DB_BACKUP_*"]);
  assert.deepEqual(p.operations.restore_database, ["SENTINEL_DB_RESTORE_*"]);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_ENV_RESTORE_DATABASE_ALLOW: "SENTINEL_DB_BACKUP_PASS" })), /database and restore_database allowlists overlap/);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_ENV_RESTORE_DATABASE_ALLOW: "SENTINEL_DB_*" })), /overlap/);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_ENV_RESTORE_DATABASE_ALLOW: "*" })), /every variable/);
  // Restore-database variables must not be admitted to any other operation either (e.g. the verifier).
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_ENV_VERIFY_DOWNLOAD_ALLOW: "SENTINEL_DB_RESTORE_USER" })), /overlap/);
});

test("D2 negative: restore-only database credentials are absent from backup (database) children, and vice versa", () => {
  const p = loadProductionBackupConfig(envFor()).envIsolation!;
  const backupEnv = buildChildEnv("database", p, ambient);
  assert.ok("SENTINEL_DB_BACKUP_USER" in backupEnv && "SENTINEL_DB_BACKUP_PASS" in backupEnv);
  assert.ok(!("SENTINEL_DB_RESTORE_USER" in backupEnv) && !("SENTINEL_DB_RESTORE_PASS" in backupEnv), "backup database child lacks restore credentials");
  const restoreEnv = buildChildEnv("restore_database", p, ambient);
  assert.ok("SENTINEL_DB_RESTORE_USER" in restoreEnv && "SENTINEL_DB_RESTORE_PASS" in restoreEnv);
  assert.ok(!("SENTINEL_DB_BACKUP_USER" in restoreEnv) && !("SENTINEL_DB_BACKUP_PASS" in restoreEnv), "restore database child lacks backup-dump credentials");
  for (const op of ["archive", "encrypt", "upload", "verify_download", "list", "delete", "alert", "decrypt", "restore_download"] as BackupOperation[]) {
    const env = buildChildEnv(op, p, ambient);
    assert.ok(!Object.keys(env).some((n) => n.startsWith("SENTINEL_DB_")), `${op} receives no database credentials`);
  }
});

test("D3 negative, fail closed: with no restore_database allowlist the restore database child gets the base environment only (never the backup allowlist)", () => {
  const p = loadProductionBackupConfig(envFor({ BACKUP_ENV_RESTORE_DATABASE_ALLOW: "" })).envIsolation!;
  assert.deepEqual(p.operations.restore_database, []);
  const env = buildChildEnv("restore_database", p, ambient);
  assert.ok(!Object.keys(env).some((n) => n.startsWith("SENTINEL_DB_")), "no inherited database credentials");
});

test("D4 real child processes: the OS environment of database vs restore_database children matches scope", async () => {
  const run = createScopedRunner(loadProductionBackupConfig(envFor()).envIsolation!, ambient);
  const dump: CommandSpec = { executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"] };
  const b = JSON.parse((await run(dump, {}, "database")).stdout) as string[];
  const r = JSON.parse((await run(dump, {}, "restore_database")).stdout) as string[];
  assert.ok(b.includes("SENTINEL_DB_BACKUP_PASS") && !b.includes("SENTINEL_DB_RESTORE_PASS"));
  assert.ok(r.includes("SENTINEL_DB_RESTORE_PASS") && !r.includes("SENTINEL_DB_BACKUP_PASS"));
});

test("D5 engine: restore's database children (preflight, pg_restore, restored inventory) are tagged restore_database, never database", async () => {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  const seen: Array<[string, BackupOperation | undefined]> = [];
  try {
    await remote.createBackup();
    const artifact = [...remote.uploaded.keys()].find((k) => k.startsWith("daily/") && k.endsWith(".tar.enc"))!.slice("daily/".length);
    await restoreBackup(remote.config, { artifact, confirmDisposable: true, tier: "daily" }, {
      run: async (command, replacements, operation) => {
        seen.push([command.executable, operation]);
        // The fake harness has no decrypt / pg_restore / preflight; stand in for them so restore reaches the database steps.
        if (command.executable === "decrypt") { await copyFile(replacements!.input!, replacements!.output!); return { stdout: "", stderr: "" }; }
        if (command.executable === "pg_restore") return { stdout: "", stderr: "" };
        if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
        return remote.run(command, replacements, operation);
      },
      log: () => undefined,
    });
    const db = seen.filter(([e]) => e === "psql" || e === "pg_restore" || e === "pg_dump");
    assert.deepEqual(db.map(([e]) => e), ["psql", "pg_restore", "psql"], "preflight, pg_restore, restored inventory");
    for (const [e, op] of db) assert.equal(op, "restore_database", `${e} on restore is tagged restore_database`);
    assert.ok(!seen.some(([, op]) => op === "database"), "no restore child uses the backup database operation");
    assert.ok(!seen.some(([, op]) => op === "upload" || op === "delete" || op === "list" || op === "encrypt"), "no writer operation during restore");
  } finally {
    await remote.cleanup();
  }
});

test("D6 engine: backup's database children (pg_dump, source inventory) are tagged database, never restore_database", async () => {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true, configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } });
  const seen: Array<[string, BackupOperation | undefined]> = [];
  try {
    const { createBackup } = await import("../engine.js");
    await createBackup(remote.config, {
      run: (command, replacements, operation) => { seen.push([command.executable, operation]); return remote.run(command, replacements, operation); },
      log: () => undefined,
    });
    const db = seen.filter(([e]) => e === "psql" || e === "pg_dump");
    assert.ok(db.some(([e]) => e === "pg_dump") && db.some(([e]) => e === "psql"));
    for (const [e, op] of db) assert.equal(op, "database", `${e} on backup is tagged database`);
    assert.ok(!seen.some(([, op]) => op === "restore_database" || op === "decrypt" || op === "restore_download"));
  } finally {
    await remote.cleanup();
  }
});
