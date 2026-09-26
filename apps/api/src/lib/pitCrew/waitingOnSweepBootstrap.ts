import { logger } from "@aee/events";
import {
  findBrokerageIdsWithOverdueWaitingOn,
  sweepOverdueWaitingOn,
} from "./assignment.js";

/**
 * R-F4 — boot-time wiring for the Pit Crew WAITING_ON expected-at sweep.
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
 * No Postgres advisory lock. An in-process overlap guard skips a second tick
 * in this process while the previous one is still running. Across processes,
 * correctness is the existing optimistic version check inside
 * sweepOverdueWaitingOn: the loser is counted as skipped. That differs from
 * H-5's reconcilers, which serialise with advisory locks.
 *
 * This slice does not emit a metric and does not raise an operational alert.
 * Follow-ups: operational alert on repeated tick failure; sweep metric.
 */

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS = 900_000;
export const PIT_CREW_WAITING_ON_SWEEP_MIN_INTERVAL_MS = 60_000;
export const PIT_CREW_WAITING_ON_SWEEP_MAX_INTERVAL_MS = 86_400_000;

/** Distinct brokerages swept in one tick, lowest brokerage id first. */
export const PIT_CREW_WAITING_ON_SWEEP_MAX_BROKERAGES_PER_TICK = 200;

export interface PitCrewWaitingOnSweepConfig {
  enabled: boolean;
  intervalMs: number;
}

/**
 * Pure aside from the warning logged when the interval is non-numeric.
 * Enabled only for the literal string "true".
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
   * Test seam. Invoked after a brokerage is selected and before its sweep.
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
  returned: number;
  skipped: number;
  failedBrokerages: number;
  durationMs: number;
  /** True when this call did not sweep because the previous tick is still running. */
  overlapSkipped: boolean;
}

/**
 * One scheduler tick. No actor is passed, so each returned row is audited as
 * PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL with a null user id.
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
      returned: 0,
      skipped: 0,
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
    let returned = 0;
    let skipped = 0;
    let failedBrokerages = 0;
    for (const brokerageId of found.brokerageIds) {
      try {
        if (options.beforeBrokerage) await options.beforeBrokerage(brokerageId);
        // No actor. The ops identity from #106 is what a scheduler tick uses.
        const result = await sweepOverdueWaitingOn({ now, brokerageId });
        scanned += result.scanned;
        returned += result.returned;
        skipped += result.skipped;
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
      returned,
      skipped,
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
