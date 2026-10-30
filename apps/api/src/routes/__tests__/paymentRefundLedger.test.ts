// Refund ledger (Owner t429u; specs/partial-refund-ledger.md §7, the 15-test plan). Synthetic data, local scratch PG only.
// Needs migration 0039 (GATED: applied to local scratch only).
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, entitlementGrants, payments, paymentRefunds, serviceOrders, users } from "@aee/db";
import { MockPaymentProvider, StripePaymentProvider, RefundRejectedError } from "@aee/integration-payments";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { reconcileRefunds } from "../../lib/paymentRefunds.js";
import { cleanupBrokerages, createBrokerageWithUsers, createListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let server: Server;
let baseUrl: string;
const suffix = Date.now();
const MISSING = 999_999_947;
let A: Tenant;
let B: Tenant;
let refundSpy: ReturnType<typeof mock.method>;
const created: number[] = [];

async function call(method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const refund = (id: number, body: unknown = {}, cookie = A.admin.cookie, headers: Record<string, string> = {}) => call("POST", `/payments/${id}/refund`, cookie, body, headers);
async function setGrant(brokerageId: number, key: string, active: boolean) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  if (rows.length === 0) {
    if (active) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  } else {
    await db.update(entitlementGrants).set({ status: active ? "Active" : "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  }
  invalidateEntitlementCache(brokerageId);
}
let seq = 0;
async function paidPayment(): Promise<{ id: number; amount: number }> {
  seq += 1;
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} RL ${seq} St` });
  const so = await call("GET", `/aml/service-orders/by-property/${propertyId}`, A.agent.cookie);
  const soId = ((await so.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
  const c = await call("POST", `/payments/service-orders/${soId}/charge`, A.agent.cookie);
  assert.equal(c.status, 201, await c.clone().text());
  const p = ((await c.json()) as { payment: { id: number; amountCents: number } }).payment;
  created.push(p.id);
  return { id: p.id, amount: p.amountCents };
}
const pay = async (id: number) => (await db.select().from(payments).where(eq(payments.id, id)))[0];
const rows = async (paymentId: number) => db.select().from(paymentRefunds).where(eq(paymentRefunds.paymentId, paymentId)).orderBy(paymentRefunds.id);
const calls = () => refundSpy.mock.callCount();
const json = async (r: Response) => (await r.json()) as { code?: string; refund?: { id: number; status: string; amountCents: number; idempotencyKey: string }; payment?: { status: string; refundedCents: number }; replayed?: boolean };
const soon = (ms = 2 * 60_000) => new Date(Date.now() + ms);
let admin2Cache: DevLoginResult | undefined;
/** A second Brokerage Administrator in brokerage A (independent reviewer). */
async function secondAdmin(): Promise<DevLoginResult> {
  if (!admin2Cache) {
    admin2Cache = await devLogin(baseUrl, { email: `rl-admin2-${suffix}@example.com`, firstName: "Second", lastName: "Admin", brokerageName: `RL A ${suffix}` });
    await db.update(users).set({ role: "Brokerage Administrator" }).where(eq(users.id, admin2Cache.user.id));
  }
  return admin2Cache;
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
  A = await createBrokerageWithUsers(baseUrl, `RL A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `RL B ${suffix}`);
  for (const t of [A, B]) await setGrant(t.brokerageId, "run.access", true);
  const pm = await call("POST", "/payments/payment-methods", A.agent.cookie, { scope: "Mine", providerCustomerRef: `cus_rl_${suffix}`, providerPaymentMethodRef: `pm_rl_${suffix}` });
  assert.equal(pm.status, 201);
  refundSpy = mock.method(MockPaymentProvider.prototype, "refund");
});

after(async () => {
  mock.restoreAll();
  MockPaymentProvider.nextRefundBehaviour = null;
  await cleanupBrokerages([A, B].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("refund ledger: amounts", { concurrency: false }, () => {
  test("1. partial then remainder: PartiallyRefunded -> Refunded; a third refund is 409 PAYMENT_NOT_REFUNDABLE", async () => {
    const p = await paidPayment();
    const r1 = await refund(p.id, { amountCents: 1000 });
    const b1 = await json(r1);
    assert.equal(r1.status, 200);
    assert.equal(b1.refund!.status, "SUCCEEDED");
    assert.equal(b1.payment!.status, "PartiallyRefunded");
    assert.equal((await pay(p.id)).refundedCents, 1000);
    const [so] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, (await pay(p.id)).serviceOrderId));
    assert.equal(so.paymentStatus, "PartiallyRefunded");
    const r2 = await refund(p.id, { amountCents: p.amount - 1000 });
    assert.equal(r2.status, 200);
    assert.equal((await json(r2)).payment!.status, "Refunded");
    assert.equal((await pay(p.id)).refundedCents, p.amount);
    const r3 = await refund(p.id, { amountCents: 1 });
    assert.equal(r3.status, 409);
    assert.equal((await json(r3)).code, "PAYMENT_NOT_REFUNDABLE");
  });

  test("2. omitted amount after a partial refund refunds exactly the remainder", async () => {
    const p = await paidPayment();
    assert.equal((await refund(p.id, { amountCents: 700 })).status, 200);
    const before = calls();
    const r = await refund(p.id, {});
    const b = await json(r);
    assert.equal(r.status, 200);
    assert.equal(b.refund!.amountCents, p.amount - 700);
    assert.equal(calls(), before + 1);
    assert.equal((refundSpy.mock.calls.at(-1)!.arguments[0] as { amountCents: number; idempotencyKey: string }).amountCents, p.amount - 700);
    assert.equal((await pay(p.id)).status, "Refunded");
  });

  test("3. more than the remainder -> 409 EXCEEDS_REMAINING, provider not called", async () => {
    const p = await paidPayment();
    assert.equal((await refund(p.id, { amountCents: 1000 })).status, 200);
    const before = calls();
    const r = await refund(p.id, { amountCents: p.amount - 1000 + 1 });
    assert.equal(r.status, 409);
    assert.equal((await json(r)).code, "REFUND_AMOUNT_EXCEEDS_REMAINING");
    assert.equal(calls(), before);
  });

  test("4. concurrency: two parallel 60% refunds -> exactly one provider call, one 409", async () => {
    const p = await paidPayment();
    const amt = Math.ceil(p.amount * 0.6);
    const before = calls();
    const [x, y] = await Promise.all([refund(p.id, { amountCents: amt }), refund(p.id, { amountCents: amt })]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409]);
    assert.equal(calls(), before + 1);
    assert.equal((await rows(p.id)).length, 1);
    assert.equal((await pay(p.id)).refundedCents, amt);
  });

  test("5. an in-flight UNKNOWN reservation blocks what it covers, allows the rest", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const u = await refund(p.id, { amountCents: 1600 });
    assert.equal(u.status, 202);
    const ub = await json(u);
    assert.equal(ub.code, "REFUND_OUTCOME_UNKNOWN");
    assert.equal(ub.refund!.status, "UNKNOWN");
    const blocked = await refund(p.id, { amountCents: p.amount - 1600 + 1 });
    assert.equal(blocked.status, 409);
    assert.equal((await json(blocked)).code, "REFUND_AMOUNT_EXCEEDS_REMAINING");
    const ok = await refund(p.id, { amountCents: p.amount - 1600 });
    assert.equal(ok.status, 200);
    assert.equal((await pay(p.id)).refundedCents, p.amount - 1600, "UNKNOWN is reserved, not counted");
    const none = await refund(p.id, {});
    assert.equal((await json(none)).code, "REFUND_IN_REVIEW", "nothing unreserved left");
  });

  test("6. same client Idempotency-Key twice: one row, one provider call, same response", async () => {
    const p = await paidPayment();
    const before = calls();
    const h = { "idempotency-key": `click-${suffix}` };
    const r1 = await refund(p.id, { amountCents: 500 }, A.admin.cookie, h);
    const r2 = await refund(p.id, { amountCents: 500 }, A.admin.cookie, h);
    const [b1, b2] = [await json(r1), await json(r2)];
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(b1.refund!.id, b2.refund!.id);
    assert.equal(b2.replayed, true);
    assert.equal(calls(), before + 1);
    assert.equal((await rows(p.id)).length, 1);
    assert.equal((await pay(p.id)).refundedCents, 500);
    const bad = await refund(p.id, { amountCents: 1 }, A.admin.cookie, { "idempotency-key": "bad key!" });
    assert.equal(bad.status, 400);
  });
});

