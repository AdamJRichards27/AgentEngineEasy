// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// The thread/message service layer: creating threads and drafts (Sections
// 10, 13), the approval/authority actions (Section 15), and the thin
// wrappers that hand a message to the outbox once it's ready to leave the
// composer. Every write here goes through the same tenant-check + audit
// discipline as the rest of the module; state changes to an existing
// message's status all funnel through outbox.ts's applyMessageTransition so
// there is exactly one place the transition table is enforced.

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  communicationThreads,
  communicationParticipants,
  communicationMessages,
  communicationTemplates,
  properties,
  type CommunicationThread,
  type CommunicationParticipant,
  type CommunicationMessage,
} from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "../audit.js";
import {
  CommunicationTenancyError,
  CommunicationTransitionError,
  type CommunicationChannel,
  type CommunicationClassification,
  type CommunicationDirection,
  type CommunicationMessageStatus,
} from "./types.js";
import { renderTemplate } from "./templates.js";
import { applyMessageTransition, queueMessage, evaluateAndDispatchQueuedMessage, type QueueMessageResult } from "./outbox.js";

export interface CreateThreadInput {
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  subject: string;
  createdByUserId: number;
}

export async function createThread(input: CreateThreadInput): Promise<CommunicationThread> {
  const [property] = await db.select().from(properties).where(eq(properties.id, input.propertyId));
  if (!property || property.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();

  const [row] = await db
    .insert(communicationThreads)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId ?? null,
      subject: input.subject,
      createdByUserId: input.createdByUserId,
    })
    .returning();

  await logAudit({
    userId: input.createdByUserId,
    action: "communication_thread_created",
    recordType: "communication_thread",
    recordId: String(row.id),
    propertyId: input.propertyId,
    updatedValue: row.subject,
  });

  return row;
}

export async function getThread(threadId: number, brokerageId: number): Promise<CommunicationThread> {
  const [thread] = await db.select().from(communicationThreads).where(eq(communicationThreads.id, threadId));
  if (!thread || thread.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  return thread;
}

/** Every thread on a property, most-recently-active first — the property-centred UI's list (Section 10). */
export async function listThreadsForProperty(propertyId: number, brokerageId: number): Promise<CommunicationThread[]> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property || property.brokerageId !== brokerageId) throw new CommunicationTenancyError();

  return db
    .select()
    .from(communicationThreads)
    .where(eq(communicationThreads.propertyId, propertyId))
    .orderBy(desc(communicationThreads.lastActivityAt));
}

/** Statuses that mean "someone needs to act on this" — the Hub's default view (Section 32) leads with these rather than a full firehose. */
const NEEDS_ATTENTION_STATUSES: CommunicationMessageStatus[] = [
  "AWAITING_APPROVAL",
  "BLOCKED_BY_CONSENT",
  "BLOCKED_BY_COST_CONTROL",
  "FAILED",
  "BOUNCED",
  "UNDELIVERABLE",
];

export interface RecentCommunicationRow {
  message: CommunicationMessage;
  propertyAddress: string;
  threadSubject: string;
}

export interface ListRecentMessagesOptions {
  /** Defaults to 50, capped at 200 — this is a summary feed, not a full export. */
  limit?: number;
  /** When true, only the statuses in NEEDS_ATTENTION_STATUSES are returned. */
  needsAttentionOnly?: boolean;
}

/**
 * The Hub route's data source (Section 32): a brokerage-wide, most-recent-
 * first feed of communication messages, each carrying its property's
 * address and thread subject so the Hub can render a useful summary line
 * without a second round-trip per row. This is deliberately a read-only
 * summary feed — INTERNAL_NOTE rows are included because, as in
 * listMessagesForThread, this whole API surface is brokerage-staff only
 * (Section 31); there is no external audience here to hide them from.
 */
export async function listRecentMessagesForBrokerage(
  brokerageId: number,
  options: ListRecentMessagesOptions = {},
): Promise<RecentCommunicationRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions = [eq(communicationMessages.brokerageId, brokerageId)];
  if (options.needsAttentionOnly) {
    conditions.push(inArray(communicationMessages.status, NEEDS_ATTENTION_STATUSES));
  }

  return db
    .select({
      message: communicationMessages,
      propertyAddress: properties.formattedAddress,
      threadSubject: communicationThreads.subject,
    })
    .from(communicationMessages)
    .innerJoin(properties, eq(properties.id, communicationMessages.propertyId))
    .innerJoin(communicationThreads, eq(communicationThreads.id, communicationMessages.threadId))
    .where(and(...conditions))
    .orderBy(desc(communicationMessages.createdAt))
    .limit(limit);
}

export async function listParticipants(threadId: number, brokerageId: number): Promise<CommunicationParticipant[]> {
  await getThread(threadId, brokerageId); // tenant check
  return db.select().from(communicationParticipants).where(eq(communicationParticipants.threadId, threadId));
}

