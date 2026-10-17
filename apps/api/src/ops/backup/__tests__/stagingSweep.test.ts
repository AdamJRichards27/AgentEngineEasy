import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadProductionBackupConfig } from "../config.js";
import { restoreBackup } from "../engine.js";
import {
  readRunMarker, removeRunDirectory, sweepStaging, writeRunMarker, type RunMarker,
} from "../stagingSweep.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";
import { productionEnv } from "./helpers/productionEnv.js";

// PH-7 R13 Task B / D-5: safe stale-staging sweep. Conservative defaults; destructive mode is opt-in.
const HOUR = 3_600_000;
const T0 = new Date("2026-03-01T00:00:00Z");
const LATER = new Date(T0.getTime() + 48 * HOUR);
const ARTIFACT = "aee-protected-20260301T000000Z-0123456789ab.tar.enc";
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const DEAD = () => false;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "aee-sweep-"));
  const staging = path.join(root, "staging");
  await mkdir(staging, { recursive: true });
  return { root, staging, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function marker(runId: string, over: Partial<RunMarker> = {}): RunMarker {
  return {
    version: 1, runId, kind: "backup", pid: 999_999, host: hostname(), uid,
    startedAt: T0.toISOString(), heartbeatAt: T0.toISOString(), state: "running", ...over,
  };
}
async function runDir(staging: string, kind: "backup" | "restore", id: string, over: Partial<RunMarker> = {}, files: Record<string, string> = { "database.dump": "PLAINTEXT-DUMP", "payload.tar": "PLAINTEXT-PAYLOAD" }) {
  const dir = path.join(staging, `${kind}-${id}`);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), body);
  }
  await writeRunMarker(dir, marker(id, { kind, ...over }));
  return dir;
}
const ID1 = "0123456789abcdef";
const ID2 = "fedcba9876543210";
const opts = (staging: string, mode: "off" | "dry-run" | "on", extra: Record<string, unknown> = {}) => ({
  stagingDirectory: staging, mode, minAgeMs: 24 * HOUR, now: () => LATER, isPidAlive: DEAD, ...extra,
});
const audit = async (staging: string) => {
  const file = path.join(staging, "sweep-audit.jsonl");
  return existsSync(file) ? (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

test("S1 mode off: nothing is read, removed or audited", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1);
    const report = await sweepStaging(opts(f.staging, "off"));
    assert.equal(report.mode, "off");
    assert.equal(report.entries.length, 0);
    assert.ok(existsSync(path.join(dir, "database.dump")));
    assert.deepEqual(await audit(f.staging), []);
  } finally { await f.cleanup(); }
});

test("S2 dry-run: reports would_remove, deletes nothing, writes an audit record marked dryRun", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1);
    const report = await sweepStaging(opts(f.staging, "dry-run"));
    assert.equal(report.entries[0]?.decision, "would_remove");
    assert.ok(existsSync(path.join(dir, "database.dump")), "dry-run must not touch anything");
    const records = (await audit(f.staging)).filter((r) => r.decision !== undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.dryRun, true);
    assert.equal(records[0]!.decision, "would_remove");
    assert.ok(!JSON.stringify(records).includes("PLAINTEXT"), "audit must never contain file contents");
  } finally { await f.cleanup(); }
});

test("S3 on: a stale, owned, marker-verified directory is overwritten and removed; audited", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1);
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(report.entries[0]?.decision, "removed");
    assert.ok(!existsSync(dir));
    assert.equal((await readdir(f.staging)).filter((n) => n.startsWith("backup-") || n.startsWith("sweeping-")).length, 0);
    const records = await audit(f.staging);
    assert.equal(records.at(-1)!.decision, "removed");
    assert.equal(records.at(-1)!.dryRun, false);
  } finally { await f.cleanup(); }
});

test("S4 active run: a live pid is never swept even with an ancient heartbeat", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1, { pid: process.pid });
    const report = await sweepStaging(opts(f.staging, "on", { isPidAlive: () => true }));
    assert.match(report.entries[0]!.decision, /^(active|ambiguous)$/);
    assert.ok(existsSync(path.join(dir, "database.dump")));
  } finally { await f.cleanup(); }
});

