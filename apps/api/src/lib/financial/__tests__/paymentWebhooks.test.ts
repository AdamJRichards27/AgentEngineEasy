import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and, desc } from "drizzle-orm";
import { db, commissionAgreements, pcFeeAuthorities, financialPaymentRequests, financialDisputes, financialLedgerEvents, domainEvents } from "@aee/db";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "../../../routes/__tests__/testSupport.js";
import { createCommissionCalculation } from "../calculations.js";
import { createPcFeeCalculation } from "../pcFeeCalculations.js";
import { ensurePcSuccessFeeRequest } from "../settlement.js";
import { advancePaymentRequestToNoticeSent, scheduleDebitForPaymentRequest } from "../paymentOutbox.js";
import { processMandatePaymentWebhook } from "../paymentWebhooks.js";

// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Integration tests for lib/financial/paymentWebhooks.ts's inbound half of
// Section 31 — the counterpart to paymentOutbox.test.ts, which covers the
// outbound dispatch. Every fixture is driven all the way to DEBIT_SCHEDULED
// through the REAL advancePaymentRequestToNoticeSent /
// scheduleDebitForPaymentRequest functions (not hand-inserted rows), so
// each fixture's providerRequestRef is a genuine sandbox-issued reference
// exactly as production traffic would produce — the same discipline
// paymentOutbox.test.ts applies, deviating into direct DB manipulation only
// where a test needs something more surgical than the normal lifecycle
// produces (here: capping one fixture's maxRetries so the exhaustion path
// is reachable in two deliveries instead of three).
//
// Six independent transactions/payment-requests are built (one per
// describe block below) for the same reason paymentOutbox.test.ts uses
// four: financial_payment_requests has a (transactionId, kind) unique
// index, so each scenario needs its own payment request rather than
// sharing — and, separately, financial_payment_provider_events dedups on
// (provider, providerEventId), so this file is also careful to give every
// *non*-duplicate-delivery test its own providerEventId.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

interface ScheduledFixture {
  propertyId: number;
  transactionId: number;
  paymentRequestId: number;
  providerRequestRef: string;
}

// pc_fee_authorities has a unique (agentUserId, version) index, and every
// fixture below deliberately shares the SAME agent (there is only one
// agent in this file's brokerage) — so each fixture's authority needs its
// own version number rather than every one hardcoding version: 1.
let authorityVersionCounter = 0;

async function buildScheduledFixture(addressSuffix: string): Promise<ScheduledFixture> {
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `1 Payment Webhooks Test St ${suffix} ${addressSuffix}`,
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
      agentUserId: A.agent.user.id,
      version: ++authorityVersionCounter,
      status: "ACTIVE",
      rateBps: 690,
      noticeRequiredDays: 0,
      mandateProviderRef: `test-mandate-${suffix}-${addressSuffix}`,
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

  const { paymentRequest: created0 } = await ensurePcSuccessFeeRequest({
    transactionId,
    brokerageId: A.brokerageId,
    propertyId,
    pcFeeCalculationId: pcFeeCalc.id,
  });

  await advancePaymentRequestToNoticeSent(created0.id);
  const { paymentRequest } = await scheduleDebitForPaymentRequest({ paymentRequestId: created0.id });

  if (!paymentRequest.providerRequestRef) {
    throw new Error("fixture setup failed to obtain a providerRequestRef from scheduleDebitForPaymentRequest");
  }

  return { propertyId, transactionId, paymentRequestId: paymentRequest.id, providerRequestRef: paymentRequest.providerRequestRef };
}

let fixtureProcessing: ScheduledFixture;
let fixturePaid: ScheduledFixture;
let fixtureFailedRetry: ScheduledFixture;
let fixtureReversed: ScheduledFixture;
let fixtureDisputed: ScheduledFixture;
let fixtureDuplicate: ScheduledFixture;

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

  A = await createBrokerageWithUsers(baseUrl, `Payment Webhooks Test ${suffix}`);

  fixtureProcessing = await buildScheduledFixture("processing");
  fixturePaid = await buildScheduledFixture("paid");
  fixtureFailedRetry = await buildScheduledFixture("failed-retry");
  fixtureReversed = await buildScheduledFixture("reversed");
  fixtureDisputed = await buildScheduledFixture("disputed");
  fixtureDuplicate = await buildScheduledFixture("duplicate");

  // Surgical: cap this one fixture's maxRetries at 2 (default is 3) so the
  // exhaustion path below is reachable with exactly two Failed deliveries.
  await db
    .update(financialPaymentRequests)
    .set({ maxRetries: 2 })
    .where(eq(financialPaymentRequests.id, fixtureFailedRetry.paymentRequestId));
});

