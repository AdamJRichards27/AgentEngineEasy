import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, commissionAgreements, commissionCalculations, pcFeeAuthorities, pcFeeCalculations, financialPaymentRequests, transactions } from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../../routes/__tests__/testSupport.js";
import { createCommissionCalculation } from "../calculations.js";
import { createPcFeeCalculation } from "../pcFeeCalculations.js";
import { finalizeCommissionForSettlement, ensurePcSuccessFeeRequest } from "../settlement.js";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage C.
//
// Integration tests for the calculation-persistence and settlement
// services against a real database and a real property/transaction
// fixture — the same shape as schema.test.ts's own fixtures. The single
// most important scenario here is Section 21's settlement idempotency
// guarantee: ensurePcSuccessFeeRequest must never create a second
// PC_SUCCESS_FEE payment request for the same transaction, however many
// times it is called.
//
// Describe blocks below run in file order (Node's test runner does not
// parallelise sibling describes by default) and deliberately build on
// each other's fixture state within this one shared transactionId — the
// "no APPROVED agreement yet" scenario runs first, before any block
// creates one, exactly so that ordering is meaningful rather than
// accidental.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let otherBrokerage: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let transactionId: number;

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

  A = await createBrokerageWithUsers(baseUrl, `Financial Settlement Test ${suffix}`);
  otherBrokerage = await createBrokerageWithUsers(baseUrl, `Financial Settlement Other Test ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Financial Settlement Test St ${suffix}`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  const ids = [A?.brokerageId, otherBrokerage?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("finalizeCommissionForSettlement — no APPROVED agreement yet", () => {
  test("is a no-op when this transaction has no APPROVED commission agreement", async () => {
    const result = await finalizeCommissionForSettlement({ transactionId, brokerageId: A.brokerageId, propertyId });
    assert.equal(result.calculation, null);
    assert.match(result.skippedReason ?? "", /No APPROVED commission agreement/);
  });
});

describe("createCommissionCalculation — versioning and supersession", () => {
  test("persists the deterministic result and calculationRuleVersion, and a supersede marks the prior FINALISED row", async () => {
    const [agreement] = await db
      .insert(commissionAgreements)
      .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 1, method: "PERCENTAGE", rateBps: 220, status: "APPROVED" })
      .returning();

    const first = await createCommissionCalculation({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      commissionAgreementId: agreement.id,
      salePriceCentsInput: 80_000_000,
      state: "FINALISED",
    });
    assert.equal(first.calculationVersion, 1);
    assert.equal(first.calculationRuleVersion, 1);
    assert.equal(first.grossCommissionCents, 1_760_000);
    assert.equal(first.state, "FINALISED");

    const second = await createCommissionCalculation({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      commissionAgreementId: agreement.id,
      salePriceCentsInput: 82_000_000, // a corrected sale price
      state: "FINALISED",
      supersede: true,
      supersededReason: "Corrected sale price after settlement adjustment.",
    });
    assert.equal(second.calculationVersion, 2);
    assert.equal(second.supersedesId, first.id);

    const [rereadFirst] = await db.select().from(commissionCalculations).where(eq(commissionCalculations.id, first.id));
    assert.equal(rereadFirst.state, "SUPERSEDED");
  });
});

describe("finalizeCommissionForSettlement — with an APPROVED agreement", () => {
  test("writes a FINALISED calculation back onto the transaction's legacy flat columns, and is idempotent for the same sale price", async () => {
    const [agreement] = await db
      .insert(commissionAgreements)
      .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 2, method: "PERCENTAGE", rateBps: 250, status: "APPROVED" })
      .returning();

    const first = await finalizeCommissionForSettlement({ transactionId, brokerageId: A.brokerageId, propertyId, salePriceCentsOverride: 90_000_000 });
    assert.ok(first.calculation);
    assert.equal(first.calculation!.commissionAgreementId, agreement.id);
    assert.equal(first.calculation!.grossCommissionCents, 2_250_000); // 900,000 * 2.50%

    const [transactionRow] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
    assert.equal(transactionRow.grossCommissionCents, 2_250_000);
    assert.ok(transactionRow.commissionCalculatedAt);

    const second = await finalizeCommissionForSettlement({ transactionId, brokerageId: A.brokerageId, propertyId, salePriceCentsOverride: 90_000_000 });
    assert.equal(second.calculation!.id, first.calculation!.id, "a repeated finalisation for the same agreement+sale price must not create a new row");
    assert.match(second.skippedReason ?? "", /Already finalised/);
  });
});

