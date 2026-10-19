import { logger } from "@aee/events";
import { mustForceMockCallTranscriptionProvider, mustForceMockVoiceTranscriptionProvider } from "../../env.js";
import { MockTranscriptionProvider } from "./mockTranscriptionProvider.js";
import { DeepgramTranscriptionProvider } from "./deepgramTranscriptionProvider.js";
import { TranscriptionProviderError } from "./types.js";
import type { TranscriptionProvider } from "./types.js";
import { assertOutboundAllowed } from "../../outboundGuard.js";

// AE GROW Priority 6 Stage E — Voice Transcription Gateway. The one place
// that knows how to reach a transcription provider, mirroring
// apps/api/src/lib/ai/gateway.ts's own AI Gateway pattern for the existing
// text-generation provider. Config is env-driven
// (AI_TRANSCRIPTION_PROVIDER=mock|deepgram, DEEPGRAM_API_KEY,
// LIVE_VOICE_TRANSCRIPTION_APPROVED — see .env.example).
export interface VoiceTranscriptionConfig {
  provider: string;
  timeoutMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadVoiceTranscriptionConfig(): VoiceTranscriptionConfig {
  return {
    provider: process.env.AI_TRANSCRIPTION_PROVIDER ?? "mock",
    timeoutMs: envInt("AI_TRANSCRIPTION_TIMEOUT_MS", 15_000),
  };
}

let providerOverride: TranscriptionProvider | null = null;

/**
 * Test seam only — mirrors documentStorage.ts's own
 * setDocumentStorageProviderForTests(). Production code always goes
 * through buildVoiceTranscriptionProvider()'s real, fail-closed selection
 * below.
 */
export function setVoiceTranscriptionProviderForTests(provider: TranscriptionProvider | null): void {
  providerOverride = provider;
}

/**
 * Fail-closed provider selection. Deliberately does NOT mirror
 * apps/api/src/lib/ai/gateway.ts's buildProvider()'s own "missing key ->
 * silently fall back to mock" behaviour, and does NOT mirror
 * mustForceMockExternalProvider()'s "silently return the mock/sandbox
 * implementation" convention used by the AML/e-sign/payments/property-data
 * factories: those are fine when the degraded outcome is still a safe,
 * honest answer (an existing Mock*Provider standing in for a domain that
 * was never going to touch a real third party without separate approval
 * anyway). Silently substituting a MOCK TRANSCRIPT for a caller who
 * explicitly configured a LIVE provider is a different, worse failure mode
 * here: the operator (and the end user reading the UI's "transcript ready"
 * state) would have no way to tell a fabricated placeholder sentence apart
 * from a real transcription of what they actually said. The Stage E
 * authorisation is explicit on this point: "never silently fall back from
 * mock to live." A misconfigured/unapproved live provider is therefore a
 * loud, typed error (live_provider_disabled / missing_credentials) that
 * routes/aiVoice.ts maps to the UI's own distinct "provider unavailable"
 * state — never a quiet downgrade to mock.
 */
export function buildVoiceTranscriptionProvider(config: VoiceTranscriptionConfig): TranscriptionProvider {
  // WS4-09: AEE_RESTORED_ENVIRONMENT refuses this outbound seam (lib/outboundGuard.ts).
  assertOutboundAllowed("voice_transcription");
  if (providerOverride !== null) return providerOverride;

  if (config.provider === "mock") {
    return new MockTranscriptionProvider();
  }

  if (config.provider === "deepgram") {
    if (mustForceMockVoiceTranscriptionProvider()) {
      logger.warn("voice_transcription_provider_locked_to_mock_pilot_policy", { requestedProvider: config.provider });
      throw new TranscriptionProviderError(
        "deepgram",
        "live_provider_disabled",
        'Live voice transcription is not yet approved for this environment (LIVE_VOICE_TRANSCRIPTION_APPROVED is not set to "true").',
      );
    }
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new TranscriptionProviderError("deepgram", "missing_credentials", "DEEPGRAM_API_KEY is not configured.");
    }
    return new DeepgramTranscriptionProvider(apiKey);
  }

  throw new TranscriptionProviderError(config.provider, "provider_error", `Unknown transcription provider "${config.provider}".`);
}

/**
 * Builds the provider used for recorded call audio (F3 Part B).
 *
 * This intentionally shares the Stage E provider classes and interface, but
 * has its own approval gate. In particular, LIVE_VOICE_TRANSCRIPTION_APPROVED
 * and LIVE_TELEPHONY_APPROVED must never unlock this factory. The gate is
 * checked before the test seam can return a non-mock fake, so tests cannot
 * accidentally create a path that production would not be allowed to use.
 */
export function buildCallTranscriptionProvider(config: VoiceTranscriptionConfig): TranscriptionProvider {
  // WS4-09: AEE_RESTORED_ENVIRONMENT refuses this outbound seam (lib/outboundGuard.ts).
  assertOutboundAllowed("voice_transcription");
  if (config.provider === "mock") {
    // A mock is safe in every environment. A non-mock test seam, however,
    // must not be able to masquerade as the mock without the call approval.
    if (providerOverride !== null && providerOverride.name !== "mock" && mustForceMockCallTranscriptionProvider()) {
      logger.warn("call_transcription_provider_locked_to_mock_pilot_policy", { requestedProvider: config.provider });
      throw new TranscriptionProviderError(
        providerOverride.name,
        "live_provider_disabled",
        'Live call transcription is not approved (LIVE_CALL_TRANSCRIPTION_APPROVED is not set to "true").',
      );
    }
    return providerOverride ?? new MockTranscriptionProvider();
  }

  if (config.provider === "deepgram") {
    // Unlike the Stage E voice-input gate, this is fail-closed in every
    // environment, not only NODE_ENV=production.
    if (mustForceMockCallTranscriptionProvider()) {
      logger.warn("call_transcription_provider_locked_to_mock_pilot_policy", { requestedProvider: config.provider });
      throw new TranscriptionProviderError(
        "deepgram",
        "live_provider_disabled",
        'Live call transcription is not approved (LIVE_CALL_TRANSCRIPTION_APPROVED is not set to "true").',
      );
    }
    // The existing seam remains useful for provider-independent tests, but
    // only after the call-specific approval above has passed.
    if (providerOverride !== null) return providerOverride;

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new TranscriptionProviderError("deepgram", "missing_credentials", "DEEPGRAM_API_KEY is not configured.");
    }
    return new DeepgramTranscriptionProvider(apiKey);
  }

  throw new TranscriptionProviderError(config.provider, "provider_error", `Unknown transcription provider "${config.provider}".`);
}
