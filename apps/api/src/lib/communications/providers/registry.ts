// AE GROW W3-B — the EMAIL/SMS dispatch seam and its activation gate.
//
// WHAT THIS REPLACES
//
// outbox.ts used to name sandboxEmailProvider/sandboxSmsProvider directly at
// the send call, with no branch and no flag. That was safe — the sandbox is
// the only adapter that exists — but it left nowhere to hang an approval
// gate. Every other outbound domain in this codebase (telephony, call
// transcription, voice, the AI model provider) resolves its provider through
// a factory that consults a LIVE_*_APPROVED flag first; EMAIL/SMS were the
// one gap, and would have had that control retrofitted around already-working
// live code at exactly the moment a vendor was chosen and everyone was in a
// hurry. This module closes the gap now, while the only reachable provider is
// provably the sandbox.
//
// WHAT THIS DELIBERATELY IS NOT
//
// There is no vendor adapter here, no vendor SDK, no credential, and no
// provider id that resolves to anything other than the sandbox. Selecting
// any non-sandbox id throws. This file is the seam and the contract; the
// adapter behind it is a separate, separately-authorised decision.
//
// FAIL-CLOSED, AND LOUDLY
//
// Modelled on ai/voice/gateway.ts's buildCallTranscriptionProvider(), whose
// header comment sets out the rule the whole codebase follows: never
// silently fall back from live to mock. The reasoning transfers exactly. A
// silent downgrade here would mean an operator who configured a real SMS
// provider, believing their contacts were being messaged, would instead get
// a sandbox row labelled SENT and a UI that agrees — indistinguishable from
// real delivery, and discovered only when someone asks why nobody replied.
// An unapproved or unknown selection is therefore a typed, logged error, and
// never a quiet substitution.

import { logger } from "@aee/events";
import { mustForceSandboxCommunicationsProvider } from "../../env.js";
import { sandboxEmailProvider } from "./sandboxEmail.js";
import { sandboxSmsProvider } from "./sandboxSms.js";
import { CommunicationProviderError, type EmailProvider, type SmsProvider } from "./types.js";
import { assertOutboundAllowed } from "../../outboundGuard.js";

/** The only provider id this build resolves. Anything else fails closed. */
export const SANDBOX_PROVIDER_ID = "sandbox";

export const EMAIL_PROVIDER_ENV = "COMMUNICATIONS_EMAIL_PROVIDER" as const;
export const SMS_PROVIDER_ENV = "COMMUNICATIONS_SMS_PROVIDER" as const;
export const LIVE_COMMUNICATIONS_APPROVAL_ENV = "LIVE_COMMUNICATIONS_APPROVED" as const;

export interface CommunicationProviderConfig {
  email: string;
  sms: string;
}

/**
 * An unset OR empty/whitespace selector means "sandbox". Being forgiving
 * here is safe precisely because the forgiving answer is the sandbox: an
 * operator who exports an empty variable gets the inert adapter, not a live
 * one. The strictness that matters is in the other direction and lives in
 * resolveProvider() below.
 */
function normalizeProviderId(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  return trimmed.length === 0 ? SANDBOX_PROVIDER_ID : trimmed.toLowerCase();
}

export function loadCommunicationProviderConfig(): CommunicationProviderConfig {
  return {
    email: normalizeProviderId(process.env[EMAIL_PROVIDER_ENV]),
    sms: normalizeProviderId(process.env[SMS_PROVIDER_ENV]),
  };
}

let emailOverride: EmailProvider | null = null;
let smsOverride: SmsProvider | null = null;

/**
 * Test seam only, mirroring setVoiceTranscriptionProviderForTests(). This is
 * what lets the conformance suite run against a candidate adapter without a
 * product-code change.
 *
 * It is NOT a way around the approval gate: resolveProvider() checks the flag
 * before an override that is not the sandbox can be returned, exactly as
 * buildCallTranscriptionProvider() does. A test cannot construct a dispatch
 * path that production would be refused.
 */
export function setCommunicationProvidersForTests(overrides: { email?: EmailProvider | null; sms?: SmsProvider | null }): void {
  if ("email" in overrides) emailOverride = overrides.email ?? null;
  if ("sms" in overrides) smsOverride = overrides.sms ?? null;
}

