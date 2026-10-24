// WS4 follow-up: staleness of the background schedulers, for an external monitor.
//
// Publishes scheduler_last_success_age_seconds{job} at scrape time (called from sampleQueueGauges, so it is served
// by the existing token-authenticated GET /api/internal/metrics; no route change). Value = whole seconds since the
// most recent COMPLETED run's completed_at, or -1 when the job has never completed or the read failed (logged as
// scheduler_staleness_sample_failed). A monitor should alert on `< 0` as well as on an age above its threshold, e.g.
// exception_scan > 2700 (3 x the 15-minute interval) and signal_sweep > 3 x its configured interval.
//
// Reads use the same "latest COMPLETED by completed_at" query the sweep's own ops health uses (sweep.ts
// getSweepOpsHealth), through drizzle so timestamps are interpreted exactly as they were written.

import { desc, eq } from "drizzle-orm";
import { db, riskExceptionScanRuns, growSignalSweepRuns } from "@aee/db";
import { setGauge, logger } from "@aee/events";

export type SchedulerJob = "exception_scan" | "signal_sweep";
export const SCHEDULER_JOBS: readonly SchedulerJob[] = ["exception_scan", "signal_sweep"];
export type LastSuccessfulRuns = Record<SchedulerJob, Date | null>;

export interface SchedulerStalenessEntry {
  job: SchedulerJob;
  lastSuccessAt: string | null;
  ageSeconds: number | null;
}

export async function readLastSuccessfulSchedulerRuns(): Promise<LastSuccessfulRuns> {
  const [scan, sweep] = await Promise.all([
    db
      .select({ completedAt: riskExceptionScanRuns.completedAt })
      .from(riskExceptionScanRuns)
      .where(eq(riskExceptionScanRuns.status, "COMPLETED"))
      .orderBy(desc(riskExceptionScanRuns.completedAt))
      .limit(1),
    db
      .select({ completedAt: growSignalSweepRuns.completedAt })
      .from(growSignalSweepRuns)
      .where(eq(growSignalSweepRuns.status, "COMPLETED"))
      .orderBy(desc(growSignalSweepRuns.completedAt))
      .limit(1),
  ]);
  return { exception_scan: scan[0]?.completedAt ?? null, signal_sweep: sweep[0]?.completedAt ?? null };
}

export function computeSchedulerStaleness(last: LastSuccessfulRuns, now: Date = new Date()): SchedulerStalenessEntry[] {
  return SCHEDULER_JOBS.map((job) => {
    const at = last[job];
    return {
      job,
      lastSuccessAt: at ? at.toISOString() : null,
      ageSeconds: at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000)) : null,
    };
  });
}

/** Scrape-time sampler. Never throws: a failed read publishes -1 for every job and logs. */
export async function sampleSchedulerStalenessGauges(
  now: Date = new Date(),
  read: () => Promise<LastSuccessfulRuns> = readLastSuccessfulSchedulerRuns,
): Promise<void> {
  let entries: SchedulerStalenessEntry[];
  try {
    entries = computeSchedulerStaleness(await read(), now);
  } catch (err) {
    logger.error("scheduler_staleness_sample_failed", { error: err });
    entries = SCHEDULER_JOBS.map((job) => ({ job, lastSuccessAt: null, ageSeconds: null }));
  }
  for (const e of entries) setGauge("scheduler_last_success_age_seconds", e.ageSeconds ?? -1, { job: e.job });
}
