// AE GROW C-10 — voice transcription metrics on POST /api/ai/voice/transcribe.
// Only requests that reach provider.transcribe are counted. A refusal before
// that call (entitlement, upload validation) leaves the series untouched.
// The provider is the existing test seam, named "mock", so live Deepgram
// stays off and no credential is read.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";
import { setVoiceTranscriptionProviderForTests } from "../../lib/ai/voice/gateway.js";
import { _resetVoiceRateLimiterForTests } from "../../lib/ai/voice/voiceRateLimiter.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../../lib/ai/voice/types.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let transcribeCalls = 0;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  setVoiceTranscriptionProviderForTests(null);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetMetricsForTesting();
  _resetVoiceRateLimiterForTests();
  transcribeCalls = 0;
  setVoiceTranscriptionProviderForTests(null);
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function wavBytes(): Buffer {
  const riff = Buffer.from("RIFF", "ascii");
  const size = Buffer.alloc(4);
  const wave = Buffer.from("WAVE", "ascii");
  return Buffer.concat([riff, size, wave, Buffer.alloc(2000, 0x00)]);
}

async function uploadAudio(cookie: string, bytes: Buffer, mimeType: string): Promise<Response> {
  const form = new FormData();
  form.set("audio", new Blob([bytes], { type: mimeType }), "recording.wav");
  form.set("mode", "ask");
  return fetch(`${baseUrl}/api/ai/voice/transcribe`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

function countingMock(durationSeconds: number): TranscriptionProvider {
  return {
    name: "mock",
    async transcribe(): Promise<TranscriptionResponse> {
      transcribeCalls += 1;
      return {
        provider: "mock",
        transcript: "hello from the mock transcription",
        durationSeconds,
        latencyMs: 1,
      };
    },
  };
}

function assertNoVoiceProviderSeries(text: string): void {
  assert.doesNotMatch(text, /voice_transcription_total\{/);
  assert.doesNotMatch(text, /voice_transcription_duration_ms_count\{/);
  assert.doesNotMatch(text, /voice_transcription_audio_seconds_total\{/);
}

test("a successful mock voice transcription increments the count, duration, and audio-seconds series", async () => {
  setVoiceTranscriptionProviderForTests(countingMock(8));
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Metrics Success ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { transcript: string };
    assert.match(body.transcript, /mock transcription/);
    assert.equal(transcribeCalls, 1);

    const text = renderMetricsText();
    assert.match(text, /voice_transcription_total\{provider="mock",outcome="success"\} 1/);
    assert.match(text, /voice_transcription_duration_ms_count\{provider="mock",outcome="success"\} 1/);
    assert.match(text, /voice_transcription_duration_ms_sum\{provider="mock",outcome="success"\} \d+/);
    assert.match(text, /# TYPE voice_transcription_duration_ms summary/);
    assert.match(text, /voice_transcription_audio_seconds_total\{provider="mock"\} 8/);
    assert.doesNotMatch(text, /outcome="provider_error"|outcome="empty_transcript"|outcome="rejected_after_provider"/);
    assert.doesNotMatch(text, /brokerageId=|userId=|correlationId=|provider="deepgram"/);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("an entitlement refusal before the provider records no voice transcription call", async () => {
  setVoiceTranscriptionProviderForTests(countingMock(8));
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Metrics Entitlement ${suffix}`);
  try {
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav");
    assert.equal(res.status, 403);
    assert.equal(transcribeCalls, 0);
    assertNoVoiceProviderSeries(renderMetricsText());
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("an upload rejected before the provider records no voice transcription call", async () => {
  setVoiceTranscriptionProviderForTests(countingMock(8));
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Metrics Upload ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    const res = await uploadAudio(fresh.agent.cookie, Buffer.from("not-audio"), "audio/wav");
    assert.equal(res.status, 400);
    assert.equal(transcribeCalls, 0);
    assertNoVoiceProviderSeries(renderMetricsText());
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});
