import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, commissionAgreements, pcFeeAuthorities, financialPaymentOutbox, financialLedgerEvents } from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult, devLogin } from "../../../routes/__tests__/testSupport.js";
import { createCommissionCalculation } from "../calculations.js";
import { createPcFeeCalculation } from "../pcFeeCalculations.js";
import { ensurePcSuccessFeeRequest } from "../settlement.js";
import {
  advancePaymentRequestToNoticeSent,
  scheduleDebitForPaymentRequest,
  dispatchOutboxEntry,
  dispatchPendingPaymentOutbox,
  cancelScheduledDebit,
} from "../paymentOutbox.js";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Integration tests for the durable payment outbox against a real
// database. Four independent transactions (fixtures below) are built up
// front rather than sharing one, because financial_payment_requests has a
// (transactionId, kind) unique index — only one PC_SUCCESS_FEE request can
// ever exist per transaction — and this file needs four separately
// configured payment requests (notice-period-elapsed, not-yet-elapsed,
// no-mandate-on-file, and a dedicated sweep fixture) to exercise the
// outbox's different code paths without them colliding with each other.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

interface Fixture {
  propertyId: number;
  transactionId: number;
  paymentRequestId: number;
  authorityId: number;
}

// Each fixture below has its own agent (one ACTIVE PC fee authority per
// agent: Owner t183u, t201u). The version counter is kept so authority
// versions stay unique even if fixtures ever share an agent again.
let authorityVersionCounter = 0;
let fixtureAgentCounter = 0;

async function buildFixture(input: { addressSuffix: string; noticeRequiredDays: number; withMandateRef: boolean }): Promise<Fixture> {
  // One ACTIVE PC fee authority per agent (Owner t183u, t201u): each fixture gets its own agent, so
  // its ACTIVE authority never coexists with another fixture's ACTIVE authority for the same agent.
  const fixtureAgent = await devLogin(baseUrl, { email: `fixture-agent-${suffix}-${++fixtureAgentCounter}@example.com`, firstName: "Fixture", lastName: `Agent${fixtureAgentCounter}`, brokerageName: `Payment Outbox Test ${suffix}` });
  const created = await createTransactionFromListedProperty(baseUrl, fixtureAgent.cookie, {
    address: `1 Payment Outbox Test St ${suffix} ${input.addressSuffix}`,
  });
  const { propertyId, transactionId } = created;

  const [agreement] = await db
    .insert(commissionAgreements)
    .values({ brokerageId: A.brokerageId, propertyId, transactionId, version: 1, method: "PERCENTAGE", rateBps: 220, status: "APPROVED" })
    .returning();

  const calculation = await createCommissionCalculation({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    commissionAgreementId: agreement.id,
    salePriceCentsInput: 80_000_000,
    state: "FINALISED",
  });

  const [authority] = await db
    .insert(pcFeeAuthorities)
    .values({
      brokerageId: A.brokerageId,
      agentUserId: fixtureAgent.user.id,
      version: ++authorityVersionCounter,
      status: "ACTIVE",
      rateBps: 690,
      noticeRequiredDays: input.noticeRequiredDays,
      mandateProviderRef: input.withMandateRef ? `test-mandate-${suffix}-${input.addressSuffix}` : null,
    })
    .returning();

  const pcFeeCalc = await createPcFeeCalculation({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    pcFeeAuthorityId: authority.id,
    commissionCalculationId: calculation.id,
    state: "FINALISED",
  });

  const { paymentRequest } = await ensurePcSuccessFeeRequest({
    transactionId,
    brokerageId: A.brokerageId,
    propertyId,
    pcFeeCalculationId: pcFeeCalc.id,
  });

  return { propertyId, transactionId, paymentRequestId: paymentRequest.id, authorityId: authority.id };
}

