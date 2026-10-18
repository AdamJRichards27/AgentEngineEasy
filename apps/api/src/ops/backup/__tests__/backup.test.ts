import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { artifactName, retentionCandidates, verifyManifest, writeManifest } from "../artifacts.js";
import { runCommand } from "../commands.js";
import { loadProductionBackupConfig } from "../config.js";
import { validateDatabaseInventory } from "../database.js";
import { compareDocumentKeys, documentInventory } from "../documents.js";
import { createBackup, restoreBackup } from "../engine.js";
import type { BackupConfig, CommandSpec, OperationLog } from "../types.js";

function productionEnvironment(root: string): NodeJS.ProcessEnv {
  const command = JSON.stringify(["tool", "--input={input}", "--output={output}", "--kms={kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production",
    DATABASE_URL: "postgresql://db.example.invalid/aee",
    BACKUP_DOCUMENT_DIRECTORY: path.join(root, "documents"),
    BACKUP_STAGING_DIRECTORY: path.join(root, "staging"),
    BACKUP_DESTINATION: "s3://vault/backups",
    BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command,
    BACKUP_DECRYPT_COMMAND: command,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["upload", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["download", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["list", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["delete", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["alert", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true",
    BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true",
    BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: path.join(root, "restore-root"),
    BACKUP_RESTORE_DOCUMENT_DIRECTORY: path.join(root, "restore-root", "documents"),
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore",
  };
}

function config(root: string): BackupConfig {
  const spec = (executable: string): CommandSpec => ({ executable, args: [] });
  return {
    databaseUrl: "postgresql://source.invalid/aee",
    documentDirectory: path.join(root, "documents"),
    restoreDatabaseUrl: "postgresql://restore.invalid/aee_restore",
    restoreDocumentDirectory: path.join(root, "restore-root", "documents"),
    restoreRoot: path.join(root, "restore-root"),
    restoreEnvironmentId: "restore-drill-01",
    encryptionKmsProfile: "kms:production-backup",
    stagingDirectory: path.join(root, "staging"),
    destination: "durable://vault/backups",
    retentionDays: 30,
    encryption: spec("encrypt"),
    decryption: spec("decrypt"),
    upload: spec("upload"),
    download: spec("download"),
    list: spec("list"),
    remove: spec("remove"),
    alert: spec("alert"),
  };
}

test("production configuration is explicit and rejects filesystem destinations", () => {
  assert.throws(() => loadProductionBackupConfig({}), /BACKUP_ENVIRONMENT must explicitly equal production/);
  const env = productionEnvironment("/tmp/config-test");
  env.BACKUP_DESTINATION = "file:///tmp/not-durable";
  assert.throws(() => loadProductionBackupConfig(env), /supported durable object-store scheme/);
  env.BACKUP_DESTINATION = "s3://real-backups/prefix";
  assert.equal(loadProductionBackupConfig(env).retentionDays, 30);
  env.BACKUP_DESTINATION = "https://bucket.example/backups";
  assert.throws(() => loadProductionBackupConfig(env), /supported durable object-store scheme/);
  env.BACKUP_DESTINATION = "s3://real-backups/prefix";
  env.BACKUP_ENCRYPTION_AUTHENTICATED = "false";
  assert.throws(() => loadProductionBackupConfig(env), /AUTHENTICATED/);
});

test("artifact names are timestamped, protected, and contain no source identity", () => {
  assert.equal(
    artifactName(new Date("2026-01-02T03:04:05.000Z"), "abcdef012345"),
    "aee-protected-20260102T030405Z-abcdef012345.tar.enc",
  );
  assert.throws(() => artifactName(new Date(), "../unsafe123"), /nonce/);
});

test("SHA-256 manifest detects artifact corruption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-backup-hash-"));
  try {
    const artifact = path.join(root, "aee-protected-20260102T030405Z-abcdef012345.tar.enc");
    await writeFile(artifact, "encrypted bytes");
    const manifest = await writeManifest(artifact, "2026-01-02T03:04:05.000Z");
    assert.equal((await verifyManifest(artifact, manifest)).bytes, 15);
    await writeFile(artifact, "tampered bytes");
    await assert.rejects(verifyManifest(artifact, manifest), /does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention only prunes old protected artifacts", () => {
  const selected = retentionCandidates(
    [
      { key: "aee-protected-old.tar.enc", lastModified: "2025-01-01T00:00:00Z" },
      { key: "aee-protected-new.tar.enc", lastModified: "2026-01-09T00:00:00Z" },
      { key: "unrelated-customer-object", lastModified: "2020-01-01T00:00:00Z" },
      { key: "aee-protected-invalid.tar.enc", lastModified: "not-a-date" },
    ],
    new Date("2026-01-01T00:00:00Z"),
  );
  assert.deepEqual(selected.map((item) => item.key), ["aee-protected-old.tar.enc"]);
});

test("document inventory detects missing and orphaned content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-backup-docs-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "signed.pdf"), "pdf");
    await writeFile(path.join(root, "orphan.pdf"), "pdf");
    const files = await documentInventory(root);
    assert.deepEqual(files, ["nested/signed.pdf", "orphan.pdf"]);
    assert.deepEqual(compareDocumentKeys(["nested/signed.pdf", "missing.pdf"], files), {
      missing: ["missing.pdf"],
      orphaned: ["orphan.pdf"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant and every-table record counts must match after restore", () => {
  const expected = { tenantCount: 2, recordCounts: { brokerages: 2, users: 10 }, documentKeys: ["a.pdf"] };
  validateDatabaseInventory(expected, structuredClone(expected));
  assert.throws(
    () => validateDatabaseInventory(expected, { ...expected, tenantCount: 1 }),
    /Tenant validation failed/,
  );
  assert.throws(
    () => validateDatabaseInventory(expected, { ...expected, recordCounts: { brokerages: 2, users: 9 } }),
    /users:10!=9/,
  );
  assert.throws(
    () => validateDatabaseInventory(expected, { ...expected, documentKeys: ["b.pdf"] }),
    /document-key records/,
  );
});

test("backup failure emits a structured failure log, invokes alert hook, and removes plaintext staging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-backup-failure-"));
  const calls: string[] = [];
  const logs: OperationLog[] = [];
  const backupConfig = config(root);
  try {
    await assert.rejects(
      createBackup(backupConfig, {
        run: async (command) => {
          calls.push(command.executable);
          if (command.executable === "pg_dump") throw new Error("dump unavailable");
          return { stdout: "", stderr: "" };
        },
        log: (entry) => logs.push(entry),
      }),
      /dump unavailable/,
    );
    assert.deepEqual(calls, ["pg_dump", "alert"]);
    assert.equal(logs[0]?.operation, "backup");
    assert.equal(logs[0]?.event, "failed");
    assert.equal(logs[0]?.level, "error");
    await assert.rejects(readFile(backupConfig.stagingDirectory), /ENOENT|EISDIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore refuses equivalent source/target identity before downloading any artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-restore-guard-"));
  let called = false;
  try {
    const unsafeConfig = { ...config(root), restoreDatabaseUrl: "postgres://source.invalid:5432/aee" };
    await assert.rejects(
      restoreBackup(
        unsafeConfig,
        {
          artifact: "aee-protected-20260102T030405Z-abcdef012345.tar.enc",
          confirmDisposable: true,
        },
        {
          run: async () => {
            called = true;
            return { stdout: "", stderr: "" };
          },
        },
      ),
      /identities are equivalent/,
    );
    assert.equal(called, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore requires confirmation and preflight blocks destructive pg_restore on populated targets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-restore-preflight-"));
  const backupConfig = config(root);
  const calls: string[] = [];
  try {
    await assert.rejects(
      restoreBackup(backupConfig, { artifact: "aee-protected-20260102T030405Z-abcdef012345.tar.enc", confirmDisposable: false }, {
        run: async (command) => {
          calls.push(command.executable);
          return { stdout: "", stderr: "" };
        },
      }),
      /explicit disposable-database confirmation/,
    );
    assert.deepEqual(calls, []);

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("encrypted artifact round trip archives and restores database metadata and documents", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-backup-roundtrip-"));
  const backupConfig = config(root);
  const remote = new Map<string, Buffer>();
  const inventory = {
    tenantCount: 2,
    recordCounts: { brokerages: 2, documents: 1 },
    documentKeys: ["signed/contract.pdf"],
  };
  let targetPublicTables = 0;
  let pgRestoreCalls = 0;
  const runner = async (
    command: CommandSpec,
    replacements: Record<string, string> = {},
  ): Promise<{ stdout: string; stderr: string }> => {
    switch (command.executable) {
      case "pg_dump": {
        const output = command.args[command.args.indexOf("--file") + 1];
        await writeFile(output!, "custom-format-dump");
        return { stdout: "", stderr: "" };
      }
      case "psql":
        if (command.args.some((arg) => arg.includes("count(*) FROM information_schema.tables"))) {
          return { stdout: `${targetPublicTables}\n`, stderr: "" };
        }
        return { stdout: JSON.stringify(inventory), stderr: "" };
      case "pg_restore":
        pgRestoreCalls += 1;
        return { stdout: "", stderr: "" };
      case "tar":
        return runCommand(command);
      case "encrypt":
      case "decrypt":
        await copyFile(replacements.input!, replacements.output!);
        return { stdout: "", stderr: "" };
      case "upload":
        remote.set(replacements.destination!, await readFile(replacements.source!));
        return { stdout: "", stderr: "" };
      case "download": {
        const content = remote.get(replacements.source!);
        if (!content) throw new Error(`missing test remote object ${replacements.source}`);
        await writeFile(replacements.destination!, content);
        return { stdout: "", stderr: "" };
      }
      case "list":
        return { stdout: "[]", stderr: "" };
      default:
        throw new Error(`unexpected command ${command.executable}`);
    }
  };
  try {
    await mkdir(path.join(backupConfig.documentDirectory!, "signed"), { recursive: true });
    await writeFile(path.join(backupConfig.documentDirectory!, "signed", "contract.pdf"), "signed document");
    const artifact = await createBackup(backupConfig, {
      run: runner,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
      log: () => undefined,
    });
    assert.equal(remote.size, 2);

    targetPublicTables = 1;
    await assert.rejects(
      restoreBackup(backupConfig, { artifact, confirmDisposable: true }, { run: runner, log: () => undefined }),
      /preflight refused populated database/,
    );
    assert.equal(pgRestoreCalls, 0, "preflight must stop the destructive --clean path");

    targetPublicTables = 0;
    await restoreBackup(
      backupConfig,
      {
        artifact,
        confirmDisposable: true,
      },
      { run: runner, log: () => undefined },
    );
    assert.equal(
      await readFile(path.join(backupConfig.restoreDocumentDirectory, "signed", "contract.pdf"), "utf8"),
      "signed document",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});