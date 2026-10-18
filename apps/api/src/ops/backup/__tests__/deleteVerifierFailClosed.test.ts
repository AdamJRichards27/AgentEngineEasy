import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY } from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { productionEnv } from "./helpers/productionEnv.js";
import { createFakeRemote, type FakeRemote } from "./helpers/fakeBackupRemote.js";
import type { RemoteObject } from "../types.js";

// PH-7 R19 / D-9 fail-closed: pruning cannot be enabled without a configured, validated delete verifier, and a delete
// command's success is never proof of permanent deletion.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = path.resolve(HERE, "../verifiers/verifyDeleteMc.mjs");
const VERIFY_OK = JSON.stringify([process.execPath, ADAPTER, "--alias", "l", "{remote}"]);
const enable = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => productionEnv({ BACKUP_PRUNE: "on", BACKUP_DELETE_VERIFY_COMMAND: VERIFY_OK, ...extra });

test("FC1 BACKUP_PRUNE=on without BACKUP_DELETE_VERIFY_COMMAND fails at config load (before any command could run)", () => {
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: "on" })), /BACKUP_PRUNE=on requires BACKUP_DELETE_VERIFY_COMMAND/);
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: "on", BACKUP_DELETE_VERIFY_COMMAND: "" })), /requires BACKUP_DELETE_VERIFY_COMMAND/);
});

test("FC2 the exact enabling configuration loads: prune on + real adapter verifier; defaults stay OFF", () => {
  const c = loadProductionBackupConfig(enable());
  assert.equal(c.prune, true);
  assert.deepEqual(c.deleteVerify, { executable: process.execPath, args: [ADAPTER, "--alias", "l", "{remote}"] });
  const off = loadProductionBackupConfig(productionEnv());
  assert.equal(off.prune, false);
  assert.equal(off.deleteVerify, undefined);
  // a verifier alone does not turn pruning on, and pruning off does not validate the (unused) verifier path
  assert.equal(loadProductionBackupConfig(productionEnv({ BACKUP_DELETE_VERIFY_COMMAND: VERIFY_OK })).prune, false);
});

test("FC3 verifier validation when pruning is on: distinct, resolvable, not a no-op, takes the object", () => {
  const bad = (spec: string[], re: RegExp, extra: Record<string, string> = {}): void =>
    assert.throws(() => loadProductionBackupConfig(enable({ BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify(spec), ...extra })), re, spec.join(" "));
  bad(["r", "{object}"], /must differ from the delete command/);
  bad(["l", "{destination}", "{object}"], /must differ from the list command/, { BACKUP_LIST_COMMAND: JSON.stringify(["l", "{destination}", "{object}"]), BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify(["l", "{destination}", "{object}"]) });
  bad([process.execPath, ADAPTER], /must include the \{object\} placeholder/);
  bad(["/nonexistent/dir/verifier", "{object}"], /not an executable file/);
  bad(["definitely-not-a-real-command-xyz", "{object}"], /not found on PATH/);
  bad([path.dirname(ADAPTER), "{object}"], /not an executable file/);
  for (const noop of [["true", "{object}"], ["/bin/true", "{object}"], ["echo", "{object}"], [":", "{object}"], ["sh", "-c", "exit 0", "{object}"], ["bash", "-c", "true # {object}"]]) bad(noop, /no-op|placeholder/);
});

test("FC3b {remote} satisfies the object placeholder for the verifier (adapter takes the remote URI)", () => {
  assert.doesNotThrow(() => loadProductionBackupConfig(enable()));
  assert.doesNotThrow(() => loadProductionBackupConfig(enable({ BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify([process.execPath, ADAPTER, "{object}"]) })));
});

// ---- engine level ----
const NOW = new Date("2026-03-01T00:00:00Z");
const hex = (n: number): string => n.toString(16).padStart(12, "0");
const POLICY = { daily: { keep: 2, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly };
function backup(n: number): RemoteObject[] {
  const day = new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);
  const stamp = day.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `aee-protected-${stamp}-${hex(n)}.tar.enc`;
  return [{ key: `daily/${name}`, lastModified: day.toISOString() }, { key: `daily/${name}.sha256.json`, lastModified: day.toISOString() }];
}
const seed6 = [1, 2, 3, 4, 5, 6].flatMap(backup);
const base = { seed: seed6, now: NOW, listIncludesUploads: true, applyRemovals: true };
const cfg = { tierPolicy: POLICY, prune: true };
const calls = (r: FakeRemote, p: string): string[] => r.calls.filter((c) => c.startsWith(`${p}:`));
const runId = (r: FakeRemote): string => r.logs.find((l) => l.event === "completed")!.runId as string;
const rec = (r: FakeRemote, key: string): any => JSON.parse(r.uploaded.get(key)!.toString("utf8"));
const completed = (r: FakeRemote): any => r.logs.find((l) => l.event === "completed")!;

test("FC4 engine: prune on with no verifier configured fails BEFORE any list, delete, upload or database command", async () => {
  const r = await createFakeRemote({ ...base, omitVerifier: true, configOverrides: cfg });
  try {
    await assert.rejects(() => r.createBackup(), /BACKUP_PRUNE=on requires BACKUP_DELETE_VERIFY_COMMAND/);
    assert.deepEqual(r.calls.filter((c) => c === "list" || c.startsWith("remove") || c.startsWith("upload") || c === "pg_dump"), []);
    assert.equal(r.removed.length, 0);
  } finally { await r.cleanup(); }
});

