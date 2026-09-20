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
//
// AE GROW Pilot Readiness WP5 — `correlationId` is likewise additive: the
// API stamps every response (errors included) with an X-Correlation-Id
// header (apps/api/src/middlewares/requestId.ts) that ties the request to
// its server log lines. It is captured here so a failure can show the
// agent a short "Reference: <first 8 chars>" to quote to support (see
// formatSupportReference below). A network failure (status 0 — no response
// ever arrived) has no server id, so correlationId is undefined there.
export class ApiError extends Error {
  status: number;
  friendly: string;
  reason?: string;
  code?: string;
  sideEffectApplied?: boolean;
  correlationId?: string;
  // AE GROW Pilot Readiness WP8 — the raw `error` string from the JSON body,
  // before humanizeApiError() turned it into `.friendly`. It exists to answer
  // one question no other field can: did this error actually come from the
  // API? Every API failure, 500 included, answers `{ "error": "…" }` (see
  // apps/api/src/middlewares/errorHandler.ts), so a 5xx with no server message
  // was authored by something in FRONT of the API — a dev proxy or load
  // balancer reporting that the API itself could not be reached. lib/
  // sessionProbe.ts is the only current reader.
  serverMessage?: string;

  constructor(
    status: number,
    friendly: string,
    technical?: string,
    reason?: string,
    extras?: { code?: string; sideEffectApplied?: boolean; correlationId?: string; serverMessage?: string },
  ) {
    super(technical ?? friendly);
    this.status = status;
    this.friendly = friendly;
    this.reason = reason;
    this.code = extras?.code;
    this.sideEffectApplied = extras?.sideEffectApplied;
    this.correlationId = extras?.correlationId;
    this.serverMessage = extras?.serverMessage;
  }
}

// ── Support references (AE GROW Pilot Readiness WP5) ────────────────────
export const CORRELATION_ID_HEADER = "X-Correlation-Id";
const SUPPORT_REFERENCE_LENGTH = 8;

// Reads the server's correlation id off a response's headers. Header lookup
// is case-insensitive in the Fetch API; the value is trimmed and anything
// outside a conservative id alphabet rejected, so a proxy-mangled header can
// never inject arbitrary text into a user-facing message.
export function readCorrelationId(headers: { get(name: string): string | null } | null | undefined): string | undefined {
  const raw = headers?.get(CORRELATION_ID_HEADER)?.trim();
  if (!raw || !/^[A-Za-z0-9._:-]{1,200}$/.test(raw)) return undefined;
  return raw;
}

// Short, quotable form of a correlation id: "Reference: 1a2b3c4d". Only the
// first 8 characters are shown (enough for support to find the full id in
// the logs); hyphens are dropped first so a UUID never yields a truncated
// "1a2b-3c4" style fragment.
export function formatSupportReference(correlationId: string | null | undefined): string | undefined {
  const compact = correlationId?.replace(/[^A-Za-z0-9]/g, "") ?? "";
  if (!compact) return undefined;
  return `Reference: ${compact.slice(0, SUPPORT_REFERENCE_LENGTH)}`;
}

// Appends the support reference (when there is one) to a friendly message.
export function withSupportReference(message: string, correlationId: string | null | undefined): string {
  const reference = formatSupportReference(correlationId);
  return reference ? `${message} ${reference}` : message;
}

// ── Global session-expiry handling (AE GROW Pilot Readiness WP5) ────────
// A 401 from any authenticated call means the session cookie is gone or
// expired — the whole app, not just the panel that made the call, should
// return to sign-in. The auth endpoints below are exempt: a 401 from them is
// either the normal "not signed in yet" probe (/auth/me — the session query
// itself), a wrong password (/auth/login, /legal/acceptance), or a public,
// pre-session flow. Treating those as "session ended" would either loop
// (probe → 401 → re-probe) or tell someone who never signed in that their
// session ended. 403 is an entitlement/permission refusal from a VALID
// session and never ends it.
const SESSION_EXPIRY_EXEMPT_EXACT = new Set(["/auth/me", "/auth/login", "/auth/dev-login", "/auth/logout", "/auth/known-users", "/legal/acceptance"]);
const SESSION_EXPIRY_EXEMPT_PREFIXES = ["/auth/invitations/", "/auth/password-reset/"];

