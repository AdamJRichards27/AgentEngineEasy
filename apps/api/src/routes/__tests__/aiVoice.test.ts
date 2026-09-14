// AE GROW Priority 6 Stage E — HTTP-level regression coverage for
// POST /api/ai/voice/transcribe. Follows the same real-app, real-HTTP-
// request pattern as routes/__tests__/growAskAe.test.ts (spins up the real
// app via createApp(), a real session cookie, real entitlement grants), so
// this exercises the exact same request path a real client hits —
// multipart upload parsing, requireAuth, the entitlement gate (mirroring
// askCopilot()'s own), the dedicated voice rate limiter/concurrency guard,
// upload validation, and provider-error mapping, all together — not just
// each module in isolation (see lib/ai/voice/__tests__/*.test.ts for that
// unit-level coverage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, aiInteractions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";
import { setVoiceTranscriptionProviderForTests } from "../../lib/ai/voice/gateway.js";
import { _resetVoiceRateLimiterForTests } from "../../lib/ai/voice/voiceRateLimiter.js";
import { TranscriptionProviderError } from "../../lib/ai/voice/types.js";
import type {
  TranscriptionProvider,
  TranscriptionProviderErrorCode,
  TranscriptionResponse,
} from "../../lib/ai/voice/types.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
// Business Coach voice tests below need this role enabled at all — without
// it every coach-mode request would 403 with "currently disabled", never
// reaching the entitlement checks this file actually means to exercise.
process.env.AI_BUSINESS_COACH_ENABLED = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

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
  _resetVoiceRateLimiterForTests();
});

after(async () => {
  setVoiceTranscriptionProviderForTests(null);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
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

async function countAiInteractions(brokerageId: number): Promise<number> {
  const rows = await db.select({ id: aiInteractions.id }).from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerageId));
  return rows.length;
}

// A minimal but genuinely signature-valid WAV buffer — long enough that
// mock-provider/validation behaviour is exercised realistically, short
// enough to keep these tests fast. Never real speech; the mock provider
// (the default provider for every test that doesn't explicitly override
// it) never inspects content beyond byte length.
function wavBytes(paddingLength = 2000): Buffer {
  const riff = Buffer.from("RIFF", "ascii");
  const size = Buffer.alloc(4);
  const wave = Buffer.from("WAVE", "ascii");
  return Buffer.concat([riff, size, wave, Buffer.alloc(paddingLength, 0x00)]);
}

function webmBytes(paddingLength = 2000): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(paddingLength, 0x00)]);
}

