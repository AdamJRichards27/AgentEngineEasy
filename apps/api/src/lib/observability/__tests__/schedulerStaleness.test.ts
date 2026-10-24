// WS4 follow-up: staleness of the two background schedulers (risk exception scan, Grow signal sweep), readable by
// an external monitor. Exposed as a gauge on the EXISTING token-authenticated GET /api/internal/metrics (sampled at
// scrape time through sampleQueueGauges), so no route file or router registration changes.
//   scheduler_last_success_age_seconds{job="exception_scan"|"signal_sweep"}
// = whole seconds since the most recent COMPLETED run's completed_at; -1 = never succeeded or could not be read.
// DB-backed parts only add rows and assert bounds that stay true while other test files run against the same DB.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { db, riskExceptionScanRuns, growSignalSweepRuns } from "@aee/db";
import { resetMetricsForTesting, renderMetricsText } from "@aee/events";
import {
  computeSchedulerStaleness,
  readLastSuccessfulSchedulerRuns,
  sampleSchedulerStalenessGauges,
} from "../schedulerStaleness.js";
import { sampleQueueGauges } from "../queueGauges.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const scanIds: string[] = [];
const sweepIds: string[] = [];
let baseUrl: string;
let server: import("node:http").Server;
const TOKEN = "ws4-test-only-metrics-token-0123456789";

before(async () => {
  process.env.METRICS_TOKEN = TOKEN;
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (scanIds.length) await db.delete(riskExceptionScanRuns).where(inArray(riskExceptionScanRuns.id, scanIds));
  if (sweepIds.length) await db.delete(growSignalSweepRuns).where(inArray(growSignalSweepRuns.id, sweepIds));
  delete process.env.METRICS_TOKEN;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => resetMetricsForTesting());

const gauge = (text: string, job: string): number | null => {
  const m = text.match(new RegExp(`scheduler_last_success_age_seconds\\{job="${job}"\\} (-?\\d+)`));
  return m ? Number(m[1]) : null;
};

test("computeSchedulerStaleness: age in whole seconds from the last success; null when never succeeded", () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  const out = computeSchedulerStaleness({ exception_scan: new Date("2026-10-19T09:44:59.400Z"), signal_sweep: null }, now);
  assert.deepEqual(out, [
    { job: "exception_scan", lastSuccessAt: "2026-10-19T09:44:59.400Z", ageSeconds: 900 },
    { job: "signal_sweep", lastSuccessAt: null, ageSeconds: null },
  ]);
});

test("sampleSchedulerStalenessGauges publishes both jobs, -1 for never-succeeded", async () => {
  const now = new Date("2026-10-19T10:00:00.000Z");
  await sampleSchedulerStalenessGauges(now, async () => ({ exception_scan: new Date("2026-10-19T09:30:00.000Z"), signal_sweep: null }));
  const text = renderMetricsText();
  assert.match(text, /# TYPE scheduler_last_success_age_seconds gauge/);
  assert.equal(gauge(text, "exception_scan"), 1800);
  assert.equal(gauge(text, "signal_sweep"), -1);
});

test("a reader failure publishes -1 for both jobs and never throws (the scrape must not 500)", async () => {
  await assert.doesNotReject(sampleSchedulerStalenessGauges(new Date(), async () => { throw new Error("db down"); }));
  const text = renderMetricsText();
  assert.equal(gauge(text, "exception_scan"), -1);
  assert.equal(gauge(text, "signal_sweep"), -1);
});

test("the DB reader uses only COMPLETED runs: a just-completed run gives a small non-negative age; a FAILED run in the future is ignored", async () => {
  const now = new Date();
  const future = new Date(now.getTime() + 10 * 365 * 24 * 3600 * 1000);
  const [s1] = await db.insert(riskExceptionScanRuns).values({ status: "COMPLETED", trigger: "MANUAL", startedAt: now, completedAt: now }).returning();
  const [s2] = await db.insert(riskExceptionScanRuns).values({ status: "FAILED", trigger: "MANUAL", startedAt: future, completedAt: future }).returning();
  const [w1] = await db.insert(growSignalSweepRuns).values({ status: "COMPLETED", trigger: "MANUAL", startedAt: now, completedAt: now }).returning();
  const [w2] = await db.insert(growSignalSweepRuns).values({ status: "FAILED", trigger: "MANUAL", startedAt: future, completedAt: future }).returning();
  scanIds.push(s1!.id, s2!.id);
  sweepIds.push(w1!.id, w2!.id);

  const last = await readLastSuccessfulSchedulerRuns();
  assert.ok(last.exception_scan && last.signal_sweep, "both jobs have a COMPLETED run");
  for (const entry of computeSchedulerStaleness(last)) {
    assert.ok(entry.ageSeconds !== null && entry.ageSeconds >= 0 && entry.ageSeconds < 120, `${entry.job} age ${entry.ageSeconds}`);
  }
});

test("sampleQueueGauges (the existing scrape-time sampler) now also publishes the staleness gauges", async () => {
  await sampleQueueGauges();
  const text = renderMetricsText();
  assert.notEqual(gauge(text, "exception_scan"), null);
  assert.notEqual(gauge(text, "signal_sweep"), null);
});

test("GET /api/internal/metrics (existing route, existing bearer auth) serves the staleness gauges; no token is still 401", async () => {
  const ok = await fetch(`${baseUrl}/api/internal/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const text = await ok.text();
  assert.match(text, /scheduler_last_success_age_seconds\{job="exception_scan"\} -?\d+/);
  assert.match(text, /scheduler_last_success_age_seconds\{job="signal_sweep"\} -?\d+/);
  const denied = await fetch(`${baseUrl}/api/internal/metrics`);
  assert.equal(denied.status, 401);
});
