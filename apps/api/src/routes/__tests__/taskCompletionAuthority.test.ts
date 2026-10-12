// R-F41 — completing a Run task or resolving a Run attention item requires
// run.access, and the three settlement sign-off tasks require a Brokerage
// Administrator. The brokerage check stays first (404, same body as a
// missing id). A missing entitlement is the existing 403. A role refusal
// writes one denial audit row with brokerage_id and no task payload.
// A task that is not a Run catalogue row, and a Grow commitment, stay on
// their previous gates.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, automationAttentionItems, automationTasks, db, entitlementGrants, growCommitments, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const SIGNOFF_KEYS = [
  "CONFIRM_TRANSACTION_RECORD_COMPLETE",
  "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
  "RECORD_RETENTION_CLOSURE_CHECK",
] as const;

const DENIAL_ACTION = "automation_task_complete_denied";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let pitCrew: DevLoginResult;
let propertyId: number;
let transactionId: number;
let buyerPartyId: number;

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function postJson(path: string, cookie: string | undefined, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: cookie ? headers(cookie) : { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function patchJson(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "PATCH",
    headers: headers(cookie),
    body: JSON.stringify(body),
  });
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function grant(brokerageId: number, entitlementKey: string): Promise<void> {
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

async function insertTask(values: Partial<typeof automationTasks.$inferInsert> & { taskKey: string }) {
  const [row] = await db
    .insert(automationTasks)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      kind: "TASK",
      title: `R-F41 ${values.taskKey} ${suffix}`,
      status: "ACTIVE",
      ...values,
    })
    .returning();
  return row;
}

async function insertAttention(values: Partial<typeof automationAttentionItems.$inferInsert> & { reasonCode: string }) {
  const [row] = await db
    .insert(automationAttentionItems)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      summary: `R-F41 ${values.reasonCode} ${suffix}`,
      status: "OPEN",
      ...values,
    })
    .returning();
  return row;
}

async function taskStatus(id: string): Promise<string> {
  const [row] = await db.select({ status: automationTasks.status }).from(automationTasks).where(eq(automationTasks.id, id));
  if (!row) throw new Error(`task ${id} missing`);
  return row.status;
}

async function denialRows(recordId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, DENIAL_ACTION), eq(auditLogs.recordId, recordId)));
}

function assertDenial(
  row: Awaited<ReturnType<typeof denialRows>>[number],
  expected: { userId: number; role: string; brokerageId: number; taskId: string },
): void {
  assert.equal(row.userId, expected.userId);
  assert.equal(row.brokerageId, expected.brokerageId);
  assert.equal(row.recordType, "automation_task");
  assert.equal(row.recordId, expected.taskId);
  assert.equal(row.action, DENIAL_ACTION);
  assert.equal(row.userEmail, null);
  assert.equal(row.previousValue, null);
  assert.equal(row.providerReference, null);
  assert.equal(row.propertyId, null);
  const detail = JSON.parse(row.updatedValue ?? "") as { actorRole: string; reason: string };
  assert.deepEqual(detail, { actorRole: expected.role, reason: "ROLE_NOT_PERMITTED" });
  const stored = `${row.action} ${row.updatedValue ?? ""} ${row.previousValue ?? ""} ${row.userEmail ?? ""}`;
  assert.doesNotMatch(stored, /amountCents|password|account|secret|authorization|cookie|checklist/i);
  assert.equal(stored.includes(String(suffix)), false);
}

