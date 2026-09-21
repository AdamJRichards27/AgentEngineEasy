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
 * True whenever live voice transcription has NOT been explicitly approved
 * (isLiveVoiceTranscriptionApproved() above). While true,
 * apps/api/src/lib/ai/voice/gateway.ts's
 * buildVoiceTranscriptionProvider() refuses to construct a live (Deepgram)
 * provider even if AI_TRANSCRIPTION_PROVIDER=deepgram and a DEEPGRAM_API_KEY
 * are both configured — it throws a typed, fail-closed error instead
 * (mapped to an honest "provider unavailable" response, never a silent
 * substitution of the mock provider for a caller who asked for a live
 * one — see that module's own header comment for why this stage
 * deliberately diverges from mustForceMockExternalProvider()'s "silently
 * return the mock/sandbox implementation" convention).
 *
 * AE GROW Pilot Readiness WP2a: this lock now applies in EVERY environment,
 * matching mustForceMockCallTranscriptionProvider() below. Previously it was
 * production-only, so a development/staging process with
 * AI_TRANSCRIPTION_PROVIDER=deepgram and a key sent real recorded voice to
 * Deepgram without the explicit approval the Stage E authorisation requires.
 */
export function mustForceMockVoiceTranscriptionProvider(): boolean {
  return !isLiveVoiceTranscriptionApproved();
}

/**
 * AE GROW Priority 6 F3 Part B — call transcription provider lock.
 *
 * True only when an operator has explicitly set LIVE_CALL_TRANSCRIPTION_APPROVED
 * to the literal string "true". This is deliberately independent from both
 * Stage E's voice-input approval and the telephony approval gate: permission
 * to send a standalone voice recording or to use live telephony does not
 * approve sending recorded call audio to a transcription provider.
 *
 * Unlike the older Stage E voice gate, this lock applies in every
 * environment. A real call-transcription provider must never be constructed
 * until this separate, explicit approval exists, including in development and
 * test. The mock provider remains available without approval.
 */
export function isLiveCallTranscriptionApproved(): boolean {
  return process.env.LIVE_CALL_TRANSCRIPTION_APPROVED === "true";
}

/**
 * True whenever live call transcription has not been explicitly approved.
 * This is intentionally not production-scoped: F3 Part B must require the
 * literal approval flag before a real provider is ever used in any
 * environment.
 */
export function mustForceMockCallTranscriptionProvider(): boolean {
  return !isLiveCallTranscriptionApproved();
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
 * True whenever live telephony has NOT been explicitly approved
 * (isLiveTelephonyApproved() above). Symmetrical with
 * mustForceMockVoiceTranscriptionProvider() above; unused by any F1 code
 * path today (see isLiveTelephonyApproved()'s own comment), but defined
 * now so a future real TelephonyProvider adapter has this check ready to
 * call rather than needing it invented under time pressure once a
 * provider is actually being integrated.
 *
 * AE GROW Pilot Readiness WP2a: applies in EVERY environment (previously
 * production-only), matching mustForceMockCallTranscriptionProvider() —
 * real calls must never be placed from a dev/staging process without the
 * explicit flag.
 */
export function mustForceMockTelephonyProvider(): boolean {
  return !isLiveTelephonyApproved();
}

/**
 * AE GROW Pilot Readiness WP2a — AI text-generation provider lock.
 *
 * True only when an operator has explicitly set LIVE_AI_PROVIDER_APPROVED to
 * the literal string "true". Selecting a real model provider
 * (AI_PROVIDER / AI_FALLBACK_PROVIDER other than "mock") plus a credential
 * is no longer enough on its own to send brokerage/contact context to an
 * external model: this separate, explicit approval must also exist. A
 * SEPARATE flag from every other LIVE_*_APPROVED flag — approving voice,
 * call transcription, telephony or external transactions never approves an
 * external LLM.
 */
export function isLiveAiProviderApproved(): boolean {
  return process.env.LIVE_AI_PROVIDER_APPROVED === "true";
}

/**
 * True whenever the live AI provider has not been explicitly approved — in
 * EVERY environment, like mustForceMockCallTranscriptionProvider(). While
 * true, apps/api/src/lib/ai/gateway.ts's buildProvider() returns the mock
 * provider for any requested real provider (see that function for why this
 * gate follows the gateway's existing "fall back to mock, loudly" pattern
 * rather than the transcription gates' typed-error pattern).
 */
export function mustForceMockAiProvider(): boolean {
  return !isLiveAiProviderApproved();
}

/**
 * AE GROW W3-B — communications dispatch activation gate.
 *
 * True only when an operator has explicitly set LIVE_COMMUNICATIONS_APPROVED
 * to the literal string "true". This governs the EMAIL/SMS dispatch seam in
 * apps/api/src/lib/communications/providers/registry.ts.
 *
 * Why this flag exists BEFORE any live adapter does. Every other outbound
 * domain — calling, call transcription, voice, the AI model provider —
 * already had a LIVE_*_APPROVED flag, because each had a real adapter that
 * needed holding shut. EMAIL/SMS had none, for the opposite reason: the
 * outbox hardcoded the sandbox adapter with no branch at all, so there was
 * nothing to gate. That is a worse position to be in, not a better one —
 * when a vendor adapter is eventually chosen, the gate would have to be
 * retrofitted around live code that already works, which is exactly the
 * order in which these controls get weakened or forgotten. Introducing the
 * seam and its gate now, while the only reachable provider is provably the
 * sandbox, means a future adapter inherits a fail-closed default on the day
 * it is written rather than needing one argued for afterwards.
 *
 * A SEPARATE flag from every other LIVE_*_APPROVED flag, per the same
 * convention those follow — approving telephony, call transcription, voice,
 * external transactions or an external LLM must never be read as approving
 * this app to send real email or SMS to a real recipient.
 */
export function isLiveCommunicationsApproved(): boolean {
  return process.env.LIVE_COMMUNICATIONS_APPROVED === "true";
}

/**
 * True whenever live communications dispatch has NOT been explicitly
 * approved. Deliberately NOT production-scoped, matching
 * mustForceMockCallTranscriptionProvider() and mustForceMockTelephonyProvider()
 * rather than the older production-only gates: a real message sent to a real
 * contact from a developer's laptop or from staging is exactly as delivered,
 * and exactly as unrecallable, as one sent from production.
 */
export function mustForceSandboxCommunicationsProvider(): boolean {
  return !isLiveCommunicationsApproved();
}
