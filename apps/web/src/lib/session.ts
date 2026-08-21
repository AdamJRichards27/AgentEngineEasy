import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./api";

export interface SessionUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  brokerageId: number | null;
  brokerageName: string | null;
}

// Whole-app auth check — Login/App.tsx use this to decide whether to show
// the app or redirect to sign-in. A 401 here is expected (no session yet),
// not a real failure, so no retry loop and no console noise.
export function useSession() {
  const query = useQuery<SessionUser, ApiError>({
    queryKey: ["session"],
    queryFn: () => apiFetch<{ user: SessionUser }>("/auth/me").then((r) => r.user),
    retry: false,
  });
  return { user: query.data, isLoading: query.isLoading, isSignedIn: !!query.data && !query.isError };
}

export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    queryClient.setQueryData(["session"], undefined);
    queryClient.clear();
  };
}