describe("refund ledger: reconciliation", { concurrency: false }, () => {
  test("7. accepted but response lost -> UNKNOWN; reconciler lookup finds it -> SUCCEEDED, ledger updated once", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "accept-then-throw";
    const r = await refund(p.id, { amountCents: 900 });
    assert.equal((await json(r)).refund!.status, "UNKNOWN");
    const before = calls();
    const s1 = await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
    assert.equal(s1.succeeded, 1);
    assert.equal(calls(), before, "lookup, not a POST");
    assert.equal((await rows(p.id))[0].status, "SUCCEEDED");
    assert.equal((await pay(p.id)).refundedCents, 900);
    await reconcileRefunds({ now: soon(10 * 60_000), onlyPaymentIds: [p.id] });
    assert.equal((await pay(p.id)).refundedCents, 900, "not counted twice");
  });

  test("8. not found at provider: inside the window retry with the SAME key; outside -> MANUAL_REVIEW, zero POSTs", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r = await json(await refund(p.id, { amountCents: 400 }));
    const key = r.refund!.idempotencyKey;
    assert.equal(r.refund!.status, "UNKNOWN");
    const before = calls();
    const s = await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
    assert.equal(s.retried, 1);
    assert.equal(calls(), before + 1);
    assert.equal((refundSpy.mock.calls.at(-1)!.arguments[0] as { amountCents: number; idempotencyKey: string }).idempotencyKey, key, "same key, never re-minted");
    assert.equal((await rows(p.id))[0].status, "SUCCEEDED");

    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r2 = await json(await refund(p.id, { amountCents: 300 }));
    await db.update(paymentRefunds).set({ submittedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(paymentRefunds.id, r2.refund!.id));
    const before2 = calls();
    const s2 = await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
    assert.equal(s2.manualReview, 1);
    assert.equal(calls(), before2, "no POST outside the idempotency window");
    assert.equal((await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, r2.refund!.id)))[0].status, "MANUAL_REVIEW");
  });

  test("9. adapter without lookup: UNKNOWN -> MANUAL_REVIEW; operator resolves once; a second resolve is 409", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r = await json(await refund(p.id, { amountCents: 250 }));
    const proto = MockPaymentProvider.prototype as unknown as { lookupRefund?: unknown };
    const original = proto.lookupRefund;
    proto.lookupRefund = undefined;
    try {
      const before = calls();
      const s = await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
      assert.equal(s.manualReview, 1);
      assert.equal(calls(), before);
    } finally {
      proto.lookupRefund = original;
    }
    const id = r.refund!.id;
    assert.equal((await call("POST", `/payments/refunds/${id}/resolve`, A.admin.cookie, { action: "mark_succeeded", note: "checked in dashboard" })).status, 400, "ref required");
    assert.equal((await call("POST", `/payments/refunds/${id}/resolve`, A.agent.cookie, { action: "mark_failed", note: "x" })).status, 403, "admin only");
    // Owner 27 Oct (b): the requester never resolves. (c): with no provider lookup the outcome can't be
    // verified, so even an independent administrator is refused and the refund stays held and reserved.
    const self = await call("POST", `/payments/refunds/${id}/resolve`, A.admin.cookie, { action: "mark_succeeded", providerRefundRef: `re_manual_${suffix}`, note: "checked in dashboard" });
    assert.equal(self.status, 403, await self.clone().text());
    assert.equal((await json(self)).code, "REFUND_RESOLVER_IS_REQUESTER");
    const other = await secondAdmin();
    proto.lookupRefund = undefined;
    try {
      const held = await call("POST", `/payments/refunds/${id}/resolve`, other.cookie, { action: "mark_succeeded", providerRefundRef: `re_manual_${suffix}`, note: "checked in dashboard" });
      assert.equal(held.status, 409, await held.clone().text());
      assert.equal((await json(held)).code, "REFUND_PROVIDER_UNVERIFIED");
    } finally {
      proto.lookupRefund = original;
    }
    assert.equal((await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)))[0].status, "MANUAL_REVIEW");
    assert.equal((await pay(p.id)).refundedCents, 0, "nothing moves without a verified provider record");
    // Once the provider can be asked: the mock has no record of this refund, so FAILED is the verified outcome.
    const ok = await call("POST", `/payments/refunds/${id}/resolve`, other.cookie, { action: "mark_failed", note: "provider has no such refund" });
    assert.equal(ok.status, 200, await ok.clone().text());
    const again = await call("POST", `/payments/refunds/${id}/resolve`, other.cookie, { action: "mark_failed", note: "oops" });
    assert.equal(again.status, 409);
    assert.equal((await json(again)).code, "REFUND_ALREADY_RESOLVED");
    assert.equal((await pay(p.id)).refundedCents, 0);
  });

  test("10. webhook: a partial refund updates that row only; duplicate is a no-op; unknown refund -> EXTERNAL MANUAL_REVIEW", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "pending";
    const r = await refund(p.id, { amountCents: 600 });
    assert.equal(r.status, 202);
    const row = (await json(r)).refund!;
    assert.equal(row.status, "SUBMITTED");
    const chargeRef = (await pay(p.id)).providerChargeRef!;
    const hook = (refunds: unknown[]) => call("POST", "/payments/webhook", undefined, { providerChargeRef: chargeRef, status: "Refunded", refunds });
    const w1 = await hook([{ providerRefundRef: `mock-refund-${row.id}`, amountCents: 600, status: "Succeeded", aeRefundId: row.id }]);
    assert.equal(((await w1.json()) as { processed: boolean }).processed, true);
    let pp = await pay(p.id);
    assert.equal(pp.status, "PartiallyRefunded", "never flipped to Refunded by event type");
    assert.equal(pp.refundedCents, 600);
    const w2 = await hook([{ providerRefundRef: `mock-refund-${row.id}`, amountCents: 600, status: "Succeeded", aeRefundId: row.id }]);
    assert.equal(((await w2.json()) as { reason?: string }).reason, "duplicate_delivery");
    assert.equal((await pay(p.id)).refundedCents, 600);
    const w3 = await hook([{ providerRefundRef: `re_dashboard_${suffix}`, amountCents: 100, status: "Succeeded" }]);
    assert.equal(((await w3.json()) as { processed: boolean }).processed, true);
    const ext = (await rows(p.id)).find((x) => x.providerRefundRef === `re_dashboard_${suffix}`)!;
    assert.equal(ext.status, "MANUAL_REVIEW");
    assert.equal(ext.reason, "EXTERNAL");
    pp = await pay(p.id);
    assert.equal(pp.refundedCents, 600, "ledger not changed silently");
    const legacy = await call("POST", "/payments/webhook", undefined, { providerChargeRef: chargeRef, status: "Refunded" });
    assert.equal(((await legacy.json()) as { reason?: string }).reason, "refund_without_detail");
    assert.equal((await pay(p.id)).status, "PartiallyRefunded");
  });

  test("11. crash between INSERT and provider call (stale PENDING) -> UNKNOWN; retried only with its own key", async () => {
    const p = await paidPayment();
    const [ins] = await db
      .insert(paymentRefunds)
      .values({ paymentId: p.id, brokerageId: A.brokerageId, amountCents: 333, status: "PENDING", idempotencyKey: `payment-refund:${p.id}:stale-${suffix}`, provider: "mock", createdAt: new Date(Date.now() - 10 * 60_000) })
      .returning();
    const fresh = await db
      .insert(paymentRefunds)
      .values({ paymentId: p.id, brokerageId: A.brokerageId, amountCents: 1, status: "PENDING", idempotencyKey: `payment-refund:${p.id}:fresh-${suffix}`, provider: "mock" })
      .returning();
    const before = calls();
    await reconcileRefunds({ onlyPaymentIds: [p.id] });
    assert.equal(calls(), before + 1, "only the stale row");
    assert.equal((refundSpy.mock.calls.at(-1)!.arguments[0] as { amountCents: number; idempotencyKey: string }).idempotencyKey, ins.idempotencyKey);
    assert.equal((await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, ins.id)))[0].status, "SUCCEEDED");
    assert.equal((await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, fresh[0].id)))[0].status, "PENDING", "inside the lease: untouched");
    await db.update(paymentRefunds).set({ status: "FAILED" }).where(eq(paymentRefunds.id, fresh[0].id));
  });
});

