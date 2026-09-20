import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { installSessionExpiryHandling } from "./lib/session";
import "./styles.css";

// retry: false — an unauthenticated 401 (very common: it's how we detect
// "not signed in") shouldn't sit through react-query's default 3-attempt
// backoff before the UI can react to it, and every other error in this app
// is already given a clear, actionable message (lib/api.ts) rather than
// something a silent retry would resolve.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// AE GROW Pilot Readiness WP5 — a 401 from any authenticated call returns the
// whole app to sign-in with a "your session has ended" message (lib/session.ts).
installSessionExpiryHandling(queryClient);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary variant="page" label="Agent Engine">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
