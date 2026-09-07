// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Route-level HTTP tests (Section 35.G) for the financial operations
// surface: authentication/authorisation, tenant isolation, Section 33
// sensitive-data redaction, and an end-to-end walk from a drafted
// commission agreement through to a PAID PC success fee via the mandate
// webhook. Mirrors commandCentre.test.ts/pitCrew.test.ts's real-server,
// real-fetch integration style rather than mocking the router.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { createBrokerageWithUsers, createTransactionFromListedProperty, addSecondBrokerageAdmin, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.MANDATE_PAYMENT_WEBHOOK_SECRET = "test-only-mandate-payment-webhook-secret";
process.env.MANDATE_PAYMENT_WEBHOOKS_ENABLED = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let secondAdmin: DevLoginResult;
let otherBrokerage: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let transactionId: number;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

function signedMandateCallback(callback: Record<string, unknown>): { raw: string; signature: string } {
  const raw = JSON.stringify(callback);
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    raw,
    signature: `t=${timestamp},v1=${createHmac("sha256", process.env.MANDATE_PAYMENT_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest("hex")}`,
  };
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

  A = await createBrokerageWithUsers(baseUrl, `Financial Routes Test ${suffix}`);
  // A genuine second Brokerage Administrator inside A's own brokerage (not
  // just a second signed-in identity) — dev-login only ever makes the
  // FIRST sign-in to a brokerage name an admin (see
  // addSecondBrokerageAdmin's own doc comment in testSupport.ts), and every
  // separation-of-duties assertion below needs an approver/activator who
  // both passes requireRole(...BROKERAGE_ADMIN_ROLES) and is not the
  // drafter.
  secondAdmin = await addSecondBrokerageAdmin(baseUrl, A.brokerageId, {
    email: `fin-routes-admin2-${suffix}@example.com`,
    firstName: "Second",
    lastName: "Admin",
    ownBrokerageName: `Financial Routes Second Admin Test ${suffix}`,
  });
  otherBrokerage = await createBrokerageWithUsers(baseUrl, `Financial Routes Other Test ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `1 Financial Routes Test St ${suffix}` });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  const ids = [A?.brokerageId, otherBrokerage?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("financial routes — authentication and authorisation", () => {
  test("unauthenticated requests are rejected", async () => {
    const res = await fetch(`${baseUrl}/api/financial/settings`);
    assert.equal(res.status, 401);
  });

  test("a non-admin agent is forbidden, matching this app's canViewFinancials precedent", async () => {
    const res = await fetch(`${baseUrl}/api/financial/settings`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 403);
  });

  test("a Brokerage Administrator gets 200 and a lazily-created settings row", async () => {
    const res = await fetch(`${baseUrl}/api/financial/settings`, { headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ settings: { brokerageId: number; defaultPcFeeRateBps: number } }>(res);
    assert.equal(body.settings.brokerageId, A.brokerageId);
    assert.equal(body.settings.defaultPcFeeRateBps, 690);
  });
});

describe("financial routes — commission agreements", () => {
  let agreementId: number;

  test("POST creates a DRAFT agreement", async () => {
    const res = await fetch(`${baseUrl}/api/financial/commission-agreements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ transactionId, method: "PERCENTAGE", rateBps: 220 }),
    });
    assert.equal(res.status, 201);
    const body = await json<{ agreement: { id: number; status: string; version: number } }>(res);
    assert.equal(body.agreement.status, "DRAFT");
    assert.equal(body.agreement.version, 1);
    agreementId = body.agreement.id;
  });

  test("the drafter cannot approve their own agreement (separation of duties -> 403)", async () => {
    const res = await fetch(`${baseUrl}/api/financial/commission-agreements/${agreementId}/approve`, {
      method: "POST",
      headers: { cookie: A.admin.cookie },
    });
    assert.equal(res.status, 403);
    const body = await json<{ reason: string }>(res);
    assert.equal(body.reason, "SEPARATION_OF_DUTIES");
  });

  test("a different admin approves it successfully", async () => {
    const res = await fetch(`${baseUrl}/api/financial/commission-agreements/${agreementId}/approve`, {
      method: "POST",
      headers: { cookie: secondAdmin.cookie },
    });
    assert.equal(res.status, 200);
    const body = await json<{ agreement: { status: string; approvedByUserId: number } }>(res);
    assert.equal(body.agreement.status, "APPROVED");
    assert.equal(body.agreement.approvedByUserId, secondAdmin.user.id);
  });

  test("a cross-tenant read reads as 404, not 403 or 200", async () => {
    const res = await fetch(`${baseUrl}/api/financial/commission-agreements/${agreementId}`, { headers: { cookie: otherBrokerage.admin.cookie } });
    assert.equal(res.status, 404);
  });

  test("POST reachable in the transaction's own property namespace summary", async () => {
    const res = await fetch(`${baseUrl}/api/properties/${propertyId}/financial/summary`, { headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ currentCommissionAgreement: { id: number } | null }>(res);
    assert.equal(body.currentCommissionAgreement?.id, agreementId);
  });
});

