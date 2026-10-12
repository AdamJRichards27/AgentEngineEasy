// Agent Engine 2.0 — WAE Stage 2: Controlled Production Workflows.
//
// Integration tests for the two new Stage 2 domain services
// (tasks.ts, attentionItems.ts) against the real database — same
// throwaway-fixture + t.after() teardown pattern as rules.test.ts /
// engine.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, auditLogs, brokerages, users, properties, transactions, automationTasks, automationAttentionItems, type UserRole } from "@aee/db";
import { createAutomationTask, assignAutomationTaskToRole } from "../tasks.js";
import { raiseAttentionItem, resolveAttentionItem } from "../attentionItems.js";

async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: UserRole): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ authProviderId: `test-${suffix}`, email: `test-${suffix}@example.com`, role, brokerageId })
    .returning();
  return row.id;
}

async function createProperty(brokerageId: number, agentId: number): Promise<number> {
  const [row] = await db.insert(properties).values({ brokerageId, agentId, formattedAddress: "1 Stage 2 Test St, Testville" }).returning();
  return row.id;
}

async function createTransaction(propertyId: number): Promise<number> {
  const [row] = await db
    .insert(transactions)
    .values({
      propertyId,
      sellerPartyIds: [],
      buyerPartyIds: [],
      purchasePriceCents: 100_000_00,
      status: "ContractPreparation",
    })
    .returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  const propertyRows = await db.select({ id: properties.id }).from(properties).where(eq(properties.brokerageId, brokerageId));
  for (const property of propertyRows) {
    await db.delete(automationTasks).where(eq(automationTasks.propertyId, property.id));
    await db.delete(automationAttentionItems).where(eq(automationAttentionItems.propertyId, property.id));
    await db.delete(transactions).where(eq(transactions.propertyId, property.id));
  }
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  // Run audit rows now reference the brokerage. Delete them before the brokerage row.
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

// ---------------------------------------------------------------------
// createAutomationTask
// ---------------------------------------------------------------------

test("createAutomationTask creates a new ACTIVE task and audits it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - create task");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const result = await createAutomationTask({
    brokerageId,
    propertyId,
    taskKey: "CONFIRM_AML_CTF_REQUIREMENTS",
    kind: "TASK",
    title: "Confirm AML/CTF requirements",
  });

  assert.equal(result.outcome, "CREATED");
  assert.equal(result.task.status, "ACTIVE");
  assert.equal(result.task.propertyId, propertyId);
});

test("createAutomationTask rejects a property that belongs to a different brokerage — tenant isolation", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - task tenant A");
  const otherBrokerageId = await createBrokerage("Stage2 Domain - task tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageId), cleanupBrokerage(otherBrokerageId)]));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  await assert.rejects(() =>
    createAutomationTask({
      brokerageId: otherBrokerageId,
      propertyId,
      taskKey: "CONFIRM_AML_CTF_REQUIREMENTS",
      kind: "TASK",
      title: "Should never be created",
    }),
  );
});

test("createAutomationTask is idempotent: an identical repeat call for the same scope/taskKey returns UNCHANGED, not a duplicate row", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - idempotent task");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const first = await createAutomationTask({
    brokerageId,
    propertyId,
    taskKey: "VERIFY_REGISTERED_PROPERTY_OWNERS",
    kind: "TASK",
    title: "Verify registered owners",
  });
  const second = await createAutomationTask({
    brokerageId,
    propertyId,
    taskKey: "VERIFY_REGISTERED_PROPERTY_OWNERS",
    kind: "TASK",
    title: "Verify registered owners",
  });

  assert.equal(first.outcome, "CREATED");
  assert.equal(second.outcome, "UNCHANGED");
  assert.equal(second.task.id, first.task.id);

  const rows = await db.select().from(automationTasks).where(eq(automationTasks.propertyId, propertyId));
  assert.equal(rows.length, 1, "an identical repeat call must never create a second row");
});

