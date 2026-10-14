// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import {
  type RiskExceptionRow,
  severityLabel,
  severityPillClass,
  statusLabel,
  categoryLabel,
  formatDueDate,
  isOverdue,
} from "../lib/riskExceptions";

// #145 — Exception & Risk Engine property panel (§16-18). One row per
// exception, collapsed detail behind "View Details" (same convention as
// the AML exception block above), with only the lifecycle actions valid
// for that exception's *current* status ever rendered — this UI narrows
// which button appears, but never which transition the server accepts;
// model.ts re-checks the status itself either way (Build Instructions
// §19/§21).
export function ExceptionsBlock({
  exceptions,
  onAcknowledge,
  onStartRemediation,
  onMarkAwaitingExternal,
  onResolve,
  onDismiss,
  onReassign,
}: {
  exceptions: RiskExceptionRow[];
  onAcknowledge: (id: string) => void;
  onStartRemediation: (id: string) => void;
  onMarkAwaitingExternal: (id: string, note: string) => void;
  onResolve: (id: string, note: string) => void;
  onDismiss: (id: string, reason: string) => void;
  onReassign: (id: string, ownerType: string, reason: string) => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reassignOwnerType, setReassignOwnerType] = useState<Record<string, string>>({});
  const [reassignReason, setReassignReason] = useState<Record<string, string>>({});

  return (
    <ul className="item-list">
      {exceptions.map((e) => {
        const closed = e.status === "RESOLVED" || e.status === "DISMISSED";
        const canStartRemediation = e.status === "ACKNOWLEDGED" || e.status === "REOPENED";
        const canResolveOrDismiss = e.status === "IN_PROGRESS" || e.status === "AWAITING_EXTERNAL";
        return (
          <li key={e.id}>
            <div>
              <span className={severityPillClass(e.severity)}>{severityLabel(e.severity)}</span>{" "}
              <span className="pill">{statusLabel(e.status)}</span>{" "}
              <strong>{e.title}</strong>
              {e.dueAt && (
                <span className={isOverdue(e.dueAt) && !closed ? "pill pill-danger" : "muted"} style={{ marginLeft: "0.5rem" }}>
                  {isOverdue(e.dueAt) && !closed ? "Overdue " : "Due "}
                  {formatDueDate(e.dueAt)}
                </span>
              )}
            </div>
            <p className="muted" style={{ marginBottom: "0.4rem" }}>
              {categoryLabel(e.category)} · {e.problemDescription}
            </p>

            {e.status === "OPEN" && (
              <button className="btn btn-small" onClick={() => onAcknowledge(e.id)}>
                Acknowledge
              </button>
            )}
            {canStartRemediation && (
              <button className="btn btn-small" onClick={() => onStartRemediation(e.id)}>
                Start Remediation
              </button>
            )}

            <details style={{ marginTop: "0.5rem" }}>
              <summary className="muted">View Details</summary>
              <p className="muted">Business impact: {e.businessImpact}</p>
              <p className="muted">Recommended action: {e.recommendedAction}</p>
              {e.resolutionRequirements && <p className="muted">To resolve: {e.resolutionRequirements}</p>}
              {e.occurrenceCount > 1 && <p className="muted">Detected {e.occurrenceCount} times, most recently {formatDueDate(e.lastDetectedAt)}.</p>}

              {closed ? (
                <p className="muted">
                  {e.status === "RESOLVED"
                    ? `Resolved${e.resolutionMethod ? ` (${e.resolutionMethod === "AUTO" ? "automatically" : "manually"})` : ""}${e.resolvedAt ? ` on ${formatDueDate(e.resolvedAt)}` : ""}.`
                    : `Dismissed${e.dismissalReason ? `: ${e.dismissalReason}` : "."}`}
                </p>
              ) : (
                <>
                  {canResolveOrDismiss && (
                    <div className="stack">
                      <input
                        value={notes[e.id] ?? ""}
                        onChange={(ev) => setNotes((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                        placeholder="Resolution note (required)"
                      />
                      <button
                        className="btn btn-small"
                        onClick={() => onResolve(e.id, (notes[e.id] ?? "").trim())}
                        disabled={!(notes[e.id] ?? "").trim()}
                      >
                        Mark Resolved
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={() => onMarkAwaitingExternal(e.id, (notes[e.id] ?? "").trim())}
                        disabled={!(notes[e.id] ?? "").trim()}
                      >
                        Awaiting External Action
                      </button>
                      {e.dismissible && (
                        <>
                          <input
                            value={reasons[e.id] ?? ""}
                            onChange={(ev) => setReasons((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                            placeholder="Dismissal reason (required)"
                          />
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => onDismiss(e.id, (reasons[e.id] ?? "").trim())}
                            disabled={!(reasons[e.id] ?? "").trim()}
                          >
                            Dismiss
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <div className="inline-form" style={{ marginTop: "0.5rem" }}>
                    <select
                      value={reassignOwnerType[e.id] ?? ""}
                      onChange={(ev) => setReassignOwnerType((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                    >
                      <option value="">Reassign to…</option>
                      <option value="LISTING_AGENT">Listing Agent</option>
                      <option value="TRANSACTION_OWNER">Transaction Owner</option>
                      <option value="BROKERAGE_ADMINISTRATOR">Brokerage Administrator</option>
                      <option value="PIT_CREW">Pit Crew</option>
                      <option value="UNASSIGNED_QUEUE">Unassigned Queue</option>
                    </select>
                    <input
                      value={reassignReason[e.id] ?? ""}
                      onChange={(ev) => setReassignReason((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                      placeholder="Reason for reassignment"
                    />
                    <button
                      className="btn btn-small"
                      onClick={() => {
                        onReassign(e.id, reassignOwnerType[e.id]!, (reassignReason[e.id] ?? "").trim());
                        setReassignOwnerType((prev) => ({ ...prev, [e.id]: "" }));
                        setReassignReason((prev) => ({ ...prev, [e.id]: "" }));
                      }}
                      disabled={!reassignOwnerType[e.id] || !(reassignReason[e.id] ?? "").trim()}
                    >
                      Reassign
                    </button>
                  </div>
                </>
              )}
            </details>
          </li>
        );
      })}
    </ul>
  );
}
