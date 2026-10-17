import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TIER_POLICY, type Tier } from "../artifacts.js";
import { loadProductionBackupConfig } from "../config.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import { productionEnv } from "./helpers/productionEnv.js";
import type { RemoteObject } from "../types.js";

// PH-7 R12 P1 / D-2: pruning is default OFF and only runs on deliberate operator opt-in (BACKUP_PRUNE=on).
const NOW = new Date("2026-03-01T00:00:00Z");
const POLICY = { daily: { keep: 1, retentionDays: 1 }, weekly: DEFAULT_TIER_POLICY.weekly, monthly: DEFAULT_TIER_POLICY.monthly };
const hex = (n: number): string => n.toString(16).padStart(12, "0");
function backup(tier: Tier, n: number): RemoteObject[] {
  const day = new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);
  const stamp = day.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `aee-protected-${stamp}-${hex(n)}.tar.enc`;
  return [{ key: `${tier}/${name}`, lastModified: day.toISOString() }, { key: `${tier}/${name}.sha256.json`, lastModified: day.toISOString() }];
}
const seed = [1, 2, 3, 4].flatMap((n) => backup("daily", n));
const noDeleteActivity = (calls: string[]): boolean => !calls.some((c) => c === "list" || c.startsWith("remove") || c.startsWith("upload:deletion-records/"));

test("P1 config: BACKUP_PRUNE unset or blank defaults to OFF and reports the default as the source", () => {
  for (const extra of [{}, { BACKUP_PRUNE: "" }, { BACKUP_PRUNE: "   " }] as Array<Record<string, string>>) {
    const config = loadProductionBackupConfig(productionEnv(extra));
    assert.equal(config.prune, false);
    assert.equal(config.pruneSource, "default");
  }
});

test("P2 config: explicit on enables (case-insensitive), explicit off stays off, both report explicit", () => {
  for (const v of ["on", "ON", " On "]) {
    const c = loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: v }));
    assert.equal(c.prune, true);
    assert.equal(c.pruneSource, "explicit");
  }
  const off = loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: "off" }));
  assert.equal(off.prune, false);
  assert.equal(off.pruneSource, "explicit");
});

test("P3 config: any other value is refused at startup (never interpreted as on)", () => {
  for (const bad of ["true", "1", "yes", "enabled", "of", "onn", "0"]) {
    assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_PRUNE: bad })), /BACKUP_PRUNE must be exactly on or off/, bad);
  }
});

test("P4 config: vault mode loads with pruning unset (default off); explicit on is still refused", () => {
  const vault = loadProductionBackupConfig(productionEnv({ BACKUP_VAULT_MODE: "true" }));
  assert.equal(vault.vaultMode, true);
  assert.equal(vault.prune, false);
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_VAULT_MODE: "true", BACKUP_PRUNE: "on" })), /prohibited in vault mode/);
});

test("P5 engine: with no prune setting NOTHING is listed, deleted or recorded, even with every old backup expired", async () => {
  const r = await createFakeRemote({ seed, now: NOW, listIncludesUploads: true, configOverrides: { tierPolicy: POLICY } });
  try {
    await r.createBackup();
    assert.ok(noDeleteActivity(r.calls), `unexpected delete-path activity: ${r.calls.join(",")}`);
    assert.deepEqual(r.removed, []);
    const done = r.logs.find((l) => l.event === "completed")!;
    assert.equal(done.prune, "off");
    assert.equal(done.pruneStatus, "disabled_default");
    assert.equal(done.verified, true);
  } finally { await r.cleanup(); }
});

test("P6 engine: operator-facing diagnostic explains that pruning is disabled and how to enable it", async () => {
  const r = await createFakeRemote({ seed, now: NOW, configOverrides: { tierPolicy: POLICY, pruneSource: "default" } });
  try {
    await r.createBackup();
    const status = r.logs.find((l) => l.event === "prune_disabled");
    assert.ok(status, "prune_disabled event must be logged");
    assert.equal(status!.level, "info");
    assert.equal(status!.source, "default");
    assert.match(String(status!.message), /BACKUP_PRUNE=on/);
    assert.ok(noDeleteActivity(r.calls));
  } finally { await r.cleanup(); }
});

test("P7 engine: explicit off is reported as disabled_explicit and also never deletes", async () => {
  const r = await createFakeRemote({ seed, now: NOW, configOverrides: { tierPolicy: POLICY, prune: false, pruneSource: "explicit" } });
  try {
    await r.createBackup();
    assert.equal(r.logs.find((l) => l.event === "completed")!.pruneStatus, "disabled_explicit");
    assert.ok(noDeleteActivity(r.calls));
  } finally { await r.cleanup(); }
});

test("P8 engine: explicit opt-in prunes after verification (behaviour unchanged) and reports enabled", async () => {
  const r = await createFakeRemote({ seed, now: NOW, listIncludesUploads: true, configOverrides: { tierPolicy: POLICY, prune: true, pruneSource: "explicit" } });
  try {
    await r.createBackup();
    assert.ok(r.removed.length > 0);
    const done = r.logs.find((l) => l.event === "completed")!;
    assert.equal(done.pruneStatus, "enabled");
    assert.equal(done.prune, "on");
    assert.ok(r.logs.some((l) => l.event === "prune_enabled" && l.level === "info"));
  } finally { await r.cleanup(); }
});

test("P9 engine: a programmatic config with vault mode and no prune field runs (default off), without deleting", async () => {
  const r = await createFakeRemote({ seed, now: NOW, configOverrides: { tierPolicy: POLICY, vaultMode: true } });
  try {
    await r.createBackup();
    assert.ok(noDeleteActivity(r.calls));
  } finally { await r.cleanup(); }
});

test("P10 engine: a disabled prune does not change backup creation, verification or tier uploads", async () => {
  const r = await createFakeRemote({ seed, now: NOW, configOverrides: { tierPolicy: POLICY } });
  try {
    const name = await r.createBackup();
    for (const t of ["daily", "weekly", "monthly"]) {
      assert.ok(r.uploaded.has(`${t}/${name}`) && r.uploaded.has(`${t}/${name}.sha256.json`), `${t} copy stored`);
      assert.ok(r.calls.includes(`download:${t}/${name}`), `${t} copy verified`);
    }
  } finally { await r.cleanup(); }
});
