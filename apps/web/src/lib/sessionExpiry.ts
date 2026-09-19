// AE GROW Pilot Readiness WP5 — global session-expiry coordination.
//
// apiFetch (lib/api.ts) calls a single registered handler whenever an
// authenticated call comes back 401 (see isSessionExpiryResponse there for
// which endpoints are exempt). This module decides what that handler does,
// kept free of React / React Query so the decision logic is unit-testable;
// lib/session.ts wires it to the real QueryClient.
//
// Loop safety: the handler only acts when the app currently believes it is
// signed in, and only once per expiry (a burst of parallel 401s from every
// panel on screen collapses into one session re-check). The re-check itself
// hits /auth/me, which is exempt from triggering the handler, so a 401 there
// can never re-enter this path.

type Listener = () => void;

export interface SessionEndedNotice {
  get(): boolean;
  set(value: boolean): void;
  subscribe(listener: Listener): () => void;
}

// Tiny external store for "show the 'your session has ended' message on the
// sign-in screen" — read by Login via useSyncExternalStore.
export function createSessionEndedNotice(): SessionEndedNotice {
  let value = false;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set(next) {
      if (next === value) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface SessionExpiryDeps {
  // Whether the app currently holds a live (successfully fetched) session.
  isSignedIn(): boolean;
  // Stop other in-flight reads so they don't pile further 401s on screen.
  cancelOtherQueries(): void;
  // Re-check the session with the server (GET /auth/me). Resolves to the
  // outcome; "signed-out" is what returns the app to the sign-in screen.
  refreshSession(): Promise<"signed-in" | "signed-out">;
}

export function createSessionExpiryCoordinator(deps: SessionExpiryDeps, notice: SessionEndedNotice) {
  let inFlight = false;
  return {
    handle(): void {
      if (inFlight || !deps.isSignedIn()) return;
      inFlight = true;
      notice.set(true);
      deps.cancelOtherQueries();
      deps
        .refreshSession()
        .then((outcome) => {
          // A stray 401 from a route whose session was actually fine (the
          // re-check succeeded) must not leave a misleading notice behind.
          if (outcome === "signed-in") notice.set(false);
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    },
    isHandling: () => inFlight,
  };
}
