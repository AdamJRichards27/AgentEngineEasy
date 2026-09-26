import { logger } from "@aee/events";
import { findBrokerageIdsWithOverdueWaitingOn } from "./assignment.js";
import { recordWaitingOnDetections } from "./waitingOnDetectionRun.js";
import {
  PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS,
  PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS,
  PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS,
  isWaitingOnSweepDue,
  isWithinOperatingWindow,
} from "./waitingOnDetection.js";
import { loadPitCrewWaitingOnSweepSettings, markPitCrewWaitingOnSweepRan } from "./waitingOnSweepSettings.js";

/**
 * R-F5 — boot-time wiring for the Pit Crew WAITING_ON detection sweep.
 *
 * Follows lib/propertyIntelligence/sweepBootstrap.ts and
 * lib/exceptions/bootstrap.ts: an idempotent registration latch, one guarded
 * setInterval, and .unref() so a background sweep never holds the process
 * open. This is deliberately NOT a job framework.
 *
 * OPT-IN, DEFAULT OFF. PIT_CREW_WAITING_ON_SWEEP_ENABLED must be the literal
 * string "true". startScheduler defaults to
 * (config.enabled && NODE_ENV !== "test"), so a test process only sweeps
 * when it calls runScheduledWaitingOnSweep() itself.
 *
 * The scheduled path identifies, classifies, sorts, and surfaces overdue
 * WAITING_ON items. It does not call sweepOverdueWaitingOn, so it does not
 * return rows to IN_PROGRESS, reassign them, or write a PC_WAITING_ON_RETURNED
 * audit. The human POST /pit-crew/ops/waiting-on/sweep route still does.
 *
 * No Postgres advisory lock. An in-process overlap guard skips a second tick
 * in this process while the previous one is still running. Repeat alerts are
 * suppressed by the sighting fingerprint, not by mutating the assignment.
 *
 * This slice does not emit a metric and does not raise an operational alert
 * (those webhooks can leave the process). Surfacing is a log line plus the
 * internal read GET /pit-crew/ops/waiting-on/detections.
 *
 * Follow-ups: operational alert on repeated tick failure; sweep metric.
 */

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS;
export const PIT_CREW_WAITING_ON_SWEEP_MIN_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS;
export const PIT_CREW_WAITING_ON_SWEEP_MAX_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS;

/** Distinct brokerages considered in one tick, lowest brokerage id first. */
export const PIT_CREW_WAITING_ON_SWEEP_MAX_BROKERAGES_PER_TICK = 200;

export interface PitCrewWaitingOnSweepConfig {
  enabled: boolean;
  intervalMs: number;
}

/**
 * Pure aside from the warning logged when the interval is non-numeric.
 * Enabled only for the literal string "true".
 *
 * intervalMs is the process wake. Per-brokerage cadence, window, and tier
 * thresholds live on pit_crew_waiting_on_sweep_settings and default to the
 * same 30 minutes, Mon–Fri 08:00–18:00 local, and 2h/4h tiers.
 */
export function pitCrewWaitingOnSweepConfig(env: NodeJS.ProcessEnv = process.env): PitCrewWaitingOnSweepConfig {
  return {
    enabled: env.PIT_CREW_WAITING_ON_SWEEP_ENABLED === "true",
    intervalMs: readIntervalMs(env.PIT_CREW_WAITING_ON_SWEEP_INTERVAL_MS),
  };
}

function readIntervalMs(raw: string | undefined): number {
  if (raw == null) return PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS;
  const trimmed = raw.trim();
  if (trimmed === "") return PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS;
  if (!/^-?\d+$/.test(trimmed)) {
    logger.warn("pit_crew_waiting_on_sweep_interval_invalid", {
      value: raw,
      fallbackMs: PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS,
    });
    return PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS;
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) {
    logger.warn("pit_crew_waiting_on_sweep_interval_invalid", {
      value: raw,
      fallbackMs: PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS,
    });
    return PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS;
  }
  if (parsed < PIT_CREW_WAITING_ON_SWEEP_MIN_INTERVAL_MS) return PIT_CREW_WAITING_ON_SWEEP_MIN_INTERVAL_MS;
  if (parsed > PIT_CREW_WAITING_ON_SWEEP_MAX_INTERVAL_MS) return PIT_CREW_WAITING_ON_SWEEP_MAX_INTERVAL_MS;
  return parsed;
}

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;
let tickInFlight = false;

export interface RegisterPitCrewWaitingOnSweepOptions {
  /** Set false to register without arming the timer. Defaults to (enabled && NODE_ENV !== "test"). */
  startScheduler?: boolean;
}

export interface RunScheduledWaitingOnSweepOptions {
  /**
   * Test seam. Invoked after a brokerage is selected and before its detection.
   * A throw is that brokerage's failure: it is logged and the tick continues
   * with the remaining brokerages.
   */
  beforeBrokerage?: (brokerageId: number) => Promise<void> | void;
  /**
   * Restrict the tick to these brokerages. Omitted on the scheduler path,
   * which considers every brokerage with an overdue row. Tests pass their
   * own tenants so a shared database is not swept.
   */
  brokerageIds?: readonly number[];
  /** Overrides the per-tick brokerage cap. Production uses the default of 200. */
  maxBrokerages?: number;
}

