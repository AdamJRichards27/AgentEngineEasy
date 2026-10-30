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
//
// G-2 — `entitlementKey` and `upgrade` are likewise additive, and only set
// on a 403 whose JSON body carries them. requireEntitlement already emits
// `{ reason, entitlementKey, upgrade:{action,productCode} }`. humanizeApiError
// uses those fields (and requireRole's bare `{ error: "Forbidden" }`) so a
// missing plan, a lapsed subscription, and a wrong role are different
// sentences. Callers that only read `.friendly` pick the new sentence up;
// this module does not render a checkout.
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
  // G-2 — entitlement middleware already returns these on a 403
  // (`apps/api/src/middlewares/entitlement.ts`). They are preserved so a
  // caller can tell a missing plan from a lapsed subscription or a wrong
  // role. This slice does not start a checkout; `upgrade` is data only.
  entitlementKey?: string;
  upgrade?: EntitlementUpgrade;
  // G-UAT-2 — POST /grow/contacts answers 409 with the existing party's id
  // so the Contacts form can open that Contact 360. Other error bodies omit it.
  contactId?: number;
  // AB-3 (D8) — POST /grow/appraisals/from-contact with entry:"property"
  // answers 409 APPRAISAL_EXISTS with the existing appraisal's id.
  appraisalId?: number;

  constructor(
    status: number,
    friendly: string,
    technical?: string,
    reason?: string,
    extras?: {
      code?: string;
      sideEffectApplied?: boolean;
      correlationId?: string;
      serverMessage?: string;
      entitlementKey?: string;
      upgrade?: EntitlementUpgrade;
      contactId?: number;
      appraisalId?: number;
    },
  ) {
    super(technical ?? friendly);
    this.status = status;
    this.friendly = friendly;
    this.reason = reason;
    this.code = extras?.code;
    this.sideEffectApplied = extras?.sideEffectApplied;
    this.correlationId = extras?.correlationId;
    this.serverMessage = extras?.serverMessage;
    this.entitlementKey = extras?.entitlementKey;
    this.upgrade = extras?.upgrade;
    this.contactId = extras?.contactId;
    this.appraisalId = extras?.appraisalId;
  }
}

// G-5 — the one narrowing for a failure an agent might see. An `as ApiError`
// cast reads `.friendly` as undefined when the thrown value is a plain Error,
// a string, or anything else that is not an ApiError, and React renders that
// as the word "undefined". A blank friendly string is the same hole. Callers
// pass a sentence that still makes sense when the failure never reached the API.
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const friendly = error.friendly.trim();
    if (friendly.length > 0) return error.friendly;
  }
  return fallback;
}

// Shape emitted by requireEntitlement on denial:
// `{ action: "grow.checkout", productCode: "grow" }`.
export interface EntitlementUpgrade {
  action: string;
  productCode: string;
}

// Fields a 403 may carry. Absent on a bare 403 and on requireRole's
// `{ error: "Forbidden" }` body.
export interface ForbiddenDetails {
  reason?: string;
  entitlementKey?: string;
  upgrade?: EntitlementUpgrade;
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
export function humanizeApiError(
  path: string,
  status: number,
  serverMessage?: string,
  correlationId?: string,
  forbidden?: ForbiddenDetails,
): string {
  if (status >= 500) return withSupportReference(humanizeServerError(path), correlationId);
  return humanizeClientError(path, status, serverMessage, forbidden);
}

// G-2. The entitlement contract (reason + entitlementKey + upgrade) and
// requireRole's exact `{ error: "Forbidden" }` body pick the sentence.
// A 403 with none of those stays the generic permission line. No checkout
// URL is built from `upgrade.action`.
const GENERIC_FORBIDDEN_MESSAGE = "You don't have permission to do that — ask a Brokerage Administrator.";
const WRONG_ROLE_MESSAGE = "You don't have the right role for that — ask a Brokerage Administrator.";
const PLAN_MISSING_MESSAGE = "Your plan doesn't include this.";
const PLAN_UPGRADE_MESSAGE = "Your plan doesn't include this. A Brokerage Administrator can add it.";
const SUBSCRIPTION_INACTIVE_MESSAGE = "Your subscription isn't active — ask a Brokerage Administrator to restore it.";
const ENTITLEMENT_EXPIRED_MESSAGE = "This access has expired — ask a Brokerage Administrator to renew it.";
const SEAT_NOT_ALLOCATED_MESSAGE = "You don't have a seat for this — ask a Brokerage Administrator.";
const LIMIT_REACHED_MESSAGE = "You've reached the limit on your plan — ask a Brokerage Administrator.";
const TENANT_FORBIDDEN_MESSAGE = "That isn't available for this brokerage.";

const ENTITLEMENT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const UPGRADE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

export function humanizeForbiddenMessage(details: ForbiddenDetails & { serverMessage?: string } = {}): string {
  const { serverMessage, reason, entitlementKey, upgrade } = details;
  if (isWrongRoleReason(reason)) return WRONG_ROLE_MESSAGE;
  // requireRole (apps/api/src/middlewares/auth.ts) returns exactly
  // { error: "Forbidden" }. A reason or entitlement field means some
  // other 403 reused that word.
  if (serverMessage === "Forbidden" && !reason && !entitlementKey && !upgrade) return WRONG_ROLE_MESSAGE;

  switch (reason) {
    case "SUBSCRIPTION_INACTIVE":
      return SUBSCRIPTION_INACTIVE_MESSAGE;
    case "ENTITLEMENT_EXPIRED":
      return ENTITLEMENT_EXPIRED_MESSAGE;
    case "SEAT_NOT_ALLOCATED":
      return SEAT_NOT_ALLOCATED_MESSAGE;
    case "LIMIT_REACHED":
      return LIMIT_REACHED_MESSAGE;
    case "TENANT_CONTEXT_REQUIRED":
    case "TENANT_MISMATCH":
      return TENANT_FORBIDDEN_MESSAGE;
    case "NOT_AUTHENTICATED":
      return "You're not signed in. Sign in to continue.";
    case "ENTITLEMENT_MISSING":
      return upgrade ? PLAN_UPGRADE_MESSAGE : PLAN_MISSING_MESSAGE;
    default:
      break;
  }

  // A key or upgrade object without a recognised reason is still a plan
  // denial (fail-closed and some Grow AI routes omit `upgrade` or `reason`).
  if (entitlementKey || upgrade) return upgrade ? PLAN_UPGRADE_MESSAGE : PLAN_MISSING_MESSAGE;
  return GENERIC_FORBIDDEN_MESSAGE;
}

function isWrongRoleReason(reason: string | undefined): boolean {
  return reason === "ROLE_FORBIDDEN" || (reason?.endsWith("_ROLE_FORBIDDEN") ?? false);
}

export function readEntitlementKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim();
  return ENTITLEMENT_KEY_PATTERN.test(key) ? key : undefined;
}

