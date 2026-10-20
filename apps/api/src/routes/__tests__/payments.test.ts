// Agent Engine 2.0 — Payments (Phase 6) cross-tenant IDOR fix.
//
// HTTP-level coverage for routes/payments.ts + lib/payments.ts: every
// raw-numeric-id load in lib/payments.ts (the charge flow, the refund flow,
// list-payments-for-service-order, and the service-order detail fetch) is
// now scoped by the authenticated caller's own brokerageId, in the same
// query that fetches the row — never a separate post-fetch check. This
// suite proves two things per operation: (1) a same-brokerage caller sees
// no behaviour change at all (the happy-path describe block below), and (2)
// a cross-tenant caller gets the exact same NOT_FOUND-shaped rejection for
// another brokerage's real id as for an id that does not exist at all —
// mirrors launch.test.ts's own "brokerage B gets 404 on brokerage A's X"
// tenant-isolation style, and financial.test.ts's real-server/real-fetch
// integration style.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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

// Two ids that have never been assigned to any row — used as this suite's
// "genuinely nonexistent" baseline that a cross-tenant response must be
// indistinguishable from. Comfortably above any id a fresh local/test
// Postgres sequence will have reached.
const NON_EXISTENT_SERVICE_ORDER_ID = 999_999_901;
const NON_EXISTENT_PAYMENT_ID = 999_999_902;

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

/** Attaches a "Mine"-scoped stored payment method for the caller — the default payer chargeServiceOrder resolves for a property's listing agent. */
async function addOwnPaymentMethod(cookie: string, ref: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/payments/payment-methods`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ scope: "Mine", providerCustomerRef: `cus_${ref}`, providerPaymentMethodRef: `pm_${ref}` }),
  });
  if (res.status !== 201) throw new Error(`add payment method failed: ${res.status} ${await res.text()}`);
}

/** lib/aml.ts's initiateAmlIfNeeded creates one ServiceOrder per AML verification alongside it — this is the real route that surfaces it (same tenant-scoped join precedent this fix follows, see routes/aml.ts). */
async function getServiceOrderId(propertyId: number, cookie: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${propertyId}`, { headers: { cookie } });
  if (res.status !== 200) throw new Error(`list service orders failed: ${res.status} ${await res.text()}`);
  const body = await json<{ serviceOrders: Array<{ id: number }> }>(res);
  if (body.serviceOrders.length === 0) throw new Error(`expected at least one service order for property ${propertyId}`);
  return body.serviceOrders[0].id;
}

/** Drives a brand-new listed property's AmlVerification ServiceOrder all the way through a real, successful charge (MockPaymentProvider always succeeds) via the real routes. */
async function chargeNewServiceOrder(cookie: string, address: string): Promise<{ propertyId: number; serviceOrderId: number; paymentId: number }> {
  const { propertyId } = await createListedProperty(baseUrl, cookie, { address });
  await addOwnPaymentMethod(cookie, `${address.replace(/\s+/g, "-")}-${Math.floor(Math.random() * 1_000_000)}`);
  const serviceOrderId = await getServiceOrderId(propertyId, cookie);

  const chargeRes = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/charge`, { method: "POST", headers: { cookie } });
  if (chargeRes.status !== 201) throw new Error(`charge failed: ${chargeRes.status} ${await chargeRes.text()}`);
  const { payment, created } = await json<{ payment: { id: number; status: string }; created: boolean }>(chargeRes);
  assert.equal(created, true);
  assert.equal(payment.status, "Succeeded");

  return { propertyId, serviceOrderId, paymentId: payment.id };
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

  A = await createBrokerageWithUsers(baseUrl, `Payments Routes A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Payments Routes B ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("unauthenticated requests are rejected", async () => {
  const res = await fetch(`${baseUrl}/api/payments/service-orders/1`);
  assert.equal(res.status, 401);
});

describe("payments routes — same-brokerage happy path (must be unchanged by the tenant-scoping fix)", () => {
  let propertyId: number;
  let serviceOrderId: number;
  let paymentId: number;

  test("POST /service-orders/:id/charge charges the listing agent's default stored method", async () => {
    const result = await chargeNewServiceOrder(A.agent.cookie, `1 Happy Path St ${suffix}`);
    propertyId = result.propertyId;
    serviceOrderId = result.serviceOrderId;
    paymentId = result.paymentId;
  });

  test("GET /service-orders/:id returns the order for a caller in its own brokerage", async () => {
    const res = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ serviceOrder: { id: number; propertyId: number; paymentStatus: string } }>(res);
    assert.equal(body.serviceOrder.id, serviceOrderId);
    assert.equal(body.serviceOrder.propertyId, propertyId);
    assert.equal(body.serviceOrder.paymentStatus, "Charged");
  });

  test("GET /service-orders/:id/payments lists the payment for a caller in its own brokerage", async () => {
    const res = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/payments`, { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ payments: Array<{ id: number; status: string; serviceOrderId: number }> }>(res);
    assert.equal(body.payments.length, 1);
    assert.equal(body.payments[0].id, paymentId);
    assert.equal(body.payments[0].serviceOrderId, serviceOrderId);
    assert.equal(body.payments[0].status, "Succeeded");
  });

  test("POST /:paymentId/refund refunds the payment for a Brokerage Administrator in its own brokerage", async () => {
    const res = await fetch(`${baseUrl}/api/payments/${paymentId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.admin.cookie },
    });
    assert.equal(res.status, 200);
    const body = await json<{ payment: { id: number; status: string } }>(res);
    assert.equal(body.payment.id, paymentId);
    assert.equal(body.payment.status, "Refunded");
  });
});