test("S5 recent heartbeat (younger than the minimum age) is never swept, even if the pid looks dead", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "restore", ID1, { heartbeatAt: new Date(LATER.getTime() - 2 * HOUR).toISOString() });
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(report.entries[0]!.decision, "too_recent");
    assert.ok(existsSync(dir));
  } finally { await f.cleanup(); }
});

test("S6 ambiguous directories are rejected, never deleted (no marker, bad marker, mismatches, foreign host/owner, junk)", async () => {
  const f = await fixture();
  try {
    const noMarker = path.join(f.staging, `backup-${ID1}`);
    await mkdir(noMarker); await writeFile(path.join(noMarker, "database.dump"), "x");
    const badJson = await runDir(f.staging, "backup", ID2);
    await writeFile(path.join(badJson, ".run.json"), "{not json");
    const wrongId = await runDir(f.staging, "backup", "aaaaaaaaaaaaaaaa", { runId: "bbbbbbbbbbbbbbbb" });
    const foreignHost = await runDir(f.staging, "backup", "1111111111111111", { host: "some-other-host" });
    const wrongKind = await runDir(f.staging, "backup", "2222222222222222", { kind: "restore" });
    const dirs = [noMarker, badJson, wrongId, foreignHost, wrongKind];
    const extra: string[] = [];
    if (uid !== null) extra.push(await runDir(f.staging, "backup", "3333333333333333", { uid: uid + 1 }));
    const unknownFile = await runDir(f.staging, "backup", "4444444444444444", {}, { "database.dump": "x", "mystery.bin": "y" });
    const badState = await runDir(f.staging, "backup", "5555555555555555", { state: "bogus" as never });
    const futureHeartbeat = await runDir(f.staging, "backup", "6666666666666666", { heartbeatAt: new Date(LATER.getTime() + 90 * HOUR).toISOString() });
    const report = await sweepStaging(opts(f.staging, "on"));
    for (const d of [...dirs, ...extra, unknownFile, badState, futureHeartbeat]) {
      assert.ok(existsSync(d), `must survive: ${path.basename(d)}`);
      const entry = report.entries.find((e) => e.name === path.basename(d));
      assert.equal(entry?.decision, "ambiguous", `${path.basename(d)} => ${entry?.decision}/${entry?.reason}`);
      assert.ok(entry!.reason.length > 0);
    }
  } finally { await f.cleanup(); }
});

test("S7 symlinks and hardlinks are ambiguous: nothing outside the directory is followed or removed", async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "precious.txt"), "keep");
    await symlink(outside, path.join(f.staging, `backup-${ID1}`), "dir");
    const inner = await runDir(f.staging, "backup", ID2);
    await symlink(path.join(outside, "precious.txt"), path.join(inner, "documents.tar"));
    const hard = await runDir(f.staging, "restore", "7777777777777777");
    await rm(path.join(hard, "payload.tar"));
    await link(path.join(outside, "precious.txt"), path.join(hard, "payload.tar"));
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(await readFile(path.join(outside, "precious.txt"), "utf8"), "keep");
    assert.ok(existsSync(inner) && existsSync(hard));
    assert.ok((await lstat(path.join(f.staging, `backup-${ID1}`))).isSymbolicLink());
    for (const e of report.entries) assert.equal(e.decision, "ambiguous", e.name);
  } finally { await f.cleanup(); }
});

test("S8 foreign names in the staging root are ignored and reported, never touched", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.staging, "important")); await writeFile(path.join(f.staging, "important", "a"), "a");
    await writeFile(path.join(f.staging, "notes.txt"), "n");
    await mkdir(path.join(f.staging, "backup-xyz"));
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.ok(existsSync(path.join(f.staging, "important", "a")) && existsSync(path.join(f.staging, "notes.txt")) && existsSync(path.join(f.staging, "backup-xyz")));
    assert.ok(report.entries.every((e) => e.decision === "foreign_ignored"));
  } finally { await f.cleanup(); }
});

