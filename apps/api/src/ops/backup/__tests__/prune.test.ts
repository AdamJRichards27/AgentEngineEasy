import assert from "node:assert/strict";
import { test } from "node:test";
import { planRetention } from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import type { OperationLog, RemoteObject } from "../types.js";

const hex = (n: number): string => n.toString(16).padStart(12, "0");
function backup(day: number, withManifest = true): RemoteObject[] {
  const stamp = `202601${String(day).padStart(2, "0")}T000000Z`;
  const name = `aee-protected-${stamp}-${hex(day)}.tar.enc`;
  const when = `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
  return withManifest
    ? [{ key: name, lastModified: when }, { key: `${name}.sha256.json`, lastModified: when }]
    : [{ key: name, lastModified: when }];
}
const keys = (objects: RemoteObject[]): string[] => objects.map((o) => o.key);

test("planRetention never deletes the newest minRetained recoverable backups even when all are expired", () => {
  const objects = [1, 2, 3, 4, 5].flatMap((d) => backup(d));
  const plan = planRetention(objects, new Date("2027-01-01T00:00:00Z"), { minRetained: 2 });
  assert.equal(plan.retained.length, 2);
  assert.ok(plan.retained[0]!.includes("20260105"));
  const deleted = keys(plan.delete);
  assert.equal(deleted.length, 6);
  assert.ok(!deleted.some((k) => k.includes("20260105") || k.includes("20260104")));
  assert.equal(plan.protectedByGuard.length, 2);
});

test("planRetention deletes an artifact before its manifest and always together", () => {
  const plan = planRetention([...backup(1), ...backup(2)], new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.deepEqual(keys(plan.delete), [
    "aee-protected-20260101T000000Z-000000000001.tar.enc",
    "aee-protected-20260101T000000Z-000000000001.tar.enc.sha256.json",
  ]);
});

test("planRetention does not delete anything when no recoverable backup exists", () => {
  const objects = [...backup(1, false), { key: "aee-protected-20260102T000000Z-000000000002.tar.enc.sha256.json", lastModified: "2026-01-02T00:00:00Z" }];
  const plan = planRetention(objects, new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.deepEqual(plan.delete, []);
  assert.deepEqual(plan.retained, []);
});

test("planRetention does not count an artifact without a manifest as a retained backup and prunes orphans", () => {
  const newestUnrecoverable = backup(9, false);
  const plan = planRetention(
    [...backup(1), ...backup(2), ...newestUnrecoverable, { key: "aee-protected-20260103T000000Z-000000000003.tar.enc.sha256.json", lastModified: "2026-01-03T00:00:00Z" }],
    new Date("2027-01-01T00:00:00Z"),
    { minRetained: 1 },
  );
  assert.ok(plan.retained[0]!.includes("20260102"), "newest RECOVERABLE backup is kept, not the manifest-less newest object");
  const deleted = keys(plan.delete);
  assert.ok(deleted.some((k) => k.includes("000000000001")));
  assert.ok(deleted.some((k) => k.includes("20260103") && k.endsWith(".sha256.json")));
  assert.ok(deleted.some((k) => k.includes("20260109")), "old manifest-less artifact may go once a recoverable backup is retained");
  assert.ok(!deleted.some((k) => k.includes("20260102")));
});

test("planRetention honours the cutoff, the protected artifact, bad timestamps and unrelated objects", () => {
  const objects: RemoteObject[] = [
    ...backup(1),
    ...backup(2),
    ...backup(3),
    { key: "customer-data.csv", lastModified: "2000-01-01T00:00:00Z" },
    { key: "aee-protected-bad.tar.enc", lastModified: "garbage" },
  ];
  const plan = planRetention(objects, new Date("2026-01-03T12:00:00Z"), {
    minRetained: 1,
    protectedArtifact: "aee-protected-20260101T000000Z-000000000001.tar.enc",
  });
  const deleted = keys(plan.delete);
  assert.deepEqual(deleted.map((k) => k.slice(0, 30)), ["aee-protected-20260102T000000Z", "aee-protected-20260102T000000Z"]);
  assert.ok(!deleted.includes("customer-data.csv"));
  assert.ok(!deleted.includes("aee-protected-bad.tar.enc"));
});

test("BACKUP_MIN_RETAINED_COUNT defaults to 7 and rejects invalid values", () => {
  const base = (extra: Record<string, string>): NodeJS.ProcessEnv => {
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
  };
  assert.equal(loadProductionBackupConfig(base({})).minRetainedBackups, 7);
  assert.equal(loadProductionBackupConfig(base({ BACKUP_MIN_RETAINED_COUNT: "3" })).minRetainedBackups, 3);
  for (const bad of ["0", "-1", "1.5", "abc"]) {
    assert.throws(() => loadProductionBackupConfig(base({ BACKUP_MIN_RETAINED_COUNT: bad })), /BACKUP_MIN_RETAINED_COUNT/);
  }
});


/**
 * Engine-level tests run the REAL createBackup() against the shared fake remote
 * (helpers/fakeBackupRemote.ts), which implements upload/download/list/delete so that
 * post-upload verification (engine.ts verifyUploadedBackup) really passes before prune runs.
 * Assertions below are unchanged from the original #224 tests.
 */
async function runEngine(
  remoteListing: RemoteObject[],
  retentionDays: number,
  minRetained: number,
  failRemove = false,
): Promise<{ removed: string[]; logs: OperationLog[]; name: string }> {
  const remote = await createFakeRemote({
    seed: remoteListing,
    retentionDays,
    minRetainedBackups: minRetained,
    failRemove,
    now: new Date("2026-03-01T00:00:00Z"),
  });
  try {
    const name = await remote.createBackup();
    return { removed: remote.removed, logs: remote.logs, name };
  } finally {
    await remote.cleanup();
  }
}


test("createBackup with BACKUP_RETENTION_DAYS=1 still keeps the minimum recoverable backups", async () => {
  const listing = [1, 2, 3, 4].flatMap((d) => backup(d));
  const { removed, logs } = await runEngine(listing, 1, 3);
  assert.deepEqual(removed.sort(), [
    "aee-protected-20260101T000000Z-000000000001.tar.enc",
    "aee-protected-20260101T000000Z-000000000001.tar.enc.sha256.json",
  ]);
  const done = logs.find((l) => l.event === "completed");
  assert.equal(done?.pruned, 2);
  assert.equal(done?.pruneProtected, 3);
});

test("createBackup never prunes when the only recoverable backups are within the minimum", async () => {
  const { removed } = await runEngine(backup(1), 1, 7);
  assert.deepEqual(removed, []);
});

test("a prune delete refused by Object Lock is logged loudly but does not fail the stored backup", async () => {
  const listing = [1, 2].flatMap((d) => backup(d));
  const { removed, logs, name } = await runEngine(listing, 1, 1, true);
  assert.ok(name.startsWith("aee-protected-"));
  assert.deepEqual(removed, []);
  const failures = logs.filter((l) => l.event === "prune_delete_failed");
  assert.equal(failures.length, 2);
  assert.equal(failures[0]?.level, "error");
  assert.equal(logs.find((l) => l.event === "completed")?.pruneFailed, 2);
});
