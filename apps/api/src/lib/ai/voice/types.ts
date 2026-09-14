// AE GROW Priority 6 Stage E — Voice as Input.
//
// Provider-neutral transcription abstraction, mirroring
// apps/api/src/lib/ai/providers/provider.ts's AiProvider pattern exactly: a
// small interface plus a deterministic Mock implementation as the safe
// default, selected by an env var (AI_TRANSCRIPTION_PROVIDER=mock|deepgram,
// see .env.example). Swapping in a real provider later never touches
// routes/aiVoice.ts.
//
// Deliberately a SEPARATE set of types from AiProvider/AiProviderRequest/
// AiProviderResponse (../types.ts) — those describe a text-generation call
// (system+user prompt in, generated text out); these describe an audio-in,
// text-out call. Sharing one shape between the two domains would force one
// of them to grow fields that make no sense for the other (there is no
// "system prompt" for transcription, and no "audio duration" for a text
// completion).

export interface TranscriptionRequest {
  /**
   * Raw audio bytes. In memory only for the lifetime of this call — see
   * this module's own "Audio handling" requirement in the Stage E
   * completion report: no implementation of TranscriptionProvider may
   * write these bytes to disk, the database, object storage, or a log
   * line, and the caller (routes/aiVoice.ts) releases its own reference to
   * this buffer as soon as this call settles, success or failure.
   */
  audioBytes: Buffer;
  /**
   * The MIME type the SERVER itself detected from the audio's own bytes
   * (audioValidation.ts's detectAudioContainer) — never the client's
   * declared Content-Type alone.
   */
  mimeType: string;
  /** Bounded request budget in milliseconds; every implementation must honour this. */
  timeoutMs: number;
  /**
   * Opaque per-request correlation id for logs — never audio or transcript
   * content. See routes/aiVoice.ts's own logging, which only ever includes
   * this id alongside byte counts, latency, and a failure category.
   */
  correlationId: string;
}

export interface TranscriptionResponse {
  provider: string;
  transcript: string;
  /**
   * Provider-reported audio duration in seconds, when the provider
   * supplies one — the third, most precise layer of this stage's duration
   * enforcement (see audioValidation.ts's own header comment on why exact
   * duration cannot always be established server-side before provider
   * submission, for every supported container, without a large
   * media-processing dependency this stage deliberately avoids).
   */
  durationSeconds: number | null;
  latencyMs: number;
}

export type TranscriptionProviderErrorCode =
  | "timeout"
  | "provider_error"
  | "malformed_response"
  | "empty_transcript"
  | "oversized_transcript"
  | "live_provider_disabled"
  | "missing_credentials";

export class TranscriptionProviderError extends Error {
  readonly provider: string;
  readonly code: TranscriptionProviderErrorCode;
  constructor(provider: string, code: TranscriptionProviderErrorCode, message: string) {
    super(message);
    this.name = "TranscriptionProviderError";
    this.provider = provider;
    this.code = code;
  }
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse>;
}

// A sanity ceiling on a provider's returned transcript length, distinct
// from (and checked before) routes/aiVoice.ts's own truncation of the
// transcript to fit the existing Ask AE question box (2000 chars, matching
// askSchema's own question.max(2000) in routes/ai.ts). Any real 60-second
// speech transcript tops out at a few hundred words — well under this
// ceiling. This exists purely as a runaway/malformed-response safety net:
// a provider response this large almost certainly indicates a malformed
// or unexpected payload (e.g. a provider echoing something other than a
// transcript), and it is safer to fail loudly with a distinct, observable
// "oversized_transcript" error than to silently truncate something that
// was never a real transcript in the first place.
export const TRANSCRIPT_SANITY_MAX_LENGTH = 20_000;

export function assertTranscriptSizeIsSane(transcript: string, provider: string): void {
  if (transcript.length > TRANSCRIPT_SANITY_MAX_LENGTH) {
    throw new TranscriptionProviderError(provider, "oversized_transcript", "The transcription provider returned an implausibly long transcript.");
  }
}