test("S9 only recoverable artifact: an unverified encrypted artifact is KEPT (plaintext overwritten and removed); verified-uploaded dirs are removed whole", async () => {
  const f = await fixture();
  try {
    const files = { "database.dump": "PLAINTEXT", "payload.tar": "PLAINTEXT", "documents.tar": "PLAINTEXT", "inventory.json": "{}", [ARTIFACT]: "ENCRYPTED", [`${ARTIFACT}.sha256.json`]: "{}" };
    const unverified = await runDir(f.staging, "backup", ID1, { state: "encrypted" }, files);
    const verified = await runDir(f.staging, "backup", ID2, { state: "uploaded_verified" }, files);
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(report.entries.find((e) => e.name === `backup-${ID1}`)?.decision, "artifact_retained");
    assert.equal(await readFile(path.join(unverified, ARTIFACT), "utf8"), "ENCRYPTED");
    assert.ok(existsSync(path.join(unverified, `${ARTIFACT}.sha256.json`)));
    for (const p of ["database.dump", "payload.tar", "documents.tar", "inventory.json"]) assert.ok(!existsSync(path.join(unverified, p)), `plaintext ${p} must be gone`);
    assert.equal((await readRunMarker(unverified))?.state, "plaintext_swept_artifact_retained");
    assert.ok(!existsSync(verified), "verified-uploaded directory is removed whole");
    // Idempotent: a second sweep neither deletes the artifact nor errors.
    const again = await sweepStaging(opts(f.staging, "on"));
    assert.equal(again.entries.find((e) => e.name === `backup-${ID1}`)?.decision, "artifact_retained");
    assert.equal(await readFile(path.join(unverified, ARTIFACT), "utf8"), "ENCRYPTED");
  } finally { await f.cleanup(); }
});

test("S9b dry-run on an unverified artifact directory reports would_retain_artifact and changes nothing", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1, { state: "encrypted" }, { "database.dump": "PLAINTEXT", [ARTIFACT]: "E" });
    const report = await sweepStaging(opts(f.staging, "dry-run"));
    assert.equal(report.entries[0]!.decision, "would_retain_artifact");
    assert.ok(existsSync(path.join(dir, "database.dump")));
  } finally { await f.cleanup(); }
});

test("S10 restore directories hold only a downloaded copy: stale ones are removed even if they contain an artifact", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "restore", ID1, {}, { [ARTIFACT]: "COPY", [`${ARTIFACT}.sha256.json`]: "{}", "payload.tar": "PLAINTEXT" });
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(report.entries[0]!.decision, "removed");
    assert.ok(!existsSync(dir));
  } finally { await f.cleanup(); }
});

test("S11 removeRunDirectory overwrites plaintext with zeros before unlinking, and keeps named files", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1, {}, { "database.dump": "SECRET-DATA-1234", "documents-src/a/b.txt": "SECRET-DOC", [ARTIFACT]: "E" });
    const seen: Array<{ file: string; zeros: boolean }> = [];
    await removeRunDirectory(dir, {
      keep: [ARTIFACT],
      beforeUnlink: async (file) => { const b = await readFile(file); seen.push({ file: path.basename(file), zeros: b.length > 0 && b.every((x) => x === 0) }); },
    });
    assert.ok(seen.some((s) => s.file === "database.dump" && s.zeros));
    assert.ok(seen.some((s) => s.file === "b.txt" && s.zeros));
    assert.ok(!seen.some((s) => s.file === ARTIFACT), "kept files are not touched");
    assert.ok(existsSync(path.join(dir, ARTIFACT)) && !existsSync(path.join(dir, "database.dump")) && !existsSync(path.join(dir, "documents-src")));
  } finally { await f.cleanup(); }
});

test("S12 an interrupted sweep (claimed directory left half-removed) is finished by the next sweep", async () => {
  const f = await fixture();
  try {
    const dir = await runDir(f.staging, "backup", ID1);
    const claimed = path.join(f.staging, `sweeping-backup-${ID1}`);
    const { rename } = await import("node:fs/promises");
    await rename(dir, claimed);
    await writeRunMarker(claimed, marker(ID1, { state: "sweep_claimed" }));
    const report = await sweepStaging(opts(f.staging, "on"));
    assert.equal(report.entries.find((e) => e.name === `sweeping-backup-${ID1}`)?.decision, "removed");
    assert.ok(!existsSync(claimed));
  } finally { await f.cleanup(); }
});

