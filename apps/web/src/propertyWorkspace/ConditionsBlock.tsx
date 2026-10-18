// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import type { ConditionBlock } from "./types";

const CONDITION_RESOLUTIONS = ["Satisfied", "Waived", "Failed", "NotApplicable"] as const;
// Stage E (#118) — a condition list with reschedule/resolve actions, plus a
// small add-condition form. Mirrors the offer-conditions free-text field's
// discipline: no invented finance/building-inspection integration, purely
// agent-recorded tracking.
export function ConditionsBlock({
  conditions,
  editable,
  onAdd,
  addError,
  onReschedule,
  onResolve,
}: {
  conditions: ConditionBlock[];
  editable: boolean;
  onAdd: (input: Record<string, unknown>) => void;
  addError: string | null;
  onReschedule: (conditionId: number, newDueDate: string | null) => void;
  onResolve: (conditionId: number, status: string, notes?: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [rescheduleDrafts, setRescheduleDrafts] = useState<Record<number, string>>({});
  const [resolveNotes, setResolveNotes] = useState<Record<number, string>>({});

  const submitAdd = () => {
    if (!description.trim()) return;
    onAdd({ description: description.trim(), dueDate: dueDate || undefined });
    setShowAdd(false);
    setDescription("");
    setDueDate("");
  };

  return (
    <div id="transaction-conditions">
      <h3 style={{ marginBottom: "0.4rem" }}>Contract conditions</h3>
      {conditions.length === 0 ? (
        <p className="muted">No conditions tracked.</p>
      ) : (
        <ul className="item-list">
          {conditions.map((c) => (
            <li key={c.id}>
              <div>
                {c.description}{" "}
                <span className={c.status === "Satisfied" || c.status === "Waived" || c.status === "NotApplicable" ? "pill pill-success" : c.status === "Failed" ? "pill pill-danger" : "pill"}>
                  {c.status}
                </span>
                {c.dueDate && ` · due ${new Date(c.dueDate).toLocaleDateString()}`}
              </div>
              {editable && c.status === "Pending" && (
                <div className="inline-form" style={{ marginTop: "0.3rem" }}>
                  <input
                    type="date"
                    value={rescheduleDrafts[c.id] ?? ""}
                    onChange={(e) => setRescheduleDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  />
                  <button
                    className="btn btn-small"
                    onClick={() => onReschedule(c.id, rescheduleDrafts[c.id] || null)}
                    disabled={!rescheduleDrafts[c.id]}
                  >
                    Reschedule
                  </button>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      const status = e.target.value;
                      if (!status) return;
                      onResolve(c.id, status, resolveNotes[c.id] || undefined);
                      e.target.value = "";
                    }}
                  >
                    <option value="" disabled>
                      Resolve as…
                    </option>
                    {CONDITION_RESOLUTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <input
                    value={resolveNotes[c.id] ?? ""}
                    onChange={(e) => setResolveNotes((prev) => ({ ...prev, [c.id]: e.target.value }))}
                    placeholder="Note (optional)"
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && !showAdd ? (
        <button className="btn btn-link" onClick={() => setShowAdd(true)}>
          + Add Condition
        </button>
      ) : editable ? (
        <div className="inline-form">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Subject to building & pest inspection" />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          <button className="btn btn-small" onClick={submitAdd} disabled={!description.trim()}>
            Save
          </button>
          <button className="btn btn-link" onClick={() => setShowAdd(false)}>
            Cancel
          </button>
        </div>
      ) : null}
      {addError && <p className="error-text">{addError}</p>}
    </div>
  );
}