/**
 * A thread's full message history, oldest first (reading order). Internal
 * notes are included — this build's whole API surface is brokerage-staff
 * only (Section 31; there is no external party portal yet), so "hidden from
 * external parties" (Section 6) is enforced by there being no external
 * audience to hide from rather than a filter here. A future external-facing
 * read must filter channel !== "INTERNAL_NOTE" before this data ever
 * reaches that surface.
 */
export async function listMessagesForThread(threadId: number, brokerageId: number): Promise<CommunicationMessage[]> {
  await getThread(threadId, brokerageId); // tenant check
  return db.select().from(communicationMessages).where(eq(communicationMessages.threadId, threadId)).orderBy(communicationMessages.createdAt);
}

export async function getMessage(messageId: number, brokerageId: number): Promise<CommunicationMessage> {
  const [message] = await db.select().from(communicationMessages).where(eq(communicationMessages.id, messageId));
  if (!message || message.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  return message;
}

export interface CreateDraftMessageInput {
  threadId: number;
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  direction?: CommunicationDirection;
  channel: CommunicationChannel;
  classification: CommunicationClassification;
  subject?: string | null;
  bodyText?: string;
  bodyHtml?: string | null;
  senderUserId: number;
  /** Set only when a Pit Crew member is sending as (on behalf of) an agent — Section 12: the recipient-facing identity is the agent's, never Pit Crew's own. */
  sendOnBehalfOfUserId?: number | null;
  recipientParticipantId?: number | null;
  recipientDisplayName?: string | null;
  recipientDestination?: string | null;
  templateId?: number | null;
  placeholderValues?: Record<string, string>;
  createdByUserId: number;
}

/**
 * The restrained composer's write path (Section 13): a single thread, a
 * single resolved recipient, optional template rendering. Always creates a
 * DRAFT — nothing here ever queues or sends.
 */
export async function createDraftMessage(input: CreateDraftMessageInput): Promise<CommunicationMessage> {
  const thread = await getThread(input.threadId, input.brokerageId);

  let recipientDisplayName = input.recipientDisplayName ?? null;
  let recipientDestination = input.recipientDestination ?? null;

  if (input.recipientParticipantId != null) {
    const [participant] = await db.select().from(communicationParticipants).where(eq(communicationParticipants.id, input.recipientParticipantId));
    if (!participant || participant.threadId !== input.threadId) throw new CommunicationTenancyError();
    recipientDisplayName = participant.displayName;
    // SMS/EMAIL go straight to their own channel's destination (no
    // cross-channel fallback — a message drafted for SMS should never
    // silently pick up an email address). PHONE_CALL records a call
    // outcome, so it prefers the mobile number too, falling back to email
    // only if no mobile is on file. EXTERNAL_MESSAGE/INTERNAL_NOTE have no
    // inherent channel preference, so those keep the email-first fallback.
    recipientDestination =
      input.channel === "SMS"
        ? participant.mobile
        : input.channel === "EMAIL"
          ? participant.email
          : input.channel === "PHONE_CALL"
            ? (participant.mobile ?? participant.email ?? null)
            : (participant.email ?? participant.mobile ?? null);
  }

  let subject = input.subject ?? null;
  let bodyText = input.bodyText ?? "";
  let bodyHtml = input.bodyHtml ?? null;
  let templateVersion: number | null = null;

  if (input.templateId != null) {
    const [template] = await db.select().from(communicationTemplates).where(eq(communicationTemplates.id, input.templateId));
    if (!template || (template.brokerageId != null && template.brokerageId !== input.brokerageId)) throw new CommunicationTenancyError();
    const rendered = renderTemplate(template, input.placeholderValues ?? {});
    subject = rendered.subject;
    bodyText = rendered.bodyText;
    bodyHtml = rendered.bodyHtml;
    templateVersion = template.version;
  }

  if (!bodyText.trim() && input.channel !== "PHONE_CALL") {
    throw new CommunicationTransitionError("A draft message needs content — write a body or choose a template.");
  }

  const [row] = await db
    .insert(communicationMessages)
    .values({
      threadId: input.threadId,
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId ?? thread.transactionId ?? null,
      direction: input.direction ?? "OUTBOUND",
      channel: input.channel,
      classification: input.classification,
      status: "DRAFT",
      subject,
      bodyText,
      bodyHtml,
      senderUserId: input.senderUserId,
      sendOnBehalfOfUserId: input.sendOnBehalfOfUserId ?? null,
      recipientParticipantId: input.recipientParticipantId ?? null,
      recipientDisplayName,
      recipientDestination,
      templateId: input.templateId ?? null,
      templateVersion,
      createdByUserId: input.createdByUserId,
      // Step 2 hardening: persist the drafting request's correlationId on
      // the row itself, not just on the COMMUNICATION_MESSAGE_DRAFTED event
      // below. Without this, outbox.ts's dispatch path (`message.correlationId
      // ?? currentCorrelationId()`) always fell through to a FRESH id when
      // dispatch happened outside the original request — which is the
      // common case: dispatchDueMessages() is a boot-time scheduler sweep
      // with no HTTP request (and therefore no ambient context) at all, so
      // every scheduled/retried send was silently starting its own,
      // disconnected correlation chain instead of continuing the one this
      // message was drafted under. Storing it here is what makes
      // "Mock Communications delivery" a provable single-correlationId
      // flow end-to-end regardless of whether dispatch is immediate
      // (same request) or deferred (a later, contextless sweep).
      correlationId: currentCorrelationId(),
    })
    .returning();

  await db.update(communicationThreads).set({ lastActivityAt: new Date(), updatedAt: new Date() }).where(eq(communicationThreads.id, input.threadId));

  await logAudit({
    userId: input.createdByUserId,
    action: "communication_message_drafted",
    recordType: "communication_message",
    recordId: String(row.id),
    propertyId: row.propertyId,
    updatedValue: `${row.channel}/${row.classification} to ${row.recipientDisplayName ?? row.recipientDestination ?? "unknown"}`,
  });

  await publishDomainEvent({
    eventType: "COMMUNICATION_MESSAGE_DRAFTED",
    occurredAt: new Date(),
    propertyId: row.propertyId,
    transactionId: row.transactionId,
    partyId: null,
    brokerageId: row.brokerageId,
    agentId: row.sendOnBehalfOfUserId ?? row.senderUserId ?? null,
    actorType: "USER",
    actorId: input.createdByUserId,
    source: "communications:composer",
    correlationId: row.correlationId ?? currentCorrelationId(),
    causationId: null,
    idempotencyKey: null,
    payload: { messageId: row.id, threadId: row.threadId, channel: row.channel, classification: row.classification },
    metadata: {},
  }).catch((err) => logger.error("publish_domain_event_failed", { eventType: "COMMUNICATION_MESSAGE_DRAFTED", messageId: row.id, error: err instanceof Error ? err.message : String(err) }));

  return row;
}

/**
 * Section 15: which messages need a second set of eyes before they can be
 * queued. Kept as one small, clearly-documented policy function rather than
 * scattered checks — every MARKETING send always needs approval; a Pit Crew
 * send-on-behalf-of-agent always needs the agent's (or an admin's) approval
 * before it goes out under that agent's name (Section 12).
 */
export function requiresApproval(message: Pick<CommunicationMessage, "classification" | "sendOnBehalfOfUserId">): boolean {
  if (message.classification === "MARKETING") return true;
  if (message.sendOnBehalfOfUserId != null) return true;
  return false;
}

export async function requestApproval(messageId: number, brokerageId: number, userId: number, expectedVersion: number): Promise<CommunicationMessage> {
  return applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "AWAITING_APPROVAL",
    expectedVersion,
    actorUserId: userId,
    auditAction: "communication_message_awaiting_approval",
  });
}

