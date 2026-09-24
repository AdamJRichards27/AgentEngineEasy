// AE GROW Priority 6 Stage F4.3 — pure logic behind the reusable
// GrowCommitmentProposalCard (components/GrowCommitmentProposalCard.tsx).
//
// Kept free of React/DOM so it is unit-testable with `tsx --test`. The card
// only ever acts on one already-proposed CREATE_GROW_COMMITMENT request by
// id through the existing governed routes
// (`/ai/actions/requests/:id/{approve,reject,execute}`); nothing here
// creates, approves, or executes anything by itself.

import {
  COMMITMENT_CREATED_HEADING,
  COMMITMENT_MAY_EXIST_HEADING,
  PROPOSED_COMMITMENT_PREFIX,
  showCommitmentNotFollowUp,
} from "./growTerms";

/** Ids from grow_call_review_links. Not parsed from a resource id string. */
export interface CommitmentProposalProvenance {
  source: "call_review";
  callSessionId?: number;
  transcriptionId?: number;
  itemType?: string;
  itemId?: string;
}

/**
 * The one shape the card renders. Every source (Ask AE's
 * proposedCommitment, the pending-commitments list, a call follow-up
 * proposal) is normalised into this by the adapters below.
 */
export interface CommitmentProposalView {
  actionRequestId: number;
  // Headline shown first (Ask AE's humanReadableSummary, or the approved
  // commitment text itself).
  summary: string;
  contactName: string | null;
  dueAt: string | null;
  timeZone: string | null;
  reason: string | null;
  evidenceSummary: string | null;
  status: string;
  expiresAt: string | null;
  reviewUrl: string | null;
  provenance: CommitmentProposalProvenance | null;
}

export type ProposalCardState =
  | "review"
  | "approving"
  | "approved"
  | "executing"
  | "executed"
  | "rejecting"
  | "rejected"
  | "dismissed"
  | "expired"
  | "already_actioned"
  | "not_available"
  | "permission_denied"
  | "validation_error"
  | "completed_after_recovery"
  | "recoverable_failure";

export interface ProposalErrorLike {
  status: number;
  reason?: string;
  sideEffectApplied?: boolean;
}

// Maps an error from the governed approve/reject/execute routes (see
// apps/api/src/routes/ai-actions.ts statusForApprovalReason /
// statusForExecutionReason) to a card state. COMPLETED_AFTER_RECOVERY is
// checked first: the side effect ran, so it must never fall through to a
// retryable state.
export function stateForProposalError(err: ProposalErrorLike): ProposalCardState {
  if (err.reason === "COMPLETED_AFTER_RECOVERY" || err.sideEffectApplied === true) return "completed_after_recovery";
  if (err.status === 403) return "permission_denied";
  if (err.status === 404) return "not_available";
  if (err.status === 400) return "validation_error";
  if (err.reason === "EXPIRED") return "expired";
  if (err.reason === "WRONG_STATUS") return "already_actioned";
  return "recoverable_failure";
}

/** Only a generic recoverable failure (nothing was created) offers a retry. */
export function canRetryProposalState(state: ProposalCardState): boolean {
  return state === "recoverable_failure";
}

export function isProposalBusy(state: ProposalCardState): boolean {
  return state === "approving" || state === "executing" || state === "rejecting";
}

export function permissionDeniedMessage(reason: string | undefined): string {
  if (reason === "ENTITLEMENT_DENIED") {
    return "Your access doesn’t include creating Grow commitments. Ask a Brokerage Administrator if you believe this is wrong.";
  }
  if (reason === "EXECUTOR_NOT_AUTHORISED") {
    return "Only the person who approved this proposal (or a Brokerage Administrator) can create the commitment.";
  }
  return "You don’t have authority to approve this. Ask a Brokerage Administrator if you believe this is wrong.";
}

export const COMPLETED_AFTER_RECOVERY_MESSAGE =
  "The commitment may already have been created. Check this contact’s Commitments before doing anything else — don’t try again.";

export function isProposalExpired(expiresAt: string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return !Number.isNaN(time) && time <= now.getTime();
}

