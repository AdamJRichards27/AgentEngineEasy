// WS4-10: restore downloads the small integrity manifest FIRST and runs the WS4-06 dump-version check on it before the
// (large) dump artifact is downloaded. A missing, unreadable or incompatible manifest aborts fail-closed with a clear
// message, and the artifact is never requested. Isolated fake remote and synthetic files only; no real remote/bucket.
import assert from "node:assert/strict";
import { copyFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { restoreBackup } from "../engine.js";
import { DumpArchiveIncompatibleError } from "../dumpFormat.js";
import { DEFAULT_TIER_POLICY, ManifestUnavailableError, parseManifest } from "../artifacts.js";
import type { CommandRunner, OperationLog } from "../types.js";
import { createFakeRemote } from "./helpers/fakeBackupRemote.js";

const header = (minor: number): Buffer => Buffer.concat([Buffer.from("PGDMP"), Buffer.from([1, minor, 0, 4, 8, 1]), Buffer.from("rest-of-archive")]);
type Remote = Awaited<ReturnType<typeof createFakeRemote>>;

async function backup(minor: number, tiered = false) {
  const remote = await createFakeRemote({ seed: [], listIncludesUploads: true, ...(tiered ? { configOverrides: { tierPolicy: DEFAULT_TIER_POLICY } } : {}) });
  const run: CommandRunner = async (command, replacements, operation) => {
    if (command.executable === "pg_dump") {
      await writeFile(command.args[command.args.indexOf("--file") + 1]!, header(minor));
      return { stdout: "", stderr: "" };
    }
    return remote.run(command, replacements, operation);
  };
  await createBackup(remote, run);
  const artifactKey = [...remote.uploaded.keys()].find((k) => k.endsWith(".tar.enc") && (!tiered || k.startsWith("daily/")))!;
  return { remote, artifactKey, artifact: artifactKey.split("/").pop()!, tier: tiered ? ("daily" as const) : undefined };
}
async function createBackup(remote: Remote, run: CommandRunner) {
  const { createBackup: create } = await import("../engine.js");
  await create(remote.config, { run, now: () => new Date("2026-03-01T00:00:00Z"), log: () => undefined });
}

/** Records every download (object key, in order) and every executable. */
function restoreRunner(remote: Remote, trail: { downloads: string[]; calls: string[] }, overrideManifest?: Buffer | null): CommandRunner {
  return async (command, replacements, operation) => {
    trail.calls.push(command.executable);
    if (command.executable === "download") {
      trail.downloads.push(replacements!.object!);
      if (overrideManifest !== undefined && replacements!.object!.endsWith(".sha256.json")) {
        if (overrideManifest === null) throw new Error("NoSuchKey: synthetic missing manifest");
        await writeFile(replacements!.destination!, overrideManifest);
        return { stdout: "", stderr: "" };
      }
    }
    if (command.executable === "decrypt") { await copyFile(replacements!.input!, replacements!.output!); return { stdout: "", stderr: "" }; }
    if (command.executable === "pg_restore") return { stdout: "", stderr: "" };
    if (command.executable === "psql" && command.args.some((a) => a.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
    return remote.run(command, replacements, operation);
  };
}

async function restore(b: Awaited<ReturnType<typeof backup>>, opts: { pgRestoreMajor?: number; manifest?: Buffer | null } = {}) {
  const trail = { downloads: [] as string[], calls: [] as string[] };
  const logs: OperationLog[] = [];
  const error = await restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true, ...(b.tier ? { tier: b.tier } : {}) }, {
    run: restoreRunner(b.remote, trail, opts.manifest), log: (e) => logs.push(e), ...(opts.pgRestoreMajor !== undefined ? { pgRestoreMajor: opts.pgRestoreMajor } : {}),
  }).then(() => undefined, (e: unknown) => e as Error);
  const failed = logs.find((l) => l.event === "failed");
  return { error, trail, logs, failed };
}

test("order: the manifest is downloaded BEFORE the dump artifact, and the artifact only once", async () => {
  for (const tiered of [false, true]) {
    const b = await backup(15, tiered);
    try {
      const r = await restore(b, { pgRestoreMajor: 16 });
      assert.equal(r.error, undefined, String(r.error));
      assert.deepEqual(r.trail.downloads, [`${b.artifactKey}.sha256.json`, b.artifactKey]);
    } finally { await b.remote.cleanup(); }
  }
});

test("incompatible archive version in the manifest: refused before the dump is downloaded (exit-69 error type)", async () => {
  const b = await backup(16);
  try {
    const r = await restore(b, { pgRestoreMajor: 16 });
    assert.ok(r.error instanceof DumpArchiveIncompatibleError && r.error.source === "manifest", String(r.error));
    assert.deepEqual(r.trail.downloads, [`${b.artifactKey}.sha256.json`], "the dump artifact is never requested");
    assert.ok(!r.trail.calls.includes("decrypt") && !r.trail.calls.includes("pg_restore"));
    assert.equal(r.failed?.stage, "archive_version_check");
    assert.match(r.error.message, /found archive 1\.16\.0, required archive<=1\.15 \(pg_restore 16\)/);
  } finally { await b.remote.cleanup(); }
});

test("missing manifest: aborts before the dump download with a clear message (tiered and flat)", async () => {
  for (const tiered of [false, true]) {
    const b = await backup(15, tiered);
    try {
      const r = await restore(b, { pgRestoreMajor: 16, manifest: null });
      assert.ok(r.error instanceof ManifestUnavailableError, String(r.error));
      assert.equal(r.error.reason, "missing");
      assert.match(r.error.message, /^Restore aborted before downloading the dump: the integrity manifest ".*\.sha256\.json" could not be downloaded/);
      assert.match(r.error.message, /Underlying error: NoSuchKey: synthetic missing manifest/);
      if (tiered) assert.match(r.error.message, /from the "daily" tier.*--tier=daily/s);
      assert.deepEqual(r.trail.downloads, [`${b.artifactKey}.sha256.json`]);
      assert.equal(r.failed?.stage, "manifest_download");
    } finally { await b.remote.cleanup(); }
  }
});

test("download command exits 0 but writes nothing: treated as missing", async () => {
  const b = await backup(15);
  try {
    const trail = { downloads: [] as string[], calls: [] as string[] };
    const inner = restoreRunner(b.remote, trail);
    const run: CommandRunner = async (command, replacements, operation) => {
      if (command.executable === "download" && replacements!.object!.endsWith(".sha256.json")) { trail.downloads.push(replacements!.object!); return { stdout: "", stderr: "" }; }
      return inner(command, replacements, operation);
    };
    const error = await restoreBackup(b.remote.config, { artifact: b.artifact, confirmDisposable: true }, { run, log: () => undefined, pgRestoreMajor: 16 }).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof ManifestUnavailableError && error.reason === "missing", String(error));
    assert.deepEqual(trail.downloads, [`${b.artifactKey}.sha256.json`]);
  } finally { await b.remote.cleanup(); }
});