let fixtureReady: Fixture; // notice period already elapsed (0 days) — the success/idempotency/cancel path
let fixtureNotElapsed: Fixture; // long notice period — the rejection path
let fixtureNoMandate: Fixture; // ACTIVE authority but no mandateProviderRef — the dispatch-failure/retry path
let fixtureSweep: Fixture; // dedicated to the dispatchPendingPaymentOutbox time-filter test

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

  A = await createBrokerageWithUsers(baseUrl, `Payment Outbox Test ${suffix}`);

  fixtureReady = await buildFixture({ addressSuffix: "ready", noticeRequiredDays: 0, withMandateRef: true });
  fixtureNotElapsed = await buildFixture({ addressSuffix: "not-elapsed", noticeRequiredDays: 30, withMandateRef: true });
  fixtureNoMandate = await buildFixture({ addressSuffix: "no-mandate", noticeRequiredDays: 0, withMandateRef: false });
  fixtureSweep = await buildFixture({ addressSuffix: "sweep", noticeRequiredDays: 0, withMandateRef: true });
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("advancePaymentRequestToNoticeSent", () => {
  test("moves a CALCULATED payment request to NOTICE_SENT and records a ledger event, and is idempotent", async () => {
    const first = await advancePaymentRequestToNoticeSent(fixtureReady.paymentRequestId);
    assert.equal(first.status, "NOTICE_SENT");
    assert.ok(first.noticeSentAt);

    const second = await advancePaymentRequestToNoticeSent(fixtureReady.paymentRequestId);
    assert.equal(second.status, "NOTICE_SENT");
    assert.equal(second.noticeSentAt?.getTime(), first.noticeSentAt?.getTime(), "a repeated call must not reset noticeSentAt");

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureReady.paymentRequestId)));
    const noticeEvents = events.filter((e) => e.eventType === "PC_FEE_NOTICE_SENT");
    assert.equal(noticeEvents.length, 1, "the idempotent re-call must not record a second ledger event");
  });

  test("also advances the other fixtures used by later describe blocks in this file", async () => {
    await advancePaymentRequestToNoticeSent(fixtureNotElapsed.paymentRequestId);
    await advancePaymentRequestToNoticeSent(fixtureNoMandate.paymentRequestId);
    await advancePaymentRequestToNoticeSent(fixtureSweep.paymentRequestId);
  });
});

describe("scheduleDebitForPaymentRequest — notice period not yet elapsed", () => {
  test("rejects when the authority's noticeRequiredDays has not passed since noticeSentAt", async () => {
    await assert.rejects(
      () => scheduleDebitForPaymentRequest({ paymentRequestId: fixtureNotElapsed.paymentRequestId }),
      /notice period has not elapsed yet/,
    );
  });
});

describe("scheduleDebitForPaymentRequest — success and idempotency", () => {
  test("dispatches immediately, moves the payment request to DEBIT_SCHEDULED, and records a ledger event", async () => {
    const result = await scheduleDebitForPaymentRequest({ paymentRequestId: fixtureReady.paymentRequestId });
    assert.equal(result.dispatched, true);
    assert.equal(result.paymentRequest.status, "DEBIT_SCHEDULED");
    assert.equal(result.paymentRequest.provider, "sandbox");
    assert.ok(result.paymentRequest.providerRequestRef);
    assert.equal(result.outboxEntry.status, "DISPATCHED");

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureReady.paymentRequestId)));
    assert.ok(events.some((e) => e.eventType === "PC_FEE_DEBIT_SCHEDULED"));
  });

  test("a repeated call returns the SAME outbox entry rather than enqueueing a second SCHEDULE_DEBIT row", async () => {
    const result = await scheduleDebitForPaymentRequest({ paymentRequestId: fixtureReady.paymentRequestId });
    assert.equal(result.dispatched, true);

    const rows = await db
      .select()
      .from(financialPaymentOutbox)
      .where(eq(financialPaymentOutbox.paymentRequestId, fixtureReady.paymentRequestId));
    assert.equal(rows.length, 1, "exactly one outbox row must exist however many times scheduling is requested");
  });
});

