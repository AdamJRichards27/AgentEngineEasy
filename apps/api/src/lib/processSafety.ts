/**
 * AE GROW Pilot Readiness WP2a (P0-1) — process-level safety net.
 *
 * lib/asyncRouteErrors.ts forwards async ROUTE failures to the global error
 * handler. This covers everything else: a rejected promise nobody awaited
 * (fire-and-forget work, timers, event handlers) and a synchronous throw
 * that escapes to the event loop.
 *
 * - unhandledRejection: logged + alerted, process KEPT ALIVE. A rejection
 *   is a single failed async operation; its stack has already unwound and
 *   it leaves no half-executed synchronous code behind, so the rest of the
 *   process is in a known state. Node's default (since v15) is to crash,
 *   which would turn one failed background task into an outage for every
 *   user. Installing this listener opts out of that default.
 * - uncaughtException: logged + alerted, then the process EXITS(1). A
 *   synchronous throw that reached the event loop may have interrupted code
 *   mid-way (half-updated in-memory state, a held lock, a partially written
 *   stream). Node's own guidance is that continuing after one is unsafe; the
 *   supervisor (Replit deployment / container orchestrator) restarts a clean
 *   process. The exit is deferred briefly so the alert has a chance to be
 *   delivered, bounded by a hard timeout so a hung alert transport can never
 *   keep a corrupted process alive.
 */
import { logger } from "@aee/events";
import { dispatchOperationalAlert } from "./operationalAlerts.js";

const UNCAUGHT_EXCEPTION_EXIT_GRACE_MS = 2_000;
let installed = false;

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return {
      errorName: err.name,
      errorMessage: err.message,
      errorCode: typeof code === "string" ? code : undefined,
      stack: err.stack,
    };
  }
  return { errorMessage: String(err) };
}

export function handleUnhandledRejection(reason: unknown): Promise<unknown> {
  logger.error("process_unhandled_rejection", { ...errorSummary(reason), processKeptAlive: true });
  return dispatchOperationalAlert({
    type: "UNHANDLED_API_ERROR",
    summary: "Unhandled promise rejection (process kept alive)",
    dedupKey: "process:unhandled-rejection",
    details: { errorName: reason instanceof Error ? reason.name : typeof reason },
  }).catch(() => undefined);
}

export function handleUncaughtException(
  err: unknown,
  exit: (code: number) => void = (code) => process.exit(code),
  graceMs: number = UNCAUGHT_EXCEPTION_EXIT_GRACE_MS,
): Promise<void> {
  logger.error("process_uncaught_exception", { ...errorSummary(err), processExiting: true });
  let exited = false;
  const exitOnce = () => {
    if (exited) return;
    exited = true;
    exit(1);
  };
  const timer = setTimeout(exitOnce, graceMs);
  timer.unref?.();
  return dispatchOperationalAlert({
    type: "UNHANDLED_API_ERROR",
    summary: "Uncaught exception — API process exiting for restart",
    dedupKey: "process:uncaught-exception",
    details: { errorName: err instanceof Error ? err.name : typeof err },
  })
    .catch(() => undefined)
    .then(() => {
      clearTimeout(timer);
      exitOnce();
    });
}

/** Idempotent. Called once from index.ts before any other startup work. */
export function installProcessSafetyHandlers(): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    void handleUnhandledRejection(reason);
  });
  process.on("uncaughtException", (err) => {
    void handleUncaughtException(err);
  });
}