export async function approveMessage(messageId: number, brokerageId: number, userId: number, expectedVersion: number): Promise<CommunicationMessage> {
  return applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "APPROVED",
    expectedVersion,
    actorUserId: userId,
    auditAction: "communication_message_approved",
  });
}

export async function cancelMessage(
  messageId: number,
  brokerageId: number,
  userId: number,
  expectedVersion: number,
  reason?: string,
): Promise<CommunicationMessage> {
  const cancelled = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "CANCELLED",
    expectedVersion,
    actorUserId: userId,
    auditAction: "communication_message_cancelled",
  });

  if (reason && reason.trim()) {
    await logAudit({
      userId,
      action: "communication_message_cancel_reason",
      recordType: "communication_message",
      recordId: String(cancelled.id),
      propertyId: cancelled.propertyId,
      updatedValue: reason.trim(),
    });
  }

  return cancelled;
}

/** The composer's "Send" button: enforces Section 15's approval policy, then hands off to the outbox's durable send flow. */
export async function sendMessageNow(messageId: number, brokerageId: number, userId: number, expectedVersion: number): Promise<QueueMessageResult> {
  const existing = await getMessage(messageId, brokerageId);
  if (requiresApproval(existing) && existing.status !== "APPROVED") {
    throw new CommunicationTransitionError("This message requires approval before it can be sent — request approval first.");
  }
  return queueMessage(messageId, brokerageId, userId, expectedVersion);
}

/** For a CANCELLED/BLOCKED_BY_* message a user wants to try again — never mutates a message that's already in flight or terminal-sent. */
export async function requeueMessage(messageId: number, brokerageId: number, userId: number, expectedVersion: number): Promise<QueueMessageResult> {
  const existing = await getMessage(messageId, brokerageId);
  if (existing.status !== "BLOCKED_BY_CONSENT" && existing.status !== "BLOCKED_BY_COST_CONTROL") {
    throw new CommunicationTransitionError(`Only a message blocked by consent or cost control can be requeued (this one is ${existing.status}).`);
  }
  const queued = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "QUEUED",
    expectedVersion,
    actorUserId: userId,
    auditAction: "communication_message_requeued",
  });
  return evaluateAndDispatchQueuedMessage(messageId, brokerageId, userId, queued);
}

export type { CommunicationThread, CommunicationParticipant, CommunicationMessage };
