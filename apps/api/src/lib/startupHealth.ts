/**
 * AE GROW Pilot Readiness WP2a — boot-task health for readiness.
 *
 * Some boot-time seeds (entitlement catalogue, run.access backfill) run
 * fire-and-forget so a slow database never blocks boot. Previously a failure
 * was only logged, so an instance with a broken entitlement catalogue kept
 * reporting ready while denying or mis-granting entitlements. Failures are
 * now recorded here, alerted, and surfaced by GET /api/health/ready
 * (routes/health.ts) as "unavailable". Boot itself is never aborted.
 *
 * Independent-review remediation: a boot task is now RETRIED, bounded, with
 * backoff, before it is allowed to mark the instance not-ready.
 *
 * Why: the pilot runbook requires a single always-on instance, and a failed
 * boot seed marked readiness failed FOREVER with no retry. One transient
 * database blip during boot — a connection refused while Postgres was still
 * starting, a momentary pool exhaustion — therefore took the only pilot
 * instance out of rotation permanently until a human noticed and restarted
 * it. That is a far more likely outage than the fault the readiness signal
 * was added to catch.
 *
 * The shape now:
 *   - a task is attempted up to STARTUP_TASK_RETRY_DELAYS_MS.length + 1
 *     times, sleeping the matching backoff between attempts;
 *   - intermediate failures are logged (warn) and nothing is marked: the task
 *     is simply still running, exactly as it already was during its first
 *     attempt, so readiness is unchanged while a transient fault heals;
 *   - only when every attempt has failed is the failure recorded, alerted,
 *     and readiness blocked — a genuine failure still takes the instance out
 *     of rotation, with the same alert as before;
 *   - a success at ANY attempt clears a recorded failure for that task
 *     (recordStartupTaskSuccess), so a later retry can also heal a failure
 *     recorded earlier in this process's life.
 */
import { logger } from "@aee/events";
import { dispatchOperationalAlert } from "./operationalAlerts.js";

const failedStartupTasks = new Map<string, string>();

/**
 * Backoff between boot-task attempts. Its length is the number of RETRIES
 * (total attempts = length + 1). Bounded and short: this is covering a
 * database that is still coming up, not an outage to sit through — the whole
 * sequence finishes inside ~47s, after which a genuine failure is reported.
 */
export const STARTUP_TASK_RETRY_DELAYS_MS: readonly number[] = [2_000, 15_000, 30_000];

export interface RunTrackedStartupTaskOptions {
  /** Overrides the backoff schedule (and therefore the attempt count). */
  retryDelaysMs?: readonly number[];
  /** Injectable timer, so tests do not have to wait out the real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open just because a retry is pending.
    if (typeof timer.unref === "function") timer.unref();
  });
}

export function recordStartupTaskFailure(task: string, err: unknown): Promise<unknown> {
  failedStartupTasks.set(task, new Date().toISOString());
  logger.error("boot_startup_task_failed", {
    task,
    error: err instanceof Error ? err.message : String(err),
    readinessBlocked: true,
  });
  return dispatchOperationalAlert({
    type: "DB_READINESS_FAILURE",
    summary: `Startup task failed: ${task} — instance reports not-ready`,
    dedupKey: `startup-task:${task}`,
    details: { task },
  }).catch(() => undefined);
}

export function recordStartupTaskSuccess(task: string): void {
  failedStartupTasks.delete(task);
}

/** Names of boot tasks currently failed; empty when all succeeded (or are still running/retrying). */
export function failedStartupTaskNames(): string[] {
  return [...failedStartupTasks.keys()].sort();
}

/**
 * Runs a fire-and-forget boot task, retrying a bounded number of times before
 * recording its failure for readiness (see the module comment). Never rejects.
 */
export async function runTrackedStartupTask(
  task: string,
  run: () => Promise<unknown>,
  options: RunTrackedStartupTaskOptions = {},
): Promise<void> {
  const delays = options.retryDelaysMs ?? STARTUP_TASK_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await run();
      // Clears any failure recorded for this task, including one recorded by
      // an earlier exhausted run — a task that later succeeds must be able to
      // put the instance back into rotation.
      const wasFailed = failedStartupTasks.has(task);
      recordStartupTaskSuccess(task);
      if (attempt > 1 || wasFailed) {
        logger.info("boot_startup_task_recovered", { task, attempt, readinessBlocked: false });
      }
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryDelayMs = delays[attempt - 1];
      if (retryDelayMs === undefined) {
        // Every attempt failed: this is no longer plausibly transient.
        await recordStartupTaskFailure(task, err);
        return;
      }
      logger.warn("boot_startup_task_retrying", {
        task,
        attempt,
        attemptsRemaining: delays.length - attempt + 1,
        retryDelayMs,
        error: message,
      });
      await sleep(retryDelayMs);
    }
  }
}

export function __resetStartupHealthForTesting(): void {
  failedStartupTasks.clear();
}
