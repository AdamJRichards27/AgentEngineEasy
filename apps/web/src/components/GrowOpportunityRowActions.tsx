// Contact 360 opportunity row actions, their forms/hooks, appraisal actions and the Contact 360 opportunities section
// (moved verbatim from pages/Grow.tsx, Contact 360 PR5). No behaviour change.
// Import specifiers use "../lib/..." / "../components/..." so the behaviour-test module mocks still match.

import { ApiError, apiErrorMessage, apiFetch } from "../lib/api";
import { DUE_FOLLOW_UP_FORM_HINT, SAVE_DUE_FOLLOW_UP_LABEL, SET_DUE_FOLLOW_UP_LABEL } from "../lib/growTerms";
import { GROW_OPPORTUNITY_MANUAL_STAGES, type GrowOpportunityManualStage } from "@aee/domain";
import { type GrowAppraisalSummary, LINK_PROPERTY_BEFORE_APPRAISAL, appraisalForProperty, appraisalReadOnlyReason, appraisalStatusLabel } from "../lib/growAppraisals";
import { type GrowContact360Opportunity, opportunityLifecycleOpen, opportunityStatusLabel } from "../lib/growContact360";
import { GrowNewOpportunityForm } from "../components/GrowNewOpportunityForm";
import { GrowTableScroll } from "../components/GrowTableScroll";
import { Link } from "wouter";
import { appraisalWorkspacePath } from "../lib/appraisalUi";
import { formatWhen } from "../lib/growToday";
import { growErrorMessage } from "../lib/growErrors";
import { useEntitlements } from "../lib/session";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

export interface GrowNextActionInput {
  nextActionDueAt?: string;
  recommendedNextAction?: string;
}

export function useUpdateOpportunityNextAction(opportunityId: number | null, onSaved: () => void) {
  return useMutation<unknown, unknown, GrowNextActionInput>({
    mutationFn: (vars) =>
      apiFetch(`/grow/opportunities/${opportunityId}`, {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: onSaved,
  });
}

export type GrowOpportunityLifecycleInput =
  | { stage: GrowOpportunityManualStage }
  | { status: "Lost"; lostReason: string }
  | { status: "Closed" };

export function useUpdateOpportunityLifecycle(opportunityId: number, onSaved: () => void) {
  return useMutation<unknown, unknown, GrowOpportunityLifecycleInput>({
    mutationFn: (body) =>
      apiFetch(`/grow/opportunities/${opportunityId}/lifecycle`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: onSaved,
  });
}

// Owns its own field state, so closing the form is what clears it — the caller
// no longer has to remember to reset two strings on success. `idPrefix` keeps
// the label/input association unique when several of these are on screen at
// once (one per row of a table).
export function GrowNextActionForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (vars: GrowNextActionInput) => void;
}) {
  const [nextActionDate, setNextActionDate] = useState("");
  const [nextActionText, setNextActionText] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const vars: GrowNextActionInput = {};
        if (nextActionDate) vars.nextActionDueAt = new Date(nextActionDate).toISOString();
        if (nextActionText.trim()) vars.recommendedNextAction = nextActionText.trim();
        if (!vars.nextActionDueAt && !vars.recommendedNextAction) return;
        onSubmit(vars);
      }}
    >
      <label htmlFor={`${idPrefix}-date`}>Next action due</label>
      <input id={`${idPrefix}-date`} type="date" value={nextActionDate} onChange={(e) => setNextActionDate(e.target.value)} />
      <label htmlFor={`${idPrefix}-text`}>Recommended next action</label>
      <input
        id={`${idPrefix}-text`}
        type="text"
        placeholder="e.g. Call to confirm appraisal time"
        value={nextActionText}
        onChange={(e) => setNextActionText(e.target.value)}
      />
      <p className="muted">{DUE_FOLLOW_UP_FORM_HINT}</p>
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        {SAVE_DUE_FOLLOW_UP_LABEL}
      </button>
    </form>
  );
}