export function isSessionExpiryResponse(path: string, status: number): boolean {
  if (status !== 401) return false;
  const bare = path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (SESSION_EXPIRY_EXEMPT_EXACT.has(bare)) return false;
  return !SESSION_EXPIRY_EXEMPT_PREFIXES.some((prefix) => bare.startsWith(prefix));
}

let sessionExpiredHandler: (() => void) | null = null;

// Registered once at startup (lib/session.ts installSessionExpiryHandling,
// called from main.tsx). Kept as an injected callback so this module stays
// free of React/React Query and its pure helpers remain unit-testable.
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

// Error States (staging brief): an agent should never see a raw
// "API /x failed: 500" or a provider's technical error text — always a
// plain sentence plus a clear next step. This is the one place that
// mapping happens, so every mutation in the app gets it for free rather
// than re-deriving copy per call site.
export function humanizeApiError(path: string, status: number, serverMessage?: string, correlationId?: string): string {
  if (status >= 500) return withSupportReference(humanizeServerError(path), correlationId);
  return humanizeClientError(path, status, serverMessage);
}

function humanizeClientError(path: string, status: number, serverMessage?: string): string {
  if (status === 401) {
    // A 401 from an authenticated call means the session ended (see
    // isSessionExpiryResponse). From a sign-in endpoint it is a credential
    // rejection ("Invalid email or password.") — show the server's reason.
    if (isSessionExpiryResponse(path, status)) return SESSION_ENDED_MESSAGE;
    return serverMessage ?? "You're not signed in. Sign in to continue.";
  }
  if (status === 403) return "You don't have permission to do that — ask a Brokerage Administrator.";
  if (status === 404) return "That couldn't be found — it may have been removed.";
  // 400/409/etc — these already carry a specific, agent-relevant reason
  // from the server (e.g. "At least one seller must be captured before
  // Ready to List."), so pass it through rather than genericising it.
  return serverMessage ?? "That didn't go through. Check the details and try again.";
}

function humanizeServerError(path: string): string {
  if (path.includes("/aml/")) return "We couldn't submit the verification request. Nothing has been charged. Try again.";
  if (path.includes("/documents/") && path.includes("send-for-signature")) {
    return "Documents couldn't be sent for signature. Nothing has been sent to the sellers yet.";
  }
  if (path.includes("/payments/") || path.includes("/charge")) {
    return "We couldn't process that payment. Your card has not been charged. Try again.";
  }
  return "Something went wrong on our end. Try again in a moment.";
}

export const NETWORK_ERROR_MESSAGE = "We couldn't reach Agent Engine. Check your connection and try again.";
export const SESSION_ENDED_MESSAGE = "Your session has ended — please sign in again.";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (error) {
    // A deliberate cancellation (AbortSignal) is not a failure — rethrow it
    // untouched so React Query / callers can recognise it as such.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // No response at all (offline, DNS, connection reset, CORS). Surface the
    // same ApiError shape every caller already reads `.friendly` from,
    // rather than a bare TypeError whose `.friendly` is undefined.
    throw new ApiError(0, NETWORK_ERROR_MESSAGE, `API ${path} failed: network error`);
  }
  if (!res.ok) {
    const correlationId = readCorrelationId(res.headers);
    if (isSessionExpiryResponse(path, res.status)) {
      try {
        sessionExpiredHandler?.();
      } catch {
        // Never let the global handler mask the original error.
      }
    }
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
    throw new ApiError(res.status, humanizeApiError(path, res.status, serverMessage, correlationId), `API ${path} failed: ${res.status}`, serverReason, {
      code: serverCode,
      sideEffectApplied,
      correlationId,
      serverMessage,
    });
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
