// WS4-07: AEE_RESTORED_ENVIRONMENT disables every outbound/background loop the API starts at boot.
// (1) value parsing, fail safe; (2) child-process boot driver with spies on timers and every outbound transport:
// with the switch on, zero intervals, zero loop timeouts, zero sends, one summary line; positive control with the
// switch off proves the same spies see every loop start; (3) guard: a setInterval in any non-registered file fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_LOOPS, BACKGROUND_LOOP_IDS, RESTORED_ENVIRONMENT_ENV, restoredEnvironmentMode } from "../restoredEnvironment.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../../..");
const srcRoot = path.join(apiRoot, "src");

test("the switch is AEE_RESTORED_ENVIRONMENT; unset/false-like keep today's behaviour", () => {
  assert.equal(RESTORED_ENVIRONMENT_ENV, "AEE_RESTORED_ENVIRONMENT");
  for (const v of [undefined, "", " ", "false", "FALSE", "0", "no", "off"]) assert.equal(restoredEnvironmentMode({ AEE_RESTORED_ENVIRONMENT: v }).restored, false, String(v));
});

test("true-like values mark the environment restored; unknown values fail safe (restored) with a reason", () => {
  for (const v of ["true", "TRUE", " on ", "1", "yes"]) assert.deepEqual(restoredEnvironmentMode({ AEE_RESTORED_ENVIRONMENT: v }), { restored: true, reason: "explicit_on" });
  assert.deepEqual(restoredEnvironmentMode({ AEE_RESTORED_ENVIRONMENT: "uat-copy" }), { restored: true, reason: "unrecognised_value_fail_closed" });
});

function boot(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== RESTORED_ENVIRONMENT_ENV) env[k] = v;
  Object.assign(env, { LOG_LEVEL: "info", PIT_CREW_WAITING_ON_SWEEP_ENABLED: "true" }, extra);
  const r = spawnSync(process.execPath, ["--import", "tsx", path.join(here, "fixtures", "restoredEnvBootDriver.ts")], { cwd: apiRoot, env, encoding: "utf8", timeout: 90_000 });
  const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("WS4-07-RESULT "));
  assert.ok(line, `driver produced no result (status ${r.status}): ${r.stderr.slice(-2000)}`);
  return JSON.parse(line.slice("WS4-07-RESULT ".length)) as {
    intervalsStarted: Array<{ file: string | null; ms: number }>; srcTimeouts: Array<{ file: string; ms: number }>;
    sends: Array<{ via: string; target: string }>; errors: string[]; summary: Array<Record<string, unknown>>;
  };
}

test("switch ON (with startScheduler: true, runImmediately, and 3 ticks): zero timers, zero sends, one summary line", () => {
  const r = boot({ AEE_RESTORED_ENVIRONMENT: "true", WS4_07_TICK: "1", WS4_07_RUN_IMMEDIATELY: "1" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.intervalsStarted, [], "no interval may start");
  assert.deepEqual(r.srcTimeouts, [], "no loop timeout may start");
  assert.deepEqual(r.sends, [], "no outbound fetch/http/socket (other than the test database)");
  assert.equal(r.summary.length, 1, "exactly one structured summary line");
  assert.deepEqual(r.summary[0]!.disabled, BACKGROUND_LOOP_IDS);
  assert.equal(r.summary[0]!.reason, "explicit_on");
});

test("switch with an unrecognised value fails safe: zero timers, logged reason", () => {
  const r = boot({ AEE_RESTORED_ENVIRONMENT: "restored-from-prod", WS4_07_TICK: "1" });
  assert.deepEqual(r.intervalsStarted, []);
  assert.deepEqual(r.sends, []);
  assert.equal(r.summary[0]?.reason, "unrecognised_value_fail_closed");
});

test("positive control, switch OFF: the same spies see every registered loop start an interval and every transport send", () => {
  const r = boot({ WS4_07_SPY_SELFTEST: "1" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.sends.map((x) => x.via).sort(), ["fetch", "http.get", "https.request", "net.connect"], "transport spies record sends");
  const files = new Set(r.intervalsStarted.map((i) => i.file));
  for (const id of BACKGROUND_LOOP_IDS) assert.ok(files.has(BACKGROUND_LOOPS[id].file), `${id} (${BACKGROUND_LOOPS[id].file}) started: ${[...files].join(",")}`);
  assert.equal(r.intervalsStarted.length, BACKGROUND_LOOP_IDS.length);
  assert.equal(r.summary.length, 0, "no summary line when the switch is off");
});

// ---------- guard ----------
const NOT_BOOT_LOOPS: Record<string, string> = {
  "ops/backup/stagingSweep.ts": "heartbeat inside a backup/restore CLI run (ops/backup CLIs), never started by the API process",
};
const HANDLER_ONLY_REGISTRATIONS = new Set(["registerAutomationEngine", "registerLaunchEngine"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === "__tests__" || name === "node_modules" ? [] : walk(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

test("guard: every non-test file that calls setInterval( is a registered background loop (or a documented non-boot loop)", () => {
  const registered = new Set<string>(Object.values(BACKGROUND_LOOPS).map((l) => l.file));
  const offenders = walk(srcRoot)
    .filter((f) => /\bsetInterval\s*\(/.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(srcRoot, f).split(path.sep).join("/"))
    .filter((f) => !registered.has(f) && !(f in NOT_BOOT_LOOPS));
  assert.deepEqual(offenders, [], "register the new loop in lib/restoredEnvironment.ts BACKGROUND_LOOPS and gate it with backgroundLoopDisabled()");
});

test("guard: every registered loop file gates its timer with backgroundLoopDisabled(<its id>)", () => {
  for (const id of BACKGROUND_LOOP_IDS) {
    const source = readFileSync(path.join(srcRoot, BACKGROUND_LOOPS[id].file), "utf8");
    assert.ok(source.includes(`backgroundLoopDisabled("${id}")`), `${BACKGROUND_LOOPS[id].file} must call backgroundLoopDisabled("${id}")`);
  }
});

test("guard: every register*() call in apps/api/src/index.ts is a registered loop or a handler-only registration", () => {
  const index = readFileSync(path.join(srcRoot, "index.ts"), "utf8");
  const calls = [...index.matchAll(/^\s*(register[A-Za-z]+)\(/gm)].map((m) => m[1]!);
  const loopRegisters = new Set<string>(Object.values(BACKGROUND_LOOPS).map((l) => l.register));
  assert.ok(calls.length >= 10, `found ${calls.join(",")}`);
  for (const c of calls) assert.ok(loopRegisters.has(c) || HANDLER_ONLY_REGISTRATIONS.has(c), `${c} is neither a registered loop nor handler-only`);
  for (const r of loopRegisters) assert.ok(calls.includes(r), `${r} is registered but not called from index.ts`);
});
