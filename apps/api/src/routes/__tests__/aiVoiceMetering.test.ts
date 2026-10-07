// C-10 — durable voice metering on POST /api/ai/voice/transcribe.
// Mock transcription provider only. Live Deepgram stays off.
import { test, before, after, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { db, aiInteractions, aiUsage, auditLogs, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { countAiRequestsToday } from "../../lib/ai/dailyUsage.js";
import { AI_VOICE_TRANSCRIBED_ACTION, VOICE_METER_METADATA_KEYS, recordVoiceTranscriptionMeter, setVoiceMeterWriterForTests } from "../../lib/ai/voice/voiceMeter.js";
import { VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV, AI_DAILY_TOKEN_LIMIT_PER_USER_ENV } from "../../lib/ai/usageLimits.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";
import { setVoiceTranscriptionProviderForTests } from "../../lib/ai/voice/gateway.js";
import { _resetVoiceRateLimiterForTests } from "../../lib/ai/voice/voiceRateLimiter.js";
import { TranscriptionProviderError } from "../../lib/ai/voice/types.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../../lib/ai/voice/types.js";

const TRANSCRIPT_PHRASE = "ZEBRA_TRANSCRIPT_PHRASE_do_not_persist";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

describe("C-10 voice metering", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  const suffix = `${Date.now()}-${randomUUID()}`;
  const cleanupIds: number[] = [];
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
    setVoiceMeterWriterForTests(null);
    await cleanupBrokerages(cleanupIds);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  beforeEach(() => {
    resetMetricsForTesting();
    _resetVoiceRateLimiterForTests();
    transcribeCalls = 0;
    setVoiceMeterWriterForTests(null);
    setVoiceTranscriptionProviderForTests(speakingProvider(4.5));
  });

  function speakingProvider(durationSeconds: number | null, transcript = TRANSCRIPT_PHRASE): TranscriptionProvider {
    return {
      name: "mock",
      async transcribe(): Promise<TranscriptionResponse> {
        transcribeCalls += 1;
        return { provider: "mock", transcript, durationSeconds, latencyMs: 7 };
      },
    };
  }

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

  async function entitled(): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
    const fresh = await createBrokerageWithUsers(baseUrl, `Voice Meter ${suffix} ${randomUUID()}`);
    cleanupIds.push(fresh.brokerageId);
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    return fresh;
  }

  function wavBytes(): Buffer {
    return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii"), Buffer.alloc(2000, 0x00)]);
  }

  async function uploadAudio(cookie: string): Promise<Response> {
    const form = new FormData();
    form.set("audio", new Blob([wavBytes()], { type: "audio/wav" }), "recording.wav");
    form.set("mode", "ask");
    return fetch(`${baseUrl}/api/ai/voice/transcribe`, { method: "POST", headers: { cookie }, body: form });
  }

  async function meterRows(brokerageId: number) {
    return db.select().from(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  }

  async function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(patch)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("a successful transcription writes exactly one meter row and no transcript or audio", async () => {
    const fresh = await entitled();
    const beforeRequests = await countAiRequestsToday(fresh.brokerageId, fresh.agent.user.id);
    const res = await uploadAudio(fresh.agent.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { transcript: string };
    assert.equal(body.transcript, TRANSCRIPT_PHRASE);

    const rows = (await meterRows(fresh.brokerageId)).filter((row) => row.action === AI_VOICE_TRANSCRIBED_ACTION);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.userId, fresh.agent.user.id);
    assert.equal(row.brokerageId, fresh.brokerageId);
    assert.equal(row.recordType, "ai_voice");
    assert.equal(row.providerReference, "mock");
    assert.equal(row.propertyId, null);
    assert.equal(row.previousValue, null);
    assert.equal(row.userEmail, null);
    assert.equal(typeof row.recordId, "string");
    assert.ok(row.recordId.length > 0);
    const metadata = JSON.parse(row.updatedValue ?? "{}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ["audioSeconds", "latencyMs", "outcome"]);
    for (const key of Object.keys(metadata)) {
      assert.ok(VOICE_METER_METADATA_KEYS.includes(key as (typeof VOICE_METER_METADATA_KEYS)[number]));
      assert.doesNotMatch(key, /transcript|^audio$|audioBytes|audioUrl|^text$|partial/i);
    }
    assert.equal(metadata.outcome, "success");
    assert.equal(metadata.audioSeconds, 4.5);
    assert.equal(typeof metadata.latencyMs, "number");
    assert.ok((metadata.latencyMs as number) >= 0);
    const blob = JSON.stringify(row);
    assert.equal(blob.includes(TRANSCRIPT_PHRASE), false);
    assert.equal(blob.toLowerCase().includes("transcript"), false);
    assert.equal(blob.toLowerCase().includes("audiobytes"), false);

    const interactions = await db.select({ id: aiInteractions.id }).from(aiInteractions).where(eq(aiInteractions.brokerageId, fresh.brokerageId));
    assert.equal(interactions.length, 0);
    const afterRequests = await countAiRequestsToday(fresh.brokerageId, fresh.agent.user.id);
    assert.equal(afterRequests.brokerage, beforeRequests.brokerage);
    assert.equal(afterRequests.user, beforeRequests.user);

    const second = await uploadAudio(fresh.agent.cookie);
    assert.equal(second.status, 200);
    const afterSecond = (await meterRows(fresh.brokerageId)).filter((candidate) => candidate.action === AI_VOICE_TRANSCRIBED_ACTION);
    assert.equal(afterSecond.length, 2);
  });

  test("a provider error records outcome without audio seconds, and a refusal before the provider records nothing", async () => {
    const fresh = await entitled();
    setVoiceTranscriptionProviderForTests({
      name: "mock",
      async transcribe() {
        transcribeCalls += 1;
        throw new TranscriptionProviderError("mock", "provider_error", TRANSCRIPT_PHRASE);
      },
    });
    const failed = await uploadAudio(fresh.agent.cookie);
    assert.equal(failed.status, 502);
    const failedRows = (await meterRows(fresh.brokerageId)).filter((row) => row.action === AI_VOICE_TRANSCRIBED_ACTION);
    assert.equal(failedRows.length, 1);
    const metadata = JSON.parse(failedRows[0]?.updatedValue ?? "{}") as Record<string, unknown>;
    assert.equal(metadata.outcome, "provider_error");
    assert.equal("audioSeconds" in metadata, false);
    assert.equal(JSON.stringify(failedRows[0]).includes(TRANSCRIPT_PHRASE), false);
    assert.equal(failedRows[0]?.providerReference, "mock");

    const refused = await createBrokerageWithUsers(baseUrl, `Voice Meter Refused ${suffix} ${randomUUID()}`);
    cleanupIds.push(refused.brokerageId);
    const denied = await uploadAudio(refused.agent.cookie);
    assert.equal(denied.status, 403);
    assert.equal(transcribeCalls, 1, "the refusal must not reach the provider");
    const deniedRows = await meterRows(refused.brokerageId);
    assert.equal(deniedRows.length, 0);
  });

  test("a meter-write failure still returns the transcript and is observable", async () => {
    const fresh = await entitled();
    setVoiceMeterWriterForTests(async () => {
      throw new Error("meter store unavailable");
    });
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      const res = await uploadAudio(fresh.agent.cookie);
      assert.equal(res.status, 200, await res.clone().text());
      const body = (await res.json()) as { transcript: string };
      assert.equal(body.transcript, TRANSCRIPT_PHRASE);
    } finally {
      process.stderr.write = original;
      setVoiceMeterWriterForTests(null);
    }
    const stderr = chunks.join("");
    assert.match(stderr, /voice_meter_write_failed/);
    assert.equal(stderr.includes(TRANSCRIPT_PHRASE), false);
    const metrics = renderMetricsText();
    assert.match(metrics, /voice_meter_write_failure_total\{\} 1/);
    const rows = (await meterRows(fresh.brokerageId)).filter((row) => row.action === AI_VOICE_TRANSCRIBED_ACTION);
    assert.equal(rows.length, 0);
  });

  test("audio-second and token ceilings refuse voice when set, and an unset audio ceiling does not", async () => {
    const fresh = await entitled();
    await withEnv({ AI_DAILY_CAP_ENFORCED: "true", [VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV]: "4" }, async () => {
      setVoiceTranscriptionProviderForTests(speakingProvider(4));
      const under = await uploadAudio(fresh.agent.cookie);
      assert.equal(under.status, 200, await under.clone().text());
      const atCap = await uploadAudio(fresh.agent.cookie);
      assert.equal(atCap.status, 429);
      const body = (await atCap.json()) as { unit: string; scope: string; limit: number };
      assert.equal(body.unit, "audio_seconds");
      assert.equal(body.scope, "user");
      assert.equal(body.limit, 4);
      assert.equal(transcribeCalls, 1);
    });

    const tokenBrokerage = await entitled();
    const [interaction] = await db
      .insert(aiInteractions)
      .values({
        requestId: randomUUID(),
        brokerageId: tokenBrokerage.brokerageId,
        userId: tokenBrokerage.agent.user.id,
        aiRole: "copilot",
        riskLevel: 0,
        status: "success",
      })
      .returning({ id: aiInteractions.id });
    assert.ok(interaction);
    await db.insert(aiUsage).values({
      interactionId: interaction.id,
      provider: "mock",
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: 100,
      estimatedCostUsd: "0",
      latencyMs: 1,
    });
    const callsBeforeToken = transcribeCalls;
    await withEnv({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: "10" }, async () => {
      const capped = await uploadAudio(tokenBrokerage.agent.cookie);
      assert.equal(capped.status, 429);
      const body = (await capped.json()) as { unit: string; scope: string };
      assert.equal(body.unit, "tokens");
      assert.equal(body.scope, "user");
      assert.equal(transcribeCalls, callsBeforeToken);
    });

    const open = await entitled();
    await withEnv(
      {
        AI_DAILY_CAP_ENFORCED: "true",
        [VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV]: undefined,
        [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: undefined,
      },
      async () => {
        await recordVoiceTranscriptionMeter({
          brokerageId: open.brokerageId,
          userId: open.agent.user.id,
          provider: "mock",
          outcome: "success",
          audioSeconds: 10000,
          latencyMs: 1,
          correlationId: randomUUID(),
        });
        setVoiceTranscriptionProviderForTests(speakingProvider(1));
        const res = await uploadAudio(open.agent.cookie);
        assert.equal(res.status, 200, await res.clone().text());
      },
    );
  });
});