export function resetCommunicationProvidersForTests(): void {
  emailOverride = null;
  smsOverride = null;
}

function liveDisabledError(provider: string, channel: "EMAIL" | "SMS"): CommunicationProviderError {
  return new CommunicationProviderError(
    provider,
    channel,
    "live_provider_disabled",
    `Live ${channel} dispatch is not approved for this environment (${LIVE_COMMUNICATIONS_APPROVAL_ENV} is not set to "true"). ` +
      `Refusing to dispatch rather than silently sending through the sandbox.`,
  );
}

function resolveProvider<P extends { name: string }>(args: {
  channel: "EMAIL" | "SMS";
  requested: string;
  sandbox: P;
  override: P | null;
  selectorEnv: string;
}): P {
  const requested = args.requested;

  if (requested === SANDBOX_PROVIDER_ID) {
    // The sandbox itself needs no approval — it reaches nothing. But an
    // override that is NOT the sandbox must not be able to ride in on the
    // sandbox's selector, or the test seam would become the bypass.
    if (args.override !== null && args.override.name !== args.sandbox.name && mustForceSandboxCommunicationsProvider()) {
      logger.warn("communications_provider_locked_to_sandbox_pilot_policy", {
        channel: args.channel,
        requestedProvider: args.override.name,
        via: "test_override",
      });
      throw liveDisabledError(args.override.name, args.channel);
    }
    return args.override ?? args.sandbox;
  }

  // A non-sandbox selection. The gate is checked FIRST and in EVERY
  // environment — before any credential lookup, before the override, and
  // without consulting NODE_ENV. There is no branch below this point that
  // can return the sandbox, which is the property that matters.
  if (mustForceSandboxCommunicationsProvider()) {
    logger.warn("communications_provider_locked_to_sandbox_pilot_policy", {
      channel: args.channel,
      requestedProvider: requested,
      via: args.selectorEnv,
    });
    throw liveDisabledError(requested, args.channel);
  }

  if (args.override !== null) return args.override;

  // Approved — and still nothing to resolve to. This build ships no live
  // EMAIL/SMS adapter at all, by design: W3-B delivers the seam and the
  // contract, not the vendor. Reaching here means an operator has approved
  // live communications and named a provider that does not exist, which is a
  // misconfiguration worth failing on rather than papering over.
  throw new CommunicationProviderError(
    requested,
    args.channel,
    "provider_error",
    `Unknown ${args.channel} provider "${requested}" (${args.selectorEnv}). ` +
      `No live ${args.channel} adapter exists in this build; "${SANDBOX_PROVIDER_ID}" is the only supported value.`,
  );
}

/**
 * Resolves the EMAIL adapter for a dispatch. With no environment set this
 * returns the very same `sandboxEmailProvider` object outbox.ts used to name
 * directly — object identity, not merely equivalent behaviour.
 */
export function resolveEmailProvider(config: CommunicationProviderConfig = loadCommunicationProviderConfig()): EmailProvider {
  // WS4-09/11: in a restored environment only an in-process (or allow-listed) provider may be used
  // (lib/outboundGuard.ts). Thrown before dispatchMessage() moves the message to SENDING, so it stays QUEUED.
  const provider = resolveProvider<EmailProvider>({
    channel: "EMAIL",
    requested: normalizeProviderId(config.email),
    sandbox: sandboxEmailProvider,
    override: emailOverride,
    selectorEnv: EMAIL_PROVIDER_ENV,
  });
  assertOutboundAllowed("communications_email", provider.name);
  return provider;
}

/** SMS counterpart of resolveEmailProvider(). Resolved independently — approving one channel's provider never selects the other's. */
export function resolveSmsProvider(config: CommunicationProviderConfig = loadCommunicationProviderConfig()): SmsProvider {
  // WS4-09/11: see resolveEmailProvider().
  const provider = resolveProvider<SmsProvider>({
    channel: "SMS",
    requested: normalizeProviderId(config.sms),
    sandbox: sandboxSmsProvider,
    override: smsOverride,
    selectorEnv: SMS_PROVIDER_ENV,
  });
  assertOutboundAllowed("communications_sms", provider.name);
  return provider;
}
