// AE GROW Pilot Readiness — boot-task readiness, with bounded retry.
//
// Independent-review remediation: a failed boot seed used to mark readiness
// failed forever with no retry, so one transient database blip at boot took
// the single always-on pilot instance permanently out of rotation. These
// tests pin the corrected contract:
//   - a task that fails then succeeds inside its retry budget never blocks
//     readiness and never alerts;
//   - a task that fails every attempt still blocks readiness AND still
//     alerts (the signal the readiness check exists for is unchanged);
//   - a later success clears a failure already recorded;
//   - the retry budget is bounded (the task is not attempted forever).
//
// The backoff timer is injected, so these run in milliseconds rather than
// waiting out the real schedule.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  STARTUP_TASK_RETRY_DELAYS_MS,
  __resetStartupHealthForTesting,
  failedStartupTaskNames,
  recordStartupTaskFailure,
  recordStartupTaskSuccess,
  runTrackedStartupTask,
} from "../startupHealth.js";
import {
  __resetOperationalAlertsForTesting,
  __setOperationalAlertTransportForTesting,
} from "../operationalAlerts.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  __resetStartupHealthForTesting();
  __resetOperationalAlertsForTesting();
});

/** Enables the webhook alert provider and captures every dispatched alert. */
function captureAlerts(): { summaries: string[] } {
  process.env.OPERATIONAL_ALERTS_ENABLED = "true";
  process.env.OPERATIONAL_ALERTS_PROVIDER = "webhook";
  process.env.OPERATIONAL_ALERTS_WEBHOOK_URL = "https://alerts.example.invalid/events";
  process.env.OPERATIONAL_ALERTS_TOKEN = "test-token-at-least-sixteen-characters";
  const captured: { summaries: string[] } = { summaries: [] };
  __setOperationalAlertTransportForTesting(async (_url, _token, envelope) => {
    captured.summaries.push(envelope.summary);
    return 204;
  });
  return captured;
}

/** An injected sleep that records what it was asked to wait, and waits nothing. */
function fakeSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

test("a transient boot failure self-heals: a task that succeeds on a later attempt never blocks readiness and never alerts", async () => {
  const alerts = captureAlerts();
  const { delays, sleep } = fakeSleep();
  let attempts = 0;

  await runTrackedStartupTask(
    "transient_seed",
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNREFUSED: the database is still starting");
      return undefined;
    },
    { retryDelaysMs: [10, 20, 30], sleep },
  );

  assert.equal(attempts, 3, "the task must be retried until it succeeds, within budget");
  assert.deepEqual(delays, [10, 20], "each retry waits its scheduled backoff");
  assert.deepEqual(failedStartupTaskNames(), [], "a healed transient failure must not leave the instance not-ready");
  assert.deepEqual(alerts.summaries, [], "a healed transient failure must not page anyone");
});

test("a genuine boot failure still marks the instance not-ready and still alerts, after a bounded number of attempts", async () => {
  const alerts = captureAlerts();
  const { delays, sleep } = fakeSleep();
  let attempts = 0;

  await runTrackedStartupTask(
    "broken_seed",
    async () => {
      attempts += 1;
      throw new Error("relation \"entitlement_catalogue\" does not exist");
    },
    { retryDelaysMs: [1, 2], sleep },
  );

  assert.equal(attempts, 3, "attempts = retries + 1, and then it stops (bounded, not a retry loop)");
  assert.deepEqual(delays, [1, 2]);
  assert.deepEqual(failedStartupTaskNames(), ["broken_seed"], "a genuine failure must still block readiness");
  assert.equal(alerts.summaries.length, 1, "the operational alert is kept");
  assert.match(alerts.summaries[0], /broken_seed/);
  assert.match(alerts.summaries[0], /not-ready/);
});

test("runTrackedStartupTask never rejects, even when every attempt throws", async () => {
  captureAlerts();
  const { sleep } = fakeSleep();
  await runTrackedStartupTask("never_rejects", async () => {
    throw new Error("boom");
  }, { retryDelaysMs: [1], sleep });
  assert.deepEqual(failedStartupTaskNames(), ["never_rejects"]);
});

test("a later success clears a failure that was already recorded", async () => {
  captureAlerts();
  const { sleep } = fakeSleep();

  await runTrackedStartupTask("recovering_seed", async () => {
    throw new Error("transient");
  }, { retryDelaysMs: [], sleep });
  assert.deepEqual(failedStartupTaskNames(), ["recovering_seed"], "exhausted on the first pass");

  await runTrackedStartupTask("recovering_seed", async () => undefined, { retryDelaysMs: [], sleep });
  assert.deepEqual(failedStartupTaskNames(), [], "a subsequent successful run puts the instance back in rotation");
});

test("a task that succeeds first time is attempted exactly once and never sleeps", async () => {
  const alerts = captureAlerts();
  const { delays, sleep } = fakeSleep();
  let attempts = 0;
  await runTrackedStartupTask("healthy_seed", async () => {
    attempts += 1;
  }, { sleep });
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
  assert.deepEqual(failedStartupTaskNames(), []);
  assert.deepEqual(alerts.summaries, []);
});

test("the default retry schedule is bounded and short enough for a boot path", () => {
  assert.ok(STARTUP_TASK_RETRY_DELAYS_MS.length > 0, "there must be at least one retry");
  assert.ok(STARTUP_TASK_RETRY_DELAYS_MS.length <= 5, "the retry budget must stay bounded");
  const total = STARTUP_TASK_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
  assert.ok(total <= 120_000, `the whole retry sequence must finish inside two minutes, got ${total}ms`);
  for (let i = 1; i < STARTUP_TASK_RETRY_DELAYS_MS.length; i += 1) {
    assert.ok(STARTUP_TASK_RETRY_DELAYS_MS[i] > STARTUP_TASK_RETRY_DELAYS_MS[i - 1], "the backoff must increase");
  }
});

test("the direct record/clear seams used by routes/health.ts are unchanged", async () => {
  captureAlerts();
  await recordStartupTaskFailure("direct_task", new Error("nope"));
  assert.deepEqual(failedStartupTaskNames(), ["direct_task"]);
  recordStartupTaskSuccess("direct_task");
  assert.deepEqual(failedStartupTaskNames(), []);
});
