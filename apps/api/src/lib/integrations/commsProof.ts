// Agent Engine 2.0 — AE Step 5 remediation — Proof B (Communications Hub).
//
// Wires the generic integration foundation (registry/outbox/adapter/
// mapping/webhooks) to a second, genuinely different domain than Proof A —
// same discipline as launchProof.ts's own header comment: every mutation
// still runs through Communications' OWN service boundary
// (checkConsent, checkCostControl, applyMessageTransition — outbox.ts), this
// file never writes to communicationMessages directly. Domain-event
// publication at each transition mirrors outbox.ts's own
// publishCommunicationEvent / webhooks.ts's own publishCommunicationMessageEvent
// exactly (this module has its own small private copy — same "each module
// funnels its own publishes through one local helper" convention those two
// files already use rather than a shared export neither of them has).
//
// What this proves (see __tests__/commsProof.test.ts):
//   - An SMS can be sent through the SAME registry -> outbox -> adapter ->
//     mapping -> webhook path Proof A proved for portal publishing, for a
//     request/response send (not Launch's fire-and-forget submission) that
//     also gets an asynchronous inbound delivery-status webhook.
//   - The brokerage's communications.sms subscription entitlement is
//     checked as a SEPARATE authority from the sending user's own role —
//     an admin with role authority but no entitlement is denied; an
//     entitled brokerage with an unauthorised user is denied; holding
//     grow.ai.use never substitutes for communications.sms or vice versa.
//   - Consent, cost-control, and quiet-hours are Communications' OWN
//     existing gates (Sections 16/21/22), applied exactly once, in the
//     same order outbox.ts's own evaluateAndDispatchQueuedMessage uses.
//   - A signed mock delivery webhook, processed through the real gateway,
//     updates the message via applyMessageTransition — never a duplicate
//     write path. Duplicate and stale/out-of-order deliveries produce no
//     duplicate/regressive effect (Proof A's own guarantee, exercised here
//     for a second domain).
//
//   - AE Grow Priority 3: communicationMessages.propertyId is now nullable
//     (a contact-first/party-only message has no property at all).
//     resolveCommsSourceRecord below deliberately returns null for such a
//     message — IntegrationSourceRecordResolution.propertyId is non-null by
//     contract (riskExceptions.propertyId is NOT NULL — see
//     sourceRecordResolvers.ts's own header comment), and there is no
//     property to attach a risk exception to anyway. This mirrors this same
//     resolver's existing "not found/cross-tenant -> null -> rule skips it,
//     never guesses" behaviour; a dead-lettered outbox command behind a
//     contact-first communication simply does not raise an H01 risk
//     exception today (a documented, narrow deferral — see the Priority 3
//     report's Known limitations — not a regression for any
//     property-anchored communication, which resolves exactly as before).

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, communicationMessages, communicationDeliveryAttempts, type CommunicationMessage } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { resolveActiveConnection } from "./registry.js";
import { enqueueCommand, dispatchCommand, mintIdempotencyKey } from "./outbox.js";
import { recordMapping, resolveByExternalId } from "./mapping.js";
import { registerWebhookEffectHandler, type WebhookEffectContext, type WebhookEffectResult } from "./webhooks.js";
import { registerIntegrationSourceRecordResolver } from "./sourceRecordResolvers.js";
import { IntegrationError, INTEGRATION_CAPABILITIES, type ActorRef, type IntegrationFailureCategory } from "./types.js";
import { MOCK_SMS_PROVIDER_ID } from "./adapters/mockSms.js";
import { requireEntitlement } from "../entitlements/resolver.js";
import { EntitlementError } from "../entitlements/types.js";
import { checkConsent } from "../communications/consent.js";
import { checkCostControl, recordCost, SMS_ESTIMATED_COST_CENTS_PER_MESSAGE } from "../communications/costControl.js";
import { isWithinQuietHours, nextAllowedSendTime } from "../communications/quietHours.js";
import { getOrCreateCommunicationSettings } from "../communications/settings.js";
import { applyMessageTransition, patchQueuedSchedule } from "../communications/outbox.js";
import {
  CommunicationTenancyError,
  CommunicationTransitionError,
  type CommunicationChannel,
  type CommunicationClassification,
  type FailureCategory as CommunicationFailureCategory,
} from "../communications/types.js";