describe("refund ledger: access, schema, adapter", { concurrency: false }, () => {
  test("12. tenant isolation: brokerage B can't refund, list or resolve A's refunds (same 404/empty as missing)", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r = await json(await refund(p.id, { amountCents: 200 }));
    const proto = MockPaymentProvider.prototype as unknown as { lookupRefund?: unknown };
    const original = proto.lookupRefund;
    proto.lookupRefund = undefined;
    try {
      await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
    } finally {
      proto.lookupRefund = original;
    }
    const before = calls();
    const f = await refund(p.id, { amountCents: 1 }, B.admin.cookie);
    const m = await refund(MISSING, { amountCents: 1 }, B.admin.cookie);
    assert.deepEqual({ s: f.status, b: await f.text() }, { s: m.status, b: await m.text() });
    assert.equal(f.status, 404);
    const lf = await call("GET", `/payments/${p.id}/refunds`, B.admin.cookie);
    assert.equal(await lf.text(), '{"refunds":[]}');
    const rf = await call("POST", `/payments/refunds/${r.refund!.id}/resolve`, B.admin.cookie, { action: "mark_failed", note: "x" });
    const rm = await call("POST", `/payments/refunds/${MISSING}/resolve`, B.admin.cookie, { action: "mark_failed", note: "x" });
    assert.deepEqual({ s: rf.status, b: await rf.text() }, { s: rm.status, b: await rm.text() });
    assert.equal(rf.status, 404);
    assert.equal(calls(), before);
    assert.equal((await rows(p.id))[0].status, "MANUAL_REVIEW");
    const own = await call("GET", `/payments/${p.id}/refunds`, A.admin.cookie);
    assert.equal(((await own.json()) as { refunds: unknown[] }).refunds.length, 1);
  });

  test("13. Grow-only admin: 403 on refund and resolve (S-1c guard preserved)", async () => {
    const p = await paidPayment();
    await setGrant(A.brokerageId, "run.access", false);
    await setGrant(A.brokerageId, "grow.access", true);
    try {
      const before = calls();
      const r = await refund(p.id, { amountCents: 1 });
      assert.equal(r.status, 403);
      assert.equal(((await r.json()) as { error: string }).error, "Not entitled");
      assert.equal((await call("POST", `/payments/refunds/1/resolve`, A.admin.cookie, { action: "mark_failed", note: "x" })).status, 403);
      assert.equal(calls(), before);
    } finally {
      await setGrant(A.brokerageId, "run.access", true);
    }
    assert.equal((await pay(p.id)).refundedCents, 0);
  });

  test("14. schema 0039: CHECK rejects over-refund and bad rows (backfill proof: evidence 03-migration-0037-proof.log)", async () => {
    const p = await paidPayment();
    await assert.rejects(db.update(payments).set({ refundedCents: p.amount + 1 }).where(eq(payments.id, p.id)), (e: { cause?: { code?: string }; code?: string }) => (e.cause?.code ?? e.code) === "23514");
    await assert.rejects(
      db.insert(paymentRefunds).values({ paymentId: p.id, brokerageId: A.brokerageId, amountCents: 0, idempotencyKey: `zero-${suffix}`, provider: "mock" }),
      (e: { cause?: { code?: string }; code?: string }) => (e.cause?.code ?? e.code) === "23514",
    );
    assert.equal((await pay(p.id)).refundedCents, 0);
  });

  test("15. Stripe adapter contract (fetch stubbed): Idempotency-Key + metadata on refund; refund id returned; 4xx = rejected; lookup by metadata; partial charge.refunded parsed", async () => {
    const stripe = new StripePaymentProvider({ secretKey: "sk_test_synthetic", webhookSecret: "whsec_synthetic", apiBaseUrl: "http://stripe.invalid" });
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let next: { status: number; body: unknown } = { status: 200, body: { id: "re_123", status: "succeeded" } };
    const fetchMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    });
    try {
      const out = await stripe.refund({ providerChargeRef: "pi_1", amountCents: 1234, idempotencyKey: "payment-refund:9:77", aeRefundId: 77 });
      assert.deepEqual(out, { providerRefundRef: "re_123", status: "Succeeded", failureReason: undefined });
      const h = seen[0].init.headers as Record<string, string>;
      assert.equal(h["Idempotency-Key"], "payment-refund:9:77");
      const body = new URLSearchParams(String(seen[0].init.body));
      assert.equal(body.get("metadata[ae_refund_id]"), "77");
      assert.equal(body.get("amount"), "1234");
      assert.equal(body.get("payment_intent"), "pi_1");
      next = { status: 400, body: { error: { message: "amount exceeds" } } };
      await assert.rejects(stripe.refund({ providerChargeRef: "pi_1", amountCents: 1, idempotencyKey: "k2", aeRefundId: 78 }), RefundRejectedError);
      next = { status: 503, body: {} };
      await assert.rejects(stripe.refund({ providerChargeRef: "pi_1", amountCents: 1, idempotencyKey: "k3", aeRefundId: 79 }), (e: Error) => !(e instanceof RefundRejectedError));
      next = { status: 200, body: { data: [{ id: "re_x", status: "succeeded", metadata: { ae_refund_id: "5" } }, { id: "re_y", status: "pending", metadata: { ae_refund_id: "80" } }] } };
      assert.deepEqual(await stripe.lookupRefund({ providerChargeRef: "pi_1", aeRefundId: 80 }), { providerRefundRef: "re_y", status: "Pending", failureReason: undefined });
      assert.match(seen.at(-1)!.url, /\/v1\/refunds\?payment_intent=pi_1/);
      next = { status: 200, body: { data: [] } };
      assert.equal(await stripe.lookupRefund({ providerChargeRef: "pi_1", aeRefundId: 81 }), null);
    } finally {
      fetchMock.mock.restore();
    }
    const parsed = stripe.parseWebhook({
      type: "charge.refunded",
      data: { object: { payment_intent: "pi_1", amount: 10000, amount_refunded: 3000, refunds: { data: [{ id: "re_a", amount: 3000, status: "succeeded", metadata: { ae_refund_id: "12" } }] } } },
    });
    assert.deepEqual(parsed.refunds, [{ providerRefundRef: "re_a", amountCents: 3000, status: "Succeeded", aeRefundId: 12, failureReason: undefined }]);
  });
});

