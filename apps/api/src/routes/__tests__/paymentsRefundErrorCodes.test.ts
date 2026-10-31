// S-1c (Owner via Grok, 2026-10-21 01:05): POST /payments/:paymentId/refund
// - requires run.access (requireEntitlement) in addition to the pre-existing requireAuth + Brokerage Administrator role;
// - errors use { error, code }:
//   PAYMENT_NOT_FOUND           404 "Not found" (missing and cross-tenant byte-identical)
//   PAYMENT_NOT_REFUNDABLE      409
//   PAYMENT_NO_CHARGE_REFERENCE 409
//   PAYMENT_REFUND_FAILED       500 "Refund failed" for anything unexpected (detail logged server-side only).
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, payments } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
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
const MISSING = 999_999_951;
let A: Tenant;
let B: Tenant;
let G: Tenant; // grow-only
let N: Tenant; // no entitlement
const paid: number[] = [];

const refund = (id: number, cookie?: string) =>
  fetch(`${baseUrl}/api/payments/${id}/refund`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: "{}" });
async function setGrant(brokerageId: number, key: string, active: boolean) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  if (rows.length === 0) {
    if (active) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  } else await db.update(entitlementGrants).set({ status: active ? "Active" : "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  invalidateEntitlementCache(brokerageId);
}
async function paidPayment(t: Tenant, label: string): Promise<number> {
  const { propertyId } = await createListedProperty(baseUrl, t.agent.cookie, { address: `${suffix} S1c ${label} St` });
  const pm = await fetch(`${baseUrl}/api/payments/payment-methods`, { method: "POST", headers: { "content-type": "application/json", cookie: t.agent.cookie }, body: JSON.stringify({ scope: "Mine", providerCustomerRef: `cus_${label}_${suffix}`, providerPaymentMethodRef: `pm_${label}_${suffix}` }) });
  assert.equal(pm.status, 201);
  const so = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${propertyId}`, { headers: { cookie: t.agent.cookie } });
  const soId = ((await so.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
  const c = await fetch(`${baseUrl}/api/payments/service-orders/${soId}/charge`, { method: "POST", headers: { cookie: t.agent.cookie } });
  assert.equal(c.status, 201, await c.clone().text());
  return ((await c.json()) as { payment: { id: number } }).payment.id;
}
const body = async (r: Response) => (await r.json()) as { error: string; code?: string };

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `S1c A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `S1c B ${suffix}`);
  G = await createBrokerageWithUsers(baseUrl, `S1c G ${suffix}`);
  N = await createBrokerageWithUsers(baseUrl, `S1c N ${suffix}`);
  for (let i = 0; i < 3; i++) paid.push(await paidPayment(A, `p${i}`));
  const gPay = await paidPayment(G, "g");
  const nPay = await paidPayment(N, "n");
  paid.push(gPay, nPay);
  await setGrant(G.brokerageId, "grow.access", true);
  await setGrant(G.brokerageId, "run.access", false);
  await setGrant(N.brokerageId, "run.access", false);
});

after(async () => {
  await cleanupBrokerages([A, B, G, N].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S-1c: refund route — run.access, role preserved, stable codes", { concurrency: false }, () => {
  test("signed out: 401", async () => {
    assert.equal((await refund(paid[0])).status, 401);
  });

  test("role preserved: a non-admin agent with run.access is still refused (403 Forbidden), payment untouched", async () => {
    const r = await refund(paid[0], A.agent.cookie);
    assert.equal(r.status, 403);
    const [row] = await db.select().from(payments).where(eq(payments.id, paid[0]));
    assert.equal(row.status, "Succeeded");
  });

  for (const [label, idx, who] of [["Grow-only", 3, () => G], ["no entitlement", 4, () => N]] as const) {
    test(`${label} admin: 403 Not entitled on own payment, nothing refunded`, async () => {
      const r = await refund(paid[idx], who().admin.cookie);
      assert.equal(r.status, 403);
      assert.equal((await body(r)).error, "Not entitled");
      const [row] = await db.select().from(payments).where(eq(payments.id, paid[idx]));
      assert.equal(row.status, "Succeeded");
    });
  }

  test("PAYMENT_NOT_FOUND: 404 for a missing id", async () => {
    const r = await refund(MISSING, A.admin.cookie);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "Not found", code: "PAYMENT_NOT_FOUND" });
  });

  test("PAYMENT_NOT_FOUND: cross-tenant admin gets a byte-identical 404, payment untouched", async () => {
    const f = await refund(paid[0], B.admin.cookie);
    const m = await refund(MISSING, B.admin.cookie);
    assert.equal(f.status, 404);
    assert.equal(m.status, 404);
    assert.equal(await f.text(), await m.text());
    const [row] = await db.select().from(payments).where(eq(payments.id, paid[0]));
    assert.equal(row.status, "Succeeded");
  });

  test("happy path unchanged for an admin with run.access: 200 Refunded", async () => {
    const r = await refund(paid[0], A.admin.cookie);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(((await r.json()) as { payment: { status: string } }).payment.status, "Refunded");
  });

  test("PAYMENT_NOT_REFUNDABLE: 409 on a second refund, no status or id in the text", async () => {
    const r = await refund(paid[0], A.admin.cookie);
    assert.equal(r.status, 409);
    const b = await body(r);
    assert.equal(b.code, "PAYMENT_NOT_REFUNDABLE");
    assert.ok(!b.error.includes(String(paid[0])) && !/Refunded|status:/.test(b.error), b.error);
  });

  test("PAYMENT_NO_CHARGE_REFERENCE: 409, no id in the text", async () => {
    await db.update(payments).set({ providerChargeRef: null }).where(eq(payments.id, paid[1]));
    const r = await refund(paid[1], A.admin.cookie);
    assert.equal(r.status, 409);
    const b = await body(r);
    assert.equal(b.code, "PAYMENT_NO_CHARGE_REFERENCE");
    assert.ok(!b.error.includes(String(paid[1])));
  });

  test("mapper: known codes -> status; unknown/provider errors -> 500 generic with no internal text", async () => {
    const { refundErrorResponse } = await import("../payments.js");
    const { PaymentRefundError } = await import("../../lib/payments.js");
    assert.deepEqual(refundErrorResponse(new PaymentRefundError("PAYMENT_NOT_FOUND")), { status: 404, body: { error: "Not found", code: "PAYMENT_NOT_FOUND" } });
    assert.equal(refundErrorResponse(new PaymentRefundError("PAYMENT_NOT_REFUNDABLE")).status, 409);
    assert.equal(refundErrorResponse(new PaymentRefundError("PAYMENT_NO_CHARGE_REFERENCE")).status, 409);
    const u = refundErrorResponse(new Error("stripe: ch_live_secret123 No such charge; request req_abc (internal)"));
    assert.deepEqual(u, { status: 500, body: { error: "Refund failed", code: "PAYMENT_REFUND_FAILED" } });
    assert.deepEqual(refundErrorResponse(undefined), u);
  });
});
