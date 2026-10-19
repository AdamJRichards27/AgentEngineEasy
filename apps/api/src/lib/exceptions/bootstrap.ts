// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// Boot-time wiring: registers the event-driven handler (once, idempotent —
// mirrors lib/automation/bootstrap.ts's registerAutomationEngine()) and
// starts the time-driven scheduler. Build Instructions §9 explicitly
// authorised building the first scheduler in this codebase — a repository
// search before this build (search_code, zero results for any cron/interval/
// scheduler infrastructure) confirmed there is nothing existing to reuse.
// Kept deliberately minimal: a guarded setInterval calling runScheduledScan(),
// not a new general-purpose job framework — exactly the amount of
// infrastructure this one recurring job needs, matching this codebase's
// existing "build the smallest thing that closes the gap" convention (see
// e.g. eventProcessingReceipts's own comment on being an outbox-consumer
// ledger, not a message queue).

import { logger } from "@aee/events";
import { registerExceptionEventHandlers, runScheduledScan, type RunScanResult } from "./engine.js";
import { notifyScanFailure } from "./scanFailureAlert.js";

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;

// 15 minutes: frequent enough that a time-sensitive severity escalation
// (e.g. a settlement crossing its due date) is caught well within the hour,
// bounded enough that a full sweep across every brokerage/rule never runs
// back-to-back with itself under normal load (engine.ts's advisory-lock
// single-flight guard is the actual safety net if a sweep ever does run
// long — an overlapping tick is refused, never run concurrently).
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * One scheduled tick, with explicit observability. A successful scan that finds nothing logs nothing
 * elsewhere, so without these lines a healthy tick is indistinguishable from a dead timer. Logging only:
 * the scan itself, its locking and its failure semantics are unchanged. `run` is injectable for tests.
 * WS4: failures (thrown, or completed with summary.errors > 0) are also handed to scanFailureAlert.ts's sink.
 */
export async function runScheduledScanTick(run: (trigger: "SCHEDULED") => Promise<RunScanResult> = runScheduledScan): Promise<void> {
  const startedAtMs = Date.now();
  logger.info("exception_engine_scheduled_scan_tick_started", { intervalMs: SCAN_INTERVAL_MS });
  try {
    const result = await run("SCHEDULED");
    if (result.ok) {
      logger.info("exception_engine_scheduled_scan_tick_succeeded", { durationMs: Date.now() - startedAtMs, ...result.summary });
      // WS4: a scan that completed but recorded per-rule errors is reported to the (pluggable, default no-op) sink.
      if (result.summary.errors > 0) {
        notifyScanFailure({
          kind: "scan_completed_with_errors",
          trigger: "SCHEDULED",
          occurredAt: new Date().toISOString(),
          durationMs: Date.now() - startedAtMs,
          scanRunId: result.summary.scanRunId,
          errors: result.summary.errors,
        });
      }
    } else {
      logger.info("exception_engine_scheduled_scan_tick_skipped", { durationMs: Date.now() - startedAtMs, reason: result.skippedReason });
    }
  } catch (err) {
    logger.error("exception_engine_scheduled_scan_failed", { error: err, durationMs: Date.now() - startedAtMs });
    // WS4: a thrown scheduled scan is reported to the (pluggable, default no-op) sink; never rethrows.
    notifyScanFailure({
      kind: "scan_threw",
      trigger: "SCHEDULED",
      occurredAt: new Date().toISOString(),
      durationMs: Date.now() - startedAtMs,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
}

export interface RegisterExceptionEngineOptions {
  /** Set false in tests / one-off scripts that call runScheduledScan() explicitly and must not also have a background timer running. Defaults to true. */
  startScheduler?: boolean;
}

/**
 * Call once at boot, after configureEvents() and alongside
 * registerAutomationEngine() (apps/api/src/index.ts). Idempotent — safe to
 * call more than once (e.g. across repeated test-suite app bootstraps in
 * the same process).
 */
export function registerExceptionEngine(options: RegisterExceptionEngineOptions = {}): void {
  if (registered) return;
  registered = true;

  registerExceptionEventHandlers();

  const startScheduler = options.startScheduler ?? process.env.NODE_ENV !== "test";
  if (!startScheduler) return;

  intervalHandle = setInterval(() => {
    void runScheduledScanTick();
  }, SCAN_INTERVAL_MS);
  // Never hold the process open just for this timer (matches Node's own
  // convention for background/best-effort intervals; a graceful shutdown
  // should not have to wait on the next tick of a periodic risk sweep).
  intervalHandle.unref?.();
  logger.info("exception_engine_scheduler_started", { intervalMs: SCAN_INTERVAL_MS });
}

/** Test-only escape hatch — stops the interval so a test process can exit cleanly. Registration state is not reset (mirrors registerAutomationEngine's own "registered" latch being permanent for the life of the process). */
export function stopExceptionEngineScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
