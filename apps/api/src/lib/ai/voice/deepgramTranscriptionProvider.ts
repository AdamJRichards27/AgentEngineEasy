import type { TranscriptionProvider, TranscriptionRequest, TranscriptionResponse } from "./types.js";
import { TranscriptionProviderError } from "./types.js";

// AE GROW Priority 6 Stage E — real provider, inactive until
// AI_TRANSCRIPTION_PROVIDER=deepgram, DEEPGRAM_API_KEY, and
// LIVE_VOICE_TRANSCRIPTION_APPROVED=true are ALL set (see gateway.ts's
// buildVoiceTranscriptionProvider() — this class is never constructed
// otherwise). Talks to Deepgram's pre-recorded transcription API directly
// over fetch, mirroring apps/api/src/lib/ai/providers/anthropicProvider.ts's
// own "no new runtime dependency, swap for an official SDK later if
// needed" approach.
//
// Fixed Australian (Sydney) endpoint, hardcoded here rather than read from
// an environment variable or accepted from any caller — the Stage E
// authorisation is explicit: "Use a fixed, server-controlled Australian
// endpoint. Do not accept a provider URL, API key, model, region or
// routing instruction from the client," and "Never silently fall back ...
// from an Australian endpoint to an overseas endpoint." There is
// deliberately no code path in this class that can reach any other
// Deepgram region. Region confirmed against Deepgram's own documentation
// during Stage E discovery (api.au.deepgram.com, AWS ap-southeast-2,
// "storage and inference for your audio, transcripts, and speech output
// happen in Australia") — see the Stage E completion report for the
// citation and date verified.
const DEEPGRAM_AU_TRANSCRIBE_ENDPOINT = "https://api.au.deepgram.com/v1/listen";

// mip_opt_out=true opts this brokerage's audio out of Deepgram's Model
// Improvement Partnership Program (i.e. out of being used to train
// Deepgram's own models) for every request, regardless of any account-level
// default — see the Stage E completion report's privacy/data-flow section
// for the citation. punctuate=true is a plain transcription-quality option,
// not a privacy-relevant one.
const DEEPGRAM_QUERY = "model=nova-2&punctuate=true&mip_opt_out=true";

interface DeepgramResponseShape {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: unknown }>;
    }>;
  };
  metadata?: { duration?: unknown };
}

function parseDeepgramResponse(json: unknown): { transcript: string; durationSeconds: number | null } | null {
  if (typeof json !== "object" || json === null) return null;
  const shape = json as DeepgramResponseShape;
  const transcript = shape.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  if (typeof transcript !== "string") return null;
  const durationRaw = shape.metadata?.duration;
  const durationSeconds = typeof durationRaw === "number" && Number.isFinite(durationRaw) ? durationRaw : null;
  return { transcript, durationSeconds };
}

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = "deepgram";
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const res = await fetch(`${DEEPGRAM_AU_TRANSCRIBE_ENDPOINT}?${DEEPGRAM_QUERY}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": request.mimeType,
          authorization: `Token ${this.apiKey}`,
        },
        body: request.audioBytes,
      });
      if (res.ok === false) {
        const body = await res.text().catch(() => "");
        throw new TranscriptionProviderError("deepgram", "provider_error", `Deepgram API returned ${res.status}: ${body.slice(0, 300)}`);
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new TranscriptionProviderError("deepgram", "malformed_response", "Deepgram returned a non-JSON response.");
      }
      const parsed = parseDeepgramResponse(json);
      if (parsed === null) {
        throw new TranscriptionProviderError("deepgram", "malformed_response", "Deepgram response did not contain a recognisable transcript.");
      }
      return {
        provider: this.name,
        transcript: parsed.transcript,
        durationSeconds: parsed.durationSeconds,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      if (err instanceof TranscriptionProviderError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new TranscriptionProviderError("deepgram", "timeout", "Deepgram did not respond within the configured timeout.");
      }
      const message = err instanceof Error ? err.message : "unknown error";
      throw new TranscriptionProviderError("deepgram", "provider_error", `Deepgram provider call failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
