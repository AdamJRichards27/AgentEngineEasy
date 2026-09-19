// AE GROW Priority 6 Stage F4.3 — pure logic for "Follow-ups from this
// call" (components/GrowCallFollowupsSection.tsx).
//
// Governed path only: the UI lists the human-approved COMMITMENT/FOLLOWUP
// items of a saved call review (GET .../followups), and on an explicit click
// POSTs .../followups/propose with nothing but {itemType, itemId, dueAt}
// triples for items the agent both selected AND whose due date they
// explicitly confirmed. A pre-filled (AI-suggested) date is only a hint:
// it never counts as confirmed on its own. Approval/execution stays on the
// existing /ai/actions/requests/:id/{approve,reject,execute} routes.

import type { CommitmentProposalView } from "./commitmentProposals";

export type CallFollowupItemType = "COMMITMENT" | "FOLLOWUP";

export interface FollowupActionRequestSummary {
  actionRequestId: number;
  status: string;
  dueAt: string | null;
  description: string | null;
  proposedByUserId: number;
  createdAt: string;
  expiresAt: string | null;
}

export type FollowupExistingProposal =
  | { visibility: "NONE" }
  | { visibility: "VISIBLE"; actionRequest: FollowupActionRequestSummary }
  | { visibility: "ALREADY_PROPOSED" };

export interface CallFollowupCandidate {
  itemType: CallFollowupItemType;
  itemId: string;
  text: string;
  suggestedDueAt: string | null;
  consentBlocked: boolean;
  existingProposal: FollowupExistingProposal;
  latestProposalStatus: string | null;
  canPropose: boolean;
}

export interface CallFollowupsResponse {
  callSessionId: number;
  transcriptionId: number;
  partyId: number;
  consentBlocked: boolean;
  candidates: CallFollowupCandidate[];
}

export interface CallFollowupProposalOutcome {
  itemType: CallFollowupItemType;
  itemId: string;
  status: "PROPOSED" | "EXISTING" | "ALREADY_PROPOSED";
  actionRequest: FollowupActionRequestSummary | null;
}

export interface ProposeFollowupsPayload {
  items: Array<{ itemType: CallFollowupItemType; itemId: string; dueAt: string }>;
}

/** Local, per-item form state. Never sent to the server as-is. */
export interface FollowupDraft {
  selected: boolean;
  // Current value of the <input type="date"> (YYYY-MM-DD), possibly
  // pre-filled from suggestedDueAt.
  dueDate: string;
  // The exact date value the agent explicitly confirmed, or null. A
  // confirmation only counts while it still equals dueDate.
  confirmedDueDate: string | null;
}

export const MAX_FOLLOWUPS_PER_PROPOSAL = 20;

export function followupKey(item: { itemType: string; itemId: string }): string {
  return `${item.itemType}:${item.itemId}`;
}

export function followupItemTypeLabel(itemType: CallFollowupItemType): string {
  return itemType === "COMMITMENT" ? "Commitment" : "Follow-up";
}

