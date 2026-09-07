// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Shared types, the validated message-status transition table (Section 9),
// and small pure-function classification/consent/retry helpers. Mirrors
// the existing schema-owns-the-enum / lib-owns-the-transitions split (see
// packages/db/src/schema/pitCrew.ts vs apps/api/src/lib/pitCrew/types.ts).

import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CLASSIFICATIONS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_MESSAGE_STATUSES,
  COMMUNICATION_PARTICIPANT_ROLES,
  type CommunicationChannel,
  type CommunicationClassification,
  type CommunicationDirection,
  type CommunicationMessageStatus,
} from "@aee/db";
import { incrementCounter } from "@aee/events";
import { dispatchOperationalAlert } from "../operationalAlerts.js";

export {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CLASSIFICATIONS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_MESSAGE_STATUSES,
  COMMUNICATION_PARTICIPANT_ROLES,
};
export type {
  CommunicationChannel,
  CommunicationClassification,
  CommunicationDirection,
  CommunicationMessageStatus,
};

// Section 9: SENT != DELIVERED — reject invalid transitions. DRAFT is the
// only status with no inbound edges (it's the creation state); RECEIVED is
// reachable only as an inbound message's creation state, never transitioned
// into from anything else, and has no outbound edges (an inbound record is
// simply recorded, not itself sent). BLOCKED_BY_CONSENT and
// BLOCKED_BY_COST_CONTROL both allow a re-attempt back into QUEUED once the
// blocking condition changes (consent granted, next cost-control period,
// threshold raised) rather than being dead ends.
export const COMMUNICATION_MESSAGE_STATUS_TRANSITIONS: Record<CommunicationMessageStatus, CommunicationMessageStatus[]> = {
  DRAFT: ["AWAITING_APPROVAL", "APPROVED", "QUEUED", "CANCELLED", "BLOCKED_BY_CONSENT", "BLOCKED_BY_COST_CONTROL"],
  AWAITING_APPROVAL: ["APPROVED", "CANCELLED"],
  APPROVED: ["QUEUED", "CANCELLED"],
  QUEUED: ["SENDING", "CANCELLED", "BLOCKED_BY_CONSENT", "BLOCKED_BY_COST_CONTROL"],
  SENDING: ["SENT", "FAILED"],
  SENT: ["DELIVERED", "FAILED", "BOUNCED", "UNDELIVERABLE"],
  // DELIVERED is not quite terminal: a provider can still report a late
  // bounce after first confirming delivery (a real, if rare, case — e.g.
  // a mailbox found full only on final handoff). Nothing else moves out of
  // DELIVERED.
  DELIVERED: ["BOUNCED"],
  RECEIVED: [],
  FAILED: ["RETRY_SCHEDULED"],
  RETRY_SCHEDULED: ["SENDING", "FAILED", "CANCELLED"],
  BOUNCED: [],
  UNDELIVERABLE: [],
  CANCELLED: [],
  BLOCKED_BY_CONSENT: ["QUEUED", "CANCELLED"],
  BLOCKED_BY_COST_CONTROL: ["QUEUED", "CANCELLED"],
};

export function isValidCommunicationStatusTransition(from: CommunicationMessageStatus, to: CommunicationMessageStatus): boolean {
  return COMMUNICATION_MESSAGE_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that count as "still trying" for UI/queue purposes. */
export const IN_FLIGHT_MESSAGE_STATUSES: CommunicationMessageStatus[] = ["QUEUED", "SENDING", "RETRY_SCHEDULED"];

/** Statuses that count as a terminal failure — no further automatic action. */
export const TERMINAL_FAILURE_STATUSES: CommunicationMessageStatus[] = ["FAILED", "BOUNCED", "UNDELIVERABLE"];

// Section 20: bounded, idempotent, audited retries only for retryable
// failures. A failure category not in this list never schedules a retry,
// regardless of remaining retryCount.
export const RETRYABLE_FAILURE_CATEGORIES = [
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "RATE_LIMITED",
  "NETWORK_ERROR",
] as const;
export type RetryableFailureCategory = (typeof RETRYABLE_FAILURE_CATEGORIES)[number];

export const NON_RETRYABLE_FAILURE_CATEGORIES = [
  "INVALID_DESTINATION",
  "BLOCKED_BY_PROVIDER",
  "UNSUBSCRIBED",
  "CONTENT_REJECTED",
] as const;
export type NonRetryableFailureCategory = (typeof NON_RETRYABLE_FAILURE_CATEGORIES)[number];

export type FailureCategory = RetryableFailureCategory | NonRetryableFailureCategory;

export function isRetryableFailure(category: string | null | undefined): boolean {
  return category != null && (RETRYABLE_FAILURE_CATEGORIES as readonly string[]).includes(category);
}

// Channels a message can only ever be OUTBOUND for (a call outcome or an
// externally-occurred message are recorded after the fact, never "sent"
// through this app) vs channels this app genuinely dispatches.
export const DISPATCHED_CHANNELS: CommunicationChannel[] = ["EMAIL", "SMS"];
export const RECORD_ONLY_CHANNELS: CommunicationChannel[] = ["PHONE_CALL", "EXTERNAL_MESSAGE"];

/** INTERNAL_NOTE is never sent externally and must never appear in any external-facing read (Section 6). */
export function isInternalOnlyChannel(channel: CommunicationChannel): boolean {
  return channel === "INTERNAL_NOTE";
}

export function isDispatchedChannel(channel: CommunicationChannel): boolean {
  return DISPATCHED_CHANNELS.includes(channel);
}

/** Which raw consent-record channel a message channel maps onto — PHONE_CALL/EXTERNAL_MESSAGE/INTERNAL_NOTE carry no consent record of their own. */
export function consentChannelFor(channel: CommunicationChannel): "EMAIL" | "SMS" | null {
  if (channel === "EMAIL") return "EMAIL";
  if (channel === "SMS") return "SMS";
  return null;
}

export class CommunicationTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationTransitionError";
  }
}

export class CommunicationConcurrencyError extends Error {
  constructor(message = "This message was changed by someone else. Refresh and try again.") {
    super(message);
    this.name = "CommunicationConcurrencyError";
  }
}

export class CommunicationConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationConsentError";
  }
}

export class CommunicationCostControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommunicationCostControlError";
  }
}

// AE Step 2 closure — Part B: every throw site in this domain resolves a
// record scoped to the caller's brokerageId and treats "doesn't exist" and
// "belongs to another tenant" identically (this class's own name/message —
// never a hint which case it was, by design). Incrementing here, at the
// one constructor every one of those throw sites shares, gives a real,
// bounded-cardinality signal for the whole domain without touching each
// call site individually. See docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md for the
// tenant_isolation_rejection_total SLI this feeds.
export class CommunicationTenancyError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "CommunicationTenancyError";
    incrementCounter("tenant_isolation_rejection_total", { boundary: "communications" });
    void dispatchOperationalAlert({
      type: "TENANT_SECURITY_SIGNAL",
      summary: "Tenant-scoped communications access was rejected",
      dedupKey: "tenant-security:communications",
      details: { boundary: "communications" },
    });
  }
}
