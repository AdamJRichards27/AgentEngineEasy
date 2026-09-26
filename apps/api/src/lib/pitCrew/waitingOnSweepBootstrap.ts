import { incrementCounter, logger, observeHistogram } from "@aee/events";
import { dispatchOperationalAlert } from "../operationalAlerts.js";
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
 * The scheduled path emits four bounded metrics
 * (pit_crew_waiting_on_sweep_tick_total,
 * pit_crew_waiting_on_sweep_tick_duration_ms,
 * pit_crew_waiting_on_sweep_brokerage_total,
 * pit_crew_waiting_on_sweep_item_total). It pages operations only when the
 * sweep itself fails PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES
 * (3) ticks in a row. It never alerts, escalates, reassigns, or contacts
 * anyone about an overdue item. The flag stays default off, so nothing can
 * fire until the Owner enables the sweep. Surfacing for a person is still a
 * log line plus the internal read GET /pit-crew/ops/waiting-on/detections.
 *
 * The in-app read is GET /pit-crew/ops/waiting-on/health (R-F7). It reports
 * this process's last tick and the caller's own settings. Rate-of-absence
 * alerting still needs an external rule engine.
 */

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS;
export const PIT_CREW_WAITING_ON_SWEEP_MIN_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS;
export const PIT_CREW_WAITING_ON_SWEEP_MAX_INTERVAL_MS = PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS;

/** Distinct brokerages considered in one tick, lowest brokerage id first. */
export const PIT_CREW_WAITING_ON_SWEEP_MAX_BROKERAGES_PER_TICK = 200;

/**
 * Same "repeated" bar as LOCK_LEAK_ALERT_AFTER_CONSECUTIVE_ORPHANED_SKIPS.
 * A code constant: not an environment variable.
 */
export const PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES = 3;

/** Brokerage ids carried on one alert. One dedup key per type, so this cap is detail, not paging volume. */
const FAILED_BROKERAGE_IDS_IN_ALERT = 20;

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
/** Ticks that threw, or finished with every considered brokerage failing. */
let consecutiveUnhealthyTicks = 0;
/** Completed ticks with at least one brokerage failure. A thrown tick does not move this. */
let consecutiveBrokerageFailureTicks = 0;

export type PitCrewWaitingOnSweepTickOutcome = "completed" | "failed" | "skipped_overlap";

/**
 * The most recent tick in this process. Job-level only: no brokerage id and
 * no per-brokerage count. durationMs is null for an overlap skip.
 */
export interface PitCrewWaitingOnSweepLastTick {
  at: string;
  outcome: PitCrewWaitingOnSweepTickOutcome;
  durationMs: number | null;
}

let lastTick: PitCrewWaitingOnSweepLastTick | null = null;
/**
 * Brokerages that failed in the last completed tick. Null until a tick
 * completes. Never returned whole. The health route answers membership for
 * the caller's id only. A thrown tick and an overlap skip do not replace it.
 */
let lastCompletedTickFailedBrokerageIds: Set<number> | null = null;

function recordLastTick(outcome: PitCrewWaitingOnSweepTickOutcome, durationMs: number | null): void {
  lastTick = { at: new Date().toISOString(), outcome, durationMs };
}

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
   * Test seam. Invoked inside the tick, before findBrokerageIdsWithOverdueWaitingOn.
   * A throw is a whole-tick failure: the function rejects, the same contract as
   * the scan itself throwing. Never passed in production.
   */
  beforeScan?: () => Promise<void> | void;
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

/** Read-only view of the in-process streaks. The health route reads the ops snapshot below. */
export function pitCrewWaitingOnSweepHealthSnapshot(): {
  consecutiveUnhealthyTicks: number;
  consecutiveBrokerageFailureTicks: number;
} {
  return { consecutiveUnhealthyTicks, consecutiveBrokerageFailureTicks };
}

export interface PitCrewWaitingOnSweepOpsSnapshot {
  enabled: boolean;
  started: boolean;
  intervalMs: number;
  lastTick: PitCrewWaitingOnSweepLastTick | null;
  consecutiveUnhealthyTicks: number;
  consecutiveBrokerageFailureTicks: number;
  alertThreshold: number;
}

/**
 * Read-only, in-process view for GET /pit-crew/ops/waiting-on/health.
 * Job-level only. The failed-brokerage set is not included.
 */
export function pitCrewWaitingOnSweepOpsSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): PitCrewWaitingOnSweepOpsSnapshot {
  const config = pitCrewWaitingOnSweepConfig(env);
  return {
    enabled: config.enabled,
    started: intervalHandle !== null,
    intervalMs: config.intervalMs,
    lastTick: lastTick === null ? null : { ...lastTick },
    consecutiveUnhealthyTicks,
    consecutiveBrokerageFailureTicks,
    alertThreshold: PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES,
  };
}

/**
 * Whether `brokerageId` failed in the last completed tick.
 * Null when no tick has completed in this process.
 */
export function pitCrewWaitingOnSweepCallerFailedLastTick(brokerageId: number): boolean | null {
  if (lastCompletedTickFailedBrokerageIds === null) return null;
  return lastCompletedTickFailedBrokerageIds.has(brokerageId);
}

function cappedFailedBrokerageIds(ids: readonly number[]): {
  failedBrokerageIds: number[];
  failedBrokerageIdsTruncated: boolean;
} {
  const sorted = [...ids].sort((left, right) => left - right);
  return {
    failedBrokerageIds: sorted.slice(0, FAILED_BROKERAGE_IDS_IN_ALERT),
    failedBrokerageIdsTruncated: sorted.length > FAILED_BROKERAGE_IDS_IN_ALERT,
  };
}

/**
 * At most one dispatch per tick. Unhealthy wins over partial brokerage
 * failures. Fire-and-forget: the real dispatcher owns cooldown, the
 * disabled short-circuit, and transport retries. A failed or slow alert
 * must not reject the tick, delay the next one, or change a row. Tests
 * stub that transport; this module does not add a second seam.
 */
