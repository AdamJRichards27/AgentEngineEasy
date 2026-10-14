// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useEntitlements } from "../lib/session";
import type { GrowAppraisalSummary } from "../lib/growAppraisals";
import type { GrowNextActionInput, GrowOpportunityLifecycleInput, GrowCommitmentPatch } from "./types";
import { GROW_LIST_SEARCH_DEBOUNCE_MS } from "./types";

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
export function useUpdateGrowCommitment(onSaved: (vars: GrowCommitmentPatch) => void) {
  return useMutation<unknown, unknown, GrowCommitmentPatch>({
    mutationFn: (vars) =>
      apiFetch(`/grow/contacts/commitments/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify("dueAt" in vars ? { dueAt: vars.dueAt } : { status: vars.status }),
      }),
    onSuccess: (_result, vars) => {
      onSaved(vars);
    },
  });
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
export function useDebouncedListSearch() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), GROW_LIST_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return {
    text,
    query,
    setText,
    commit() {
      setQuery(text.trim());
    },
  };
}
