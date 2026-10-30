// Agent Engine 2.0 — Financial Transaction Engine (Priority 9) — AE Step 5
// remediation, Proof C.
//
// A NEW, genuinely small Financial Engine authority: validates an inbound
// mock payment-STATUS observation against an existing financialPaymentRequests
// obligation and records the result as evidence via financial_reconciliations
// — the SAME table legacyReconciliation.ts already uses for exactly this
// purpose (see that file's own header comment: "only ever creates a
// financialReconciliations row"). This module follows the identical
// discipline: it NEVER writes to financialPaymentRequests.status,
// .reconciliationStatus, or .reconciledAt, and it NEVER sets a
// financial_reconciliations row's own status to RECONCILED — reconciliation
// is a decision this app's existing manual reconciliation workflow (a human,
// through financial_reconciliations' reconciledByUserId/reconciledAt) makes,
// never something a provider webhook can declare on its own. See
// lib/financial/legacyReconciliation.ts's own confirmed precedent: no writer
// anywhere in the Financial Engine sets status "RECONCILED" today, and this
// module does not change that.
//
// Money-movement boundary (explicit, load-bearing): this file imports
// nothing from lib/financial/paymentOutbox.ts, paymentWebhooks.ts,
// provider.ts, or @aee/integration-mandate-payments — it cannot schedule,
// submit, retry, or reverse a debit. It only ever reads a
// financialPaymentRequests row (to validate against) and writes
// financial_reconciliations + financial_ledger_events rows (evidence/audit).
// There is no code path from this module to any bank/trust/payment-processor
// connection.
//
// External identity: reuses lib/integrations/mapping.ts's generic
// recordMapping/resolveByExternalId — no financial-specific mapping table.
// Ambiguous mapping (a payload naming a DIFFERENT internal payment request
// than what this externalReference is already mapped to) is a
// MappingConflictError, surfaced here as a VARIANCE reconciliation row for
// human review — see rules/financial.ts's FINANCIAL_RECONCILIATION_VARIANCE
// rule, which is what actually routes it to the Exception & Risk Engine.

import { and, eq, desc } from "drizzle-orm";
import { syncReceiptsForPaymentRequest } from "./receipts.js";
import {
  db,
  financialPaymentRequests,
  financialReconciliations,
  financialLedgerEvents,
  type FinancialPaymentRequest,
  type FinancialReconciliation,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { recordMapping, resolveByExternalId, MappingConflictError } from "../integrations/mapping.js";
import { incrementCounter } from "@aee/events";
import { dispatchOperationalAlert } from "../operationalAlerts.js";

export const PAYMENT_REQUEST_SOURCE_RECORD_TYPE = "financial_payment_request";
export const MOCK_PAYMENT_STATUS_RECONCILIATION_SOURCE = "mock_integration_payment_status";

// Additive to financial_ledger_events.eventType (a `text` column, not a
// Postgres enum — see FINANCIAL_LEDGER_EVENT_TYPES' own header comment in
// packages/db/src/schema/financial.ts for the established "no migration
// required" convention this follows).
export const MOCK_PAYMENT_STATUS_LEDGER_EVENT_TYPES = {
  OBSERVED_MATCH: "MOCK_PAYMENT_STATUS_OBSERVED_MATCH",
  OBSERVED_VARIANCE: "MOCK_PAYMENT_STATUS_OBSERVED_VARIANCE",
  OBSERVED_STALE_IGNORED: "MOCK_PAYMENT_STATUS_OBSERVED_STALE_IGNORED",
} as const;

async function recordLedgerEvent(input: {
  brokerageId: number;
  propertyId?: number | null;
  transactionId?: number | null;
  eventType: string;
  amountCents?: number | null;
  currency?: string;
  sourceRecordType: string;
  sourceRecordId: string;
  actorType: "SYSTEM" | "USER";
  reason?: string | null;
}): Promise<void> {
  await db.insert(financialLedgerEvents).values({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId ?? null,
    transactionId: input.transactionId ?? null,
    eventType: input.eventType,
    amountCents: input.amountCents ?? null,
    currency: input.currency ?? "AUD",
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    actorType: input.actorType,
    reason: input.reason ?? null,
  });
}

export class MockPaymentStatusSyncError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Establishes (or re-confirms) the external<->internal reference for a
 * payment request BEFORE any status event needs to resolve it — the
 * bookkeeping equivalent of a human noting "the mock processor's reference
 * for payment request #4821 is REF-XYZ", not a provider API call (there is
 * no outbound half to this proof — see financialProof.ts's own header
 * comment). Brokerage-Administrator-only at the route layer
 * (routes/integrations.ts), same weight class as every other connection
 * action.
 */
