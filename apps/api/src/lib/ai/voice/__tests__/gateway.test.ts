import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadVoiceTranscriptionConfig,
  buildVoiceTranscriptionProvider,
  setVoiceTranscriptionProviderForTests,
} from "../gateway.js";
import { MockTranscriptionProvider } from "../mockTranscriptionProvider.js";
import { DeepgramTranscriptionProvider } from "../deepgramTranscriptionProvider.js";
import { TranscriptionProviderError } from "../types.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../types.js";

const ENV_KEYS = [
  "NODE_ENV",
  "AI_TRANSCRIPTION_PROVIDER",
  "AI_TRANSCRIPTION_TIMEOUT_MS",
  "DEEPGRAM_API_KEY",
  "LIVE_VOICE_TRANSCRIPTION_APPROVED",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) snapshot[key] = process.env[key];
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

test("loadVoiceTranscriptionConfig defaults to the mock provider and a 15s timeout when unconfigured", () => {
  const snapshot = snapshotEnv();
  try {
    delete process.env.AI_TRANSCRIPTION_PROVIDER;
    delete process.env.AI_TRANSCRIPTION_TIMEOUT_MS;
    const config = loadVoiceTranscriptionConfig();
    assert.equal(config.provider, "mock");
    assert.equal(config.timeoutMs, 15_000);
  } finally {
    restoreEnv(snapshot);
  }
});

test("loadVoiceTranscriptionConfig honours explicit provider and timeout env vars", () => {
  const snapshot = snapshotEnv();
  try {
    process.env.AI_TRANSCRIPTION_PROVIDER = "deepgram";
    process.env.AI_TRANSCRIPTION_TIMEOUT_MS = "9000";
    const config = loadVoiceTranscriptionConfig();
    assert.equal(config.provider, "deepgram");
    assert.equal(config.timeoutMs, 9000);
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildVoiceTranscriptionProvider returns a MockTranscriptionProvider for provider: mock", () => {
  const provider = buildVoiceTranscriptionProvider({ provider: "mock", timeoutMs: 5000 });
  assert.ok(provider instanceof MockTranscriptionProvider);
  assert.equal(provider.name, "mock");
});

test("buildVoiceTranscriptionProvider throws missing_credentials for deepgram with no API key configured (non-production)", () => {
  const snapshot = snapshotEnv();
  try {
    process.env.NODE_ENV = "test";
    delete process.env.DEEPGRAM_API_KEY;
    delete process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED;
    assert.throws(
      () => buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 5000 }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "missing_credentials",
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildVoiceTranscriptionProvider throws live_provider_disabled in production when live voice transcription is not approved, even with a credential present", () => {
  const snapshot = snapshotEnv();
  try {
    process.env.NODE_ENV = "production";
    process.env.DEEPGRAM_API_KEY = "a-real-looking-key";
    delete process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED;
    assert.throws(
      () => buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 5000 }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "live_provider_disabled",
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildVoiceTranscriptionProvider throws live_provider_disabled in production even when LIVE_VOICE_TRANSCRIPTION_APPROVED is a truthy-looking but non-'true' value", () => {
  const snapshot = snapshotEnv();
  try {
    process.env.NODE_ENV = "production";
    process.env.DEEPGRAM_API_KEY = "a-real-looking-key";
    process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED = "1";
    assert.throws(
      () => buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 5000 }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "live_provider_disabled",
    );
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildVoiceTranscriptionProvider constructs a live DeepgramTranscriptionProvider once production, an API key, and explicit approval are all present", () => {
  const snapshot = snapshotEnv();
  try {
    process.env.NODE_ENV = "production";
    process.env.DEEPGRAM_API_KEY = "a-real-looking-key";
    process.env.LIVE_VOICE_TRANSCRIPTION_APPROVED = "true";
    const provider = buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 5000 });
    assert.ok(provider instanceof DeepgramTranscriptionProvider);
    assert.equal(provider.name, "deepgram");
  } finally {
    restoreEnv(snapshot);
  }
});

test("buildVoiceTranscriptionProvider throws a typed provider_error for an unknown provider name", () => {
  assert.throws(
    () => buildVoiceTranscriptionProvider({ provider: "some-unsupported-provider", timeoutMs: 5000 }),
    (err: unknown) => err instanceof TranscriptionProviderError && err.code === "provider_error",
  );
});

test("setVoiceTranscriptionProviderForTests overrides selection regardless of provider config, and is reset afterwards", async () => {
  const fake: TranscriptionProvider = {
    name: "fake-for-test",
    async transcribe(): Promise<TranscriptionResponse> {
      return { provider: "fake-for-test", transcript: "fake", durationSeconds: null, latencyMs: 1 };
    },
  };
  try {
    setVoiceTranscriptionProviderForTests(fake);
    const provider = buildVoiceTranscriptionProvider({ provider: "deepgram", timeoutMs: 5000 });
    assert.equal(provider, fake);
  } finally {
    setVoiceTranscriptionProviderForTests(null);
  }
  // Override cleared: normal fail-closed selection resumes.
  const mockProvider = buildVoiceTranscriptionProvider({ provider: "mock", timeoutMs: 5000 });
  assert.ok(mockProvider instanceof MockTranscriptionProvider);
});