const DATE_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * YYYY-MM-DD -> ISO-8601 (UTC midnight, the same convention as Contact
 * 360's manual "Add commitment" form). null for anything else.
 */
export function dateInputToIso(value: string): string | null {
  const match = DATE_INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return date.toISOString();
}

/** ISO-8601 -> YYYY-MM-DD for pre-filling a date input ("" when invalid). */
export function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

export function canProposeCandidate(candidate: CallFollowupCandidate, consentBlocked: boolean): boolean {
  return !consentBlocked && !candidate.consentBlocked && candidate.canPropose;
}

export function createFollowupDrafts(candidates: CallFollowupCandidate[]): Record<string, FollowupDraft> {
  const drafts: Record<string, FollowupDraft> = {};
  for (const candidate of candidates) {
    drafts[followupKey(candidate)] = {
      selected: false,
      dueDate: isoToDateInput(candidate.suggestedDueAt),
      // Pre-filled is not confirmed.
      confirmedDueDate: null,
    };
  }
  return drafts;
}

/** Keeps existing local edits, adds drafts for newly listed items. */
export function mergeFollowupDrafts(
  current: Record<string, FollowupDraft>,
  candidates: CallFollowupCandidate[],
): Record<string, FollowupDraft> {
  const fresh = createFollowupDrafts(candidates);
  for (const key of Object.keys(fresh)) {
    if (current[key]) fresh[key] = current[key]!;
  }
  return fresh;
}

/** Changing the date always clears any earlier confirmation. */
export function setDraftDueDate(draft: FollowupDraft, dueDate: string): FollowupDraft {
  return { ...draft, dueDate, confirmedDueDate: null };
}

/** Explicit confirmation of the currently shown date (only if valid). */
export function setDraftDueDateConfirmed(draft: FollowupDraft, confirmed: boolean): FollowupDraft {
  if (!confirmed) return { ...draft, confirmedDueDate: null };
  return dateInputToIso(draft.dueDate) === null ? { ...draft, confirmedDueDate: null } : { ...draft, confirmedDueDate: draft.dueDate };
}

export function isDraftDueDateConfirmed(draft: FollowupDraft | undefined): boolean {
  return !!draft && draft.confirmedDueDate !== null && draft.confirmedDueDate === draft.dueDate && dateInputToIso(draft.dueDate) !== null;
}

export function isDraftReady(candidate: CallFollowupCandidate, draft: FollowupDraft | undefined, consentBlocked: boolean): boolean {
  return canProposeCandidate(candidate, consentBlocked) && !!draft?.selected && isDraftDueDateConfirmed(draft);
}

/**
 * The only body ever sent to .../followups/propose: selected, proposable
 * items whose due date the agent explicitly confirmed, each reduced to
 * exactly {itemType, itemId, dueAt}. Never description/partyId/brokerageId
 * or any other field (the API's strict schema would reject them anyway).
 */
export function buildProposePayload(
  candidates: CallFollowupCandidate[],
  drafts: Record<string, FollowupDraft>,
  consentBlocked: boolean,
): ProposeFollowupsPayload {
  const items: ProposeFollowupsPayload["items"] = [];
  for (const candidate of candidates) {
    const draft = drafts[followupKey(candidate)];
    if (!isDraftReady(candidate, draft, consentBlocked)) continue;
    const dueAt = dateInputToIso(draft!.confirmedDueDate!);
    if (dueAt === null) continue;
    items.push({ itemType: candidate.itemType, itemId: candidate.itemId, dueAt });
    if (items.length >= MAX_FOLLOWUPS_PER_PROPOSAL) break;
  }
  return { items };
}

export const CONSENT_BLOCKED_MESSAGE =
  "Recording consent for this call was withdrawn, so new follow-up proposals can’t be created. Existing proposals are unchanged.";

/** Why "Propose selected follow-ups" is disabled, or null when enabled. */
export function proposeDisabledReason(
  candidates: CallFollowupCandidate[],
  drafts: Record<string, FollowupDraft>,
  consentBlocked: boolean,
): string | null {
  if (consentBlocked || candidates.some((candidate) => candidate.consentBlocked)) return CONSENT_BLOCKED_MESSAGE;
  if (!candidates.some((candidate) => canProposeCandidate(candidate, consentBlocked))) {
    return "Every follow-up from this call has already been proposed.";
  }
  const selected = candidates.filter((candidate) => canProposeCandidate(candidate, consentBlocked) && drafts[followupKey(candidate)]?.selected);
  if (selected.length === 0) return "Select at least one follow-up to propose.";
  if (selected.some((candidate) => !isDraftDueDateConfirmed(drafts[followupKey(candidate)]))) {
    return "Confirm the due date for each selected follow-up.";
  }
  if (selected.length > MAX_FOLLOWUPS_PER_PROPOSAL) return `Propose at most ${MAX_FOLLOWUPS_PER_PROPOSAL} follow-ups at a time.`;
  return null;
}

export type FollowupStatusTone = "neutral" | "warning" | "success" | "danger";

export interface FollowupStatus {
  label: string;
  tone: FollowupStatusTone;
}

export function followupStatus(candidate: CallFollowupCandidate, now: Date = new Date()): FollowupStatus {
  const existing = candidate.existingProposal;
  if (existing.visibility === "ALREADY_PROPOSED") {
    // Someone else's proposal: no details are shown (F4.0 D1/D2).
    return { label: "Already proposed by another user", tone: "neutral" };
  }
  if (existing.visibility === "VISIBLE") {
    const request = existing.actionRequest;
    if (request.status === "COMPLETED") return { label: "Commitment created", tone: "success" };
    if (request.status === "APPROVED") return { label: "Approved — commitment not created yet", tone: "warning" };
    if (request.status === "EXECUTING") return { label: "Creating commitment…", tone: "warning" };
    if (request.status === "AWAITING_APPROVAL") {
      const expiresAt = request.expiresAt ? new Date(request.expiresAt).getTime() : NaN;
      if (!Number.isNaN(expiresAt) && expiresAt <= now.getTime()) {
        return { label: "Proposal expired — refresh to propose again", tone: "danger" };
      }
      if (!Number.isNaN(expiresAt)) {
        const hours = Math.floor((expiresAt - now.getTime()) / 3_600_000);
        return { label: `Proposed — awaiting approval (expires in ${hours < 1 ? "<1" : hours}h)`, tone: "warning" };
      }
      return { label: "Proposed — awaiting approval", tone: "warning" };
    }
    return { label: `Proposal ${request.status.toLowerCase().replace(/_/g, " ")}`, tone: "neutral" };
  }
  if (candidate.latestProposalStatus === "EXPIRED") return { label: "Previous proposal expired — you can propose it again", tone: "danger" };
  if (candidate.latestProposalStatus === "REJECTED") return { label: "Previous proposal rejected — you can propose it again", tone: "neutral" };
  if (candidate.latestProposalStatus === "FAILED" || candidate.latestProposalStatus === "CANCELLED") {
    return { label: "Previous proposal didn’t complete — you can propose it again", tone: "neutral" };
  }
  return { label: "Not proposed yet", tone: "neutral" };
}

export function followupStatusPillClass(tone: FollowupStatusTone): string {
  if (tone === "success") return "pill pill-success";
  if (tone === "warning") return "pill pill-warning";
  if (tone === "danger") return "pill pill-danger";
  return "pill";
}

/**
 * The action request to show a review card for, if any: a proposal from
 * this session (the propose response, or one the agent already acted on
 * here) first, else an open request the actor may see.
 */
export function cardRequestForCandidate(
  candidate: CallFollowupCandidate,
  local: Record<string, FollowupActionRequestSummary>,
): FollowupActionRequestSummary | null {
  const retained = local[followupKey(candidate)];
  if (retained) return retained;
  const existing = candidate.existingProposal;
  if (existing.visibility === "VISIBLE" && (existing.actionRequest.status === "AWAITING_APPROVAL" || existing.actionRequest.status === "APPROVED")) {
    return existing.actionRequest;
  }
  return null;
}

/** Adds the propose response's visible requests to the local map. */
export function retainOutcomes(
  local: Record<string, FollowupActionRequestSummary>,
  outcomes: CallFollowupProposalOutcome[],
): Record<string, FollowupActionRequestSummary> {
  const next = { ...local };
  for (const outcome of outcomes) {
    if (outcome.actionRequest) next[followupKey(outcome)] = outcome.actionRequest;
  }
  return next;
}

export function summarizeProposeOutcomes(outcomes: CallFollowupProposalOutcome[]): string {
  const proposed = outcomes.filter((outcome) => outcome.status === "PROPOSED").length;
  const existing = outcomes.filter((outcome) => outcome.status === "EXISTING").length;
  const others = outcomes.filter((outcome) => outcome.status === "ALREADY_PROPOSED").length;
  const parts: string[] = [];
  if (proposed > 0) parts.push(`${proposed} ${proposed === 1 ? "proposal" : "proposals"} created — awaiting your approval`);
  if (existing > 0) parts.push(`${existing} already proposed`);
  if (others > 0) parts.push(`${others} already proposed by another user`);
  return parts.length > 0 ? `${parts.join("; ")}. Nothing is created until you approve.` : "Nothing was proposed.";
}

export function viewFromFollowupRequest(
  request: FollowupActionRequestSummary,
  candidate: Pick<CallFollowupCandidate, "itemType" | "itemId" | "text">,
  context: { transcriptionId: number; contactName: string | null },
): CommitmentProposalView {
  return {
    actionRequestId: request.actionRequestId,
    summary: request.description ?? candidate.text,
    contactName: context.contactName,
    dueAt: request.dueAt,
    timeZone: null,
    reason: candidate.itemType === "COMMITMENT" ? "Commitment approved in call review" : "Follow-up approved in call review",
    evidenceSummary: null,
    status: request.status,
    expiresAt: request.expiresAt,
    reviewUrl: null,
    provenance: { source: "call_review", transcriptionId: context.transcriptionId, itemType: candidate.itemType, itemId: candidate.itemId },
  };
}

export interface FollowupErrorLike {
  status: number;
  code?: string;
  friendly?: string;
}

/** Error code -> agent-facing copy for the F4.1 follow-up routes. */
export function followupErrorMessage(err: FollowupErrorLike): string {
  switch (err.code) {
    case "CONSENT_WITHDRAWN":
      return CONSENT_BLOCKED_MESSAGE;
    case "WRONG_STATE":
      return "Follow-ups are only available for a saved call review. Nothing was proposed.";
    case "ENTITLEMENT_REQUIRED":
      return "Your access doesn’t include call follow-ups. Ask a Brokerage Administrator.";
    case "ACCESS_DENIED":
      return "You can’t propose follow-ups for this call.";
    case "POLICY_DENIED":
      return "A follow-up proposal was blocked by policy. Refresh to see which follow-ups, if any, were proposed.";
    case "NOT_FOUND":
      return "This call review is no longer available.";
    case "INVALID_INPUT":
      return "Check the selected follow-ups and their due dates (within two years of today), then try again.";
    case "AUDIT_FAILURE":
      return "Nothing was proposed because the audit record couldn’t be written. Try again.";
    case "AUDIT_INCOMPLETE":
      return "The proposals were created and await your approval, but the audit record couldn’t be completed. Propose the same follow-ups again to finish it — this won’t create duplicates.";
    default:
      break;
  }
  if (err.status === 403) return "You don’t have permission to do that — ask a Brokerage Administrator.";
  if (err.status === 404) return "This call review is no longer available.";
  return err.friendly ?? "Couldn’t propose these follow-ups. Try again.";
}

/** React Query keys to refresh after any propose/approve/reject/execute. */
export function followupInvalidationKeys(partyId: number): ReadonlyArray<readonly unknown[]> {
  return [
    ["grow-call-followups"],
    ["grow-pending-commitments"],
    ["grow-contact", partyId],
    ["grow-activities"],
  ];
}

export function callFollowupsQueryKey(callSessionId: number, transcriptionId: number) {
  return ["grow-call-followups", callSessionId, transcriptionId] as const;
}

export function pendingCommitmentsQueryKey(partyId: number) {
  return ["grow-pending-commitments", partyId] as const;
}

/**
 * Keeps cards the agent acted on in this view visible (with their outcome
 * message) after the refreshed pending list no longer includes them.
 */
export function mergeRetainedProposals<T extends { actionRequestId: number }>(fetched: T[], retained: T[]): T[] {
  const seen = new Set(fetched.map((item) => item.actionRequestId));
  return [...fetched, ...retained.filter((item) => !seen.has(item.actionRequestId))];
}