describe("financial routes — PC fee authorities: separation of duties and Section 33 redaction", () => {
  let authorityId: number;

  test("POST creates a PENDING authority for an agent in the same brokerage", async () => {
    const res = await fetch(`${baseUrl}/api/financial/pc-fee-authorities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ agentUserId: A.agent.user.id, rateBps: 690 }),
    });
    assert.equal(res.status, 201);
    const body = await json<{ authority: { id: number; status: string } }>(res);
    assert.equal(body.authority.status, "PENDING");
    authorityId = body.authority.id;
  });

  test("rejects assigning an authority to an agent from a different brokerage", async () => {
    const res = await fetch(`${baseUrl}/api/financial/pc-fee-authorities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ agentUserId: otherBrokerage.agent.user.id, rateBps: 690 }),
    });
    assert.equal(res.status, 404);
  });

  test("the drafter cannot activate their own authority", async () => {
    const res = await fetch(`${baseUrl}/api/financial/pc-fee-authorities/${authorityId}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ mandateProviderRef: "sandbox-route-ref-1", mandateProvider: "sandbox" }),
    });
    assert.equal(res.status, 403);
  });

  test("a different admin activates it, and the JSON response never carries the raw mandate reference", async () => {
    const res = await fetch(`${baseUrl}/api/financial/pc-fee-authorities/${authorityId}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: secondAdmin.cookie },
      body: JSON.stringify({ mandateProviderRef: "sandbox-route-ref-1", mandateProvider: "sandbox" }),
    });
    assert.equal(res.status, 200);
    const rawText = await res.text();
    assert.equal(rawText.includes("sandbox-route-ref-1"), false, "the raw mandateProviderRef must never be serialised into an API response");
    const body = JSON.parse(rawText) as { authority: { status: string; hasMandate: boolean; mandateProviderRef?: string } };
    assert.equal(body.authority.status, "ACTIVE");
    assert.equal(body.authority.hasMandate, true);
    assert.equal(body.authority.mandateProviderRef, undefined);
  });

  test("GET list also redacts every row", async () => {
    const res = await fetch(`${baseUrl}/api/financial/pc-fee-authorities?agentUserId=${A.agent.user.id}`, { headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 200);
    const rawText = await res.text();
    assert.equal(rawText.includes("mandateProviderRef"), false);
  });
});

