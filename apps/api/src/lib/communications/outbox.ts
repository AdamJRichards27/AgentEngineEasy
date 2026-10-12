// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// The durable outbox send flow (Section 20): validate -> queue -> dispatch
// -> record, with bounded/idempotent/audited retries for retryable
// failures only. Concretely, queueMessage() + dispatchMessage() below walk
// a message through these steps:
//
//   1. Load the message and verify tenancy.
//   2. Validate it is actually ready to leave the composer (correct source
//      status, a channel that isn't INTERNAL_NOTE, a real recipient
//      destination, non-empty content).
//   3. Mint an idempotencyKey (once — never re-minted on retry) and
//      transition DRAFT/APPROVED -> QUEUED.
//   4. Record-only channels (PHONE_CALL/EXTERNAL_MESSAGE) skip straight to
//      step 9 — they are a record of something that already happened, not
//      a send this app performs, so consent/cost/quiet-hours never apply.
//   5. Consent gate (Section 16) — blocks to BLOCKED_BY_CONSENT.
//   6. Cost-control gate (Section 21, SMS only) — blocks to
//      BLOCKED_BY_COST_CONTROL.
//   7. Quiet-hours gate (Section 22) — if the effective send time falls
//      inside a configured window, the message stays QUEUED with its
//      scheduledAt pushed to the window's end; dispatchDueMessages() (the
//      boot-time scheduler) picks it up later.
//   8. Otherwise dispatch immediately: QUEUED/RETRY_SCHEDULED -> SENDING.
//   8a. AE GROW W1-A (A-3): dispatchMessage() re-runs the step 5 consent
//      check itself, immediately before SENDING, for every dispatched
//      channel. Steps 1-7 only run on the enqueue path; the boot-time sweep
//      dispatchDueMessages() calls dispatchMessage() directly, so a message
//      deferred past quiet hours or waiting out a retry backoff would
//      otherwise be delivered on a consent decision made minutes or hours
//      earlier. Blocks to BLOCKED_BY_CONSENT, same as step 5.
//   9. Call the provider-neutral adapter (Sections 17-18).
//  10. Record a communicationDeliveryAttempts row — append-only, one per
//      attempt, never edited.
//  11. On SENT: record actual SMS cost, transition to SENT, publish
//      COMMUNICATION_MESSAGE_SENT.
//  12. On FAILED with a retryable failure category and attempts remaining:
//      FAILED -> RETRY_SCHEDULED with a capped exponential backoff.
//  13. On FAILED with a non-retryable category or exhausted retries:
//      terminal FAILED, publish COMMUNICATION_MESSAGE_FAILED — the
//      Exception & Risk Engine's communicationDelivery.ts rule listens for
//      this (Section 24).
//
// AE GROW PRIORITY 3: this send path (queueMessage -> evaluateAndDispatch-
// QueuedMessage -> dispatchMessage) is the SOLE place sandboxEmailProvider/
// sandboxSmsProvider are ever called. GP-4 refuses a party-linked EMAIL/SMS
// send before the QUEUED transition unless legacy destination consent and an
// affirmative F2 consent head both exist, and DNC always blocks. A message
// that was already queued (quiet-hours deferral, retry sweep) is moved to
// BLOCKED_BY_CONSENT by the same gate instead of reaching a provider.
//
// AE GROW W3-B: the two provider calls in dispatchMessage() below now go
// through providers/registry.ts's resolveEmailProvider()/resolveSmsProvider()
// rather than naming the sandbox adapters directly. With no environment set
// those resolvers return the very same sandbox singletons this file used to
// import, so the dispatch path is unchanged; what changed is that there is
// now a single place where a future vendor adapter would be selected, and
// that place is gated by LIVE_COMMUNICATIONS_APPROVED. Resolution happens
// BEFORE the QUEUED -> SENDING transition on purpose — see the comment at
// the resolution site for why a misconfiguration must not be laundered into
// a delivery attempt.

