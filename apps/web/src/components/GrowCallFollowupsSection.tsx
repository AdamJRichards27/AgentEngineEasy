import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../lib/api";
import {
  buildProposePayload,
  callFollowupsQueryKey,
  canProposeCandidate,
  cardRequestForCandidate,
  CONSENT_BLOCKED_MESSAGE,
  followupErrorMessage,
  followupInvalidationKeys,
  followupItemTypeLabel,
  followupKey,
  followupStatus,
  followupStatusPillClass,
  isDraftDueDateConfirmed,
  mergeFollowupDrafts,
  proposeDisabledReason,
  retainOutcomes,
  setDraftDueDate,
  setDraftDueDateConfirmed,
  summarizeProposeOutcomes,
  viewFromFollowupRequest,
  type CallFollowupProposalOutcome,
  type CallFollowupsResponse,
  type FollowupActionRequestSummary,
  type FollowupDraft,
  type ProposeFollowupsPayload,
} from "../lib/callFollowups";
import { GrowCommitmentProposalCard } from "./GrowCommitmentProposalCard";
import { CALL_ITEMS_EMPTY, CALL_ITEMS_HELP, CALL_ITEMS_LOADING, CALL_ITEMS_TITLE, PROPOSE_SELECTED_LABEL } from "../lib/growTerms";

function errorFrom(error: unknown): string {
  return error instanceof ApiError
    ? followupErrorMessage({ status: error.status, code: error.code, friendly: error.friendly })
    : "Couldn’t reach the server. Try again.";
}