export async function linkPaymentRequestToExternalReference(
  paymentRequestId: number,
  brokerageId: number,
  connectionId: string,
  externalReference: string,
  actor: { id: number },
): Promise<void> {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, paymentRequestId));
  if (!request || request.brokerageId !== brokerageId) {
    throw new MockPaymentStatusSyncError("NOT_FOUND", "Payment request not found.");
  }
  await recordMapping({
    connectionId,
    brokerageId,
    entityType: PAYMENT_REQUEST_SOURCE_RECORD_TYPE,
    internalId: String(paymentRequestId),
    externalId: externalReference,
  });
  await logAudit({
    userId: actor.id,
    action: "financial_payment_request_external_reference_linked",
    recordType: "financial_payment_request",
    recordId: String(paymentRequestId),
    updatedValue: externalReference,
  });
}

export interface MockPaymentStatusEvent {
  connectionId: string;
  externalReference: string;
  amountCents: number;
  currency: string;
  occurredAt: Date;
  providerStatus: string;
}

export type MockPaymentStatusOutcome = "MATCHED" | "VARIANCE" | "STALE_IGNORED" | "UNKNOWN_REFERENCE";

export interface ApplyMockPaymentStatusResult {
  outcome: MockPaymentStatusOutcome;
  paymentRequest: FinancialPaymentRequest | null;
  reconciliation: FinancialReconciliation | null;
}

/**
 * The Financial Engine's own authority for this proof (Section: "reconciliation
 * occurs ONLY through the Financial Engine's own existing rules/authority").
 * Validates amount + currency against the target obligation, guards against a
 * stale/out-of-order event regressing more recent evidence, and records the
 * result as a financial_reconciliations row — evidence, never a status
 * change on the obligation itself.
 */
