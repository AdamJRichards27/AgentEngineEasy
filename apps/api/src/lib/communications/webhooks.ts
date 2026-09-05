// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Inbound communication/webhook handling (Section 19):
//   - Idempotent: a redelivered webhook (every provider's documented
//     behaviour) is recognised via communicationWebhookEvents' unique
//     (provider, providerEventId) index and returned as DUPLICATE rather
//     than reprocessed.
//   - Signature-verified: the caller (routes/communicationsWebhooks.ts)
//     passes the exact raw request bytes app.ts's express.json({verify})
//     hook already captures on every request — a provider's HMAC is
//     computed over the bytes it sent, never a re-serialized parsed body.
//   - Tenant-safe: the webhook route is tenant-scoped by URL
//     (/api/communications/webhooks/:brokerageId/:provider), so brokerageId
//     is always a value THIS APP resolved and validated, never trusted from
//     the inbound payload; every matched message's own brokerageId is then
//     cross-checked against it before anything is mutated.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  communicationWebhookEvents,
  communicationMessages,
  type CommunicationWebhookEvent,
  type CommunicationMessage,
} from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { applyMessageTransition } from "./outbox.js";
import { recordConsent, normalizeDestination } from "./consent.js";

export type InboundWebhookEventType = "DELIVERY_RECEIPT" | "INBOUND_MESSAGE" | "BOUNCE" | "OPT_OUT";

export interface VerifyWebhookSignatureInput {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  secret: string;
}

/**
 * HMAC-SHA256 over the exact raw bytes, hex-encoded, compared with a
 * constant-time comparison — the generic shape most webhook providers use.
 * A provider-specific adapter can wrap this if its signature scheme
 * differs; this covers the sandbox/dev path and the common case.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!input.signatureHeader) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const provided = input.signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export interface InboundWebhookInput {
  /** Resolved by the route from its own URL path — never taken from the payload. */
  brokerageId: number;
  provider: string;
  providerEventId: string;
  eventType: InboundWebhookEventType;
  payload: Record<string, unknown>;
  /** Present when the provider payload names the message it concerns (a delivery receipt or bounce). */
  providerMessageId?: string | null;
  /** Present on an OPT_OUT (a "STOP" reply) or an INBOUND_MESSAGE — the sender's own address/number. */
  destination?: string | null;
  destinationChannel?: "EMAIL" | "SMS" | null;
}

export interface ProcessWebhookResult {
  status: "PROCESSED" | "DUPLICATE" | "FAILED";
  webhookEventId: number;
  detail?: string;
}

/**
 * The single entry point routes/communicationsWebhooks.ts calls once a
 * signature has verified. Idempotent by (provider, providerEventId) — a
 * redelivery is recorded as DUPLICATE, never reprocessed.
 */
