import assert from "node:assert/strict";
import { test } from "node:test";
import { loadProductionBackupConfig } from "../config.js";
import { restoreBackup } from "../engine.js";
import type { CommandSpec, OperationLog } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

// PH-7 Package B (LOCAL, unpublished): optional separate verifier / restore download commands.
// Uses the same shared fake remote; the engine is not stubbed.

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
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore", ...extra,
  };
}

const spec = (executable: string): CommandSpec => ({ executable, args: [] });

test("B1 config: verifier/restore download commands are optional, validated, and absent by default", () => {
  const base = loadProductionBackupConfig(envFor());
  assert.equal(base.verifyDownload, undefined);
  assert.equal(base.restoreDownload, undefined);
  assert.ok(!("verifyDownload" in base) && !("restoreDownload" in base));
  const cfg = loadProductionBackupConfig(envFor({
    BACKUP_VERIFY_DOWNLOAD_COMMAND: JSON.stringify(["aws-verifier", "{source}", "{destination}"]),
    BACKUP_RESTORE_DOWNLOAD_COMMAND: JSON.stringify(["aws-restore", "{source}", "{destination}"]),
  }));
  assert.equal(cfg.verifyDownload?.executable, "aws-verifier");
  assert.equal(cfg.restoreDownload?.executable, "aws-restore");
  assert.equal(cfg.download.executable, "d", "writer-side download command is unchanged");
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_VERIFY_DOWNLOAD_COMMAND: JSON.stringify(["v", "{source}"]) })), /BACKUP_VERIFY_DOWNLOAD_COMMAND must include the \{destination\}/);
  assert.throws(() => loadProductionBackupConfig(envFor({ BACKUP_RESTORE_DOWNLOAD_COMMAND: "not json" })), /BACKUP_RESTORE_DOWNLOAD_COMMAND must be a JSON array/);
});

test("B2 engine: with a verifier command, every tier copy is verified through it (never the writer download) before list/remove", async () => {
  const remote = await createFakeRemote({
    seed: [], listIncludesUploads: true,
    configOverrides: { verifyDownload: spec("verify-download") },
  });
  try {
    await remote.createBackup();
    assert.ok(!remote.calls.some((c) => c.startsWith("download")), "writer download identity is not used for verification");
    const verifies = remote.calls.filter((c) => c.startsWith("verify-download"));
    assert.ok(verifies.length >= 2 && verifies.length % 2 === 0, "artifact + manifest per tier copy");
    const lastVerify = remote.calls.map((c, i) => (c.startsWith("verify-download") ? i : -1)).reduce((a, b) => Math.max(a, b));
    const firstList = remote.calls.indexOf("list");
    assert.ok(firstList === -1 || firstList > lastVerify, "verification precedes prune listing");
  } finally {
    await remote.cleanup();
  }
});

test("B3 engine: a verifier failure through the verifier command stops the run before any list/remove", async () => {
  const remote = await createFakeRemote({
    seed: [], listIncludesUploads: true, failDownload: /\.tar\.enc$/,
    configOverrides: { verifyDownload: spec("verify-download") },
  });
  try {
    await assert.rejects(remote.createBackup(), /Post-upload verification failed/);
    assert.ok(!remote.calls.includes("list"));
    assert.equal(remote.removed.length, 0);
  } finally {
    await remote.cleanup();
  }
});

test("B4 engine: without a verifier command behaviour is unchanged (falls back to download)", async () => {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true });
  try {
    await remote.createBackup();
    assert.ok(remote.calls.some((c) => c.startsWith("download:")));
    assert.ok(!remote.calls.some((c) => c.startsWith("verify-download") || c.startsWith("restore-download")));
  } finally {
    await remote.cleanup();
  }
});

test("B5 restore: uses the restore download command when configured and never the writer download", async () => {
  const remote = await createFakeRemote({ configOverrides: { restoreDownload: spec("restore-download") } });
  const seen: string[] = [];
  const logs: OperationLog[] = [];
  const run = async (command: { executable: string }) => {
    seen.push(command.executable);
    if (command.executable === "alert") return { stdout: "", stderr: "" };
    throw new Error("stop after first download");
  };
  try {
    const cfg = { ...remote.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" };
    await assert.rejects(
      restoreBackup(cfg, { artifact: "aee-protected-20260101T000000Z-0123456789ab.tar.enc", confirmDisposable: true }, { run: run as never, log: (e) => logs.push(e) }),
      /stop after first download/,
    );
    assert.equal(seen[0], "restore-download");
    assert.ok(!seen.includes("download"));
  } finally {
    await remote.cleanup();
  }
});
