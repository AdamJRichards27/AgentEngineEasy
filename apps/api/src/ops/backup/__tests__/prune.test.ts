import assert from "node:assert/strict";
import { test } from "node:test";
import { planRetention } from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import { artifactKey, bk, merge, type Listing } from "./retentionFixtures.js";
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

// PH-7 R29b: only VERIFIED backups (artifact + manifest + matching .verified.json) count toward keep, and
// backup units are only deleted once a RESTORE_VERIFIED point exists (RETENTION-SAFEGUARD-SPEC). The
// fixtures below give every backup a verified marker and the newest one a restore-verified marker.
const NOW = new Date("2027-01-02T00:00:00Z");
function backups(days: number[], options: { manifestless?: number[]; restoreOn?: number } = {}): Listing {
  const newest = options.restoreOn ?? Math.max(...days);
  return merge(
    ...days.map((d) =>
      options.manifestless?.includes(d) ? bk(d, { manifest: false }) : bk(d, { verified: "ok", restore: d === newest ? "ok" : false }),
    ),
  );
}
const planOf = (l: Listing, cutoff: Date, options: { minRetained: number; protectedArtifact?: string }) =>
  planRetention(l.objects, cutoff, { ...options, evidence: l.evidence, now: NOW });

test("planRetention never deletes the newest minRetained verified backups even when all are expired", () => {
  const plan = planOf(backups([1, 2, 3, 4, 5]), new Date("2027-01-01T00:00:00Z"), { minRetained: 2 });
  assert.deepEqual(plan.retained, [artifactKey(5), artifactKey(4)]);
  const deleted = keys(plan.delete);
  assert.equal(deleted.length, 9, "three units of artifact + manifest + marker");
  assert.ok(!deleted.some((k) => k.includes("20260105") || k.includes("20260104")));
  assert.equal(plan.protectedByGuard.length, 2);
});

test("planRetention deletes an artifact before its manifest and markers, always together", () => {
  const plan = planOf(backups([1, 2]), new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.deepEqual(keys(plan.delete), [artifactKey(1), `${artifactKey(1)}.sha256.json`, `${artifactKey(1)}.verified.json`]);
});

test("planRetention does not delete anything when no recoverable backup exists", () => {
  const objects = [...backup(1, false), { key: "aee-protected-20260102T000000Z-000000000002.tar.enc.sha256.json", lastModified: "2026-01-02T00:00:00Z" }];
  const plan = planRetention(objects, new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.deepEqual(plan.delete, []);
  assert.deepEqual(plan.retained, []);
});

test("planRetention does not delete anything when no VERIFIED backup exists (legacy marker-less pairs)", () => {
  const plan = planRetention([1, 2, 3].flatMap((d) => backup(d)), new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.deepEqual(plan.delete, []);
  assert.deepEqual(plan.retained, []);
});

test("planRetention does not count an artifact without a manifest as retained; orphans go by age only", () => {
  const listing = merge(backups([1, 2], { restoreOn: 2 }), bk(9, { manifest: false }), bk(3, { artifact: false }));
  const plan = planOf(listing, new Date("2027-01-01T00:00:00Z"), { minRetained: 1 });
  assert.equal(plan.retained[0], artifactKey(2), "newest VERIFIED backup is kept, not the manifest-less newest object");
  const deleted = keys(plan.delete);
  assert.ok(deleted.includes(artifactKey(1)));
  assert.ok(deleted.includes(`${artifactKey(3)}.sha256.json`), "orphan manifest is pruned by age");
  // Behaviour change (R29/R29b): a manifest-less artifact NEWER than the protected backups is no longer
  // deleted; only units older than every protected backup are deletable (AC4 monotonicity).
  assert.ok(!deleted.includes(artifactKey(9)));
  assert.ok(!deleted.some((k) => k.startsWith(artifactKey(2))));
});

test("planRetention honours the cutoff, the protected artifact, bad timestamps and unrelated objects", () => {
  const listing = backups([1, 2, 3]);
  listing.objects.push({ key: "customer-data.csv", lastModified: "2000-01-01T00:00:00Z" });
  listing.objects.push({ key: "aee-protected-bad.tar.enc", lastModified: "garbage" });
  const plan = planOf(listing, new Date("2026-01-03T12:00:00Z"), { minRetained: 1, protectedArtifact: artifactKey(1) });
  const deleted = keys(plan.delete);
  assert.deepEqual(deleted, [artifactKey(2), `${artifactKey(2)}.sha256.json`, `${artifactKey(2)}.verified.json`]);
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
 * Assertions below are unchanged from the original #224 tests except where marked R29b.
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
    prune: true,
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
  // R29b: the fake remote seeds .verified.json markers (and a restore-verified marker on the newest pair).
  assert.deepEqual(removed, [
    "aee-protected-20260101T000000Z-000000000001.tar.enc",
    "aee-protected-20260101T000000Z-000000000001.tar.enc.sha256.json",
    "aee-protected-20260101T000000Z-000000000001.tar.enc.verified.json",
  ]);
  const done = logs.find((l) => l.event === "completed");
  assert.equal(done?.pruned, 3);
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
  assert.equal(failures.length, 1, "D-3: pruning stops at the first refused delete (was: every object attempted)");
  assert.equal(failures[0]?.level, "error");
  assert.equal(logs.find((l) => l.event === "completed")?.pruneFailed, 1);
  assert.ok(logs.some((l) => l.event === "prune_stopped"));
});
