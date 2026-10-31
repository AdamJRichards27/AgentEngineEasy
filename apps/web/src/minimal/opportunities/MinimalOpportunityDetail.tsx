import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "wouter";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { useEntitlements } from "../../lib/session";
import { parseDetailId } from "../properties/minimalPropertyDetailModel";
import { type LifecycleCommand, lifecycleAnnouncement, lifecycleBody } from "./minimalOpportunitiesModel";
import {
  buildOpportunityDetail,
  opportunityDetailQueryPath,
  pickOpportunity,
  type MinimalOpportunityDetailRow,
} from "./minimalOpportunityDetailModel";
import { MinimalOpportunityDetailView } from "./MinimalOpportunityDetailView";
import "./opportunities.css";

// AE Minimal A opportunity detail. Rendered only inside the Minimal shell
// (selectOpportunityDetailView; AE_MINIMAL_UX_ENABLED default OFF).

export default function MinimalOpportunityDetail() {
  const params = useParams<{ id: string }>();
  const id = parseDetailId(params.id);
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManage = hasEntitlement("grow.opportunities.manage");
  const [lostReason, setLostReason] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const detail = useQuery<{ opportunities: MinimalOpportunityDetailRow[] }>({
    queryKey: ["minimal-opportunity", id],
    queryFn: () => apiFetch(opportunityDetailQueryPath(id!)),
    enabled: id !== null,
  });
  const row = id === null ? null : pickOpportunity(detail.data?.opportunities, id);

  const lifecycle = useMutation({
    mutationFn: (command: LifecycleCommand) => {
      const result = lifecycleBody(command);
      if (!result.ok) return Promise.reject(new Error(result.error));
      return apiFetch(`/grow/opportunities/${id}/lifecycle`, { method: "PATCH", body: JSON.stringify(result.body) });
    },
    onMutate: () => {
      setActionError(null);
      setAnnouncement(null);
    },
    onSuccess: (_d, command) => {
      setLostReason(null);
      setAnnouncement(lifecycleAnnouncement(row?.contactName, command));
      for (const key of [["minimal-opportunity", id], ["minimal-opportunities"], ["minimal-property-opportunities"], ["minimal-property-detail-opportunities"], ["grow-today"]]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onError: (error) =>
      setActionError(error instanceof Error && !("friendly" in error) ? error.message : apiErrorMessage(error, "Couldn't update the opportunity. Try again.")),
  });

  const state =
    id === null
      ? ({ kind: "error", text: "That opportunity couldn't be found." } as const)
      : detail.isLoading
        ? ({ kind: "loading" } as const)
        : detail.isError
          ? ({ kind: "error", text: apiErrorMessage(detail.error, "Couldn't load this opportunity."), onRetry: () => void detail.refetch() } as const)
          : row
            ? ({ kind: "ready", model: buildOpportunityDetail(row) } as const)
            : ({ kind: "error", text: "That opportunity couldn't be found — it may have been removed." } as const);

  return (
    <MinimalOpportunityDetailView
      state={state}
      canManage={canManage}
      pending={lifecycle.isPending}
      actionError={actionError}
      announcement={announcement}
      lostReason={lostReason}
      onStage={(stage) => lifecycle.mutate({ kind: "stage", stage })}
      onStartLost={() => setLostReason("")}
      onLostReason={setLostReason}
      onConfirmLost={() => lostReason !== null && lifecycle.mutate({ kind: "lost", lostReason })}
      onCancelLost={() => setLostReason(null)}
      onClose={() => lifecycle.mutate({ kind: "close" })}
    />
  );
}