export interface GrowNoteInput {
  summary: string;
  partyId: number;
  propertyId: number | null;
  opportunityId: number | null;
}

// POST /grow/activities with activityType "note" is the one write behind
// "Add note". Grow Today's card has used it since Priority 1. Opportunity rows
// call this same helper so a note saved from the Opportunities tab cannot drift
// from a note saved on Today.
export function useAddGrowNote(onSaved: () => void) {
  return useMutation<unknown, unknown, GrowNoteInput>({
    mutationFn: (input) =>
      apiFetch("/grow/activities", {
        method: "POST",
        body: JSON.stringify({
          activityType: "note",
          summary: input.summary,
          partyId: input.partyId,
          ...(input.propertyId ? { propertyId: input.propertyId } : {}),
          ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
        }),
      }),
    onSuccess: onSaved,
  });
}

export interface GrowManualActivityInput {
  activityType: "call" | "meeting";
  summary: string;
  occurredAt: string;
  partyId: number;
  propertyId: number | null;
  opportunityId: number | null;
  durationMinutes: number | null;
  outcome: string | null;
}

// POST /grow/activities for a call or meeting that already happened.
// The body is an activity row. Nothing here opens a call, a recording,
// transcription, or a provider.
export function useLogManualActivity(onSaved: () => void) {
  return useMutation<unknown, unknown, GrowManualActivityInput>({
    mutationFn: (input) =>
      apiFetch("/grow/activities", {
        method: "POST",
        body: JSON.stringify({
          activityType: input.activityType,
          summary: input.summary,
          occurredAt: input.occurredAt,
          partyId: input.partyId,
          ...(input.propertyId ? { propertyId: input.propertyId } : {}),
          ...(input.opportunityId ? { opportunityId: input.opportunityId } : {}),
          ...(input.durationMinutes !== null ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.outcome ? { outcome: input.outcome } : {}),
        }),
      }),
    onSuccess: onSaved,
  });
}

export function localDatetimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function datetimeLocalToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function GrowNoteForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (summary: string) => void;
}) {
  const [noteText, setNoteText] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        const summary = noteText.trim();
        if (!summary) return;
        onSubmit(summary);
      }}
    >
      <label htmlFor={`${idPrefix}-note`}>Note</label>
      <textarea
        id={`${idPrefix}-note`}
        placeholder="Add a note about this contact"
        value={noteText}
        onChange={(e) => setNoteText(e.target.value)}
        required
        rows={2}
      />
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        Save note
      </button>
    </form>
  );
}

export function GrowManualActivityForm({
  idPrefix,
  submitting,
  onSubmit,
}: {
  idPrefix: string;
  submitting: boolean;
  onSubmit: (input: {
    activityType: "call" | "meeting";
    summary: string;
    occurredAt: string;
    durationMinutes: number | null;
    outcome: string | null;
  }) => void;
}) {
  const [activityType, setActivityType] = useState<"call" | "meeting">("call");
  const [occurredAt, setOccurredAt] = useState(() => localDatetimeValue(new Date()));
  const [durationMinutes, setDurationMinutes] = useState("");
  const [outcome, setOutcome] = useState("");
  const [summary, setSummary] = useState("");

  return (
    <form
      className="stack grow-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = summary.trim();
        const iso = datetimeLocalToIso(occurredAt);
        if (!trimmed || !iso) return;
        const durationText = durationMinutes.trim();
        const duration = durationText.length === 0 ? null : Number(durationText);
        if (duration !== null && (!Number.isInteger(duration) || duration < 1)) return;
        const trimmedOutcome = outcome.trim();
        onSubmit({
          activityType,
          summary: trimmed,
          occurredAt: iso,
          durationMinutes: duration,
          outcome: trimmedOutcome.length > 0 ? trimmedOutcome : null,
        });
      }}
    >
      <p className="muted">Records a call or meeting that already happened. It does not place a call.</p>
      <label htmlFor={`${idPrefix}-type`}>Type</label>
      <select
        id={`${idPrefix}-type`}
        value={activityType}
        onChange={(event) => setActivityType(event.target.value === "meeting" ? "meeting" : "call")}
      >
        <option value="call">Call</option>
        <option value="meeting">Meeting</option>
      </select>
      <label htmlFor={`${idPrefix}-occurred`}>When it happened</label>
      <input
        id={`${idPrefix}-occurred`}
        type="datetime-local"
        value={occurredAt}
        onChange={(event) => setOccurredAt(event.target.value)}
        required
      />
      <label htmlFor={`${idPrefix}-duration`}>Duration in minutes (optional)</label>
      <input
        id={`${idPrefix}-duration`}
        type="number"
        min={1}
        max={1440}
        step={1}
        value={durationMinutes}
        onChange={(event) => setDurationMinutes(event.target.value)}
      />
      <label htmlFor={`${idPrefix}-outcome`}>Outcome (optional)</label>
      <input
        id={`${idPrefix}-outcome`}
        type="text"
        maxLength={200}
        value={outcome}
        onChange={(event) => setOutcome(event.target.value)}
      />
      <label htmlFor={`${idPrefix}-summary`}>Summary</label>
      <textarea
        id={`${idPrefix}-summary`}
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        required
        rows={2}
        maxLength={2000}
      />
      <button className="btn btn-primary btn-small" type="submit" disabled={submitting}>
        Save call or meeting
      </button>
    </form>
  );
}

