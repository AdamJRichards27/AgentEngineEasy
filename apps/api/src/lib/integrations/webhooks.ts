// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// The inbound webhook gateway (Section 6): signature verification, replay
// protection, idempotency, tenant-safety, and "transform before entering
// domain workflows" (Section 4) — all enforced here, once, for every
// provider. Mirrors lib/communications/webhooks.ts's own
// verifyWebhookSignature/processInboundWebhook shape, generalised:
//   - Tenant-safe: connectionId (never brokerageId or provider payload
//     content) is resolved from the route's own URL path
//     (routes/integrationsWebhooks.ts), then that connection's OWN
//     brokerageId is what every downstream check uses — a provider can
//     never claim to be a different tenant's webhook.
//   - Idempotent: integration_inbox's unique (connectionId, provider,
//     providerEventId) index — a redelivery is DUPLICATE, never reprocessed.
//   - Transform-before-domain: registerWebhookEffectHandler registers a
//     per-(provider, eventType) handler that receives the RAW payload,
//     transforms it into whatever the target domain service actually
//     needs, and calls that existing domain service — never a raw provider
//     field name reaching a domain table (Section 4). See launchProof.ts
//     for the one handler this build actually registers.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, integrationInbox, integrationConnections, type IntegrationInboxRow, type IntegrationConnection } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger, incrementCounter } from "@aee/events";
import { writeDeadLetter, markReplayed, loadDeadLetterInBrokerage } from "./deadLetters.js";
import { IntegrationError, type InboundIntegrationWebhookInput, type ProcessIntegrationWebhookResult } from "./types.js";
import { dispatchOperationalAlert } from "../operationalAlerts.js";

export interface VerifyWebhookSignatureInput {
  rawBody: Buffer | string;
  signatureHeader: string | undefined;
  secret: string;
}

/** HMAC-SHA256 over the exact raw bytes, constant-time compared — identical scheme to communications/webhooks.ts's verifyWebhookSignature (the generic shape most providers use; a provider-specific adapter wraps this if its scheme differs). */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  if (!input.signatureHeader) return false;
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest("hex");
  const provided = input.signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

// Section 8/security: a hard ceiling on inbound payload size, checked here
// as a defence-in-depth layer independent of app.ts's own express.json()
// limit — never trust a single enforcement point for a resource-exhaustion
// control.
export const MAX_WEBHOOK_PAYLOAD_BYTES = 256 * 1024;

export interface WebhookEffectContext {
  connection: IntegrationConnection;
  inboxRow: IntegrationInboxRow;
}
export interface WebhookEffectResult {
  summary: string;
  relatedOutboxId?: string | null;
}
export type WebhookEffectHandler = (ctx: WebhookEffectContext) => Promise<WebhookEffectResult>;

const effectHandlers = new Map<string, WebhookEffectHandler>();
function handlerKey(provider: string, eventType: string): string {
  return `${provider}::${eventType}`;
}
export function registerWebhookEffectHandler(provider: string, eventType: string, handler: WebhookEffectHandler): void {
  effectHandlers.set(handlerKey(provider, eventType), handler);
}
export function clearWebhookEffectHandlersForTesting(): void {
  effectHandlers.clear();
}

async function publishWebhookRejectedEvent(brokerageId: number | null, provider: string, providerEventId: string, reason: string): Promise<void> {
  logger.warn("integration_webhook_rejected", { provider, providerEventId, reason, brokerageId });
  incrementCounter("integration_webhook_total", { outcome: "rejected" });
  if (brokerageId == null) return; // unresolvable tenant — nothing to scope the event to; the caller's own audit log is the record
  // currentCorrelationId(): this runs synchronously inside the HTTP request
  // that delivered the webhook (routes/integrationsWebhooks.ts, downstream
  // of middlewares/requestId.ts's ambient context) — Step 2 hardening
  // replaces what used to be a fresh, disconnected newCorrelationId() here
  // with that request's own id, so a rejected/quarantined delivery can be
  // tied back to the exact inbound HTTP call that produced it.
  await publishDomainEvent({
    eventType: "INTEGRATION_WEBHOOK_REJECTED" as any,
    occurredAt: new Date(),
    propertyId: null,
    transactionId: null,
    partyId: null,
    brokerageId,
    agentId: null,
    actorType: "SYSTEM",
    actorId: null,
    source: "integrations:webhooks",
    correlationId: currentCorrelationId(),
    causationId: null,
    idempotencyKey: `INTEGRATION_WEBHOOK_REJECTED:${provider}:${providerEventId}`,
    payload: { provider, providerEventId, reason },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "INTEGRATION_WEBHOOK_REJECTED", error: err instanceof Error ? err.message : String(err) }));
}

