// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { growErrorMessage } from "./messages";

interface GrowNoteInput {
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
interface GrowManualActivityInput {
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
function localDatetimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function datetimeLocalToIso(value: string): string | null {
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
// Contact 360's recent-activity log. Opportunity rows use the same form.
export function GrowContactActivityLog({ partyId, canLog }: { partyId: number; canLog: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const logActivity = useLogManualActivity(() => {
    setOpen(false);
    queryClient.invalidateQueries({ queryKey: ["grow-contact", partyId] });
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  });
  if (!canLog) return null;
  return (
    <div className="grow-manual-activity">
      <button type="button" className="btn btn-secondary btn-small" disabled={logActivity.isPending} onClick={() => setOpen((value) => !value)}>
        {open ? "Cancel" : "Log call or meeting"}
      </button>
      {logActivity.isError && <p className="error-text">{growErrorMessage(logActivity.error, "Something went wrong. Try again.")}</p>}
      {open && (
        <GrowManualActivityForm
          idPrefix={`grow-contact-activity-${partyId}`}
          submitting={logActivity.isPending}
          onSubmit={(input) =>
            logActivity.mutate({
              ...input,
              partyId,
              propertyId: null,
              opportunityId: null,
            })
          }
        />
      )}
    </div>
  );
}