// G-UAT-6 — appraisal writes use the existing Grow appraisal routes.
// grow.access + grow.opportunities.manage, the same keys those routes require.
// A missing property is an explanation, never a button that would 409.
export function useCanReadAppraisals(): boolean {
  const { hasEntitlement } = useEntitlements();
  return hasEntitlement("grow.access");
}

export function useCanManageAppraisals(): boolean {
  const { hasEntitlement } = useEntitlements();
  return hasEntitlement("grow.access") && hasEntitlement("grow.opportunities.manage");
}

export function useAppraisalPipeline(enabled: boolean) {
  return useQuery<{ appraisals: GrowAppraisalSummary[] }>({
    queryKey: ["grow-appraisals"],
    queryFn: () => apiFetch("/grow/appraisals/pipeline"),
    enabled,
  });
}

export function invalidateAppraisalReads(
  queryClient: { invalidateQueries: (filter: { queryKey: unknown[] }) => void },
  partyId: number | null,
) {
  if (partyId !== null) queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
  queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
  queryClient.invalidateQueries({ queryKey: ["grow-today"] });
  queryClient.invalidateQueries({ queryKey: ["grow-appraisals"] });
}

export function appraisalWriteErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return "That couldn't be found.";
  if (error instanceof ApiError && error.status === 400) return apiErrorMessage(error, "Check the details and try again.");
  if (error instanceof ApiError && error.status === 403) {
    return apiErrorMessage(error, "You don't have permission to update this appraisal.");
  }
  if (error instanceof ApiError && error.status === 409) {
    return apiErrorMessage(error, "That step isn't available for this appraisal.");
  }
  return apiErrorMessage(error, "Couldn't update that appraisal. Try again.");
}

export function GrowAppraisalRecord({
  appraisal,
  partyId = null,
}: {
  appraisal: GrowAppraisalSummary | null;
  partyId?: number | null;
}) {
  if (!appraisal) return null;
  const readOnlyReason = appraisalReadOnlyReason(appraisal, partyId);

  return (
    <div className="grow-appraisal-record">
      <p>
        {appraisal.propertyAddress} — Status: {appraisalStatusLabel(appraisal.status)}
        {appraisal.outcome ? ` — Outcome: ${appraisal.outcome}` : " — Outcome: Not recorded"}
      </p>
      {readOnlyReason && <p className="muted">{readOnlyReason}</p>}
      <Link href={appraisalWorkspacePath(appraisal.id)} className="btn btn-link btn-small" id={`grow-appraisal-${appraisal.id}-open`}>
        Open appraisal
      </Link>
    </div>
  );
}

