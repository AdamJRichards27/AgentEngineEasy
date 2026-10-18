// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { DUE_FOLLOW_UP_FORM_HINT, SAVE_DUE_FOLLOW_UP_LABEL } from "../lib/growTerms";
import type { GrowNextActionInput } from "./types";

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
