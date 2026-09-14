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

/**
 * AE GROW Priority 6 Stage E — Voice as Input.
 *
 * True only when an operator has explicitly set
 * LIVE_VOICE_TRANSCRIPTION_APPROVED to the literal string "true". Modelled
 * directly on isLiveExternalTransactionsApproved() above: a single,
 * explicit flag that must be flipped before this process is allowed to
 * send real audio to a real (non-mock) transcription provider such as
 * Deepgram. See apps/api/src/lib/ai/voice/gateway.ts's
 * buildVoiceTranscriptionProvider() for where this is actually enforced.
 *
 * Deliberately a SEPARATE flag from LIVE_EXTERNAL_TRANSACTIONS_APPROVED,
 * not a reuse of it: approving payments/AML/e-signature/property-data
 * providers is not the same decision as approving an external party to
 * receive a user's recorded voice, which the Stage E authorisation
 * requires to be its own, explicit, later Project Owner decision (see the
 * "Live-activation gates" section of
 * docs/AE_GROW_PRIORITY_6_STAGE_E_VOICE_INPUT_REPORT.md).
 */
export function isLiveVoiceTranscriptionApproved(): boolean {
  return process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED === "true";
}

/**
 * True only in production, when live voice transcription has NOT been
 * explicitly approved (isLiveVoiceTranscriptionApproved() above). While
 * true, apps/api/src/lib/ai/voice/gateway.ts's
 * buildVoiceTranscriptionProvider() refuses to construct a live (Deepgram)
 * provider even if AI_TRANSCRIPTION_PROVIDER=deepgram and a DEEPGRAM_API_KEY
 * are both configured — it throws a typed, fail-closed error instead
 * (mapped to an honest "provider unavailable" response, never a silent
 * substitution of the mock provider for a caller who asked for a live
 * one — see that module's own header comment for why this stage
 * deliberately diverges from mustForceMockExternalProvider()'s "silently
 * return the mock/sandbox implementation" convention). Outside production
 * this has no effect, same as mustForceMockExternalProvider() above.
 */
export function mustForceMockVoiceTranscriptionProvider(): boolean {
  return isProductionEnvironment() && !isLiveVoiceTranscriptionApproved();
}

/**
 * AE GROW Priority 6 Stage F1 — Call Foundation.
 *
 * True only when an operator has explicitly set LIVE_TELEPHONY_APPROVED to
 * the literal string "true". Modelled directly on
 * isLiveVoiceTranscriptionApproved() above, but this is a KILL SWITCH for a
 * real telephony provider that does not exist yet — F1 implements ONLY
 * SandboxTelephonyProvider (see apps/api/src/lib/telephony/sandboxProvider.ts)
 * and defines no real provider adapter at all. This flag therefore has no
 * effect on any code path F1 ships; it exists now, ahead of any real
 * adapter, so that a future F2 provider integration inherits a
 * fail-closed default from day one rather than needing this decision
 * retrofitted later. The governing F1 authorisation is explicit that even
 * once a real adapter exists, activating it requires ALL of: a configured
 * provider selection, credentials, an entitlement, AND this flag — never
 * this flag alone.
 *
 * Deliberately a SEPARATE flag from LIVE_EXTERNAL_TRANSACTIONS_APPROVED and
 * LIVE_VOICE_TRANSCRIPTION_APPROVED, per that same authorisation — approving
 * any of the other two domains must never be read as approving live
 * telephony.
 */
export function isLiveTelephonyApproved(): boolean {
  return process.env.LIVE_TELEPHONY_APPROVED === "true";
}

/**
 * True only in production, when live telephony has NOT been explicitly
 * approved (isLiveTelephonyApproved() above). Symmetrical with
 * mustForceMockVoiceTranscriptionProvider() above; unused by any F1 code
 * path today (see isLiveTelephonyApproved()'s own comment), but defined
 * now so a future real TelephonyProvider adapter has this check ready to
 * call rather than needing it invented under time pressure once a
 * provider is actually being integrated.
 */
export function mustForceMockTelephonyProvider(): boolean {
  return isProductionEnvironment() && !isLiveTelephonyApproved();
}
