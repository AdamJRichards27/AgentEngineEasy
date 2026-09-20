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
import { db, growSignalSweepRuns, parties, properties } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import {
  runSignalSweep,
  tryHoldSignalSweepLockForTests,
  resetSweepResumePointForTests,
  getSweepOpsHealth,
  sweepConfig,
  LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS,
} from "../sweep.js";
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
  await clearRunningRows();
  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release, "the lock must be free at the start of this test");
  try {
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
  await clearRunningRows();
  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release, "the lock must be free at the start of this test");
  try {
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
  await clearRunningRows();
  const [runningRow] = await db.insert(growSignalSweepRuns).values({ status: "RUNNING", trigger: "SCHEDULED" }).returning();
  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release);
  try {
    for (let attempt = 0; attempt < LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS + 2; attempt += 1) {
      const refused = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
      assert.equal(refused.ok, false);
    }
    await settleAlerts();
  } finally {
    await release();
    await db.delete(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, runningRow.id));
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
  await clearRunningRows();
  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release);
  try {
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
  await clearRunningRows();
  const release = await tryHoldSignalSweepLockForTests();
  assert.ok(release);
  try {
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
  const result = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId], force: true });
  assert.equal(result.ok, true);

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
});

test("H-3 — lastCompletedAt is derived from a real COMPLETED row, not from the five-row recentRuns window", async () => {
  // The distinction this asserts: with the five most recent runs ALL non-
  // COMPLETED, a health check that scanned only recentRuns would wrongly
  // report "never completed" on a system that has completed sweeps.
  await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId] });
  const withCompletion = await getSweepOpsHealth();
  assert.notEqual(withCompletion.lastCompletedAt, null);

  const noise = [];
  for (let i = 0; i < 6; i += 1) {
    const [row] = await db.insert(growSignalSweepRuns).values({ status: "FAILED", trigger: "SCHEDULED", completedAt: new Date() }).returning();
    noise.push(row.id);
  }
  try {
    const health = await getSweepOpsHealth();
    assert.ok(health.recentRuns.every((r) => r.status === "FAILED"), "the recentRuns window is now entirely FAILED rows");
    assert.notEqual(health.lastCompletedAt, null, "lastCompletedAt must still find the real completion behind the window");
  } finally {
    for (const id of noise) await db.delete(growSignalSweepRuns).where(eq(growSignalSweepRuns.id, id));
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

/* Keeps the unused-fixture linting honest: these exist so the brokerage has
 * real rows to sweep rather than being an empty tenant. */
test("fixture sanity — the test brokerage is sweepable", async () => {
  const [party] = await db.insert(parties).values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Ops", lastName: "Fixture" }).returning({ id: parties.id });
  const [property] = await db
    .insert(properties)
    .values({ brokerageId: A.brokerageId, agentId: A.admin.user.id, formattedAddress: `1 Ops Health St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  assert.ok(party.id > 0 && property.id > 0);
  const result = await runSignalSweep("MANUAL", { brokerageIds: [A.brokerageId], force: true });
  assert.equal(result.ok, true);
});
