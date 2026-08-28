import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, brokerages, properties, users } from "@aee/db";
import { buildPropertyContext } from "../context/contextEngine.js";

test("buildPropertyContext enforces tenant isolation by brokerageId", async () => {
  const [anyUser] = await db.select().from(users).limit(1);
  assert.notEqual(anyUser, undefined, "test requires at least one existing user row (seed data)");

  const [tempBrokerage] = await db
    .insert(brokerages)
    .values({ name: "AI Test Brokerage (tenant isolation)" })
    .returning();
  const [tempProperty] = await db
    .insert(properties)
    .values({
      brokerageId: tempBrokerage.id,
      agentId: anyUser.id,
      formattedAddress: "1 AI Test Street, Testville",
      workflowStage: "Appraisal",
    })
    .returning();

  try {
    const ownBrokerageResult = await buildPropertyContext(tempBrokerage.id, tempProperty.id);
    assert.notEqual(ownBrokerageResult, null);
    assert.equal(ownBrokerageResult?.address, "1 AI Test Street, Testville");

    const foreignBrokerageId = tempBrokerage.id + 1_000_000;
    const foreignBrokerageResult = await buildPropertyContext(foreignBrokerageId, tempProperty.id);
    assert.equal(
      foreignBrokerageResult,
      null,
      "a property must resolve to null context when requested by a brokerageId that does not own it"
    );
  } finally {
    await db.delete(properties).where(eq(properties.id, tempProperty.id));
    await db.delete(brokerages).where(eq(brokerages.id, tempBrokerage.id));
  }
});

test("buildPropertyContext returns null for a property id that does not exist at all", async () => {
  const result = await buildPropertyContext(1, -1);
  assert.equal(result, null);
});
