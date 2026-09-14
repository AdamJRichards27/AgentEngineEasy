import { test } from "node:test";
import assert from "node:assert/strict";
import { MockTranscriptionProvider } from "../mockTranscriptionProvider.js";
import { TranscriptionProviderError } from "../types.js";

test("mock provider deterministically succeeds for real audio bytes, with no network activity", async () => {
  const provider = new MockTranscriptionProvider();
  const bytes = Buffer.from("fake-webm-bytes-for-testing");
  const result = await provider.transcribe({
    audioBytes: bytes,
    mimeType: "audio/webm",
    timeoutMs: 5000,
    correlationId: "test-correlation-1",
  });
  assert.equal(result.provider, "mock");
  assert.equal(typeof result.transcript, "string");
  assert.ok(result.transcript.includes(String(bytes.length)));
  assert.ok(result.transcript.includes("audio/webm"));
  assert.equal(result.durationSeconds, null);
  assert.equal(typeof result.latencyMs, "number");
});

test("mock provider is deterministic across repeated calls with the same input", async () => {
  const provider = new MockTranscriptionProvider();
  const bytes = Buffer.from("identical-bytes");
  const first = await provider.transcribe({ audioBytes: bytes, mimeType: "audio/wav", timeoutMs: 5000, correlationId: "a" });
  const second = await provider.transcribe({ audioBytes: bytes, mimeType: "audio/wav", timeoutMs: 5000, correlationId: "b" });
  assert.equal(first.transcript, second.transcript);
});

test("mock provider rejects an empty audio buffer with a typed empty_transcript error", async () => {
  const provider = new MockTranscriptionProvider();
  await assert.rejects(
    () => provider.transcribe({ audioBytes: Buffer.alloc(0), mimeType: "audio/webm", timeoutMs: 5000, correlationId: "empty" }),
    (err: unknown) => err instanceof TranscriptionProviderError && err.code === "empty_transcript",
  );
});
