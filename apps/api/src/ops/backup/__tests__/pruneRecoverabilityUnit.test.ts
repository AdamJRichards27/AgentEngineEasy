import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY, type Tier } from "../artifacts.js";
import { createFakeRemote, type FakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

// PH-7 R12 P0 / D-3: an artifact and its manifest are ONE recoverability unit.
// A manifest is never deleted unless its artifact delete was confirmed successful in the same run.
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
const removeCalls = (r: FakeRemote): string[] => r.calls.filter((c) => c.startsWith("remove:")).map((c) => c.slice(7));
const runId = (r: FakeRemote): string => r.logs.find((l) => l.event === "completed")!.runId as string;
const rec = (r: FakeRemote, key: string): any => JSON.parse(r.uploaded.get(key)!.toString("utf8"));
const base = { seed: seed6, now: NOW, listIncludesUploads: true, applyRemovals: true };
const cfg = (extra: object = {}) => ({ tierPolicy: POLICY, prune: true, ...extra });

test("M1 reproduces the reported defect: artifact deletes refused must NOT lead to manifest deletes (no unrecoverable artifacts)", async () => {
  const r = await createFakeRemote({ ...base, failRemovePattern: /\.tar\.enc$/, configOverrides: cfg() });
  try {
    await r.createBackup();
    const manifestAttempts = removeCalls(r).filter(isManifest);
    assert.deepEqual(manifestAttempts, [], "no manifest delete may even be attempted while its artifact delete failed");
    assert.deepEqual(r.removed.filter(isManifest), [], "no manifest was removed");
    const listed = JSON.parse((await r.run({ executable: "list", args: [] }, {}, "list")).stdout) as RemoteObject[];
    const keys = new Set(listed.map((o) => o.key));
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const [a, m] = backup("daily", n);
      assert.ok(keys.has(a!.key) && keys.has(m!.key), `backup ${n} must still be recoverable (artifact + manifest present)`);
    }
  } finally { await r.cleanup(); }
});

test("M2 pruning STOPS at the first uncertain delete, preserves manifests, logs and alerts visibly", async () => {
  const r = await createFakeRemote({ ...base, failRemovePattern: /\.tar\.enc$/, configOverrides: cfg() });
  try {
    await r.createBackup();
    assert.equal(removeCalls(r).length, 1, "exactly one delete attempted, then pruning stopped");
    const stopped = r.logs.find((l) => l.event === "prune_stopped");
    assert.ok(stopped, "prune_stopped must be logged");
    assert.equal(stopped!.level, "error");
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0]!.status, "prune_delete_refused");
    const done = r.logs.find((l) => l.event === "completed")!;
    assert.equal(done.pruned, 0);
    assert.equal(done.pruneStopped, true);
  } finally { await r.cleanup(); }
});

test("M3 ambiguous artifact delete (outcome unknown, request may have landed) also preserves the manifest and stops", async () => {
  const r = await createFakeRemote({ ...base, removeThenThrow: /\.tar\.enc$/, configOverrides: cfg() });
  try {
    await r.createBackup();
    assert.deepEqual(removeCalls(r).filter(isManifest), []);
    assert.equal(removeCalls(r).length, 1);
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "artifact_delete_failed_manifest_preserved");
  } finally { await r.cleanup(); }
});

test("M4 durable deletion-intent record is uploaded BEFORE the first delete; outcome record after the last", async () => {
  const r = await createFakeRemote({ ...base, configOverrides: cfg() });
  try {
    await r.createBackup();
    const id = runId(r);
    const intentKey = `deletion-records/${id}.intent.json`, outcomeKey = `deletion-records/${id}.outcome.json`;
    const firstRemove = r.calls.findIndex((c) => c.startsWith("remove:"));
    const lastRemove = r.calls.map((c) => c.startsWith("remove:")).lastIndexOf(true);
    assert.ok(r.calls.indexOf(`upload:${intentKey}`) !== -1 && r.calls.indexOf(`upload:${intentKey}`) < firstRemove, "intent before first delete");
    assert.ok(r.calls.indexOf(`upload:${outcomeKey}`) > lastRemove, "outcome after last delete");
    const intent = rec(r, intentKey);
    assert.equal(intent.kind, "prune-intent");
    assert.equal(intent.units.length, 5);
    const outcome = rec(r, outcomeKey);
    assert.equal(outcome.stopped, false);
    assert.ok(outcome.units.every((u: any) => u.status === "deleted_verified"));
  } finally { await r.cleanup(); }
});