/**
 * The single entry point routes/integrationsWebhooks.ts calls once
 * signature verification has already run (the route passes signatureValid,
 * never the raw secret, into this function — the gateway records the
 * outcome but the actual HMAC comparison happens at the route, right next
 * to the raw bytes, exactly like communications' own split). An invalid
 * signature or unresolvable connection is REJECTED and quarantined (Section
 * 14's acceptance scenario) — recorded in integration_inbox for audit, but
 * never dispatched to any effect handler.
 */
export async function processInboundWebhook(input: InboundIntegrationWebhookInput): Promise<ProcessIntegrationWebhookResult> {
  const payloadSize = Buffer.byteLength(JSON.stringify(input.payload));
  if (payloadSize > MAX_WEBHOOK_PAYLOAD_BYTES) {
    await publishWebhookRejectedEvent(null, input.provider, input.providerEventId, "PAYLOAD_TOO_LARGE");
    throw new IntegrationError("VALIDATION", `Webhook payload exceeds the ${MAX_WEBHOOK_PAYLOAD_BYTES}-byte limit.`);
  }

  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, input.connectionId));
  if (!connection) {
    await publishWebhookRejectedEvent(null, input.provider, input.providerEventId, "UNKNOWN_CONNECTION");
    throw new IntegrationError("NOT_FOUND", "Unknown integration connection.");
  }

  if (!input.signatureValid) {
    // Recorded for audit even though rejected — Section 14: "invalid
    // signature rejected and quarantined", not silently dropped.
    const [row] = await db
      .insert(integrationInbox)
      .values({
        connectionId: connection.id,
        brokerageId: connection.brokerageId,
        provider: input.provider,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        payload: input.payload,
        signatureValid: false,
        processingStatus: "REJECTED",
        processedAt: new Date(),
        processingError: "Invalid signature.",
      })
      .onConflictDoNothing()
      .returning();
    await publishWebhookRejectedEvent(connection.brokerageId, input.provider, input.providerEventId, "INVALID_SIGNATURE");
    if (row) return { status: "REJECTED", inboxId: row.id, detail: "Invalid signature — quarantined." };
    // A redelivery of an already-rejected event collides on the dedup
    // index; treat it the same as any other duplicate.
    const [existing] = await db
      .select()
      .from(integrationInbox)
      .where(and(eq(integrationInbox.connectionId, connection.id), eq(integrationInbox.provider, input.provider), eq(integrationInbox.providerEventId, input.providerEventId)));
    return { status: "DUPLICATE", inboxId: existing!.id, detail: "Already recorded (invalid signature)." };
  }

  const [existingEvent] = await db
    .select()
    .from(integrationInbox)
    .where(and(eq(integrationInbox.connectionId, connection.id), eq(integrationInbox.provider, input.provider), eq(integrationInbox.providerEventId, input.providerEventId)));
  if (existingEvent) {
    return { status: "DUPLICATE", inboxId: existingEvent.id, detail: "Already processed." };
  }

  const [event] = await db
    .insert(integrationInbox)
    .values({
      connectionId: connection.id,
      brokerageId: connection.brokerageId,
      provider: input.provider,
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      payload: input.payload,
      signatureValid: true,
    })
    .onConflictDoNothing()
    .returning();

  if (!event) {
    // Someone else's insert won the race between our SELECT and our INSERT.
    const [raceWinner] = await db
      .select()
      .from(integrationInbox)
      .where(and(eq(integrationInbox.connectionId, connection.id), eq(integrationInbox.provider, input.provider), eq(integrationInbox.providerEventId, input.providerEventId)));
    if (!raceWinner) throw new Error("Failed to record inbound integration webhook event.");
    return { status: "DUPLICATE", inboxId: raceWinner.id, detail: "Already processed (concurrent delivery)." };
  }

  try {
    const handler = effectHandlers.get(handlerKey(input.provider, input.eventType));
    if (!handler) {
      await db.update(integrationInbox).set({ processedAt: new Date(), processingStatus: "PROCESSED" }).where(eq(integrationInbox.id, event.id));
      return { status: "PROCESSED", inboxId: event.id, detail: `No effect handler registered for ${input.provider}/${input.eventType} — recorded only.` };
    }
    const effect = await handler({ connection, inboxRow: event });
    await db.update(integrationInbox).set({ processedAt: new Date(), processingStatus: "PROCESSED", relatedOutboxId: effect.relatedOutboxId ?? null }).where(eq(integrationInbox.id, event.id));
    logger.info("integration_webhook_processed", { provider: input.provider, eventType: input.eventType, inboxId: event.id, connectionId: connection.id, brokerageId: connection.brokerageId });
    incrementCounter("integration_webhook_total", { outcome: "processed" });
    return { status: "PROCESSED", inboxId: event.id, detail: effect.summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error processing webhook.";
    await db.update(integrationInbox).set({ processedAt: new Date(), processingStatus: "FAILED", processingError: message }).where(eq(integrationInbox.id, event.id));
    await writeDeadLetter({
      brokerageId: connection.brokerageId,
      connectionId: connection.id,
      sourceType: "INBOX",
      sourceId: String(event.id),
      reason: message,
      payloadSnapshot: { provider: input.provider, eventType: input.eventType, payload: input.payload },
    });
    logger.error("integration_webhook_dead_lettered", { provider: input.provider, eventType: input.eventType, inboxId: event.id, connectionId: connection.id, brokerageId: connection.brokerageId, reason: message });
    await dispatchOperationalAlert({
      type: "INTEGRATION_WEBHOOK_FAILURE",
      summary: "Integration webhook processing failed",
      dedupKey: `integration-webhook:${input.provider}:${input.providerEventId}`,
      details: { provider: input.provider, eventType: input.eventType, connectionId: connection.id, brokerageId: connection.brokerageId, inboxId: event.id },
    });
    incrementCounter("integration_webhook_total", { outcome: "failed" });
    incrementCounter("integration_dead_letter_total", { source_type: "INBOX" });
    return { status: "FAILED", inboxId: event.id, detail: message };
  }
}

