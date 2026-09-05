// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Boot-time registration for the Communications Hub's own background work:
// a scheduler that sweeps for QUEUED messages deferred past quiet hours and
// RETRY_SCHEDULED messages whose backoff has elapsed, and dispatches them
// (outbox.ts's dispatchDueMessages()). Mirrors the existing
// register<X>Engine() template (lib/exceptions/bootstrap.ts,
// lib/launch/bootstrap.ts): an idempotent `registered` latch, an interval
// handle that is .unref()'d so it never holds the process open, and a
// test-only reset/stop escape hatch.
//
// Section 24 (Exception & Risk integration) needs no separate wiring here —
// once lib/exceptions/rules/communicationDelivery.ts is added to RISK_RULES
// (lib/exceptions/registry.ts — already done), the existing Exception
// Engine scheduler picks it up on its own next scan; Communications does
// not run a second copy of that machinery.

import { logger } from "@aee/events";
import { dispatchDueMessages } from "./outbox.js";

const SWEEP_INTERVAL_MS = 60_000;

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;

export function registerCommunicationsEngine(): void {
  if (registered) return;
  registered = true;

  intervalHandle = setInterval(() => {
    dispatchDueMessages().catch((err) => logger.error("communications_outbox_sweep_failed", { error: err instanceof Error ? err.message : String(err) }));
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopCommunicationsEngineScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test-only: resets the registration latch so a test can call registerCommunicationsEngine() again in isolation. */
export function _resetCommunicationsEngineForTesting(): void {
  stopCommunicationsEngineScheduler();
  registered = false;
}
