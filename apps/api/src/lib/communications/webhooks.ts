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
//
// AE GROW PRIORITY 3: findMessageForBrokerage() below resolves a message by
// (providerMessageId, brokerageId, provider) only — it never referenced
// propertyId — so it already correctly matches a contact-first message
// (propertyId null, partyId set) with no changes required. The only fix
// this priority needed here was publishCommunicationMessageEvent no longer
// hardcoding partyId to null.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  db,
  communicationWebhookEvents,
  communicationMessages,
  communicationThreads,
  communicationParticipants,
  type CommunicationWebhookEvent,
  type CommunicationMessage,
  type CommunicationThread,
} from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "../audit.js";
import { applyMessageTransition } from "./outbox.js";
import { recordConsent, normalizeDestination } from "./consent.js";
import { assertCommunicationAnchor, type CommunicationClassification } from "./types.js";

export type InboundWebhookEventType = "DELIVERY_RECEIPT" | "INBOUND_MESSAGE" | "BOUNCE" | "OPT_OUT";

export interface VerifyWebhookSignatureInput {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  timestamp: string | undefined;
  secret: string;
}

/**
 * HMAC-SHA256 over the exact raw bytes, hex-encoded, compared with a
 * constant-time comparison — the generic shape most webhook providers use.
 * A provider-specific adapter can wrap this if its signature scheme
 * differs; this covers the sandbox/dev path and the common case.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!input.signatureHeader || !input.timestamp) return false;
  const expected = createHmac("sha256", input.secret).update(input.timestamp).update(".").update(input.rawBody).digest("hex");
  const provided = input.signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

export const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
export function isWebhookTimestampFresh(timestamp: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !/^\d{10,13}$/.test(timestamp)) return false;
  const raw = Number(timestamp);
  const timestampMs = timestamp.length === 10 ? raw * 1_000 : raw;
  return Number.isSafeInteger(timestampMs) && Math.abs(now - timestampMs) <= WEBHOOK_TIMESTAMP_TOLERANCE_MS;
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
      return applyInboundMessage(input);
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
    // AE Grow Priority 3: previously hardcoded null — now the message's
    // real, denormalised partyId, matching outbox.ts's own
    // publishCommunicationEvent fix.
    partyId: message.partyId,
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
 * COMMUNICATION_MESSAGE_RECEIVED fires for every accepted inbound webhook.
 * When a conversation in this brokerage resolves, the event carries that
 * message and thread. When it does not, the event still records the
 * receipt and does not invent a thread id.
 */
async function publishInboundMessageReceivedEvent(
  input: InboundWebhookInput,
  message: CommunicationMessage | null,
): Promise<void> {
  await publishDomainEvent({
    eventType: "COMMUNICATION_MESSAGE_RECEIVED",
    occurredAt: new Date(),
    propertyId: message?.propertyId ?? null,
    transactionId: message?.transactionId ?? null,
    partyId: message?.partyId ?? null,
    brokerageId: input.brokerageId,
    agentId: null,
    actorType: "SYSTEM",
    actorId: null,
    source: "communications:webhooks",
    correlationId: message?.correlationId ?? currentCorrelationId(),
    causationId: null,
    idempotencyKey: `COMMUNICATION_MESSAGE_RECEIVED:${input.provider}:${input.providerEventId}`,
    payload: {
      provider: input.provider,
      providerEventId: input.providerEventId,
      destination: input.destination ?? null,
      destinationChannel: input.destinationChannel ?? null,
      messageId: message?.id ?? null,
      threadId: message?.threadId ?? null,
      channel: message?.channel ?? null,
      classification: message?.classification ?? null,
      status: message?.status ?? null,
    },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "COMMUNICATION_MESSAGE_RECEIVED", provider: input.provider, error: err instanceof Error ? err.message : String(err) }));
}

/** Statuses a contact can actually be replying to. Drafts and unsent blocks are not a conversation yet. */
const INBOUND_REPLY_TARGET_STATUSES = ["SENT", "DELIVERED", "RECEIVED", "BOUNCED"] as const;

