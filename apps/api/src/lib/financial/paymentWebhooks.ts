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

import { eq, and } from "drizzle-orm";
import {
  db,
  financialPaymentRequests,
  financialPaymentProviderEvents,
  financialDisputes,
  financialLedgerEvents,
  type FinancialPaymentRequest,
} from "@aee/db";
import type { MandateWebhookResult } from "@aee/integration-mandate-payments";
import { mandatePaymentProvider } from "./provider.js";

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
  reason?: "invalid_signature" | "payment_request_not_found" | "duplicate_delivery";
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
): Promise<ProcessMandateWebhookResult> {
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

  const updated = await applyMandateWebhookResult(request, result);

  await db
    .update(financialPaymentProviderEvents)
    .set({ processingStatus: "PROCESSED", paymentRequestId: request.id, processedAt: new Date() })
    .where(eq(financialPaymentProviderEvents.id, inserted.id));

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
