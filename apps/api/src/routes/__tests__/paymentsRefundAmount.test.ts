// S-1d (Owner via Grok, 2026-10-21 01:56): POST /payments/:paymentId/refund validates amountCents BEFORE any provider call.
// - omitted -> full refund of payment.amountCents (existing semantics);
// - present: must be a positive integer number, else 400 REFUND_AMOUNT_INVALID (0, negative, fraction, string, null, NaN-ish);
// - > refundable remainder -> 409 REFUND_AMOUNT_EXCEEDS_REMAINING. The schema does not track partial refunds (payments has
//   only status; any refund sets "Refunded"), so remainder = payment.amountCents (gap reported, no migration).
// Proof of "no provider call": MockPaymentProvider.prototype.refund is wrapped with node:test mock and its call count asserted.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, payments } from "@aee/db";
import { MockPaymentProvider } from "@aee/integration-payments";
import { cleanupBrokerages, createBrokerageWithUsers, createListedProperty, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: Tenant;
const paid: number[] = [];
let refundSpy: ReturnType<typeof mock.method>;

const refund = (id: number, body: string) =>
  fetch(`${baseUrl}/api/payments/${id}/refund`, { method: "POST", headers: { "content-type": "application/json", cookie: A.admin.cookie }, body });
async function paidPayment(label: string): Promise<number> {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} S1d ${label} St` });
  const so = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${propertyId}`, { headers: { cookie: A.agent.cookie } });
  const soId = ((await so.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
  const c = await fetch(`${baseUrl}/api/payments/service-orders/${soId}/charge`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(c.status, 201, await c.clone().text());
  return ((await c.json()) as { payment: { id: number } }).payment.id;
}
async function row(id: number) {
  const [r] = await db.select().from(payments).where(eq(payments.id, id));
  return r;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `S1d A ${suffix}`);
  const pm = await fetch(`${baseUrl}/api/payments/payment-methods`, { method: "POST", headers: { "content-type": "application/json", cookie: A.agent.cookie }, body: JSON.stringify({ scope: "Mine", providerCustomerRef: `cus_s1d_${suffix}`, providerPaymentMethodRef: `pm_s1d_${suffix}` }) });
  assert.equal(pm.status, 201);
  for (let i = 0; i < 4; i++) paid.push(await paidPayment(`p${i}`));
  refundSpy = mock.method(MockPaymentProvider.prototype, "refund");
});

after(async () => {
  mock.restoreAll();
  if (A) await cleanupBrokerages([A.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S-1d: refund amountCents validation", { concurrency: false }, () => {
  const invalid: Array<[string, string]> = [
    ["zero", '{"amountCents":0}'],
    ["negative", '{"amountCents":-100}'],
    ["fraction", '{"amountCents":12.5}'],
    ["numeric string", '{"amountCents":"100"}'],
    ["non-numeric string", '{"amountCents":"abc"}'],
    ["null", '{"amountCents":null}'],
    ["boolean", '{"amountCents":true}'],
    ["unsafe integer", '{"amountCents":9007199254740993}'],
  ];
  for (const [label, body] of invalid) {
    test(`REFUND_AMOUNT_INVALID 400: ${label}; no provider call; payment untouched`, async () => {
      const calls = refundSpy.mock.callCount();
      const r = await refund(paid[0], body);
      assert.equal(r.status, 400, `${label}: ${await r.clone().text()}`);
      const b = (await r.json()) as { error: string; code: string };
      assert.equal(b.code, "REFUND_AMOUNT_INVALID");
      assert.equal(b.error, "Refund amount must be a positive whole number of cents.");
      assert.equal(refundSpy.mock.callCount(), calls, "provider.refund must not be called");
      assert.equal((await row(paid[0])).status, "Succeeded");
    });
  }

  test("REFUND_AMOUNT_EXCEEDS_REMAINING 409: amount > payment amount; no provider call; no amounts echoed", async () => {
    const p = await row(paid[0]);
    const calls = refundSpy.mock.callCount();
    const r = await refund(paid[0], JSON.stringify({ amountCents: p.amountCents + 1 }));
    assert.equal(r.status, 409, await r.clone().text());
    const b = (await r.json()) as { error: string; code: string };
    assert.equal(b.code, "REFUND_AMOUNT_EXCEEDS_REMAINING");
    assert.ok(!b.error.includes(String(p.amountCents)));
    assert.equal(refundSpy.mock.callCount(), calls);
    assert.equal((await row(paid[0])).status, "Succeeded");
  });

  test("exactly the payment amount is allowed (one provider call with that amount)", async () => {
    const p = await row(paid[1]);
    const calls = refundSpy.mock.callCount();
    const r = await refund(paid[1], JSON.stringify({ amountCents: p.amountCents }));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(refundSpy.mock.callCount(), calls + 1);
    assert.equal(refundSpy.mock.calls.at(-1)!.arguments[1], p.amountCents);
  });

  test("a valid partial amount is passed to the provider unchanged", async () => {
    const calls = refundSpy.mock.callCount();
    const r = await refund(paid[2], JSON.stringify({ amountCents: 1 }));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(refundSpy.mock.callCount(), calls + 1);
    assert.equal(refundSpy.mock.calls.at(-1)!.arguments[1], 1);
    // Existing semantics (gap): no partial tracking, so the payment is marked Refunded and a second refund is 409 NOT_REFUNDABLE.
    assert.equal((await row(paid[2])).status, "Refunded");
    const again = await refund(paid[2], JSON.stringify({ amountCents: 1 }));
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { code: string }).code, "PAYMENT_NOT_REFUNDABLE");
  });

  test("omitted amountCents (empty body and {}) -> full refund of payment.amountCents (existing semantics)", async () => {
    const p = await row(paid[3]);
    const calls = refundSpy.mock.callCount();
    const r = await refund(paid[3], "{}");
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(refundSpy.mock.callCount(), calls + 1);
    assert.equal(refundSpy.mock.calls.at(-1)!.arguments[1], p.amountCents);
  });

  test("validation runs before the existence lookup only for shape: invalid amount on a missing id is still 400 (no existence signal either way)", async () => {
    const r = await refund(999_999_961, '{"amountCents":-1}');
    assert.equal(r.status, 400);
    const ok = await refund(999_999_961, '{"amountCents":1}');
    assert.equal(ok.status, 404);
  });
});
