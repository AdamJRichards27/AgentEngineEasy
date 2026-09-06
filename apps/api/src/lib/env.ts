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

/**
 * Critical Blocker Remediation, Phase 10 — commercial/external-action lock.
 *
 * True only when an operator has explicitly set
 * LIVE_EXTERNAL_TRANSACTIONS_APPROVED to the literal string "true". This is
 * the single flag that must be flipped before this process is allowed to
 * use a real (non-mock/non-sandbox) billing, payment, AML, e-signature, or
 * property-data provider in production — see mustForceMockExternalProvider()
 * below and its equivalents inline in each packages/integrations/* provider
 * factory (those packages cannot import this file — apps/api depends on
 * them, not the other way around — so each repeats this same two-line
 * check locally rather than sharing this function directly).
 *
 * Outside production this has no effect (see mustForceMockExternalProvider):
 * local/test runs keep today's behaviour unchanged either way.
 */
export function isLiveExternalTransactionsApproved(): boolean {
  return process.env.LIVE_EXTERNAL_TRANSACTIONS_APPROVED === "true";
}

/**
 * True only in production, when live external transactions have NOT been
 * explicitly approved (isLiveExternalTransactionsApproved() above). While
 * true, every provider factory in this app must ignore its own PROVIDER
 * env var and any configured credentials, and return its mock/sandbox
 * implementation instead — regardless of whether a real API key/secret
 * happens to be present in the environment (e.g. copied in from another
 * deployment's Secrets by mistake). This is what makes the AE Project
 * Owner's explicit instruction for this remediation pass — "no automated
 * subscription/direct-debit/PC success-fee/trust-money transaction
 * authorised" and "test/sandbox modes only; no real AML/email/SMS/
 * e-signature/payment/property-data action authorised" — true independent
 * of what credentials an operator has or has not configured, the same
 * "must not depend on a credential simply being absent" reasoning as every
 * other fail-closed gate in this file.
 */
export function mustForceMockExternalProvider(): boolean {
  return isProductionEnvironment() && !isLiveExternalTransactionsApproved();
}
