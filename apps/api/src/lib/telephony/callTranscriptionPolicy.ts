/**
 * Shared, provider-neutral policy for recorded-call transcription.
 *
 * Keep these values in this small module: the request path and the stale
 * processing reconciler must agree on both the retry budget and the durable
 * failure vocabulary.  These are deliberately not environment settings.
 */
export const CALL_TRANSCRIPTION_MAX_RETRIES = 3;
export const CALL_TRANSCRIPTION_MAX_TIMEOUT_MS = 120_000;
export const CALL_TRANSCRIPTION_DEFAULT_TIMEOUT_MS = 15_000;
export const CALL_TRANSCRIPTION_STALE_AFTER_MS = 15 * 60 * 1_000;

export type CallTranscriptionFailureReason =
  | "RECORDING_UNAVAILABLE"
  | "RECORDING_DELETED"
  | "TRANSCRIPTION_TIMEOUT"
  | "PROVIDER_ERROR"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "PROCESSING_ABANDONED"
  | "TENANT_MISMATCH"
  | "ACCESS_DENIED"
  | "ENTITLEMENT_REQUIRED"
  | "INVALID_INPUT"
  | "RECORDING_REFERENCE_MISMATCH"
  | "F2_EVIDENCE_MISSING"
  | "F2_EVIDENCE_INVALID"
  | "LIVE_PROVIDER_DISABLED"
  | "MISSING_PROVIDER_CREDENTIALS"
  | "PROVIDER_CONFIGURATION_ERROR"
  | "INVALID_AUDIO"
  | "AUDIT_FAILURE";

export const CALL_TRANSCRIPTION_FAILURE_REASONS = [
  "RECORDING_UNAVAILABLE",
  "RECORDING_DELETED",
  "TRANSCRIPTION_TIMEOUT",
  "PROVIDER_ERROR",
  "MALFORMED_PROVIDER_RESPONSE",
  "PROCESSING_ABANDONED",
  "TENANT_MISMATCH",
  "ACCESS_DENIED",
  "ENTITLEMENT_REQUIRED",
  "INVALID_INPUT",
  "RECORDING_REFERENCE_MISMATCH",
  "F2_EVIDENCE_MISSING",
  "F2_EVIDENCE_INVALID",
  "LIVE_PROVIDER_DISABLED",
  "MISSING_PROVIDER_CREDENTIALS",
  "PROVIDER_CONFIGURATION_ERROR",
  "INVALID_AUDIO",
  "AUDIT_FAILURE",
] as const satisfies readonly CallTranscriptionFailureReason[];

/** Classify untrusted provider/runtime errors without persisting their text. */
export function classifyCallTranscriptionFailure(
  error: unknown,
): CallTranscriptionFailureReason {
  if (typeof error === "string") {
    const value = error.toUpperCase();
    if (value.includes("TIMEOUT") || value.includes("ABORT")) return "TRANSCRIPTION_TIMEOUT";
  }
  if (error && typeof error === "object") {
    const code = "code" in error ? String((error as { code?: unknown }).code).toLowerCase() : "";
    const name = "name" in error ? String((error as { name?: unknown }).name).toLowerCase() : "";
    const message = "message" in error ? String((error as { message?: unknown }).message).toLowerCase() : "";
    if (code === "timeout" || name === "aborterror" || message.includes("timeout") || message.includes("timed out")) {
      return "TRANSCRIPTION_TIMEOUT";
    }
    if (code === "malformed_response" || code === "empty_transcript" || code === "oversized_transcript") {
      return "MALFORMED_PROVIDER_RESPONSE";
    }
    if (code === "live_provider_disabled") return "LIVE_PROVIDER_DISABLED";
    if (code === "missing_credentials") return "MISSING_PROVIDER_CREDENTIALS";
    if (
      code === "empty_audio" ||
      code === "audio_too_large" ||
      code === "unsupported_audio_type" ||
      code === "audio_type_mismatch" ||
      code === "audio_duration_exceeded"
    ) return "INVALID_AUDIO";
    if (message.includes("unknown transcription provider")) return "PROVIDER_CONFIGURATION_ERROR";
  }
  return "PROVIDER_ERROR";
}

export function isRetryableCallTranscriptionFailure(
  reason: CallTranscriptionFailureReason,
): boolean {
  return reason === "TRANSCRIPTION_TIMEOUT" ||
    reason === "PROVIDER_ERROR" ||
    reason === "MALFORMED_PROVIDER_RESPONSE";
}

export function boundedCallTranscriptionTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return CALL_TRANSCRIPTION_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(1, Math.floor(value)), CALL_TRANSCRIPTION_MAX_TIMEOUT_MS);
}

export function callTranscriptionRetryDelayMs(retryCount: number): number {
  // Short, bounded backoff. Tests can set NODE_ENV=test and use this seam.
  const delay = Math.min(250, Math.max(0, retryCount) * 25);
  return process.env.NODE_ENV === "test" ? 0 : delay;
}