async function uploadAudio(
  cookie: string | undefined,
  bytes: Buffer,
  mimeType: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  form.set("audio", new Blob([bytes], { type: mimeType }), "recording.wav");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return fetch(`${baseUrl}/api/ai/voice/transcribe`, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
}

function throwingProvider(code: TranscriptionProviderErrorCode): TranscriptionProvider {
  return {
    name: "fake-throwing-provider",
    async transcribe(): Promise<TranscriptionResponse> {
      throw new TranscriptionProviderError("fake-throwing-provider", code, `test fixture for code ${code}`);
    },
  };
}

function resultProvider(build: () => TranscriptionResponse, delayMs = 0): TranscriptionProvider {
  return {
    name: "fake-result-provider",
    async transcribe(): Promise<TranscriptionResponse> {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return build();
    },
  };
}

test("POST /api/ai/voice/transcribe requires authentication", async () => {
  const res = await uploadAudio(undefined, wavBytes(), "audio/wav");
  assert.equal(res.status, 401);
});

test("POST /api/ai/voice/transcribe rejects a request with no audio part at all", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route No File ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const form = new FormData();
    form.set("mode", "ask");
    const res = await fetch(`${baseUrl}/api/ai/voice/transcribe`, { method: "POST", headers: { cookie: fresh.agent.cookie }, body: form });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /audio file is required/i);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe is refused with 403 for a STARTER brokerage (no grow.access), for both ask and coach mode", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Starter ${suffix}`);
  try {
    const askRes = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(askRes.status, 403);
    const askBody = (await askRes.json()) as { error: string };
    assert.match(askBody.error, /Grow or Pro plan/);

    const coachRes = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "coach" });
    assert.equal(coachRes.status, 403);
    const coachBody = (await coachRes.json()) as { error: string };
    assert.match(coachBody.error, /Business Coach/);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe succeeds for an entitled GROW-tier brokerage, for both ask and coach mode, and returns only { transcript }", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Grow Entitled ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");

    const askRes = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(askRes.status, 200);
    const askBody = (await askRes.json()) as { transcript: string };
    assert.equal(typeof askBody.transcript, "string");
    assert.ok(askBody.transcript.includes("mock transcription"));
    assert.deepEqual(Object.keys(askBody), ["transcript"]);

    const coachRes = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "coach" });
    assert.equal(coachRes.status, 200);
    const coachBody = (await coachRes.json()) as { transcript: string };
    assert.equal(typeof coachBody.transcript, "string");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe succeeds for a genuine PRO subscription (grow.access + run.access)", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Pro Entitled ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "run.access");
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 200);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe defaults mode to ask when omitted, exactly like askSchema", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Default Mode ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav");
    assert.equal(res.status, 200);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects an attempt to inject an extra multipart field (e.g. brokerageId) — the route accepts exactly one non-file field (mode), so no client-supplied identity/role/brokerage override can even be parsed", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route No Override ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask", brokerageId: "999999" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "AUDIO_UPLOAD_LIMIT");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects a declared type outside the allowlist with 400 UNSUPPORTED_AUDIO_TYPE", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Bad Mime ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "video/mp4", { mode: "ask" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "UNSUPPORTED_AUDIO_TYPE");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects a declared type that does not match the audio's own bytes with 400 AUDIO_TYPE_MISMATCH", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Mime Mismatch ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    // WebM signature bytes, declared as audio/wav.
    const res = await uploadAudio(fresh.agent.cookie, webmBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "AUDIO_TYPE_MISMATCH");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects an empty (zero-byte) audio upload with 400 EMPTY_AUDIO", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Empty Audio ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await uploadAudio(fresh.agent.cookie, Buffer.alloc(0), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "EMPTY_AUDIO");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects an upload larger than the configured size ceiling with 413 AUDIO_TOO_LARGE", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Oversized ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 0x41);
    const res = await uploadAudio(fresh.agent.cookie, oversized, "audio/wav", { mode: "ask" });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "AUDIO_TOO_LARGE");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe enforces the provider-reported duration limit (Layer 3) with 400 AUDIO_DURATION_EXCEEDED", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Duration Exceeded ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    setVoiceTranscriptionProviderForTests(
      resultProvider(() => ({ provider: "fake", transcript: "hello", durationSeconds: 61, latencyMs: 1 })),
    );
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "AUDIO_DURATION_EXCEEDED");
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe returns 422 when the provider's transcript is empty/whitespace-only after trimming", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Blank Transcript ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    setVoiceTranscriptionProviderForTests(
      resultProvider(() => ({ provider: "fake", transcript: "   ", durationSeconds: null, latencyMs: 1 })),
    );
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 422);
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe truncates an overlong-but-plausible transcript to the same 2000-char ceiling as askSchema.question", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Truncation ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const longTranscript = "a".repeat(2500);
    setVoiceTranscriptionProviderForTests(
      resultProvider(() => ({ provider: "fake", transcript: longTranscript, durationSeconds: null, latencyMs: 1 })),
    );
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { transcript: string };
    assert.equal(body.transcript.length, 2000);
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects an implausibly long (>20000 char) provider response with 502, before truncation", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Sanity Ceiling ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    setVoiceTranscriptionProviderForTests(
      resultProvider(() => ({ provider: "fake", transcript: "a".repeat(20001), durationSeconds: null, latencyMs: 1 })),
    );
    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 502);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "oversized_transcript");
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe maps every TranscriptionProviderError code to a distinct, safe HTTP status", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Provider Errors ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const cases: Array<[TranscriptionProviderErrorCode, number]> = [
      ["timeout", 504],
      ["provider_error", 502],
      ["malformed_response", 502],
      ["missing_credentials", 503],
      ["live_provider_disabled", 503],
      ["empty_transcript", 422],
    ];
    for (const [code, expectedStatus] of cases) {
      setVoiceTranscriptionProviderForTests(throwingProvider(code));
      const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
      assert.equal(res.status, expectedStatus, `code ${code} should map to ${expectedStatus}`);
    }
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe enforces the per-user hourly rate limit end to end: a single agent's 9th attempted request within the window is refused with 429", async () => {
  // voiceRateLimiter.test.ts already unit-tests both the per-brokerage (20)
  // and per-user (8) ceilings in isolation with distinct synthetic ids.
  // This HTTP-level test's job is different: prove the real route actually
  // wires assertVoiceRateLimit(brokerageId, userId) into a real request and
  // produces a real 429 — exercised via the per-user ceiling (8) since a
  // single authenticated agent's own repeated requests hit that tighter
  // ceiling before the shared per-brokerage one (20).
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Rate Limit ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    let lastStatus = 0;
    for (let i = 0; i < 9; i++) {
      const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
      lastStatus = res.status;
      if (i < 8) {
        assert.equal(res.status, 200, `request #${i} (within the 8-per-hour per-user cap) must succeed`);
      }
    }
    assert.equal(lastStatus, 429, "the 9th request from the same user within the same window must be refused with 429, not silently served or 500'd");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe rejects a second concurrent request from the same user while the first is still in flight, with 429", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route Concurrency ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    setVoiceTranscriptionProviderForTests(
      resultProvider(() => ({ provider: "fake", transcript: "concurrent fixture", durationSeconds: null, latencyMs: 1 }), 150),
    );
    const [first, second] = await Promise.all([
      uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" }),
      uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 429], "exactly one of the two concurrent requests must be accepted, the other rejected with 429");
  } finally {
    setVoiceTranscriptionProviderForTests(null);
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe never creates an aiInteractions row and never itself calls POST /api/ai/ask", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Voice Route No Side Effects ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const before = await countAiInteractions(fresh.brokerageId);

    const res = await uploadAudio(fresh.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { transcript: string };
    assert.ok(body.transcript.length > 0);

    const after = await countAiInteractions(fresh.brokerageId);
    assert.equal(after, before, "transcription alone must not write an aiInteractions row — only a subsequent, human-initiated POST /api/ai/ask would");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/voice/transcribe never leaks one brokerage's entitlement into another brokerage's request", async () => {
  const A = await createBrokerageWithUsers(baseUrl, `Voice Route Cross Tenant A ${suffix}`);
  const B = await createBrokerageWithUsers(baseUrl, `Voice Route Cross Tenant B ${suffix}`);
  try {
    await grant(A.brokerageId, "grow.access");
    // B is deliberately left as STARTER (no grants).

    const resA = await uploadAudio(A.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(resA.status, 200);

    const resB = await uploadAudio(B.agent.cookie, wavBytes(), "audio/wav", { mode: "ask" });
    assert.equal(resB.status, 403, "B's own (STARTER) tier must govern B's request — A's entitlement grant must never leak across brokerages");
  } finally {
    await cleanupBrokerages([A.brokerageId, B.brokerageId]);
  }
});
