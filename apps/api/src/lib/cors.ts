/**
 * Explicit CORS origin allowlist (Foundation Remediation follow-up).
 *
 * Replaces the previous `cors({ origin: true, credentials: true })`, which
 * reflected ANY requesting Origin back with Access-Control-Allow-Origin —
 * combined with `credentials: true` (required so the browser sends/accepts
 * the session cookie, see lib/session.ts), that let any website's JS make
 * credentialed cross-origin requests against this API on a signed-in
 * user's behalf. `origin: true` is a documented cors-package footgun for
 * exactly this reason.
 *
 * The allowlist is read from CORS_ALLOWED_ORIGINS (comma-separated, see
 * .env.example). Same fail-closed shape as SESSION_SECRET
 * (lib/session.ts's assertSessionSecretConfigured, called at boot from
 * index.ts): in production, an unset CORS_ALLOWED_ORIGINS refuses to
 * start rather than silently booting with either an open allowlist or one
 * that rejects every credentialed cross-origin request in a way nobody
 * decided on purpose. Outside production, an unset CORS_ALLOWED_ORIGINS
 * falls back to common localhost dev-server origins so local development
 * and the existing test suite (which never sets CORS_ALLOWED_ORIGINS,
 * see apps/api/.env) are not broken by this change.
 */
import { isProductionEnvironment } from "./env.js";

/** Vite's default dev server port, and the port apps/web's tooling has historically used. */
const DEFAULT_DEV_ORIGINS = ["http://localhost:5173", "http://localhost:3000"];

function parseConfiguredOrigins(): string[] {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * The origins this deployment will echo back in
 * Access-Control-Allow-Origin (and therefore allow to make credentialed
 * cross-origin requests). An explicit CORS_ALLOWED_ORIGINS always wins;
 * absent that, production gets an empty (fail-closed) list — boot should
 * already have refused to start in that case, see assertCorsConfigured —
 * and every other environment gets the localhost dev-origin defaults.
 */
export function getAllowedOrigins(): string[] {
  const configured = parseConfiguredOrigins();
  if (configured.length > 0) return configured;
  return isProductionEnvironment() ? [] : DEFAULT_DEV_ORIGINS;
}

/**
 * Call once during process boot (see index.ts), alongside the existing
 * assertSessionSecretConfigured() — refuses to start in production when
 * CORS_ALLOWED_ORIGINS is unset, instead of quietly booting a
 * cookie-authenticated API with no operator-decided cross-origin policy.
 */
export function assertCorsConfigured(): void {
  if (isProductionEnvironment() && parseConfiguredOrigins().length === 0) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS is not configured. Refusing to start in " +
        "production: this API sends credentials (the session cookie) on " +
        "cross-origin responses, so it must be told exactly which " +
        "origins are allowed to do that rather than falling back to " +
        "reflecting any requesting Origin. Set CORS_ALLOWED_ORIGINS to a " +
        "comma-separated list of the exact origins allowed to call this " +
        "API (for example: https://app.example.com).",
    );
  }
}

/**
 * Origin-callback for the `cors` package (see app.ts). Requests with no
 * Origin header — same-origin navigation, curl/server-to-server calls, and
 * every fetch() call this repo's own HTTP-level test suite makes against
 * its in-process server (routes/__tests__/*.test.ts) — aren't subject to
 * the browser's CORS enforcement in the first place, so they're let
 * through without a header, exactly as they were before this change.
 * Everything else is checked against the explicit allowlist above; when
 * production somehow reaches here with an empty allowlist (boot should
 * already have refused to start via assertCorsConfigured), this fails
 * closed and denies every cross-origin Origin rather than reflecting one.
 */
export function corsOriginCallback(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) {
    callback(null, true);
    return;
  }
  callback(null, getAllowedOrigins().includes(origin));
}
