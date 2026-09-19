/**
 * AE GROW Pilot Readiness WP2a — boot-task health for readiness.
 *
 * Some boot-time seeds (entitlement catalogue, run.access backfill) run
 * fire-and-forget so a slow database never blocks boot. Previously a failure
 * was only logged, so an instance with a broken entitlement catalogue kept
 * reporting ready while denying or mis-granting entitlements. Failures are
 * now recorded here, alerted, and surfaced by GET /api/health/ready
 * (routes/health.ts) as "unavailable" (these tasks are not retried in-process,
 * so the instance stays not-ready until it is restarted and the task
 * succeeds). Boot itself is never aborted.
 */
import { logger } from "@aee/events";
import { dispatchOperationalAlert } from "./operationalAlerts.js";

const failedStartupTasks = new Map<string, string>();

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

/** Names of boot tasks currently failed; empty when all succeeded (or are still running). */
export function failedStartupTaskNames(): string[] {
  return [...failedStartupTasks.keys()].sort();
}

/**
 * Runs a fire-and-forget boot task, recording its outcome for readiness.
 * Never rejects.
 */
export function runTrackedStartupTask(task: string, run: () => Promise<unknown>): Promise<void> {
  return run().then(
    () => {
      recordStartupTaskSuccess(task);
    },
    async (err: unknown) => {
      await recordStartupTaskFailure(task, err);
    },
  );
}

export function __resetStartupHealthForTesting(): void {
  failedStartupTasks.clear();
}
