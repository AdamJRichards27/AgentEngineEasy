import {
  growDataRegionError,
  growDataRegionState,
  type GrowDataRegionQuery,
} from "../lib/growWorkspace";

// AE GROW Pilot Readiness WP6b (D6) — the loading / failed / empty presentation
// every Grow data region shares, so a region can never again render nothing at
// all when its query fails (see lib/growWorkspace.ts's own header comment).
//
// Deliberately only renders the *non-data* states and returns null otherwise:
// each caller keeps rendering its own table/list exactly as before, so this
// adds an error branch without restating any existing markup. The copy follows
// the pattern Today and Contact 360 already use (the query's humanised
// ApiError message, never a raw status), plus the support reference the
// ErrorBoundary fallback already shows for failures that carry a server
// correlation id.
export function GrowDataRegionStatus({
  query,
  itemCount,
  loadingMessage = "Loading…",
  errorFallback,
  emptyMessage,
  onRetry,
}: {
  query: GrowDataRegionQuery;
  // Rows the region would render; null/undefined until the response arrives.
  itemCount: number | null | undefined;
  loadingMessage?: string;
  // Shown when the failure isn't an ApiError (so it has no friendly message).
  errorFallback: string;
  emptyMessage: string;
  // Refetches the region's own query — never reloads the page.
  onRetry: () => void;
}) {
  const state = growDataRegionState(query, itemCount);

  if (state === "loading") {
    return <p className="muted">{loadingMessage}</p>;
  }

  if (state === "error") {
    const { message, reference } = growDataRegionError(query.error, errorFallback);
    return (
      <div role="alert">
        <p className="error-text">{message}</p>
        {reference !== undefined && (
          <p className="muted">
            If this keeps happening, contact support and quote <strong>{reference}</strong>.
          </p>
        )}
        <div className="grow-empty-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (state === "empty") {
    return <p className="empty-state">{emptyMessage}</p>;
  }

  return null;
}