test("M5 per-unit order is artifact then its own manifest, and a unit completes before the next starts", async () => {
  const r = await createFakeRemote({ ...base, configOverrides: cfg() });
  try {
    await r.createBackup();
    const calls = removeCalls(r);
    // R29b: a unit is artifact, then its manifest, then its .verified.json marker (fake remote seeds markers).
    assert.equal(calls.length, 15);
    for (let i = 0; i < calls.length; i += 3) {
      assert.ok(!isManifest(calls[i]!) && calls[i + 1] === `${calls[i]}.sha256.json` && calls[i + 2] === `${calls[i]}.verified.json`, `unit ${i / 3}: artifact immediately followed by its manifest, then its marker`);
    }
  } finally { await r.cleanup(); }
});

test("M6 failure to write the deletion-intent record fails closed: zero deletes, visible failure", async () => {
  const r = await createFakeRemote({ ...base, failUpload: /^deletion-records\//, configOverrides: cfg() });
  try {
    await assert.rejects(r.createBackup(), /upload refused/);
    assert.deepEqual(removeCalls(r), []);
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0]!.error!, /^prune_failed: /);
  } finally { await r.cleanup(); }
});

test("M7 retry is idempotent and never damages recoverability; the last verified backup survives both runs", async () => {
  const r = await createFakeRemote({ ...base, failRemovePattern: /\.tar\.enc$/, configOverrides: cfg() });
  try {
    await r.createBackup(); // run 1: refused, everything preserved
    assert.deepEqual(r.removed, []);
    r.controls.failRemovePattern = undefined; // refusal lifted (e.g. retention elapsed)
    await r.createBackup(); // run 2 (a different artifact name is produced per run)
    const listed = (JSON.parse((await r.run({ executable: "list", args: [] }, {}, "list")).stdout) as RemoteObject[]).map((o) => o.key);
    const artifacts = listed.filter((k) => k.startsWith("daily/") && k.endsWith(".tar.enc"));
    for (const a of artifacts) assert.ok(listed.includes(`${a}.sha256.json`), `${a} keeps its manifest`);
    assert.ok(artifacts.length >= 2, "keep floor of 2 recoverable backups still honoured");
    // every removed manifest had its artifact removed first
    const removedNow: string[] = [...r.removed];
    for (const m of removedNow.filter(isManifest)) {
      const a = m.slice(0, -".sha256.json".length);
      assert.ok(removedNow.indexOf(a) !== -1 && removedNow.indexOf(a) < removedNow.indexOf(m));
    }
    // third run: nothing left to prune, no error, no duplicate damage
    const before = r.removed.length;
    await r.createBackup();
    assert.equal(r.removed.length, before, "nothing further pruned");
  } finally { await r.cleanup(); }
});

test("M8 manifest delete failing after a confirmed artifact delete is recorded, stops pruning, and the orphan manifest is harmless", async () => {
  const r = await createFakeRemote({ ...base, failRemovePattern: /\.sha256\.json$/, configOverrides: cfg() });
  try {
    await r.createBackup();
    assert.equal(removeCalls(r).length, 2, "artifact deleted, manifest failed, then stop");
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "manifest_delete_failed_artifact_deleted");
    assert.equal(out.stopped, true);
    assert.ok(out.units.slice(1).every((u: any) => u.status === "not_attempted_pruning_stopped"));
    r.controls.failRemovePattern = undefined;
    await r.createBackup(); // retry cleans the orphan manifest and continues
    assert.ok(r.removed.some((k) => isManifest(k)));
  } finally { await r.cleanup(); }
});