/** "Expires in 23h" / "Expires in 40m" / "Expired"; null when unknown. */
export function formatProposalExpiry(expiresAt: string | null, now: Date = new Date()): string | null {
  if (!expiresAt) return null;
  const time = new Date(expiresAt).getTime();
  if (Number.isNaN(time)) return null;
  const remainingMs = time - now.getTime();
  if (remainingMs <= 0) return "Expired";
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 60) return `Expires in ${Math.max(minutes, 1)}m`;
  return `Expires in ${Math.floor(minutes / 60)}h`;
}

export function provenanceLabel(provenance: CommitmentProposalProvenance | null | undefined): string | null {
  return provenance?.source === "call_review" ? "From call review" : null;
}

export function proposalStatusLabel(status: string): string {
  switch (status) {
    case "AWAITING_APPROVAL":
      return "Awaiting approval";
    case "APPROVED":
      return "Approved — not created yet";
    case "EXECUTING":
      return "Creating";
    case "COMPLETED":
      return "Commitment created";
    case "REJECTED":
      return "Rejected";
    case "EXPIRED":
      return "Expired";
    default:
      return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  }
}

/** Status pill for the card, following its live state after any action. */
export function proposalCardStatusLabel(state: ProposalCardState, status: string): string {
  switch (state) {
    case "review":
      return "Awaiting approval";
    case "approving":
    case "executing":
    case "rejecting":
      return "Working\u2026";
    case "approved":
      return "Approved \u2014 not created yet";
    case "executed":
      return "Commitment created";
    case "rejected":
      return "Rejected";
    case "expired":
      return "Expired";
    case "already_actioned":
      return "Already actioned";
    case "not_available":
      return "No longer available";
    case "completed_after_recovery":
      return "May already be created";
    default:
      return proposalStatusLabel(status);
  }
}

// AE GROW Pilot Readiness WP6b (P3-c) — the card's header line. It used to be
// the fixed string "Proposed follow-up — nothing created yet", which stayed on
// screen after the agent approved the proposal and the commitment had actually
// been created: the card's body said "Commitment created" while its own
// heading still said nothing had been. The heading now follows the same live
// state the status pill does.
export function proposalCardHeading(state: ProposalCardState, status: string): string {
  switch (state) {
    case "executed":
      return COMMITMENT_CREATED_HEADING;
    case "executing":
      return `${PROPOSED_COMMITMENT_PREFIX} — creating it…`;
    case "approved":
      return `${PROPOSED_COMMITMENT_PREFIX} — approved, not created yet`;
    case "approving":
      return `${PROPOSED_COMMITMENT_PREFIX} — approving…`;
    case "rejecting":
      return `${PROPOSED_COMMITMENT_PREFIX} — rejecting…`;
    case "rejected":
      return `${PROPOSED_COMMITMENT_PREFIX} — rejected, nothing created`;
    case "expired":
      return `${PROPOSED_COMMITMENT_PREFIX} — expired, nothing created`;
    case "already_actioned":
      return `${PROPOSED_COMMITMENT_PREFIX} — already actioned`;
    case "not_available":
      return `${PROPOSED_COMMITMENT_PREFIX} — no longer available`;
    case "completed_after_recovery":
      return COMMITMENT_MAY_EXIST_HEADING;
    default:
      // review / permission_denied / validation_error / recoverable_failure —
      // every one of these leaves nothing created.
      return status === "APPROVED"
        ? `${PROPOSED_COMMITMENT_PREFIX} — approved, not created yet`
        : `${PROPOSED_COMMITMENT_PREFIX} — nothing created yet`;
  }
}

/** Verified (not advisory) accent once the commitment actually exists. */
export function proposalCardHeadingAccentClass(state: ProposalCardState): string {
  return state === "executed" ? "ai-copilot-kind-verified" : "ai-copilot-kind-advisory";
}

