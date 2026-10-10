// R-F30 — transaction lifecycle order and a terminal Closed state.
// R-F36 — routine settlement completion also requires unconditional status.
// Same HTTP harness as runTransactionVerticalSlice.test.ts and
// propertyTimeline.test.ts: a real Express app, real session auth, and
// createTransactionFromListedProperty. No web change is covered here.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, transactions, properties, auditLogs, transactionConditions } from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  getDomainEventsForProperty,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

function headers(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

function closedMessage(transactionId: number): string {
  return `Transaction ${transactionId} is closed — no further changes can be recorded.`;
}

async function loadTransaction(transactionId: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!row) throw new Error(`transaction ${transactionId} missing`);
  return row;
}

async function loadProperty(propertyId: number) {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!row) throw new Error(`property ${propertyId} missing`);
  return row;
}

async function auditIds(propertyId: number): Promise<number[]> {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.propertyId, propertyId));
  return rows.map((row) => row.id).sort((a, b) => a - b);
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

  A = await createBrokerageWithUsers(baseUrl, `R-F30 Lifecycle A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F30 Lifecycle B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("settlement cannot be scheduled or completed before the contract is signed, and another brokerage still gets 404", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Lifecycle Guard Ave ${suffix}`,
    settlementDate: "2027-04-20",
  });

  const beforeTx = await loadTransaction(transactionId);
  const beforeProperty = await loadProperty(propertyId);
  assert.equal(beforeTx.status, "ContractPreparation");
  assert.equal(beforeTx.contractDate, null);
  assert.ok(beforeTx.settlementDate, "accepted-offer carry-forward must already have a settlement date");
  const beforeAudits = await auditIds(propertyId);

  const scheduleRes = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-05-01",
  });
  assert.equal(scheduleRes.status, 400);
  const scheduleBody = await bodyOf<{ error: string }>(scheduleRes);
  assert.equal(scheduleBody.error, `Transaction ${transactionId} cannot schedule settlement before the contract is signed.`);

  const afterScheduleTx = await loadTransaction(transactionId);
  const afterScheduleProperty = await loadProperty(propertyId);
  assert.equal(afterScheduleTx.status, beforeTx.status);
  assert.equal(afterScheduleTx.settlementDate?.toISOString(), beforeTx.settlementDate?.toISOString());
  assert.equal(afterScheduleProperty.workflowStage, beforeProperty.workflowStage);
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_SCHEDULED")).length, 0);
  assert.deepEqual(await auditIds(propertyId), beforeAudits);

  // Prerequisite behaviour, not a role test: the caller is a Brokerage Administrator
  // so the settlement-complete gate does not answer 403 before this check.
  const completeRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(completeRes.status, 400);
  const completeBody = await bodyOf<{ error: string }>(completeRes);
  assert.equal(completeBody.error, `Transaction ${transactionId} cannot complete settlement before the contract is signed.`);

  const afterCompleteTx = await loadTransaction(transactionId);
  const afterCompleteProperty = await loadProperty(propertyId);
  assert.equal(afterCompleteTx.status, "ContractPreparation");
  assert.equal(afterCompleteTx.settlementCompletedAt, null);
  assert.equal(afterCompleteProperty.workflowStage, beforeProperty.workflowStage);
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_COMPLETED")).length, 0);
  assert.deepEqual(await auditIds(propertyId), beforeAudits);

  const foreignRes = await postJson(`/transactions/${transactionId}/settlement-schedule`, B.agent.cookie, {
    settlementDate: "2027-05-01",
  });
  assert.equal(foreignRes.status, 404);
  const foreignBody = await bodyOf<{ error: string }>(foreignRes);
  assert.equal(foreignBody.error, "Not found");
  assert.deepEqual(await loadTransaction(transactionId), afterCompleteTx);
});

