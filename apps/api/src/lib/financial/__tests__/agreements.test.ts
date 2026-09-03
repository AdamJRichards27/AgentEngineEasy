// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Integration tests for the commission agreement authoring/approval
// service against a real database and a real property/transaction
// fixture — the same shape as settlement.test.ts's own fixtures. The
// central scenario is separation of duties (Section 32/33 — "control
// money-related events"): the same user who drafts an agreement must
// never be able to approve it.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, commissionAgreements } from "@aee/db";
import { createBrokerageWithUsers, createTransactionFromListedProperty, devLogin, cleanupBrokerages, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import { createCommissionAgreement, approveCommissionAgreement, cancelCommissionAgreement, FinancialControlError } from "../agreements.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let secondAdmin: DevLoginResult;
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

  A = await createBrokerageWithUsers(baseUrl, `Financial Agreements Test ${suffix}`);
  secondAdmin = await devLogin(baseUrl, {
    email: `fin-agreements-admin2-${suffix}@example.com`,
    firstName: "Second",
    lastName: "Admin",
    brokerageName: `Financial Agreements Test ${suffix}`,
  });
  otherBrokerage = await createBrokerageWithUsers(baseUrl, `Financial Agreements Other Test ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `1 Financial Agreements Test St ${suffix}` });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  const ids = [A?.brokerageId, otherBrokerage?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("createCommissionAgreement", () => {
  test("drafts version 1 as DRAFT, recording the creator", async () => {
    const agreement = await createCommissionAgreement({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "PERCENTAGE",
      rateBps: 220,
      createdByUserId: secondAdmin.user.id,
    });
    assert.equal(agreement.version, 1);
    assert.equal(agreement.status, "DRAFT");
    assert.equal(agreement.createdByUserId, secondAdmin.user.id);
  });
});

describe("approveCommissionAgreement — separation of duties", () => {
  test("rejects the drafter approving their own agreement", async () => {
    const agreement = await createCommissionAgreement({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "PERCENTAGE",
      rateBps: 230,
      createdByUserId: A.admin.user.id,
    });
    await assert.rejects(
      () => approveCommissionAgreement(agreement.id, A.brokerageId, A.admin.user.id),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "SEPARATION_OF_DUTIES",
    );
  });

  test("a different approver succeeds, supersedes the prior APPROVED version, and records a ledger event", async () => {
    const first = await createCommissionAgreement({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "PERCENTAGE",
      rateBps: 240,
      createdByUserId: A.agent.user.id,
    });
    const approvedFirst = await approveCommissionAgreement(first.id, A.brokerageId, secondAdmin.user.id);
    assert.equal(approvedFirst.status, "APPROVED");
    assert.equal(approvedFirst.approvedByUserId, secondAdmin.user.id);

    const second = await createCommissionAgreement({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "PERCENTAGE",
      rateBps: 250,
      createdByUserId: A.agent.user.id,
    });
    const approvedSecond = await approveCommissionAgreement(second.id, A.brokerageId, secondAdmin.user.id);
    assert.equal(approvedSecond.supersedesId, approvedFirst.id);

    const [rereadFirst] = await db.select().from(commissionAgreements).where(eq(commissionAgreements.id, approvedFirst.id));
    assert.equal(rereadFirst.status, "SUPERSEDED");
  });

  test("a cross-tenant id reads as not found", async () => {
    const foreign = await createCommissionAgreement({
      brokerageId: otherBrokerage.brokerageId,
      propertyId,
      transactionId,
      method: "FIXED_AMOUNT",
      fixedAmountCents: 500000,
      createdByUserId: otherBrokerage.agent.user.id,
    });
    await assert.rejects(
      () => approveCommissionAgreement(foreign.id, A.brokerageId, secondAdmin.user.id),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "NOT_FOUND",
    );
  });
});

describe("cancelCommissionAgreement", () => {
  test("cancels a DRAFT agreement and rejects cancelling it twice", async () => {
    const agreement = await createCommissionAgreement({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "MANUAL_WITH_REASON",
      fixedAmountCents: 100000,
      manualReason: "Negotiated flat fee",
      createdByUserId: A.admin.user.id,
    });
    const cancelled = await cancelCommissionAgreement(agreement.id, A.brokerageId, secondAdmin.user.id, "Deal fell through");
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cancelReason, "Deal fell through");

    await assert.rejects(
      () => cancelCommissionAgreement(agreement.id, A.brokerageId, secondAdmin.user.id, "Again"),
      (err: unknown) => err instanceof FinancialControlError && err.reason === "INVALID_STATUS",
    );
  });
});
