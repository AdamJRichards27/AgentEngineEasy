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
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, transactions, amlVerifications, auditLogs, automationAttentionItems, automationTasks } from "@aee/db";
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

  // Reach Settled independently of the unconditional/condition/AML state --
  // completeSettlement only requires a scheduled settlement date.
  await scheduleSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId, settlementDate: new Date("2027-04-01") });
  await completeSettlement({ transactionId, userId: A.agent.user.id, brokerageId: A.brokerageId });

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
