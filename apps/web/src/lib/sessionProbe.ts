// AE GROW Pilot Readiness WP8 — D-web-2: a hard reload while the API is
// unreachable must not look like "you're signed out".
//
// App.tsx gates the whole app on useSession(). Before this module, its only
// two outcomes were "loading" and "signed in or not", so ANY failure of the
// initial GET /auth/me probe — including one where no response ever arrived —
// fell through to `<Redirect to="/login" />` and the agent was shown a
// sign-in form they could not possibly use. (In-app navigation after sign-in
// already behaves correctly: apiFetch's 401 path and the WP5 session-expiry
// coordinator only ever fire on a real 401 from a reachable server.)
//
// Pure and React-free so the classification itself is unit-testable, matching
// lib/sessionExpiry.ts's split between decision logic here and wiring in
// lib/session.ts.

export type SessionProbeState = "loading" | "signed-in" | "signed-out" | "api-unreachable";

// A proxy/load balancer answering on a down API's behalf. Named explicitly
// because these are unambiguous even if such a hop does return a JSON body.
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

// "The API never answered", as opposed to "you have no session":
//   status 0  — apiFetch's own no-response ApiError: offline, DNS, refused
//               connection, reset, CORS. See lib/api.ts.
//   502/503/504 — a gateway reporting the API is down.
//   any other 5xx with no server message — also a hop in front of the API.
//               Every real API failure answers `{ "error": "…" }` (apps/api/
//               src/middlewares/errorHandler.ts), so an empty-bodied 5xx was
//               not authored by the API. This is not hypothetical: Vite's own
//               dev proxy answers 500 with an empty body when its target
//               refuses the connection, which is exactly the hard-reload case
//               this classification exists for.
// Everything else — 401 above all — came from the API and is classified
// normally, so the genuine signed-out path is untouched.
export function isApiUnreachableError(
  error: { status?: number; serverMessage?: string } | null | undefined,
): boolean {
  const status = error?.status;
  if (typeof status !== "number") return false;
  if (status === 0) return true;
  if (GATEWAY_STATUSES.has(status)) return true;
  // A 5xx the API itself authored (it told us what went wrong) is a broken
  // API, not an unreachable one — that keeps its existing treatment.
  return status >= 500 && !error?.serverMessage;
}

// Order matters: an already-resolved session wins (a background refetch that
// fails must not blank a working app), then the first-load spinner, and only
// then is a failure classified. Anything that isn't a transport failure is
// signed-out exactly as before — including a 401, which is the normal "no
// session yet" answer from a perfectly healthy API.
export function classifySessionProbe(input: {
  isLoading: boolean;
  hasUser: boolean;
  error?: { status?: number; serverMessage?: string } | null;
}): SessionProbeState {
  if (input.hasUser && !input.error) return "signed-in";
  if (input.isLoading) return "loading";
  if (isApiUnreachableError(input.error)) return "api-unreachable";
  return "signed-out";
}
