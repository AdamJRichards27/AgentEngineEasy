// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Inbound mandate-payment-provider webhook processing (Section 31). Same
// verify -> parse -> dedup -> apply shape as lib/payments.ts's
// processPaymentWebhook and lib/communications/webhooks.ts's
// processInboundWebhook, adapted for the PC-fee debit lifecycle's wider
// status vocabulary (Processing/Paid/Failed/Reversed/Disputed vs
// payments.ts's Succeeded/Failed/Refunded) and its retryCount/maxRetries
// columns, which lib/payments.ts's Payment table doesn't have at all — a
// Failed mandate debit is retryable up to maxRetries before it becomes
// permanently FAILED, whereas a failed card charge there is simply Failed.
//
// Dedup uses the SAME financialPaymentProviderEvents table Stage B already
// built for this purpose (its (provider, providerEventId) unique index),
// via the identical insert-first-then-apply idiom
// lib/communications/webhooks.ts's processInboundWebhook established: the
// event row is inserted BEFORE its effects are applied, so a redelivered
// webhook (nearly every real provider redelivers at least once) fails the
// insert's unique constraint and is a guaranteed no-op rather than a
// double-applied state transition.
//
// Stage F: the Paid/terminal-Failed/Reversed branches additionally publish
// FINANCIAL_PAYMENT_PAID/FINANCIAL_PAYMENT_FAILED/FINANCIAL_PAYMENT_REVERSED
// to the canonical event bus (events.ts), and a terminal Failed outcome
// additionally leaves an internal note on the property's Financial notices
// thread (communications.ts) — the one financial-webhook outcome that
// genuinely needs a human to notice and act, per Section 15's "a human has
// to intervene past exhausted retries" posture (paymentOutbox.ts's own
// module comment says the same for its own exhausted-retries path).

import { eq, and } from "drizzle-orm";
import { syncReceiptsForPaymentRequest } from "./receipts.js";
import {
  db,
  financialPaymentRequests,
  financialPaymentProviderEvents,
  financialDisputes,
  financialLedgerEvents,
  pcFeeAuthorities,
  properties,
  type FinancialPaymentRequest,
} from "@aee/db";
import type { MandateWebhookResult } from "@aee/integration-mandate-payments";
import { mandatePaymentProvider } from "./provider.js";
import { emitFinancialEvent } from "./events.js";
import { notifyFinancialEvent } from "./communications.js";

async function recordLedgerEvent(input: {
  brokerageId: number;
  propertyId?: number | null;
  transactionId?: number | null;
  eventType: string;
  amountCents?: number | null;
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
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    actorType: input.actorType,
    reason: input.reason ?? null,
  });
}

export interface ProcessMandateWebhookResult {
  processed: boolean;
  reason?: "webhooks_disabled" | "invalid_signature" | "payment_request_not_found" | "context_mismatch" | "duplicate_delivery";
  paymentRequest?: FinancialPaymentRequest;
}

/**
 * Section 31's inbound half — the counterpart to lib/financial/
 * paymentOutbox.ts's outbound dispatch.
 */