import { and, asc, eq, isNotNull, lte, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, communicationDeliveryAttempts, communicationMessages, type CommunicationMessage } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger, incrementCounter } from "@aee/events";
import { logAudit } from "../audit.js";
import {
  CommunicationConcurrencyError,
  CommunicationTenancyError,
  CommunicationTransitionError,
  isDispatchedChannel,
  isInternalOnlyChannel,
  isRetryableFailure,
  isValidCommunicationStatusTransition,
  type CommunicationChannel,
  type CommunicationMessageStatus,
} from "./types.js";
import { APPROVAL_REQUIRED_BEFORE_SEND, requiresApproval } from "./approvalPolicy.js";
import { assertMessageMayLeave, OutboundConsentRefused } from "./outboundConsent.js";
import { checkCostControl, recordCost, SMS_ESTIMATED_COST_CENTS_PER_MESSAGE } from "./costControl.js";
import { isWithinQuietHours, nextAllowedSendTime } from "./quietHours.js";
import { getOrCreateCommunicationSettings } from "./settings.js";
import { SANDBOX_EMAIL_PROVIDER_NAME } from "./providers/sandboxEmail.js";
import { SANDBOX_SMS_PROVIDER_NAME } from "./providers/sandboxSms.js";
import { resolveEmailProvider, resolveSmsProvider } from "./providers/registry.js";
import type { EmailProvider, ProviderSendResult, SmsProvider } from "./providers/types.js";

interface MessageTransitionPatch {
  subject?: string | null;
  scheduledAt?: Date | null;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  failedAt?: Date | null;
  failureCategory?: string | null;
  failureDetail?: string | null;
  retryCount?: number;
  provider?: string | null;
  providerMessageId?: string | null;
  idempotencyKey?: string | null;
  costEstimateCents?: number | null;
  costActualCents?: number | null;
}

export interface ApplyMessageTransitionInput {
  messageId: number;
  brokerageId: number;
  toStatus: CommunicationMessageStatus;
  expectedVersion: number;
  actorUserId: number | null;
  patch?: MessageTransitionPatch;
  auditAction: string;
}

/**
 * The one place a communicationMessages.status changes (mirrors
 * pit_crew_assignments' applyTransition template): tenant-checked,
 * transition-table-validated, optimistic-concurrency UPDATE, then audited.
 * Exported so messages.ts's approve/cancel actions reuse this instead of a
 * second copy of the same guardrails.
 */
export async function applyMessageTransition(input: ApplyMessageTransitionInput): Promise<CommunicationMessage> {
  const [existing] = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.id, input.messageId), eq(communicationMessages.brokerageId, input.brokerageId)));
  if (!existing || existing.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();
  if (existing.version !== input.expectedVersion) throw new CommunicationConcurrencyError();
  if (!isValidCommunicationStatusTransition(existing.status as CommunicationMessageStatus, input.toStatus)) {
    throw new CommunicationTransitionError(`Cannot move a communication message from ${existing.status} to ${input.toStatus}.`);
  }

  const [row] = await db
    .update(communicationMessages)
    .set({ status: input.toStatus, version: existing.version + 1, updatedAt: new Date(), ...input.patch })
    .where(
      and(
        eq(communicationMessages.id, input.messageId),
        eq(communicationMessages.brokerageId, input.brokerageId),
        eq(communicationMessages.version, input.expectedVersion),
      ),
    )
    .returning();
  if (!row) throw new CommunicationConcurrencyError();

  await logAudit({
    userId: input.actorUserId ?? undefined,
    action: input.auditAction,
    recordType: "communication_message",
    recordId: String(row.id),
    // AE Grow Priority 3: propertyId is nullable now (a contact-first
    // message has none) — logAudit's own propertyId field is
    // `number | undefined`, never `null`.
    propertyId: row.propertyId ?? undefined,
    previousValue: existing.status,
    updatedValue: row.status,
  });

  return row;
}

/**
 * A same-status patch (no transition) with the same optimistic-concurrency
 * guarantee — used to push scheduledAt out for a quiet-hours deferral.
 * Exported (AE Step 5 remediation, Proof B) so commsProof.ts's integration-
 * backed send path can defer past quiet hours using the exact same
 * primitive this file's own evaluateAndDispatchQueuedMessage uses, rather
 * than a second copy of the same raw update.
 */
