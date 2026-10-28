// AE GROW Completion Program — Wave 1, slice W1-D.
//
// Regression coverage for the three things this slice added below the HTTP
// layer: the unhealthy-sweep ALERT (H-1, the P0), the two new sweep METRICS
// plus the previously-dead `expired` label (H-6), and getSweepOpsHealth()'s
// own answers (H-2/H-3). The route wiring on top of these is covered
// separately in routes/__tests__/propertyIntelligenceOps.test.ts.
//
// Real Postgres, real fixtures, no mock of the module under test — the
// convention every suite in this directory follows. The only injections are
// the alert transport seam operationalAlerts.ts already exposes for exactly
// this purpose, and the metrics registry's own test-only reset.
//
// Every sweep here is SCOPED to this file's own brokerage, except where the
// unscoped production path is itself under test.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, growSignalSweepCursors, growSignalSweepRuns, parties, properties, setDbQueryObserver } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import {
  runSignalSweep,
  resetSweepResumePointForTests,
  getSweepOpsHealth,
  sweepConfig,
  LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS,
} from "../sweep.js";
import { acquireSweepLockForTest, sweepWhenLockFree } from "./sweepLockContention.js";
import {
  __setOperationalAlertTransportForTesting,
  __resetOperationalAlertsForTesting,
  OPERATIONAL_ALERT_POLICIES,
} from "../../operationalAlerts.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

