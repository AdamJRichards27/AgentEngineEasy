// AE GROW Pilot Readiness WP1 — HTTP-level coverage for:
//   P1-3: the durable per-brokerage daily AI request cap
//         (TIER_CAPABILITIES.maxAiRequestsPerDay, lib/ai/dailyUsage.ts),
//         enforced before any provider call on POST /api/ai/ask (RUN Copilot,
//         Grow Ask AE, Business Coach) and POST /api/ai/voice/transcribe.
//   P2-2: grow.ai.use is required for Grow-scoped Ask AE / Business Coach and
//         for voice, while non-Grow RUN Copilot is unaffected.
//
// Same real-app / real-HTTP / real-Postgres pattern as growAskAe.test.ts and
// aiVoice.test.ts. "No provider call" is proven with a counter on the mock AI
// provider (MockAiProvider.prototype.generate) and a counting transcription
// provider injected via setVoiceTranscriptionProviderForTests. Usage for
// "today" is seeded directly as ai_interactions rows — the same durable
// records the cap counts.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, aiInteractions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { resolveBrokerageTier, TIER_CAPABILITIES } from "../../lib/ai/entitlements.js";
import { countBrokerageAiRequestsToday } from "../../lib/ai/dailyUsage.js";
import { MockAiProvider } from "../../lib/ai/providers/mockProvider.js";
import { _resetGrowRateLimiterForTests } from "../../lib/ai/growRateLimiter.js";
import { setVoiceTranscriptionProviderForTests } from "../../lib/ai/voice/gateway.js";
import { _resetVoiceRateLimiterForTests } from "../../lib/ai/voice/voiceRateLimiter.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../../lib/ai/voice/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AI_BUSINESS_COACH_ENABLED = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const cleanupIds: number[] = [];

// Counts every call that actually reaches the (mock) AI provider.
let providerCalls = 0;
const originalGenerate = MockAiProvider.prototype.generate;

// Counts every call that actually reaches the transcription provider.
let transcriptionCalls = 0;
const countingTranscriptionProvider: TranscriptionProvider = {
  name: "counting-mock",
  async transcribe(): Promise<TranscriptionResponse> {
    transcriptionCalls += 1;
    return { transcript: "counted mock transcription", provider: "counting-mock", durationSeconds: 1, latencyMs: 1 };
  },
};

// The cap only fires when it is enforced (see isDailyAiCapEnforced): by default
// that means "a real AI provider is approved", which the pilot's mock provider
// is not. These tests are about the cap itself, so they turn it on explicitly.
const previousCapEnforced = process.env.AI_DAILY_CAP_ENFORCED;

before(async () => {
  process.env.AI_DAILY_CAP_ENFORCED = "true";
  MockAiProvider.prototype.generate = async function (this: MockAiProvider, request) {
    providerCalls += 1;
    return originalGenerate.call(this, request);
  };
  setVoiceTranscriptionProviderForTests(countingTranscriptionProvider);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  _resetGrowRateLimiterForTests();
  _resetVoiceRateLimiterForTests();
});

after(async () => {
  if (previousCapEnforced === undefined) delete process.env.AI_DAILY_CAP_ENFORCED;
  else process.env.AI_DAILY_CAP_ENFORCED = previousCapEnforced;
  MockAiProvider.prototype.generate = originalGenerate;
  setVoiceTranscriptionProviderForTests(null);
  await cleanupBrokerages(cleanupIds);
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

async function newBrokerage(label: string): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
  const b = await createBrokerageWithUsers(baseUrl, `WP1 AI Cap ${label} ${suffix}`);
  cleanupIds.push(b.brokerageId);
  return b;
}

/** Seeds `n` ai_interactions rows for today (or at `createdAt`) with the given status. */
async function seedInteractions(
  brokerageId: number,
  userId: number,
  n: number,
  status: "success" | "error" | "blocked_flag" | "blocked_entitlement" = "success",
  createdAt?: Date,
) {
  if (n <= 0) return;
  await db.insert(aiInteractions).values(
    Array.from({ length: n }, () => ({
      requestId: randomUUID(),
      brokerageId,
      userId,
      aiRole: "copilot",
      riskLevel: 0,
      status,
      ...(createdAt ? { createdAt } : {}),
    })),
  );
}

async function limitFor(brokerageId: number): Promise<number> {
  return TIER_CAPABILITIES[await resolveBrokerageTier(brokerageId)].maxAiRequestsPerDay;
}

function ask(cookie: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/ai/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ question: "How am I tracking?", contextId: null, ...body }),
  });
}

