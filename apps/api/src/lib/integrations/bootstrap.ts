// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Boot-time registration, mirroring the existing register<X>Engine()
// template (lib/exceptions/bootstrap.ts, lib/communications/bootstrap.ts):
// an idempotent `registered` latch, an interval handle that is .unref()'d
// so it never holds the process open, and a test-only reset escape hatch.
// Registers the one mock adapter this build ships, the one domain proof's
// webhook effect handler, seeds the provider catalogue (fire-and-forget,
// same non-blocking convention as billing's ensureCatalogueSeeded), and
// starts the outbox retry-sweep scheduler.

import { registerAdapter, seedProviderCatalogue } from "./registry.js";
import { mockPortalAdapter } from "./adapters/mockPortal.js";
import { registerLaunchIntegrationHandlers } from "./launchProof.js";
import { dispatchDueOutbox } from "./outbox.js";

const SWEEP_INTERVAL_MS = 60_000;

let registered = false;
let intervalHandle: NodeJS.Timeout | null = null;

export function registerIntegrationsEngine(): void {
  if (registered) return;
  registered = true;

  registerAdapter(mockPortalAdapter);
  registerLaunchIntegrationHandlers();
  seedProviderCatalogue().catch((err) => console.error("seedProviderCatalogue failed", err));

  intervalHandle = setInterval(() => {
    dispatchDueOutbox().catch((err) => console.error("Integration outbox sweep failed", err));
  }, SWEEP_INTERVAL_MS);
  intervalHandle.unref();
}

export function stopIntegrationsEngineScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test-only: resets the registration latch so a test can call registerIntegrationsEngine() again in isolation. */
export function _resetIntegrationsEngineForTesting(): void {
  stopIntegrationsEngineScheduler();
  registered = false;
}
