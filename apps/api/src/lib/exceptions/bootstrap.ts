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

import { registerExceptionEventHandlers, runScheduledScan } from "./engine.js";

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;

// 15 minutes: frequent enough that a time-sensitive severity escalation
// (e.g. a settlement crossing its due date) is caught well within the hour,
// bounded enough that a full sweep across every brokerage/rule never runs
// back-to-back with itself under normal load (see engine.ts's
// SCAN_STALE_WINDOW_MS — the scan-run guard is the actual safety net if a
// sweep ever does run long).
const SCAN_INTERVAL_MS = 15 * 60 * 1000;

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
    runScheduledScan("SCHEDULED").catch((err) => console.error("exception engine: scheduled scan failed", err));
  }, SCAN_INTERVAL_MS);
  // Never hold the process open just for this timer (matches Node's own
  // convention for background/best-effort intervals; a graceful shutdown
  // should not have to wait on the next tick of a periodic risk sweep).
  intervalHandle.unref?.();
}

/** Test-only escape hatch — stops the interval so a test process can exit cleanly. Registration state is not reset (mirrors registerAutomationEngine's own "registered" latch being permanent for the life of the process). */
export function stopExceptionEngineScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
