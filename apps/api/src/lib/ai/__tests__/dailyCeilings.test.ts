// C-10 — optional token and voice audio-second ceilings, plus the invariants
// that the existing request ceilings and the voice/request split stay put.
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, aiInteractions, aiUsage, auditLogs, brokerages, users } from "@aee/db";
import type { Brokerage, User } from "@aee/db";
import {
  AI_DAILY_TOKEN_LIMIT_PER_BROKERAGE_ENV,
  AI_DAILY_TOKEN_LIMIT_PER_USER_ENV,
  VOICE_DAILY_AUDIO_SECONDS_PER_BROKERAGE_ENV,
  VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV,
} from "../usageLimits.js";
import {
  AiDailyCapExceededError,
  assertDailyAiLimitsNotReached,
  countAiRequestsToday,
  sumVoiceAudioSecondsToday,
} from "../dailyUsage.js";
import {
  AI_VOICE_TRANSCRIBED_ACTION,
  VOICE_METER_METADATA_KEYS,
  recordVoiceTranscriptionMeter,
} from "../voice/voiceMeter.js";

describe("C-10 daily ceilings", { concurrency: false }, () => {
  const createdBrokerageIds: number[] = [];

  async function fixture(tag: string): Promise<{ brokerage: Brokerage; user: User }> {
    const [brokerage] = await db.insert(brokerages).values({ name: `C10 ceilings ${tag} ${randomUUID()}` }).returning();
    assert.ok(brokerage);
    createdBrokerageIds.push(brokerage.id);
    const [user] = await db
      .insert(users)
      .values({
        authProviderId: `c10-${randomUUID()}`,
        email: `c10-${randomUUID()}@example.test`,
        firstName: "C10",
        lastName: "Ceilings",
        role: "Agent",
        brokerageId: brokerage.id,
        isActive: true,
      })
      .returning();
    assert.ok(user);
    return { brokerage, user };
  }

  async function cleanup(): Promise<void> {
    if (createdBrokerageIds.length === 0) return;
    const interactionRows = await db
      .select({ id: aiInteractions.id })
      .from(aiInteractions)
      .where(inArray(aiInteractions.brokerageId, createdBrokerageIds));
    const interactionIds = interactionRows.map((row) => row.id);
    if (interactionIds.length > 0) {
      await db.delete(aiUsage).where(inArray(aiUsage.interactionId, interactionIds));
    }
    await db.delete(aiInteractions).where(inArray(aiInteractions.brokerageId, createdBrokerageIds));
    await db.delete(auditLogs).where(inArray(auditLogs.brokerageId, createdBrokerageIds));
    await db.delete(users).where(inArray(users.brokerageId, createdBrokerageIds));
    await db.delete(brokerages).where(inArray(brokerages.id, createdBrokerageIds));
  }

  test.after(cleanup);

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

  async function seedTokens(brokerageId: number, userId: number, totalTokens: number, count = 1): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      const [interaction] = await db
        .insert(aiInteractions)
        .values({
          requestId: randomUUID(),
          brokerageId,
          userId,
          aiRole: "copilot",
          riskLevel: 0,
          status: "success",
        })
        .returning({ id: aiInteractions.id });
      assert.ok(interaction);
      await db.insert(aiUsage).values({
        interactionId: interaction.id,
        provider: "mock",
        promptTokens: totalTokens,
        completionTokens: 0,
        totalTokens,
        estimatedCostUsd: "1.25",
        latencyMs: 5,
      });
    }
  }

  async function meter(brokerageId: number, userId: number, audioSeconds: number | null, outcome: "success" | "provider_error" = "success"): Promise<void> {
    await recordVoiceTranscriptionMeter({
      brokerageId,
      userId,
      provider: "mock",
      outcome,
      audioSeconds,
      latencyMs: 15,
      correlationId: randomUUID(),
    });
  }

  test("token ceilings refuse on total tokens and do nothing when unset", async () => {
    const { brokerage, user } = await fixture("tokens");
    await seedTokens(brokerage.id, user.id, 80);

    await withEnv(
      {
        AI_DAILY_CAP_ENFORCED: "true",
        [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: "10",
        [AI_DAILY_TOKEN_LIMIT_PER_BROKERAGE_ENV]: undefined,
      },
      async () => {
        await assert.rejects(
          () => assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER" }),
          (err: unknown) => {
            assert.ok(err instanceof AiDailyCapExceededError);
            assert.equal(err.unit, "tokens");
            assert.equal(err.scope, "user");
            assert.equal(err.limit, 10);
            return true;
          },
        );
      },
    );

    await withEnv(
      {
        AI_DAILY_CAP_ENFORCED: "true",
        [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: undefined,
        [AI_DAILY_TOKEN_LIMIT_PER_BROKERAGE_ENV]: "50",
      },
      async () => {
        await assert.rejects(
          () => assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER" }),
          (err: unknown) => {
            assert.ok(err instanceof AiDailyCapExceededError);
            assert.equal(err.unit, "tokens");
            assert.equal(err.scope, "brokerage");
            return true;
          },
        );
      },
    );

    await withEnv(
      {
        AI_DAILY_CAP_ENFORCED: "true",
        [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: undefined,
        [AI_DAILY_TOKEN_LIMIT_PER_BROKERAGE_ENV]: undefined,
      },
      async () => {
        await assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER" });
      },
    );
  });

  test("a breached request ceiling still wins, and reports requests, when tokens are also over", async () => {
    const { brokerage, user } = await fixture("requests-first");
    await seedTokens(brokerage.id, user.id, 100, 20);
    await withEnv(
      { AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_TOKEN_LIMIT_PER_USER_ENV]: "1" },
      async () => {
        await assert.rejects(
          () => assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER" }),
          (err: unknown) => {
            assert.ok(err instanceof AiDailyCapExceededError);
            assert.equal(err.unit, "requests");
            assert.equal(err.scope, "brokerage");
            assert.equal(err.limit, 20);
            assert.match(err.message, /daily limit of 20 AI requests/);
            return true;
          },
        );
      },
    );
  });

  test("audio-second ceilings apply to voice only, and an unset ceiling adds no limit", async () => {
    const { brokerage, user } = await fixture("audio");
    await meter(brokerage.id, user.id, 40);

    await withEnv(
      { AI_DAILY_CAP_ENFORCED: "true", [VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV]: "30" },
      async () => {
        await assert.rejects(
          () => assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER", surface: "voice" }),
          (err: unknown) => {
            assert.ok(err instanceof AiDailyCapExceededError);
            assert.equal(err.unit, "audio_seconds");
            assert.equal(err.scope, "user");
            assert.equal(err.limit, 30);
            return true;
          },
        );
        await assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER" });
      },
    );

    await withEnv(
      {
        AI_DAILY_CAP_ENFORCED: "true",
        [VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV]: undefined,
        [VOICE_DAILY_AUDIO_SECONDS_PER_BROKERAGE_ENV]: "10",
      },
      async () => {
        await assert.rejects(
          () => assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER", surface: "voice" }),
          (err: unknown) => {
            assert.ok(err instanceof AiDailyCapExceededError);
            assert.equal(err.unit, "audio_seconds");
            assert.equal(err.scope, "brokerage");
            return true;
          },
        );
      },
    );

    await withEnv({ AI_DAILY_CAP_ENFORCED: "true", [VOICE_DAILY_AUDIO_SECONDS_PER_USER_ENV]: undefined, [VOICE_DAILY_AUDIO_SECONDS_PER_BROKERAGE_ENV]: undefined }, async () => {
      await assertDailyAiLimitsNotReached({ brokerageId: brokerage.id, userId: user.id, tier: "STARTER", surface: "voice" });
    });
  });

  test("voice meter rows do not increment the AI request count and are tenant-scoped", async () => {
    const a = await fixture("tenant-a");
    const b = await fixture("tenant-b");
    const [otherUser] = await db
      .insert(users)
      .values({
        authProviderId: `c10-other-${randomUUID()}`,
        email: `c10-other-${randomUUID()}@example.test`,
        firstName: "Other",
        lastName: "Agent",
        role: "Agent",
        brokerageId: a.brokerage.id,
        isActive: true,
      })
      .returning();
    assert.ok(otherUser);

    await meter(a.brokerage.id, a.user.id, 4);
    await meter(a.brokerage.id, otherUser.id, 6);
    await meter(b.brokerage.id, b.user.id, 9);
    await meter(a.brokerage.id, a.user.id, 12, "provider_error");

    const counts = await countAiRequestsToday(a.brokerage.id, a.user.id);
    assert.equal(counts.brokerage, 0);
    assert.equal(counts.user, 0);
    assert.equal((await countAiRequestsToday(b.brokerage.id, b.user.id)).brokerage, 0);

    const aSum = await sumVoiceAudioSecondsToday(a.brokerage.id, a.user.id);
    assert.equal(aSum.brokerage, 10, "failure rows contribute no seconds; both users in A are included");
    assert.equal(aSum.user, 4);
    const otherSum = await sumVoiceAudioSecondsToday(a.brokerage.id, otherUser.id);
    assert.equal(otherSum.user, 6);
    assert.equal(otherSum.brokerage, 10);
    const bSum = await sumVoiceAudioSecondsToday(b.brokerage.id, b.user.id);
    assert.equal(bSum.brokerage, 9);
    assert.equal(bSum.user, 9);
    const cross = await sumVoiceAudioSecondsToday(a.brokerage.id, b.user.id);
    assert.equal(cross.brokerage, 10);
    assert.equal(cross.user, 0, "a user id from another brokerage adds nothing inside this tenant");
  });

  test("persisted voice metadata has no transcript or audio payload", async () => {
    const { brokerage, user } = await fixture("privacy");
    const correlationId = randomUUID();
    await recordVoiceTranscriptionMeter({
      brokerageId: brokerage.id,
      userId: user.id,
      provider: "mock",
      outcome: "success",
      audioSeconds: 3.5,
      latencyMs: 21,
      correlationId,
    });
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.brokerageId, brokerage.id));
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.action, AI_VOICE_TRANSCRIBED_ACTION);
    assert.equal(row.recordType, "ai_voice");
    assert.equal(row.recordId, correlationId);
    assert.equal(row.providerReference, "mock");
    assert.equal(row.userId, user.id);
    assert.equal(row.propertyId, null);
    assert.equal(row.previousValue, null);
    assert.equal(row.userEmail, null);
    const metadata = JSON.parse(row.updatedValue ?? "{}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), ["audioSeconds", "latencyMs", "outcome"]);
    for (const key of Object.keys(metadata)) {
      assert.ok(VOICE_METER_METADATA_KEYS.includes(key as (typeof VOICE_METER_METADATA_KEYS)[number]));
      assert.doesNotMatch(key, /transcript|^audio$|audioBytes|audioUrl|^text$|partial|bytes/i);
    }
    assert.equal(metadata.outcome, "success");
    assert.equal(metadata.audioSeconds, 3.5);
    assert.equal(metadata.latencyMs, 21);
    const blob = JSON.stringify(row).toLowerCase();
    assert.equal(blob.includes("transcript"), false);
    assert.equal(blob.includes("audiobytes"), false);
    assert.equal(blob.includes("audiourl"), false);

    await meter(brokerage.id, user.id, 99, "provider_error");
    const failureRows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.brokerageId, brokerage.id));
    const failure = failureRows.find((candidate) => candidate.recordId !== correlationId);
    assert.ok(failure);
    const failureMeta = JSON.parse(failure.updatedValue ?? "{}") as Record<string, unknown>;
    assert.deepEqual(Object.keys(failureMeta).sort(), ["latencyMs", "outcome"]);
    assert.equal(failureMeta.outcome, "provider_error");
    assert.equal("audioSeconds" in failureMeta, false);
  });
});