export async function patchQueuedSchedule(messageId: number, brokerageId: number, expectedVersion: number, scheduledAt: Date): Promise<CommunicationMessage> {
  const [row] = await db
    .update(communicationMessages)
    .set({ scheduledAt, version: expectedVersion + 1, updatedAt: new Date() })
    .where(and(eq(communicationMessages.id, messageId), eq(communicationMessages.brokerageId, brokerageId), eq(communicationMessages.version, expectedVersion)))
    .returning();
  if (!row) throw new CommunicationConcurrencyError();
  return row;
}

type CommunicationOutboxEventType =
  | "COMMUNICATION_MESSAGE_QUEUED"
  | "COMMUNICATION_MESSAGE_SENT"
  | "COMMUNICATION_MESSAGE_FAILED"
  | "COMMUNICATION_MESSAGE_BLOCKED";

async function publishCommunicationEvent(eventType: CommunicationOutboxEventType, message: CommunicationMessage, actorUserId: number | null): Promise<void> {
  await publishDomainEvent({
    eventType,
    occurredAt: new Date(),
    propertyId: message.propertyId,
    transactionId: message.transactionId,
    // AE Grow Priority 3: previously hardcoded null (no partyId column
    // existed on communicationMessages yet) — now the message's real,
    // denormalised partyId, so a contact-first message's own lifecycle
    // events (queued/sent/failed/blocked) carry its party the same way a
    // property-first message's events carry its property.
    partyId: message.partyId,
    brokerageId: message.brokerageId,
    agentId: message.sendOnBehalfOfUserId ?? message.senderUserId ?? null,
    actorType: actorUserId ? "USER" : "SYSTEM",
    actorId: actorUserId,
    source: "communications:outbox",
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

/** A message already at QUEUED or RETRY_SCHEDULED failed the consent gate. It must not be dispatched. */
async function blockAlreadyQueuedForConsent(
  message: CommunicationMessage,
  brokerageId: number,
  actorUserId: number | null,
  refusal: OutboundConsentRefused,
): Promise<CommunicationMessage> {
  const blocked = await applyMessageTransition({
    messageId: message.id,
    brokerageId,
    toStatus: "BLOCKED_BY_CONSENT",
    expectedVersion: message.version,
    actorUserId,
    patch: { failureCategory: "CONSENT_BLOCKED", failureDetail: refusal.message },
    auditAction: "communication_message_blocked_by_consent",
  });
  await publishCommunicationEvent("COMMUNICATION_MESSAGE_BLOCKED", blocked, actorUserId);
  return blocked;
}

export interface QueueMessageResult {
  message: CommunicationMessage;
  blocked: boolean;
  blockedReason: string | null;
  dispatched: boolean;
}

/** Steps 1-8 (and, for an immediately-dispatchable message, steps 9-13 via dispatchMessage). */
export async function queueMessage(messageId: number, brokerageId: number, actorUserId: number, expectedVersion: number): Promise<QueueMessageResult> {
  const [existing] = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.id, messageId), eq(communicationMessages.brokerageId, brokerageId)));
  if (!existing || existing.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  if (existing.status !== "DRAFT" && existing.status !== "APPROVED") {
    throw new CommunicationTransitionError(`Only a DRAFT or APPROVED message can be queued (this one is ${existing.status}).`);
  }
  // Same Section 15 gate as sendMessageNow. A direct queue of a DRAFT
  // SERVICE (or MARKETING, or send-on-behalf) message must not skip it.
  if (requiresApproval(existing) && existing.status !== "APPROVED") {
    throw new CommunicationTransitionError(APPROVAL_REQUIRED_BEFORE_SEND);
  }
  if (isInternalOnlyChannel(existing.channel as CommunicationChannel)) {
    throw new CommunicationTransitionError("An INTERNAL_NOTE is never queued for sending — it never leaves this app.");
  }
  if (!existing.recipientDestination || !existing.recipientDestination.trim()) {
    throw new CommunicationTransitionError("This message has no recipient destination to send to.");
  }
  if (!existing.bodyText || !existing.bodyText.trim()) {
    throw new CommunicationTransitionError("This message has no content to send.");
  }

  // GP-4: refuse before QUEUED. A missing or failed consent lookup must not
  // leave a queued message behind.
  await assertMessageMayLeave(existing, actorUserId);

  const now = new Date();
  const requestedSendAt = existing.scheduledAt && existing.scheduledAt > now ? existing.scheduledAt : now;
  const idempotencyKey = existing.idempotencyKey ?? `msg-${messageId}-${randomUUID()}`;

  const queued = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "QUEUED",
    expectedVersion,
    actorUserId,
    patch: { idempotencyKey, scheduledAt: requestedSendAt },
    auditAction: "communication_message_queued",
  });
  await publishCommunicationEvent("COMMUNICATION_MESSAGE_QUEUED", queued, actorUserId);

  return evaluateAndDispatchQueuedMessage(messageId, brokerageId, actorUserId, queued);
}

