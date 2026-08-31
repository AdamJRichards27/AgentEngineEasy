// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// Boot-time wiring: registers the one event-driven handler this module
// needs — auto-proposing a Launch Plan the moment a property's Agency
// Agreement is signed, matching the governing spec's lifecycle
// (AGENCY AGREEMENT SIGNED -> LAUNCH PLANNING). Mirrors
// lib/exceptions/bootstrap.ts's own "register once, idempotent" shape;
// unlike that module there is no scheduler to start here — Launch has
// nothing time-driven, everything else is a direct route action.

import { registerHandler, type DomainEvent } from "@aee/events";
import { getOrCreateLaunchPlan } from "./model.js";

let registered = false;

/**
 * SYSTEM-attributed (actor null) — getOrCreateLaunchPlan is itself
 * idempotent (unique index on launch_plans.property_id, race-safe), so a
 * duplicate AGENCY_AGREEMENT_SIGNED delivery or a plan the agent already
 * started manually both resolve to "do nothing" rather than an error.
 * Never throws back to the dispatcher — registry.ts already isolates
 * handler failures from each other, but this still logs with its own
 * specific message rather than relying on the generic one.
 */
async function handleAgencyAgreementSigned(event: DomainEvent): Promise<void> {
  if (event.propertyId == null || event.brokerageId == null) return;
  try {
    await getOrCreateLaunchPlan(event.propertyId, event.brokerageId, null);
  } catch (err) {
    console.error(`launch engine: auto-propose launch plan failed for property ${event.propertyId}`, err);
  }
}

/** Call once at boot, alongside registerExceptionEngine() (apps/api/src/index.ts) — after configureEvents() so the dispatch map already exists. Idempotent. */
export function registerLaunchEngine(): void {
  if (registered) return;
  registered = true;
  registerHandler("AGENCY_AGREEMENT_SIGNED", handleAgencyAgreementSigned);
}

/** Test-only escape hatch, mirrors clearHandlersForTesting()'s role for the exception engine — resets this module's own idempotency latch (does not clear the shared handler map itself; tests that need that call events' own clearHandlersForTesting()). */
export function _resetLaunchEngineForTesting(): void {
  registered = false;
}
