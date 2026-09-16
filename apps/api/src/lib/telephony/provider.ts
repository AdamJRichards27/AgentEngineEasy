// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §10 — provider-neutral TelephonyProvider interface, mirroring
// apps/api/src/lib/ai/voice/types.ts's TranscriptionProvider pattern
// exactly: a small interface plus a deterministic mock/sandbox
// implementation as the only thing F1 actually constructs (see
// sandboxProvider.ts). Nothing in this file, or anything that consumes
// it, locks AE to a specific vendor (Twilio/Plivo/Vonage/Amazon Connect/
// MessageMedia/Sinch) — see the Stage F1 completion report's provider
// decision memo for the vendor comparison itself, which is informational
// only and implements nothing.

export interface TelephonyDialRequest {
  callSessionId: number;
  brokerageId: number;
  /** E.164 — the exact number this call session resolved to dial. */
  destinationE164: string;
}

export interface TelephonyDialResult {
  providerCallId: string;
}

/**
 * Provider-neutral capability metadata.  Capabilities describe what the
 * active adapter can do; they do not activate a live provider or grant
 * permission to use the capability.  Recording remains separately gated by
 * policy, consent, entitlement, and operational approval.
 */
export interface TelephonyProviderCapabilities {
  recording: boolean;
  transcription: boolean;
}

export interface TelephonyProvider {
  readonly name: string;
  readonly capabilities: TelephonyProviderCapabilities;
  /**
   * Requests that a call be placed. A real provider implementation would
   * make an outbound API call here; F1 defines no such implementation —
   * see sandboxProvider.ts's own header comment for why SandboxTelephonyProvider
   * is the ONLY implementation this stage constructs.
   */
  dial(request: TelephonyDialRequest): Promise<TelephonyDialResult>;
}

export type TelephonyProviderErrorCode = "provider_error" | "live_provider_disabled" | "missing_credentials";

export class TelephonyProviderError extends Error {
  readonly provider: string;
  readonly code: TelephonyProviderErrorCode;
  constructor(provider: string, code: TelephonyProviderErrorCode, message: string) {
    super(message);
    this.name = "TelephonyProviderError";
    this.provider = provider;
    this.code = code;
  }
}
