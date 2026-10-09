// Run Transaction Vertical Slice (#124) — Stage D/F/H:
// apps/api/src/lib/transactions.ts. Covers the three highest-risk changes
// in this build: acceptOffer's new db.transaction()-based property-row
// lock (this codebase's first use of it) actually serialises a genuine
// concurrent-accept race rather than merely looking like it does; the
// previously-confirmed data-loss gap where offer conditions (deposit,
// settlement date, free text) were discarded at acceptance is fixed;
// buyer AML/CTF linkage now actually fires on contract signing; and
// closeTransaction's new real preconditions (#121) report every genuine
// blocker and force:true is a deliberate, distinctly-audited override.
//
// Also covers Part B Stage 2 remediation: completeSettlement and
// closeTransaction now wrap their transactions/properties/workflowSteps
// writes in a single db.transaction() instead of several separate
// statements, so a crash partway through rolls everything back instead of
// leaving workflowSteps permanently stale behind an idempotent guard that
// would otherwise make a retry silently short-circuit. See the two
// "rolls back atomically ... and a retry converges" tests below, and the
// commit/PR description for the full incident this closes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  transactions,
  properties,
  workflows,
  workflowSteps,
  amlVerifications,
  auditLogs,
  automationAttentionItems,
  automationTasks,
} from "@aee/db";
import {
  acceptOffer,
  recordContractSigned,
  recordLegalRepresentatives,
  scheduleSettlement,
  completeSettlement,
  closeTransaction,
  TransactionClosureBlockedError,
} from "../transactions.js";
import { addCondition, listConditions } from "../transactionConditions.js";
import {
  createBrokerageWithUsers,
  createListedProperty,
  createTransactionFromListedProperty,
  cleanupBrokerages,
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
const brokerageAName = `Run Vertical Slice Transactions A ${suffix}`;
const brokerageBName = `Run Vertical Slice Transactions B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

async function createOfferOnProperty(cookie: string, propertyId: number, offerPriceCents: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      offerPriceCents,
      conditions: {},
      buyer: { firstName: "Buyer", lastName: String(offerPriceCents), email: `buyer-${offerPriceCents}-${Date.now()}@example.com` },
    }),
  });
  if (res.status !== 201) throw new Error(`create offer failed: ${res.status} ${await res.text()}`);
  const { offer } = await json<{ offer: { id: number } }>(res);
  return offer.id;
}

// Part B Stage 2 remediation test support: simulates the exact failure mode
// completeSettlement/closeTransaction's new db.transaction() wrapping
// protects against -- a crash partway through the write sequence -- by
// installing a one-shot Postgres trigger that raises on the workflow_steps
// row refreshTransactionSteps would otherwise update. `stepId` is always a
// real workflowSteps.id read back from the database in the test itself, so
// this is safe string interpolation, not user input.
async function installFaultTrigger(stepId: number): Promise<void> {
  await db.execute(
    sql.raw(`
      create or replace function fault_fn_${stepId}() returns trigger as $body$
      begin
        raise exception 'stage2_fault_injected: simulated crash mid db.transaction() (workflow_steps.id=${stepId})';
      end;
      $body$ language plpgsql;
    `),
  );
  await db.execute(
    sql.raw(`
      create trigger fault_trg_${stepId}
      before update on workflow_steps
      for each row
      when (old.id = ${stepId})
      execute function fault_fn_${stepId}();
    `),
  );
}

async function removeFaultTrigger(stepId: number): Promise<void> {
  await db.execute(sql.raw(`drop trigger if exists fault_trg_${stepId} on workflow_steps;`));
  await db.execute(sql.raw(`drop function if exists fault_fn_${stepId}();`));
}

// drizzle-orm's node-postgres driver wraps a failing query in its own
// "Failed query: ..." error rather than surfacing the raised Postgres
// exception text at the top level, so matching err.message against the
// raw RAISE EXCEPTION string is unreliable. The wrapped message does
// include the failing query's bind params, though -- and workflow_steps.id
// is always the last one -- so asserting the rejection is actually our
// fault-injected trigger (not some unrelated bug) means checking for
// either the raw message (in case a driver upgrade changes the wrapping)
// or the target row id.
async function assertFaultRejection(action: () => Promise<unknown>, stepId: number): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Error, "expected the fault-injected trigger to make this call reject, but it resolved");
  const cause = (caught as { cause?: unknown }).cause;
  const combined = `${(caught as Error).message} | ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  assert.ok(
    combined.includes("stage2_fault_injected") || combined.includes(String(stepId)),
    `expected the rejection to be caused by the fault-injected trigger on workflow_steps.id=${stepId}, got: ${combined}`,
  );
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

test("acceptOffer serialises a genuine concurrent-accept race: exactly one Transaction is created for the property, and the loser fails cleanly", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: "1 Concurrency Test Rd" });
  const offerIdOne = await createOfferOnProperty(A.agent.cookie, propertyId, 70000000);
  const offerIdTwo = await createOfferOnProperty(A.agent.cookie, propertyId, 75000000);

  const [resOne, resTwo] = await Promise.all([
    fetch(`${baseUrl}/api/offers/${offerIdOne}/accept`, { method: "POST", headers: { cookie: A.agent.cookie } }),
    fetch(`${baseUrl}/api/offers/${offerIdTwo}/accept`, { method: "POST", headers: { cookie: A.agent.cookie } }),
  ]);
  const statuses = [resOne.status, resTwo.status].sort();
  assert.deepEqual(statuses, [201, 400], `exactly one accept must succeed and the other must fail cleanly, got ${JSON.stringify(statuses)}`);

  const transactionRows = await db.select().from(transactions).where(eq(transactions.propertyId, propertyId));
  assert.equal(transactionRows.length, 1, "the property-row lock must prevent two Transactions ever being created for the same property");
});