export const COMMS_SMS_ENTITLEMENT_KEY = "communications.sms";
export const SMS_DELIVERY_WEBHOOK_EVENT_TYPE = "SMS_DELIVERY_STATUS_UPDATE";
const COMMS_SOURCE_RECORD_TYPE = "communication_message";

// Never leaks the integration layer's own failure vocabulary into
// Communications' column untranslated (Section 4: "transform before
// entering domain workflows") — mirrors applyListingStatusUpdate's own
// discipline of never handing a raw provider field straight to a domain
// table.
function mapIntegrationFailureToCommunicationFailure(category: IntegrationFailureCategory | null | undefined): CommunicationFailureCategory {
  switch (category) {
    case "TRANSIENT_PROVIDER_ERROR":
      return "PROVIDER_UNAVAILABLE";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    case "AUTH_ERROR":
      return "BLOCKED_BY_PROVIDER";
    case "VALIDATION_ERROR":
      return "CONTENT_REJECTED";
    case "PERMANENT_REJECTION":
    default:
      return "BLOCKED_BY_PROVIDER";
  }
}

type CommsProofEventType =
  | "COMMUNICATION_MESSAGE_QUEUED"
  | "COMMUNICATION_MESSAGE_SENT"
  | "COMMUNICATION_MESSAGE_FAILED"
  | "COMMUNICATION_MESSAGE_BLOCKED"
  | "COMMUNICATION_MESSAGE_DELIVERED";

async function publishCommsProofEvent(eventType: CommsProofEventType, message: CommunicationMessage, actorUserId: number | null): Promise<void> {
  await publishDomainEvent({
    eventType,
    occurredAt: new Date(),
    propertyId: message.propertyId,
    transactionId: message.transactionId,
    partyId: null,
    brokerageId: message.brokerageId,
    agentId: message.sendOnBehalfOfUserId ?? message.senderUserId ?? null,
    actorType: actorUserId ? "USER" : "SYSTEM",
    actorId: actorUserId,
    source: "integrations:commsProof",
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
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType, messageId: message.id, brokerageId: message.brokerageId, error: err }));
}

export interface SendSmsViaIntegrationInput {
  messageId: number;
  brokerageId: number;
  connectionId: string;
  actor: ActorRef;
}

export type SendSmsViaIntegrationOutcome = "SENT" | "FAILED" | "RETRY_SCHEDULED" | "DEFERRED_QUIET_HOURS" | "BLOCKED_BY_CONSENT" | "BLOCKED_BY_COST_CONTROL";

export interface SendSmsViaIntegrationResult {
  message: CommunicationMessage;
  outcome: SendSmsViaIntegrationOutcome;
}

/**
 * The outbound half of Proof B. Steps (see this file's own header comment
 * and __tests__/commsProof.test.ts for the full enumerated scenario):
 * validate -> resolve connection (fail-closed) -> entitlement (separate
 * from the caller's own role authority, already enforced by the route's
 * requireRole) -> consent -> cost-control -> quiet-hours -> real
 * transactional outbox -> real mock adapter -> reflect the outcome through
 * Communications' own applyMessageTransition.
 */
