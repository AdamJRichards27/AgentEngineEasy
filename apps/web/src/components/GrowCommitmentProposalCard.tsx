import { useState } from "react";
import { Link } from "wouter";
import { apiFetch, ApiError } from "../lib/api";
import {
  canRetryProposalState,
  COMPLETED_AFTER_RECOVERY_MESSAGE,
  formatProposalDue,
  formatProposalExpiry,
  initialProposalState,
  isProposalBusy,
  permissionDeniedMessage,
  proposalCardStatusLabel,
  provenanceLabel,
  stateForProposalError,
  type CommitmentProposalView,
  type ProposalCardState,
} from "../lib/commitmentProposals";

interface GrowCommitmentExecutionResult {
  id: number;
}

// AE GROW Priority 6 Stage D (extracted and made reusable in Stage F4.3) —
// the human review/approval surface for one already-proposed
// CREATE_GROW_COMMITMENT action request. Used by Ask AE / Business Coach
// (AskAgentEngine.tsx), by "Follow-ups from this call"
// (GrowCallFollowupsSection.tsx), and by Contact 360's pending proposals
// list (GrowPendingCommitmentProposals.tsx).
//
// Deliberately calls only the existing, unmodified generic governance router
// (`/ai/actions/requests/:id/{approve,reject,execute}`) by the
// actionRequestId the backend already resolved and validated server-side —
// this component never re-implements any policy/ownership/tamper check
// itself, never proposes anything, and never lets the agent pick which
// action or actor type runs.
//
// "Approve & Create Commitment" is one deliberate click from the agent's
// point of view — the two-step approve-then-execute state machine
// underneath (unmodified Action Requests / Execution Gateway) is not
// something this UI asks the agent to trigger as two separate clicks. A
// proposal handed over already in "APPROVED" status shows a dedicated
// "Create commitment" button instead of auto-executing on mount, since
// executing a real write never happens without an explicit click.
//
// Every button is only rendered in a non-busy state, so a second click
// while a request is in flight is impossible. A COMPLETED_AFTER_RECOVERY
// execute outcome (the commitment may already exist) never offers a retry.
export function GrowCommitmentProposalCard({
  proposal,
  dismissible = true,
  onSettled,
}: {
  proposal: CommitmentProposalView;
  // "Not now" (close without deciding, never calls any endpoint). Off for
  // persistent lists where hiding a card locally would only confuse.
  dismissible?: boolean;
  // Called after every governed call returns (success or failure) so the
  // parent can refresh its read models. Never used to retry anything.
  onSettled?: (state: ProposalCardState) => void;
}) {
  const [state, setState] = useState<ProposalCardState>(() => initialProposalState(proposal));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<string | undefined>(undefined);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [createdCommitmentId, setCreatedCommitmentId] = useState<number | null>(null);
  // Where "Try again" returns to: an execute failure after a successful
  // approval retries only the execute step (re-approving would be refused).
  const [retryState, setRetryState] = useState<"review" | "approved">("review");

  function fail(err: unknown): ProposalCardState {
    const apiErr = err instanceof ApiError ? err : null;
    const next = apiErr !== null ? stateForProposalError(apiErr) : "recoverable_failure";
    setErrorReason(apiErr?.reason);
    // The dedicated state message is clearer than the generic friendly text
    // for every mapped state; only the generic failure shows the latter.
    setErrorMessage(next === "recoverable_failure" ? apiErr?.friendly ?? "Something went wrong. Try again." : null);
    setState(next);
    return next;
  }

  async function runExecute() {
    setState("executing");
    setErrorMessage(null);
    let outcome: ProposalCardState = "executed";
    try {
      const result = await apiFetch<{ request: { id: number; status: string }; result: GrowCommitmentExecutionResult | null }>(
        `/ai/actions/requests/${proposal.actionRequestId}/execute`,
        { method: "POST" },
      );
      setCreatedCommitmentId(result.result !== null && result.result !== undefined ? result.result.id : null);
      setState("executed");
    } catch (err) {
      setRetryState("approved");
      outcome = fail(err);
    }
    onSettled?.(outcome);
  }

  async function handleApprove() {
    if (isProposalBusy(state)) return;
    setState("approving");
    setErrorMessage(null);
    try {
      await apiFetch(`/ai/actions/requests/${proposal.actionRequestId}/approve`, { method: "POST" });
    } catch (err) {
      setRetryState("review");
      // Evaluate fail() unconditionally: `onSettled?.(fail(err))` would skip
      // the argument entirely when no onSettled is passed.
      const failedState = fail(err);
      onSettled?.(failedState);
      return;
    }
    // Approval succeeded — immediately execute, so the agent's one click
    // reads through to "Commitment created". A failure here is still
    // reported as its own state rather than silently swallowed.
    await runExecute();
  }

  async function handleReject() {
    if (isProposalBusy(state)) return;
    const reasonText = rejectReason.trim().length > 0 ? rejectReason.trim() : "Not needed right now.";
    setState("rejecting");
    setErrorMessage(null);
    let outcome: ProposalCardState = "rejected";
    try {
      await apiFetch(`/ai/actions/requests/${proposal.actionRequestId}/reject`, {
        method: "POST",
        body: JSON.stringify({ reason: reasonText }),
      });
      setState("rejected");
    } catch (err) {
      setRetryState("review");
      outcome = fail(err);
    }
    onSettled?.(outcome);
  }

  if (state === "dismissed") {
    return null;
  }

  const dueLabel = formatProposalDue(proposal.dueAt);
  const expiryLabel = state === "review" || state === "approved" ? formatProposalExpiry(proposal.expiresAt) : null;
  const sourceLabel = provenanceLabel(proposal.provenance);
  const fromCall = sourceLabel !== null;
  const rejectInputId = `grow-commitment-reject-reason-${proposal.actionRequestId}`;

  return (
    <div className="ai-copilot-proposal grow-commitment-proposal" aria-live="polite" aria-atomic="true">
      <div className="grow-commitment-proposal-header">
        <div className="eyebrow ai-copilot-kind-advisory">Proposed follow-up — nothing created yet</div>
        <div className="grow-commitment-proposal-meta">
          {sourceLabel !== null && <span className="pill">{sourceLabel}</span>}
          <span className="pill">{proposalCardStatusLabel(state, proposal.status)}</span>
          {expiryLabel !== null && (
            <span className={`pill ${expiryLabel === "Expired" ? "pill-danger" : "pill-warning"}`}>{expiryLabel}</span>
          )}
        </div>
      </div>
      <p>{proposal.summary}</p>
      <ul className="ai-copilot-proposal-details">
        {proposal.contactName !== null && <li>Contact: {proposal.contactName}</li>}
        {dueLabel !== null && (
          <li>
            Due: {dueLabel}
            {proposal.timeZone !== null ? ` · ${proposal.timeZone}` : ""}
          </li>
        )}
        {proposal.reason !== null && (
          <li>
            {fromCall ? "Source" : "Why AE suggested this"}: {proposal.reason}
          </li>
        )}
        {proposal.evidenceSummary !== null && <li>Evidence: {proposal.evidenceSummary}</li>}
      </ul>

      {errorMessage !== null && <p className="error-text">{errorMessage}</p>}

      {state === "review" && (
        <>
          <div className="ai-copilot-proposal-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={handleApprove}>
              Approve &amp; Create Commitment
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              aria-expanded={showRejectForm}
              aria-controls={showRejectForm ? rejectInputId : undefined}
              onClick={() => setShowRejectForm((v) => !v)}
            >
              Reject
            </button>
            {dismissible && (
              <button type="button" className="btn btn-link btn-small" onClick={() => setState("dismissed")}>
                Not now
              </button>
            )}
          </div>
          {showRejectForm && (
            <form
              className="stack grow-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleReject();
              }}
            >
              <label htmlFor={rejectInputId}>Reason (optional)</label>
              <input
                id={rejectInputId}
                type="text"
                placeholder="e.g. Already followed up"
                value={rejectReason}
                maxLength={2000}
                onChange={(e) => setRejectReason(e.target.value)}
              />
              <button className="btn btn-secondary btn-small" type="submit">
                Confirm rejection
              </button>
            </form>
          )}
        </>
      )}

      {state === "approving" && (
        <p className="ai-copilot-loading">
          <span className="ai-copilot-spinner" aria-hidden="true" />
          Approving…
        </p>
      )}

      {state === "approved" && (
        <div className="ai-copilot-proposal-actions">
          <p className="muted">Already approved — the commitment has not been created yet.</p>
          <button type="button" className="btn btn-primary btn-small" onClick={runExecute}>
            Create commitment
          </button>
        </div>
      )}

      {state === "executing" && (
        <p className="ai-copilot-loading">
          <span className="ai-copilot-spinner" aria-hidden="true" />
          Creating the commitment…
        </p>
      )}

      {state === "executed" && (
        <p>
          Commitment created.{" "}
          {proposal.reviewUrl !== null ? (
            <Link href={proposal.reviewUrl}>{createdCommitmentId !== null ? `View in Grow (#${createdCommitmentId})` : "View in Grow"}</Link>
          ) : (
            <span className="muted">It now appears in this contact&rsquo;s Commitments.</span>
          )}
        </p>
      )}

      {state === "rejecting" && (
        <p className="ai-copilot-loading">
          <span className="ai-copilot-spinner" aria-hidden="true" />
          Rejecting…
        </p>
      )}

      {state === "rejected" && <p className="muted">Rejected. No commitment was created.</p>}

      {state === "expired" && (
        <p className="muted">
          {fromCall
            ? "This proposal has expired. No commitment was created — you can propose this follow-up again from the call review."
            : "This proposal has expired. Ask AE again to generate a fresh one if it’s still needed."}
        </p>
      )}

      {state === "already_actioned" && (
        <p className="muted">This proposal has already been actioned (approved, rejected, or executed elsewhere) — no further action is possible here.</p>
      )}

      {state === "not_available" && (
        <p className="muted">This proposal is no longer available — it may have been removed or actioned elsewhere. Nothing was created here.</p>
      )}

      {state === "permission_denied" && <p className="error-text">{permissionDeniedMessage(errorReason)}</p>}

      {state === "validation_error" && <p className="error-text">That didn&rsquo;t go through. Check the details and try again.</p>}

      {state === "completed_after_recovery" && <p className="error-text">{COMPLETED_AFTER_RECOVERY_MESSAGE}</p>}

      {state === "recoverable_failure" && canRetryProposalState(state) && (
        <div className="ai-copilot-proposal-actions">
          <p className="muted">Nothing further was created. You can try again.</p>
          <button type="button" className="btn btn-secondary btn-small" onClick={() => setState(retryState)}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
