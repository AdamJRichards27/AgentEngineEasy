import { test } from "node:test";
import assert from "node:assert/strict";
import { db, users } from "@aee/db";
import { askCopilot } from "../orchestrator.js";
import { AiFeatureDisabledError } from "../types.js";

test("askCopilot refuses to run when AI_COPILOT_ENABLED=false, server-side, before any provider call", async () => {
  const [anyUser] = await db.select().from(users).limit(1);
  assert.notEqual(anyUser, undefined, "test requires at least one existing user row (seed data)");
  const previous = process.env.AI_COPILOT_ENABLED;
  process.env.AI_COPILOT_ENABLED = "false";
  try {
    await assert.rejects(
      () =>
        askCopilot({
          brokerageId: anyUser.brokerageId ?? 1,
          userId: anyUser.id,
          userRole: anyUser.role,
          question: "Is this request blocked?",
          contextType: null,
          contextId: null,
        }),
      AiFeatureDisabledError
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AI_COPILOT_ENABLED;
    } else {
      process.env.AI_COPILOT_ENABLED = previous;
    }
  }
});

test("askCopilot returns a Level 0 structured response on the happy path (mock provider)", async () => {
  const [anyUser] = await db.select().from(users).limit(1);
  assert.notEqual(anyUser, undefined, "test requires at least one existing user row (seed data)");
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "mock";
  try {
    const result = await askCopilot({
      brokerageId: anyUser.brokerageId ?? 1,
      userId: anyUser.id,
      userRole: anyUser.role,
      question: "How many active properties do I have?",
      contextType: null,
      contextId: null,
    });
    assert.equal(result.response.riskLevel, 0);
    assert.ok(["fact", "inference", "recommendation", "unknown"].includes(result.response.kind));
    assert.equal(typeof result.requestId, "string");
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = previousProvider;
    }
  }
});