/**
 * Steps 4-8 for a message already sitting at QUEUED: record-only channels
 * go straight through to SENT; dispatched channels (EMAIL/SMS) run the
 * consent and cost-control gates, then either dispatch immediately or defer
 * past quiet hours. Split out from queueMessage so requeueMessage (a
 * BLOCKED_BY_CONSENT/BLOCKED_BY_COST_CONTROL message re-entering the flow —
 * the transition table only ever lets those two statuses move to QUEUED,
 * never back to DRAFT/APPROVED) can re-run this same gate-and-dispatch
 * logic without re-validating or re-transitioning a message that is
 * already QUEUED.
 */
export async function evaluateAndDispatchQueuedMessage(
  messageId: number,
  brokerageId: number,
  actorUserId: number | null,
  queuedMessage?: CommunicationMessage,
): Promise<QueueMessageResult> {
  const queued =
    queuedMessage ??
    (
      await db
        .select()
        .from(communicationMessages)
        .where(and(eq(communicationMessages.id, messageId), eq(communicationMessages.brokerageId, brokerageId)))
    )[0];
  if (!queued || queued.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  if (queued.status !== "QUEUED") {
    throw new CommunicationTransitionError(`Only a QUEUED message can be evaluated for dispatch (this one is ${queued.status}).`);
  }

  if (!isDispatchedChannel(queued.channel as CommunicationChannel)) {
    const sending = await applyMessageTransition({
      messageId,
      brokerageId,
      toStatus: "SENDING",
      expectedVersion: queued.version,
      actorUserId,
      auditAction: "communication_message_sending",
    });
    const recorded = await applyMessageTransition({
      messageId,
      brokerageId,
      toStatus: "SENT",
      expectedVersion: sending.version,
      actorUserId,
      patch: { sentAt: new Date(), provider: "record_only" },
      auditAction: "communication_message_recorded",
    });
    await db.insert(communicationDeliveryAttempts).values({
      messageId: recorded.id,
      attemptNumber: 1,
      status: "SENT",
      providerResponseSummary: "Recorded directly — this channel is not dispatched through a provider (Section 6).",
    });
    await publishCommunicationEvent("COMMUNICATION_MESSAGE_SENT", recorded, actorUserId);
    return { message: recorded, blocked: false, blockedReason: null, dispatched: true };
  }

  const costUserId = queued.sendOnBehalfOfUserId ?? queued.senderUserId ?? null;

  try {
    await assertMessageMayLeave(queued, actorUserId);
  } catch (err) {
    if (!(err instanceof OutboundConsentRefused)) throw err;
    const blocked = await blockAlreadyQueuedForConsent(queued, brokerageId, actorUserId, err);
    return { message: blocked, blocked: true, blockedReason: err.message, dispatched: false };
  }

  const costResult = await checkCostControl(brokerageId, costUserId, queued.channel as CommunicationChannel);
  if (!costResult.allowed) {
    const blocked = await applyMessageTransition({
      messageId,
      brokerageId,
      toStatus: "BLOCKED_BY_COST_CONTROL",
      expectedVersion: queued.version,
      actorUserId,
      patch: { failureCategory: "COST_CONTROL_BLOCKED", failureDetail: costResult.reason },
      auditAction: "communication_message_blocked_by_cost_control",
    });
    await publishCommunicationEvent("COMMUNICATION_MESSAGE_BLOCKED", blocked, actorUserId);
    return { message: blocked, blocked: true, blockedReason: costResult.reason, dispatched: false };
  }

  const now = new Date();
  const requestedSendAt = queued.scheduledAt && queued.scheduledAt > now ? queued.scheduledAt : now;
  const settings = await getOrCreateCommunicationSettings(brokerageId);
  const effectiveSendAt = isWithinQuietHours(requestedSendAt, settings) ? nextAllowedSendTime(requestedSendAt, settings) : requestedSendAt;

  if (effectiveSendAt > now) {
    const rescheduled = await patchQueuedSchedule(messageId, brokerageId, queued.version, effectiveSendAt);
    return { message: rescheduled, blocked: false, blockedReason: null, dispatched: false };
  }

  const dispatched = await dispatchMessage(messageId, brokerageId);
  // AE GROW W1-A (A-3): dispatchMessage now runs its own consent re-check,
  // so it can hand back a BLOCKED_BY_CONSENT message even on this path (a
  // withdrawal that lands between the check above and the dispatch below).
  // Report that honestly rather than claiming `dispatched: true` for a
  // message that never reached a provider.
  if (dispatched.status === "BLOCKED_BY_CONSENT") {
    return { message: dispatched, blocked: true, blockedReason: dispatched.failureDetail, dispatched: false };
  }
  return { message: dispatched, blocked: false, blockedReason: null, dispatched: true };
}

/** Steps 8-13 for a message already at QUEUED or RETRY_SCHEDULED — used both by queueMessage's immediate path and by dispatchDueMessages' sweep. */
export async function dispatchMessage(messageId: number, brokerageId: number): Promise<CommunicationMessage> {
  const [existing] = await db
    .select()
    .from(communicationMessages)
    .where(and(eq(communicationMessages.id, messageId), eq(communicationMessages.brokerageId, brokerageId)));
  if (!existing || existing.brokerageId !== brokerageId) throw new CommunicationTenancyError();
  if (existing.status !== "QUEUED" && existing.status !== "RETRY_SCHEDULED") {
    throw new CommunicationTransitionError(`Only a QUEUED or RETRY_SCHEDULED message can be dispatched (this one is ${existing.status}).`);
  }

  const channel = existing.channel as CommunicationChannel;

  // AE GROW W1-A (A-3): the consent gate used to run ONLY at step 5, inside
  // evaluateAndDispatchQueuedMessage. Two paths reach a provider without
  // passing through it again, and on both of them arbitrary time elapses
  // between that check and the send:
  //
  //   * a message deferred past quiet hours (step 7) stays QUEUED with a
  //     future scheduledAt, and dispatchDueMessages() below then calls this
  //     function directly when the window closes;
  //   * a RETRY_SCHEDULED message waits out its backoff (up to 30 minutes
  //     per attempt) and is likewise picked up by that same sweep.
  //
  // If consent is withdrawn in that interval — a STOP reply landing on
  // webhooks.ts's applyOptOut, or a staff member revoking marketing opt-in —
  // the old code delivered anyway. Re-checking here makes this function, the
  // sole caller of both sandbox providers, fail closed on its own rather
  // than trusting a decision some earlier caller may have made long ago.
  // Reuses the existing BLOCKED_BY_CONSENT status and CONSENT_BLOCKED
  // failure category, so a message blocked at dispatch is indistinguishable
  // from one blocked at enqueue and requeues through the same path.
  if (isDispatchedChannel(channel)) {
    try {
      await assertMessageMayLeave(existing, null);
    } catch (err) {
      if (!(err instanceof OutboundConsentRefused)) throw err;
      return blockAlreadyQueuedForConsent(existing, brokerageId, null, err);
    }
  }

  // AE GROW W3-B: resolve the adapter BEFORE the SENDING transition, and
  // deliberately outside the try/catch below.
  //
  // Both placements are load-bearing. The catch below converts any throw into
  // a FAILED delivery attempt with PROVIDER_UNAVAILABLE — correct for a send
  // that genuinely reached a provider and went wrong, but badly wrong for a
  // resolution failure: a deployment that selected an unapproved live
  // provider would be recorded as a transient delivery outage, retried on
  // backoff, and eventually shown to staff as "the provider was unavailable"
  // — an unapproved live provider is not an outage, and no amount of retrying
  // will approve it. Resolving here instead lets a typed
  // CommunicationProviderError propagate out of dispatchMessage() to the
  // caller, loudly, the way ai/voice/gateway.ts's typed errors do.
  //
  // Resolving before the transition also leaves the message untouched at
  // QUEUED/RETRY_SCHEDULED rather than stranded at SENDING, so once the
  // configuration is corrected the existing sweep picks it up with no manual
  // repair. With no environment set neither call can throw: each returns the
  // sandbox singleton.
  const emailProvider: EmailProvider | null = channel === "EMAIL" ? resolveEmailProvider() : null;
  const smsProvider: SmsProvider | null = channel === "SMS" ? resolveSmsProvider() : null;

  const sending = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "SENDING",
    expectedVersion: existing.version,
    actorUserId: null,
    patch: channel === "SMS" ? { costEstimateCents: SMS_ESTIMATED_COST_CENTS_PER_MESSAGE } : undefined,
    auditAction: "communication_message_sending",
  });

  const attemptNumber = sending.retryCount + 1;
  let result: ProviderSendResult;
  try {
    if (channel === "EMAIL") {
      result = await emailProvider!.send({
        to: sending.recipientDestination!,
        subject: sending.subject,
        bodyText: sending.bodyText,
        bodyHtml: sending.bodyHtml,
        idempotencyKey: sending.idempotencyKey!,
      });
    } else if (channel === "SMS") {
      result = await smsProvider!.send({
        to: sending.recipientDestination!,
        bodyText: sending.bodyText,
        idempotencyKey: sending.idempotencyKey!,
      });
    } else {
      throw new CommunicationTransitionError(`Channel ${channel} is not dispatched through a provider.`);
    }
  } catch (err) {
    result = {
      // Label the failure with the adapter that actually threw. Under the
      // default configuration these resolve to the same two sandbox names
      // this line used to hardcode; the fallbacks cover only the
      // non-dispatched-channel throw in the try above, where no provider was
      // resolved.
      provider: (channel === "EMAIL" ? emailProvider?.name : smsProvider?.name) ??
        (channel === "EMAIL" ? SANDBOX_EMAIL_PROVIDER_NAME : SANDBOX_SMS_PROVIDER_NAME),
      providerMessageId: `error-${randomUUID()}`,
      status: "FAILED",
      failureCategory: "PROVIDER_UNAVAILABLE",
      failureDetail: err instanceof Error ? err.message : "Unknown provider error.",
    };
  }

  await db.insert(communicationDeliveryAttempts).values({
    messageId: sending.id,
    attemptNumber,
    status: result.status,
    providerResponseSummary:
      result.status === "SENT" ? "Provider accepted the message." : (result.failureDetail ?? "Provider rejected the message.").slice(0, 500),
    errorDetail: result.status === "FAILED" ? result.failureDetail ?? null : null,
  });

  if (result.status === "SENT") {
    if (channel === "SMS") {
      const costUserId = sending.sendOnBehalfOfUserId ?? sending.senderUserId ?? null;
      await recordCost(brokerageId, costUserId, "SMS", SMS_ESTIMATED_COST_CENTS_PER_MESSAGE);
    }
    const sent = await applyMessageTransition({
      messageId,
      brokerageId,
      toStatus: "SENT",
      expectedVersion: sending.version,
      actorUserId: null,
      patch: {
        sentAt: new Date(),
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        costActualCents: channel === "SMS" ? SMS_ESTIMATED_COST_CENTS_PER_MESSAGE : null,
      },
      auditAction: "communication_message_sent",
    });
    await publishCommunicationEvent("COMMUNICATION_MESSAGE_SENT", sent, null);
    return sent;
  }

  const retryable = isRetryableFailure(result.failureCategory) && attemptNumber < sending.maxRetries;
  const failed = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "FAILED",
    expectedVersion: sending.version,
    actorUserId: null,
    patch: {
      failedAt: new Date(),
      failureCategory: result.failureCategory ?? null,
      failureDetail: result.failureDetail ?? null,
      retryCount: attemptNumber,
    },
    auditAction: "communication_message_failed",
  });

  if (!retryable) {
    // AE Step 2 closure — Part B: a non-retryable failure or one that has
    // exhausted maxRetries is this domain's version of the same
    // "repeated/exhausted job failure" signal lib/integrations/outbox.ts's
    // dead-letter path and lib/financial/paymentOutbox.ts's exhausted path
    // already track. See docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
    incrementCounter("job_repeated_failure_total", { job: "communications_outbox_message" });
    await publishCommunicationEvent("COMMUNICATION_MESSAGE_FAILED", failed, null);
    return failed;
  }

  // Capped exponential backoff: 1m, 2m, 4m, ... up to 30m between attempts.
  const backoffMs = Math.min(30 * 60_000, 60_000 * 2 ** (attemptNumber - 1));
  const rescheduled = await applyMessageTransition({
    messageId,
    brokerageId,
    toStatus: "RETRY_SCHEDULED",
    expectedVersion: failed.version,
    actorUserId: null,
    patch: { scheduledAt: new Date(Date.now() + backoffMs) },
    auditAction: "communication_message_retry_scheduled",
  });
  await publishCommunicationEvent("COMMUNICATION_MESSAGE_FAILED", rescheduled, null);
  return rescheduled;
}