export async function processInboundWebhook(input: InboundWebhookInput): Promise<ProcessWebhookResult> {
  const [existingEvent] = await db
    .select()
    .from(communicationWebhookEvents)
    .where(and(eq(communicationWebhookEvents.provider, input.provider), eq(communicationWebhookEvents.providerEventId, input.providerEventId)));
  if (existingEvent) {
    return { status: "DUPLICATE", webhookEventId: existingEvent.id, detail: "Already processed." };
  }

  const [event] = await db
    .insert(communicationWebhookEvents)
    .values({
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payload: input.payload,
    })
    .onConflictDoNothing()
    .returning();

  if (!event) {
    // Someone else's insert won the race between our SELECT and our INSERT.
    const [raceWinner] = await db
      .select()
      .from(communicationWebhookEvents)
      .where(and(eq(communicationWebhookEvents.provider, input.provider), eq(communicationWebhookEvents.providerEventId, input.providerEventId)));
    if (!raceWinner) throw new Error("Failed to record inbound webhook event.");
    return { status: "DUPLICATE", webhookEventId: raceWinner.id, detail: "Already processed (concurrent delivery)." };
  }

  try {
    const effect = await applyWebhookEffect(input);
    await db
      .update(communicationWebhookEvents)
      .set({ processedAt: new Date(), processingStatus: "PROCESSED", relatedMessageId: effect.relatedMessageId ?? null })
      .where(eq(communicationWebhookEvents.id, event.id));
    return { status: "PROCESSED", webhookEventId: event.id, detail: effect.summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error processing webhook.";
    await db
      .update(communicationWebhookEvents)
      .set({ processedAt: new Date(), processingStatus: "FAILED", processingError: message })
      .where(eq(communicationWebhookEvents.id, event.id));
    return { status: "FAILED", webhookEventId: event.id, detail: message };
  }
}

interface WebhookEffectResult {
  summary: string;
  relatedMessageId?: number | null;
}

async function applyWebhookEffect(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  switch (input.eventType) {
    case "DELIVERY_RECEIPT":
      return applyDeliveryReceipt(input);
    case "BOUNCE":
      return applyBounce(input);
    case "OPT_OUT":
      return applyOptOut(input);
    case "INBOUND_MESSAGE":
      // Recording an inbound reply as its own message row belongs to
      // messages.ts (it needs thread resolution, participant matching,
      // etc.). This build records the raw event for audit/inspection and
      // leaves reply-threading as deferred scope (see completion report) —
      // but the lifecycle event itself still fires, since
      // packages/events/src/types.ts documents COMMUNICATION_MESSAGE_RECEIVED
      // as part of this module's event coverage regardless of whether a
      // message row exists yet.
      await publishInboundMessageReceivedEvent(input);
      return { summary: "Inbound message event recorded; reply-threading is deferred scope." };
    default:
      return { summary: `Unrecognised event type ${input.eventType} — recorded only.` };
  }
}

// Section 23/25-style domain events for the two outcomes that mutate an
// existing message row (a delivery receipt confirming DELIVERED, or a
// bounce that fails it) — mirrors outbox.ts's publishCommunicationEvent so
// every communication lifecycle event carries the same PublishEventInput
// shape regardless of which module raised it.
type CommunicationWebhookMessageEventType = "COMMUNICATION_MESSAGE_DELIVERED" | "COMMUNICATION_MESSAGE_FAILED";

async function publishCommunicationMessageEvent(
  eventType: CommunicationWebhookMessageEventType,
  message: CommunicationMessage,
): Promise<void> {
  await publishDomainEvent({
    eventType,
    occurredAt: new Date(),
    propertyId: message.propertyId,
    transactionId: message.transactionId,
    partyId: null,
    brokerageId: message.brokerageId,
    agentId: message.sendOnBehalfOfUserId ?? message.senderUserId ?? null,
    actorType: "SYSTEM",
    actorId: null,
    source: "communications:webhooks",
    correlationId: message.correlationId ?? currentCorrelationId(),
    causationId: message.causationId ?? null,
    idempotencyKey: `${eventType}:${message.id}:${message.version}`,
    payload: {
      messageId: message.id,
      threadId: message.threadId,
      channel: message.channel,
      classification: message.classification,
      status: message.status,
      failureCategory: message.failureCategory,
    },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType, messageId: message.id, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * INBOUND_MESSAGE has no message row yet (reply-threading is deferred
 * scope — see applyWebhookEffect above), so this carries only what the
 * webhook itself knows rather than being built from a CommunicationMessage.
 */
async function publishInboundMessageReceivedEvent(input: InboundWebhookInput): Promise<void> {
  await publishDomainEvent({
    eventType: "COMMUNICATION_MESSAGE_RECEIVED",
    occurredAt: new Date(),
    propertyId: null,
    transactionId: null,
    partyId: null,
    brokerageId: input.brokerageId,
    agentId: null,
    actorType: "SYSTEM",
    actorId: null,
    source: "communications:webhooks",
    correlationId: currentCorrelationId(),
    causationId: null,
    idempotencyKey: `COMMUNICATION_MESSAGE_RECEIVED:${input.provider}:${input.providerEventId}`,
    payload: {
      provider: input.provider,
      providerEventId: input.providerEventId,
      destination: input.destination ?? null,
      destinationChannel: input.destinationChannel ?? null,
    },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "COMMUNICATION_MESSAGE_RECEIVED", provider: input.provider, error: err instanceof Error ? err.message : String(err) }));
}

/** Tenant-safe lookup: only ever matches a message that already belongs to the webhook's own (URL-resolved) brokerage. */
async function findMessageForBrokerage(providerMessageId: string | null | undefined, brokerageId: number) {
  if (!providerMessageId) return null;
  const [message] = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.providerMessageId, providerMessageId), eq(communicationMessages.brokerageId, brokerageId)));
  return message ?? null;
}

