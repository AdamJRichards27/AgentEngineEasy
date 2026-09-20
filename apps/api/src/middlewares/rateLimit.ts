import rateLimit from "express-rate-limit";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { incrementCounter } from "@aee/events";
import { dispatchOperationalAlert } from "../lib/operationalAlerts.js";

/**
 * Same NODE_ENV==="test" carve-out already used elsewhere in this codebase
 * (lib/financial/bootstrap.ts and lib/exceptions/bootstrap.ts skip their
 * periodic schedulers the same way, and apps/api/.env sets NODE_ENV=test
 * for the real HTTP-level test suite). The limiters below stay fully real
 * in every environment — nothing is disabled here — they just get a much
 * higher ceiling under test so the suite's many rapid, legitimate
 * same-process requests (routes/__tests__/*.test.ts spins up a real
 * listening server per file and drives it with dozens of fetch() calls)
 * never collide with the production-sized budget.
 */
const isTestEnvironment = process.env.NODE_ENV === "test";

const ONE_MINUTE_MS = 60_000;
const TEST_REQUEST_LIMIT = 100_000;

/**
 * Production-sized budgets, named so the wiring below and its tests can
 * refer to one definition rather than three scattered magic numbers.
 */
export const AUTH_RATE_LIMIT_PER_MINUTE = 20;
export const GLOBAL_RATE_LIMIT_PER_MINUTE = 300;
/**
 * AE GROW Pilot Readiness WP6a (D3). The session probe gets its own,
 * generous budget rather than the strict credential-surface one: it is not
 * a brute-force surface (it requires an already-valid session cookie and
 * reveals nothing without one), but the SPA calls it on every page load and
 * on every session refresh (apps/web/src/lib/session.ts), so charging it to
 * the 20/min sign-in budget bounced a legitimately signed-in user back to
 * /login after ~20 navigations. Matched to the app-wide global budget
 * because that is the ceiling this endpoint could ever reach anyway.
 */
export const SESSION_PROBE_RATE_LIMIT_PER_MINUTE = 300;

/**
 * Generous global throttle applied to the whole API (see app.ts) — 300
 * requests/minute per IP. Not a substitute for real abuse detection; it's
 * the first line of defence against runaway retries, a misbehaving
 * integration, or basic scripted abuse hitting an API that previously had
 * zero throttling anywhere.
 */
export const globalRateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: isTestEnvironment ? TEST_REQUEST_LIMIT : GLOBAL_RATE_LIMIT_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Stricter limiter for the credential surface — routes/index.ts mounts this
 * ahead of authRouter, on /auth (via authSurfaceRateLimiter below).
 * 20 requests/minute per IP. Sign-in, dev-login, password-reset and
 * invitation endpoints are the highest-value target for credential
 * stuffing / brute-force-style abuse, so they get a tighter budget than
 * the rest of the API.
 *
 * The `limit` override exists only so the tests can exercise the real
 * throttling behaviour without waiting out a production-sized budget (the
 * NODE_ENV==="test" carve-out above otherwise raises every ceiling).
 */
export function buildAuthRateLimiter(limit: number = isTestEnvironment ? TEST_REQUEST_LIMIT : AUTH_RATE_LIMIT_PER_MINUTE): RequestHandler {
  return rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication requests, please try again later." },
    // AE Step 2 closure — Part B: the auth surface is the highest-value
    // target for credential-stuffing/brute-force-style abuse (this file's
    // own module comment) — a sustained rate of hits here is exactly the
    // auth-attack-pattern signal Part B names. See
    // docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
    handler: (_req, res, _next, options) => {
      incrementCounter("auth_security_event_total", { event: "auth_rate_limited" });
      void dispatchOperationalAlert({
        type: "AUTH_ANOMALY",
        summary: "Authentication rate limit reached",
        dedupKey: "auth-anomaly:rate-limit",
        details: { signal: "auth_rate_limited" },
      });
      res.status(options.statusCode).json(options.message);
    },
  });
}

export const authRateLimiter = buildAuthRateLimiter();

/**
 * AE GROW Pilot Readiness WP6a (D3) — generous limiter for the read-only
 * session probe. Deliberately NOT the strict credential limiter and
 * deliberately NOT "no limiter at all": the endpoint stays throttled (so it
 * can never become a free, unbounded surface), just at a budget a real
 * browsing session cannot exhaust. It raises none of the auth-anomaly
 * signals above, because exhausting this budget is not an auth-attack
 * pattern.
 */