// AE GROW Pilot Readiness WP6b (P3-d) — the API builds a proposal's
// humanReadableSummary from the action registry's summarize() (see
// apps/api/src/lib/ai/actions/registry.ts CREATE_GROW_COMMITMENT), which has
// only the input ids to work with and so renders "for contact #289". Every
// adapter below already carries the contact's real name alongside that
// summary, so the raw id reference is replaced client-side rather than shown
// to an agent. Only the *matching* party id is substituted: a summary that
// mentioned some other contact's id must never be relabelled with this
// contact's name. The one other rewrite is the G-6 name: a stored
// "follow-up commitment" is shown as a commitment. Due follow-ups and call
// follow-ups are not rewritten.
export function humaniseContactReference(summary: string, partyId: number | null, contactName: string | null): string {
  const name = contactName?.trim();
  const named = !name || partyId === null || !Number.isFinite(partyId)
    ? summary
    : summary.replace(new RegExp(`\\bcontact #${partyId}\\b`, "gi"), name);
  return showCommitmentNotFollowUp(named);
}

/** The card's state on mount (never auto-executes an approved proposal). */
export function initialProposalState(view: Pick<CommitmentProposalView, "status" | "expiresAt">, now: Date = new Date()): ProposalCardState {
  if (view.status === "APPROVED") return "approved";
  if (view.status === "EXPIRED") return "expired";
  if (view.status === "AWAITING_APPROVAL" && isProposalExpired(view.expiresAt, now)) return "expired";
  if (view.status !== "AWAITING_APPROVAL") return "already_actioned";
  return "review";
}

export function formatProposalDue(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? dueAt : date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

// ---------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------

/** Mirrors the API's GrowCommitmentProposalSummary (Ask AE / Coach). */
export interface AskAgentCommitmentProposal {
  actionRequestId: number;
  actionKey: "CREATE_GROW_COMMITMENT";
  humanReadableSummary: string;
  contactName: string;
  partyId: number;
  dueAt: string;
  timeZone: string;
  relatedPropertyId: number | null;
  relatedOpportunityId: number | null;
  reason: string;
  evidenceSummary: string | null;
  status: "AWAITING_APPROVAL" | "APPROVED";
  expiresAt: string | null;
  reviewUrl: string;
}

export function viewFromAskAgentProposal(proposal: AskAgentCommitmentProposal): CommitmentProposalView {
  return {
    actionRequestId: proposal.actionRequestId,
    summary: humaniseContactReference(proposal.humanReadableSummary, proposal.partyId, proposal.contactName),
    contactName: proposal.contactName,
    dueAt: proposal.dueAt,
    timeZone: proposal.timeZone,
    reason: proposal.reason,
    evidenceSummary: proposal.evidenceSummary,
    status: proposal.status,
    expiresAt: proposal.expiresAt,
    reviewUrl: proposal.reviewUrl,
    provenance: null,
  };
}

/** One row of GET /grow/ai-actions/pending-commitments. */
export interface PendingCommitmentProposal {
  id: number;
  actionKey: string;
  humanReadableSummary: string;
  input: unknown;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  provenance: CommitmentProposalProvenance | null;
}

export function viewFromPendingProposal(row: PendingCommitmentProposal, contactName: string | null): CommitmentProposalView {
  const input = (row.input && typeof row.input === "object" ? row.input : {}) as Record<string, unknown>;
  const description = typeof input.description === "string" ? input.description : null;
  const fromCall = row.provenance?.source === "call_review";
  const partyId = typeof input.partyId === "number" ? input.partyId : null;
  return {
    actionRequestId: row.id,
    // WP6b P3-d: the fallback summary is the same server-built string, so it
    // gets the same "contact #289" → name treatment.
    summary: description ?? humaniseContactReference(row.humanReadableSummary, partyId, contactName),
    contactName,
    dueAt: typeof input.dueAt === "string" ? input.dueAt : null,
    timeZone: null,
    reason: typeof input.reason === "string" ? input.reason : null,
    // A call-review proposal's evidence is ids only; the provenance label
    // says the same thing in words.
    evidenceSummary: !fromCall && typeof input.evidenceSummary === "string" ? input.evidenceSummary : null,
    status: row.status,
    expiresAt: row.expiresAt,
    reviewUrl: null,
    provenance: row.provenance ?? null,
  };
}
