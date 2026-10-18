// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { SET_DUE_FOLLOW_UP_LABEL } from "../lib/growTerms";
import { GROW_OPPORTUNITY_MANUAL_STAGES, type GrowOpportunityManualStage } from "@aee/domain";
import type { GrowAppraisalSummary } from "../lib/growAppraisals";
import {
  useAddGrowNote,
  useLogManualActivity,
  GrowNoteForm,
  GrowManualActivityForm,
} from "./GrowActivityLog";
import { GrowOpportunityAppraisalActions } from "./GrowAppraisals";
import { GrowNextActionForm } from "./GrowNextActionForm";
import { growErrorMessage, opportunityLifecycleOpen } from "./messages";
import {
  useUpdateOpportunityNextAction,
  useUpdateOpportunityLifecycle,
  useCanManageAppraisals,
} from "./useGrowMutations";

// The actions an opportunity ROW offers, shared by the Opportunities tab and
// Contact 360's opportunities table. View contact, View property, and Create
// follow-up landed with #56. Add note and Ask AE are the other non-outreach
// actions Grow Today already offers on the same opportunity record; they reuse
// Today's note write and Today's tab switch.
//
// Email and SMS are intentionally not copied here. Grow Today only shows them
// when the card carries a channel and the contact is not do-not-contact. This
// list does not have that contactability payload, and offering outreach without
// it would bypass the gate. View contact opens the record where those actions
// already live.
//
// onViewContact and onAskAE are null on Contact 360 — that table is already
// inside the contact, and Ask AE is a workspace-tab jump the contact screen
// does not own. Everywhere else they are the same jumps Grow Today makes.
export function GrowOpportunityRowActions({
  opportunityId,
  partyId,
  propertyId,
  stage,
  status,
  appraisal,
  canManageOpportunities,
  canAddNote,
  canViewContacts,
  onViewContact,
  onAskAE,
  onSaved,
}: {
  opportunityId: number;
  partyId: number | null;
  propertyId: number | null;
  stage: string;
  status: string;
  appraisal: GrowAppraisalSummary | null;
  canManageOpportunities: boolean;
  canAddNote: boolean;
  canViewContacts: boolean;
  onViewContact: ((partyId: number) => void) | null;
  onAskAE: (() => void) | null;
  onSaved: () => void;
}) {
  const [openForm, setOpenForm] = useState<"note" | "log" | "nextAction" | "lost" | null>(null);
  const [lostReason, setLostReason] = useState("");
  const canManageAppraisals = useCanManageAppraisals();
  const updateNextAction = useUpdateOpportunityNextAction(opportunityId, () => {
    setOpenForm(null);
    onSaved();
  });
  const addNote = useAddGrowNote(() => {
    setOpenForm(null);
    onSaved();
  });
  const logActivity = useLogManualActivity(() => {
    setOpenForm(null);
    onSaved();
  });
  const updateLifecycle = useUpdateOpportunityLifecycle(opportunityId, () => {
    setOpenForm(null);
    setLostReason("");
    onSaved();
  });
  const busy = addNote.isPending || logActivity.isPending || updateNextAction.isPending || updateLifecycle.isPending;
  const showAddNote = canAddNote && partyId !== null;
  const showLifecycle = canManageOpportunities && opportunityLifecycleOpen(status, stage);
  const stageChoices = (GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(stage)
    ? [...GROW_OPPORTUNITY_MANUAL_STAGES]
    : [stage, ...GROW_OPPORTUNITY_MANUAL_STAGES];
  const stageFieldId = `grow-opportunity-stage-${opportunityId}`;
  const lostReasonFieldId = `grow-opportunity-lost-reason-${opportunityId}`;
  const trimmedLostReason = lostReason.trim();
  const errorMessage = addNote.isError
    ? growErrorMessage(addNote.error, "Something went wrong. Try again.")
    : logActivity.isError
      ? growErrorMessage(logActivity.error, "Something went wrong. Try again.")
      : updateNextAction.isError
        ? growErrorMessage(updateNextAction.error, "Something went wrong. Try again.")
        : updateLifecycle.isError
          ? growErrorMessage(updateLifecycle.error, "Something went wrong. Try again.")
          : null;

  return (
    <div className="grow-action-card-actions">
      {showAddNote && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "note" ? null : "note")}
        >
          {openForm === "note" ? "Cancel" : "Add note"}
        </button>
      )}
      {showAddNote && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "log" ? null : "log")}
        >
          {openForm === "log" ? "Cancel" : "Log call or meeting"}
        </button>
      )}
      {canManageOpportunities && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={() => setOpenForm(openForm === "nextAction" ? null : "nextAction")}
        >
          {openForm === "nextAction" ? "Cancel" : SET_DUE_FOLLOW_UP_LABEL}
        </button>
      )}
      {propertyId !== null && (
        <Link href={`/properties/${propertyId}`} className="btn btn-link btn-small">
          View property
        </Link>
      )}
      {onViewContact !== null && canViewContacts && partyId !== null && (
        <button type="button" className="btn btn-link btn-small" onClick={() => onViewContact(partyId)}>
          View contact
        </button>
      )}
      {onAskAE !== null && (
        <button type="button" className="btn btn-link btn-small" onClick={onAskAE}>
          Ask AE
        </button>
      )}
      <GrowOpportunityAppraisalActions
        opportunityId={opportunityId}
        partyId={partyId}
        propertyId={propertyId}
        appraisal={appraisal}
        canWrite={canManageAppraisals}
      />
      {showLifecycle && (
        <div className="grow-opportunity-lifecycle">
          <label htmlFor={stageFieldId}>Change stage</label>
          <select
            id={stageFieldId}
            value={stage}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              if (!(GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(next) || next === stage) return;
              updateLifecycle.mutate({ stage: next as GrowOpportunityManualStage });
            }}
          >
            {stageChoices.map((choice) => (
              <option
                key={choice}
                value={choice}
                disabled={!(GROW_OPPORTUNITY_MANUAL_STAGES as readonly string[]).includes(choice)}
              >
                {choice}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "lost" ? null : "lost")}
          >
            {openForm === "lost" ? "Cancel" : "Mark lost"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            id={`grow-opportunity-close-${opportunityId}`}
            disabled={busy}
            aria-label="Close opportunity"
            onClick={() => updateLifecycle.mutate({ status: "Closed" })}
          >
            Close
          </button>
          {openForm === "lost" && (
            <form
              className="stack grow-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!trimmedLostReason) return;
                updateLifecycle.mutate({ status: "Lost", lostReason: trimmedLostReason });
              }}
            >
              <label htmlFor={lostReasonFieldId}>Lost reason</label>
              <input
                id={lostReasonFieldId}
                type="text"
                value={lostReason}
                required
                aria-required="true"
                onChange={(event) => setLostReason(event.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-small" disabled={busy || trimmedLostReason.length === 0}>
                Mark lost
              </button>
            </form>
          )}
        </div>
      )}
      {errorMessage && <p className="error-text" role="alert">{errorMessage}</p>}
      {openForm === "note" && partyId !== null && (
        <GrowNoteForm
          idPrefix={`grow-opportunity-note-${opportunityId}`}
          submitting={busy}
          onSubmit={(summary) =>
            addNote.mutate({
              summary,
              partyId,
              propertyId,
              opportunityId,
            })
          }
        />
      )}
      {openForm === "log" && partyId !== null && (
        <GrowManualActivityForm
          idPrefix={`grow-opportunity-activity-${opportunityId}`}
          submitting={busy}
          onSubmit={(input) =>
            logActivity.mutate({
              ...input,
              partyId,
              propertyId,
              opportunityId,
            })
          }
        />
      )}
      {openForm === "nextAction" && (
        <GrowNextActionForm
          idPrefix={`grow-opportunity-${opportunityId}`}
          submitting={busy}
          onSubmit={(vars) => updateNextAction.mutate(vars)}
        />
      )}
    </div>
  );
}