// AE GROW Priority 6 Stage F4.3 — "Follow-ups from this call".
//
// Rendered by GrowContactTranscriptPanel for a saved (APPROVED /
// PARTIALLY_APPROVED) call review only. Lists the human-approved COMMITMENT
// and FOLLOWUP items (read-only text) and lets the agent, with explicit
// clicks only, turn selected items into Stage D CREATE_GROW_COMMITMENT
// proposals. A suggested due date is only a pre-fill: each selected item's
// date must be explicitly confirmed (the "Confirm due date" checkbox, which
// clears again whenever the date changes) before it can be proposed.
// Nothing is proposed, approved, or executed automatically; approval and
// creation happen on the shared GrowCommitmentProposalCard through the
// existing governed /ai/actions/requests/:id routes.
export function GrowCallFollowupsSection({
  callSessionId,
  transcriptionId,
  partyId,
  contactName,
}: {
  callSessionId: number;
  transcriptionId: number;
  partyId: number;
  contactName: string | null;
}) {
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, FollowupDraft>>({});
  const [localRequests, setLocalRequests] = useState<Record<string, FollowupActionRequestSummary>>({});
  const [lastOutcomes, setLastOutcomes] = useState<CallFollowupProposalOutcome[] | null>(null);
  const followups = useQuery<CallFollowupsResponse>({
    queryKey: callFollowupsQueryKey(callSessionId, transcriptionId),
    queryFn: () => apiFetch(`/grow/calls/${callSessionId}/transcription/${transcriptionId}/followups`),
    retry: false,
  });
  const candidates = followups.data?.candidates ?? [];
  const consentBlocked = followups.data?.consentBlocked ?? false;

  useEffect(() => {
    if (followups.data) setDrafts((current) => mergeFollowupDrafts(current, followups.data!.candidates));
  }, [followups.data]);

  function refreshReadModels() {
    for (const queryKey of followupInvalidationKeys(partyId)) {
      queryClient.invalidateQueries({ queryKey });
    }
  }

  const propose = useMutation({
    mutationFn: (payload: ProposeFollowupsPayload) =>
      apiFetch<{ proposals: CallFollowupProposalOutcome[] }>(
        `/grow/calls/${callSessionId}/transcription/${transcriptionId}/followups/propose`,
        { method: "POST", body: JSON.stringify(payload) },
      ),
    onSuccess: ({ proposals }) => {
      setLastOutcomes(proposals);
      setLocalRequests((current) => retainOutcomes(current, proposals));
      // Proposed items are no longer selectable; clear their selection.
      setDrafts((current) => {
        const next = { ...current };
        for (const outcome of proposals) {
          const key = followupKey(outcome);
          if (next[key]) next[key] = { ...next[key]!, selected: false };
        }
        return next;
      });
    },
    // Refresh even on failure: AUDIT_INCOMPLETE / POLICY_DENIED can leave
    // real proposals behind that the list must now show.
    onSettled: refreshReadModels,
  });

  function updateDraft(key: string, update: (draft: FollowupDraft) => FollowupDraft) {
    setDrafts((current) => (current[key] ? { ...current, [key]: update(current[key]!) } : current));
  }

  const disabledReason = proposeDisabledReason(candidates, drafts, consentBlocked);

  function submit() {
    if (propose.isPending || disabledReason !== null) return;
    const payload = buildProposePayload(candidates, drafts, consentBlocked);
    if (payload.items.length === 0) return;
    propose.mutate(payload);
  }

  return (
    <div className="grow-call-followups">
      <div className="grow-review-group-title"><strong>{CALL_ITEMS_TITLE}</strong></div>
      <p className="muted">{CALL_ITEMS_HELP}</p>
      {followups.isLoading && <p className="muted">{CALL_ITEMS_LOADING}</p>}
      {followups.isError && <p className="error-text">{errorFrom(followups.error)}</p>}
      {followups.data && candidates.length === 0 && (
        <p className="empty-state">{CALL_ITEMS_EMPTY}</p>
      )}
      {followups.data && consentBlocked && candidates.length > 0 && (
        <p className="grow-review-advisory" role="status">{CONSENT_BLOCKED_MESSAGE}</p>
      )}
      {candidates.map((candidate) => {
        const key = followupKey(candidate);
        const draft = drafts[key];
        const proposable = canProposeCandidate(candidate, consentBlocked);
        const status = followupStatus(candidate);
        const cardRequest = cardRequestForCandidate(candidate, localRequests);
        const label = followupItemTypeLabel(candidate.itemType);
        const idBase = `grow-followup-${transcriptionId}-${candidate.itemType}-${candidate.itemId}`.replace(/[^A-Za-z0-9_-]/g, "-");
        const confirmed = isDraftDueDateConfirmed(draft);
        return (
          <div className="grow-review-item grow-followup-item" key={key}>
            <div className="grow-followup-item-header">
              <span className="eyebrow">{label}</span>
              <span className={followupStatusPillClass(status.tone)}>{status.label}</span>
            </div>
            <p className="grow-followup-text" id={`${idBase}-text`}>{candidate.text}</p>
            {proposable && draft && (
              <div className="grow-followup-controls">
                <label className="grow-followup-check" htmlFor={`${idBase}-select`}>
                  <input
                    id={`${idBase}-select`}
                    aria-describedby={`${idBase}-text`}
                    type="checkbox"
                    checked={draft.selected}
                    disabled={propose.isPending}
                    onChange={(event) => updateDraft(key, (current) => ({ ...current, selected: event.target.checked }))}
                  />
                  Propose as a commitment
                </label>
                <label className="grow-followup-date" htmlFor={`${idBase}-due`}>
                  Due date
                  <input
                    id={`${idBase}-due`}
                    aria-describedby={`${idBase}-text`}
                    type="date"
                    aria-label={`${label} due date`}
                    value={draft.dueDate}
                    disabled={propose.isPending}
                    onChange={(event) => updateDraft(key, (current) => setDraftDueDate(current, event.target.value))}
                  />
                </label>
                <label className="grow-followup-check" htmlFor={`${idBase}-confirm`}>
                  <input
                    id={`${idBase}-confirm`}
                    aria-describedby={`${idBase}-text`}
                    type="checkbox"
                    checked={confirmed}
                    disabled={propose.isPending || !draft.dueDate}
                    onChange={(event) => updateDraft(key, (current) => setDraftDueDateConfirmed(current, event.target.checked))}
                  />
                  Confirm due date
                </label>
                {candidate.suggestedDueAt !== null && !confirmed && draft.dueDate !== "" && (
                  <small className="muted">Suggested from the call — confirm or change it.</small>
                )}
              </div>
            )}
            {cardRequest !== null && (
              <GrowCommitmentProposalCard
                key={cardRequest.actionRequestId}
                proposal={viewFromFollowupRequest(cardRequest, candidate, { transcriptionId, contactName })}
                dismissible={false}
                onSettled={() => {
                  // Keep this card (and its outcome message) visible after
                  // the refreshed list moves the item to a new status.
                  setLocalRequests((current) => ({ ...current, [key]: cardRequest }));
                  refreshReadModels();
                }}
              />
            )}
          </div>
        );
      })}
      {lastOutcomes !== null && <p className="muted" role="status">{summarizeProposeOutcomes(lastOutcomes)}</p>}
      {propose.isError && <p className="error-text">{errorFrom(propose.error)}</p>}
      {candidates.length > 0 && (
        <div className="grow-call-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={propose.isPending || disabledReason !== null}
            aria-describedby={disabledReason !== null && !consentBlocked ? `grow-followups-hint-${transcriptionId}` : undefined}
            onClick={submit}
          >
            {propose.isPending ? "Proposing…" : PROPOSE_SELECTED_LABEL}
          </button>
          {disabledReason !== null && !consentBlocked && (
            <small className="muted" id={`grow-followups-hint-${transcriptionId}`}>{disabledReason}</small>
          )}
        </div>
      )}
    </div>
  );
}