describe("createPcFeeCalculation — requires ACTIVE authority", () => {
  test("rejects a non-ACTIVE authority and succeeds once one is activated", async () => {
    const [notProvided] = await db.insert(pcFeeAuthorities).values({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, version: 1 }).returning();
    assert.equal(notProvided.status, "NOT_PROVIDED");

    // Several commissionCalculations rows exist by this point in the file
    // (earlier describe blocks superseded their own prior versions) — pick
    // the current FINALISED one explicitly rather than relying on any
    // implicit row order from a plain SELECT.
    const calcRows = await db
      .select()
      .from(commissionCalculations)
      .where(and(eq(commissionCalculations.transactionId, transactionId), eq(commissionCalculations.state, "FINALISED")));
    const finalisedCalc = calcRows.sort((a, b) => b.calculationVersion - a.calculationVersion)[0];
    assert.ok(finalisedCalc, "expected a FINALISED commission calculation from an earlier describe block in this file");

    await assert.rejects(
      () =>
        createPcFeeCalculation({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          pcFeeAuthorityId: notProvided.id,
          commissionCalculationId: finalisedCalc.id,
        }),
      /not ACTIVE/,
    );

    const [active] = await db
      .insert(pcFeeAuthorities)
      .values({
        brokerageId: A.brokerageId,
        agentUserId: A.agent.user.id,
        version: 2,
        supersedesId: notProvided.id,
        status: "ACTIVE",
        rateBps: 690,
      })
      .returning();

    const pcFeeCalc = await createPcFeeCalculation({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      pcFeeAuthorityId: active.id,
      commissionCalculationId: finalisedCalc.id,
      state: "FINALISED",
    });
    assert.equal(pcFeeCalc.feeBasisUsed, "PERCENTAGE_OF_GCI");
    assert.equal(pcFeeCalc.isProvisional, false);
  });
});

