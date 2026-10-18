import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY, type Tier } from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { productionEnv } from "./helpers/productionEnv.js";
import { createFakeRemote, type FakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

// PH-7 R18 / D-9: a delete command's successful exit is NOT proof of permanent deletion (versioned and Object
// Lock buckets answer a plain delete with a delete marker and keep the data). The engine must never record a
// deletion as verified unless an explicit post-delete verification command confirmed it.
const NOW = new Date("2026-03-01T00:00:00Z");
const hex = (n: number): string => n.toString(16).padStart(12, "0");
const POLICY = { daily: { keep: 2, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly };
function backup(tier: Tier, n: number): RemoteObject[] {
  const day = new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);
  const stamp = day.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `aee-protected-${stamp}-${hex(n)}.tar.enc`;
  return [{ key: `${tier}/${name}`, lastModified: day.toISOString() }, { key: `${tier}/${name}.sha256.json`, lastModified: day.toISOString() }];
}
const seed6 = [1, 2, 3, 4, 5, 6].flatMap((n) => backup("daily", n));
const isManifest = (k: string): boolean => k.endsWith(".sha256.json");
const calls = (r: FakeRemote, prefix: string): string[] => r.calls.filter((c) => c.startsWith(`${prefix}:`)).map((c) => c.slice(prefix.length + 1));
const runId = (r: FakeRemote): string => r.logs.find((l) => l.event === "completed")!.runId as string;
const rec = (r: FakeRemote, key: string): any => JSON.parse(r.uploaded.get(key)!.toString("utf8"));
const base = { seed: seed6, now: NOW, listIncludesUploads: true, applyRemovals: true };
const cfg = { tierPolicy: POLICY, prune: true };
const completed = (r: FakeRemote): any => r.logs.find((l) => l.event === "completed")!;

test("DV1 default (no verification command): successful deletes are recorded deleted_unverified, never as verified", async () => {
  const r = await createFakeRemote({ ...base, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.deleteVerification, "none");
    assert.ok(out.units.length > 0 && out.units.every((u: any) => u.status === "deleted_unverified"));
    const c = completed(r);
    assert.equal(c.prunedVerified, 0);
    assert.equal(c.prunedUnverified, 10);
    assert.equal(c.pruned, 10, "existing counter still means: delete commands that reported success");
    assert.equal(calls(r, "verify-delete").length, 0);
  } finally { await r.cleanup(); }
});

test("DV2 verification command configured and passing: units are deleted_verified; verifier runs after each delete, under the read-only list identity", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: {}, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.deleteVerification, "command");
    assert.ok(out.units.every((u: any) => u.status === "deleted_verified"));
    const c = completed(r);
    assert.equal(c.prunedVerified, 10);
    assert.equal(c.prunedUnverified, 0);
    const trail = r.calls.filter((x) => x.startsWith("remove:") || x.startsWith("verify-delete:"));
    for (let i = 0; i < trail.length; i += 2) {
      assert.ok(trail[i]!.startsWith("remove:") && trail[i + 1] === trail[i]!.replace("remove:", "verify-delete:"), "each delete is immediately verified");
    }
    assert.ok(r.operations.filter((o) => o.startsWith("verify-delete:")).every((o) => o === "verify-delete:list"), "verifier must not receive delete credentials");
    assert.ok(r.operations.filter((o) => o.startsWith("remove:")).every((o) => o === "remove:delete"));
  } finally { await r.cleanup(); }
});

test("DV3 delete command exits 0 but the object remains (delete marker / surviving version): NOT recorded as deleted, manifest preserved, pruning stops, alert sent", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: { stillPresent: /\.tar\.enc$/ }, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "artifact_delete_not_verified_manifest_preserved");
    assert.ok(out.units.slice(1).every((u: any) => u.status === "not_attempted_pruning_stopped"));
    assert.equal(out.stopped, true);
    assert.ok(!calls(r, "remove").some(isManifest), "manifest of an unverified artifact delete must not even be attempted");
    const c = completed(r);
    assert.equal(c.pruned, 0, "an unverified delete is not counted as pruned");
    assert.equal(c.pruneFailed, 1);
    assert.equal(c.prunedVerified, 0);
    assert.equal(c.manifestsPreserved, 1);
    const ev = r.logs.find((l) => l.event === "prune_delete_not_verified");
    assert.ok(ev && ev.level === "error");
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0]!.status, "prune_delete_refused");
  } finally { await r.cleanup(); }
});

test("DV4 manifest delete reports success but is not verified after a verified artifact delete: recorded, stops", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: { stillPresent: /\.sha256\.json$/ }, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "manifest_delete_not_verified_artifact_deleted");
    assert.equal(out.stopped, true);
    assert.equal(completed(r).prunedVerified, 1, "only the verified artifact delete counts");
    assert.equal(completed(r).pruneFailed, 1);
  } finally { await r.cleanup(); }
});

test("DV5 a failing verifier (unavailable / no permission) is treated as NOT verified, never as success", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: { fails: true }, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "artifact_delete_not_verified_manifest_preserved");
    assert.equal(completed(r).pruned, 0);
    assert.equal(completed(r).pruneStopped, true);
  } finally { await r.cleanup(); }
});

test("DV6 a refused delete never reaches the verifier and keeps the existing refused-delete status", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: {}, failRemovePattern: /\.tar\.enc$/, configOverrides: cfg });
  try {
    await r.createBackup();
    assert.equal(calls(r, "verify-delete").length, 0);
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "artifact_delete_failed_manifest_preserved");
  } finally { await r.cleanup(); }
});

test("DV7 defaults unchanged: pruning off means no list, delete or verify command runs even when a verifier is configured", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: {}, configOverrides: { tierPolicy: POLICY } });
  try {
    await r.createBackup();
    assert.equal(calls(r, "remove").length + calls(r, "verify-delete").length, 0);
    assert.equal(r.calls.filter((c) => c === "list").length, 0);
    assert.equal(completed(r).prune, "off");
  } finally { await r.cleanup(); }
});

test("DV8 config: BACKUP_DELETE_VERIFY_COMMAND is optional, validated when set, and must differ from the delete command", () => {
  assert.equal(loadProductionBackupConfig(productionEnv()).deleteVerify, undefined);
  const ok = loadProductionBackupConfig(productionEnv({ BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify(["v", "{object}"]) }));
  assert.deepEqual(ok.deleteVerify, { executable: "v", args: ["{object}"] });
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify(["v", "x"]) })), /BACKUP_DELETE_VERIFY_COMMAND must include the \{object\} placeholder/);
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_DELETE_VERIFY_COMMAND: "not json" })), /BACKUP_DELETE_VERIFY_COMMAND must be a JSON array/);
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify(["r", "{object}"]) })), /verification command must differ from the delete command/);
  // defaults untouched
  const d = loadProductionBackupConfig(productionEnv());
  assert.equal(d.prune, false);
  assert.equal(d.stagingSweep, "off");
});