/** Every alert the sweep dispatched during a test, captured at the transport seam. */
interface CapturedAlert {
  type: string;
  dedupKey: string;
  severity: string;
  owner: string;
  runbook: string;
  summary: string;
  details?: Record<string, unknown>;
}
let captured: CapturedAlert[] = [];

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Sweep Ops A ${suffix}`);

  // Alert delivery is disabled unless a deployment explicitly turns it on, so
  // a test that did not set these would assert on a no-op and pass vacuously.
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "http://127.0.0.1:1/w1d-test-sink";
  process.env.OPERATIONAL_ALERTS_TOKEN = "w1d-test-token-at-least-16-chars";
  __setOperationalAlertTransportForTesting(async (_url, _token, envelope) => {
    captured.push(envelope as unknown as CapturedAlert);
    return 200;
  });
});

after(async () => {
  delete process.env.OPERATIONAL_ALERTS_ENABLED;
  delete process.env.OPERATIONAL_ALERTS_PROVIDER;
  delete process.env.OPERATIONAL_ALERTS_WEBHOOK_URL;
  delete process.env.OPERATIONAL_ALERTS_TOKEN;
  __resetOperationalAlertsForTesting();
  await cleanupBrokerages([A?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  captured = [];
  __resetOperationalAlertsForTesting();
  resetSweepResumePointForTests();
  resetMetricsForTesting();
});

/**
 * The alert dispatch is deliberately fire-and-forget (a refused sweep must
 * never be turned into a thrown one by an alerting problem), so the promise
 * it returns is not awaited by the caller. Give the microtask queue a turn.
 */
async function settleAlerts(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * Counter value for one exact series in the Prometheus render, or 0 when the
 * series is absent.
 *
 * Parses each line's labels rather than string-matching them: renderMetricsText
 * emits labels in METRIC_DEFINITIONS declaration order, not the order a caller
 * happens to write them, so a substring match silently reads 0 for a series
 * that is really there.
 */
function counter(name: string, labels: Record<string, string>): number {
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const rendered = Object.fromEntries(
      line
        .slice(line.indexOf("{") + 1, line.indexOf("}"))
        .split(",")
        .filter(Boolean)
        .map((pair) => {
          const [k, v] = pair.split("=");
          return [k, v.replace(/"/g, "")];
        }),
    );
    const matches =
      Object.keys(rendered).length === Object.keys(labels).length &&
      Object.entries(labels).every(([k, v]) => rendered[k] === v);
    if (matches) return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/**
 * Clears any RUNNING row left behind by another suite. The condition under
 * test in the leak cases is precisely "the lock is held and NOTHING is
 * running"; a stray RUNNING row would mask it — and is itself abandoned,
 * which is exactly what an unscoped sweep's own stale-run recovery concludes.
 */
async function clearRunningRows(): Promise<void> {
  await db
    .update(growSignalSweepRuns)
    .set({ status: "FAILED", completedAt: new Date(), errorMessage: "Abandoned: the sweep did not complete (its process stopped while running)." })
    .where(eq(growSignalSweepRuns.status, "RUNNING"));
}

/*
 * The sweep's single-flight advisory lock (0x41455351, 1) is DATABASE-wide, not
 * process-wide. The test runner gives each test FILE its own process, but those
 * processes share one database, and several other suites trigger sweeps -- the
 * ops route suite does it over HTTP. So a sibling suite can legitimately hold
 * the lock at the instant one of these tests wants it.
 *
 * That is the single-flight guarantee working correctly, not a defect, but it
 * made two assumptions in this file flaky: "the lock must be free right now"
 * and "my sweep must have run". Both now retry briefly instead of asserting
 * exclusivity on first try. The retries are bounded and fail loudly, so a
 * genuine leak -- the P0 this file exists to catch -- still fails the suite
 * rather than hanging.
 */
//
// The waits themselves now live in sweepLockContention.ts, shared with the
// other sweep suites: a 60 s bound instead of 2 s, a free-lock probe before
// each sweep attempt, and no orphaned-refusal count carried over from a
// contention retry. Every test here that inserts or clears RUNNING rows does
// it while holding the lock, so a sibling's live run is never among them and
// a sibling's stale-run recovery cannot close this file's fixture row.
const sweepExclusively = sweepWhenLockFree;

/* ---------------------------------------------------------------------
 * H-1 (P0) — the suspected lock leak must be ALERTABLE, not just logged.
 *
 * logger.error is never bridged to dispatchOperationalAlert (logger.ts only
 * writes JSON to stderr), so before this slice a leaked lock was entirely
 * silent: sweeping was dead while property_signal_sweep_total kept reporting
 * the healthy-looking `skipped_locked`. Each test below fails against the
 * code as it was before the fix.
 * -----------------------------------------------------------------*/

test("H-1 — a held lock with no RUNNING row, repeated to the threshold, dispatches exactly one GROW_SIGNAL_SWEEP_UNHEALTHY alert", async () => {
  const release = await acquireSweepLockForTest();
  try {
    await clearRunningRows();
    for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS; attempt += 1) {
      const refused = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
      assert.equal(refused.ok, false, "the lock is held, so every attempt must be refused");
    }
    await settleAlerts();
  } finally {
    await release();
  }

  const leaks = captured.filter((a) => a.dedupKey === "grow-signal-sweep:lock-leak");
  assert.equal(leaks.length, 1, "a suspected lock leak must raise exactly one alert, not zero and not one per refusal");
  assert.equal(leaks[0].type, "GROW_SIGNAL_SWEEP_UNHEALTHY");
  // The policy travels on the envelope, so an operator sees severity/owner/
  // runbook without consulting the source.
  assert.equal(leaks[0].severity, "high");
  assert.equal(leaks[0].owner, "operations");
  assert.equal(leaks[0].runbook, "grow-signal-sweep");
});

test("H-1 — the ordinary race (a single orphaned refusal below the threshold) alerts nobody", async () => {
  const release = await acquireSweepLockForTest();
  try {
    await clearRunningRows();
    // One below the threshold: this is the documented, expected case — the
    // holder inserts its run row a moment after taking the lock.
    for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS - 1; attempt += 1) {
      await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
    }
    await settleAlerts();
  } finally {
    await release();
  }
  assert.deepEqual(captured, [], "an ordinary lock race must never page anyone");
});

test("H-1 — a refusal while a sweep really IS running is the expected outcome and alerts nobody", async () => {
  // A genuine RUNNING row present: this is not a leak at all.
  const release = await acquireSweepLockForTest();
  let runningRow: { id: string } | undefined;
  try {
    await clearRunningRows();
    [runningRow] = await db.insert(growSignalSweepRuns).values({ status: "RUNNING", trigger: "SCHEDULED" }).returning();
    for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS + 2; attempt += 1) {
      const refused = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
      assert.equal(refused.ok, false);
    }
    await settleAlerts();
  } finally {
    if (runningRow) await db.delete(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, runningRow.id));
    await release();
  }
  assert.deepEqual(captured, [], "a refusal with a real RUNNING row is the documented expected case, not an incident");
  assert.equal(
    counter("property_signal_sweep_lock_orphaned_total", { kind: "suspected_leak", trigger: "MANUAL" }),
    0,
    "a refusal with a RUNNING row is not orphaned at all and must not touch this counter",
  );
});

/* ---------------------------------------------------------------------
 * H-6 — the two new counters, and the label that was declared-but-dead.
 * -----------------------------------------------------------------*/

test("H-6 — orphaned-lock refusals are counted by kind, separately from property_signal_sweep_total's skipped_locked", async () => {
  const release = await acquireSweepLockForTest();
  try {
    await clearRunningRows();
    for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS; attempt += 1) {
      await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
    }
    await settleAlerts();
  } finally {
    await release();
  }

  const races = counter("property_signal_sweep_lock_orphaned_total", { kind: "race", trigger: "MANUAL" });
  const leaks = counter("property_signal_sweep_lock_orphaned_total", { kind: "suspected_leak", trigger: "MANUAL" });
  assert.equal(races, LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS - 1, "every refusal below the threshold counts as a race");
  assert.equal(leaks, 1, "the refusal that reached the threshold counts as a suspected leak");

  // The separation is the whole point: skipped_locked must keep counting
  // EXPECTED refusals only, and `failed` must not be polluted with refusals.
  assert.equal(
    counter("property_signal_sweep_total", { outcome: "skipped_locked", trigger: "MANUAL" }),
    LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS,
    "every refusal is still a skipped_locked, orphaned or not",
  );
  assert.equal(counter("property_signal_sweep_total", { outcome: "failed", trigger: "MANUAL" }), 0, "a refusal is not a failed sweep");
});

test("H-6 — no new sweep metric series carries a tenant identifier", async () => {
  const release = await acquireSweepLockForTest();
  try {
    await clearRunningRows();
    await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
  } finally {
    await release();
  }
  await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });

  const rendered = renderMetricsText();
  const sweepSeries = rendered
    .split("\n")
    .filter((l) => l.startsWith("property_signal_") && !l.startsWith("#"));
  assert.ok(sweepSeries.length > 0, "the render must actually contain sweep series, or this test proves nothing");
  for (const line of sweepSeries) {
    const labels = line.slice(line.indexOf("{") + 1, line.indexOf("}"));
    assert.doesNotMatch(labels, /brokerage|tenant|party|property_id|user/i, `series carries a tenant identifier: ${line}`);
    assert.doesNotMatch(labels, new RegExp(`"${A.brokerageId}"`), `series carries this test's brokerage id: ${line}`);
  }
});