async function assertNotEntitled(res: Response): Promise<void> {
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error?: string; entitlementKey?: string };
  assert.equal(body.error, "Not entitled");
  assert.equal(body.entitlementKey, "run.access");
}

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

  A = await createBrokerageWithUsers(baseUrl, `R-F41 Tasks A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F41 Tasks B ${suffix}`);
  const pitLogin = await devLogin(baseUrl, {
    email: `pit-rf41-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: `R-F41 Tasks A ${suffix}`,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitLogin.user.id));
  pitCrew = { cookie: pitLogin.cookie, user: { ...pitLogin.user, role: "Pit Crew", brokerageId: A.brokerageId } };

  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Task Gate St ${suffix}`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;

  const partyRes = await postJson("/parties", A.agent.cookie, {
    propertyId,
    role: "Buyer",
    firstName: "Grow",
    lastName: "Contact",
  });
  if (partyRes.status !== 201) throw new Error(`create buyer failed: ${partyRes.status} ${await partyRes.text()}`);
  buyerPartyId = ((await partyRes.json()) as { party: { id: number } }).party.id;
  await grant(A.brokerageId, "grow.activities.manage");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("an unauthenticated completion or resolution is 401", async () => {
  const task = await insertTask({ taskKey: "PREPARE_CONTRACT_DOCUMENTATION", transactionId });
  const item = await insertAttention({ reasonCode: "OTHER", transactionId });
  const complete = await postJson(`/tasks/${task.id}/complete`, undefined);
  assert.equal(complete.status, 401);
  const resolve = await postJson(`/tasks/attention-items/${item.id}/resolve`, undefined, {});
  assert.equal(resolve.status, 401);
  assert.equal(await taskStatus(task.id), "ACTIVE");
});

test("an Agent with run.access can complete a normal Run task and resolve a transaction attention item", async () => {
  const task = await insertTask({ taskKey: "PREPARE_CONTRACT_DOCUMENTATION", transactionId });
  const complete = await postJson(`/tasks/${task.id}/complete`, A.agent.cookie);
  assert.equal(complete.status, 200);
  const body = (await complete.json()) as { task: { status: string } };
  assert.equal(body.task.status, "COMPLETED");

  const propertyTask = await insertTask({ taskKey: "CONFIRM_AML_CTF_REQUIREMENTS", transactionId: null });
  const propertyComplete = await postJson(`/tasks/${propertyTask.id}/complete`, A.agent.cookie);
  assert.equal(propertyComplete.status, 200);

  const item = await insertAttention({ reasonCode: "OTHER", transactionId });
  const resolve = await postJson(`/tasks/attention-items/${item.id}/resolve`, A.agent.cookie, { notes: "Recorded" });
  assert.equal(resolve.status, 200);
  assert.equal((await denialRows(task.id)).length, 0);
});

test("an Agent or Pit Crew completing S1, S2, or S3 is 403 and writes one denial audit row", async () => {
  for (const taskKey of SIGNOFF_KEYS) {
    const task = await insertTask({
      taskKey,
      transactionId,
      title: `Secret checklist ${taskKey} ${suffix}`,
    });
    const denied = await postJson(`/tasks/${task.id}/complete`, A.agent.cookie);
    assert.equal(denied.status, 403, taskKey);
    const body = (await denied.json()) as { error?: string };
    assert.equal(body.error, "Forbidden");
    assert.equal(await taskStatus(task.id), "ACTIVE");
    const rows = await denialRows(task.id);
    assert.equal(rows.length, 1);
    assertDenial(rows[0]!, { userId: A.agent.user.id, role: "Agent", brokerageId: A.brokerageId, taskId: task.id });
  }

  const pitTask = await insertTask({
    taskKey: "CONFIRM_TRANSACTION_RECORD_COMPLETE",
    transactionId,
    title: `Secret checklist pit ${suffix}`,
  });
  const pitDenied = await postJson(`/tasks/${pitTask.id}/complete`, pitCrew.cookie);
  assert.equal(pitDenied.status, 403);
  assert.equal(((await pitDenied.json()) as { error?: string }).error, "Forbidden");
  const pitRows = await denialRows(pitTask.id);
  assert.equal(pitRows.length, 1);
  assertDenial(pitRows[0]!, { userId: pitCrew.user.id, role: "Pit Crew", brokerageId: A.brokerageId, taskId: pitTask.id });
  assert.equal(await taskStatus(pitTask.id), "ACTIVE");
});

test("a Brokerage Administrator can complete S1, S2, and S3", async () => {
  for (const taskKey of SIGNOFF_KEYS) {
    const task = await insertTask({ taskKey, transactionId });
    const completed = await postJson(`/tasks/${task.id}/complete`, A.admin.cookie);
    assert.equal(completed.status, 200, taskKey);
    const body = (await completed.json()) as { task: { status: string; taskKey: string } };
    assert.equal(body.task.status, "COMPLETED");
    assert.equal(body.task.taskKey, taskKey);
    assert.equal((await denialRows(task.id)).length, 0);
  }
});

test("a transaction-linked task or Run property workflow without run.access is 403 and is not completed", async () => {
  const task = await insertTask({ taskKey: "PREPARE_CONTRACT_DOCUMENTATION", transactionId });
  const propertyTask = await insertTask({ taskKey: "VERIFY_REGISTERED_PROPERTY_OWNERS", transactionId: null });
  const signoff = await insertTask({ taskKey: "RECORD_RETENTION_CLOSURE_CHECK", transactionId });
  const item = await insertAttention({ reasonCode: "MISSING_SETTLEMENT_DATE", transactionId });
  const propertyItem = await insertAttention({ reasonCode: "MISSING_REGISTERED_OWNER", transactionId: null });

  await setRunAccess(A.brokerageId, false);
  try {
    await assertNotEntitled(await postJson(`/tasks/${task.id}/complete`, A.agent.cookie));
    await assertNotEntitled(await postJson(`/tasks/${propertyTask.id}/complete`, A.agent.cookie));
    await assertNotEntitled(await postJson(`/tasks/${signoff.id}/complete`, A.admin.cookie));
    await assertNotEntitled(await postJson(`/tasks/attention-items/${item.id}/resolve`, A.agent.cookie, {}));
    await assertNotEntitled(await postJson(`/tasks/attention-items/${propertyItem.id}/resolve`, A.agent.cookie, {}));
  } finally {
    await setRunAccess(A.brokerageId, true);
  }

  assert.equal(await taskStatus(task.id), "ACTIVE");
  assert.equal(await taskStatus(propertyTask.id), "ACTIVE");
  assert.equal(await taskStatus(signoff.id), "ACTIVE");
  assert.equal((await denialRows(signoff.id)).length, 0, "an entitlement refusal is not a role-denial audit");
  const [stillOpen] = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.id, item.id));
  assert.equal(stillOpen?.status, "OPEN");
});