test("acceptOffer carries forward deposit, settlement date, and free-text conditions from the offer onto the Transaction and a transactionConditions row", async () => {
  const { transactionId, offerId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "2 Carry Forward Ave",
    offerPriceCents: 90000000,
    depositCents: 4500000,
    settlementDate: "2027-03-20",
    conditionsText: "Subject to sale of buyer's existing property",
  });
  void offerId;

  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  assert.equal(transaction.depositCents, 4500000);
  assert.equal(transaction.settlementDate?.toISOString().slice(0, 10), "2027-03-20");

  const conditions = await listConditions(transactionId);
  const carriedCondition = conditions.find((c) => c.description === "Subject to sale of buyer's existing property");
  assert.ok(carriedCondition, "the offer's free-text condition must survive as a real transactionConditions row, not be discarded");
  assert.equal(carriedCondition?.status, "Pending");
});

test("acceptOffer is idempotent: accepting an already-Accepted offer returns the existing Transaction rather than creating a second one", async () => {
  const { propertyId, offerId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "3 Idempotent Accept St" });

  const result = await acceptOffer({ offerId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(result.created, false);

  const transactionRows = await db.select().from(transactions).where(eq(transactions.propertyId, propertyId));
  assert.equal(transactionRows.length, 1);
});

test("recordContractSigned is idempotent on contractDate and initiates AML for every buyer party exactly once", async () => {
  const { transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "4 Buyer AML Wiring Cl" });

  const signed = await recordContractSigned({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.ok(signed.contractDate);

  const signedAgain = await recordContractSigned({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(signedAgain.contractDate?.getTime(), signed.contractDate?.getTime());

  const buyerPartyIds = Array.isArray(signed.buyerPartyIds) ? (signed.buyerPartyIds as number[]) : [];
  assert.ok(buyerPartyIds.length > 0, "the fixture's offer must have created a real buyer party");
  const verifications = await db.select().from(amlVerifications).where(eq(amlVerifications.partyId, buyerPartyIds[0]));
  assert.equal(verifications.length, 1, "buyer AML must be initiated exactly once, even though recordContractSigned was called twice");
});

test("recordLegalRepresentatives applies partial updates: undefined leaves the existing value untouched, explicit null clears it", async () => {
  const { transactionId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "5 Legal Reps Rd" });

  const firstUpdate = await recordLegalRepresentatives({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    sellerSolicitorPartyId: 111,
  });
  const firstReps = firstUpdate.legalRepresentatives as { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null };
  assert.equal(firstReps.sellerSolicitorPartyId, 111);
  assert.equal(firstReps.buyerSolicitorPartyId ?? null, null);

  const secondUpdate = await recordLegalRepresentatives({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    buyerSolicitorPartyId: 222,
    // sellerSolicitorPartyId intentionally omitted (undefined) -- must stay 111.
  });
  const secondReps = secondUpdate.legalRepresentatives as { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null };
  assert.equal(secondReps.sellerSolicitorPartyId, 111, "omitting a field must leave its existing value untouched");
  assert.equal(secondReps.buyerSolicitorPartyId, 222);

  const thirdUpdate = await recordLegalRepresentatives({
    transactionId,
    userId: A.agent.user.id,
    brokerageId: A.brokerageId,
    sellerSolicitorPartyId: null,
  });
  const thirdReps = thirdUpdate.legalRepresentatives as { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null };
  assert.equal(thirdReps.sellerSolicitorPartyId, null, "an explicit null must clear the field");
  assert.equal(thirdReps.buyerSolicitorPartyId, 222, "clearing one side must not disturb the other");
});

test("closeTransaction reports every real blocker (unconditional, pending condition, incomplete buyer AML, open attention item, active task) and force:true bypasses them with a distinctly-audited close", async () => {
  const { transactionId, propertyId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: "6 Closure Blockers Way" });

  // Contract signed -> buyer AML initiated but not Complete (blocker 3);
  // never exchanged -> unconditionalAt stays null (blocker 1).
  await recordContractSigned({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  // A Pending condition that is deliberately never resolved (blocker 2).
  await addCondition({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, description: "Subject to finance" });

  // Reach Settled without completeSettlement. Routine completion now requires
  // unconditionalAt, and this test still needs that close blocker (plus the
  // pending condition and incomplete buyer AML) to stay in place.
  await scheduleSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, settlementDate: new Date("2027-04-01") });
  await db
    .update(transactions)
    .set({
      status: "Settled",
      settlementCompletedAt: new Date("2027-04-02T00:00:00.000Z"),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transactionId));

  // Manufacture blockers 4 and 5 directly -- a real open attention item and
  // a real active task, exactly the shape the WAE catalogue would create.
  await db.insert(automationAttentionItems).values({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    reasonCode: "OTHER",
    summary: "Manufactured for closure-blocker test coverage",
    status: "OPEN",
  });
  await db.insert(automationTasks).values({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    taskKey: "PREPARE_SETTLEMENT_TRACKING",
    kind: "TASK",
    title: "Manufactured for closure-blocker test coverage",
    status: "ACTIVE",
  });

  await assert.rejects(
    async () => {
      try {
        await closeTransaction({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
      } catch (err) {
        assert.ok(err instanceof TransactionClosureBlockedError, "must throw the typed TransactionClosureBlockedError, not a generic Error");
        assert.equal(err.blockers.length, 5, `expected all 5 blockers, got: ${JSON.stringify(err.blockers)}`);
        assert.ok(err.blockers.some((b) => /not become unconditional/i.test(b)));
        assert.ok(err.blockers.some((b) => /condition\(s\) are still Pending/i.test(b)));
        assert.ok(err.blockers.some((b) => /AML\/CTF verification is not complete/i.test(b)));
        assert.ok(err.blockers.some((b) => /open attention item/i.test(b)));
        assert.ok(err.blockers.some((b) => /active task/i.test(b)));
        throw err;
      }
    },
    TransactionClosureBlockedError,
  );

  const [stillOpen] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  assert.equal(stillOpen.status, "Settled", "an unforced blocked close must never change the transaction's status");

  const forced = await closeTransaction({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, force: true });
  assert.equal(forced.status, "Closed");
  assert.ok(forced.closedAt);

  const forcedAuditRows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, String(transactionId)), eq(auditLogs.action, "transaction_closed_forced")));
  assert.ok(forcedAuditRows.length > 0, "a forced close must be distinctly audited as transaction_closed_forced, not an ordinary transaction_closed");
});

test("completeSettlement rolls back atomically on a mid-transaction failure, and a retry converges every write (Part B Stage 2 remediation)", async () => {
  const { transactionId, propertyId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "7 Atomic Settlement Ln",
  });
  await recordContractSigned({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  await scheduleSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, settlementDate: new Date("2027-05-01") });

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "Transaction")));
  assert.ok(workflow, "accepting the offer must have created the Transaction workflow");
  const [settlementStep] = await db
    .select()
    .from(workflowSteps)
    .where(and(eq(workflowSteps.workflowId, workflow.id), eq(workflowSteps.stepKey, "Settlement")));
  assert.ok(settlementStep, "the Transaction workflow must have a Settlement step");
  assert.equal(settlementStep.status, "InProgress", "sanity check: contract is signed and settlement is scheduled but not yet completed");

  // The accepted offer carries a pending condition, so unconditionalAt is still
  // null. This test is about atomic rollback, not the completion gate.
  await db
    .update(transactions)
    .set({ unconditionalAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));

  // Force the workflowSteps write inside completeSettlement's db.transaction()
  // to fail, simulating the crash this remediation protects against (see
  // completeSettlement in lib/transactions.ts and refreshTransactionSteps in
  // lib/workflowSteps.ts).
  await installFaultTrigger(settlementStep.id);
  try {
    await assertFaultRejection(
      () => completeSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId }),
      settlementStep.id,
    );

    // Pre-fix, the transactions write and the workflowSteps refresh were two
    // separate statements: the first would already have committed here,
    // leaving settlementCompletedAt set while workflowSteps stayed stale
    // forever (the idempotent guard `if (transaction.settlementCompletedAt)
    // return transaction;` would then make every retry a silent no-op).
    // With the fix, both writes live in one db.transaction(), so the failed
    // workflowSteps write must roll back the transactions write too.
    const [afterFailure] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    assert.equal(afterFailure.status, "SettlementScheduled", "a failed completeSettlement must not leave the transaction Settled");
    assert.equal(afterFailure.settlementCompletedAt, null, "a failed completeSettlement must not leave settlementCompletedAt set");

    const [stepAfterFailure] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, settlementStep.id));
    assert.equal(stepAfterFailure.status, "InProgress", "the Settlement step must be unchanged by the rolled-back attempt");
  } finally {
    await removeFaultTrigger(settlementStep.id);
  }

  // Retry now that the transient fault is gone. Because the failed attempt
  // actually rolled back, settlementCompletedAt is still null, so the
  // idempotent guard does not short-circuit -- the retry re-runs the write
  // for real instead of silently returning stale state.
  const retried = await completeSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  assert.equal(retried.status, "Settled");
  assert.ok(retried.settlementCompletedAt, "the retry must actually complete settlement");

  const [stepAfterRetry] = await db.select().from(workflowSteps).where(eq(workflowSteps.id, settlementStep.id));
  assert.equal(stepAfterRetry.status, "Complete", "the retry must converge the Settlement step to Complete, not leave it stale");
});