after(async () => {
  const ids = [A?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("processMandatePaymentWebhook — Processing", () => {
  test("moves a DEBIT_SCHEDULED payment request to PROCESSING and records a ledger event", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-processing-${suffix}`,
      providerRequestRef: fixtureProcessing.providerRequestRef,
      status: "Processing",
    });
    assert.equal(result.processed, true);
    assert.equal(result.paymentRequest?.status, "PROCESSING");
    assert.ok(result.paymentRequest?.processingStartedAt);

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureProcessing.paymentRequestId)));
    assert.ok(events.some((e) => e.eventType === "PC_FEE_PAYMENT_PROCESSING"));
  });
});

describe("processMandatePaymentWebhook — Paid", () => {
  test("moves a DEBIT_SCHEDULED payment request to PAID and records a ledger event", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-paid-${suffix}`,
      providerRequestRef: fixturePaid.providerRequestRef,
      status: "Paid",
    });
    assert.equal(result.processed, true);
    assert.equal(result.paymentRequest?.status, "PAID");
    assert.ok(result.paymentRequest?.paidAt);

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixturePaid.paymentRequestId)));
    assert.ok(events.some((e) => e.eventType === "PC_FEE_PAID"));
  });
});

describe("processMandatePaymentWebhook — correlationId propagation (Step 2 hardening, named proof flow \"Mock Financial status processing\")", () => {
  test("a Paid webhook delivered over REAL HTTP publishes FINANCIAL_PAYMENT_PAID under the SAME correlationId as the webhook request itself", async () => {
    // Deliberately goes through the actual route (routes/financialWebhooks.ts)
    // rather than calling processMandatePaymentWebhook directly, as every
    // other test in this file does — this is the one thing a direct call
    // cannot prove: that emitFinancialEvent's `currentCorrelationId()`
    // fallback (paymentWebhooks.ts never passes an explicit correlationId)
    // correctly resolves to THIS INBOUND WEBHOOK REQUEST's own ambient
    // context (established by middlewares/requestId.ts), not a disconnected
    // fresh id, given the whole verify -> parse -> dedup -> apply chain runs
    // synchronously inside the one route handler.
    const fixture = await buildScheduledFixture("correlation-proof");

    const webhookRes = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mandate-payment-signature": "sig" },
      body: JSON.stringify({
        providerEventId: `evt-correlation-proof-${suffix}`,
        providerRequestRef: fixture.providerRequestRef,
        status: "Paid",
      }),
    });
    assert.equal(webhookRes.status, 200);
    const requestCorrelationId = webhookRes.headers.get("x-correlation-id");
    assert.ok(requestCorrelationId, "the webhook request must echo an X-Correlation-Id response header");
    const body = (await webhookRes.json()) as { processed: boolean; paymentRequest?: { status: string } };
    assert.equal(body.processed, true);
    assert.equal(body.paymentRequest?.status, "PAID");

    const [paidEvent] = await db
      .select()
      .from(domainEvents)
      .where(and(eq(domainEvents.eventType, "FINANCIAL_PAYMENT_PAID"), eq(domainEvents.transactionId, fixture.transactionId)))
      .orderBy(desc(domainEvents.occurredAt))
      .limit(1);
    assert.ok(paidEvent, "expected FINANCIAL_PAYMENT_PAID to have been published");
    assert.equal(
      paidEvent.correlationId,
      requestCorrelationId,
      "FINANCIAL_PAYMENT_PAID must carry the triggering webhook request's own correlationId — the whole inbound-webhook-processing flow is one traceable unit",
    );
  });
});