test("H-6 — property_signal_outcome_total{outcome=\"expired\"} is no longer a dead label", async () => {
  // The number was computed (summary.signalsExpired) and discarded before
  // this slice, so this series never existed at all.
  const result = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });

  const rendered = renderMetricsText();
  assert.ok(
    rendered.includes('property_signal_outcome_total{outcome="expired"}'),
    "the sweep must now emit the expired series it has always computed",
  );
  // And it agrees with the run's own bookkeeping, rather than being an
  // independently-invented number.
  if (result.ok) {
    assert.equal(
      counter("property_signal_outcome_total", { outcome: "expired" }),
      result.summary.signalsExpired,
      "the counter must match the summary field it is derived from",
    );
  }
});

/* ---------------------------------------------------------------------
 * H-2 / H-3 — getSweepOpsHealth() is the honest answer to "is this alive?".
 * -----------------------------------------------------------------*/

test("H-2 — ops health reports the scheduler's effective configuration and the recent run rows", async () => {
  await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
  const health = await getSweepOpsHealth();
  const config = sweepConfig();

  assert.equal(health.scheduler.enabled, config.enabled);
  assert.equal(health.scheduler.intervalMs, config.intervalMs);
  assert.equal(health.scheduler.maxBrokerages, config.maxBrokerages);
  assert.equal(health.scheduler.maxCandidatesPerBrokerage, config.maxCandidatesPerBrokerage);

  assert.ok(Array.isArray(health.recentRuns));
  assert.ok(health.recentRuns.length > 0 && health.recentRuns.length <= 5, "at most the five most recent runs");
  // truncated / errors / the signals* and brokerages* counters come free on
  // the run rows — H-2 required no new columns.
  const [newest] = health.recentRuns;
  assert.equal(typeof newest.truncated, "boolean");
  assert.equal(typeof newest.errors, "number");
  assert.equal(typeof newest.brokeragesConsidered, "number");
  assert.equal(typeof newest.signalsExpired, "number");
  // Newest first.
  for (let i = 1; i < health.recentRuns.length; i += 1) {
    assert.ok(
      health.recentRuns[i - 1].startedAt.getTime() >= health.recentRuns[i].startedAt.getTime(),
      "recent runs must be newest-first",
    );
  }
});

