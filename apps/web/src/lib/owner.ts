import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";

export interface OwnerStatus {
  isOwner: boolean;
  homeBrokerageId?: number;
  selectedBrokerageId?: number | null;
}
export interface OwnerBrokerage {
  id: number;
  name: string;
}

export function useOwnerStatus(enabled: boolean) {
  return useQuery({
    queryKey: ["owner-status"],
    queryFn: () => apiFetch<OwnerStatus>("/owner/status"),
    enabled,
    retry: false,
  });
}

export function useOwnerBrokerages(enabled: boolean) {
  return useQuery({
    queryKey: ["owner-brokerages"],
    queryFn: () => apiFetch<{ brokerages: OwnerBrokerage[] }>("/owner/brokerages"),
    enabled,
    retry: false,
  });
}

export function useCreateOwnerBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => apiFetch<{ brokerage: OwnerBrokerage }>("/owner/brokerages", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["owner-brokerages"] }),
  });
}

export function useRenameOwnerBrokerage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: OwnerBrokerage) => apiFetch(`/owner/brokerages/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["owner-brokerages"] }),
  });
}

export function useOwnerContext() {
  return useMutation({
    mutationFn: (brokerageId: number | null) => apiFetch("/owner/context", {
      method: "POST",
      body: JSON.stringify({ brokerageId }),
    }),
    retry: false,
    // A full navigation discards every tenant query, local edit and mutation.
    onSuccess: (_data, brokerageId) => {
      window.location.assign(brokerageId === null ? "/owner" : "/settings/users");
    },
  });
}