export async function processMandatePaymentWebhook(
  rawBody: Buffer | string,
  signature: string,
  payload: unknown,
  options: { requireTransportContext?: boolean } = {},
): Promise<ProcessMandateWebhookResult> {
  // Disabled is a hard no-op; in particular do not parse, deduplicate, or
  // record an event that could later be mistaken for a provider outcome.
  if (!mandatePaymentProvider.isWebhookEnabled()) {
    return { processed: false, reason: "webhooks_disabled" };
  }
  if (!mandatePaymentProvider.verifyWebhookSignature(rawBody, signature)) {
    return { processed: false, reason: "invalid_signature" };
  }

  const result: MandateWebhookResult = mandatePaymentProvider.parseWebhook(payload);

  const [inserted] = await db
    .insert(financialPaymentProviderEvents)
    .values({
      provider: mandatePaymentProvider.name,
      providerEventId: result.providerEventId,
      eventType: result.status.toUpperCase(),
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    return { processed: false, reason: "duplicate_delivery" };
  }

  const [request] = await db
    .select()
    .from(financialPaymentRequests)
    .where(eq(financialPaymentRequests.providerRequestRef, result.providerRequestRef));

  if (!request) {
    await db
      .update(financialPaymentProviderEvents)
      .set({
        processingStatus: "FAILED",
        processingError: `No payment request found for providerRequestRef=${result.providerRequestRef}`,
        processedAt: new Date(),
      })
      .where(eq(financialPaymentProviderEvents.id, inserted.id));
    return { processed: false, reason: "payment_request_not_found" };
  }

  // providerRequestRef alone is not a tenant boundary. Public transport must
  // provide all three signed bindings. Trusted in-process typed events may
  // omit transport-only fields, but any context they do provide is still
  // checked rather than silently trusted.
  const contextSupplied =
    result.brokerageId !== undefined ||
    result.provider !== undefined ||
    result.mandateProviderRef !== undefined;
  const requiresAuthority = options.requireTransportContext || contextSupplied;
  const [authority] = requiresAuthority && request.pcFeeAuthorityId != null
    ? await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, request.pcFeeAuthorityId))
    : [];
  const contextMissing = options.requireTransportContext && (
    result.brokerageId === undefined ||
    result.provider === undefined ||
    result.mandateProviderRef === undefined
  );
  if (
    contextMissing ||
    (contextSupplied && (
      result.provider !== mandatePaymentProvider.name ||
      request.provider !== result.provider ||
      request.brokerageId !== result.brokerageId ||
      !authority ||
      authority.brokerageId !== request.brokerageId ||
      authority.mandateProvider !== result.provider ||
      authority.mandateProviderRef !== result.mandateProviderRef
    ))
  ) {
    await db
      .update(financialPaymentProviderEvents)
      .set({ processingStatus: "FAILED", processingError: "Webhook provider, brokerage, or mandate context did not match payment request.", processedAt: new Date() })
      .where(eq(financialPaymentProviderEvents.id, inserted.id));
    return { processed: false, reason: "context_mismatch" };
  }

  const updated = await applyMandateWebhookResult(request, result);

  await db
    .update(financialPaymentProviderEvents)
    .set({ processingStatus: "PROCESSED", paymentRequestId: request.id, processedAt: new Date() })
    .where(eq(financialPaymentProviderEvents.id, inserted.id));

  // Owner t180u(2): success / failure / reversal receipts (idempotent).
  await syncReceiptsForPaymentRequest(updated.id);

  return { processed: true, paymentRequest: updated };
}

