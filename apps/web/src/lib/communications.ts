// Agent Engine 2.0 -- Communications Hub (Priority 8). Hand-mirrors the
// Communications types and REST surface declared on the API side
// (apps/api/src/lib/communications/*.ts + routes/communications.ts) the
// same way lib/pitCrew.ts hand-mirrors Pit Crew's -- there is no shared
// package between apps/web and apps/api, so these shapes are kept in sync
// by hand.
//
// AE GROW PRIORITY 3 -- contact-first threads. propertyId/partyId on
// CommunicationThread and CommunicationMessage are now both nullable
// (mirrors packages/db/src/schema/communications.ts's own change -- a
// thread/message is anchored to a property, a contact, or both, never
// neither). fetchThreadsForParty / createContactCommunicationThread /
// fetchContactRecipientCandidates below are the contact-first analogues of
// the property-scoped functions just above each of them, calling the new
// /grow/contacts/:partyId/communications/... routes
// (apps/api/src/routes/communications.ts's "contact-first" block) rather
// than /properties/:propertyId/communications/.... Everything past thread
// creation (participants, composing, lifecycle actions) reuses the exact
// same generic functions already declared below unchanged -- those only
// ever needed a threadId/messageId, never a propertyId.
import { apiFetch } from "./api";

export const COMMUNICATION_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL", "EXTERNAL_MESSAGE", "INTERNAL_NOTE"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const COMMUNICATION_CLASSIFICATIONS = ["TRANSACTIONAL", "SERVICE", "MARKETING"] as const;
export type CommunicationClassification = (typeof COMMUNICATION_CLASSIFICATIONS)[number];

export type CommunicationMessageStatus =
  | "DRAFT"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "DELIVERED"
  | "RECEIVED"
  | "FAILED"
  | "RETRY_SCHEDULED"
  | "BOUNCED"
  | "UNDELIVERABLE"
  | "CANCELLED"
  | "BLOCKED_BY_CONSENT"
  | "BLOCKED_BY_COST_CONTROL";

export interface CommunicationThread {
  id: number;
  brokerageId: number;
  // AE Grow Priority 3: nullable -- a contact-first thread (created from
  // Contact 360) has no property. See partyId below.
  propertyId: number | null;
  transactionId: number | null;
  subject: string;
  status: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  // AE Grow Priority 3: the contact-first anchor -- set on every thread
  // created via POST /grow/contacts/:partyId/communications/threads, and
  // null on an ordinary property-first thread that has no known contact.
  partyId: number | null;
}

export interface CommunicationParticipant {
  id: number;
  threadId: number;
  partyId: number | null;
  role: string;
  displayName: string;
  email: string | null;
  mobile: string | null;
  isManualEntry: boolean;
  manualEntryReason: string | null;
  addedByUserId: number | null;
  addedAt: string;
}

export interface CommunicationMessage {
  id: number;
  threadId: number;
  brokerageId: number;
  // AE Grow Priority 3: nullable -- see CommunicationThread.propertyId above.
  propertyId: number | null;
  transactionId: number | null;
  direction: "OUTBOUND" | "INBOUND";
  channel: CommunicationChannel;
  classification: CommunicationClassification;
  status: CommunicationMessageStatus;
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  senderUserId: number | null;
  sendOnBehalfOfUserId: number | null;
  recipientParticipantId: number | null;
  recipientDisplayName: string | null;
  recipientDestination: string | null;
  templateId: number | null;
  templateVersion: number | null;
  provider: string | null;
  providerMessageId: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureCategory: string | null;
  failureDetail: string | null;
  retryCount: number;
  maxRetries: number;
  costEstimateCents: number | null;
  costActualCents: number | null;
  createdByUserId: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  // AE Grow Priority 3: denormalised straight from the thread's partyId --
  // see CommunicationThread.partyId above.
  partyId: number | null;
}

export interface CandidateRecipient {
  partyId: number;
  role: string;
  isPrimary: boolean;
  displayName: string;
  email: string | null;
  mobile: string | null;
  isDuplicateContact: boolean;
}