test("FC4b engine: a verifier equal to the delete command is refused before any destructive operation", async () => {
  const r = await createFakeRemote({ ...base, configOverrides: { ...cfg, deleteVerify: { executable: "remove", args: [] } } });
  try {
    await assert.rejects(() => r.createBackup(), /must differ from the delete command/);
    assert.equal(r.removed.length, 0);
  } finally { await r.cleanup(); }
});

test("FC5 verifier exits 0 but prints nothing (e.g. a no-op or `true`): NOT verified, manifest preserved, pruning stops, alert sent", async () => {
  const r = await createFakeRemote({ ...base, verifyDelete: { stdout: "" }, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.equal(out.units[0].status, "artifact_delete_not_verified_manifest_preserved");
    assert.equal(out.units[0].verifierClass, "malformed_output");
    assert.ok(out.units.slice(1).every((u: any) => u.status === "not_attempted_pruning_stopped"));
    assert.equal(calls(r, "remove").length, 1, "no second delete after an unverified one");
    assert.ok(!calls(r, "remove").some((c) => c.endsWith(".sha256.json")));
    const c = completed(r);
    assert.equal(c.prunedVerified, 0);
    assert.equal(c.pruned, 0);
    assert.equal(c.pruneStopped, true);
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0]!.error!, /not verified|verification/i);
  } finally { await r.cleanup(); }
});

test("FC6 malformed / contradictory / non-absent verifier output with exit 0 is never verified", async () => {
  for (const stdout of ["ok\n", "{not json", '{"class":"absent"}\n', '{"class":"absent","verified":false}\n', '{"class":"delete_marker_retained","verified":true}\n', '{"class":"absent","verified":true,"versions":1,"deleteMarkers":0}\n', '{"class":"absent","verified":true,"versions":0,"deleteMarkers":2}\n', '[{"class":"absent","verified":true}]\n', "null\n"]) {
    const r = await createFakeRemote({ ...base, verifyDelete: { stdout }, configOverrides: cfg });
    try {
      await r.createBackup();
      assert.equal(completed(r).prunedVerified, 0, stdout);
      assert.equal(completed(r).pruned, 0, stdout);
      assert.equal(rec(r, `deletion-records/${runId(r)}.outcome.json`).units[0].status, "artifact_delete_not_verified_manifest_preserved", stdout);
    } finally { await r.cleanup(); }
  }
});

test("FC7 verifier failure carries its class into the outcome record and the alert is actionable", async () => {
  for (const errorClass of ["delete_marker_retained", "governance_locked", "compliance_locked", "access_denied_or_incomplete", "inconclusive", "versions_retained"]) {
    const r = await createFakeRemote({ ...base, verifyDelete: { stillPresent: /\.tar\.enc$/, errorClass }, configOverrides: cfg });
    try {
      await r.createBackup();
      const u = rec(r, `deletion-records/${runId(r)}.outcome.json`).units[0];
      assert.equal(u.status, "artifact_delete_not_verified_manifest_preserved");
      assert.equal(u.verifierClass, errorClass);
      assert.equal(r.alerts.length, 1);
      assert.match(r.alerts[0]!.error!, new RegExp(errorClass));
    } finally { await r.cleanup(); }
  }
});

test("FC8 counters: `pruned` can never exceed verified permanent deletions; accepted delete commands are counted separately; no unverified status is emitted", async () => {
  const ok = await createFakeRemote({ ...base, verifyDelete: {}, configOverrides: cfg });
  try {
    await ok.createBackup();
    const c = completed(ok);
    assert.equal(c.prunedVerified, 10);
    assert.equal(c.pruned, c.prunedVerified, "deprecated alias: equals verified deletions only");
    assert.equal(c.deleteCommandsAccepted, 10);
    assert.ok(!("prunedUnverified" in c));
    assert.ok(rec(ok, `deletion-records/${runId(ok)}.outcome.json`).units.every((u: any) => u.status === "deleted_verified"));
  } finally { await ok.cleanup(); }
  const bad = await createFakeRemote({ ...base, verifyDelete: { stillPresent: /\.tar\.enc$/ }, configOverrides: cfg });
  try {
    await bad.createBackup();
    const c = completed(bad);
    assert.equal(c.pruned, 0);
    assert.equal(c.prunedVerified, 0);
    assert.equal(c.deleteCommandsAccepted, 1, "the delete command was accepted once but that is NOT a verified deletion");
  } finally { await bad.cleanup(); }
});

test("FC9 partial failure: first unit verified, second unit not verified -> third unit never attempted", async () => {
  const second = seed6.filter((o) => o.key.includes(hex(2)))[0]!.key;
  const r = await createFakeRemote({ ...base, verifyDelete: { stillPresent: new RegExp(second.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + "$") }, configOverrides: cfg });
  try {
    await r.createBackup();
    const out = rec(r, `deletion-records/${runId(r)}.outcome.json`);
    assert.deepEqual(out.units.map((u: any) => u.status).slice(0, 3), ["deleted_verified", "artifact_delete_not_verified_manifest_preserved", "not_attempted_pruning_stopped"]);
    assert.equal(out.stopped, true);
    assert.equal(completed(r).prunedVerified, 2, "unit 1: artifact + manifest");
    assert.equal(calls(r, "remove").length, 3);
  } finally { await r.cleanup(); }
});

test("FC10 prune OFF (default): nothing runs, verifier not required, no verifier call", async () => {
  const r = await createFakeRemote({ ...base, omitVerifier: true, configOverrides: { tierPolicy: POLICY } });
  try {
    await r.createBackup();
    assert.equal(r.calls.filter((c) => c === "list" || c.startsWith("remove") || c.startsWith("verify-delete")).length, 0);
    assert.equal(completed(r).prune, "off");
    assert.equal(completed(r).pruned, 0);
  } finally { await r.cleanup(); }
});
