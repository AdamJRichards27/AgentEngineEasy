// WS4 follow-up: an env off-switch for restored / cloned environments. AEE_DISABLE_SCAN_SCHEDULERS stops the
// 15-minute risk exception scan timer and the Grow signal sweep timer from starting, even when a caller passes
// startScheduler: true. Default (unset) is unchanged: both schedulers start as before outside NODE_ENV=test.
// Only the timers are affected; event handlers and manual (MANUAL-trigger) runs are untouched.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { scanSchedulersOffSwitch, SCAN_SCHEDULERS_OFF_SWITCH_ENV } from "../scanSchedulerOffSwitch.js";
import { registerExceptionEngine, stopExceptionEngineScheduler, resolveExceptionSchedulerStart } from "../exceptions/bootstrap.js";
import { registerSignalSweep, stopSignalSweepScheduler, resolveSignalSweepStart } from "../propertyIntelligence/sweepBootstrap.js";

const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
type Line = { level: string; message: string; [k: string]: unknown };

afterEach(() => {
  delete process.env[SCAN_SCHEDULERS_OFF_SWITCH_ENV];
  (process.stdout as { write: unknown }).write = realOut;
  (process.stderr as { write: unknown }).write = realErr;
});

test("the env variable name is AEE_DISABLE_SCAN_SCHEDULERS", () => {
  assert.equal(SCAN_SCHEDULERS_OFF_SWITCH_ENV, "AEE_DISABLE_SCAN_SCHEDULERS");
});

test("unset, empty and explicit false-like values leave the schedulers ON (default unchanged)", () => {
  for (const v of [undefined, "", "  ", "false", "FALSE", "0", "no", "off"]) {
    assert.equal(scanSchedulersOffSwitch({ AEE_DISABLE_SCAN_SCHEDULERS: v }).disabled, false, `value ${JSON.stringify(v)}`);
  }
});

test("true-like values turn the schedulers OFF", () => {
  for (const v of ["true", "TRUE", " true ", "1", "yes", "on"]) {
    assert.equal(scanSchedulersOffSwitch({ AEE_DISABLE_SCAN_SCHEDULERS: v }).disabled, true, `value ${JSON.stringify(v)}`);
  }
});

test("an unrecognised value fails closed (schedulers OFF) and says so", () => {
  const r = scanSchedulersOffSwitch({ AEE_DISABLE_SCAN_SCHEDULERS: "restored-env" });
  assert.equal(r.disabled, true);
  assert.equal(r.reason, "unrecognised_value_fail_closed");
});

test("exception scan: default decision unchanged (on outside test, off under test, explicit option honoured)", () => {
  assert.equal(resolveExceptionSchedulerStart({}, { NODE_ENV: "production" }).start, true);
  assert.equal(resolveExceptionSchedulerStart({}, { NODE_ENV: "test" }).start, false);
  assert.equal(resolveExceptionSchedulerStart({ startScheduler: true }, { NODE_ENV: "test" }).start, true);
  assert.equal(resolveExceptionSchedulerStart({ startScheduler: false }, { NODE_ENV: "production" }).start, false);
});

test("exception scan: the off-switch wins over the default AND over startScheduler: true", () => {
  const env = { NODE_ENV: "production", AEE_DISABLE_SCAN_SCHEDULERS: "true" };
  assert.deepEqual(resolveExceptionSchedulerStart({}, env), { start: false, reason: "off_switch" });
  assert.deepEqual(resolveExceptionSchedulerStart({ startScheduler: true }, env), { start: false, reason: "off_switch" });
});

test("signal sweep: default decision unchanged, GROW_SIGNAL_SWEEP_ENABLED=false still disables", () => {
  assert.equal(resolveSignalSweepStart({}, { NODE_ENV: "production" }).start, true);
  assert.equal(resolveSignalSweepStart({}, { NODE_ENV: "test" }).start, false);
  assert.equal(resolveSignalSweepStart({}, { NODE_ENV: "production", GROW_SIGNAL_SWEEP_ENABLED: "false" }).start, false);
  assert.equal(resolveSignalSweepStart({ startScheduler: true }, { NODE_ENV: "test" }).start, true);
});

test("signal sweep: the off-switch wins over the default AND over startScheduler: true", () => {
  const env = { NODE_ENV: "production", AEE_DISABLE_SCAN_SCHEDULERS: "1" };
  assert.deepEqual(resolveSignalSweepStart({}, env), { start: false, reason: "off_switch" });
  assert.deepEqual(resolveSignalSweepStart({ startScheduler: true }, env), { start: false, reason: "off_switch" });
});

test("real registration with the switch set and startScheduler: true starts no timer and logs the disable reason", () => {
  const lines: Line[] = [];
  const capture = (chunk: unknown): boolean => {
    const text = String(chunk);
    if (!text.trim().startsWith('{"')) return realOut(chunk as string);
    for (const raw of text.split("\n")) {
      if (!raw.trim().startsWith("{")) continue;
      try { lines.push(JSON.parse(raw)); } catch { /* not a log line */ }
    }
    return true;
  };
  process.env.LOG_LEVEL = "info";
  process.env[SCAN_SCHEDULERS_OFF_SWITCH_ENV] = "true";
  (process.stdout as { write: unknown }).write = capture;
  (process.stderr as { write: unknown }).write = capture;
  try {
    registerExceptionEngine({ startScheduler: true });
    registerSignalSweep({ startScheduler: true });
  } finally {
    stopExceptionEngineScheduler();
    stopSignalSweepScheduler();
  }
  const names = lines.map((l) => l.message);
  assert.ok(!names.includes("exception_engine_scheduler_started"), "exception scan timer must not start");
  assert.ok(!names.includes("property_signal_sweep_scheduler_started"), "signal sweep timer must not start");
  const ex = lines.find((l) => l.message === "exception_engine_scheduler_disabled");
  const sw = lines.find((l) => l.message === "property_signal_sweep_scheduler_disabled");
  assert.equal(ex?.reason, "off_switch");
  assert.equal(sw?.reason, "off_switch");
  assert.equal(ex?.offSwitchEnv, "AEE_DISABLE_SCAN_SCHEDULERS");
});
