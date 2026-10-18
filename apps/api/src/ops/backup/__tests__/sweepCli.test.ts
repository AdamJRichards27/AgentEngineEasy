import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { productionEnv } from "./helpers/productionEnv.js";

// PH-7 R15: the operator sweep command reports through the structured logger; an operator can tell
// disabled / dry-run / failed apart from the output and the exit code.
const sweepScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sweep.ts");

function runSweep(env: Record<string, string>) {
  const child = spawnSync(process.execPath, ["--import", "tsx", sweepScript], {
    env: { PATH: process.env.PATH ?? "", ...productionEnv(env) }, encoding: "utf8", timeout: 60_000,
  });
  const parse = (text: string) => text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: child.status, out: parse(child.stdout), err: parse(child.stderr) };
}

test("R15-1 sweep off (default): one staging_sweep_disabled line on stdout, exit 0", () => {
  const r = runSweep({});
  assert.equal(r.status, 0);
  assert.equal(r.out.length, 1);
  assert.equal(r.out[0]!.event, "staging_sweep_disabled");
  assert.equal(r.out[0]!.mode, "off");
  assert.equal(r.err.length, 0);
});

test("R15-2 dry-run: staging_sweep with mode and counts on stdout, exit 0", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-sweepcli-"));
  try {
    await mkdir(path.join(root, "staging"), { recursive: true });
    const r = runSweep({ BACKUP_STAGING_DIRECTORY: path.join(root, "staging"), BACKUP_STAGING_SWEEP: "dry-run" });
    assert.equal(r.status, 0);
    assert.equal(r.out[0]!.event, "staging_sweep");
    assert.equal(r.out[0]!.mode, "dry-run");
    assert.deepEqual(r.out[0]!.counts, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("R15-3 failure: staging_sweep_failed on stderr, non-zero exit, no path in the output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aee-sweepcli-"));
  try {
    const notADirectory = path.join(root, "notadir");
    await writeFile(notADirectory, "x");
    const r = runSweep({ BACKUP_STAGING_DIRECTORY: notADirectory, BACKUP_STAGING_SWEEP: "on" });
    assert.notEqual(r.status, 0);
    assert.equal(r.out.length, 0);
    assert.equal(r.err[0]!.event, "staging_sweep_failed");
    assert.ok(!JSON.stringify(r.err).includes(root), "the failure line must not contain the staging path");
  } finally { await rm(root, { recursive: true, force: true }); }
});
