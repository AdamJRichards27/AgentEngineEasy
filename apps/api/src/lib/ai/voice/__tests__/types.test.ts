// AE GROW Priority 6 Stage E — direct boundary-condition coverage for
// assertTranscriptSizeIsSane (the runaway/malformed-response sanity net
// described in voice/types.ts's own header comment on TRANSCRIPT_SANITY_MAX_LENGTH).
// Every other numeric boundary this stage introduced
// (assertPlausibleAudioDuration and assertProviderReportedDurationWithinLimit
// in audioValidation.test.ts) already has this same "exactly at the ceiling
// passes, one character/byte over it throws" unit test; this file closes
// the one remaining case that was previously only exercised indirectly,
// through routes/__tests__/aiVoice.test.ts's HTTP-level "rejects an
// implausibly long (>20000 char) provider response" test. That HTTP-level
// test stays as the real end-to-end proof the route wires this check in
// correctly; this file's job is the narrower one of proving the boundary
// itself is exactly where it's documented to be, independent of the route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTranscriptSizeIsSane, TranscriptionProviderError, TRANSCRIPT_SANITY_MAX_LENGTH } from "../types.js";

test("TRANSCRIPT_SANITY_MAX_LENGTH is the documented 20,000 character ceiling", () => {
  assert.equal(TRANSCRIPT_SANITY_MAX_LENGTH, 20_000);
});

test("assertTranscriptSizeIsSane accepts a transcript well under the ceiling", () => {
  assert.doesNotThrow(() => assertTranscriptSizeIsSane("a short, entirely realistic transcript", "mock"));
});

test("assertTranscriptSizeIsSane accepts an empty string (that is a separate, already-handled case elsewhere, not this function's concern)", () => {
  assert.doesNotThrow(() => assertTranscriptSizeIsSane("", "mock"));
});

test("assertTranscriptSizeIsSane accepts a transcript exactly at the ceiling", () => {
  assert.doesNotThrow(() => assertTranscriptSizeIsSane("a".repeat(TRANSCRIPT_SANITY_MAX_LENGTH), "mock"));
});

test("assertTranscriptSizeIsSane rejects a transcript one character over the ceiling with a typed oversized_transcript error naming the provider", () => {
  assert.throws(
    () => assertTranscriptSizeIsSane("a".repeat(TRANSCRIPT_SANITY_MAX_LENGTH + 1), "deepgram"),
    (err: unknown) =>
      err instanceof TranscriptionProviderError && err.code === "oversized_transcript" && err.provider === "deepgram",
  );
});
