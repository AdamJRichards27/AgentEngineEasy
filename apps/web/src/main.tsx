import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installSessionExpiryHandling, reloadPageRestoredFromCache } from "./lib/session";
import "./fonts/inter/inter.css";
import "./styles.css";

// retry: false — an unauthenticated 401 (very common: it's how we detect
// "not signed in") shouldn't sit through react-query's default 3-attempt
// backoff before the UI can react to it, and every other error in this app
// is already given a clear, actionable message (lib/api.ts) rather than
// something a silent retry would resolve.
//
// staleTime / refetchOnWindowFocus — react-query's defaults are staleTime: 0 and
// refetchOnWindowFocus: true, which means every alt-tab back to the browser, and
// every remount, re-runs every mounted query in full. Grow's tabs unmount on
// switch (pages/Grow.tsx), so switching tab and switching back re-ran the whole
// Contact 360 read set — the timeline aggregation, the intelligence summary and
// the contacts list enrichment — for data that had not changed. Freshness in this
// app is mutation-driven, not focus-driven: every write path invalidates its own
// keys (57 invalidateQueries/refetch call sites across apps/web/src), and
// queryClient.invalidateQueries refetches active queries unconditionally —
// it marks the query isInvalidated, which short-circuits the staleTime check
// (@tanstack/query-core query.js isStaleByTime) — so raising staleTime cannot
// make a post-mutation read go stale.
//
// The two live-polling surfaces are likewise unaffected: components/
// GrowContactTranscriptPanel.tsx and the in-call session query in pages/Grow.tsx
// both drive themselves with an explicit refetchInterval that returns false on a
// terminal state. refetchInterval is scheduled independently of staleTime and of
// refetchOnWindowFocus (query-core queryObserver.js #updateRefetchInterval keeps
// its timer running while blurred and only gates the fetch on focusManager), so
// those two keep polling on exactly the same 3s cadence as before. The only
// change there is that refocusing no longer fires one extra immediate refetch on
// top of the poll — the next scheduled tick is at most 3s away regardless.
//
// The accepted trade-off is a bounded staleness window: a query remounted within
// 30s of its last fetch, with no intervening mutation, serves from cache.
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } },
});

// AE GROW Pilot Readiness WP5 — a 401 from any authenticated call returns the
// whole app to sign-in with a "your session has ended" message (lib/session.ts).
installSessionExpiryHandling(queryClient);

// UAT D1 — Back after a full navigation can restore the signed-in document
// from the back-forward cache. Reload so the session probe runs again.
window.addEventListener("pageshow", (event) => {
  reloadPageRestoredFromCache(event, () => window.location.reload());
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary variant="page" label="Agent Engine">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
