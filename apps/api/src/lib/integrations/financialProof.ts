// Agent Engine 2.0 — AE Step 5 remediation — Proof C (Financial Transaction
// Engine).
//
// Wires the generic integration foundation's inbound webhook gateway to
// lib/financial/mockPaymentStatusSync.ts — a genuinely new, small Financial
// Engine authority (see that file's own extensive header comment on the
// money-movement boundary and the "never RECONCILED" discipline). This file
// is deliberately thin: signature verification, idempotency, and tenant
// safety are the SAME generic gateway (webhooks.ts) Proof A/B already use;
// all this file does is transform the mock processor's own payload
// vocabulary into a call on the Financial Engine's real service boundary
// (Section 4: "transform before entering domain workflows").
//
// Proof C is inbound-only by design (see mockPaymentStatusSync.ts's own
// header comment) — there is no outbound "submit a payment" half here, only
// a connection-gated inbound status observation. Every effect this file's
// handler can produce is still gated by a live resolveActiveConnection call
// (defense-in-depth, mirrors applySmsDeliveryStatusUpdate/
// applyListingStatusUpdate — the generic webhook gateway itself does not
// enforce connection status/scope on inbound events, only tenant identity
// and signature validity, so each domain proof's own handler re-checks).

import { eq } from "drizzle-orm";
import { db, financialPaymentRequests } from "@aee/db";
import { resolveActiveConnection } from "./registry.js";
import { registerWebhookEffectHandler, type WebhookEffectContext, type WebhookEffectResult } from "./webhooks.js";
import { registerIntegrationSourceRecordResolver } from "./sourceRecordResolvers.js";
import { IntegrationError, INTEGRATION_CAPABILITIES } from "./types.js";
import { MOCK_PAYMENT_STATUS_PROVIDER_ID } from "./adapters/mockPaymentStatus.js";
import { applyMockPaymentStatusEvent, PAYMENT_REQUEST_SOURCE_RECORD_TYPE } from "../financial/mockPaymentStatusSync.js";

export const PAYMENT_STATUS_WEBHOOK_EVENT_TYPE = "MOCK_PAYMENT_STATUS_UPDATE";

/**
 * The inbound half of Proof C, registered once at bootstrap
 * (registerFinancialIntegrationHandlers below).
 */
async function applyMockPaymentStatusWebhook({ connection, inboxRow }: WebhookEffectContext): Promise<WebhookEffectResult> {
  const payload = inboxRow.payload as {
    externalReference?: string;
    amountCents?: number;
    currency?: string;
    status?: string;
    occurredAt?: string;
  };
  if (!payload.externalReference || typeof payload.amountCents !== "number" || !payload.currency || !payload.status) {
    throw new Error("Malformed mock payment-status webhook — missing externalReference, amountCents, currency, or status.");
  }

  // Defense-in-depth connection gate (see this file's own header comment) —
  // a disabled/suspended/unapproved-scope connection produces NO domain
  // effect, even though the generic gateway already recorded the raw event
  // for audit.
  try {
    await resolveActiveConnection(connection.brokerageId, connection.id, INTEGRATION_CAPABILITIES.PAYMENTS_STATUS_SYNC);
  } catch (err) {
    if (err instanceof IntegrationError) {
      return { summary: `Connection is not usable for payments.statusSync (${err.reason}) — event recorded, no effect applied.` };
    }
    throw err;
  }

  const result = await applyMockPaymentStatusEvent(connection.brokerageId, {
    connectionId: connection.id,
    externalReference: payload.externalReference,
    amountCents: payload.amountCents,
    currency: payload.currency,
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : inboxRow.receivedAt,
    providerStatus: payload.status,
  });

  switch (result.outcome) {
    case "UNKNOWN_REFERENCE":
      return { summary: `No payment request is mapped to external reference ${payload.externalReference} on this connection — event recorded, no effect applied.` };
    case "STALE_IGNORED":
      return { summary: `Stale/out-of-order mock payment-status event for payment request ${result.paymentRequest?.id} ignored — newer evidence already recorded.` };
    case "VARIANCE":
      return { summary: `Mock payment-status event for payment request ${result.paymentRequest?.id} recorded as a VARIANCE (amount/currency mismatch) — routed for manual review, no reconciliation authority granted.` };
    case "MATCHED":
    default:
      return { summary: `Mock payment-status event for payment request ${result.paymentRequest?.id} recorded as matching evidence (PARTIALLY_RECONCILED) — full reconciliation remains a Financial Engine human authority action.` };
  }
}

async function resolveFinancialSourceRecord(brokerageId: number, sourceRecordId: string) {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, Number(sourceRecordId)));
  if (!request || request.brokerageId !== brokerageId) return null;
  return { propertyId: request.propertyId, transactionId: request.transactionId };
}

let registered = false;
export function registerFinancialIntegrationHandlers(): void {
  if (registered) return;
  registerWebhookEffectHandler(MOCK_PAYMENT_STATUS_PROVIDER_ID, PAYMENT_STATUS_WEBHOOK_EVENT_TYPE, applyMockPaymentStatusWebhook);
  registerIntegrationSourceRecordResolver(PAYMENT_REQUEST_SOURCE_RECORD_TYPE, resolveFinancialSourceRecord);
  registered = true;
}

export function clearFinancialIntegrationHandlersForTesting(): void {
  registered = false;
}