async function applyMandateWebhookResult(request: FinancialPaymentRequest, result: MandateWebhookResult): Promise<FinancialPaymentRequest> {
  switch (result.status) {
    case "Processing": {
      const [updated] = await db
        .update(financialPaymentRequests)
        .set({
          status: "PROCESSING",
          processingStartedAt: request.processingStartedAt ?? new Date(),
          providerStatus: result.status,
          updatedAt: new Date(),
        })
        .where(eq(financialPaymentRequests.id, request.id))
        .returning();
      await recordLedgerEvent({
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        eventType: "PC_FEE_PAYMENT_PROCESSING",
        amountCents: updated.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated.id),
        actorType: "SYSTEM",
      });
      return updated;
    }

    case "Paid": {
      const [updated] = await db
        .update(financialPaymentRequests)
        .set({ status: "PAID", paidAt: new Date(), providerStatus: result.status, updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, request.id))
        .returning();
      await recordLedgerEvent({
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        eventType: "PC_FEE_PAID",
        amountCents: updated.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated.id),
        actorType: "SYSTEM",
      });
      await emitFinancialEvent({
        eventType: "FINANCIAL_PAYMENT_PAID",
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        actorType: "SYSTEM",
        source: "webhook:financial:mandate-payments",
        payload: { paymentRequestId: updated.id, amountCents: updated.amountCents },
      });
      return updated;
    }

    case "Failed": {
      // A failed mandate debit is retryable (Section 15) up to
      // maxRetries — unlike lib/payments.ts's Payment, which has no
      // retry columns at all and treats every failure as final.
      const retryCount = request.retryCount + 1;
      const willRetry = retryCount < request.maxRetries;
      const [updated] = await db
        .update(financialPaymentRequests)
        .set({
          status: willRetry ? "RETRY_SCHEDULED" : "FAILED",
          retryCount,
          failedAt: willRetry ? null : new Date(),
          failureReason: result.failureReason ?? "Payment failed",
          providerStatus: result.status,
          updatedAt: new Date(),
        })
        .where(eq(financialPaymentRequests.id, request.id))
        .returning();
      await recordLedgerEvent({
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        eventType: "PC_FEE_PAYMENT_FAILED",
        amountCents: updated.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated.id),
        actorType: "SYSTEM",
        reason: `${result.failureReason ?? "Payment failed"} (attempt ${retryCount}/${request.maxRetries}${willRetry ? ", will retry" : ", exhausted"})`,
      });

      if (!willRetry) {
        await emitFinancialEvent({
          eventType: "FINANCIAL_PAYMENT_FAILED",
          brokerageId: updated.brokerageId,
          propertyId: updated.propertyId,
          transactionId: updated.transactionId,
          actorType: "SYSTEM",
          source: "webhook:financial:mandate-payments",
          payload: { paymentRequestId: updated.id, amountCents: updated.amountCents, reason: updated.failureReason },
        });

        // Section 25: a permanently failed PC success-fee debit needs a
        // human to notice — the payment outbox has already exhausted its
        // own retries by this point (Section 15), so nothing further will
        // happen automatically. propertyId is nullable on
        // financialPaymentRequests in principle but always set for a
        // PC_SUCCESS_FEE request in practice; skip the note rather than
        // guess a recipient if it's ever missing.
        if (updated.propertyId != null) {
          const [property] = await db.select({ agentId: properties.agentId }).from(properties).where(eq(properties.id, updated.propertyId));
          if (property?.agentId) {
            await notifyFinancialEvent({
              brokerageId: updated.brokerageId,
              propertyId: updated.propertyId,
              transactionId: updated.transactionId,
              createdByUserId: property.agentId,
              subject: "PC success fee payment failed",
              bodyText: `Payment request #${updated.id} (${(updated.amountCents / 100).toFixed(2)} AUD) failed permanently after ${retryCount} attempt(s): ${updated.failureReason ?? "no reason given"}. This will not retry automatically — review the mandate and payment request.`,
            });
          }
        }
      }

      return updated;
    }

    case "Reversed": {
      const [updated] = await db
        .update(financialPaymentRequests)
        .set({
          status: "REVERSED",
          reversedAt: new Date(),
          reversalReason: result.failureReason ?? "Reversed by provider",
          providerStatus: result.status,
          updatedAt: new Date(),
        })
        .where(eq(financialPaymentRequests.id, request.id))
        .returning();
      await recordLedgerEvent({
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        eventType: "PC_FEE_PAYMENT_REVERSED",
        amountCents: updated.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated.id),
        actorType: "SYSTEM",
        reason: `Reversed by provider: ${result.failureReason ?? "no reason given"}`,
      });
      await emitFinancialEvent({
        eventType: "FINANCIAL_PAYMENT_REVERSED",
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        actorType: "SYSTEM",
        source: "webhook:financial:mandate-payments",
        payload: { paymentRequestId: updated.id, amountCents: updated.amountCents, reason: updated.reversalReason },
      });
      return updated;
    }

    case "Disputed": {
      const [updated] = await db
        .update(financialPaymentRequests)
        .set({ status: "DISPUTED", providerStatus: result.status, updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, request.id))
        .returning();

      // Idempotent: a redelivered or repeated Disputed event for the same
      // payment request must not open a second concurrent dispute record.
      const [existingOpenDispute] = await db
        .select()
        .from(financialDisputes)
        .where(and(eq(financialDisputes.paymentRequestId, request.id), eq(financialDisputes.status, "OPEN")));
      if (!existingOpenDispute) {
        await db.insert(financialDisputes).values({
          brokerageId: updated.brokerageId,
          paymentRequestId: updated.id,
          disputedAmountCents: updated.amountCents,
          reason: result.disputeReason ?? "Disputed by provider",
          status: "OPEN",
        });
      }

      await recordLedgerEvent({
        brokerageId: updated.brokerageId,
        propertyId: updated.propertyId,
        transactionId: updated.transactionId,
        eventType: "PC_FEE_DISPUTED",
        amountCents: updated.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated.id),
        actorType: "SYSTEM",
        reason: result.disputeReason ?? null,
      });
      return updated;
    }

    default:
      throw new Error(`Unknown mandate webhook status: ${result.status as string}`);
  }
}