test("contract-signed advances only ContractPreparation and refuses Settled or Closed when the contract date is missing", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `2 Contract Order Rd ${suffix}`,
  });

  const prepared = await loadProperty(propertyId);
  assert.equal((await loadTransaction(transactionId)).status, "ContractPreparation");

  const signedRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signedRes.status, 200);
  const signed = await loadTransaction(transactionId);
  const signedProperty = await loadProperty(propertyId);
  assert.equal(signed.status, "UnderContract");
  assert.ok(signed.contractDate);
  assert.equal(signedProperty.workflowStage, "Contract");
  assert.notEqual(signedProperty.workflowStage, prepared.workflowStage);

  await db
    .update(transactions)
    .set({
      status: "SettlementScheduled",
      contractDate: null,
      settlementDate: new Date("2027-08-15T00:00:00.000Z"),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transactionId));
  await db
    .update(properties)
    .set({ workflowStage: "Settlement", updatedAt: new Date() })
    .where(eq(properties.id, propertyId));

  const legacyRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(legacyRes.status, 200);
  const legacy = await loadTransaction(transactionId);
  const legacyProperty = await loadProperty(propertyId);
  assert.equal(legacy.status, "SettlementScheduled");
  assert.equal(legacyProperty.workflowStage, "Settlement");
  assert.ok(legacy.contractDate, "the contract date is still recorded; only the backward status move is refused");

  const auditsBeforeSettled = await auditIds(propertyId);
  await db
    .update(transactions)
    .set({
      status: "Settled",
      contractDate: null,
      settlementDate: new Date("2027-09-01T00:00:00.000Z"),
      settlementCompletedAt: new Date("2027-09-02T00:00:00.000Z"),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transactionId));
  await db.update(properties).set({ workflowStage: "Settlement", updatedAt: new Date() }).where(eq(properties.id, propertyId));

  const settledRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(settledRes.status, 400);
  const settledBody = await bodyOf<{ error: string }>(settledRes);
  assert.equal(settledBody.error, `Transaction ${transactionId} cannot record a signed contract after settlement.`);
  const settled = await loadTransaction(transactionId);
  assert.equal(settled.status, "Settled");
  assert.equal(settled.contractDate, null);
  assert.equal((await loadProperty(propertyId)).workflowStage, "Settlement");
  assert.deepEqual(await auditIds(propertyId), auditsBeforeSettled);

  await db
    .update(transactions)
    .set({ status: "Closed", contractDate: null, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));

  const closedRes = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(closedRes.status, 400);
  const closedBody = await bodyOf<{ error: string }>(closedRes);
  assert.equal(closedBody.error, closedMessage(transactionId));
  const closed = await loadTransaction(transactionId);
  assert.equal(closed.status, "Closed");
  assert.equal(closed.contractDate, null);
  assert.equal((await loadProperty(propertyId)).workflowStage, "Settlement");
  assert.deepEqual(await auditIds(propertyId), auditsBeforeSettled);
});

test("a closed transaction rejects later writers and still accepts idempotent replays", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `3 Closed Terminal St ${suffix}`,
    conditionsText: "Subject to building inspection",
  });

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.admin.cookie);
  assert.equal(signed.status, 200, await signed.text());
  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.admin.cookie, {
    settlementDate: "2027-06-01",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());
  // Completion now requires unconditionalAt. Leave exchangedAt unset so the
  // exchange attempt after close is still a would-write, not an idempotent replay.
  await db
    .update(transactions)
    .set({ unconditionalAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));
  const completed = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(completed.status, 200, await completed.text());
  const paid = await postJson(`/transactions/${transactionId}/agent-paid`, A.admin.cookie);
  assert.equal(paid.status, 200, await paid.text());
  const closed = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie, { force: true });
  assert.equal(closed.status, 200, await closed.text());

  const closedRow = await loadTransaction(transactionId);
  assert.equal(closedRow.status, "Closed");
  assert.equal(closedRow.exchangedAt, null, "exchange must still be a would-write after this close");
  assert.ok(closedRow.contractDate);
  assert.ok(closedRow.settlementCompletedAt);
  assert.ok(closedRow.agentPaidAt);
  assert.ok(closedRow.commissionCalculatedAt);

  const [condition] = await db.select().from(transactionConditions).where(eq(transactionConditions.transactionId, transactionId));
  assert.ok(condition, "the accepted offer must have carried a condition forward");

  const beforeRow = await loadTransaction(transactionId);
  const beforeCondition = condition;
  const beforeAudits = await auditIds(propertyId);

  const attempts: Array<{ label: string; path: string; body?: unknown }> = [
    { label: "funds-received", path: `/transactions/${transactionId}/funds-received`, body: { amountCents: 100 } },
    { label: "calculate-commission", path: `/transactions/${transactionId}/calculate-commission`, body: { force: true } },
    { label: "finance-approved", path: `/transactions/${transactionId}/finance-approved` },
    {
      label: "legal-representatives",
      path: `/transactions/${transactionId}/legal-representatives`,
      body: { sellerSolicitorPartyId: 1 },
    },
    { label: "conditions add", path: `/transactions/${transactionId}/conditions`, body: { description: "Late special condition" } },
    {
      label: "condition reschedule",
      path: `/transactions/conditions/${condition.id}/reschedule`,
      body: { newDueDate: "2027-07-01" },
    },
    {
      label: "condition resolve",
      path: `/transactions/conditions/${condition.id}/resolve`,
      body: { status: "Waived" },
    },
    { label: "exchange", path: `/transactions/${transactionId}/exchange` },
  ];

  for (const attempt of attempts) {
    const res = await postJson(attempt.path, A.admin.cookie, attempt.body);
    const text = await res.text();
    assert.equal(res.status, 400, `${attempt.label}: ${text}`);
    const body = JSON.parse(text) as { error?: string };
    assert.equal(body.error, closedMessage(transactionId), attempt.label);
  }

  assert.deepEqual(await loadTransaction(transactionId), beforeRow);
  const [afterCondition] = await db.select().from(transactionConditions).where(eq(transactionConditions.id, condition.id));
  assert.deepEqual(afterCondition, beforeCondition);
  assert.deepEqual(await auditIds(propertyId), beforeAudits);

  const replays: Array<{ label: string; path: string; body?: unknown }> = [
    { label: "close", path: `/transactions/${transactionId}/close` },
    { label: "contract-signed", path: `/transactions/${transactionId}/contract-signed` },
    { label: "settlement-complete", path: `/transactions/${transactionId}/settlement-complete` },
    { label: "agent-paid", path: `/transactions/${transactionId}/agent-paid` },
  ];
  for (const replay of replays) {
    const res = await postJson(replay.path, A.admin.cookie, replay.body);
    const text = await res.text();
    assert.equal(res.status, 200, `${replay.label}: ${text}`);
  }

  assert.deepEqual(await loadTransaction(transactionId), beforeRow);
  assert.deepEqual(await auditIds(propertyId), beforeAudits);
});