export function readEntitlementUpgrade(value: unknown): EntitlementUpgrade | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const action = (value as { action?: unknown }).action;
  const productCode = (value as { productCode?: unknown }).productCode;
  if (typeof action !== "string" || typeof productCode !== "string") return undefined;
  const actionTrim = action.trim();
  const productTrim = productCode.trim();
  if (!UPGRADE_TOKEN_PATTERN.test(actionTrim) || !UPGRADE_TOKEN_PATTERN.test(productTrim)) return undefined;
  return { action: actionTrim, productCode: productTrim };
}

function humanizeClientError(path: string, status: number, serverMessage?: string, forbidden?: ForbiddenDetails): string {
  if (status === 401) {
    // A 401 from an authenticated call means the session ended (see
    // isSessionExpiryResponse). From a sign-in endpoint it is a credential
    // rejection ("Invalid email or password.") — show the server's reason.
    if (isSessionExpiryResponse(path, status)) return SESSION_ENDED_MESSAGE;
    return serverMessage ?? "You're not signed in. Sign in to continue.";
  }
  if (status === 403) {
    return humanizeForbiddenMessage({ serverMessage, ...forbidden });
  }
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

let ownerSelectedBrokerageId: number | null = null;

// Memory only: never derive a write's tenant from shared storage or retry a
// context_changed rejection against a freshly fetched tenant.
export function configureOwnerRequestContext(user: {
  platformOwner?: boolean;
  ownerSelectedBrokerageId?: number | null;
} | null | undefined): void {
  ownerSelectedBrokerageId = user?.platformOwner ? user.ownerSelectedBrokerageId ?? null : null;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  // Callers cannot override this safety guard (including on read requests).
  headers.delete("X-AEE-Owner-Brokerage");
  headers.delete("X-AEE-Owner-Action");
  const method = (init?.method ?? "GET").toUpperCase();
  const ownerPath = path.split(/[?#]/)[0];
  if (method !== "GET" && method !== "HEAD" && (ownerPath === "/owner" || ownerPath.startsWith("/owner/"))) {
    headers.set("X-AEE-Owner-Action", "1");
  }
  if (method !== "GET" && method !== "HEAD" && ownerSelectedBrokerageId !== null) {
    headers.set("X-AEE-Owner-Brokerage", String(ownerSelectedBrokerageId));
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      credentials: "include",
      headers,
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
    let entitlementKey: string | undefined;
    let upgrade: EntitlementUpgrade | undefined;
    let contactId: number | undefined;
    let appraisalId: number | undefined;
    try {
      const body = await res.json();
      serverMessage = typeof body?.error === "string" ? body.error : undefined;
      serverReason = typeof body?.reason === "string" ? body.reason : undefined;
      serverCode = typeof body?.code === "string" ? body.code : undefined;
      sideEffectApplied = typeof body?.sideEffectApplied === "boolean" ? body.sideEffectApplied : undefined;
      // G-2: only a 403 carries the entitlement contract. Other statuses
      // keep their existing reason/code parsing and ignore these fields.
      if (res.status === 403) {
        entitlementKey = readEntitlementKey(body?.entitlementKey);
        upgrade = readEntitlementUpgrade(body?.upgrade);
      }
      const rawContactId = body?.contactId;
      if (typeof rawContactId === "number" && Number.isInteger(rawContactId) && rawContactId > 0) {
        contactId = rawContactId;
      }
      const rawAppraisalId = body?.appraisalId;
      if (typeof rawAppraisalId === "number" && Number.isInteger(rawAppraisalId) && rawAppraisalId > 0) {
        appraisalId = rawAppraisalId;
      }
    } catch {
      // Non-JSON error body — fall through with no server message.
    }
    const forbidden = res.status === 403 ? { reason: serverReason, entitlementKey, upgrade } : undefined;
    const contextChanged = res.status === 409 && [serverReason, serverCode, serverMessage]
      .some((value) => value?.toLowerCase() === "context_changed");
    const friendly = contextChanged
      ? "Your selected brokerage changed in another tab. This change was not saved. Reload the page before continuing."
      : humanizeApiError(path, res.status, serverMessage, correlationId, forbidden);
    throw new ApiError(res.status, friendly, `API ${path} failed: ${res.status}`, serverReason, {
      code: serverCode,
      sideEffectApplied,
      correlationId,
      serverMessage,
      entitlementKey,
      upgrade,
      contactId,
      appraisalId,
    });
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}
