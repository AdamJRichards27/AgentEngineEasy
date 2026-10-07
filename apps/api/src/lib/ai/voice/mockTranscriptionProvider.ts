import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResponse } from "./types.js";
import { TranscriptionProviderError } from "./types.js";

// AE GROW Priority 6 Stage E — the default provider until a real Deepgram
// configuration is intentionally supplied (see gateway.ts's fail-closed
// selection). Deterministic, offline, free, and makes no network call of
// any kind — safe to run in this build, in every test, and in CI. It does
// not call a real speech model. The transcript names only a non-sensitive
// property of the input (byte length and detected MIME type — never the
// audio's own content, which this provider never inspects beyond checking
// it is non-empty), so the rest of the pipeline (validation, entitlement,
// rate limiting, the web UI's transcript-ready state) is fully exercisable
// end-to-end without a live provider or any network I/O. The text mock
// (providers/mockProvider.ts) does not copy its request into its narrative.
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mock";

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const start = Date.now();
    if (request.audioBytes.length === 0) {
      // Real callers can never reach this: routes/aiVoice.ts's
      // audioValidation.ts rejects an empty upload before any provider is
      // ever constructed. Kept as a defence-in-depth check (and a
      // deterministic way for provider-level tests to exercise this
      // provider's own "empty_transcript" mapping without going through
      // the HTTP route) rather than assuming the caller always validates
      // first.
      throw new TranscriptionProviderError("mock", "empty_transcript", "No audio data was received.");
    }
    const transcript =
      `This is a mock transcription of a ${request.audioBytes.length}-byte ${request.mimeType} audio clip. ` +
      'Set AI_TRANSCRIPTION_PROVIDER=deepgram and the required Deepgram configuration to use a real provider.';
    return {
      provider: this.name,
      transcript,
      durationSeconds: null,
      latencyMs: Date.now() - start,
    };
  }
}