describe("createPcFeeCalculation — cross-tenant pcFeeAuthorityId is rejected (IDOR fix)", () => {
  test("a foreign brokerage's authority cannot be used, and is indistinguishable from a nonexistent id", async () => {
    const calcRows = await db
      .select()
      .from(commissionCalculations)
      .where(and(eq(commissionCalculations.transactionId, transactionId), eq(commissionCalculations.state, "FINALISED")));
    const finalisedCalc = calcRows.sort((a, b) => b.calculationVersion - a.calculationVersion)[0];
    assert.ok(finalisedCalc, "expected a FINALISED commission calculation from an earlier describe block in this file");

    // An ACTIVE authority, but it belongs to a completely different
    // brokerage — the confidential mandate terms (feeBasis/rateBps/
    // gciDefinition) below must never be readable from A's brokerage.
    const [foreignAuthority] = await db
      .insert(pcFeeAuthorities)
      .values({ brokerageId: otherBrokerage.brokerageId, agentUserId: otherBrokerage.agent.user.id, version: 1, status: "ACTIVE", rateBps: 9999 })
      .returning();

    const foreignMessage = `PC fee authority ${foreignAuthority.id} not found.`;
    await assert.rejects(
      () =>
        createPcFeeCalculation({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          pcFeeAuthorityId: foreignAuthority.id,
          commissionCalculationId: finalisedCalc.id,
        }),
      (err: unknown) => err instanceof Error && err.message === foreignMessage,
    );

    // Same message, same shape, for a genuinely nonexistent id — a caller
    // must never be able to tell "exists in another brokerage" apart from
    // "doesn't exist at all".
    const bogusId = foreignAuthority.id + 1_000_000;
    await assert.rejects(
      () =>
        createPcFeeCalculation({
          brokerageId: A.brokerageId,
          propertyId,
          transactionId,
          pcFeeAuthorityId: bogusId,
          commissionCalculationId: finalisedCalc.id,
        }),
      (err: unknown) => err instanceof Error && err.message === `PC fee authority ${bogusId} not found.`,
    );

    // And no row was ever persisted onto A's transaction referencing the
    // foreign authority.
    const leaked = await db
      .select()
      .from(pcFeeCalculations)
      .where(and(eq(pcFeeCalculations.transactionId, transactionId), eq(pcFeeCalculations.pcFeeAuthorityId, foreignAuthority.id)));
    assert.equal(leaked.length, 0);
  });

  test("an authority belonging to the caller's own brokerage still works (happy path preserved)", async () => {
    const calcRows = await db
      .select()
      .from(commissionCalculations)
      .where(and(eq(commissionCalculations.transactionId, transactionId), eq(commissionCalculations.state, "FINALISED")));
    const finalisedCalc = calcRows.sort((a, b) => b.calculationVersion - a.calculationVersion)[0];
    assert.ok(finalisedCalc, "expected a FINALISED commission calculation from an earlier describe block in this file");

    // One ACTIVE authority per agent (Owner t183u, t201u): the new version supersedes the agent's
    // earlier ACTIVE authority from this file, as activation would.
    await db
      .update(pcFeeAuthorities)
      .set({ status: "REPLACED" })
      .where(and(eq(pcFeeAuthorities.agentUserId, A.agent.user.id), eq(pcFeeAuthorities.status, "ACTIVE")));
    const [ownAuthority] = await db
      .insert(pcFeeAuthorities)
      .values({ brokerageId: A.brokerageId, agentUserId: A.agent.user.id, version: 3, status: "ACTIVE", rateBps: 500 })
      .returning();

    const pcFeeCalc = await createPcFeeCalculation({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      pcFeeAuthorityId: ownAuthority.id,
      commissionCalculationId: finalisedCalc.id,
      state: "FINALISED",
    });
    assert.equal(pcFeeCalc.pcFeeAuthorityId, ownAuthority.id);
    assert.equal(pcFeeCalc.feeBasisUsed, "PERCENTAGE_OF_GCI");
    assert.equal(pcFeeCalc.rateBpsUsed, 500);
    assert.equal(pcFeeCalc.isProvisional, false);
  });
});

describe("ensurePcSuccessFeeRequest — settlement idempotency (Section 21)", () => {
  test("a repeated call never creates a second PC_SUCCESS_FEE payment request for the same transaction", async () => {
    const [pcFeeCalc] = await db.select().from(pcFeeCalculations).where(eq(pcFeeCalculations.transactionId, transactionId));
    assert.ok(pcFeeCalc, "expected a PC fee calculation from the previous describe block");

    const first = await ensurePcSuccessFeeRequest({
      transactionId,
      brokerageId: A.brokerageId,
      propertyId,
      pcFeeCalculationId: pcFeeCalc.id,
    });
    assert.equal(first.created, true);
    assert.equal(first.paymentRequest.kind, "PC_SUCCESS_FEE");
    assert.equal(first.paymentRequest.amountCents, pcFeeCalc.totalFeeCents);

    // The core guarantee: calling this again — exactly what a second,
    // duplicate SETTLEMENT_COMPLETED delivery would do — must return the
    // SAME row, not create a new one.
    const second = await ensurePcSuccessFeeRequest({
      transactionId,
      brokerageId: A.brokerageId,
      propertyId,
      pcFeeCalculationId: pcFeeCalc.id,
    });
    assert.equal(second.created, false);
    assert.equal(second.paymentRequest.id, first.paymentRequest.id);
    assert.match(second.skippedReason ?? "", /already exists/);

    const allRequests = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.transactionId, transactionId));
    const pcSuccessFeeRequests = allRequests.filter((r) => r.kind === "PC_SUCCESS_FEE");
    assert.equal(pcSuccessFeeRequests.length, 1, "exactly one PC_SUCCESS_FEE request must exist however many times settlement fires");
  });
});