function wavBytes(paddingLength = 2000): Buffer {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii"), Buffer.alloc(paddingLength, 0x00)]);
}

function uploadAudio(cookie: string, mode: "ask" | "coach" = "ask") {
  const form = new FormData();
  form.set("audio", new Blob([wavBytes()], { type: "audio/wav" }), "recording.wav");
  form.set("mode", mode);
  return fetch(`${baseUrl}/api/ai/voice/transcribe`, { method: "POST", headers: { cookie }, body: form });
}

test("WP1 P1-3: countBrokerageAiRequestsToday counts only today's provider-reaching rows (success/error) for this brokerage", async () => {
  const b = await newBrokerage("Count");
  const other = await newBrokerage("Count Other");
  await seedInteractions(b.brokerageId, b.admin.user.id, 3, "success");
  await seedInteractions(b.brokerageId, b.admin.user.id, 2, "error");
  await seedInteractions(b.brokerageId, b.admin.user.id, 4, "blocked_flag");
  await seedInteractions(b.brokerageId, b.admin.user.id, 1, "blocked_entitlement");
  await seedInteractions(b.brokerageId, b.admin.user.id, 6, "success", new Date(Date.now() - 36 * 60 * 60 * 1000));
  await seedInteractions(other.brokerageId, other.admin.user.id, 7, "success");
  assert.equal(await countBrokerageAiRequestsToday(b.brokerageId), 5);
  assert.equal(await countBrokerageAiRequestsToday(other.brokerageId), 7);
});

test("WP1 P1-3: RUN Copilot (STARTER tier) works under the daily cap and returns 429 with no provider call once the cap is reached", async () => {
  const b = await newBrokerage("Starter");
  assert.equal(await resolveBrokerageTier(b.brokerageId), "STARTER");
  const limit = await limitFor(b.brokerageId);
  assert.equal(limit, TIER_CAPABILITIES.STARTER.maxAiRequestsPerDay);

  // Blocked rows and yesterday's rows never count toward today's quota.
  await seedInteractions(b.brokerageId, b.agent.user.id, limit - 1, "success");
  await seedInteractions(b.brokerageId, b.agent.user.id, 5, "blocked_flag");
  await seedInteractions(b.brokerageId, b.agent.user.id, 5, "success", new Date(Date.now() - 48 * 60 * 60 * 1000));

  const callsBefore = providerCalls;
  const underCap = await ask(b.agent.cookie, { contextType: null });
  assert.equal(underCap.status, 200, await underCap.clone().text());
  assert.equal(providerCalls, callsBefore + 1, "under the cap the provider is called exactly once");
  assert.equal(await countBrokerageAiRequestsToday(b.brokerageId), limit, "the successful request itself is durably counted");

  const atCap = await ask(b.agent.cookie, { contextType: null });
  assert.equal(atCap.status, 429);
  const body = (await atCap.json()) as { error: string; limit: number; tier: string };
  assert.match(body.error, /daily limit of \d+ AI requests/);
  assert.equal(body.limit, limit);
  assert.equal(body.tier, "STARTER");
  assert.equal(providerCalls, callsBefore + 1, "a capped request must never reach the provider");

  // The refusal is audited as blocked and does not itself consume quota.
  const blocked = await db
    .select()
    .from(aiInteractions)
    .where(and(eq(aiInteractions.brokerageId, b.brokerageId), eq(aiInteractions.userId, b.agent.user.id), eq(aiInteractions.status, "blocked_flag")));
  assert.ok(blocked.some((r) => (r.errorMessage ?? "").includes("daily limit")));
  assert.equal(await countBrokerageAiRequestsToday(b.brokerageId), limit);
});

