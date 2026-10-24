// WS4 follow-up: a pluggable alert hook for the scheduled risk exception scan. Before this, a scheduled scan that
// threw (or completed with per-rule errors) only produced a log line, so nothing could page anyone. The hook is a
// small sink interface; the default sink is a no-op (no real receiver, no credentials). Tests use a recording sink
// and an injected runner, so no database rows are read or written.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runScheduledScanTick } from "../bootstrap.js";
import {
  createRecordingScanFailureAlertSink,
  getScanFailureAlertSink,
  noopScanFailureAlertSink,
  setScanFailureAlertSink,
  type ScanFailureAlertSink,
} from "../scanFailureAlert.js";

const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
let logLines: Array<{ level: string; message: string }> = [];
function capture(chunk: unknown): boolean {
  const text = String(chunk);
  if (!text.trim().startsWith('{"')) return realOut(chunk as string);
  for (const raw of text.split("\n")) {
    if (!raw.trim().startsWith("{")) continue;
    try { logLines.push(JSON.parse(raw)); } catch { /* not a log line */ }
  }
  return true;
}

beforeEach(() => {
  logLines = [];
  process.env.LOG_LEVEL = "info";
  (process.stdout as { write: unknown }).write = capture;
  (process.stderr as { write: unknown }).write = capture;
});
afterEach(() => {
  (process.stdout as { write: unknown }).write = realOut;
  (process.stderr as { write: unknown }).write = realErr;
  setScanFailureAlertSink(null);
});

const summary = (errors: number) => ({
  scanRunId: "run-ws4", brokeragesScanned: 2, rulesEvaluated: 6, exceptionsCreated: 0, exceptionsUpdated: 0, exceptionsAutoResolved: 0, errors,
});

test("the default sink is the no-op sink (no real receiver is wired)", () => {
  assert.equal(getScanFailureAlertSink(), noopScanFailureAlertSink);
});

test("a thrown scheduled scan notifies the sink once with kind scan_threw and the error message", async () => {
  const sink = createRecordingScanFailureAlertSink();
  setScanFailureAlertSink(sink);
  await runScheduledScanTick(async () => { throw new Error("db unreachable"); });
  assert.equal(sink.alerts.length, 1);
  const a = sink.alerts[0]!;
  assert.equal(a.kind, "scan_threw");
  assert.equal(a.trigger, "SCHEDULED");
  assert.equal(a.errorMessage, "db unreachable");
  assert.equal(typeof a.durationMs, "number");
  assert.ok(!Number.isNaN(Date.parse(a.occurredAt)));
  assert.ok(logLines.some((l) => l.message === "exception_engine_scheduled_scan_failed"), "existing failure log line is kept");
});

test("a scan that completes with per-rule errors notifies with kind scan_completed_with_errors", async () => {
  const sink = createRecordingScanFailureAlertSink();
  setScanFailureAlertSink(sink);
  await runScheduledScanTick(async () => ({ ok: true, summary: summary(3) }));
  assert.equal(sink.alerts.length, 1);
  assert.equal(sink.alerts[0]!.kind, "scan_completed_with_errors");
  assert.equal(sink.alerts[0]!.errors, 3);
  assert.equal(sink.alerts[0]!.scanRunId, "run-ws4");
});

test("a clean scan and a refused (locked) scan do not notify", async () => {
  const sink = createRecordingScanFailureAlertSink();
  setScanFailureAlertSink(sink);
  await runScheduledScanTick(async () => ({ ok: true, summary: summary(0) }));
  await runScheduledScanTick(async () => ({ ok: false, skippedReason: "A scan is already running." }));
  assert.equal(sink.alerts.length, 0);
});

test("a sink that throws or rejects never breaks the tick, and the sink failure is logged", async () => {
  const throwing: ScanFailureAlertSink = { notify() { throw new Error("sink sync boom"); } };
  setScanFailureAlertSink(throwing);
  await assert.doesNotReject(runScheduledScanTick(async () => { throw new Error("scan boom"); }));
  const rejecting: ScanFailureAlertSink = { notify: async () => { throw new Error("sink async boom"); } };
  setScanFailureAlertSink(rejecting);
  await assert.doesNotReject(runScheduledScanTick(async () => { throw new Error("scan boom 2"); }));
  await new Promise((r) => setImmediate(r));
  assert.equal(logLines.filter((l) => l.message === "exception_engine_scan_failure_alert_sink_failed").length, 2);
});

test("setScanFailureAlertSink(null) restores the no-op default", () => {
  setScanFailureAlertSink(createRecordingScanFailureAlertSink());
  setScanFailureAlertSink(null);
  assert.equal(getScanFailureAlertSink(), noopScanFailureAlertSink);
});