export function buildSessionProbeRateLimiter(
  limit: number = isTestEnvironment ? TEST_REQUEST_LIMIT : SESSION_PROBE_RATE_LIMIT_PER_MINUTE,
): RequestHandler {
  return rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
}

export const sessionProbeRateLimiter = buildSessionProbeRateLimiter();

/**
 * Paths under the /auth mount that are read-only session probes rather than
 * credential-bearing endpoints. Compared against the mount-relative path
 * (Express strips the "/auth" prefix from req.url for middleware mounted
 * with `use("/auth", ...)`), so this stays correct if the mount prefix ever
 * changes.
 *
 * Only GET /auth/me qualifies today — it is the single endpoint the SPA
 * polls on every page load and session refresh (apps/web/src/lib/session.ts
 * useSession()/useEntitlements(), and apps/web/src/lib/api.ts's own
 * SESSION_EXPIRY_EXEMPT_EXACT list names it as "the session probe"). The
 * other endpoint the web app fetches unauthenticated on load,
 * GET /legal/versions, lives on privacyRouter and was never behind this
 * limiter at all. Everything else under /auth — login, dev-login, logout,
 * known-users, password-reset/*, invitations/*, change-password, admin/* —
 * stays on the strict limiter.
 */
const SESSION_PROBE_PATHS: ReadonlySet<string> = new Set(["/me"]);

export function isSessionProbeRequest(method: string, mountRelativePath: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  // Normalise a trailing slash so "/me/" cannot slip past onto the strict
  // limiter (or, worse, be used to burn a different budget than the one the
  // route it resolves to is supposed to use).
  const normalised = mountRelativePath.length > 1 ? mountRelativePath.replace(/\/+$/, "") : mountRelativePath;
  return SESSION_PROBE_PATHS.has(normalised);
}

/**
 * The single middleware routes/index.ts mounts on /auth: it routes the
 * read-only session probe to the generous limiter and everything else on
 * the auth surface to the strict credential limiter. Written as an explicit
 * dispatch (rather than a `skip` on the strict limiter plus a second
 * `use()`) so exactly one limiter ever counts a given request, and so the
 * choice is visible in one place.
 */
export function buildAuthSurfaceRateLimiter(
  strict: RequestHandler = authRateLimiter,
  probe: RequestHandler = sessionProbeRateLimiter,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const limiter = isSessionProbeRequest(req.method, req.path) ? probe : strict;
    limiter(req, res, next);
  };
}

export const authSurfaceRateLimiter = buildAuthSurfaceRateLimiter();

/**
 * AE GROW Pilot Readiness WP6a (D3, part b) — explicit, configurable proxy
 * trust for Express's `trust proxy` setting.
 *
 * Express (and therefore express-rate-limit's per-IP key) defaults to
 * NOT trusting any proxy, which means that behind a load balancer every
 * request appears to come from the balancer's own IP and all users share a
 * single rate-limit budget. Turning trust on blindly is worse — a client
 * could then spoof X-Forwarded-For and bypass the limiter entirely — so
 * this is operator-configured via TRUST_PROXY and FAILS SAFE: unset, empty,
 * "false", or anything unparseable all mean "trust nothing", i.e. exactly
 * the behaviour this app had before this setting existed.
 *
 * Accepted values:
 *   unset / "" / "false"  -> false (trust nothing; the default)
 *   "true"                -> true  (trust every hop; only safe when the app
 *                                   is not directly reachable)
 *   a non-negative integer-> that many hops closest to the app are trusted
 *                            (the usual answer for a single load balancer
 *                            is "1")
 */
export type TrustProxySetting = boolean | number;

export function parseTrustProxySetting(raw: string | undefined | null): {
  value: TrustProxySetting;
  valid: boolean;
} {
  if (raw === undefined || raw === null) return { value: false, valid: true };
  const normalised = raw.trim().toLowerCase();
  if (normalised === "" || normalised === "false") return { value: false, valid: true };
  if (normalised === "true") return { value: true, valid: true };
  // Deliberately strict: Number() alone accepts "0x1", " 1e3", "Infinity"
  // and "" — none of which an operator meant to type into a hop count.
  if (/^\d+$/.test(normalised)) {
    const hops = Number(normalised);
    if (Number.isSafeInteger(hops)) return { value: hops, valid: true };
  }
  return { value: false, valid: false };
}