test("H-3 — a sweep that just completed is not stale; the threshold is 3x the scheduler interval", async () => {
  await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
  const health = await getSweepOpsHealth();

  assert.notEqual(health.lastCompletedAt, null, "a run just completed, so this cannot be null");
  assert.equal(health.staleBy.thresholdMs, sweepConfig().intervalMs * 3);
  assert.equal(typeof health.staleBy.ageMs, "number");
  assert.equal(health.staleBy.stale, false, "a sweep that completed moments ago is not stale");
});

test("H-3 — staleness is computed against lastCompletedAt, so an old completion reads stale", async () => {
  await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
  const fresh = await getSweepOpsHealth();
  assert.equal(fresh.staleBy.stale, false);

  // Evaluate the same state from far enough in the future that the newest
  // completion is past 3x the interval. This exercises the real threshold
  // arithmetic without rewriting any run row's timestamps.
  const wayLater = new Date(Date.now() + sweepConfig().intervalMs * 3 + 60_000);
  const stale = await getSweepOpsHealth(wayLater);
  assert.equal(stale.staleBy.stale, true, "a completion older than 3x the interval must read stale");
  assert.ok((stale.staleBy.ageMs ?? 0) > stale.staleBy.thresholdMs);
});

test("H-3 — runningRunId reports an in-flight run and is null otherwise", async () => {
  // Held for the whole test, so no sibling file's sweep can insert its own
  // RUNNING row or recover (close) this one between the two reads.
  const release = await acquireSweepLockForTest();
  try {
    await clearRunningRows();
    const idle = await getSweepOpsHealth();
    assert.equal(idle.runningRunId, null, "nothing is running, so this must be null");

    const [runningRow] = await db.insert(growSignalSweepRuns).values({ status: "RUNNING", trigger: "SCHEDULED" }).returning();
    try {
      const busy = await getSweepOpsHealth();
      assert.equal(busy.runningRunId, runningRow.id, "a RUNNING row must be reported — a non-null id with an old startedAt is the shape of a crashed sweep");
    } finally {
      await db.delete(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, runningRow.id));
    }
  } finally {
    await release();
  }
});

test("H-3 — lastCompletedAt is derived from a real COMPLETED row, not from the five-row recentRuns window", async () => {
  // The distinction this asserts: with the five most recent runs ALL non-
  // COMPLETED, a health check that scanned only recentRuns would wrongly
  // report "never completed" on a system that has completed sweeps.
  await sweepExclusively({ brokerageIds: [A.brokerageId] });
  const withCompletion = await getSweepOpsHealth();
  assert.notEqual(withCompletion.lastCompletedAt, null);

  // The run rows are global. Holding the sweep lock keeps a sibling file's
  // sweep from adding its own run row between the noise and the read, and the
  // noise is dated an hour ahead so it is the newest window even next to a
  // sibling's fixture row (sweep.test.ts's stale-run row starts 10 min ahead).
  const release = await acquireSweepLockForTest();
  const noise = [];
  try {
    const noiseStartedAt = new Date(Date.now() + 60 * 60 * 1000);
    for (let i = 0; i < 6; i += 1) {
      const [row] = await db
        .insert(growSignalSweepRuns)
        .values({ status: "FAILED", trigger: "SCHEDULED", startedAt: new Date(noiseStartedAt.getTime() + i), completedAt: new Date() })
        .returning();
      noise.push(row.id);
    }
    const health = await getSweepOpsHealth();
    assert.ok(health.recentRuns.every((r) => r.status === "FAILED"), "the recentRuns window is now entirely FAILED rows");
    assert.notEqual(health.lastCompletedAt, null, "lastCompletedAt must still find the real completion behind the window");
  } finally {
    for (const id of noise) await db.delete(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, id));
    await release();
  }
});

test("H-3 — brokeragesDue reports what the next run would consider, bounded by maxBrokerages", async () => {
  const health = await getSweepOpsHealth();
  assert.equal(typeof health.brokeragesDue, "number");
  assert.ok(health.brokeragesDue >= 0);
  assert.ok(health.brokeragesDue <= sweepConfig().maxBrokerages, "never more than one run's own bound");
});