/**
 * I-17. One scheduler tick dispatches at most this many due messages.
 *
 * Technical safety bound for the 60s sweep in bootstrap.ts, not a
 * commercial send cap. The sweep used to select every due QUEUED /
 * RETRY_SCHEDULED row and walk them serially, so a backlog was loaded in
 * full and was still due when the next tick selected again. Each tick now
 * takes the oldest due rows, up to this limit. Rows past the limit stay
 * QUEUED or RETRY_SCHEDULED and wait for a later tick.
 *
 * Order is scheduledAt ascending, then id ascending. A quiet-hours window
 * end shared by many messages does not reshuffle between ticks, and the
 * next tick continues the same backlog instead of picking an arbitrary
 * subset.
 *
 * A caller may request a smaller batch. The request cannot raise this cap.
 */
export const DISPATCH_DUE_MESSAGES_LIMIT = 25;

export function resolveDispatchDueMessageLimit(requested?: number): number {
  if (requested === undefined) return DISPATCH_DUE_MESSAGES_LIMIT;
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`dispatchDueMessages limit must be a positive integer (received ${String(requested)}).`);
  }
  return Math.min(requested, DISPATCH_DUE_MESSAGES_LIMIT);
}

/**
 * The boot-time scheduler's sweep (lib/communications/bootstrap.ts): every
 * QUEUED message deferred past quiet hours, and every RETRY_SCHEDULED
 * message whose backoff has elapsed, gets one dispatch attempt — up to
 * DISPATCH_DUE_MESSAGES_LIMIT rows, oldest scheduledAt first. Runs across
 * every brokerage — this is a system-wide background sweep, not a
 * per-tenant read.
 *
 * Each selected row still goes through dispatchMessage(), so the A-3
 * consent re-check and the D-3 provider resolution (sandbox unless
 * LIVE_COMMUNICATIONS_APPROVED) run for that row exactly as they do on
 * the immediate enqueue path. This function does not choose a provider.
 */