test("closeTransaction rolls back atomically on a mid-transaction failure, and a retry converges every write (Part B Stage 2 remediation)", async () => {
  const { transactionId, propertyId } = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: "8 Atomic Closure Pl",
  });
  await recordContractSigned({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });
  await scheduleSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, settlementDate: new Date("2027-06-01") });
  // Same as the settlement atomicity fixture: the carried condition leaves
  // unconditionalAt null, and this test is about close rollback, not that gate.
  await db
    .update(transactions)
    .set({ unconditionalAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transactionId));
  await completeSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });

  const [propertyBefore] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.notEqual(propertyBefore.workflowStage, "Closed", "sanity check: the property must not already read Closed before this test's close attempt");

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "Transaction")));
  assert.ok(workflow, "accepting the offer must have created the Transaction workflow");
  const [payoutStep] = await db
    .select()
    .from(workflowSteps)
    .where(and(eq(workflowSteps.workflowId, workflow.id), eq(workflowSteps.stepKey, "Payout")));
  assert.ok(payoutStep, "the Transaction workflow must have a Payout step");

  // Force the workflowSteps write inside closeTransaction's db.transaction()
  // to fail. Pre-fix, this was the third of three separate statements
  // (transactions, then properties.workflowStage, then workflowSteps) -- a
  // crash here would already have committed the first two, leaving the
  // transaction Closed in the database while the property still read its
  // old workflow stage, with no way for a retry to notice or fix it (the
  // guard `if (transaction.status === "Closed") return transaction;` would
  // make the retry return immediately).
  await installFaultTrigger(payoutStep.id);
  try {
    await assertFaultRejection(
      () => closeTransaction({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, force: true }),
      payoutStep.id,
    );

    const [transactionAfterFailure] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    assert.equal(transactionAfterFailure.status, "Settled", "a failed closeTransaction must not leave the transaction Closed");
    assert.equal(transactionAfterFailure.closedAt, null, "a failed closeTransaction must not leave closedAt set");

    const [propertyAfterFailure] = await db.select().from(properties).where(eq(properties.id, propertyId));
    assert.equal(
      propertyAfterFailure.workflowStage,
      propertyBefore.workflowStage,
      "the properties.workflowStage write must roll back together with the transactions write, not commit alone",
    );
  } finally {
    await removeFaultTrigger(payoutStep.id);
  }

  // Retry now that the transient fault is gone. Because the failed attempt
  // actually rolled back, transaction.status is still "Settled", so the
  // idempotent guard does not short-circuit -- the retry re-runs all three
  // writes for real.
  const retried = await closeTransaction({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, force: true });
  assert.equal(retried.status, "Closed");
  assert.ok(retried.closedAt, "the retry must actually close the transaction");

  const [propertyAfterRetry] = await db.select().from(properties).where(eq(properties.id, propertyId));
  assert.equal(propertyAfterRetry.workflowStage, "Closed", "the retry must converge properties.workflowStage to Closed, not leave it stale");
});
