import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import { useEntitlements } from "../../lib/session";
import {
  MINIMAL_OPPORTUNITIES_PAGE_LIMIT,
  type LifecycleCommand,
  type MinimalOpportunityRow,
  buildPipelineBoard,
  lifecycleBody,
} from "./minimalOpportunitiesModel";
import { MinimalOpportunitiesView, type LostDraft } from "./MinimalOpportunitiesView";
import "./opportunities.css";

// AE Minimal A Opportunities page (pipeline). Rendered only inside the Minimal
// shell (selectOpportunitiesView; AE_MINIMAL_UX_ENABLED default OFF).
//   GET   /grow/opportunities?limit=100           ["minimal-opportunities"]
//   PATCH /grow/opportunities/:id/lifecycle       (#187; the server re-checks every rule)

export default function MinimalOpportunities() {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManage = hasEntitlement("grow.opportunities.manage");
  const [showClosed, setShowClosed] = useState(false);
  const [lostDraft, setLostDraft] = useState<LostDraft | null>(null);
  const [actionError, setActionError] = useState<{ id: number; text: string } | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);

  const list = useQuery<{ opportunities: MinimalOpportunityRow[]; total: number }>({
    queryKey: ["minimal-opportunities"],
    queryFn: () => apiFetch(`/grow/opportunities?limit=${MINIMAL_OPPORTUNITIES_PAGE_LIMIT}`),
  });

  const lifecycle = useMutation({
    mutationFn: (vars: { id: number; command: LifecycleCommand }) => {
      const result = lifecycleBody(vars.command);
      if (!result.ok) return Promise.reject(new Error(result.error));
      return apiFetch(`/grow/opportunities/${vars.id}/lifecycle`, { method: "PATCH", body: JSON.stringify(result.body) });
    },
    onMutate: (vars) => {
      setPendingId(vars.id);
      setActionError(null);
    },
    onSuccess: () => {
      setLostDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["minimal-opportunities"] });
      void queryClient.invalidateQueries({ queryKey: ["minimal-property-opportunities"] });
      void queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    },
    onError: (error, vars) => setActionError({ id: vars.id, text: apiErrorMessage(error, "Couldn't update the opportunity. Try again.") }),
    onSettled: () => setPendingId(null),
  });

  const rows = list.data?.opportunities ?? [];
  return (
    <MinimalOpportunitiesView
      board={buildPipelineBoard(rows)}
      rowsById={new Map(rows.map((r) => [r.id, r]))}
      total={list.data?.total ?? rows.length}
      loading={list.isLoading}
      error={list.isError ? apiErrorMessage(list.error, "Couldn't load opportunities. Try again.") : null}
      actionError={actionError}
      canManage={canManage}
      showClosed={showClosed}
      lostDraft={lostDraft}
      pendingId={pendingId}
      onToggleClosed={() => setShowClosed((v) => !v)}
      onStage={(id, stage) => lifecycle.mutate({ id, command: { kind: "stage", stage } })}
      onStartLost={(id) => setLostDraft({ id, reason: "" })}
      onLostReason={(text) => setLostDraft((cur) => (cur ? { ...cur, reason: text } : cur))}
      onConfirmLost={() => lostDraft && lifecycle.mutate({ id: lostDraft.id, command: { kind: "lost", lostReason: lostDraft.reason } })}
      onCancelLost={() => setLostDraft(null)}
      onClose={(id) => lifecycle.mutate({ id, command: { kind: "close" } })}
      onRetry={() => void list.refetch()}
    />
  );
}
