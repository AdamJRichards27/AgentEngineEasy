import { randomUUID } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db, users, brokerages, aiInteractions, aiUsage } from "@aee/db";
import type { User, Brokerage } from "@aee/db";
import { askCopilot } from "../orchestrator.js";
import { AiFeatureDisabledError } from "../types.js";

// These two tests exercise askCopilot end-to-end against the real database, so
// they need a real, foreign-key-satisfying user and brokerage row to act as.
// They intentionally do NOT rely on any ambient/seed data being present: CI's
// disposable Postgres service is a brand-new, empty database (see the
// "Deterministic clean-database migration check" step in
// .github/workflows/ci.yml), so this file creates its own fixture rows in
// before() and removes exactly those rows - and nothing else - in after().
let testBrokerage: Brokerage;
let testUser: User;

before(async () => {
  // Unique per test run so this can never collide with a pre-existing row in
  // a long-lived database (e.g. a local dev database) - the exact condition
  // that let this file's previous "just grab any existing user" version mask
  // its own missing fixture for so long.
  const fixtureTag = `orchestrator-test-${randomUUID()}`;

  const [brokerage] = await db
    .insert(brokerages)
    .values({ name: `Fixture Brokerage (${fixtureTag})` })
    .returning();
  testBrokerage = brokerage;

  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `fixture-auth-${fixtureTag}`,
      email: `${fixtureTag}@example.test`,
      firstName: "Fixture",
      lastName: "User",
      role: "Agent",
      brokerageId: testBrokerage.id,
      isActive: true,
    })
    .returning();
  testUser = user;
});

after(async () => {
  // Scoped to exactly this fixture's own user id, so this can never delete
  // anyone else's data even if it runs against a database that already has
  // rows in it. Order matches the foreign-key chain: ai_usage ->
  // ai_interactions -> user -> brokerage.
  const interactionRows = await db
    .select({ id: aiInteractions.id })
    .from(aiInteractions)
    .where(eq(aiInteractions.userId, testUser.id));
  const interactionIds = interactionRows.map((row) => row.id);

  if (interactionIds.length > 0) {
    await db.delete(aiUsage).where(inArray(aiUsage.interactionId, interactionIds));
  }
  await db.delete(aiInteractions).where(eq(aiInteractions.userId, testUser.id));
  await db.delete(users).where(eq(users.id, testUser.id));
  await db.delete(brokerages).where(eq(brokerages.id, testBrokerage.id));
});

test("askCopilot refuses to run when AI_COPILOT_ENABLED=false, server-side, before any provider call", async () => {
  const previous = process.env.AI_COPILOT_ENABLED;
  process.env.AI_COPILOT_ENABLED = "false";
  try {
    await assert.rejects(
      () =>
        askCopilot({
          brokerageId: testUser.brokerageId ?? testBrokerage.id,
          userId: testUser.id,
          userRole: testUser.role,
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
  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "mock";
  try {
    const result = await askCopilot({
      brokerageId: testUser.brokerageId ?? testBrokerage.id,
      userId: testUser.id,
      userRole: testUser.role,
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
