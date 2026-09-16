import { and, eq } from "drizzle-orm";
import { db, growCallWebhookEvents, growCallSessions } from "@aee/db";
import { applySandboxLifecycleEvent, type SandboxLifecycleEvent } from "./callSessions.js";
import { CallSessionTransitionError } from "./stateMachine.js";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §15 — inbound sandbox-webhook idempotency, mirroring
// apps/api/src/lib/communications/webhooks.ts's processInboundWebhook()
// select-then-insert-with-onConflictDoNothing pattern exactly (dedup by
// (provider, providerEventId), race-condition-safe). F1 implements this
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
  const [existingEvent] = await db
    .select()
    .from(growCallWebhookEvents)
    .where(and(eq(growCallWebhookEvents.provider, input.provider), eq(growCallWebhookEvents.providerEventId, input.providerEventId)));
  if (existingEvent) {
    // The base lifecycle is already idempotent for an applied terminal
    // target. Re-enter that no-op path for a terminal replay so a recording
    // closure/audit that failed after the first delivery can be retried
    // without ever duplicating the core audit or timeline activity.
    if (input.eventType === "call.completed" || input.eventType === "call.failed") {
      const [session] = await db
        .select({ id: growCallSessions.id, status: growCallSessions.status })
        .from(growCallSessions)
        .where(and(eq(growCallSessions.provider, input.provider), eq(growCallSessions.providerCallId, input.providerCallId)));
      const targetStatus = input.eventType === "call.completed" ? "COMPLETED" : "FAILED";
      if (session?.status === targetStatus) {
        try {
          await applySandboxLifecycleEvent(session.id, EVENT_TYPE_TO_LIFECYCLE_EVENT[input.eventType]);
        } catch {
          // Preserve duplicate-delivery semantics even if a retryable
          // recording-only sink remains unavailable.
        }
      }
    }
    return { status: "DUPLICATE", webhookEventId: existingEvent.id, detail: "Already processed." };
  }

  const [event] = await db
    .insert(growCallWebhookEvents)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payload: input.payload,
    })
    .onConflictDoNothing()
    .returning();

  if (!event) {
    const [raceWinner] = await db
      .select()
      .from(growCallWebhookEvents)
      .where(and(eq(growCallWebhookEvents.provider, input.provider), eq(growCallWebhookEvents.providerEventId, input.providerEventId)));
    if (!raceWinner) throw new Error("Failed to record inbound telephony webhook event.");
    return { status: "DUPLICATE", webhookEventId: raceWinner.id, detail: "Already processed (concurrent delivery)." };
  }

  try {
    const [session] = await db
      .select({ id: growCallSessions.id })
      .from(growCallSessions)
      .where(and(eq(growCallSessions.provider, input.provider), eq(growCallSessions.providerCallId, input.providerCallId)));
    if (!session) {
      await db
        .update(growCallWebhookEvents)
        .set({ processedAt: new Date(), processingStatus: "FAILED", processingError: "No matching call session for this providerCallId." })
        .where(eq(growCallWebhookEvents.id, event.id));
      return { status: "FAILED", webhookEventId: event.id, detail: "No matching call session for this providerCallId." };
    }

    await applySandboxLifecycleEvent(session.id, EVENT_TYPE_TO_LIFECYCLE_EVENT[input.eventType]);

    await db
      .update(growCallWebhookEvents)
      .set({ processedAt: new Date(), processingStatus: "PROCESSED", relatedCallSessionId: session.id })
      .where(eq(growCallWebhookEvents.id, event.id));
    return { status: "PROCESSED", webhookEventId: event.id, detail: `Applied ${input.eventType} to call session ${session.id}.` };
  } catch (err) {
    const message =
      err instanceof CallSessionTransitionError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error processing telephony webhook.";
    await db
      .update(growCallWebhookEvents)
      .set({ processedAt: new Date(), processingStatus: "FAILED", processingError: message })
      .where(eq(growCallWebhookEvents.id, event.id));
    return { status: "FAILED", webhookEventId: event.id, detail: message };
  }
}