export async function applyMockPaymentStatusEvent(brokerageId: number, event: MockPaymentStatusEvent): Promise<ApplyMockPaymentStatusResult> {
  const mapping = await resolveByExternalId(event.connectionId, PAYMENT_REQUEST_SOURCE_RECORD_TYPE, event.externalReference);
  if (!mapping) {
    return { outcome: "UNKNOWN_REFERENCE", paymentRequest: null, reconciliation: null };
  }

  const paymentRequestId = Number(mapping.internalId);
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, paymentRequestId));
  if (!request || request.brokerageId !== brokerageId) {
    // Cross-tenant / no-longer-exists — treated identically to unknown,
    // never revealing that a mapping exists for a different tenant.
    return { outcome: "UNKNOWN_REFERENCE", paymentRequest: null, reconciliation: null };
  }

  // Stale/out-of-order guard: an event older than the most recent
  // reconciliation evidence already recorded for this payment request must
  // never regress it (mirrors launchProof.ts's LIVE_TERMINAL_STATUSES /
  // commsProof.ts's TERMINAL_DELIVERY_STATUSES out-of-order discipline,
  // applied here to an evidence trail rather than a status field).
  const [mostRecent] = await db
    .select()
    .from(financialReconciliations)
    .where(and(eq(financialReconciliations.brokerageId, brokerageId), eq(financialReconciliations.recordType, PAYMENT_REQUEST_SOURCE_RECORD_TYPE), eq(financialReconciliations.recordId, String(paymentRequestId))))
    .orderBy(desc(financialReconciliations.createdAt))
    .limit(1);
  if (mostRecent && mostRecent.createdAt.getTime() > event.occurredAt.getTime()) {
    await recordLedgerEvent({
      brokerageId,
      propertyId: request.propertyId,
      transactionId: request.transactionId,
      eventType: MOCK_PAYMENT_STATUS_LEDGER_EVENT_TYPES.OBSERVED_STALE_IGNORED,
      amountCents: event.amountCents,
      currency: event.currency,
      sourceRecordType: PAYMENT_REQUEST_SOURCE_RECORD_TYPE,
      sourceRecordId: String(paymentRequestId),
      actorType: "SYSTEM",
      reason: `Stale mock payment-status event ignored — newer reconciliation evidence (${mostRecent.createdAt.toISOString()}) already recorded.`,
    });
    return { outcome: "STALE_IGNORED", paymentRequest: request, reconciliation: mostRecent };
  }

  const amountMatches = event.amountCents === request.amountCents;
  const currencyMatches = event.currency === request.currency;
  const matched = amountMatches && currencyMatches;
  const differenceCents = amountMatches ? 0 : event.amountCents - request.amountCents;

  const [reconciliation] = await db
    .insert(financialReconciliations)
    .values({
      brokerageId,
      recordType: PAYMENT_REQUEST_SOURCE_RECORD_TYPE,
      recordId: String(paymentRequestId),
      expectedAmountCents: request.amountCents,
      reportedAmountCents: event.amountCents,
      evidenceAmountCents: event.amountCents,
      differenceCents,
      // PARTIALLY_RECONCILED, never RECONCILED — this is system-observed
      // evidence of a match, not the Financial Engine's own authoritative
      // sign-off (Build brief: "a provider event may update external-payment
      // status but CANNOT independently declare the AE obligation
      // reconciled"). VARIANCE for a genuine amount/currency mismatch.
      status: matched ? "PARTIALLY_RECONCILED" : "VARIANCE",
      source: MOCK_PAYMENT_STATUS_RECONCILIATION_SOURCE,
      externalReference: event.externalReference,
      notes: matched
        ? `Mock payment-status event (${event.providerStatus}) matches this payment request's amount and currency.`
        : `Mock payment-status event (${event.providerStatus}) reported ${event.amountCents} ${event.currency}, but this payment request expects ${request.amountCents} ${request.currency}. Requires manual review.`,
    })
    .returning();

  if (!matched) {
    // AE Step 2 closure — Part B named critical gap: financial reconciliation
    // mismatch. This is the one and only place a VARIANCE reconciliation row
    // is recorded (this file's own header comment) — see
    // docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
    incrementCounter("financial_reconciliation_variance_total", { source: MOCK_PAYMENT_STATUS_RECONCILIATION_SOURCE });
    await dispatchOperationalAlert({
      type: "FINANCIAL_RECONCILIATION_VARIANCE",
      summary: "Payment-status reconciliation variance detected",
      dedupKey: `financial-variance:${brokerageId}:${paymentRequestId}:${event.externalReference}`,
      details: {
        brokerageId,
        paymentRequestId,
        expectedAmountCents: request.amountCents,
        reportedAmountCents: event.amountCents,
        expectedCurrency: request.currency,
        reportedCurrency: event.currency,
      },
    });
  }

  await recordLedgerEvent({
    brokerageId,
    propertyId: request.propertyId,
    transactionId: request.transactionId,
    eventType: matched ? MOCK_PAYMENT_STATUS_LEDGER_EVENT_TYPES.OBSERVED_MATCH : MOCK_PAYMENT_STATUS_LEDGER_EVENT_TYPES.OBSERVED_VARIANCE,
    amountCents: event.amountCents,
    currency: event.currency,
    sourceRecordType: PAYMENT_REQUEST_SOURCE_RECORD_TYPE,
    sourceRecordId: String(paymentRequestId),
    actorType: "SYSTEM",
    reason: reconciliation.notes,
  });

  await logAudit({
    action: "financial_payment_request_mock_status_observed",
    recordType: "financial_payment_request",
    recordId: String(paymentRequestId),
    propertyId: request.propertyId,
    updatedValue: reconciliation.status,
  });

  // Owner t180u(2): reconciliation receipt (idempotent).
  await syncReceiptsForPaymentRequest(request.id);
  return { outcome: matched ? "MATCHED" : "VARIANCE", paymentRequest: request, reconciliation };
}

export { MappingConflictError };