test("the alert policy registry declares GROW_SIGNAL_SWEEP_UNHEALTHY exactly once, with the agreed policy", () => {
  const policy = OPERATIONAL_ALERT_POLICIES.GROW_SIGNAL_SWEEP_UNHEALTHY;
  assert.deepEqual(policy, { severity: "high", owner: "operations", runbook: "grow-signal-sweep" });
});

/* ---------------------------------------------------------------------
 * H-4 (P1) — a per-brokerage failure and a cursor-touch failure must page.
 *
 * H-1 already raises GROW_SIGNAL_SWEEP_UNHEALTHY when the sweep as a whole
 * is not running (leaked lock, or a scheduled tick that throws). These two
 * paths used to stop at property_signal_sweep_brokerage_failure_total and
 * logger.error, which is not bridged to dispatchOperationalAlert. A tenant
 * that fails on every scheduled pass, and a cursor stamp that never lands,
 * could therefore fail forever with no alert.
 * -----------------------------------------------------------------*/

/**
 * Fails brokerageId's cursor read (the first statement of its pass) and,
 * when failCursorTouch is set, the follow-up stamp of last_evaluated_at.
 * Same statement-observer seam sweepRemediation.test.ts uses for P1-2.
 */
function failBrokeragePass(brokerageId: number, failCursorTouch: boolean): { uninstall: () => void; counts: { evaluation: number; cursorTouch: number } } {
  const counts = { evaluation: 0, cursorTouch: 0 };
  const uninstall = setDbQueryObserver((query, params) => {
    const text = query.toLowerCase().replace(/\s+/g, " ").trim();
    if (!text.includes("grow_signal_sweep_cursors")) return;
    const targetsBrokerage = params.some((param) => param === brokerageId || param === String(brokerageId));
    if (!targetsBrokerage) return;
    if (text.startsWith("select")) {
      counts.evaluation += 1;
      throw new Error("injected: brokerage read failed");
    }
    if (failCursorTouch && (text.startsWith("insert") || text.startsWith("update"))) {
      counts.cursorTouch += 1;
      throw new Error("injected: cursor touch failed");
    }
  });
  return { uninstall, counts };
}

test("H-4 — a per-brokerage evaluation failure dispatches GROW_SIGNAL_SWEEP_BROKERAGE_FAILED, stamps the cursor, and dedupes a repeat", async () => {
  await db.delete(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, A.brokerageId));
  const injected = failBrokeragePass(A.brokerageId, false);
  let firstRunId = "";
  try {
    const first = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
    firstRunId = first.summary.sweepRunId;
    assert.equal(first.summary.errors, 1, "the failing pass is counted and the run still completes");
    await settleAlerts();
    const second = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
    assert.equal(second.summary.errors, 1);
    await settleAlerts();
  } finally {
    injected.uninstall();
  }

  assert.ok(injected.counts.evaluation >= 2, "the brokerage read really failed on both passes");
  assert.equal(injected.counts.cursorTouch, 0, "this case stamps the cursor; it must not inject a cursor-touch failure");

  const alerts = captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_BROKERAGE_FAILED");
  assert.equal(alerts.length, 1, "two failing passes inside the cooldown dispatch exactly one evaluation alert");
  assert.equal(alerts[0].dedupKey, `grow-signal-sweep:brokerage-evaluation-failed:${A.brokerageId}`);
  assert.equal(alerts[0].severity, "high");
  assert.equal(alerts[0].owner, "operations");
  assert.equal(alerts[0].runbook, "grow-signal-sweep");
  assert.equal(alerts[0].details?.brokerageId, A.brokerageId);
  assert.equal(alerts[0].details?.sweepRunId, firstRunId);
  assert.equal(alerts[0].details?.kind, "evaluation");
  assert.equal(captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED").length, 0);
  assert.equal(captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_UNHEALTHY").length, 0, "one tenant failing is not the whole-sweep alert");

  assert.equal(counter("property_signal_sweep_brokerage_failure_total", { kind: "evaluation" }), 2, "the metric still counts every failure; dedup is alert-only");
  assert.equal(counter("property_signal_sweep_brokerage_failure_total", { kind: "cursor_touch" }), 0);

  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, A.brokerageId));
  assert.ok(cursor?.lastEvaluatedAt, "a failing pass still stamps last_evaluated_at so the tenant cannot pin the front of the ordering");
  const [run] = await db.select().from(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, firstRunId));
  assert.equal(run.status, "COMPLETED", "a run that lost one tenant is completed-with-errors");
  assert.equal(run.errors, 1);
});

