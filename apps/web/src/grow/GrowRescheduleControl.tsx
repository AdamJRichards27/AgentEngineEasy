// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";

// Date/time picker for an Open commitment. Shown only by a caller that has
// already checked grow.activities.manage. 400, 404 and 403 surface through
// the shared mutation's growErrorMessage, which is the plain sentence
// apiFetch already stored on the error.
export function GrowRescheduleControl({
  idPrefix,
  busy,
  onSubmit,
}: {
  idPrefix: string;
  busy: boolean;
  onSubmit: (dueAt: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dueLocal, setDueLocal] = useState("");

  return (
    <>
      <button
        type="button"
        className="btn btn-link btn-small"
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Close" : "Reschedule"}
      </button>
      {open && (
        <form
          className="stack grow-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dueLocal) return;
            const dueAt = new Date(dueLocal);
            if (Number.isNaN(dueAt.getTime())) return;
            onSubmit(dueAt.toISOString());
          }}
        >
          <label htmlFor={`${idPrefix}-due`}>New due time</label>
          <input
            id={`${idPrefix}-due`}
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            required
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={busy || !dueLocal}>
            Save new time
          </button>
        </form>
      )}
    </>
  );
}