after(async () => {
  if (created.length) await db.delete(paymentRefunds).where(inArray(paymentRefunds.paymentId, created)).catch(() => undefined);
});

// Owner 27 Oct refund rules on the refund ledger's manual review:
// (b) an independent Brokerage Administrator resolves; the requester never does;
// (c) a resolution must match the provider's verified record; with no way to
//     verify (adapter without lookup) the refund stays held and reserved;
// (e) a provider "Succeeded" with no refund reference never moves the ledger.
describe("refund ledger: Owner 27 Oct review rules", { concurrency: false }, () => {
  let admin2: DevLoginResult;
  before(async () => {
    admin2 = await secondAdmin();
  });
  const resolve = (id: number, cookie: string, body: Record<string, unknown>) => call("POST", `/payments/refunds/${id}/resolve`, cookie, body);
  const refundRow = async (id: number) => (await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, id)))[0];
  /** A refund the provider never received, sent to MANUAL_REVIEW (lookup: not found, outside the idempotency window). */
  async function heldNotAtProvider(amountCents: number) {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r = await json(await refund(p.id, { amountCents }));
    await db.update(paymentRefunds).set({ submittedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(paymentRefunds.id, r.refund!.id));
    const s = await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] });
    assert.equal(s.manualReview, 1);
    return { p, id: r.refund!.id };
  }

  test("R-b. the administrator who requested the refund cannot resolve it (403); an independent administrator can", async () => {
    const { p, id } = await heldNotAtProvider(150);
    for (const action of ["mark_failed", "mark_succeeded"]) {
      const self = await resolve(id, A.admin.cookie, { action, note: "self review", providerRefundRef: `re_self_${suffix}` });
      assert.equal(self.status, 403, `${action}: ${await self.clone().text()}`);
      assert.equal((await json(self)).code, "REFUND_RESOLVER_IS_REQUESTER");
    }
    assert.equal((await refundRow(id)).status, "MANUAL_REVIEW", "nothing changes");
    const ok = await resolve(id, admin2.cookie, { action: "mark_failed", note: "provider has no such refund" });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal((await refundRow(id)).status, "FAILED");
    assert.equal((await pay(p.id)).refundedCents, 0);
  });

  test("R-c1. a resolution that contradicts the provider's record is refused; refund stays held, ledger unchanged", async () => {
    const { p, id } = await heldNotAtProvider(175);
    const bad = await resolve(id, admin2.cookie, { action: "mark_succeeded", providerRefundRef: `re_typed_${suffix}`, note: "says it is done" });
    assert.equal(bad.status, 409, await bad.clone().text());
    assert.equal((await json(bad)).code, "REFUND_PROVIDER_MISMATCH");
    assert.equal((await refundRow(id)).status, "MANUAL_REVIEW");
    assert.equal((await pay(p.id)).refundedCents, 0, "an unverified success never moves refunded_cents");
  });

  test("R-c2. no provider lookup available: neither outcome can be verified, so the refund stays held and reserved", async () => {
    const p = await paidPayment();
    MockPaymentProvider.nextRefundBehaviour = "throw";
    const r = await json(await refund(p.id, { amountCents: 125 }));
    const proto = MockPaymentProvider.prototype as unknown as { lookupRefund?: unknown };
    const original = proto.lookupRefund;
    proto.lookupRefund = undefined;
    try {
      assert.equal((await reconcileRefunds({ now: soon(), onlyPaymentIds: [p.id] })).manualReview, 1);
      for (const action of ["mark_succeeded", "mark_failed"]) {
        const res = await resolve(r.refund!.id, admin2.cookie, { action, providerRefundRef: `re_unverified_${suffix}`, note: "checked in dashboard" });
        assert.equal(res.status, 409, `${action}: ${await res.clone().text()}`);
        assert.equal((await json(res)).code, "REFUND_PROVIDER_UNVERIFIED");
      }
    } finally {
      proto.lookupRefund = original;
    }
    assert.equal((await refundRow(r.refund!.id)).status, "MANUAL_REVIEW");
    assert.equal((await pay(p.id)).refundedCents, 0);
  });

  test("R-e. provider says Succeeded but returns no refund reference: the ledger does not move; the refund is held", async () => {
    const p = await paidPayment();
    const m = mock.method(MockPaymentProvider.prototype, "refund", async () => ({ providerRefundRef: "", status: "Succeeded" as const }));
    let id: number;
    try {
      const r = await json(await refund(p.id, { amountCents: 110 }));
      id = r.refund!.id;
    } finally {
      m.mock.restore();
    }
    const row = await refundRow(id!);
    assert.notEqual(row.status, "SUCCEEDED", "an unreferenced success is not verified");
    assert.equal((await pay(p.id)).refundedCents, 0);
  });
});