test("signed but still conditional settlement completion is refused and changes nothing", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `4 Conditional Settlement Ave ${suffix}`,
    conditionsText: "Subject to finance",
    settlementDate: "2027-05-20",
  });

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200, await signed.text());
  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-06-20",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());

  const beforeTx = await loadTransaction(transactionId);
  const beforeProperty = await loadProperty(propertyId);
  assert.equal(beforeTx.status, "SettlementScheduled");
  assert.ok(beforeTx.contractDate);
  assert.equal(beforeTx.unconditionalAt, null);
  assert.equal(beforeProperty.workflowStage, "Settlement");
  const beforeAudits = await auditIds(propertyId);

  const completeRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(completeRes.status, 400);
  const completeBody = await bodyOf<{ error: string }>(completeRes);
  assert.equal(completeBody.error, `Transaction ${transactionId} cannot complete settlement until it is unconditional.`);

  const afterTx = await loadTransaction(transactionId);
  const afterProperty = await loadProperty(propertyId);
  assert.equal(afterTx.status, beforeTx.status);
  assert.equal(afterProperty.workflowStage, beforeProperty.workflowStage);
  assert.equal(afterTx.grossCommissionCents, beforeTx.grossCommissionCents);
  assert.equal(afterTx.gstCents, beforeTx.gstCents);
  assert.equal(afterTx.commissionCalculatedAt?.toISOString() ?? null, beforeTx.commissionCalculatedAt?.toISOString() ?? null);
  assert.deepEqual(afterTx, beforeTx);
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_COMPLETED")).length, 0);
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.propertyId, propertyId));
  assert.equal(
    audits.filter((row) => row.action === "settlement_completed" || row.action === "SETTLEMENT_COMPLETED").length,
    0,
  );
  assert.deepEqual(await auditIds(propertyId), beforeAudits);

  const foreignRes = await postJson(`/transactions/${transactionId}/settlement-complete`, B.agent.cookie);
  assert.equal(foreignRes.status, 404);
  const foreignBody = await bodyOf<{ error: string }>(foreignRes);
  assert.equal(foreignBody.error, "Not found");
  assert.deepEqual(await loadTransaction(transactionId), beforeTx);
  assert.equal((await loadProperty(propertyId)).workflowStage, beforeProperty.workflowStage);
  assert.deepEqual(await auditIds(propertyId), beforeAudits);
});

test("signed unconditional settlement completes as before, and a replay stays 200", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `5 Unconditional Settlement Rd ${suffix}`,
    conditionsText: "",
    settlementDate: "2027-07-01",
  });

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200, await signed.text());
  const exchange = await postJson(`/transactions/${transactionId}/exchange`, A.agent.cookie);
  assert.equal(exchange.status, 200, await exchange.text());
  const exchanged = await loadTransaction(transactionId);
  assert.ok(exchanged.contractDate);
  assert.ok(exchanged.unconditionalAt, "a signed contract with no tracked conditions becomes unconditional on exchange");

  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-07-15",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());

  const beforeForeign = await loadTransaction(transactionId);
  const foreignRes = await postJson(`/transactions/${transactionId}/settlement-complete`, B.agent.cookie);
  assert.equal(foreignRes.status, 404);
  const foreignBody = await bodyOf<{ error: string }>(foreignRes);
  assert.equal(foreignBody.error, "Not found");
  assert.deepEqual(await loadTransaction(transactionId), beforeForeign);
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_COMPLETED")).length, 0);

  const completeRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(completeRes.status, 200, await completeRes.text());
  const settled = await loadTransaction(transactionId);
  assert.equal(settled.status, "Settled");
  assert.ok(settled.settlementCompletedAt);
  assert.ok(settled.grossCommissionCents && settled.grossCommissionCents > 0, "completion still auto-calculates commission");
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_COMPLETED")).length, 1);
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.propertyId, propertyId));
  assert.equal(audits.filter((row) => row.action === "settlement_completed").length, 1);

  const auditsAfterComplete = await auditIds(propertyId);
  const replayRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(replayRes.status, 200, await replayRes.text());
  const replayed = await loadTransaction(transactionId);
  assert.equal(replayed.status, "Settled");
  assert.equal(replayed.settlementCompletedAt?.toISOString(), settled.settlementCompletedAt?.toISOString());
  assert.deepEqual(replayed, settled);
  assert.equal((await getDomainEventsForProperty(propertyId, "SETTLEMENT_COMPLETED")).length, 1);
  assert.deepEqual(await auditIds(propertyId), auditsAfterComplete);
});