test("S13 config: BACKUP_STAGING_SWEEP defaults to off; dry-run and on parse; invalid values are startup errors", () => {
  const c = loadProductionBackupConfig(productionEnv({}));
  assert.equal(c.stagingSweep, "off");
  assert.equal(c.stagingSweepMinAgeHours, 24);
  assert.equal(loadProductionBackupConfig(productionEnv({ BACKUP_STAGING_SWEEP: "" })).stagingSweep, "off");
  assert.equal(loadProductionBackupConfig(productionEnv({ BACKUP_STAGING_SWEEP: "Dry-Run" })).stagingSweep, "dry-run");
  assert.equal(loadProductionBackupConfig(productionEnv({ BACKUP_STAGING_SWEEP: "on", BACKUP_STAGING_SWEEP_MIN_AGE_HOURS: "72" })).stagingSweepMinAgeHours, 72);
  for (const bad of ["yes", "true", "1", "onn", "dry_run"]) {
    assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_STAGING_SWEEP: bad })), /BACKUP_STAGING_SWEEP must be exactly off, dry-run or on/);
  }
  for (const bad of ["0", "-1", "1.5", "abc", "721", "0.5"]) {
    assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_STAGING_SWEEP: "on", BACKUP_STAGING_SWEEP_MIN_AGE_HOURS: bad })), /BACKUP_STAGING_SWEEP_MIN_AGE_HOURS must be an integer from 1 to 720/);
  }
});

test("S14 engine: createBackup writes a run marker, advances its state, never sweeps by default, and leaves no run directory after success", async () => {
  const r = await createFakeRemote({});
  try {
    const stale = await runDir(r.config.stagingDirectory, "backup", ID2);
    const states: string[] = [];
    const run: typeof r.run = async (command, replacements, op) => {
      if (command.executable === "upload" && replacements?.source) {
        const m = await readRunMarker(path.dirname(replacements.source));
        if (m && states.at(-1) !== m.state) states.push(m.state);
      }
      return r.run(command, replacements, op);
    };
    const { createBackup } = await import("../engine.js");
    await createBackup(r.config, { run, now: () => T0, log: (e) => r.logs.push(e) });
    assert.deepEqual(states, ["encrypted"], "marker says 'encrypted' while artifact is uploading");
    assert.ok(existsSync(stale), "default (off) must not sweep");
    assert.deepEqual((await readdir(r.config.stagingDirectory)).filter((n) => n.startsWith("backup-") && n !== `backup-${ID2}`), []);
  } finally { await r.cleanup(); }
});

test("S15 engine: stagingSweep=on at backup start removes stale dirs but never its own active run or another live run", async () => {
  const r = await createFakeRemote({ configOverrides: { stagingSweep: "on", stagingSweepMinAgeHours: 1 } });
  try {
    const stale = await runDir(r.config.stagingDirectory, "backup", ID2, { heartbeatAt: new Date(T0.getTime() - 5 * HOUR).toISOString(), startedAt: new Date(T0.getTime() - 5 * HOUR).toISOString() });
    const live = await runDir(r.config.stagingDirectory, "restore", ID1, { pid: process.pid, heartbeatAt: new Date(T0.getTime() - 5 * HOUR).toISOString() });
    const { createBackup } = await import("../engine.js");
    await createBackup(r.config, { run: r.run, now: () => T0, log: (e) => r.logs.push(e) });
    assert.ok(!existsSync(stale), "stale directory swept");
    assert.ok(existsSync(live), "directory of a live pid is never swept");
    assert.ok(r.logs.some((l) => l.event === "staging_sweep"));
    assert.ok(r.logs.some((l) => l.event === "completed"));
  } finally { await r.cleanup(); }
});

test("S16 engine: a sweep failure never fails or blocks the backup (reported, not fatal)", async () => {
  const r = await createFakeRemote({ configOverrides: { stagingSweep: "on" } });
  try {
    await writeFile(path.join(r.config.stagingDirectory, "sweep-audit.jsonl"), "").catch(() => undefined);
    const { createBackup } = await import("../engine.js");
    // Make the audit path a directory so audit writes fail.
    await rm(path.join(r.config.stagingDirectory, "sweep-audit.jsonl"), { force: true });
    await mkdir(path.join(r.config.stagingDirectory, "sweep-audit.jsonl"), { recursive: true });
    await runDir(r.config.stagingDirectory, "backup", ID2, { heartbeatAt: new Date(T0.getTime() - 99 * HOUR).toISOString() });
    const name = await createBackup(r.config, { run: r.run, now: () => T0, log: (e) => r.logs.push(e) });
    assert.match(name, /^aee-protected-/);
    assert.ok(r.logs.some((l) => l.event === "staging_sweep_failed"));
  } finally { await r.cleanup(); }
});