test("unreadable manifest (not JSON, wrong shape, other artifact, bad version field): aborts before the dump download", async () => {
  const b = await backup(15);
  const good = JSON.parse(b.remote.uploaded.get(`${b.artifactKey}.sha256.json`)!.toString("utf8")) as Record<string, unknown>;
  const bodies: Array<[string, Buffer]> = [
    ["not json", Buffer.from("{not json")],
    ["empty", Buffer.alloc(0)],
    ["array", Buffer.from("[]")],
    ["wrong version", Buffer.from(JSON.stringify({ ...good, version: 2 }))],
    ["other artifact", Buffer.from(JSON.stringify({ ...good, artifact: "aee-protected-20260101T000000Z-000000000000.tar.enc" }))],
    ["bad sha", Buffer.from(JSON.stringify({ ...good, sha256: "xyz" }))],
    ["bytes not a number", Buffer.from(JSON.stringify({ ...good, bytes: "12" }))],
    ["dumpArchiveVersion not a version", Buffer.from(JSON.stringify({ ...good, dumpArchiveVersion: 116 }))],
    ["dumpArchiveVersion garbage", Buffer.from(JSON.stringify({ ...good, dumpArchiveVersion: "1.16" }))],
  ];
  try {
    for (const [label, body] of bodies) {
      for (const major of [16, undefined]) {
        const r = await restore(b, { manifest: body, ...(major !== undefined ? { pgRestoreMajor: major } : {}) });
        assert.ok(r.error instanceof ManifestUnavailableError, `${label}/${major}: ${String(r.error)}`);
        assert.equal(r.error.reason, "unreadable", label);
        assert.match(r.error.message, /^Restore aborted before downloading the dump: the integrity manifest ".*\.sha256\.json" is unreadable/, label);
        assert.deepEqual(r.trail.downloads, [`${b.artifactKey}.sha256.json`], `${label}: the dump artifact is never requested`);
        assert.equal(r.failed?.stage, "manifest_check", label);
      }
    }
  } finally { await b.remote.cleanup(); }
});

test("legacy manifest (no dumpArchiveVersion) is readable: the dump is downloaded and the header check still guards pg_restore", async () => {
  const b = await backup(16);
  const good = JSON.parse(b.remote.uploaded.get(`${b.artifactKey}.sha256.json`)!.toString("utf8")) as Record<string, unknown>;
  delete good.dumpArchiveVersion;
  try {
    const r = await restore(b, { pgRestoreMajor: 16, manifest: Buffer.from(JSON.stringify(good) + "\n") });
    assert.ok(r.error instanceof DumpArchiveIncompatibleError && r.error.source === "header", String(r.error));
    assert.deepEqual(r.trail.downloads, [`${b.artifactKey}.sha256.json`, b.artifactKey]);
    assert.ok(!r.trail.calls.includes("pg_restore"));
    assert.ok(r.logs.some((l) => l.event === "manifest_without_archive_version"), "the operator is told the early check could not run");
  } finally { await b.remote.cleanup(); }
});

test("a manifest that passes the early check but does not match the downloaded dump still fails integrity (unchanged)", async () => {
  const b = await backup(15);
  const good = JSON.parse(b.remote.uploaded.get(`${b.artifactKey}.sha256.json`)!.toString("utf8")) as Record<string, unknown>;
  try {
    const r = await restore(b, { pgRestoreMajor: 16, manifest: Buffer.from(JSON.stringify({ ...good, sha256: "0".repeat(64) })) });
    assert.match(String(r.error), /SHA-256 or byte length does not match/);
    assert.equal(r.failed?.stage, "verify");
    assert.ok(!r.trail.calls.includes("decrypt"));
  } finally { await b.remote.cleanup(); }
});

test("parseManifest: structural validation without the artifact (unit)", () => {
  const ok = { version: 1, artifact: "a.tar.enc", createdAt: "x", sha256: "a".repeat(64), bytes: 3 };
  assert.deepEqual(parseManifest(JSON.stringify(ok), "a.tar.enc"), ok);
  assert.equal(parseManifest(JSON.stringify({ ...ok, dumpArchiveVersion: "1.15.0" }), "a.tar.enc").dumpArchiveVersion, "1.15.0");
  for (const bad of ["", "null", "{", JSON.stringify({ ...ok, artifact: "b.tar.enc" }), JSON.stringify({ ...ok, dumpArchiveVersion: "" })]) {
    assert.throws(() => parseManifest(bad, "a.tar.enc"), /malformed|names a different artifact|not valid JSON/, bad);
  }
});