describe("processMandatePaymentWebhook — Failed retry and exhaustion", () => {
  test("a Failed webhook below maxRetries moves the request to RETRY_SCHEDULED and increments retryCount", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-failed-1-${suffix}`,
      providerRequestRef: fixtureFailedRetry.providerRequestRef,
      status: "Failed",
      failureReason: "Insufficient funds",
    });
    assert.equal(result.processed, true);
    assert.equal(result.paymentRequest?.status, "RETRY_SCHEDULED");
    assert.equal(result.paymentRequest?.retryCount, 1);
    assert.equal(result.paymentRequest?.failedAt, null);
  });

  test("a second Failed webhook exhausts maxRetries and moves the request to permanent FAILED", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-failed-2-${suffix}`,
      providerRequestRef: fixtureFailedRetry.providerRequestRef,
      status: "Failed",
      failureReason: "Insufficient funds",
    });
    assert.equal(result.processed, true);
    assert.equal(result.paymentRequest?.status, "FAILED");
    assert.equal(result.paymentRequest?.retryCount, 2);
    assert.ok(result.paymentRequest?.failedAt);

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureFailedRetry.paymentRequestId)));
    const failedEvents = events.filter((e) => e.eventType === "PC_FEE_PAYMENT_FAILED");
    assert.equal(failedEvents.length, 2, "the retryable failure and the exhausting failure each record their own ledger event");
  });
});

describe("processMandatePaymentWebhook — Reversed", () => {
  test("moves a DEBIT_SCHEDULED payment request to REVERSED and records a ledger event", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-reversed-${suffix}`,
      providerRequestRef: fixtureReversed.providerRequestRef,
      status: "Reversed",
      failureReason: "Mandate cancelled by payer's bank",
    });
    assert.equal(result.processed, true);
    assert.equal(result.paymentRequest?.status, "REVERSED");
    assert.ok(result.paymentRequest?.reversedAt);
    assert.equal(result.paymentRequest?.reversalReason, "Mandate cancelled by payer's bank");

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureReversed.paymentRequestId)));
    assert.ok(events.some((e) => e.eventType === "PC_FEE_PAYMENT_REVERSED"));
  });
});

describe("processMandatePaymentWebhook — Disputed", () => {
  test("moves the request to DISPUTED and opens exactly one dispute row even across two Disputed deliveries", async () => {
    const first = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-disputed-1-${suffix}`,
      providerRequestRef: fixtureDisputed.providerRequestRef,
      status: "Disputed",
      disputeReason: "Payer disputes authorisation",
    });
    assert.equal(first.processed, true);
    assert.equal(first.paymentRequest?.status, "DISPUTED");

    // A second, distinctly-IDed Disputed delivery for the same payment
    // request (e.g. the provider re-notifying) must not open a second,
    // concurrent dispute record — this is distinct from the duplicate-
    // delivery test below, which reuses the SAME providerEventId.
    const second = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-disputed-2-${suffix}`,
      providerRequestRef: fixtureDisputed.providerRequestRef,
      status: "Disputed",
      disputeReason: "Payer disputes authorisation (provider re-notified)",
    });
    assert.equal(second.processed, true);

    const disputes = await db.select().from(financialDisputes).where(eq(financialDisputes.paymentRequestId, fixtureDisputed.paymentRequestId));
    assert.equal(disputes.length, 1, "a second Disputed delivery must not open a second dispute row while one is still OPEN");
    assert.equal(disputes[0].status, "OPEN");
  });
});

describe("processMandatePaymentWebhook — duplicate delivery", () => {
  test("a redelivered webhook with the same providerEventId is a no-op the second time", async () => {
    const payload = {
      providerEventId: `evt-duplicate-${suffix}`,
      providerRequestRef: fixtureDuplicate.providerRequestRef,
      status: "Paid",
    };

    const first = await processMandatePaymentWebhook("{}", "sig", payload);
    assert.equal(first.processed, true);
    assert.equal(first.paymentRequest?.status, "PAID");

    const second = await processMandatePaymentWebhook("{}", "sig", payload);
    assert.equal(second.processed, false);
    assert.equal(second.reason, "duplicate_delivery");

    const events = await db
      .select()
      .from(financialLedgerEvents)
      .where(eq(financialLedgerEvents.sourceRecordId, String(fixtureDuplicate.paymentRequestId)));
    const paidEvents = events.filter((e) => e.eventType === "PC_FEE_PAID");
    assert.equal(paidEvents.length, 1, "the duplicate delivery must not double-apply the Paid transition or its ledger event");
  });
});

describe("processMandatePaymentWebhook — unknown payment request", () => {
  test("returns payment_request_not_found for a providerRequestRef with no matching payment request", async () => {
    const result = await processMandatePaymentWebhook("{}", "sig", {
      providerEventId: `evt-unknown-${suffix}`,
      providerRequestRef: "no-such-provider-request-ref",
      status: "Paid",
    });
    assert.equal(result.processed, false);
    assert.equal(result.reason, "payment_request_not_found");
  });
});
