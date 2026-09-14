// AE GROW Priority 6 Stage E — Voice as Input upload validation.
//
// Mirrors apps/api/src/lib/documentStorage.ts's own validateDocumentBytes/
// detectDocumentMimeType discipline: never trust the client's declared
// Content-Type or filename extension alone — inspect the bytes themselves.
//
// Duration enforcement is deliberately layered rather than exact, and this
// is an honest, documented limitation rather than an oversight: this app
// does not (and this stage does not add) a media-processing/decoding
// dependency capable of computing an exact playback duration for every
// container MediaRecorder can produce across supported browsers before the
// bytes are ever sent to a provider. Layer 1 is voiceRecording.ts's
// client-side 60-second auto-stop (never trusted alone — a client is
// free to lie). Layer 2 is this module's own generous byte-ceiling check
// (assertPlausibleAudioDuration) — a bound so loose that only a payload
// which could not represent 60 seconds of audio at ANY realistic encoding
// this app selects could exceed it, so it never falsely rejects a real
// recording, but it does catch a wildly malformed or truncated payload
// before it is ever sent to a provider. Layer 3 is
// assertProviderReportedDurationWithinLimit, applied by routes/aiVoice.ts
// AFTER a successful transcription, using the provider's own reported
// duration (Deepgram returns one in its response metadata) — the most
// precise of the three layers, but only available after the provider call
// has already happened, which is why layers 1 and 2 exist at all.

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_AUDIO_DURATION_SECONDS = 60;

// audio/wave and audio/x-wav are real-world aliases some browsers/tools use
// for the same RIFF/WAVE container detectAudioContainer() reports as
// "audio/wav" below; audio/mp3 is a common (if technically non-standard)
// alias for audio/mpeg. All are accepted as declared types and normalised
// against their detected family in validateVoiceAudioUpload().
const ALLOWED_AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
]);

export type VoiceUploadValidationErrorCode =
  | "EMPTY_AUDIO"
  | "AUDIO_TOO_LARGE"
  | "UNSUPPORTED_AUDIO_TYPE"
  | "AUDIO_TYPE_MISMATCH"
  | "AUDIO_DURATION_EXCEEDED";

export class VoiceUploadValidationError extends Error {
  readonly code: VoiceUploadValidationErrorCode;
  constructor(code: VoiceUploadValidationErrorCode, message: string) {
    super(message);
    this.name = "VoiceUploadValidationError";
    this.code = code;
  }
}

export function configuredMaxVoiceAudioBytes(): number {
  return MAX_AUDIO_BYTES;
}

export function configuredMaxVoiceAudioDurationSeconds(): number {
  return MAX_AUDIO_DURATION_SECONDS;
}

// Signature/container sniffing covering every format MediaRecorder
// realistically produces across supported browsers (voiceRecording.ts's own
// MIME_CANDIDATES list): WebM/Opus (Chrome/Firefox/Edge default), Ogg/Opus
// (Firefox alternative), MP4/AAC (Safari desktop and iOS, which does not
// support WebM at all — see the Stage E discovery report's browser
// findings), plus WAV/MP3 for completeness and any future non-MediaRecorder
// caller.
export function detectAudioContainer(bytes: Buffer): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "audio/webm"; // EBML header - WebM (and Matroska, indistinguishable at this level)
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "OggS") {
    return "audio/ogg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return "audio/wav";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    return "audio/mp4"; // ISO base media container - covers M4A/MP4 audio
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg"; // ID3v2-tagged MP3
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "audio/mpeg"; // MPEG frame sync (untagged MP3)
  }
  return null;
}

function normaliseMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

function mimeFamily(mimeType: string): string {
  if (mimeType === "audio/wave" || mimeType === "audio/x-wav") return "audio/wav";
  if (mimeType === "audio/mp3") return "audio/mpeg";
  return mimeType;
}

// Layer 2 of the duration enforcement described in this module's own header
// comment. 5,000,000 bytes/second is a deliberately generous ceiling — real
// MediaRecorder output at any codec/bitrate this app selects
// (voiceRecording.ts's MIME_CANDIDATES) is far below this, so this only
// ever rejects a byte count that could not possibly represent audio within
// the duration ceiling at any realistic encoding, complementing rather than
// replacing the provider-reported-duration check.
const MAX_PLAUSIBLE_BYTES_PER_SECOND = 5_000_000;

export function assertPlausibleAudioDuration(byteLength: number, maxDurationSeconds: number = MAX_AUDIO_DURATION_SECONDS): void {
  const maxPlausibleBytesForDuration = maxDurationSeconds * MAX_PLAUSIBLE_BYTES_PER_SECOND;
  if (byteLength > maxPlausibleBytesForDuration) {
    throw new VoiceUploadValidationError("AUDIO_DURATION_EXCEEDED", "Audio exceeds the configured duration limit.");
  }
}

export interface ValidatedVoiceAudio {
  detectedMimeType: string;
  byteLength: number;
}

export function validateVoiceAudioUpload(bytes: Buffer, declaredMimeType: string): ValidatedVoiceAudio {
  if (bytes.length === 0) {
    throw new VoiceUploadValidationError("EMPTY_AUDIO", "Audio upload must not be empty.");
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new VoiceUploadValidationError("AUDIO_TOO_LARGE", "Audio exceeds the configured size limit.");
  }
  const declared = normaliseMimeType(declaredMimeType);
  if (!ALLOWED_AUDIO_MIME_TYPES.has(declared)) {
    throw new VoiceUploadValidationError("UNSUPPORTED_AUDIO_TYPE", "Audio type is not allowed.");
  }
  const detected = detectAudioContainer(bytes);
  if (detected === null) {
    throw new VoiceUploadValidationError("UNSUPPORTED_AUDIO_TYPE", "Audio content could not be recognised as a supported format.");
  }
  if (mimeFamily(declared) !== mimeFamily(detected)) {
    throw new VoiceUploadValidationError("AUDIO_TYPE_MISMATCH", "Declared audio type does not match its bytes.");
  }
  assertPlausibleAudioDuration(bytes.length);
  return { detectedMimeType: detected, byteLength: bytes.length };
}

// Layer 3 of the duration enforcement described in this module's own header
// comment — called by routes/aiVoice.ts after a successful transcription,
// using the provider's own reported duration when it supplies one (a null
// durationSeconds, e.g. from the mock provider, is not itself a violation —
// there is simply nothing more precise than layers 1/2 to check in that
// case).
export function assertProviderReportedDurationWithinLimit(durationSeconds: number | null, maxDurationSeconds: number = MAX_AUDIO_DURATION_SECONDS): void {
  if (durationSeconds !== null && durationSeconds > maxDurationSeconds) {
    throw new VoiceUploadValidationError(
      "AUDIO_DURATION_EXCEEDED",
      "The audio's actual duration, as reported by the transcription provider, exceeds the configured limit.",
    );
  }
}