describe("payments routes — cross-tenant IDOR fix: brokerage B vs brokerage A's ServiceOrder/Payment", () => {
  let serviceOrderId: number;
  let paymentId: number;

  before(async () => {
    const result = await chargeNewServiceOrder(A.agent.cookie, `2 Tenant Isolation St ${suffix}`);
    serviceOrderId = result.serviceOrderId;
    paymentId = result.paymentId;
  });

  test("POST /service-orders/:id/charge — brokerage B gets the same rejection for A's real ServiceOrder as for one that does not exist at all", async () => {
    const crossTenantRes = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/charge`, {
      method: "POST",
      headers: { cookie: B.agent.cookie },
    });
    const nonExistentRes = await fetch(`${baseUrl}/api/payments/service-orders/${NON_EXISTENT_SERVICE_ORDER_ID}/charge`, {
      method: "POST",
      headers: { cookie: B.agent.cookie },
    });

    // S-1b: stable code instead of the raw 400 message.
    assert.equal(crossTenantRes.status, 404, "must reject, never charge brokerage A's stored payment method");
    assert.equal(nonExistentRes.status, crossTenantRes.status);

    const crossTenantBody = await json<{ error: string; code?: string }>(crossTenantRes);
    const nonExistentBody = await json<{ error: string; code?: string }>(nonExistentRes);
    // Same message SHAPE for both ("ServiceOrder <id> not found") — the ids
    // differ by construction, so this checks the template, not literal
    // string equality, which is the real "cannot distinguish exists-but-
    // not-mine from doesn't-exist-at-all" guarantee.
    assert.deepEqual(crossTenantBody, { error: "Not found", code: "SERVICE_ORDER_NOT_FOUND" });
    assert.deepEqual(nonExistentBody, crossTenantBody);

    // Brokerage A's own view must be completely unaffected by B's attempt:
    // still Succeeded, never re-charged or otherwise disturbed.
    const stillA = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/payments`, { headers: { cookie: A.agent.cookie } });
    const stillABody = await json<{ payments: Array<{ status: string }> }>(stillA);
    assert.equal(stillABody.payments.length, 1);
    assert.equal(stillABody.payments[0].status, "Succeeded");
  });

  test("POST /:paymentId/refund — brokerage B's admin gets the same rejection for A's real Payment as for one that does not exist at all", async () => {
    const crossTenantRes = await fetch(`${baseUrl}/api/payments/${paymentId}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B.admin.cookie },
    });
    const nonExistentRes = await fetch(`${baseUrl}/api/payments/${NON_EXISTENT_PAYMENT_ID}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: B.admin.cookie },
    });

    assert.equal(crossTenantRes.status, 400, "must reject, never refund brokerage A's payment");
    assert.equal(nonExistentRes.status, crossTenantRes.status);

    const crossTenantBody = await json<{ error: string }>(crossTenantRes);
    const nonExistentBody = await json<{ error: string }>(nonExistentRes);
    assert.match(crossTenantBody.error, /^Payment \d+ not found$/);
    assert.match(nonExistentBody.error, /^Payment \d+ not found$/);

    // Brokerage A's payment must still be Succeeded, not Refunded, after B's attempt.
    const stillA = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/payments`, { headers: { cookie: A.agent.cookie } });
    const stillABody = await json<{ payments: Array<{ id: number; status: string }> }>(stillA);
    const stillAPayment = stillABody.payments.find((p) => p.id === paymentId);
    assert.ok(stillAPayment);
    assert.equal(stillAPayment?.status, "Succeeded");
  });

  test("GET /service-orders/:id/payments — brokerage B gets the exact same empty list for A's ServiceOrder as for one that does not exist at all", async () => {
    const crossTenantRes = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}/payments`, { headers: { cookie: B.agent.cookie } });
    const nonExistentRes = await fetch(`${baseUrl}/api/payments/service-orders/${NON_EXISTENT_SERVICE_ORDER_ID}/payments`, { headers: { cookie: B.agent.cookie } });

    assert.equal(crossTenantRes.status, 200);
    assert.equal(nonExistentRes.status, 200);
    const crossTenantBody = await json<{ payments: unknown[] }>(crossTenantRes);
    const nonExistentBody = await json<{ payments: unknown[] }>(nonExistentRes);
    assert.deepEqual(crossTenantBody, { payments: [] });
    assert.deepEqual(crossTenantBody, nonExistentBody);
  });

  test("GET /service-orders/:id — brokerage B gets the exact same 404 for A's ServiceOrder as for one that does not exist at all", async () => {
    const crossTenantRes = await fetch(`${baseUrl}/api/payments/service-orders/${serviceOrderId}`, { headers: { cookie: B.agent.cookie } });
    const nonExistentRes = await fetch(`${baseUrl}/api/payments/service-orders/${NON_EXISTENT_SERVICE_ORDER_ID}`, { headers: { cookie: B.agent.cookie } });

    assert.equal(crossTenantRes.status, 404);
    assert.equal(nonExistentRes.status, 404);
    const crossTenantBody = await json<{ error: string }>(crossTenantRes);
    const nonExistentBody = await json<{ error: string }>(nonExistentRes);
    assert.deepEqual(crossTenantBody, { error: "Not found" });
    assert.deepEqual(crossTenantBody, nonExistentBody);
  });
});