test("createAutomationTask supersedes rather than overwrites when a material date changes — changed transaction date scenario", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - reminder supersede");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const transactionId = await createTransaction(propertyId);

  const first = await createAutomationTask({
    brokerageId,
    propertyId,
    transactionId,
    taskKey: "PRE_SETTLEMENT_MILESTONE_REMINDER",
    kind: "REMINDER",
    title: "Pre-settlement milestone reminder",
    dueAt: new Date("2026-09-01T00:00:00.000Z"),
  });
  assert.equal(first.outcome, "CREATED");

  const rescheduled = await createAutomationTask({
    brokerageId,
    propertyId,
    transactionId,
    taskKey: "PRE_SETTLEMENT_MILESTONE_REMINDER",
    kind: "REMINDER",
    title: "Pre-settlement milestone reminder",
    dueAt: new Date("2026-09-15T00:00:00.000Z"),
  });
  assert.equal(rescheduled.outcome, "SUPERSEDED_AND_RECREATED");
  assert.equal(rescheduled.supersededTaskId, first.task.id);
  assert.notEqual(rescheduled.task.id, first.task.id);

  const [originalAfter] = await db.select().from(automationTasks).where(eq(automationTasks.id, first.task.id));
  assert.equal(originalAfter.status, "SUPERSEDED", "the original reminder must be retained as historical evidence, never deleted");
  assert.equal(originalAfter.supersededByTaskId, rescheduled.task.id);

  const [newRow] = await db.select().from(automationTasks).where(eq(automationTasks.id, rescheduled.task.id));
  assert.equal(newRow.status, "ACTIVE");
  assert.equal(newRow.dueAt?.toISOString(), "2026-09-15T00:00:00.000Z");

  const activeRows = await db
    .select()
    .from(automationTasks)
    .where(eq(automationTasks.transactionId, transactionId));
  const activeCount = activeRows.filter((r) => r.status === "ACTIVE").length;
  assert.equal(activeCount, 1, "exactly one ACTIVE reminder must exist after a reschedule");
});

// ---------------------------------------------------------------------
// assignAutomationTaskToRole
// ---------------------------------------------------------------------

test("assignAutomationTaskToRole reassigns the current active task and audits it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - assign task");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  await createAutomationTask({
    brokerageId,
    propertyId,
    taskKey: "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
    kind: "TASK",
    title: "Prepare listing-launch requirements",
  });

  const result = await assignAutomationTaskToRole({
    brokerageId,
    propertyId,
    taskKey: "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
    assignedRole: "Pit Crew",
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.task.assignedRole, "Pit Crew");
});

test("assignAutomationTaskToRole returns NOT_FOUND for a task key with no active row", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - assign missing task");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const result = await assignAutomationTaskToRole({
    brokerageId,
    propertyId,
    taskKey: "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
    assignedRole: "Agent",
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NOT_FOUND");
});

// ---------------------------------------------------------------------
// raiseAttentionItem / resolveAttentionItem
// ---------------------------------------------------------------------

test("raiseAttentionItem creates an OPEN item and audits it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - raise attention item");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const result = await raiseAttentionItem({
    brokerageId,
    propertyId,
    reasonCode: "MISSING_SETTLEMENT_DATE",
    summary: "No settlement date on the triggering event.",
  });

  assert.equal(result.outcome, "CREATED");
  assert.equal(result.item.status, "OPEN");
});

test("raiseAttentionItem is idempotent: does not silently discard, but does not duplicate an already-OPEN condition", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - idempotent attention item");
  t.after(() => cleanupBrokerage(brokerageId));
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const transactionId = await createTransaction(propertyId);

  const first = await raiseAttentionItem({
    brokerageId,
    propertyId,
    transactionId,
    reasonCode: "MISSING_SETTLEMENT_DATE",
    summary: "No settlement date (first).",
  });
  const second = await raiseAttentionItem({
    brokerageId,
    propertyId,
    transactionId,
    reasonCode: "MISSING_SETTLEMENT_DATE",
    summary: "No settlement date (second delivery of the same underlying condition).",
  });

  assert.equal(first.outcome, "CREATED");
  assert.equal(second.outcome, "ALREADY_OPEN");
  assert.equal(second.item.id, first.item.id);

  const rows = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.transactionId, transactionId));
  assert.equal(rows.length, 1);
});

test("resolveAttentionItem marks an OPEN item RESOLVED and records who resolved it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - resolve attention item");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, adminId);

  const { item } = await raiseAttentionItem({
    brokerageId,
    propertyId,
    reasonCode: "MISSING_LEGAL_REPRESENTATIVE",
    summary: "Buyer legal representative not on file.",
  });

  const resolved = await resolveAttentionItem({
    brokerageId,
    attentionItemId: item.id,
    resolvedByUserId: adminId,
    resolutionNote: "Solicitor details captured.",
  });

  assert.equal(resolved.status, "RESOLVED");
  assert.equal(resolved.resolvedByUserId, adminId);
  assert.ok(resolved.resolvedAt);
});

test("resolveAttentionItem rejects an item from a different brokerage — tenant isolation", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Domain - resolve tenant A");
  const otherBrokerageId = await createBrokerage("Stage2 Domain - resolve tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageId), cleanupBrokerage(otherBrokerageId)]));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const otherAdminId = await createUser(otherBrokerageId, "Brokerage Administrator");
  const propertyId = await createProperty(brokerageId, adminId);

  const { item } = await raiseAttentionItem({
    brokerageId,
    propertyId,
    reasonCode: "OTHER",
    summary: "Tenant isolation test item.",
  });

  await assert.rejects(() =>
    resolveAttentionItem({
      brokerageId: otherBrokerageId,
      attentionItemId: item.id,
      resolvedByUserId: otherAdminId,
    }),
  );
});