export function GrowOpportunityAppraisalActions({
  opportunityId,
  partyId,
  propertyId,
  appraisal,
  canWrite,
}: {
  opportunityId: number;
  partyId: number | null;
  propertyId: number | null;
  appraisal: GrowAppraisalSummary | null;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      apiFetch("/grow/appraisals/from-opportunity", {
        method: "POST",
        body: JSON.stringify({ opportunityId }),
      }),
    onSuccess: () => {
      setErrorMessage(null);
      invalidateAppraisalReads(queryClient, partyId);
    },
    onError: (error) => setErrorMessage(appraisalWriteErrorMessage(error)),
  });

  return (
    <div className="grow-opportunity-appraisal">
      {errorMessage && (
        <p className="error-text" role="alert">
          {errorMessage}
        </p>
      )}
      {canWrite && propertyId === null && <p className="muted">{LINK_PROPERTY_BEFORE_APPRAISAL}</p>}
      {canWrite && propertyId !== null && appraisal == null && (
        <button
          type="button"
          className="btn btn-secondary btn-small"
          id={`grow-opportunity-start-appraisal-${opportunityId}`}
          disabled={start.isPending}
          onClick={() => start.mutate()}
        >
          Start appraisal
        </button>
      )}
      <GrowAppraisalRecord appraisal={appraisal} partyId={partyId} />
    </div>
  );
}

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

// AE GROW Completion W2-B (E-3) — Contact 360's opportunities table. Extracted
// from GrowContactDetail above only so the row actions it now carries can be
// exercised on their own; the markup is otherwise the table that was inline
// here, plus an Actions column.
export function GrowContactOpportunitiesSection({
  partyId,
  contactName,
  linkedProperties,
  opportunities,
  onChanged,
}: {
  partyId: number;
  contactName?: string;
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
  opportunities: GrowContact360Opportunity[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canReadAppraisals = useCanReadAppraisals();
  const pipeline = useAppraisalPipeline(canReadAppraisals);
  const appraisalRows = canReadAppraisals ? (pipeline.data?.appraisals ?? []) : [];

  function onSaved() {
    // A follow-up or a note changes what Today and the activity list show.
    onChanged();
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  }

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      <GrowNewOpportunityForm
        fixedParty={{ id: partyId, displayName: contactName?.trim() || "This contact" }}
        linkedProperties={linkedProperties ?? []}
      />
      {opportunities.length === 0 && <p className="empty-state">No opportunities yet.</p>}
      {opportunities.length > 0 && (
        <GrowTableScroll>
        <table className="grow-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Next action</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => (
              <tr key={o.id}>
                <td>{o.opportunityType}</td>
                <td>{o.stage}</td>
                <td>
                  <span className={`pill ${o.status === "Open" ? "pill-success" : o.status === "Lost" ? "pill-danger" : ""}`}>
                    {opportunityStatusLabel(o.status, o.lostReason)}
                  </span>
                </td>
                <td>{o.reason ?? "–"}</td>
                <td>
                  {o.recommendedNextAction ?? "–"}
                  {o.nextActionDueAt ? ` (due ${formatWhen(o.nextActionDueAt)})` : ""}
                </td>
                <td>
                  {/* onViewContact is null here on purpose — see
                      GrowOpportunityRowActions: this table is already inside
                      the contact these opportunities belong to. */}
                  <GrowOpportunityRowActions
                    opportunityId={o.id}
                    partyId={partyId}
                    propertyId={o.propertyId}
                    stage={o.stage}
                    status={o.status}
                    appraisal={appraisalForProperty(appraisalRows, o.propertyId, partyId)}
                    canManageOpportunities={canManageOpportunities}
                    canAddNote={canAddNote}
                    canViewContacts={false}
                    onViewContact={null}
                    onAskAE={null}
                    onSaved={onSaved}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </GrowTableScroll>
      )}
    </section>
  );
}
