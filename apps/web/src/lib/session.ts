import { useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch, ApiError, setSessionExpiredHandler } from "./api";
import { createSessionEndedNotice, createSessionExpiryCoordinator } from "./sessionExpiry";
import { classifySessionProbe, type SessionProbeState } from "./sessionProbe";

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
//
// AE GROW Pilot Readiness WP8 — `probe` and `retryProbe` are additive, for the
// one caller (App.tsx) that gates the whole app on this query. `isLoading` and
// `isSignedIn` are computed exactly as before, so every other caller is
// unaffected; `probe` additionally separates "the API never answered" from
// "you have no session" so a hard reload against a down API shows a
// connectivity state with a retry instead of a sign-in form nobody can use.
// See lib/sessionProbe.ts for the classification rules.
export function useSession() {
  const query = useQuery<SessionResponse, ApiError, SessionUser>({
    queryKey: ["session"],
    queryFn: () => apiFetch<SessionResponse>("/auth/me"),
    select: (data) => data.user,
    retry: false,
  });
  const probe: SessionProbeState = classifySessionProbe({
    isLoading: query.isLoading,
    hasUser: !!query.data,
    error: query.isError ? query.error : null,
  });
  return {
    user: query.data,
    isLoading: query.isLoading,
    isSignedIn: !!query.data && !query.isError,
    probe,
    // Re-runs GET /auth/me. Safe to call from the connectivity screen: it
    // refetches this one query rather than navigating, so there is no
    // redirect to loop on — a still-unreachable API simply leaves the same
    // screen in place, and a 401 resolves to the normal signed-out redirect.
    retryProbe: () => {
      void query.refetch();
    },
  };
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
    sessionEndedNotice.set(false);
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    queryClient.setQueryData(["session"], undefined);
    queryClient.clear();
  };
}

// AE GROW Pilot Readiness WP5 — session expiry. One app-wide notice, set when
// an authenticated call 401s mid-session and shown on the sign-in screen
// ("Your session has ended — please sign in again."); cleared on sign-in,
// sign-out, or when the re-check shows the session is actually still valid.
export const sessionEndedNotice = createSessionEndedNotice();

export function useSessionEndedNotice(): boolean {
  return useSyncExternalStore(sessionEndedNotice.subscribe, sessionEndedNotice.get, sessionEndedNotice.get);
}

const isSessionQuery = (query: { queryKey: readonly unknown[] }) => query.queryKey[0] === "session";

// Called once from main.tsx. Wires apiFetch's global 401 path to the
// ["session"] query: re-fetching /auth/me turns the session query into its
// error state, which App.tsx already treats as signed-out and redirects to
// /login — no separate navigation (and so no redirect loop) is needed here.
export function installSessionExpiryHandling(queryClient: QueryClient): () => void {
  const coordinator = createSessionExpiryCoordinator(
    {
      isSignedIn: () => {
        const state = queryClient.getQueryState(["session"]);
        return !!state?.data && state.status === "success";
      },
      cancelOtherQueries: () => {
        void queryClient.cancelQueries({ predicate: (query) => !isSessionQuery(query) });
      },
      refreshSession: async () => {
        await queryClient.invalidateQueries({ queryKey: ["session"], exact: true });
        return queryClient.getQueryState(["session"])?.status === "success" ? "signed-in" : "signed-out";
      },
    },
    sessionEndedNotice,
  );
  setSessionExpiredHandler(coordinator.handle);
  return () => setSessionExpiredHandler(null);
}

// Shared post-sign-in step for Login / AcceptInvitation. Drops any cached
// data from a previous (possibly different) user's session, clears the
// session-ended notice, then re-fetches the full /auth/me response so both
// useSession() and useEntitlements() see {user, entitlements}. (Writing the
// login response's bare `user` into ["session"] directly, as before, left the
// cache in the wrong shape for useSession's `select`, so the app still
// looked signed-out until the next refetch.)
export function useCompleteSignIn() {
  const queryClient = useQueryClient();
  return async () => {
    sessionEndedNotice.set(false);
    queryClient.removeQueries({ predicate: (query) => !isSessionQuery(query) });
    await queryClient.invalidateQueries({ queryKey: ["session"], exact: true });
  };
}
