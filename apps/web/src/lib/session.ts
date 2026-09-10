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

// AE GROW Priority 0.5 — Workstream 1: GET /auth/me now also returns `entitlements` as a
// sibling field alongside `user` (see apps/api/src/routes/auth.ts) — this is the full shape of
// that response. Never merged into SessionUser: the entitlement set is a resolver decision
// (apps/api/src/lib/entitlements/resolver.ts), not a property of the user record itself.
interface SessionResponse {
  user: SessionUser;
  entitlements: string[];
}

// Whole-app auth check — Login/App.tsx use this to decide whether to show
// the app or redirect to sign-in. A 401 here is expected (no session yet),
// not a real failure, so no retry loop and no console noise.
//
// AE GROW Priority 0.5 — Workstream 1: still fetches the FULL /auth/me response ({user,
// entitlements}) so this hook and useEntitlements() below share one network call — both use the
// identical queryKey ["session"], so react-query dedupes them to a single request automatically.
// `select` projects out just `.user` here, so this hook's external contract
// ({user, isLoading, isSignedIn}) is unchanged byte-for-byte for every existing caller.
export function useSession() {
  const query = useQuery<SessionResponse, ApiError, SessionUser>({
    queryKey: ["session"],
    queryFn: () => apiFetch<SessionResponse>("/auth/me"),
    select: (data) => data.user,
    retry: false,
  });
  return { user: query.data, isLoading: query.isLoading, isSignedIn: !!query.data && !query.isError };
}

// AE GROW Priority 0.5 — Workstream 1: frontend entitlement awareness. Product-surface
// visibility (Grow-first navigation ordering, entitlement-aware landing) must be driven by what
// the brokerage has actually PURCHASED, not by role — see lib/productNav.ts, the only place this
// hook's output should be consumed for navigation decisions. Backend enforcement
// (apps/api/src/middlewares/entitlement.ts) remains authoritative regardless of what this
// returns; this is a UX/navigation signal only — the same "UX nicety, not the security boundary"
// posture App.tsx already documents for its existing canSeePitCrew/canSeeFinancial checks.
export function useEntitlements() {
  const query = useQuery<SessionResponse, ApiError, string[]>({
    queryKey: ["session"],
    queryFn: () => apiFetch<SessionResponse>("/auth/me"),
    select: (data) => data.entitlements,
    retry: false,
  });
  const entitlements = query.data ?? [];
  return {
    entitlements,
    isLoading: query.isLoading,
    hasEntitlement: (key: string) => entitlements.includes(key),
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  return async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    queryClient.setQueryData(["session"], undefined);
    queryClient.clear();
  };
}