export async function dispatchDueMessages(
  now: Date = new Date(),
  requestedLimit?: number,
): Promise<{ dispatchedCount: number; blockedCount: number; errorCount: number; selectedCount: number }> {
  const limit = resolveDispatchDueMessageLimit(requestedLimit);
  const due = await db
    .select()
    .from(communicationMessages)
    .where(
      and(
        or(eq(communicationMessages.status, "QUEUED"), eq(communicationMessages.status, "RETRY_SCHEDULED")),
        isNotNull(communicationMessages.scheduledAt),
        lte(communicationMessages.scheduledAt, now),
      ),
    )
    .orderBy(asc(communicationMessages.scheduledAt), asc(communicationMessages.id))
    .limit(limit);

  let dispatchedCount = 0;
  // AE GROW W1-A (A-3): a message this sweep picks up can now come back
  // BLOCKED_BY_CONSENT (consent withdrawn while it sat deferred past quiet
  // hours or waiting out a retry backoff). That is a successful, deliberate
  // non-send, not a dispatch and not an error — counting it as either would
  // misreport the sweep.
  let blockedCount = 0;
  let errorCount = 0;
  for (const message of due) {
    try {
      const result = await dispatchMessage(message.id, message.brokerageId);
      if (result.status === "BLOCKED_BY_CONSENT") blockedCount++;
      else dispatchedCount++;
    } catch (err) {
      errorCount++;
      logger.error("communications_dispatch_due_failed", { messageId: message.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { dispatchedCount, blockedCount, errorCount, selectedCount: due.length };
}
