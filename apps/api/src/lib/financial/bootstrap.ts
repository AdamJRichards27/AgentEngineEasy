// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage F.
//
// registerFinancialEngine(): the engine's AE-integration wiring —
// everything Stages B-E's own module comments deferred to "Stage F's job"
// (settlement.ts's header: "this module is the pure service layer Stage
// F's registerFinancialEngine() event subscriber calls when a
// SETTLEMENT_COMPLETED domain event arrives"; paymentOutbox.ts's header:
// "Stage F wires a recurring caller for dispatchPendingPaymentOutbox").
// Mirrors lib/exceptions/bootstrap.ts's own registerExceptionEngine shape
// (idempotent "registered" latch, an options.startScheduler escape hatch
// for tests, unref()'d interval so a graceful shutdown never waits on it).

import { eq, and } from "drizzle-orm";
import { db, properties, pcFeeAuthorities } from "@aee/db";
import { registerHandler, type DomainEvent } from "@aee/events";
import { finalizeCommissionForSettlement, ensurePcSuccessFeeRequest } from "./settlement.js";
import { createPcFeeCalculation } from "./pcFeeCalculations.js";
import { dispatchPendingPaymentOutbox } from "./paymentOutbox.js";

// Same order of magnitude as registerExceptionEngine's own
// SCAN_INTERVAL_MS (15 min) — the payment outbox's own backoff already
// caps an individual entry's retry spacing (paymentOutbox.ts's
// backoffMinutesFor, up to 24h), so this interval only needs to be
// frequent enough that a freshly-PENDING or backoff-elapsed entry doesn't
// sit unprocessed for an unreasonable stretch, not fast enough to race
// anything time-sensitive.
const OUTBOX_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Settlement-triggered finalisation, end to end (Section 21): finalises
 * the transaction's commission against its APPROVED commission agreement
 * (a no-op if none exists — finalizeCommissionForSettlement's own
 * documented behaviour), then — only once that actually produced a
 * calculation — checks whether the transaction's agent has an ACTIVE PC
 * fee authority and, if so, calculates and ensures a PC_SUCCESS_FEE
 * payment request for it. Both settlement.ts functions this calls are
 * already individually idempotent (see their own doc comments), so a
 * redelivered SETTLEMENT_COMPLETED is always safe to re-run in full.
 */
export async function handleSettlementCompleted(event: DomainEvent): Promise<void> {
  if (event.transactionId == null || event.brokerageId == null || event.propertyId == null) {
    // No canonical publisher of SETTLEMENT_COMPLETED omits these today,
    // but fail closed (skip) rather than guess at a missing scope, same
    // posture as lib/exceptions/engine.ts's own event.brokerageId guard.
    return;
  }

  const result = await finalizeCommissionForSettlement({
    transactionId: event.transactionId,
    brokerageId: event.brokerageId,
    propertyId: event.propertyId,
    correlationId: event.correlationId,
  });
  if (!result.calculation) return;

  let agentUserId = event.agentId ?? null;
  if (!agentUserId) {
    const [property] = await db.select({ agentId: properties.agentId }).from(properties).where(eq(properties.id, event.propertyId));
    agentUserId = property?.agentId ?? null;
  }
  if (!agentUserId) return;

  const [activeAuthority] = await db
    .select()
    .from(pcFeeAuthorities)
    .where(and(eq(pcFeeAuthorities.agentUserId, agentUserId), eq(pcFeeAuthorities.status, "ACTIVE")));
  if (!activeAuthority) return; // no PC fee authority on file for this agent -- nothing to bill (Section 13: never invented, only ever recorded).

  const pcFeeCalculation = await createPcFeeCalculation({
    brokerageId: event.brokerageId,
    propertyId: event.propertyId,
    transactionId: event.transactionId,
    pcFeeAuthorityId: activeAuthority.id,
    commissionCalculationId: result.calculation.id,
    state: "FINALISED",
    correlationId: event.correlationId,
  });

  await ensurePcSuccessFeeRequest({
    transactionId: event.transactionId,
    brokerageId: event.brokerageId,
    propertyId: event.propertyId,
    pcFeeCalculationId: pcFeeCalculation.id,
    correlationId: event.correlationId,
  });
}

let registered = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function registerFinancialEventHandlers(): void {
  registerHandler("SETTLEMENT_COMPLETED", handleSettlementCompleted);
}

export interface RegisterFinancialEngineOptions {
  /** Set false in tests / one-off scripts that call dispatchPendingPaymentOutbox() explicitly and must not also have a background timer running. Defaults to true. */
  startScheduler?: boolean;
}

/**
 * Call once at boot, after configureEvents() and alongside
 * registerExceptionEngine()/registerLaunchEngine()/
 * registerCommunicationsEngine() (apps/api/src/index.ts). Idempotent —
 * safe to call more than once (e.g. across repeated test-suite app
 * bootstraps in the same process).
 */
export function registerFinancialEngine(options: RegisterFinancialEngineOptions = {}): void {
  if (registered) return;
  registered = true;

  registerFinancialEventHandlers();

  const startScheduler = options.startScheduler ?? process.env.NODE_ENV !== "test";
  if (!startScheduler) return;

  intervalHandle = setInterval(() => {
    dispatchPendingPaymentOutbox().catch((err) => console.error("financial engine: payment outbox sweep failed", err));
  }, OUTBOX_SWEEP_INTERVAL_MS);
  // Never hold the process open just for this timer (matches
  // registerExceptionEngine's own intervalHandle.unref?.() convention).
  intervalHandle.unref?.();
}

/** Test-only escape hatch — stops the interval so a test process can exit cleanly. Registration state is not reset (mirrors registerExceptionEngine's own "registered" latch being permanent for the life of the process). */
export function stopFinancialEngineScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
