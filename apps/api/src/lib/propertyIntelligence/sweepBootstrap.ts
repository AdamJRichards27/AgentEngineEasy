import { logger } from "@aee/events";
import { runSignalSweep, sweepConfig } from "./sweep.js";

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

export interface RegisterSignalSweepOptions {
  /** Set false in tests / one-off scripts that call runSignalSweep() explicitly and must not also have a background timer running. Defaults to NODE_ENV !== "test". */
  startScheduler?: boolean;
}

/** Call once at boot, alongside registerExceptionEngine() (apps/api/src/index.ts). Idempotent. */
export function registerSignalSweep(options: RegisterSignalSweepOptions = {}): void {
  if (registered) return;
  registered = true;

  const config = sweepConfig();
  const startScheduler = options.startScheduler ?? (config.enabled && process.env.NODE_ENV !== "test");
  if (!startScheduler) {
    logger.info("property_signal_sweep_scheduler_disabled", { enabled: config.enabled, nodeEnv: process.env.NODE_ENV ?? null });
    return;
  }

  intervalHandle = setInterval(() => {
    runSignalSweep("SCHEDULED").catch((err) => logger.error("property_signal_sweep_scheduled_run_failed", { error: err instanceof Error ? err.message : String(err) }));
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
