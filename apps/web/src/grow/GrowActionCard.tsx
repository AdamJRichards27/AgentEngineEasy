// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  actionTypeLabel,
  canOfferChannel,
  contactabilityNotice,
  formatWhen,
  hasLinkedContact,
  priorityLabel,
  priorityPillClass,
  rankExplanationLines,
  rankSummaryLine,
  unlinkedContactNotice,
} from "../lib/growToday";
import { SET_DUE_FOLLOW_UP_LABEL } from "../lib/growTerms";
import { appraisalWorkspacePath } from "../lib/appraisalUi";
import { useAddGrowNote, GrowNoteForm } from "./GrowActivityLog";
import { GrowNextActionForm } from "./GrowNextActionForm";
import { GrowRescheduleControl } from "./GrowRescheduleControl";
import { growErrorMessage } from "./messages";
import type { GrowActionCardProps } from "./types";
import { useUpdateOpportunityNextAction, useUpdateGrowCommitment } from "./useGrowMutations";

// One card renders every supported action for that item, same "no separate detail screen"
// convention PitCrewCommandCentre.tsx's PcItemCard already established for this codebase. Every
// button rendered here is backed by a real, already-working capability (POST /grow/activities,
// PATCH /grow/opportunities/:id, or a real /properties/:id link) -- nothing here is a dead
// button, and each one is additionally hidden unless the signed-in user actually holds the
// entitlement that write requires (see canAddNote/canManageOpportunities above), so a button
// that would just 403 is never shown in the first place.
//
// AE GROW Priority 2 §12: "View Contact" follows the exact same precedent as "View property"
// below (showViewProperty) — a plain button, gated on the read entitlement the destination tab
// itself requires (canViewContacts = grow.contacts.read), never on item.availableActions, since
// every GrowTodayAction already carries a real item.partyId and no change to
// apps/api/src/lib/growToday.ts (Priority 1's own, already-shipped ranking logic) was needed or
// made to add this.
export function GrowActionCard({
  item,
  canAddNote,
  canManageOpportunities,
  canViewContacts,
  canManageContactComms,
  onAskAE,
  onViewContact,
  onEmailContact,
  onSmsContact,
}: GrowActionCardProps) {
  const queryClient = useQueryClient();
  const [openForm, setOpenForm] = useState<"note" | "nextAction" | null>(null);

  function invalidateToday() {
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  }

  // Same note write the Opportunities tab uses. The form unmounts on success,
  // which clears its field — there is no second copy of the POST body.
  const addNote = useAddGrowNote(() => {
    setOpenForm(null);
    invalidateToday();
  });

  // AE GROW Completion W2-B (E-3): this card's follow-up mutation now lives in
  // useUpdateOpportunityNextAction above, so the two opportunity tables offer
  // the identical write rather than each growing their own copy. Nothing about
  // what this card does changed — the form's own field state simply moved into
  // GrowNextActionForm, which unmounts (and therefore clears) when it closes.
  const updateNextAction = useUpdateOpportunityNextAction(item.opportunityId, () => {
    setOpenForm(null);
    invalidateToday();
  });

  // G-UAT-1 / G-UAT-4 — same commitment PATCH Contact 360 uses. Completing
  // drops the row from Today because Grow Today only reads Open commitments.
  // Rescheduling changes dueAt; invalidating Today lets the card leave
  // Overdue when the new time is no longer due. Cancel stays on Contact 360.
  const completeCommitment = useUpdateGrowCommitment(() => {
    invalidateToday();
  });

  // AE GROW Signal Sweep stage 3: every contact-anchored affordance is now
  // additionally gated on the card actually HAVING a contact. A Property
  // Intelligence signal derived from a provider observation is anchored to a
  // property and has no party at all — it used to be dropped from Today
  // entirely, which is the defect stage 3 fixes, so the UI has to cope with
  // it rather than assume item.partyId is always a number.
  const linkedContact = hasLinkedContact(item);
  const showAddNote = canAddNote && linkedContact && item.availableActions.some((b) => b.action === "add_note");
  const showUpdateNextAction =
    canManageOpportunities && item.opportunityId !== null && item.availableActions.some((b) => b.action === "update_next_action");
  const showViewProperty = item.propertyId !== null && item.availableActions.some((b) => b.action === "view_property");
  // E-2: Rule E's primary action is view_appraisal. It opens the Appraisal
  // Workspace at /grow/appraisals/:id. A card with no appraisal id does not
  // invent a link. View property stays on /properties/:id.
  const viewAppraisal = item.availableActions.find(
    (b): b is { action: "view_appraisal"; appraisalId: number } => b.action === "view_appraisal",
  );
  const showViewAppraisal = viewAppraisal !== undefined && viewAppraisal.appraisalId > 0;
  const showViewContact = canViewContacts && linkedContact;
  // AE GROW Priority 3 §4: gated on both the grow.contacts.manage entitlement (see
  // canManageContactComms above) and the contact actually having that channel on file.
  //
  // AE GROW Signal Sweep stage 3: that check now lives in ONE place —
  // lib/growToday.ts's canOfferChannel — which additionally refuses any card
  // marked do_not_contact and fails closed on an unrecognised contactability
  // value. The server already withholds prospecting items for a suppressed
  // contact and nulls their contact fields, so this is a third independent
  // guard, not the only one.
  const showEmail = canManageContactComms && canOfferChannel(item, "email");
  const showSms = canManageContactComms && canOfferChannel(item, "sms");
  const showAskAE = item.availableActions.some((b) => b.action === "ask_ae");
  // canAddNote is grow.activities.manage, the same entitlement Contact 360
  // checks before it offers Complete on an Open commitment.
  const showCompleteCommitment = canAddNote && item.commitmentId !== null;

  const consentNotice = contactabilityNotice(item);
  const kindLabel = actionTypeLabel(item.type);
  const unlinkedNotice = unlinkedContactNotice(item);
  const why = item.whyItMatters;
  const rankSummary = rankSummaryLine(item);
  const rankLines = rankExplanationLines(item);

  const busy = addNote.isPending || updateNextAction.isPending || completeCommitment.isPending;
  const errorMessage: string | null = addNote.isError
    ? growErrorMessage(addNote.error, "Something went wrong. Try again.")
    : updateNextAction.isError
    ? growErrorMessage(updateNextAction.error, "Something went wrong. Try again.")
    : completeCommitment.isError
    ? growErrorMessage(completeCommitment.error, "Something went wrong. Try again.")
    : null;

  return (
    <li className="grow-action-card">
      <div className="grow-action-card-header">
        <span className={priorityPillClass(item.priority)}>{priorityLabel(item.priority)}</span>
        {kindLabel ? <span className="pill">{kindLabel}</span> : null}
        <strong>{item.contactName}</strong>
        {item.propertyLabel ? <span className="muted"> — {item.propertyLabel}</span> : null}
      </div>
      {/* AE GROW Signal Sweep stage 3: a do-not-contact notice leads the card,
          above the reason and the recommendation, so it can never be missed by
          somebody skimming. It only ever appears on an agent's own dated
          commitment — prospecting items for a suppressed contact are withheld
          by the server and never reach this component. */}
      {consentNotice && (
        <p className="error-text grow-action-consent-notice" role="note">
          <strong>Do not contact.</strong> {consentNotice}
        </p>
      )}

      <p className="muted grow-action-reason">{item.reason}</p>

      {/* AE GROW Signal Sweep stage 3 — EXPLAINABILITY. A ranked signal must
          say why it matters in language the agent can act on and repeat to a
          homeowner, and the rank itself is only ever shown alongside the
          itemised factors that produced it. A bare score is not an
          explanation. */}
      {why && (
        <div className="grow-action-why">
          <p className="grow-action-why-headline">{why.headline}</p>
          {why.talkingPoint && (
            <p className="grow-action-why-talking-point">
              <strong>You could ask:</strong> {why.talkingPoint}
            </p>
          )}
          <p className="muted grow-action-why-caution">{why.caution}</p>
          {rankLines.length > 0 && (
            <details className="grow-action-why-factors">
              <summary>{rankSummary ?? "Why AE ranked this here"}</summary>
              <ul>
                {rankLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <p>Recommended: {item.recommendedAction}</p>
      {unlinkedNotice && <p className="muted grow-action-unlinked-notice">{unlinkedNotice}</p>}
      <p className="muted">
        {item.dueAt
          ? `Due ${formatWhen(item.dueAt)}`
          : item.lastActivityAt
          ? `Last contact ${formatWhen(item.lastActivityAt)}`
          : "No contact recorded yet"}
        {item.relationshipType ? ` · ${item.relationshipType.replace(/_/g, " ")}` : null}
      </p>

      {errorMessage && <p className="error-text">{errorMessage}</p>}

      <div className="grow-action-card-actions">
        {showCompleteCommitment && (
          <button
            type="button"
            className="btn btn-link btn-small"
            disabled={busy}
            onClick={() => {
              if (item.commitmentId === null) return;
              completeCommitment.mutate({ id: item.commitmentId, status: "Completed" });
            }}
          >
            Complete
          </button>
        )}
        {showCompleteCommitment && item.commitmentId !== null && (
          <GrowRescheduleControl
            idPrefix={`grow-today-commitment-${item.commitmentId}`}
            busy={busy}
            onSubmit={(dueAt) => {
              if (item.commitmentId === null) return;
              completeCommitment.mutate({ id: item.commitmentId, dueAt });
            }}
          />
        )}
        {showAddNote && (
          <button
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "note" ? null : "note")}
          >
            Add note
          </button>
        )}
        {showUpdateNextAction && (
          <button
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => setOpenForm(openForm === "nextAction" ? null : "nextAction")}
          >
            {SET_DUE_FOLLOW_UP_LABEL}
          </button>
        )}
        {showViewAppraisal && viewAppraisal && (
          <Link href={appraisalWorkspacePath(viewAppraisal.appraisalId)} className="btn btn-link btn-small">
            View appraisal
          </Link>
        )}
        {showViewProperty && item.propertyId !== null && (
          <Link href={`/properties/${item.propertyId}`} className="btn btn-link btn-small">
            View property
          </Link>
        )}
        {/* The `item.partyId !== null` repeated below is what proves to the
            compiler what showViewContact/showEmail/showSms already guarantee:
            a contact-anchored button is never rendered for a card that has no
            contact. */}
        {showViewContact && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onViewContact(item.partyId as number)}>
            View contact
          </button>
        )}
        {showEmail && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onEmailContact(item.partyId as number)}>
            Email
          </button>
        )}
        {showSms && item.partyId !== null && (
          <button type="button" className="btn btn-link btn-small" onClick={() => onSmsContact(item.partyId as number)}>
            SMS
          </button>
        )}
        {showAskAE && (
          <button type="button" className="btn btn-link btn-small" onClick={onAskAE}>
            Ask AE
          </button>
        )}
      </div>

      {openForm === "note" && item.partyId !== null && (
        <GrowNoteForm
          idPrefix={`grow-note-${item.id}`}
          submitting={busy}
          onSubmit={(summary) =>
            addNote.mutate({
              summary,
              partyId: item.partyId as number,
              propertyId: item.propertyId,
              opportunityId: item.opportunityId,
            })
          }
        />
      )}

      {openForm === "nextAction" && (
        <GrowNextActionForm idPrefix={`grow-next-action-${item.id}`} submitting={busy} onSubmit={(vars) => updateNextAction.mutate(vars)} />
      )}
    </li>
  );
}