test("another brokerage's task or attention item is 404, including when that caller has no run.access", async () => {
  const task = await insertTask({ taskKey: "CONFIRM_TRANSACTION_RECORD_COMPLETE", transactionId, title: `Hidden sign-off ${suffix}` });
  const item = await insertAttention({ reasonCode: "OTHER", transactionId });

  await setRunAccess(B.brokerageId, false);
  try {
    const complete = await postJson(`/tasks/${task.id}/complete`, B.agent.cookie);
    assert.equal(complete.status, 404);
    const completeBody = (await complete.json()) as { error?: string };
    assert.equal(completeBody.error, "NOT_FOUND");
    assert.equal(JSON.stringify(completeBody).includes(task.title), false);

    const resolve = await postJson(`/tasks/attention-items/${item.id}/resolve`, B.admin.cookie, { notes: "nope" });
    assert.equal(resolve.status, 404);
    const resolveBody = (await resolve.json()) as { error?: string };
    assert.match(resolveBody.error ?? "", /not found/i);
    assert.equal(JSON.stringify(resolveBody).includes(item.summary), false);
  } finally {
    await setRunAccess(B.brokerageId, true);
  }

  assert.equal(await taskStatus(task.id), "ACTIVE");
  assert.equal((await denialRows(task.id)).length, 0);
  const [stillOpen] = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.id, item.id));
  assert.equal(stillOpen?.status, "OPEN");
});

test("a non-Run task and a Grow commitment still complete when run.access is absent", async () => {
  const task = await insertTask({ taskKey: "GROW_CONTACT_FOLLOW_UP", transactionId: null, title: "Call the vendor back" });
  const item = await insertAttention({ reasonCode: "MANUAL_REVIEW_REQUIRED", transactionId: null });

  const created = await postJson(`/grow/contacts/${buyerPartyId}/commitments`, A.agent.cookie, {
    description: "Send the market report",
    dueAt: "2027-03-01",
  });
  assert.equal(created.status, 201, await created.clone().text());
  const commitmentId = ((await created.json()) as { commitment: { id: number } }).commitment.id;

  await setRunAccess(A.brokerageId, false);
  try {
    const complete = await postJson(`/tasks/${task.id}/complete`, A.agent.cookie);
    assert.equal(complete.status, 200);
    assert.equal(((await complete.json()) as { task: { status: string } }).task.status, "COMPLETED");

    const resolve = await postJson(`/tasks/attention-items/${item.id}/resolve`, A.agent.cookie, { notes: "Done outside Run" });
    assert.equal(resolve.status, 200);

    const grow = await patchJson(`/grow/contacts/commitments/${commitmentId}`, A.agent.cookie, { status: "Completed" });
    assert.equal(grow.status, 200, await grow.clone().text());
    const growBody = (await grow.json()) as { commitment: { status: string } };
    assert.equal(growBody.commitment.status, "Completed");
  } finally {
    await setRunAccess(A.brokerageId, true);
  }

  const [commitment] = await db.select().from(growCommitments).where(eq(growCommitments.id, commitmentId));
  assert.equal(commitment?.status, "Completed");
  assert.equal((await denialRows(task.id)).length, 0);
});
