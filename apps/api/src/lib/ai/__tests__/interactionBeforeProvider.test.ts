// C-10 — the countable ai_interactions row exists before the provider returns,
// and a provider failure updates that same row instead of inserting a second one.
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, aiInteractions, aiUsage, brokerages, users } from "@aee/db";
import type { Brokerage, User } from "@aee/db";
import { askCopilot } from "../orchestrator.js";
import { setAiGatewayProviderForTests } from "../gateway.js";
import type { AiProvider } from "../providers/provider.js";
import type { AiProviderRequest, AiProviderResponse } from "../types.js";

describe("C-10 interaction write order", { concurrency: false }, () => {
  async function fixture(): Promise<{ brokerage: Brokerage; user: User }> {
    const tag = randomUUID();
    const [brokerage] = await db.insert(brokerages).values({ name: `C10 order ${tag}` }).returning();
    assert.ok(brokerage);
    const [user] = await db
      .insert(users)
      .values({
        authProviderId: `c10-order-${tag}`,
        email: `c10-order-${tag}@example.test`,
        firstName: "Order",
        lastName: "Test",
        role: "Agent",
        brokerageId: brokerage.id,
        isActive: true,
      })
      .returning();
    assert.ok(user);
    return { brokerage, user };
  }

  async function cleanup(brokerageId: number, userId: number): Promise<void> {
    const rows = await db.select({ id: aiInteractions.id }).from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerageId));
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) await db.delete(aiUsage).where(inArray(aiUsage.interactionId, ids));
    await db.delete(aiInteractions).where(eq(aiInteractions.brokerageId, brokerageId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  }

  function provider(generate: AiProvider["generate"]): AiProvider {
    return { name: "mock", generate };
  }

  test("askCopilot inserts the interaction before the provider returns, then records usage on that row", async () => {
    const { brokerage, user } = await fixture();
    let seenDuringProvider = false;
    try {
      setAiGatewayProviderForTests(() =>
        provider(async (_request: AiProviderRequest): Promise<AiProviderResponse> => {
          const rows = await db.select().from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerage.id));
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.status, "success");
          assert.equal(rows[0]?.responseKind, null);
          seenDuringProvider = true;
          return {
            provider: "mock",
            model: "mock-v1",
            text: "ok",
            usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7, estimatedCostUsd: 0 },
            latencyMs: 2,
          };
        }),
      );
      const result = await askCopilot({
        brokerageId: brokerage.id,
        userId: user.id,
        userRole: user.role,
        question: "How many active properties do I have?",
        contextType: null,
        contextId: null,
      });
      assert.equal(typeof result.requestId, "string");
      assert.equal(seenDuringProvider, true);
      const rows = await db.select().from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerage.id));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "success");
      assert.equal(typeof rows[0]?.responseKind, "string");
      const usage = await db.select().from(aiUsage).where(eq(aiUsage.interactionId, rows[0]!.id));
      assert.equal(usage.length, 1);
      assert.equal(usage[0]?.totalTokens, 7);
      assert.equal(usage[0]?.provider, "mock");
    } finally {
      setAiGatewayProviderForTests(null);
      await cleanup(brokerage.id, user.id);
    }
  });

  test("a provider failure updates the pre-written row to error and does not insert a second row", async () => {
    const { brokerage, user } = await fixture();
    try {
      setAiGatewayProviderForTests(() =>
        provider(async () => {
          const rows = await db.select({ id: aiInteractions.id }).from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerage.id));
          assert.equal(rows.length, 1);
          throw new Error("provider down");
        }),
      );
      await assert.rejects(
        () =>
          askCopilot({
            brokerageId: brokerage.id,
            userId: user.id,
            userRole: user.role,
            question: "How many active properties do I have?",
            contextType: null,
            contextId: null,
          }),
        /provider down/,
      );
      const rows = await db.select().from(aiInteractions).where(eq(aiInteractions.brokerageId, brokerage.id));
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "error");
      assert.match(rows[0]?.errorMessage ?? "", /provider down/);
      const usage = await db.select().from(aiUsage).where(eq(aiUsage.interactionId, rows[0]!.id));
      assert.equal(usage.length, 0);
    } finally {
      setAiGatewayProviderForTests(null);
      await cleanup(brokerage.id, user.id);
    }
  });
});