async function applyDeliveryReceipt(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  const message = await findMessageForBrokerage(input.providerMessageId, input.brokerageId);
  if (!message) return { summary: "No matching message in this brokerage for this delivery receipt — recorded only." };

  if (message.status !== "SENT") {
    return {
      summary: `Message ${message.id} is ${message.status}, not SENT — delivery receipt ignored as stale/out-of-order.`,
      relatedMessageId: message.id,
    };
  }

  const delivered = await applyMessageTransition({
    messageId: message.id,
    brokerageId: message.brokerageId,
    toStatus: "DELIVERED",
    expectedVersion: message.version,
    actorUserId: null,
    patch: { deliveredAt: new Date() },
    auditAction: "communication_message_delivered",
  });
  await publishCommunicationMessageEvent("COMMUNICATION_MESSAGE_DELIVERED", delivered);
  return { summary: `Message ${message.id} marked DELIVERED.`, relatedMessageId: message.id };
}

async function applyBounce(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  const message = await findMessageForBrokerage(input.providerMessageId, input.brokerageId);
  if (!message) return { summary: "No matching message in this brokerage for this bounce — recorded only." };

  if (message.status !== "SENT" && message.status !== "DELIVERED") {
    return { summary: `Message ${message.id} is ${message.status} — bounce ignored as stale/out-of-order.`, relatedMessageId: message.id };
  }

  const bounced = await applyMessageTransition({
    messageId: message.id,
    brokerageId: message.brokerageId,
    toStatus: "BOUNCED",
    expectedVersion: message.version,
    actorUserId: null,
    patch: { failedAt: new Date(), failureCategory: "UNDELIVERABLE_BOUNCE", failureDetail: "The provider reported this message bounced." },
    auditAction: "communication_message_bounced",
  });
  // A bounce is semantically a delivery failure, not its own lifecycle
  // branch — publish the same COMMUNICATION_MESSAGE_FAILED event
  // dispatchMessage() publishes for a provider-side send failure, so every
  // consumer (Exception & Risk's COMM01 rule included) only has to listen
  // for one event type to learn "this message did not get through."
  await publishCommunicationMessageEvent("COMMUNICATION_MESSAGE_FAILED", bounced);
  return { summary: `Message ${message.id} marked BOUNCED.`, relatedMessageId: message.id };
}

async function applyOptOut(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  // Destructured into locals (rather than read off `input` at each use)
  // so the narrowing from the guard below survives the `await
  // recordConsent(...)` call — TS invalidates narrowing on a possibly-
  // aliased object property across an await, but not on a local const.
  const { destination, destinationChannel } = input;
  if (!destination || !destinationChannel) {
    return { summary: "OPT_OUT webhook missing a destination/channel — recorded only, no consent change applied." };
  }

  // A "STOP" reply is the universal signal a recipient no longer wants to
  // hear from this channel at all — it revokes marketing consent
  // explicitly (not merely "leaves it unset") and separately records a
  // transactional opt-out (which Section 16's transactionalOptOutAllowed
  // knob decides whether to actually honour for TRANSACTIONAL/SERVICE
  // sends going forward).
  await recordConsent({
    brokerageId: input.brokerageId,
    channel: destinationChannel,
    destination,
    marketingOptIn: false,
    transactionalOptOut: true,
    source: "WEBHOOK_REPLY_STOP",
  });
  return { summary: `Recorded opt-out for ${normalizeDestination(destinationChannel, destination)}.` };
}

export type { CommunicationWebhookEvent };