test("WP1 P1-3: Grow Ask AE and Business Coach share the tier's daily cap (resolved via resolveBrokerageTier) and are refused with 429 before any provider call", async () => {
  const b = await newBrokerage("Grow");
  await grant(b.brokerageId, "grow.access");
  await grant(b.brokerageId, "grow.ai.use");
  const tier = await resolveBrokerageTier(b.brokerageId);
  assert.equal(tier, "PRO", "dev-login's run.access + grow.access resolves to PRO");
  const limit = await limitFor(b.brokerageId);

  await seedInteractions(b.brokerageId, b.agent.user.id, limit - 1, "success");
  const callsBefore = providerCalls;
  const underCap = await ask(b.agent.cookie, { contextType: "grow" });
  assert.equal(underCap.status, 200, await underCap.clone().text());
  assert.equal(providerCalls, callsBefore + 1);

  const growAtCap = await ask(b.agent.cookie, { contextType: "grow" });
  assert.equal(growAtCap.status, 429);
  const coachAtCap = await ask(b.agent.cookie, { contextType: "grow", mode: "coach" });
  assert.equal(coachAtCap.status, 429);
  const copilotAtCap = await ask(b.agent.cookie, { contextType: null });
  assert.equal(copilotAtCap.status, 429, "the cap is per brokerage, across every AI surface");
  assert.equal(providerCalls, callsBefore + 1, "no capped request may reach the provider");
});

test("WP1 P1-3: the daily cap is per brokerage — one brokerage at its cap never blocks another", async () => {
  const capped = await newBrokerage("Capped");
  const fresh = await newBrokerage("Fresh");
  await seedInteractions(capped.brokerageId, capped.agent.user.id, await limitFor(capped.brokerageId), "success");

  assert.equal((await ask(capped.agent.cookie, { contextType: null })).status, 429);
  assert.equal((await ask(fresh.agent.cookie, { contextType: null })).status, 200);
});

test("WP1 P1-3: voice transcription is refused with 429 and no transcription-provider call once the brokerage's durable daily AI count has reached the cap", async () => {
  const b = await newBrokerage("Voice");
  await grant(b.brokerageId, "grow.access");
  await grant(b.brokerageId, "grow.ai.use");
  const limit = await limitFor(b.brokerageId);

  await seedInteractions(b.brokerageId, b.agent.user.id, limit - 1, "success");
  const before = transcriptionCalls;
  const underCap = await uploadAudio(b.agent.cookie);
  assert.equal(underCap.status, 200, await underCap.clone().text());
  assert.equal(transcriptionCalls, before + 1);

  await seedInteractions(b.brokerageId, b.agent.user.id, 1, "success");
  const atCap = await uploadAudio(b.agent.cookie);
  assert.equal(atCap.status, 429);
  assert.match(((await atCap.json()) as { error: string }).error, /daily limit/);
  assert.equal(transcriptionCalls, before + 1, "a capped voice request must never reach the transcription provider");
});

test("WP1 P2-2: grow.access without grow.ai.use is refused (403) for Grow Ask AE, Business Coach and voice — but non-Grow RUN Copilot still works", async () => {
  const b = await newBrokerage("NoGrowAi");
  await grant(b.brokerageId, "grow.access");
  const callsBefore = providerCalls;

  const growRes = await ask(b.agent.cookie, { contextType: "grow" });
  assert.equal(growRes.status, 403);
  const growBody = (await growRes.json()) as { error: string; entitlementKey: string };
  assert.equal(growBody.entitlementKey, "grow.ai.use");
  assert.match(growBody.error, /Grow or Pro plan/);

  const coachRes = await ask(b.agent.cookie, { contextType: "grow", mode: "coach" });
  assert.equal(coachRes.status, 403);
  const coachBody = (await coachRes.json()) as { error: string; entitlementKey: string };
  assert.equal(coachBody.entitlementKey, "grow.ai.use");
  assert.match(coachBody.error, /does not include the AI Business Coach/);
  assert.equal(providerCalls, callsBefore, "a request refused for grow.ai.use never reaches the provider");

  const voiceBefore = transcriptionCalls;
  const voiceRes = await uploadAudio(b.agent.cookie);
  assert.equal(voiceRes.status, 403);
  assert.equal(((await voiceRes.json()) as { entitlementKey: string }).entitlementKey, "grow.ai.use");
  assert.equal(transcriptionCalls, voiceBefore);

  const copilotRes = await ask(b.agent.cookie, { contextType: null });
  assert.equal(copilotRes.status, 200, "grow.ai.use must never gate non-Grow RUN Copilot");

  // Granting grow.ai.use unlocks the Grow surfaces.
  await grant(b.brokerageId, "grow.ai.use");
  assert.equal((await ask(b.agent.cookie, { contextType: "grow" })).status, 200);
  assert.equal((await ask(b.agent.cookie, { contextType: "grow", mode: "coach" })).status, 200);
  assert.equal((await uploadAudio(b.agent.cookie)).status, 200);
});