test("H-4 — a cursor-touch failure dispatches GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED and does not advance the cursor", async () => {
  await db.delete(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, A.brokerageId));
  const injected = failBrokeragePass(A.brokerageId, true);
  let firstRunId = "";
  try {
    const first = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
    firstRunId = first.summary.sweepRunId;
    assert.equal(first.summary.errors, 1);
    assert.equal(first.ok, true, "a cursor-touch failure must not fail the whole run");
    await settleAlerts();
    const second = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
    assert.equal(second.summary.errors, 1);
    await settleAlerts();
  } finally {
    injected.uninstall();
  }

  assert.ok(injected.counts.evaluation >= 2, "the evaluation failure is what leads to the cursor touch");
  assert.ok(injected.counts.cursorTouch >= 2, "the cursor stamp really failed on both passes");

  const cursorAlerts = captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED");
  const evaluationAlerts = captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_BROKERAGE_FAILED");
  assert.equal(cursorAlerts.length, 1, "two cursor-touch failures inside the cooldown dispatch exactly one cursor-touch alert");
  assert.equal(evaluationAlerts.length, 1, "the evaluation failure on the same pass still pages, on its own dedup key");
  assert.equal(cursorAlerts[0].dedupKey, `grow-signal-sweep:cursor-touch-failed:${A.brokerageId}`);
  assert.equal(cursorAlerts[0].severity, "high");
  assert.equal(cursorAlerts[0].owner, "operations");
  assert.equal(cursorAlerts[0].runbook, "grow-signal-sweep");
  assert.equal(cursorAlerts[0].details?.brokerageId, A.brokerageId);
  assert.equal(cursorAlerts[0].details?.sweepRunId, firstRunId);
  assert.equal(cursorAlerts[0].details?.kind, "cursor_touch");
  assert.match(String(cursorAlerts[0].summary), /last_evaluated_at/);

  assert.equal(counter("property_signal_sweep_brokerage_failure_total", { kind: "evaluation" }), 2);
  assert.equal(counter("property_signal_sweep_brokerage_failure_total", { kind: "cursor_touch" }), 2);

  const rendered = renderMetricsText();
  for (const line of rendered.split("\n")) {
    if (!line.startsWith("property_signal_sweep_brokerage_failure_total{")) continue;
    assert.doesNotMatch(line, new RegExp(`"${A.brokerageId}"`), `failure series carries this brokerage id: ${line}`);
  }

  const [cursor] = await db.select().from(growSignalSweepCursors).where(eq(growSignalSweepCursors.brokerageId, A.brokerageId));
  assert.equal(cursor, undefined, "a failed cursor touch leaves last_evaluated_at unstamped");
  const [run] = await db.select().from(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, firstRunId));
  assert.equal(run.status, "COMPLETED");
});

test("H-4 — a healthy brokerage pass raises neither per-brokerage alert", async () => {
  const result = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
  assert.equal(result.summary.errors, 0);
  await settleAlerts();
  assert.deepEqual(
    captured.filter((a) => a.type === "GROW_SIGNAL_SWEEP_BROKERAGE_FAILED" || a.type === "GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED"),
    [],
  );
});

test("H-4 — the brokerage and cursor-touch alert policies match GROW_SIGNAL_SWEEP_UNHEALTHY", () => {
  const h1 = OPERATIONAL_ALERT_POLICIES.GROW_SIGNAL_SWEEP_UNHEALTHY;
  assert.deepEqual(OPERATIONAL_ALERT_POLICIES.GROW_SIGNAL_SWEEP_BROKERAGE_FAILED, h1);
  assert.deepEqual(OPERATIONAL_ALERT_POLICIES.GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED, h1);
});

/* Keeps the unused-fixture linting honest: these exist so the brokerage has
 * real rows to sweep rather than being an empty tenant. */
test("fixture sanity — the test brokerage is sweepable", async () => {
  const [party] = await db.insert(parties).values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Ops", lastName: "Fixture" }).returning({ id: parties.id });
  const [property] = await db
    .insert(properties)
    .values({ brokerageId: A.brokerageId, agentId: A.admin.user.id, formattedAddress: `1 Ops Health St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  assert.ok(party.id > 0 && property.id > 0);
  const result = await sweepExclusively({ brokerageIds: [A.brokerageId], force: true });
});