test("S17 engine: a failed backup removes its run directory (plaintext overwritten) and a failed restore does too", async () => {
  const r = await createFakeRemote({ failUpload: /\.tar\.enc$/ });
  try {
    await r.createBackup().then(() => assert.fail("must fail"), () => undefined);
    assert.deepEqual((await readdir(r.config.stagingDirectory)).filter((n) => n.startsWith("backup-")), []);
    await restoreBackup({ ...r.config, restoreDatabaseUrl: "postgresql://restore.invalid/other" }, { artifact: ARTIFACT, confirmDisposable: true }, { run: r.run, log: () => undefined }).then(() => undefined, () => undefined);
    assert.deepEqual((await readdir(r.config.stagingDirectory)).filter((n) => n.startsWith("restore-")), []);
  } finally { await r.cleanup(); }
});

// ---- crash / restart ------------------------------------------------------------------------------------------
const here = path.dirname(fileURLToPath(import.meta.url));
async function crashAt(stage: string) {
  const out = path.join(await mkdtemp(path.join(tmpdir(), "aee-crash-")), "out.json");
  const child = spawnSync(process.execPath, ["--import", "tsx", path.join(here, "helpers", "crashChild.ts")], {
    env: { ...process.env, CRASH_AT: stage, CRASH_OUT: out }, encoding: "utf8", timeout: 60_000,
  });
  assert.ok(child.signal === "SIGKILL" || child.status === null || child.status !== 0, `child must have been killed: ${child.status} ${child.signal} ${child.stderr}`);
  const info = JSON.parse(await readFile(out, "utf8")) as { staging: string; root: string };
  return { ...info, cleanup: async () => { await rm(info.root, { recursive: true, force: true }); await rm(path.dirname(out), { recursive: true, force: true }); } };
}

test("S18 crash before upload (SIGKILL): the sweep overwrites the plaintext and RETAINS the only encrypted artifact", async () => {
  const c = await crashAt("upload");
  try {
    const [dirName] = (await readdir(c.staging)).filter((n) => n.startsWith("backup-"));
    assert.ok(dirName, "a killed run leaves its directory behind");
    const dir = path.join(c.staging, dirName!);
    assert.ok(existsSync(path.join(dir, "database.dump")), "precondition: plaintext dump left by the crash");
    assert.equal((await readRunMarker(dir))?.state, "encrypted");
    const young = await sweepStaging({ stagingDirectory: c.staging, mode: "on", minAgeMs: 24 * HOUR, now: () => new Date() });
    assert.ok(existsSync(path.join(dir, "database.dump")), "a just-crashed run is too recent to sweep");
    assert.equal(young.entries[0]!.decision, "too_recent");
    const report = await sweepStaging({ stagingDirectory: c.staging, mode: "on", minAgeMs: 24 * HOUR, now: () => new Date(Date.now() + 48 * HOUR) });
    assert.equal(report.entries.find((e) => e.name === dirName)?.decision, "artifact_retained");
    const left = await readdir(dir);
    assert.ok(left.some((n) => n.endsWith(".tar.enc")), "encrypted artifact kept");
    for (const p of ["database.dump", "payload.tar", "documents.tar", "inventory.json"]) assert.ok(!left.includes(p), `${p} removed`);
  } finally { await c.cleanup(); }
});

test("S19 crash after verified upload (SIGKILL at prune): the sweep removes the whole directory", async () => {
  const c = await crashAt("list");
  try {
    const [dirName] = (await readdir(c.staging)).filter((n) => n.startsWith("backup-"));
    const dir = path.join(c.staging, dirName!);
    assert.equal((await readRunMarker(dir))?.state, "uploaded_verified");
    const report = await sweepStaging({ stagingDirectory: c.staging, mode: "on", minAgeMs: 24 * HOUR, now: () => new Date(Date.now() + 48 * HOUR) });
    const e = report.entries.find((x) => x.name === dirName);
    assert.equal(e?.decision, "removed", `${e?.decision}: ${e?.reason}`);
    assert.ok(!existsSync(dir));
  } finally { await c.cleanup(); }
});
