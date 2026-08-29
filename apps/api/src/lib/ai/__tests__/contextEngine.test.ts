import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, properties, users } from "@aee/db";
import { buildPropertyContext } from "../context/contextEngine.js";

test("buildPropertyContext enforces tenant isolation by brokerageId", async () => {
  // Self-contained fixture: this test creates its own brokerage, user, and
  // property rather than relying on any ambient/seed data being present -
  // CI's disposable Postgres service is a brand-new, empty database (see
  // .github/workflows/ci.yml's "Deterministic clean-database migration
  // check"), and this file is not guaranteed any other test file's rows are
  // still present when it runs (node:test runs test files concurrently).
  const fixtureTag = `context-engine-test-${randomUUID()}`;

  const [tempBrokerage] = await db
    .insert(brokerages)
    .values({ name: `AI Test Brokerage (tenant isolation) (${fixtureTag})` })
    .returning();
  const [tempUser] = await db
    .insert(users)
    .values({
      authProviderId: `fixture-auth-${fixtureTag}`,
      email: `${fixtureTag}@example.test`,
      firstName: "Fixture",
      lastName: "Agent",
      role: "Agent",
      brokerageId: tempBrokerage.id,
      isActive: true,
    })
    .returning();
  const [tempProperty] = await db
    .insert(properties)
    .values({
      brokerageId: tempBrokerage.id,
      agentId: tempUser.id,
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
    await db.delete(users).where(eq(users.id, tempUser.id));
    await db.delete(brokerages).where(eq(brokerages.id, tempBrokerage.id));
  }
});

test("buildPropertyContext returns null for a property id that does not exist at all", async () => {
  const result = await buildPropertyContext(1, -1);
  assert.equal(result, null);
});
