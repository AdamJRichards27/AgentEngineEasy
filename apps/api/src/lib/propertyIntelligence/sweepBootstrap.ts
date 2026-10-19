import { logger } from "@aee/events";
import { dispatchOperationalAlert } from "../operationalAlerts.js";
import { runSignalSweep, sweepConfig, type RunSignalSweepResult } from "./sweep.js";
import { scanSchedulersOffSwitch, SCAN_SCHEDULERS_OFF_SWITCH_ENV } from "../scanSchedulerOffSwitch.js";
import { backgroundLoopDisabled } from "../restoredEnvironment.js";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — boot-time wiring.
 *
 * Follows lib/exceptions/bootstrap.ts exactly: an idempotent registration
 * latch, one guarded setInterval, and .unref() so a background best-effort
 * sweep never holds the process open or delays a graceful shutdown. This is
 * deliberately NOT a new job framework — it is the smallest thing that runs
 * one recurring job, the same judgement the exceptions scheduler documented
 * when it became the first scheduler in this codebase.
 *
 * NEVER RUNS UNDER TEST unless explicitly asked. startScheduler defaults to
 * `NODE_ENV !== "test"`, so a test process only sweeps when it calls
 * runSignalSweep() itself — no background timer can race a test's fixtures
 * or another test file's tenants.
 *
 * OPT OUT ENTIRELY with GROW_SIGNAL_SWEEP_ENABLED=false. The full list of
 * environment variables this feature introduces is documented on
 * sweepConfig() in ./sweep.ts.
 *
 * The sweep itself is single-flighted by a Postgres advisory lock, so an
 * overlapping tick (or a second API instance) is refused rather than run
 * concurrently — the interval below needs no locking of its own.
 */

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;

/**
 * One scheduled tick, with explicit observability (start / succeeded / skipped / failed). Logging only: the
 * sweep, its advisory lock and the H-1 failure alert are unchanged. `run` is injectable for tests.
 */
export async function runSignalSweepTick(run: (trigger: "SCHEDULED") => Promise<RunSignalSweepResult> = runSignalSweep): Promise<void> {
  const config = sweepConfig();
  const startedAtMs = Date.now();
  logger.info("property_signal_sweep_scheduled_tick_started", { intervalMs: config.intervalMs });
  try {
    const result = await run("SCHEDULED");
    if (result.ok) {
      logger.info("property_signal_sweep_scheduled_tick_succeeded", { durationMs: Date.now() - startedAtMs, ...result.summary });
    } else {
      logger.info("property_signal_sweep_scheduled_tick_skipped", { durationMs: Date.now() - startedAtMs, reason: result.skippedReason });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("property_signal_sweep_scheduled_run_failed", { error: message, durationMs: Date.now() - startedAtMs });
    // AE GROW Completion W1-D (H-1). This catch is the ONLY thing standing
    // between a permanently throwing scheduled sweep and total silence:
    // logger.error is not bridged to dispatchOperationalAlert (logger.ts
    // only writes JSON to stderr), and nothing else observes this timer. The
    // dedup cooldown in operationalAlerts.ts is what keeps a tick that fails
    // every interval to one alert per cooldown rather than one per tick.
    void dispatchOperationalAlert({
      type: "GROW_SIGNAL_SWEEP_UNHEALTHY",
      summary: `The scheduled Property Intelligence signal sweep threw and did not run: ${message}`,
      dedupKey: "grow-signal-sweep:scheduled-run-failed",
      details: { intervalMs: config.intervalMs, error: message },
    }).catch((alertErr) =>
      logger.error("property_signal_sweep_alert_dispatch_failed", { error: alertErr instanceof Error ? alertErr.message : String(alertErr) }),
    );
  }
}

export interface RegisterSignalSweepOptions {
  /** Set false in tests / one-off scripts that call runSignalSweep() explicitly and must not also have a background timer running. Defaults to NODE_ENV !== "test". */
  startScheduler?: boolean;
}

export type SignalSweepStartDecision = { start: true } | { start: false; reason: "off_switch" | "option" | "sweep_disabled_or_test_env" };

/**
 * WS4: whether the sweep timer should start. AEE_DISABLE_SCAN_SCHEDULERS (see ../scanSchedulerOffSwitch.ts) wins over
 * everything, including an explicit startScheduler: true. Otherwise unchanged: the option if given, else
 * GROW_SIGNAL_SWEEP_ENABLED !== "false" (the same rule as sweepConfig().enabled) and NODE_ENV !== "test".
 */
export function resolveSignalSweepStart(
  options: RegisterSignalSweepOptions = {},
  env: Record<string, string | undefined> = process.env,
): SignalSweepStartDecision {
  if (scanSchedulersOffSwitch(env).disabled) return { start: false, reason: "off_switch" };
  if (options.startScheduler !== undefined) return options.startScheduler ? { start: true } : { start: false, reason: "option" };
  const enabled = env.GROW_SIGNAL_SWEEP_ENABLED !== "false";
  return enabled && env.NODE_ENV !== "test" ? { start: true } : { start: false, reason: "sweep_disabled_or_test_env" };
}

/** Call once at boot, alongside registerExceptionEngine() (apps/api/src/index.ts). Idempotent. */
export function registerSignalSweep(options: RegisterSignalSweepOptions = {}): void {
  if (registered) return;
  registered = true;

  const config = sweepConfig();
  // WS4-07/WS4-08: AEE_RESTORED_ENVIRONMENT (lib/restoredEnvironment.ts) is the superset switch and is checked first;
  // the WS4-05 AEE_DISABLE_SCAN_SCHEDULERS off-switch (resolve*Start below) remains as a scan-loops-only subset.
  if (backgroundLoopDisabled("signal_sweep")) return;
  const decision = resolveSignalSweepStart(options);
  if (!decision.start) {
    logger.info("property_signal_sweep_scheduler_disabled", {
      enabled: config.enabled,
      nodeEnv: process.env.NODE_ENV ?? null,
      reason: decision.reason,
      ...(decision.reason === "off_switch" ? { offSwitchEnv: SCAN_SCHEDULERS_OFF_SWITCH_ENV, offSwitch: scanSchedulersOffSwitch().reason } : {}),
    });
    return;
  }

  intervalHandle = setInterval(() => {
    void runSignalSweepTick();
  }, config.intervalMs);
  intervalHandle.unref?.();

  logger.info("property_signal_sweep_scheduler_started", { intervalMs: config.intervalMs, maxBrokerages: config.maxBrokerages, maxCandidatesPerBrokerage: config.maxCandidatesPerBrokerage });
}

/** Test-only escape hatch — stops the interval so a test process can exit cleanly. Registration state is not reset (mirrors registerExceptionEngine's permanent latch). */
export function stopSignalSweepScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