export interface CommunicationTemplate {
  id: number;
  brokerageId: number | null;
  templateKey: string;
  name: string;
  channel: CommunicationChannel;
  classification: CommunicationClassification;
  category: "LAUNCH" | "TRANSACTION" | "PC_EVENT" | "GENERAL";
  version: number;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  subject: string | null;
  bodyText: string;
  bodyHtml: string | null;
  placeholders: string[];
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface QueueMessageResult {
  message: CommunicationMessage;
  blocked: boolean;
  blockedReason: string | null;
  dispatched: boolean;
}

export interface RecentCommunicationRow {
  message: CommunicationMessage;
  propertyAddress: string;
  threadSubject: string;
}

export interface HubResponse {
  messages: RecentCommunicationRow[];
  needsAttentionCount: number;
}

// ---------------------------------------------------------------------
// Hub (Section 32).
// ---------------------------------------------------------------------

export function fetchCommunicationsHub(filter: "all" | "needs-attention" = "all", limit?: number): Promise<HubResponse> {
  const params = new URLSearchParams({ filter });
  if (limit) params.set("limit", String(limit));
  return apiFetch<HubResponse>(`/communications/hub?${params.toString()}`);
}

// ---------------------------------------------------------------------
// Threads (Section 10) -- property-scoped.
// ---------------------------------------------------------------------

export function fetchThreadsForProperty(propertyId: number): Promise<{ threads: CommunicationThread[] }> {
  return apiFetch<{ threads: CommunicationThread[] }>(`/properties/${propertyId}/communications/threads`);
}

export function createCommunicationThread(propertyId: number, body: { subject: string; transactionId?: number }): Promise<CommunicationThread> {
  return apiFetch<CommunicationThread>(`/properties/${propertyId}/communications/threads`, { method: "POST", body: JSON.stringify(body) });
}

export interface ThreadDetail {
  thread: CommunicationThread;
  participants: CommunicationParticipant[];
  messages: CommunicationMessage[];
}

export function fetchThreadDetail(threadId: number): Promise<ThreadDetail> {
  return apiFetch<ThreadDetail>(`/communications/threads/${threadId}`);
}

export function fetchRecipientCandidates(propertyId: number): Promise<{ candidates: CandidateRecipient[] }> {
  return apiFetch<{ candidates: CandidateRecipient[] }>(`/properties/${propertyId}/communications/recipients`);
}

// ---------------------------------------------------------------------
// AE GROW PRIORITY 3 -- Threads (contact-first), for Contact 360. Mounted
// under /grow/contacts/:partyId/communications/... rather than
// /properties/:propertyId/communications/... -- see this file's header
// comment. Shaped identically to the property-first functions above
// (same CommunicationThread / CandidateRecipient types) so
// components/CommunicationsSection.tsx's shared thread-detail/composer
// pieces need no special-casing between the two.
// ---------------------------------------------------------------------

export function fetchThreadsForParty(partyId: number): Promise<{ threads: CommunicationThread[] }> {
  return apiFetch<{ threads: CommunicationThread[] }>(`/grow/contacts/${partyId}/communications/threads`);
}

export function createContactCommunicationThread(
  partyId: number,
  body: { subject: string; transactionId?: number },
): Promise<CommunicationThread> {
  return apiFetch<CommunicationThread>(`/grow/contacts/${partyId}/communications/threads`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchContactRecipientCandidates(partyId: number): Promise<{ candidates: CandidateRecipient[] }> {
  return apiFetch<{ candidates: CandidateRecipient[] }>(`/grow/contacts/${partyId}/communications/recipients`);
}

// ---------------------------------------------------------------------
// Participants (Section 11).
// ---------------------------------------------------------------------

export function addParticipantFromParty(threadId: number, body: { partyId: number; role: string }): Promise<CommunicationParticipant> {
  return apiFetch<CommunicationParticipant>(`/communications/threads/${threadId}/participants`, { method: "POST", body: JSON.stringify(body) });
}

export function addManualParticipant(
  threadId: number,
  body: { displayName: string; role: string; email?: string; mobile?: string; reason: string },
): Promise<CommunicationParticipant> {
  return apiFetch<CommunicationParticipant>(`/communications/threads/${threadId}/participants/manual`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------
// Messages / the composer (Section 13) and its lifecycle actions.
// ---------------------------------------------------------------------

export interface CreateDraftMessageBody {
  transactionId?: number;
  channel: CommunicationChannel;
  classification: CommunicationClassification;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  sendOnBehalfOfUserId?: number;
  recipientParticipantId?: number;
  recipientDisplayName?: string;
  recipientDestination?: string;
  templateId?: number;
  placeholderValues?: Record<string, string>;
}

export function createDraftMessage(threadId: number, body: CreateDraftMessageBody): Promise<CommunicationMessage> {
  return apiFetch<CommunicationMessage>(`/communications/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify(body) });
}

export function fetchMessage(messageId: number): Promise<CommunicationMessage> {
  return apiFetch<CommunicationMessage>(`/communications/messages/${messageId}`);
}

function versionedAction<T>(messageId: number, action: string, expectedVersion: number, extra?: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(`/communications/messages/${messageId}/${action}`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, ...extra }),
  });
}

export function requestApproval(messageId: number, expectedVersion: number): Promise<CommunicationMessage> {
  return versionedAction(messageId, "request-approval", expectedVersion);
}

export function approveMessage(messageId: number, expectedVersion: number): Promise<CommunicationMessage> {
  return versionedAction(messageId, "approve", expectedVersion);
}

export function cancelMessage(messageId: number, expectedVersion: number, reason?: string): Promise<CommunicationMessage> {
  return versionedAction(messageId, "cancel", expectedVersion, reason ? { reason } : undefined);
}

export function sendMessageNow(messageId: number, expectedVersion: number): Promise<QueueMessageResult> {
  return versionedAction(messageId, "send", expectedVersion);
}

export function requeueMessage(messageId: number, expectedVersion: number): Promise<QueueMessageResult> {
  return versionedAction(messageId, "requeue", expectedVersion);
}

// ---------------------------------------------------------------------
// Templates (Section 14).
// ---------------------------------------------------------------------

export function fetchTemplates(params?: { channel?: CommunicationChannel; category?: string; status?: string }): Promise<{ templates: CommunicationTemplate[] }> {
  const qs = new URLSearchParams();
  if (params?.channel) qs.set("channel", params.channel);
  if (params?.category) qs.set("category", params.category);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString();
  return apiFetch<{ templates: CommunicationTemplate[] }>(`/communications/templates${suffix ? `?${suffix}` : ""}`);
}

export function activateTemplate(templateId: number): Promise<CommunicationTemplate> {
  return apiFetch<CommunicationTemplate>(`/communications/templates/${templateId}/activate`, { method: "POST" });
}

// ---------------------------------------------------------------------
// Cost summary (Section 21).
// ---------------------------------------------------------------------

export interface CommunicationCostSummary {
  periodKey: string;
  brokerage: { messageCount: number; costEstimateCents: number };
  user: { messageCount: number; costEstimateCents: number } | null;
  softThresholdCents: number;
  hardThresholdCents: number;
}

export function fetchCostSummary(): Promise<CommunicationCostSummary> {
  return apiFetch<CommunicationCostSummary>(`/communications/cost-summary`);
}

// ---------------------------------------------------------------------
// Display helpers.
// ---------------------------------------------------------------------

const STATUS_LABELS: Record<CommunicationMessageStatus, string> = {
  DRAFT: "Draft",
  AWAITING_APPROVAL: "Awaiting Approval",
  APPROVED: "Approved",
  QUEUED: "Queued",
  SENDING: "Sending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  RECEIVED: "Received",
  FAILED: "Failed",
  RETRY_SCHEDULED: "Retrying",
  BOUNCED: "Bounced",
  UNDELIVERABLE: "Undeliverable",
  CANCELLED: "Cancelled",
  BLOCKED_BY_CONSENT: "Blocked (Consent)",
  BLOCKED_BY_COST_CONTROL: "Blocked (Cost Control)",
};

export function communicationStatusLabel(status: string): string {
  return STATUS_LABELS[status as CommunicationMessageStatus] ?? status;
}

export function communicationStatusPillClass(status: string): string {
  switch (status) {
    case "DELIVERED":
    case "SENT":
    case "RECEIVED":
      return "pill pill-success";
    case "QUEUED":
    case "SENDING":
    case "RETRY_SCHEDULED":
    case "AWAITING_APPROVAL":
      return "pill pill-warning";
    case "FAILED":
    case "BOUNCED":
    case "UNDELIVERABLE":
    case "BLOCKED_BY_CONSENT":
    case "BLOCKED_BY_COST_CONTROL":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

const CHANNEL_LABELS: Record<CommunicationChannel, string> = {
  EMAIL: "Email",
  SMS: "SMS",
  PHONE_CALL: "Phone Call",
  EXTERNAL_MESSAGE: "External Message",
  INTERNAL_NOTE: "Internal Note",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as CommunicationChannel] ?? channel;
}

const CLASSIFICATION_LABELS: Record<CommunicationClassification, string> = {
  TRANSACTIONAL: "Transactional",
  SERVICE: "Service",
  MARKETING: "Marketing",
};

export function classificationLabel(classification: string): string {
  return CLASSIFICATION_LABELS[classification as CommunicationClassification] ?? classification;
}

/** Section 6: a channel this app genuinely dispatches, vs one it only records after the fact. */
export function isDispatchedChannel(channel: CommunicationChannel): boolean {
  return channel === "EMAIL" || channel === "SMS";
}