export async function sendSmsViaIntegration(input: SendSmsViaIntegrationInput): Promise<SendSmsViaIntegrationResult> {
  const [existing] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, input.messageId));
  if (!existing || existing.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();
  if (existing.channel !== "SMS") {
    throw new CommunicationTransitionError("Only an SMS message can be sent through the integration foundation (Proof B).");
  }
  if (existing.status !== "DRAFT" && existing.status !== "APPROVED") {
    throw new CommunicationTransitionError(`Only a DRAFT or APPROVED message can be sent this way (this one is ${existing.status}).`);
  }
  if (!existing.recipientDestination?.trim()) throw new CommunicationTransitionError("This message has no recipient destination.");
  if (!existing.bodyText?.trim()) throw new CommunicationTransitionError("This message has no content to send.");

  // Fail-closed connection resolution (Section 4) — covers "disabled
  // connection" and "unapproved connection" (capability not an approved
  // scope) directly; resolveActiveConnection also re-derives brokerage
  // config (integrations.enabled) and the integrations.access entitlement.
  await resolveActiveConnection(input.brokerageId, input.connectionId, INTEGRATION_CAPABILITIES.COMMS_SEND_SMS);

  // Subscription entitlement, checked SEPARATELY from the caller's own role
  // authority (already enforced upstream by the route's requireRole) —
  // deliberately a different authority than resolveActiveConnection's own
  // integrations.access check above: this is Communications' OWN
  // per-feature gate (mirrors grow.ai.use's own separation from every other
  // entitlement key), never satisfied by holding integrations.access or
  // grow.ai.use.
  try {
    await requireEntitlement({ id: input.actor.id, role: input.actor.role, brokerageId: input.brokerageId }, COMMS_SMS_ENTITLEMENT_KEY);
  } catch (err) {
    if (err instanceof EntitlementError) {
      throw new IntegrationError("ENTITLEMENT_DENIED", `This brokerage does not hold the ${COMMS_SMS_ENTITLEMENT_KEY} entitlement.`);
    }
    throw err;
  }

  // Transition to QUEUED FIRST — mirrors outbox.ts's own queueMessage ->
  // evaluateAndDispatchQueuedMessage split exactly: the consent/cost-control
  // block edges only exist FROM QUEUED (and DRAFT) in
  // COMMUNICATION_MESSAGE_STATUS_TRANSITIONS, never from APPROVED directly,
  // so the gates below must run against a message already at QUEUED.
  const idempotencyKey = existing.idempotencyKey ?? `msg-${existing.id}-${randomUUID()}`;
  const queued = await applyMessageTransition({
    messageId: existing.id,
    brokerageId: input.brokerageId,
    toStatus: "QUEUED",
    expectedVersion: existing.version,
    actorUserId: input.actor.id,
    patch: { idempotencyKey },
    auditAction: "communication_message_queued",
  });
  await publishCommsProofEvent("COMMUNICATION_MESSAGE_QUEUED", queued, input.actor.id);

  const consentResult = await checkConsent(input.brokerageId, "SMS" as CommunicationChannel, existing.recipientDestination!, existing.classification as CommunicationClassification);
  if (!consentResult.allowed) {
    const blocked = await applyMessageTransition({
      messageId: existing.id,
      brokerageId: input.brokerageId,
      toStatus: "BLOCKED_BY_CONSENT",
      expectedVersion: queued.version,
      actorUserId: input.actor.id,
      patch: { failureCategory: "CONSENT_BLOCKED", failureDetail: consentResult.reason },
      auditAction: "communication_message_blocked_by_consent",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_BLOCKED", blocked, input.actor.id);
    return { message: blocked, outcome: "BLOCKED_BY_CONSENT" };
  }

  const costResult = await checkCostControl(input.brokerageId, input.actor.id, "SMS");
  if (!costResult.allowed) {
    const blocked = await applyMessageTransition({
      messageId: existing.id,
      brokerageId: input.brokerageId,
      toStatus: "BLOCKED_BY_COST_CONTROL",
      expectedVersion: queued.version,
      actorUserId: input.actor.id,
      patch: { failureCategory: "COST_CONTROL_BLOCKED", failureDetail: costResult.reason },
      auditAction: "communication_message_blocked_by_cost_control",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_BLOCKED", blocked, input.actor.id);
    return { message: blocked, outcome: "BLOCKED_BY_COST_CONTROL" };
  }

  const settings = await getOrCreateCommunicationSettings(input.brokerageId);
  const now = new Date();
  if (isWithinQuietHours(now, settings)) {
    const rescheduled = await patchQueuedSchedule(existing.id, input.brokerageId, queued.version, nextAllowedSendTime(now, settings));
    return { message: rescheduled, outcome: "DEFERRED_QUIET_HOURS" };
  }

  const sending = await applyMessageTransition({
    messageId: existing.id,
    brokerageId: input.brokerageId,
    toStatus: "SENDING",
    expectedVersion: queued.version,
    actorUserId: input.actor.id,
    patch: { costEstimateCents: SMS_ESTIMATED_COST_CENTS_PER_MESSAGE },
    auditAction: "communication_message_sending",
  });

  const externalMessageId = `mock-sms-${idempotencyKey}`;
  const command = await enqueueCommand({
    brokerageId: input.brokerageId,
    connectionId: input.connectionId,
    capability: INTEGRATION_CAPABILITIES.COMMS_SEND_SMS,
    commandPayload: { to: existing.recipientDestination, bodyText: existing.bodyText, externalMessageId },
    idempotencyKey: mintIdempotencyKey(`comms-sms:${existing.id}`),
    sourceRecordType: COMMS_SOURCE_RECORD_TYPE,
    sourceRecordId: String(existing.id),
  });
  const dispatched = await dispatchCommand(command.id);

  const attemptNumber = sending.retryCount + 1;

  if (dispatched.status === "SENT") {
    await db.insert(communicationDeliveryAttempts).values({
      messageId: sending.id,
      attemptNumber,
      status: "SENT",
      providerResponseSummary: `Accepted by ${MOCK_SMS_PROVIDER_ID} via the integration foundation (outbox command ${command.id}).`,
    });
    await recordMapping({ connectionId: input.connectionId, brokerageId: input.brokerageId, entityType: COMMS_SOURCE_RECORD_TYPE, internalId: String(existing.id), externalId: externalMessageId });
    await recordCost(input.brokerageId, input.actor.id, "SMS", SMS_ESTIMATED_COST_CENTS_PER_MESSAGE);
    const sent = await applyMessageTransition({
      messageId: existing.id,
      brokerageId: input.brokerageId,
      toStatus: "SENT",
      expectedVersion: sending.version,
      actorUserId: input.actor.id,
      patch: { sentAt: new Date(), provider: MOCK_SMS_PROVIDER_ID, providerMessageId: externalMessageId, costActualCents: SMS_ESTIMATED_COST_CENTS_PER_MESSAGE },
      auditAction: "communication_message_sent",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_SENT", sent, input.actor.id);
    return { message: sent, outcome: "SENT" };
  }

  if (dispatched.status === "DEAD_LETTERED") {
    await db.insert(communicationDeliveryAttempts).values({
      messageId: sending.id,
      attemptNumber,
      status: "FAILED",
      providerResponseSummary: (dispatched.lastError ?? "Dead-lettered by the integration outbox.").slice(0, 500),
      errorDetail: dispatched.lastError ?? null,
    });
    const failed = await applyMessageTransition({
      messageId: existing.id,
      brokerageId: input.brokerageId,
      toStatus: "FAILED",
      expectedVersion: sending.version,
      actorUserId: input.actor.id,
      patch: { failedAt: new Date(), failureCategory: mapIntegrationFailureToCommunicationFailure("PERMANENT_REJECTION"), failureDetail: dispatched.lastError ?? "The mock SMS gateway permanently rejected this message." },
      auditAction: "communication_message_failed",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_FAILED", failed, input.actor.id);
    return { message: failed, outcome: "FAILED" };
  }

  // RETRY_SCHEDULED — the integration outbox's own retry sweep
  // (dispatchDueOutbox) will pick this command back up later. Reflected
  // through the EXACT same FAILED->RETRY_SCHEDULED edge outbox.ts's own
  // dispatchMessage uses for a retryable sandbox failure, translating the
  // integration-layer schedule onto Communications' own status/scheduledAt.
  await db.insert(communicationDeliveryAttempts).values({
    messageId: sending.id,
    attemptNumber,
    status: "FAILED",
    providerResponseSummary: (dispatched.lastError ?? "Transient failure — retry scheduled at the integration layer.").slice(0, 500),
    errorDetail: dispatched.lastError ?? null,
  });
  const transientFailed = await applyMessageTransition({
    messageId: existing.id,
    brokerageId: input.brokerageId,
    toStatus: "FAILED",
    expectedVersion: sending.version,
    actorUserId: input.actor.id,
    patch: { failedAt: new Date(), failureCategory: mapIntegrationFailureToCommunicationFailure("TRANSIENT_PROVIDER_ERROR"), failureDetail: dispatched.lastError ?? null, retryCount: attemptNumber },
    auditAction: "communication_message_failed",
  });
  const rescheduled = await applyMessageTransition({
    messageId: existing.id,
    brokerageId: input.brokerageId,
    toStatus: "RETRY_SCHEDULED",
    expectedVersion: transientFailed.version,
    actorUserId: input.actor.id,
    patch: { scheduledAt: dispatched.nextAttemptAt ?? new Date(Date.now() + 60_000) },
    auditAction: "communication_message_retry_scheduled",
  });
  await publishCommsProofEvent("COMMUNICATION_MESSAGE_FAILED", rescheduled, input.actor.id);
  return { message: rescheduled, outcome: "RETRY_SCHEDULED" };
}

const TERMINAL_DELIVERY_STATUSES = ["DELIVERED", "FAILED", "BOUNCED", "UNDELIVERABLE"];

/**
 * The inbound half of Proof B, registered once at bootstrap
 * (registerCommsIntegrationHandlers below). Transforms the mock SMS
 * gateway's OWN vocabulary (payload.status: "DELIVERED" | "FAILED") into a
 * call on Communications' real service boundary — never a raw provider
 * field reaching communicationMessages directly.
 */
async function applySmsDeliveryStatusUpdate({ connection, inboxRow }: WebhookEffectContext): Promise<WebhookEffectResult> {
  const payload = inboxRow.payload as { externalMessageId?: string; status?: string; failureDetail?: string };
  if (!payload.externalMessageId || !payload.status) {
    throw new Error("Malformed mock SMS delivery webhook — missing externalMessageId or status.");
  }

  const mapping = await resolveByExternalId(connection.id, COMMS_SOURCE_RECORD_TYPE, payload.externalMessageId);
  if (!mapping) {
    return { summary: `No communication message is mapped to external message id ${payload.externalMessageId} — event recorded, no effect applied.` };
  }

  const messageId = Number(mapping.internalId);
  const [message] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, messageId));
  if (!message || message.brokerageId !== connection.brokerageId) {
    // Identical shape to Proof A's own tenant-safety posture — a mapping
    // that no longer resolves to a same-tenant message is treated as
    // unknown, never as a hint the record exists elsewhere.
    return { summary: `Mapped communication message ${messageId} not found in this connection's brokerage — event recorded, no effect applied.` };
  }

  if (TERMINAL_DELIVERY_STATUSES.includes(message.status)) {
    return { summary: `Message ${message.id} is already ${message.status} — duplicate/stale event ignored, no further effect.` };
  }

  if (message.status !== "SENT") {
    return { summary: `Message ${message.id} is ${message.status}, not SENT — delivery event recorded, no effect applied.` };
  }

  if (payload.status === "DELIVERED") {
    const delivered = await applyMessageTransition({
      messageId: message.id,
      brokerageId: connection.brokerageId,
      toStatus: "DELIVERED",
      expectedVersion: message.version,
      actorUserId: null,
      patch: { deliveredAt: new Date() },
      auditAction: "communication_message_delivered",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_DELIVERED", delivered, null);
    return { summary: `Message ${message.id} confirmed DELIVERED via mock SMS gateway webhook.` };
  }

  if (payload.status === "FAILED") {
    const failed = await applyMessageTransition({
      messageId: message.id,
      brokerageId: connection.brokerageId,
      toStatus: "FAILED",
      expectedVersion: message.version,
      actorUserId: null,
      patch: { failedAt: new Date(), failureCategory: mapIntegrationFailureToCommunicationFailure("PERMANENT_REJECTION"), failureDetail: payload.failureDetail ?? "Mock SMS gateway reported delivery failure." },
      auditAction: "communication_message_failed",
    });
    await publishCommsProofEvent("COMMUNICATION_MESSAGE_FAILED", failed, null);
    return { summary: `Message ${message.id} marked FAILED via mock SMS gateway delivery webhook.` };
  }

  return { summary: `Mock SMS gateway sent an unrecognised status "${payload.status}" for message ${message.id} — recorded for audit only, no effect applied.` };
}

async function resolveCommsSourceRecord(brokerageId: number, sourceRecordId: string) {
  const [message] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, Number(sourceRecordId)));
  if (!message || message.brokerageId !== brokerageId) return null;
  // AE Grow Priority 3: a contact-first (party-only) message has no
  // propertyId — IntegrationSourceRecordResolution.propertyId is non-null
  // by contract (see this module's own header comment above), and there is
  // no property to attach a risk exception to, so this is skipped exactly
  // like an unmapped/cross-tenant record rather than guessed at.
  if (message.propertyId == null) return null;
  return { propertyId: message.propertyId, transactionId: message.transactionId };
}

let registered = false;
export function registerCommsIntegrationHandlers(): void {
  if (registered) return;
  registerWebhookEffectHandler(MOCK_SMS_PROVIDER_ID, SMS_DELIVERY_WEBHOOK_EVENT_TYPE, applySmsDeliveryStatusUpdate);
  registerIntegrationSourceRecordResolver(COMMS_SOURCE_RECORD_TYPE, resolveCommsSourceRecord);
  registered = true;
}

export function clearCommsIntegrationHandlersForTesting(): void {
  registered = false;
}
