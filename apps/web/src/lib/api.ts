// Thrown by apiFetch on any non-2xx response. Carries the HTTP status so
// callers can special-case auth (401) without string-matching a message,
// and a `.friendly` message that's safe to show an agent directly — see
// humanizeApiError() below for how it's derived.
//
// AE GROW Priority 6 Stage D — `reason` is additive: some routes (the
// existing AI-action governance router, `/ai/actions/requests/:id/...`)
// already return a machine-readable `reason` string in their JSON error
// body (e.g. "EXPIRED", "WRONG_STATUS") alongside the human-readable
// `error` string humanizeApiError() already turns into `.friendly` below.
// Every existing call site in this app ignores `.reason` completely (it
// simply doesn't exist on ApiError before this change), so this is a
// strictly additive capability, not a behavioural change to any existing
// error handling — it exists so a caller that needs to distinguish, say,
// an expired proposal from an already-actioned one (both currently
// surfaced as the same 409 status) can do so without this file inventing
// a parallel, route-specific error-parsing path of its own.
//
// AE GROW Priority 6 Stage F4.3 — `code` and `sideEffectApplied` are
// likewise additive. The F4.1 call follow-up routes return a machine-readable
// `code` (e.g. "CONSENT_WITHDRAWN", "AUDIT_INCOMPLETE") and the governed
// execute route returns `sideEffectApplied: true` alongside reason
// "COMPLETED_AFTER_RECOVERY" (the commitment may already exist, so the UI
// must never offer a retry). Existing call sites never read either field.
export class ApiError extends Error {
  status: number;
  friendly: string;
  reason?: string;
  code?: string;
  sideEffectApplied?: boolean;

  constructor(
    status: number,
    friendly: string,
    technical?: string,
    reason?: string,
    extras?: { code?: string; sideEffectApplied?: boolean },
  ) {
    super(technical ?? friendly);
    this.status = status;
    this.friendly = friendly;
    this.reason = reason;
    this.code = extras?.code;
    this.sideEffectApplied = extras?.sideEffectApplied;
  }
}

// Error States (staging brief): an agent should never see a raw
// "API /x failed: 500" or a provider's technical error text — always a
// plain sentence plus a clear next step. This is the one place that
// mapping happens, so every mutation in the app gets it for free rather
// than re-deriving copy per call site.
function humanizeApiError(path: string, status: number, serverMessage?: string): string {
  if (status === 401) return "You've been signed out. Sign in again to continue.";
  if (status === 403) return "You don't have permission to do that — ask a Brokerage Administrator.";
  if (status === 404) return "That couldn't be found — it may have been removed.";
  if (status >= 500) {
    if (path.includes("/aml/")) return "We couldn't submit the verification request. Nothing has been charged. Try again.";
    if (path.includes("/documents/") && path.includes("send-for-signature")) {
      return "Documents couldn't be sent for signature. Nothing has been sent to the sellers yet.";
    }
    if (path.includes("/payments/") || path.includes("/charge")) {
      return "We couldn't process that payment. Your card has not been charged. Try again.";
    }
    return "Something went wrong on our end. Try again in a moment.";
  }
  // 400/409/etc — these already carry a specific, agent-relevant reason
  // from the server (e.g. "At least one seller must be captured before
  // Ready to List."), so pass it through rather than genericising it.
  return serverMessage ?? "That didn't go through. Check the details and try again.";
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let serverMessage: string | undefined;
    let serverReason: string | undefined;
    let serverCode: string | undefined;
    let sideEffectApplied: boolean | undefined;
    try {
      const body = await res.json();
      serverMessage = typeof body?.error === "string" ? body.error : undefined;
      serverReason = typeof body?.reason === "string" ? body.reason : undefined;
      serverCode = typeof body?.code === "string" ? body.code : undefined;
      sideEffectApplied = typeof body?.sideEffectApplied === "boolean" ? body.sideEffectApplied : undefined;
    } catch {
      // Non-JSON error body — fall through with no server message.
    }
    throw new ApiError(res.status, humanizeApiError(path, res.status, serverMessage), `API ${path} failed: ${res.status}`, serverReason, {
      code: serverCode,
      sideEffectApplied,
    });
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
