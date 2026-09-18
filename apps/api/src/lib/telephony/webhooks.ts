import { and, eq, ne } from "drizzle-orm";
import { db, growCallWebhookEvents, growCallSessions } from "@aee/db";
import { applySandboxLifecycleEvent, GrowCallSessionValidationError, type SandboxLifecycleEvent } from "./callSessions.js";
import { CallSessionTransitionError } from "./stateMachine.js";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §15 — inbound sandbox-webhook idempotency. Receipts are deduplicated by
// (provider, providerEventId); success commits atomically with the base
// lifecycle and its effects, while failed/pending receipts are retryable.
// F1 implements this
// ONLY for sandbox/test events — there is no live external provider to
// call back into this route (§10, §11).
//
// Tenant safety: brokerageId is NEVER read from the webhook payload. The
// call session this event concerns is resolved by (provider,
// providerCallId) alone — a value that is already globally unique because
// SandboxTelephonyProvider derives it from this app's own call-session id
// (see sandboxProvider.ts) — and every subsequent mutation uses THAT
// session row's own stored brokerageId, never anything the caller sent.

export type TelephonySandboxEventType = "call.ringing" | "call.connected" | "call.completed" | "call.failed";

const EVENT_TYPE_TO_LIFECYCLE_EVENT: Record<TelephonySandboxEventType, SandboxLifecycleEvent> = {
  "call.ringing": "RINGING",
  "call.connected": "CONNECTED",
  "call.completed": "COMPLETED",
  "call.failed": "FAILED",
};

export interface TelephonyWebhookInput {
  provider: string;
  providerEventId: string;
  eventType: TelephonySandboxEventType;
  providerCallId: string;
  payload: Record<string, unknown>;
}

export interface ProcessTelephonyWebhookResult {
  status: "PROCESSED" | "DUPLICATE" | "FAILED";
  webhookEventId: number;
  detail?: string;
}

export async function processInboundTelephonyWebhook(input: TelephonyWebhookInput): Promise<ProcessTelephonyWebhookResult> {
  let [event] = await db
    .select()
    .from(growCallWebhookEvents)
    .where(and(eq(growCallWebhookEvents.provider, input.provider), eq(growCallWebhookEvents.providerEventId, input.providerEventId)));
  if (!event) {
    [event] = await db
      .insert(growCallWebhookEvents)
      .values({
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        // Store authoritative routing fields even for callers that supply a
        // separate payload. Subsequent attempts use only this immutable receipt.
        payload: { ...input.payload, providerCallId: input.providerCallId },
      })
      .onConflictDoNothing()
      .returning();

    if (!event) {
      [event] = await db
        .select()
        .from(growCallWebhookEvents)
        .where(and(eq(growCallWebhookEvents.provider, input.provider), eq(growCallWebhookEvents.providerEventId, input.providerEventId)));
    }
    if (!event) throw new Error("Failed to record inbound telephony webhook event.");
  }

  try {
    const storedPayload = event.payload as Record<string, unknown>;
    const storedCallId = storedPayload?.providerCallId;
    const lifecycleEvent = EVENT_TYPE_TO_LIFECYCLE_EVENT[event.eventType as TelephonySandboxEventType];
    if (typeof storedCallId !== "string" || !Object.hasOwn(EVENT_TYPE_TO_LIFECYCLE_EVENT, event.eventType)) {
      throw new Error("Receipt has no valid stored lifecycle target.");
    }
    const [session] = await db
      .select({ id: growCallSessions.id })
      .from(growCallSessions)
      .where(and(eq(growCallSessions.provider, event.provider), eq(growCallSessions.providerCallId, storedCallId)));
    if (!session) {
      await db
        .update(growCallWebhookEvents)
        .set({ processedAt: new Date(), processingStatus: "FAILED", processingError: "No matching call session for this providerCallId." })
        .where(and(eq(growCallWebhookEvents.id, event.id), ne(growCallWebhookEvents.processingStatus, "PROCESSED")));
      return { status: "FAILED", webhookEventId: event.id, detail: "No matching call session for this providerCallId." };
    }

    let duplicate = false;
    await applySandboxLifecycleEvent(session.id, lifecycleEvent, {
      receipt: {
        claim: async (tx) => {
          // Lock order is always brokerage -> receipt. Both the claim and
          // completion use the lifecycle transaction: process death releases
          // locks and rolls back ALL base effects, with no stranded lease.
          const [locked] = await tx.select().from(growCallWebhookEvents)
            .where(eq(growCallWebhookEvents.id, event.id)).for("update");
          if (!locked) throw new Error("Webhook receipt disappeared.");
          duplicate = locked.processingStatus === "PROCESSED";
          return !duplicate;
        },
        complete: async (tx) => {
          await tx.update(growCallWebhookEvents)
            .set({ processedAt: new Date(), processingStatus: "PROCESSED", processingError: null, relatedCallSessionId: session.id })
            .where(eq(growCallWebhookEvents.id, event.id));
        },
      },
    });
    return {
      status: duplicate ? "DUPLICATE" : "PROCESSED",
      webhookEventId: event.id,
      detail: duplicate ? "Already processed." : `Applied ${event.eventType} to call session ${session.id}.`,
    };
  } catch (err) {
    const message =
      err instanceof CallSessionTransitionError || err instanceof GrowCallSessionValidationError
        ? err.message
        : "Unable to process telephony webhook. Please retry.";
    await db
      .update(growCallWebhookEvents)
      .set({ processedAt: new Date(), processingStatus: "FAILED", processingError: message })
      // A competing successful retry may commit before this failure is
      // recorded. Never downgrade its authoritative success receipt.
      .where(and(eq(growCallWebhookEvents.id, event.id), ne(growCallWebhookEvents.processingStatus, "PROCESSED")));
    return { status: "FAILED", webhookEventId: event.id, detail: message };
  }
}
