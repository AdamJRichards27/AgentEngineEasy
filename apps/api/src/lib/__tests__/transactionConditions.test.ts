// Run Transaction Vertical Slice (#124) — Stage E: Contract & Conditions
// (apps/api/src/lib/transactionConditions.ts). CONTRACT_EXCHANGED and
// TRANSACTION_UNCONDITIONAL existed in the canonical event registry with
// zero publishers before this build. These tests prove: exchange requires
// a signed contract and is idempotent; a transaction with zero tracked
// conditions becomes unconditional the moment it is exchanged (vacuous
// truth, matching a real cash/unconditional contract); resolving every
// condition to a non-blocking status auto-fires TRANSACTION_UNCONDITIONAL
// exactly once; a Failed condition blocks it until waived; reschedules
// preserve due-date history rather than overwriting it; and every entry
// point enforces tenant isolation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, transactions } from "@aee/db";
import {
  listConditions,
  addCondition,
  rescheduleConditionDueDate,
  resolveCondition,
  recordExchange,
  maybeRecordUnconditional,
} from "../transactionConditions.js";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  getDomainEventsForProperty,
  type DevLoginResult,
} from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Run Vertical Slice Conditions A ${suffix}`;
const brokerageBName = `Run Vertical Slice Conditions B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

async function signContract(cookie: string, transactionId: number) {
  const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/contract-signed`, { method: "POST", headers: { cookie } });
  if (res.status !== 200) throw new Error(`contract-signed failed: ${res.status} ${await res.text()}`);
}

async function loadTransaction(transactionId: number) {
  const [row] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  return row;
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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("recordExchange refuses a transaction whose contract has not been signed yet", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "1 Conditions Test Way",
    conditionsText: "",
  });
  await assert.rejects(
    () => recordExchange({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
    /cannot be exchanged before the contract is signed/i,
  );
  // Cleanup happens via cleanupBrokerages in after(); no per-test teardown needed.
  void propertyId;
});

test("a transaction with zero tracked conditions becomes unconditional the instant it is exchanged, and both events fire exactly once across a duplicate exchange call", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "2 Vacuous Unconditional St",
    conditionsText: "", // offer carried no free-text condition -> zero transactionConditions rows
  });
  await signContract(A.agent.cookie, transactionId);

  const conditions = await listConditions(transactionId);
  assert.equal(conditions.length, 0, "this fixture must start with zero conditions to exercise the vacuous-truth path");

  const exchanged = await recordExchange({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.ok(exchanged.exchangedAt);
  assert.ok(exchanged.unconditionalAt, "zero conditions + exchanged must become unconditional automatically");

  // Idempotency: calling exchange again must not move the timestamps or
  // double-publish either event.
  const exchangedAgain = await recordExchange({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(exchangedAgain.exchangedAt?.getTime(), exchanged.exchangedAt?.getTime());
  assert.equal(exchangedAgain.unconditionalAt?.getTime(), exchanged.unconditionalAt?.getTime());

  const exchangedEvents = await getDomainEventsForProperty(propertyId, "CONTRACT_EXCHANGED");
  assert.equal(exchangedEvents.length, 1);
  const unconditionalEvents = await getDomainEventsForProperty(propertyId, "TRANSACTION_UNCONDITIONAL");
  assert.equal(unconditionalEvents.length, 1);
});

test("resolving every Pending condition to a non-blocking status auto-marks the transaction unconditional exactly once; a Failed condition blocks it until waived", async () => {
  const { propertyId, transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "3 Blocking Condition Rd",
    conditionsText: "", // the free-text offer condition is separate from the finance condition we add explicitly below
  });
  await signContract(A.agent.cookie, transactionId);
  await recordExchange({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });

  const financeCondition = await addCondition({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    description: "Subject to finance approval",
  });
  const inspectionCondition = await addCondition({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    description: "Subject to building & pest inspection",
  });

  // Adding a condition after exchange must have reopened the transaction --
  // it was vacuously unconditional a moment ago (zero conditions), and now
  // has two Pending ones.
  let current = await loadTransaction(transactionId);
  assert.equal(current.unconditionalAt, null, "adding a Pending condition must not leave a stale unconditionalAt from before it existed");

  await resolveCondition({ conditionId: financeCondition.id, userId: A.agent.user.id, brokerageId: A.brokerageId, status: "Satisfied" });
  current = await loadTransaction(transactionId);
  assert.equal(current.unconditionalAt, null, "one condition still Pending must keep the transaction conditional");

  await resolveCondition({ conditionId: inspectionCondition.id, userId: A.agent.user.id, brokerageId: A.brokerageId, status: "Failed" });
  current = await loadTransaction(transactionId);
  assert.equal(current.unconditionalAt, null, "a Failed condition must block automatic unconditional, not just a Pending one");

  await resolveCondition({
    conditionId: inspectionCondition.id,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    status: "Waived",
    notes: "Buyer proceeded despite inspection findings",
  });
  current = await loadTransaction(transactionId);
  assert.ok(current.unconditionalAt, "waiving the last blocking condition must trigger automatic unconditional");

  const unconditionalEvents = await getDomainEventsForProperty(propertyId, "TRANSACTION_UNCONDITIONAL");
  assert.equal(unconditionalEvents.length, 1, "TRANSACTION_UNCONDITIONAL must fire exactly once even though maybeRecordUnconditional ran after every resolve");

  const finalConditions = await listConditions(transactionId);
  assert.equal(finalConditions.find((c) => c.id === financeCondition.id)?.status, "Satisfied");
  assert.equal(finalConditions.find((c) => c.id === inspectionCondition.id)?.status, "Waived");
});

test("rescheduleConditionDueDate appends to dueDateHistory rather than overwriting it", async () => {
  const { transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "4 Reschedule History Cl",
    conditionsText: "",
  });
  const condition = await addCondition({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    description: "Subject to finance",
    dueDate: new Date("2027-02-01"),
  });

  const first = await rescheduleConditionDueDate({
    conditionId: condition.id,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    newDueDate: new Date("2027-02-15"),
  });
  assert.equal(Array.isArray(first.dueDateHistory) ? first.dueDateHistory.length : -1, 1);

  const second = await rescheduleConditionDueDate({
    conditionId: condition.id,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    newDueDate: new Date("2027-03-01"),
  });
  assert.equal(Array.isArray(second.dueDateHistory) ? second.dueDateHistory.length : -1, 2, "every prior due date must survive, never be overwritten in place");
  assert.equal(new Date(second.dueDate as unknown as string).toISOString().slice(0, 10), "2027-03-01");
});

test("addCondition, rescheduleConditionDueDate, and resolveCondition all enforce tenant isolation", async () => {
  const { transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "5 Tenant Isolation Pl",
    conditionsText: "",
  });

  await assert.rejects(
    () => addCondition({ transactionId, userId: B.agent.user.id, brokerageId: B.brokerageId, description: "Should be rejected" }),
    /not found/i,
  );

  const legitCondition = await addCondition({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    description: "Legitimate condition",
  });

  await assert.rejects(
    () =>
      rescheduleConditionDueDate({
        conditionId: legitCondition.id,
        userId: B.agent.user.id,
        brokerageId: B.brokerageId,
        newDueDate: new Date("2027-05-01"),
      }),
    /not found/i,
  );

  await assert.rejects(
    () =>
      resolveCondition({
        conditionId: legitCondition.id,
        userId: B.agent.user.id,
        brokerageId: B.brokerageId,
        status: "Satisfied",
      }),
    /not found/i,
  );
});
