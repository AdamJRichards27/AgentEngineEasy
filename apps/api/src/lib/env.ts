/**
 * Centralised, explicit environment classification for security-sensitive
 * feature gates (Agent Engine 2.0 Foundation Remediation, Stage 1).
 *
 * Deliberately fail-closed: every gate here defaults to the SECURE/DISABLED
 * state. A gate only opens when an operator has explicitly set the matching
 * environment variable to the literal string "true" - omitting a variable,
 * leaving NODE_ENV unset, or setting an unexpected value must never enable
 * a development-only capability (Foundation Remediation instructions,
 * Stage 1.1: "development-only routes cannot be activated merely by
 * omitting an environment variable").
 */

/** True only when NODE_ENV is explicitly "production". Its absence is never treated as safe. */
export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * True only when an operator has explicitly opted in to development-only
 * authentication (POST /auth/dev-login, GET /auth/known-users) AND the
 * environment has not been explicitly marked production. Both conditions
 * must hold. The disabled state is the default in every other case,
 * including when ALLOW_DEV_AUTH is unset, empty, or any value other than
 * the literal string "true" - and it cannot be re-enabled by anything set
 * inside a request (header, query string, body).
 */
export function isDevAuthEnabled(): boolean {
  if (isProductionEnvironment()) return false;
  return process.env.ALLOW_DEV_AUTH === "true";
}

/**
 * True only when an operator has explicitly accepted an HttpOnly session
 * cookie without the Secure attribute, for plain-http local development
 * (e.g. http://localhost without TLS). Every other environment - including
 * this repository's own Replit workspace, which is served over https even
 * in development - gets a Secure cookie by default.
 */
export function isInsecureCookieExplicitlyAllowed(): boolean {
  if (isProductionEnvironment()) return false;
  return process.env.ALLOW_INSECURE_DEV_COOKIES === "true";
}