function dispatchSweepHealthIfDue(input: {
  brokerages: number;
  failedBrokerages: number;
  failedBrokerageIds: readonly number[];
  /** Set only when the tick threw. Per-brokerage messages stay in the log. */
  errorMessage: string | null;
}): void {
  const threshold = PIT_CREW_WAITING_ON_SWEEP_ALERT_AFTER_CONSECUTIVE_FAILURES;
  const ids = cappedFailedBrokerageIds(input.failedBrokerageIds);
  const intervalMs = pitCrewWaitingOnSweepConfig().intervalMs;
  const shared = {
    intervalMs,
    brokerages: input.brokerages,
    failedBrokerages: input.failedBrokerages,
    failedBrokerageIds: ids.failedBrokerageIds,
    failedBrokerageIdsTruncated: ids.failedBrokerageIdsTruncated,
  };
  const alert =
    consecutiveUnhealthyTicks >= threshold
      ? {
          type: "PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY" as const,
          summary:
            input.errorMessage != null
              ? `The scheduled Pit Crew WAITING_ON detection sweep failed ${consecutiveUnhealthyTicks} ticks in a row and did not finish.`
              : `The scheduled Pit Crew WAITING_ON detection sweep failed for every considered brokerage ${consecutiveUnhealthyTicks} ticks in a row.`,
          dedupKey: "pit-crew-waiting-on-sweep:unhealthy",
          details: {
            consecutiveTicks: consecutiveUnhealthyTicks,
            ...shared,
            ...(input.errorMessage != null ? { error: input.errorMessage } : {}),
          },
        }
      : consecutiveBrokerageFailureTicks >= threshold
        ? {
            type: "PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED" as const,
            summary: `The scheduled Pit Crew WAITING_ON detection sweep has had brokerage failures on ${consecutiveBrokerageFailureTicks} consecutive completed ticks.`,
            dedupKey: "pit-crew-waiting-on-sweep:brokerage-failures",
            details: {
              consecutiveTicks: consecutiveBrokerageFailureTicks,
              ...shared,
            },
          }
        : null;
  if (!alert) return;
  void dispatchOperationalAlert(alert).catch((err) => {
    logger.error("pit_crew_waiting_on_sweep_alert_dispatch_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function noteCompletedTick(input: {
  brokerages: number;
  failedBrokerages: number;
  failedBrokerageIds: readonly number[];
}): void {
  const unhealthy = input.brokerages > 0 && input.failedBrokerages === input.brokerages;
  if (unhealthy) consecutiveUnhealthyTicks += 1;
  else consecutiveUnhealthyTicks = 0;
  if (input.failedBrokerages > 0) consecutiveBrokerageFailureTicks += 1;
  else consecutiveBrokerageFailureTicks = 0;
  lastCompletedTickFailedBrokerageIds = new Set(input.failedBrokerageIds);
  dispatchSweepHealthIfDue({ ...input, errorMessage: null });
}

function noteThrownTick(input: {
  brokerages: number;
  failedBrokerages: number;
  failedBrokerageIds: readonly number[];
  errorMessage: string;
}): void {
  consecutiveUnhealthyTicks += 1;
  dispatchSweepHealthIfDue(input);
}

function recordItemCounts(surfaced: number, deduped: number): void {
  if (surfaced > 0) incrementCounter("pit_crew_waiting_on_sweep_item_total", { outcome: "surfaced" }, surfaced);
  if (deduped > 0) incrementCounter("pit_crew_waiting_on_sweep_item_total", { outcome: "deduped" }, deduped);
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
    incrementCounter("pit_crew_waiting_on_sweep_tick_total", { outcome: "skipped_overlap" });
    recordLastTick("skipped_overlap", null);
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
  const failedBrokerageIds: number[] = [];
  let brokeragesConsidered = 0;
  let failedBrokerages = 0;
  try {
    if (options.beforeScan) await options.beforeScan();
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

    brokeragesConsidered = found.brokerageIds.length;
    let scanned = 0;
    let surfaced = 0;
    let deduped = 0;
    let skippedWindow = 0;
    let skippedCadence = 0;
    for (const brokerageId of found.brokerageIds) {
      try {
        if (options.beforeBrokerage) await options.beforeBrokerage(brokerageId);
        const settings = await loadPitCrewWaitingOnSweepSettings(brokerageId);
        if (!isWithinOperatingWindow(now, settings)) {
          skippedWindow += 1;
          incrementCounter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "skipped_window" });
          continue;
        }
        if (!isWaitingOnSweepDue(settings.lastDetectionAt, now, settings.cadenceMs)) {
          skippedCadence += 1;
          incrementCounter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "skipped_cadence" });
          continue;
        }
        const result = await recordWaitingOnDetections({ now, brokerageId, settings });
        await markPitCrewWaitingOnSweepRan(brokerageId, now);
        scanned += result.scanned;
        surfaced += result.surfaced;
        deduped += result.deduped;
        incrementCounter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "detected" });
        recordItemCounts(result.surfaced, result.deduped);
      } catch (err) {
        failedBrokerages += 1;
        failedBrokerageIds.push(brokerageId);
        incrementCounter("pit_crew_waiting_on_sweep_brokerage_total", { outcome: "failed" });
        logger.error("pit_crew_waiting_on_sweep_brokerage_failed", {
          brokerageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const durationMs = Date.now() - started;
    const summary = {
      brokerages: brokeragesConsidered,
      scanned,
      surfaced,
      deduped,
      skippedWindow,
      skippedCadence,
      failedBrokerages,
      durationMs,
    };
    logger.info("pit_crew_waiting_on_sweep_tick_completed", summary);
    incrementCounter("pit_crew_waiting_on_sweep_tick_total", { outcome: "completed" });
    observeHistogram("pit_crew_waiting_on_sweep_tick_duration_ms", durationMs, { outcome: "completed" });
    noteCompletedTick({ brokerages: brokeragesConsidered, failedBrokerages, failedBrokerageIds });
    recordLastTick("completed", durationMs);
    return { ...summary, overlapSkipped: false };
  } catch (err) {
    const durationMs = Date.now() - started;
    incrementCounter("pit_crew_waiting_on_sweep_tick_total", { outcome: "failed" });
    observeHistogram("pit_crew_waiting_on_sweep_tick_duration_ms", durationMs, { outcome: "failed" });
    noteThrownTick({
      brokerages: brokeragesConsidered,
      failedBrokerages,
      failedBrokerageIds,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    recordLastTick("failed", durationMs);
    throw err;
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
      // The tick already recorded the failure and, at the repeated-failure
      // threshold, dispatched the one alert. Do not dispatch a second one.
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
 * in-process overlap flag, both repeated-failure counters, the last-tick
 * record, and the last-completed-tick failure set.
 */
export function resetPitCrewWaitingOnSweepSchedulerForTests(): void {
  stopPitCrewWaitingOnSweepScheduler();
  registered = false;
  tickInFlight = false;
  consecutiveUnhealthyTicks = 0;
  consecutiveBrokerageFailureTicks = 0;
  lastTick = null;
  lastCompletedTickFailedBrokerageIds = null;
}