describe("cancelScheduledDebit", () => {
  test("cancels a DEBIT_SCHEDULED request, moving it to WAIVED", async () => {
    const updated = await cancelScheduledDebit({ paymentRequestId: fixtureReady.paymentRequestId, reason: "Brokerage chose to waive this fee." });
    assert.equal(updated.status, "WAIVED");
    assert.ok(updated.waivedAt);
    assert.equal(updated.waiveReason, "Brokerage chose to waive this fee.");
  });

  test("cancelling again (no longer DEBIT_SCHEDULED) is rejected", async () => {
    await assert.rejects(
      () => cancelScheduledDebit({ paymentRequestId: fixtureReady.paymentRequestId, reason: "again" }),
      /not DEBIT_SCHEDULED/,
    );
  });
});

describe("dispatchOutboxEntry — retry and exhaustion", () => {
  test("a dispatch failure (no mandate on file) increments attempts and reschedules with backoff, then fails permanently once maxAttempts is reached", async () => {
    const idempotencyKey = `schedule-debit:${fixtureNoMandate.paymentRequestId}`;
    const [entry] = await db
      .insert(financialPaymentOutbox)
      .values({
        brokerageId: A.brokerageId,
        paymentRequestId: fixtureNoMandate.paymentRequestId,
        action: "SCHEDULE_DEBIT",
        status: "PENDING",
        maxAttempts: 2,
        idempotencyKey,
      })
      .returning();

    const firstOutcome = await dispatchOutboxEntry(entry);
    assert.equal(firstOutcome.outboxEntry.attempts, 1);
    assert.equal(firstOutcome.outboxEntry.status, "PENDING", "one failure with maxAttempts=2 must not exhaust the entry yet");
    assert.ok(firstOutcome.outboxEntry.nextAttemptAt.getTime() > Date.now(), "a backoff window must be scheduled before the next attempt");
    assert.ok(firstOutcome.outboxEntry.lastError?.includes("no active mandate"));
    assert.equal(firstOutcome.paymentRequest, null, "the payment request itself is untouched while retries remain");

    const secondOutcome = await dispatchOutboxEntry(firstOutcome.outboxEntry);
    assert.equal(secondOutcome.outboxEntry.attempts, 2);
    assert.equal(secondOutcome.outboxEntry.status, "FAILED");
    assert.ok(secondOutcome.paymentRequest, "exhausting retries must also mark the payment request itself FAILED");
    assert.equal(secondOutcome.paymentRequest!.status, "FAILED");
    assert.ok(secondOutcome.paymentRequest!.failedAt);

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureNoMandate.paymentRequestId)));
    assert.ok(events.some((e) => e.eventType === "PC_FEE_PAYMENT_FAILED"));
  });
});

describe("dispatchPendingPaymentOutbox — sweep", () => {
  test("does not dispatch an entry whose nextAttemptAt is still in the future, then dispatches it once that time has passed", async () => {
    const idempotencyKey = `schedule-debit:${fixtureSweep.paymentRequestId}`;
    const [entry] = await db
      .insert(financialPaymentOutbox)
      .values({
        brokerageId: A.brokerageId,
        paymentRequestId: fixtureSweep.paymentRequestId,
        action: "SCHEDULE_DEBIT",
        status: "PENDING",
        idempotencyKey,
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000), // an hour from now — not due yet
      })
      .returning();

    const notYetDue = await dispatchPendingPaymentOutbox(50);
    const [stillPending] = await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.id, entry.id));
    assert.equal(stillPending.status, "PENDING", "an entry not yet due must be left untouched by the sweep");
    assert.ok(notYetDue.attempted >= 0);

    await db
      .update(financialPaymentOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 60_000) })
      .where(eq(financialPaymentOutbox.id, entry.id));

    const nowDue = await dispatchPendingPaymentOutbox(50);
    assert.ok(nowDue.dispatched >= 1, "the now-due entry must be picked up and dispatched by the sweep");

    const [dispatchedRow] = await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.id, entry.id));
    assert.equal(dispatchedRow.status, "DISPATCHED");
  });
});
