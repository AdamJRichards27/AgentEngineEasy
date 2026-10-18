// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useQueryClient } from "@tanstack/react-query";
import { formatWhen } from "../lib/growToday";
import { GrowRescheduleControl } from "./GrowRescheduleControl";
import { growErrorMessage } from "./messages";
import type { GrowContact360Commitment } from "./types";
import { useUpdateGrowCommitment } from "./useGrowMutations";

// Contact 360's commitment list. Exported so the Reschedule action can be
// exercised on its own; GrowContactDetail mounts this same component.
export function GrowContactCommitmentsList({
  commitments,
  canManageActivities,
  onChanged,
}: {
  commitments: GrowContact360Commitment[];
  canManageActivities: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const updateCommitment = useUpdateGrowCommitment((vars) => {
    onChanged();
    if ("dueAt" in vars) {
      queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    }
  });

  return (
    <>
      {commitments.length === 0 && <p className="empty-state">No commitments recorded.</p>}
      {commitments.length > 0 && (
        <ul className="item-list">
          {commitments.map((cm) => (
            <li key={cm.id}>
              <span className={`pill ${cm.status === "Open" ? "pill-warning" : cm.status === "Completed" ? "pill-success" : "pill-danger"}`}>
                {cm.status}
              </span>{" "}
              {cm.description} — due {formatWhen(cm.dueAt)}
              {cm.status === "Open" && canManageActivities && (
                <>
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={updateCommitment.isPending}
                    onClick={() => updateCommitment.mutate({ id: cm.id, status: "Completed" })}
                  >
                    Complete
                  </button>
                  <button
                    type="button"
                    className="btn btn-link btn-small"
                    disabled={updateCommitment.isPending}
                    onClick={() => updateCommitment.mutate({ id: cm.id, status: "Cancelled" })}
                  >
                    Cancel
                  </button>
                  <GrowRescheduleControl
                    idPrefix={`grow-contact-commitment-${cm.id}`}
                    busy={updateCommitment.isPending}
                    onSubmit={(dueAt) => updateCommitment.mutate({ id: cm.id, dueAt })}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {updateCommitment.isError && (
        <p className="error-text">{growErrorMessage(updateCommitment.error, "Something went wrong. Try again.")}</p>
      )}
    </>
  );
}
