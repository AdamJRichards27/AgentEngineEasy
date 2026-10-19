// Scheduler observability: explicit start/tick/success/skip/failure log lines for the 15-minute exception scan
// and the signal sweep. Logging only — the injected runner stands in for the real scan/sweep so no database
// rows are read or written by these tests.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runScheduledScanTick } from "../exceptions/bootstrap.js";
import { runSignalSweepTick } from "../propertyIntelligence/sweepBootstrap.js";
import {
  __setOperationalAlertTransportForTesting,
  __resetOperationalAlertsForTesting,
} from "../operationalAlerts.js";

type Line = { level: string; message: string; [key: string]: unknown };
let lines: Line[] = [];
let alerts: unknown[] = [];
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);

function capture(chunk: unknown): boolean {
  const text = String(chunk);
  // Log lines are captured; anything else (the test runner's own reporting) passes straight through.
  if (!text.trim().startsWith('{"')) return realOut(chunk as string);
  for (const raw of text.split("\n")) {
    if (!raw.trim().startsWith("{")) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      /* not a log line */
    }
  }
  return true;
}

beforeEach(() => {
  lines = [];
  alerts = [];
  process.env.LOG_LEVEL = "info";
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.com/hook";
  process.env.OPERATIONAL_ALERTS_TOKEN = "test-only-token-0123456789";
  (process.stdout as { write: unknown }).write = capture;
  (process.stderr as { write: unknown }).write = capture;
  __setOperationalAlertTransportForTesting(async (_url: string, _token: string, alert: unknown) => {
    alerts.push(alert);
    return 200;
  });
});

afterEach(() => {
  for (const key of ["OPERATIONAL_ALERTS_ENABLED", "OPERATIONAL_ALERTS_PROVIDER", "OPERATIONAL_ALERTS_WEBHOOK_URL", "OPERATIONAL_ALERTS_TOKEN"]) delete process.env[key];
  (process.stdout as { write: unknown }).write = realOut;
  (process.stderr as { write: unknown }).write = realErr;
  __resetOperationalAlertsForTesting();
});

const names = () => lines.map((l) => l.message);

test("exception scan tick logs start then succeeded with the summary and duration", async () => {
  const summary = { scanRunId: "run-1", brokeragesScanned: 3, rulesEvaluated: 9, exceptionsCreated: 0, exceptionsUpdated: 0, exceptionsAutoResolved: 0, errors: 0 };
  let trigger: string | undefined;
  await runScheduledScanTick(async (t) => {
    trigger = t;
    return { ok: true, summary };
  });
  assert.equal(trigger, "SCHEDULED");
  assert.deepEqual(names(), ["exception_engine_scheduled_scan_tick_started", "exception_engine_scheduled_scan_tick_succeeded"]);
  const done = lines[1]!;
  assert.equal(done.scanRunId, "run-1");
  assert.equal(done.brokeragesScanned, 3);
  assert.equal(typeof done.durationMs, "number");
});

test("exception scan tick logs a refused (locked) scan as skipped, not as failure", async () => {
  await runScheduledScanTick(async () => ({ ok: false, skippedReason: "A scan is already running." }));
  assert.deepEqual(names(), ["exception_engine_scheduled_scan_tick_started", "exception_engine_scheduled_scan_tick_skipped"]);
  assert.equal(lines[1]!.reason, "A scan is already running.");
});

test("exception scan tick logs a thrown scan at error level under the existing failure name and does not rethrow", async () => {
  await runScheduledScanTick(async () => {
    throw new Error("boom");
  });
  assert.deepEqual(names(), ["exception_engine_scheduled_scan_tick_started", "exception_engine_scheduled_scan_failed"]);
  assert.equal(lines[1]!.level, "error");
});

test("signal sweep tick logs start then succeeded with the summary", async () => {
  const summary = {
    sweepRunId: "s-1", brokeragesConsidered: 2, brokeragesEvaluated: 2, brokeragesSkippedUnchanged: 0, candidatesEvaluated: 4,
    signalsCreated: 0, signalsUpdated: 0, signalsReRaised: 0, signalsExpired: 0, candidatesSuppressed: 0, truncated: false, errors: 0,
  };
  await runSignalSweepTick(async () => ({ ok: true, summary: summary as never }));
  assert.deepEqual(names(), ["property_signal_sweep_scheduled_tick_started", "property_signal_sweep_scheduled_tick_succeeded"]);
  assert.equal(lines[1]!.sweepRunId, "s-1");
  assert.equal(alerts.length, 0);
});

test("signal sweep tick logs skipped for a refused run and sends no alert", async () => {
  await runSignalSweepTick(async () => ({ ok: false, skippedReason: "locked" }));
  assert.deepEqual(names(), ["property_signal_sweep_scheduled_tick_started", "property_signal_sweep_scheduled_tick_skipped"]);
  assert.equal(alerts.length, 0);
});

test("signal sweep tick failure keeps the H-1 operational alert and the existing failure log name", async () => {
  await runSignalSweepTick(async () => {
    throw new Error("sweep exploded");
  });
  assert.ok(names().includes("property_signal_sweep_scheduled_run_failed"));
  await new Promise((r) => setImmediate(r));
  assert.equal(alerts.length, 1);
  assert.match(JSON.stringify(alerts[0]), /GROW_SIGNAL_SWEEP_UNHEALTHY/);
});