export interface WaitingOnSweepTickResult {
  brokerages: number;
  scanned: number;
  surfaced: number;
  deduped: number;
  skippedWindow: number;
  skippedCadence: number;
  failedBrokerages: number;
  durationMs: number;
  /** True when this call did not sweep because the previous tick is still running. */
  overlapSkipped: boolean;
}

/**
 * One scheduler tick. Detection and prioritisation only. Does not return
 * WAITING_ON rows to IN_PROGRESS and does not write an audit row.
 */
export async function runScheduledWaitingOnSweep(
  now: Date = new Date(),
  options: RunScheduledWaitingOnSweepOptions = {},
): Promise<WaitingOnSweepTickResult> {
  if (tickInFlight) {
    logger.info("pit_crew_waiting_on_sweep_tick_skipped_overlap");
    return {
      brokerages: 0,
      scanned: 0,
      surfaced: 0,
      deduped: 0,
      skippedWindow: 0,
      skippedCadence: 0,
      failedBrokerages: 0,
      durationMs: 0,
      overlapSkipped: true,
    };
  }
  tickInFlight = true;
  const started = Date.now();
  try {
    const cap =
      options.maxBrokerages != null && Number.isInteger(options.maxBrokerages) && options.maxBrokerages > 0
        ? options.maxBrokerages
        : PIT_CREW_WAITING_ON_SWEEP_MAX_BROKERAGES_PER_TICK;
    const found = await findBrokerageIdsWithOverdueWaitingOn(now, {
      limit: cap,
      brokerageIds: options.brokerageIds,
    });
    if (found.truncated) {
      logger.warn("pit_crew_waiting_on_sweep_brokerages_truncated", { cap });
    }

    let scanned = 0;
    let surfaced = 0;
    let deduped = 0;
    let skippedWindow = 0;
    let skippedCadence = 0;
    let failedBrokerages = 0;
    for (const brokerageId of found.brokerageIds) {
      try {
        if (options.beforeBrokerage) await options.beforeBrokerage(brokerageId);
        const settings = await loadPitCrewWaitingOnSweepSettings(brokerageId);
        if (!isWithinOperatingWindow(now, settings)) {
          skippedWindow += 1;
          continue;
        }
        if (!isWaitingOnSweepDue(settings.lastDetectionAt, now, settings.cadenceMs)) {
          skippedCadence += 1;
          continue;
        }
        const result = await recordWaitingOnDetections({ now, brokerageId, settings });
        await markPitCrewWaitingOnSweepRan(brokerageId, now);
        scanned += result.scanned;
        surfaced += result.surfaced;
        deduped += result.deduped;
      } catch (err) {
        failedBrokerages += 1;
        logger.error("pit_crew_waiting_on_sweep_brokerage_failed", {
          brokerageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = {
      brokerages: found.brokerageIds.length,
      scanned,
      surfaced,
      deduped,
      skippedWindow,
      skippedCadence,
      failedBrokerages,
      durationMs: Date.now() - started,
    };
    logger.info("pit_crew_waiting_on_sweep_tick_completed", summary);
    return { ...summary, overlapSkipped: false };
  } finally {
    tickInFlight = false;
  }
}

/** Call once at boot, next to registerSignalSweep() (apps/api/src/index.ts). Idempotent. */
export function registerPitCrewWaitingOnSweep(options: RegisterPitCrewWaitingOnSweepOptions = {}): void {
  if (registered) return;
  registered = true;

  const config = pitCrewWaitingOnSweepConfig();
  const startScheduler = options.startScheduler ?? (config.enabled && process.env.NODE_ENV !== "test");
  if (!startScheduler) {
    logger.info("pit_crew_waiting_on_sweep_scheduler_disabled", {
      enabled: config.enabled,
      nodeEnv: process.env.NODE_ENV ?? null,
    });
    return;
  }

  intervalHandle = setInterval(() => {
    runScheduledWaitingOnSweep().catch((err) => {
      logger.error("pit_crew_waiting_on_sweep_scheduled_run_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, config.intervalMs);
  intervalHandle.unref?.();

  logger.info("pit_crew_waiting_on_sweep_scheduler_started", { intervalMs: config.intervalMs });
}

/** Test-only escape hatch — stops the interval so a test process can exit cleanly. Registration state is not reset. */
export function stopPitCrewWaitingOnSweepScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Test-only. stopPitCrewWaitingOnSweepScheduler does not clear the latch;
 * this does, so a suite can register more than once. Also clears a stuck
 * in-process overlap flag.
 */
export function resetPitCrewWaitingOnSweepSchedulerForTests(): void {
  stopPitCrewWaitingOnSweepScheduler();
  registered = false;
  tickInFlight = false;
}