function inboundIdempotencyKey(provider: string, providerEventId: string): string {
  return `inbound:${provider}:${providerEventId}`;
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inboundBodyText(payload: Record<string, unknown>): string {
  return payloadString(payload, "bodyText") ?? payloadString(payload, "body") ?? payloadString(payload, "text") ?? "";
}

function inboundSubject(payload: Record<string, unknown>, priorSubject: string | null): string | null {
  const explicit = payloadString(payload, "subject");
  if (explicit) return explicit;
  if (!priorSubject) return null;
  return priorSubject.startsWith("Re:") ? priorSubject : `Re: ${priorSubject}`;
}

/**
 * Same normalisation consent uses, expressed in SQL so a stored
 * "Buyer@Example.com" or "0400 123 456" matches the webhook's sender.
 * A leading "+" is significant: "+61400…" and "0400…" are not treated as
 * the same number.
 */
function destinationEquals(column: SQL | unknown, channel: "EMAIL" | "SMS", raw: string): SQL {
  const normalized = normalizeDestination(channel, raw);
  if (!normalized || normalized === "+") return sql`false`;
  if (channel === "EMAIL") {
    return sql`lower(btrim(${column})) = ${normalized}`;
  }
  const digits = normalized.startsWith("+") ? normalized.slice(1) : normalized;
  if (!digits) return sql`false`;
  const storedDigits = sql`regexp_replace(btrim(${column}), '[^0-9]', '', 'g')`;
  if (normalized.startsWith("+")) {
    return sql`${column} is not null and left(btrim(${column}), 1) = '+' and ${storedDigits} = ${digits}`;
  }
  return sql`${column} is not null and coalesce(left(btrim(${column}), 1), '') <> '+' and ${storedDigits} = ${digits}`;
}

function replyChannel(messageChannel: string, destinationChannel: "EMAIL" | "SMS" | null | undefined): "EMAIL" | "SMS" | null {
  if (destinationChannel === "EMAIL" || destinationChannel === "SMS") {
    if (messageChannel === destinationChannel) return destinationChannel;
    if (messageChannel !== "EMAIL" && messageChannel !== "SMS") return destinationChannel;
    return null;
  }
  if (messageChannel === "EMAIL" || messageChannel === "SMS") return messageChannel;
  return null;
}

function asClassification(value: string): CommunicationClassification {
  if (value === "TRANSACTIONAL" || value === "SERVICE" || value === "MARKETING") return value;
  return "TRANSACTIONAL";
}

interface ResolvedInboundReply {
  thread: CommunicationThread;
  replyTo: CommunicationMessage | null;
  channel: "EMAIL" | "SMS";
  recipientParticipantId: number | null;
  recipientDisplayName: string | null;
  recipientDestination: string | null;
}

async function threadForBrokerage(threadId: number, brokerageId: number): Promise<CommunicationThread | null> {
  const [thread] = await db.select().from(communicationThreads).where(eq(communicationThreads.id, threadId));
  if (!thread || thread.brokerageId !== brokerageId) return null;
  return thread;
}

/**
 * Resolve the conversation this reply belongs to, inside the webhook's
 * brokerage only. A providerMessageId names the prior message. Failing
 * that, the sender address names the latest sent/received message on this
 * provider and channel, then the latest thread whose participant carries
 * that address. Nothing in the payload (thread id, brokerage id, property
 * id) is trusted.
 */
async function resolveInboundReply(input: InboundWebhookInput): Promise<ResolvedInboundReply | null> {
  const destinationChannel = input.destinationChannel === "EMAIL" || input.destinationChannel === "SMS" ? input.destinationChannel : null;

  if (input.providerMessageId) {
    const prior = await findMessageForBrokerage(input.providerMessageId, input.brokerageId, input.provider);
    const channel = prior ? replyChannel(prior.channel, destinationChannel) : null;
    if (prior && channel) {
      const thread = await threadForBrokerage(prior.threadId, input.brokerageId);
      if (thread) {
        return {
          thread,
          replyTo: prior,
          channel,
          recipientParticipantId: prior.recipientParticipantId,
          recipientDisplayName: prior.recipientDisplayName,
          recipientDestination: input.destination ?? prior.recipientDestination,
        };
      }
    }
  }

  if (!input.destination || !destinationChannel) return null;
  const normalizedDestination = normalizeDestination(destinationChannel, input.destination);
  if (!normalizedDestination || normalizedDestination === "+") return null;

  const [byDestination] = await db
    .select()
    .from(communicationMessages)
    .where(
      and(
        eq(communicationMessages.brokerageId, input.brokerageId),
        eq(communicationMessages.provider, input.provider),
        eq(communicationMessages.channel, destinationChannel),
        inArray(communicationMessages.status, [...INBOUND_REPLY_TARGET_STATUSES]),
        destinationEquals(communicationMessages.recipientDestination, destinationChannel, input.destination),
      ),
    )
    .orderBy(desc(communicationMessages.createdAt), desc(communicationMessages.id))
    .limit(1);
  if (byDestination) {
    const thread = await threadForBrokerage(byDestination.threadId, input.brokerageId);
    if (thread) {
      return {
        thread,
        replyTo: byDestination,
        channel: destinationChannel,
        recipientParticipantId: byDestination.recipientParticipantId,
        recipientDisplayName: byDestination.recipientDisplayName,
        recipientDestination: normalizedDestination,
      };
    }
  }

  const participantColumn = destinationChannel === "EMAIL" ? communicationParticipants.email : communicationParticipants.mobile;
  const [participantRow] = await db
    .select({ participant: communicationParticipants, thread: communicationThreads })
    .from(communicationParticipants)
    .innerJoin(communicationThreads, eq(communicationThreads.id, communicationParticipants.threadId))
    .where(
      and(
        eq(communicationThreads.brokerageId, input.brokerageId),
        destinationEquals(participantColumn, destinationChannel, input.destination),
      ),
    )
    .orderBy(desc(communicationThreads.lastActivityAt), desc(communicationThreads.id))
    .limit(1);
  if (!participantRow || participantRow.thread.brokerageId !== input.brokerageId) return null;
  return {
    thread: participantRow.thread,
    replyTo: null,
    channel: destinationChannel,
    recipientParticipantId: participantRow.participant.id,
    recipientDisplayName: participantRow.participant.displayName,
    recipientDestination: normalizedDestination,
  };
}

async function applyInboundMessage(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  const resolved = await resolveInboundReply(input);
  if (!resolved) {
    await publishInboundMessageReceivedEvent(input, null);
    return { summary: "Inbound message event recorded; no conversation in this brokerage matched this reply." };
  }

  assertCommunicationAnchor(resolved.thread.propertyId, resolved.thread.partyId);
  const idempotencyKey = inboundIdempotencyKey(input.provider, input.providerEventId);
  const [inserted] = await db
    .insert(communicationMessages)
    .values({
      threadId: resolved.thread.id,
      brokerageId: input.brokerageId,
      propertyId: resolved.thread.propertyId,
      partyId: resolved.thread.partyId,
      transactionId: resolved.thread.transactionId,
      direction: "INBOUND",
      channel: resolved.channel,
      classification: resolved.replyTo ? asClassification(resolved.replyTo.classification) : "TRANSACTIONAL",
      status: "RECEIVED",
      subject: inboundSubject(input.payload, resolved.replyTo?.subject ?? resolved.thread.subject),
      bodyText: inboundBodyText(input.payload),
      recipientParticipantId: resolved.recipientParticipantId,
      recipientDisplayName: resolved.recipientDisplayName,
      recipientDestination: resolved.recipientDestination,
      provider: input.provider,
      // The webhook's providerMessageId names the prior outbound, when it
      // names one. Copying it onto this row would make a later delivery
      // receipt match either message.
      providerMessageId: null,
      replyToMessageId: resolved.replyTo?.id ?? null,
      idempotencyKey,
      correlationId: currentCorrelationId(),
    })
    .onConflictDoNothing({ target: communicationMessages.idempotencyKey })
    .returning();

  const message = inserted ?? (await findInboundMessageByIdempotencyKey(idempotencyKey, input.brokerageId));
  if (!message) {
    throw new Error("Inbound reply could not be recorded for this brokerage.");
  }

  if (inserted) {
    await db
      .update(communicationThreads)
      .set({ lastActivityAt: new Date(), updatedAt: new Date() })
      .where(and(eq(communicationThreads.id, resolved.thread.id), eq(communicationThreads.brokerageId, input.brokerageId)));
    await logAudit({
      brokerageId: input.brokerageId,
      userId: null,
      action: "communication_message_received",
      recordType: "communication_message",
      recordId: String(message.id),
      propertyId: message.propertyId ?? undefined,
      updatedValue: `${message.channel} reply on thread ${message.threadId}`,
    });
  }

  await publishInboundMessageReceivedEvent(input, message);
  return {
    summary: `Inbound reply recorded as message ${message.id} on thread ${message.threadId}.`,
    relatedMessageId: message.id,
  };
}

async function findInboundMessageByIdempotencyKey(idempotencyKey: string, brokerageId: number): Promise<CommunicationMessage | null> {
  const [existing] = await db.select().from(communicationMessages).where(eq(communicationMessages.idempotencyKey, idempotencyKey));
  if (!existing || existing.brokerageId !== brokerageId) return null;
  return existing;
}

/** Tenant-safe lookup: only ever matches a message that already belongs to the webhook's own (URL-resolved) brokerage. */
async function findMessageForBrokerage(providerMessageId: string | null | undefined, brokerageId: number, provider: string) {
  if (!providerMessageId) return null;
  const [message] = await db
    .select()
    .from(communicationMessages)
    .where(
      and(
        eq(communicationMessages.providerMessageId, providerMessageId),
        eq(communicationMessages.brokerageId, brokerageId),
        eq(communicationMessages.provider, provider),
      ),
    );
  return message ?? null;
}

async function applyDeliveryReceipt(input: InboundWebhookInput): Promise<WebhookEffectResult> {
  const message = await findMessageForBrokerage(input.providerMessageId, input.brokerageId, input.provider);
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
  const message = await findMessageForBrokerage(input.providerMessageId, input.brokerageId, input.provider);
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
