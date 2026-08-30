// Run Transaction Vertical Slice (#124) — #122: agent-facing task
// completion. automationTasks/automationAttentionItems previously had zero
// non-admin surface; completeAutomationTask (apps/api/src/lib/automation/
// tasks.ts) is the new agent-facing chokepoint. These tests prove it is
// tenant-scoped, idempotent on an already-completed task, and correctly
// refuses to "complete" a task that is no longer actionable (SUPERSEDED or
// CANCELLED) rather than silently succeeding.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, automationTasks } from "@aee/db";
import { completeAutomationTask } from "../tasks.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Run Vertical Slice CompleteTask A ${suffix}`;
const brokerageBName = `Run Vertical Slice CompleteTask B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyIdA: number;

async function insertTask(overrides: Partial<typeof automationTasks.$inferInsert> = {}) {
  const [row] = await db
    .insert(automationTasks)
    .values({
      brokerageId: A.brokerageId,
      propertyId: propertyIdA,
      taskKey: "PREPARE_SETTLEMENT_TRACKING",
      kind: "TASK",
      title: "Test task",
      status: "ACTIVE",
      ...overrides,
    })
    .returning();
  return row;
}

before(async () => {
  const { configureEvents } = await import("../../events.js");
  configureEvents();
  const { createApp } = await import("../../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
  const listed = await createListedProperty(baseUrl, A.agent.cookie, { address: "1 Complete Task Test Rd" });
  propertyIdA = listed.propertyId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("completes an ACTIVE task, is idempotent once COMPLETED, and audits the completion", async () => {
  const task = await insertTask();

  const first = await completeAutomationTask({ brokerageId: A.brokerageId, taskId: task.id, userId: A.agent.user.id });
  assert.equal(first.ok, true);
  assert.equal(first.task?.status, "COMPLETED");
  assert.ok(first.task?.completedAt);

  const second = await completeAutomationTask({ brokerageId: A.brokerageId, taskId: task.id, userId: A.agent.user.id });
  assert.equal(second.ok, true);
  assert.equal(second.task?.completedAt?.getTime(), first.task?.completedAt?.getTime(), "completing an already-completed task must be a pure no-op");
});

test("rejects a task from a different brokerage with NOT_FOUND", async () => {
  const task = await insertTask();
  const result = await completeAutomationTask({ brokerageId: B.brokerageId, taskId: task.id, userId: B.agent.user.id });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_FOUND");

  const [row] = await db.select().from(automationTasks).where(eq(automationTasks.id, task.id));
  assert.equal(row.status, "ACTIVE", "a cross-tenant completion attempt must never mutate the row");
});

test("refuses to complete a SUPERSEDED or CANCELLED task", async () => {
  const superseded = await insertTask({ status: "SUPERSEDED" });
  const supersededResult = await completeAutomationTask({ brokerageId: A.brokerageId, taskId: superseded.id, userId: A.agent.user.id });
  assert.equal(supersededResult.ok, false);
  assert.equal(supersededResult.reason, "ALREADY_TERMINAL");

  const cancelled = await insertTask({ status: "CANCELLED" });
  const cancelledResult = await completeAutomationTask({ brokerageId: A.brokerageId, taskId: cancelled.id, userId: A.agent.user.id });
  assert.equal(cancelledResult.ok, false);
  assert.equal(cancelledResult.reason, "ALREADY_TERMINAL");
});

test("a nonexistent taskId returns NOT_FOUND rather than throwing", async () => {
  const result = await completeAutomationTask({ brokerageId: A.brokerageId, taskId: "00000000-0000-0000-0000-000000000000", userId: A.agent.user.id });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_FOUND");
});