describe("financial routes — end-to-end PC success fee lifecycle through the API", () => {
  let e2eTransactionId: number;
  let e2ePropertyId: number;
  let paymentRequestId: number;
  let providerRequestRef: string;

  test("drives a fresh transaction through agreement, calculation, authority, fee, notice, and a scheduled debit", async () => {
    const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, { address: `2 Financial Routes E2E St ${suffix}` });
    e2eTransactionId = created.transactionId;
    e2ePropertyId = created.propertyId;

    const agreementRes = await fetch(`${baseUrl}/api/financial/commission-agreements`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ transactionId: e2eTransactionId, method: "PERCENTAGE", rateBps: 220 }),
    });
    const { agreement } = await json<{ agreement: { id: number } }>(agreementRes);
    await fetch(`${baseUrl}/api/financial/commission-agreements/${agreement.id}/approve`, { method: "POST", headers: { cookie: secondAdmin.cookie } });

    const calcRes = await fetch(`${baseUrl}/api/financial/commission-calculations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ transactionId: e2eTransactionId, commissionAgreementId: agreement.id, salePriceCentsInput: 80_000_000, state: "FINALISED" }),
    });
    assert.equal(calcRes.status, 201);
    const { calculation } = await json<{ calculation: { id: number; grossCommissionCents: number } }>(calcRes);
    assert.equal(calculation.grossCommissionCents, 1_760_000);

    // noticeRequiredDays: 0 so the debit can be scheduled immediately in
    // this test, without waiting on a real cooling-off period.
    const authorityRes = await fetch(`${baseUrl}/api/financial/pc-fee-authorities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ agentUserId: A.agent.user.id, rateBps: 690, noticeRequiredDays: 0 }),
    });
    const { authority } = await json<{ authority: { id: number } }>(authorityRes);
    const activateRes = await fetch(`${baseUrl}/api/financial/pc-fee-authorities/${authority.id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: secondAdmin.cookie },
      body: JSON.stringify({ mandateProviderRef: `sandbox-e2e-ref-${suffix}`, mandateProvider: "sandbox" }),
    });
    assert.equal(activateRes.status, 200);

    const pcCalcRes = await fetch(`${baseUrl}/api/financial/pc-fee-calculations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ transactionId: e2eTransactionId, pcFeeAuthorityId: authority.id, commissionCalculationId: calculation.id, state: "FINALISED" }),
    });
    assert.equal(pcCalcRes.status, 201);
    const { calculation: pcFeeCalculation } = await json<{ calculation: { id: number; totalFeeCents: number } }>(pcCalcRes);

    const ensureRes = await fetch(`${baseUrl}/api/financial/settlement/ensure-pc-success-fee`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
      body: JSON.stringify({ transactionId: e2eTransactionId, pcFeeCalculationId: pcFeeCalculation.id }),
    });
    assert.equal(ensureRes.status, 201);
    const { paymentRequest } = await json<{ paymentRequest: { id: number; amountCents: number } }>(ensureRes);
    assert.equal(paymentRequest.amountCents, pcFeeCalculation.totalFeeCents);
    paymentRequestId = paymentRequest.id;

    const noticeRes = await fetch(`${baseUrl}/api/financial/payment-requests/${paymentRequestId}/notice-sent`, { method: "POST", headers: { cookie: A.admin.cookie } });
    assert.equal(noticeRes.status, 200);

    const scheduleRes = await fetch(`${baseUrl}/api/financial/payment-requests/${paymentRequestId}/schedule-debit`, { method: "POST", headers: { cookie: A.admin.cookie } });
    assert.equal(scheduleRes.status, 200);
    const scheduled = await json<{ paymentRequest: { status: string; providerRequestRef: string | null } }>(scheduleRes);
    assert.equal(scheduled.paymentRequest.status, "DEBIT_SCHEDULED");
    assert.ok(scheduled.paymentRequest.providerRequestRef);
    providerRequestRef = scheduled.paymentRequest.providerRequestRef!;
  });

  test("the sandbox mandate webhook moves the request to PAID and the ledger records it", async () => {
    const callback = signedMandateCallback({
      providerEventId: `evt-${suffix}-paid`,
      providerRequestRef,
      status: "Paid",
      brokerageId: A.brokerageId,
      provider: "sandbox",
      mandateProviderRef: `sandbox-e2e-ref-${suffix}`,
    });
    const webhookRes = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mandate-payment-signature": callback.signature },
      body: callback.raw,
    });
    assert.equal(webhookRes.status, 200);
    const body = await json<{ processed: boolean }>(webhookRes);
    assert.equal(body.processed, true);

    const getRes = await fetch(`${baseUrl}/api/financial/payment-requests/${paymentRequestId}`, { headers: { cookie: A.admin.cookie } });
    const { paymentRequest } = await json<{ paymentRequest: { status: string } }>(getRes);
    assert.equal(paymentRequest.status, "PAID");

    const ledgerRes = await fetch(`${baseUrl}/api/financial/ledger-events?transactionId=${e2eTransactionId}`, { headers: { cookie: A.admin.cookie } });
    const { events } = await json<{ events: Array<{ eventType: string }> }>(ledgerRes);
    assert.ok(events.some((e) => e.eventType === "PC_FEE_PAID"));
  });

  test("a redelivered webhook is a no-op the second time", async () => {
    const callback = signedMandateCallback({
      providerEventId: `evt-${suffix}-paid`,
      providerRequestRef,
      status: "Paid",
      brokerageId: A.brokerageId,
      provider: "sandbox",
      mandateProviderRef: `sandbox-e2e-ref-${suffix}`,
    });
    const res = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mandate-payment-signature": callback.signature },
      body: callback.raw,
    });
    const body = await json<{ processed: boolean; reason?: string }>(res);
    assert.equal(body.processed, false);
    assert.equal(body.reason, "duplicate_delivery");
  });

  test("an unknown providerRequestRef reads as payment_request_not_found", async () => {
    const callback = signedMandateCallback({
      providerEventId: `evt-${suffix}-unknown`,
      providerRequestRef: "no-such-ref",
      status: "Paid",
      brokerageId: A.brokerageId,
      provider: "sandbox",
      mandateProviderRef: "no-such-mandate",
    });
    const res = await fetch(`${baseUrl}/api/financial/webhooks/mandate-payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mandate-payment-signature": callback.signature },
      body: callback.raw,
    });
    assert.equal(res.status, 404);
    const body = await json<{ reason?: string }>(res);
    assert.equal(body.reason, "payment_request_not_found");
  });
});

describe("financial routes — ops", () => {
  test("the outbox dispatch trigger is admin-reachable and returns a sweep summary shape", async () => {
    const res = await fetch(`${baseUrl}/api/financial/ops/dispatch-outbox`, { method: "POST", headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ result: { attempted: number; dispatched: number; stillPending: number; failed: number } }>(res);
    assert.equal(typeof body.result.attempted, "number");
  });
});