/** Controlled replay for an INBOX-sourced dead letter — re-enters processInboundWebhook's own handler dispatch, never a shortcut (mirrors outbox.ts's replayDeadLetteredCommand). */
export async function replayDeadLetteredWebhook(deadLetterId: string, brokerageId: number, actor: { id: number }): Promise<{ result: ProcessIntegrationWebhookResult | null }> {
  const letter = await loadDeadLetterInBrokerage(deadLetterId, brokerageId);
  if (letter.sourceType !== "INBOX") throw new IntegrationError("VALIDATION", "This dead letter is not an inbound webhook.");

  const inboxId = Number(letter.sourceId);
  const [inboxRow] = await db.select().from(integrationInbox).where(eq(integrationInbox.id, inboxId));
  if (!inboxRow) throw new IntegrationError("NOT_FOUND", "The original inbound webhook record no longer exists.");
  const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, inboxRow.connectionId));
  if (!connection) throw new IntegrationError("NOT_FOUND", "The connection for this webhook no longer exists.");

  try {
    const handler = effectHandlers.get(handlerKey(inboxRow.provider, inboxRow.eventType));
    if (!handler) {
      await markReplayed(deadLetterId, actor.id, "FAILED", "No effect handler registered — nothing to replay.");
      return { result: null };
    }
    const effect = await handler({ connection, inboxRow });
    await db.update(integrationInbox).set({ processedAt: new Date(), processingStatus: "PROCESSED", processingError: null, relatedOutboxId: effect.relatedOutboxId ?? null }).where(eq(integrationInbox.id, inboxRow.id));
    await markReplayed(deadLetterId, actor.id, "SUCCESS", null);
    // currentCorrelationId() here is the REPLAY request's own id (this
    // function runs inside the admin's HTTP request to trigger a replay,
    // under the same requestId ambient context) — deliberately distinct
    // from the original inboxRow delivery's id, since integration_inbox has
    // no persisted correlationId column to re-establish that original chain
    // from (see docs/OBSERVABILITY_STANDARD.md's known-limitations note).
    logger.info("integration_webhook_replayed", { deadLetterId, inboxId: inboxRow.id, actorId: actor.id, outcome: "SUCCESS", correlationId: currentCorrelationId() });
    incrementCounter("integration_replay_total", { outcome: "success" });
    return { result: { status: "PROCESSED", inboxId: inboxRow.id, detail: effect.summary } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Replay threw an unexpected error.";
    await markReplayed(deadLetterId, actor.id, "FAILED", message);
    logger.error("integration_webhook_replay_failed", { deadLetterId, inboxId: inboxRow.id, actorId: actor.id, error: message, correlationId: currentCorrelationId() });
    incrementCounter("integration_replay_total", { outcome: "failure" });
    throw err;
  }
}
