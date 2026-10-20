// D6 (Owner direction t113u; specs/decisions-pack.md D6): service-order Cancelled status and an
// application-level duplicate-order guard. Synthetic data only.
// Covers: cancel permissions (own agent, admin, other agent, Pit Crew, Grow-only, cross-tenant == missing),
// repeat submits (idempotent cancel, idempotent AML request), concurrent requests (parallel AML requests
// create one order; parallel cancels write one audit row), history preserved, cancelled orders never charged
// or retried.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, payments, serviceOrders, amlVerifications, auditLogs, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, createListedProperty, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

type Tenant = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let server: Server;
let baseUrl: string;
const suffix = Date.now();
const MISSING = 999_999_937;
let X: Tenant;
let Y: Tenant;
let otherAgent: DevLoginResult;
let pitCrew: DevLoginResult;
let propertyId: number;

async function call(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function setGrant(brokerageId: number, key: string, active: boolean) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  if (rows.length === 0) {
    if (active) await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  } else {
    await db.update(entitlementGrants).set({ status: active ? "Active" : "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, key)));
  }
  invalidateEntitlementCache(brokerageId);
}
let partySeq = 0;
async function addBuyer(): Promise<number> {
  partySeq += 1;
  const res = await call("POST", "/parties", X.agent.cookie, { propertyId, role: "Buyer", firstName: "Bea", lastName: `Buyer${partySeq}`, email: `d6-buyer-${suffix}-${partySeq}@example.com` });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { party: { id: number } }).party.id;
}
/** A fresh Ordered AML service order for a new buyer party. */
async function newOrder(): Promise<number> {
  const partyId = await addBuyer();
  const res = await call("POST", "/aml/request", X.agent.cookie, { propertyId, partyId });
  assert.equal(res.status, 201, await res.clone().text());
  const [row] = await db.select().from(serviceOrders).where(and(eq(serviceOrders.propertyId, propertyId), eq(serviceOrders.partyId, partyId)));
  assert.equal(row.status, "Ordered");
  return row.id;
}
async function cancelAudits(soId: number) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.action, "service_order_cancelled"), eq(auditLogs.recordId, String(soId))));
}
const cancel = (id: number, cookie: string, body: unknown = { reason: "Ordered in error" }) => call("POST", `/payments/service-orders/${id}/cancel`, cookie, body);

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  X = await createBrokerageWithUsers(baseUrl, `D6 X ${suffix}`);
  Y = await createBrokerageWithUsers(baseUrl, `D6 Y ${suffix}`);
  for (const t of [X, Y]) {
    await setGrant(t.brokerageId, "run.access", true);
    await setGrant(t.brokerageId, "grow.access", true);
  }
  otherAgent = await devLogin(baseUrl, { email: `agent2-d6-x-${suffix}@example.com`, firstName: "Other", lastName: "Agent", brokerageName: `D6 X ${suffix}` });
  assert.equal(otherAgent.user.role, "Agent");
  pitCrew = await devLogin(baseUrl, { email: `pit-d6-x-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: `D6 X ${suffix}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  ({ propertyId } = await createListedProperty(baseUrl, X.agent.cookie, { address: `${suffix} D6 Cancel St` }));
});

after(async () => {
  await cleanupBrokerages([X, Y].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("D6: service-order cancel permissions", { concurrency: false }, () => {
  test("property's own agent can cancel an Ordered order; row kept as Cancelled with an audit row", async () => {
    const id = await newOrder();
    const res = await cancel(id, X.agent.cookie);
    const body = (await res.json()) as { serviceOrder: { status: string }; cancelled: boolean };
    assert.equal(res.status, 200);
    assert.equal(body.cancelled, true);
    assert.equal(body.serviceOrder.status, "Cancelled");
    const [row] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, id));
    assert.equal(row.status, "Cancelled", "history preserved: row updated, not deleted");
    const audits = await cancelAudits(id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].userId, X.agent.user.id);
    assert.equal(audits[0].previousValue, "Ordered");
    assert.match(audits[0].updatedValue ?? "", /Ordered in error/);
    const list = await call("GET", `/aml/service-orders/by-property/${propertyId}`, X.agent.cookie);
    const listed = ((await list.json()) as { serviceOrders: Array<{ id: number; status: string }> }).serviceOrders.find((o) => o.id === id);
    assert.equal(listed?.status, "Cancelled", "cancelled order still listed");
  });

  test("Brokerage Administrator can cancel", async () => {
    const id = await newOrder();
    const res = await cancel(id, X.admin.cookie);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await cancelAudits(id))[0].userId, X.admin.user.id);
  });

  test("another agent in the same brokerage and Pit Crew get 403 and change nothing", async () => {
    const id = await newOrder();
    for (const who of [otherAgent, pitCrew]) {
      const res = await cancel(id, who.cookie);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { code: string }).code, "SERVICE_ORDER_CANCEL_FORBIDDEN");
    }
    const [row] = await db.select().from(serviceOrders).where(eq(serviceOrders.id, id));
    assert.equal(row.status, "Ordered");
    assert.equal((await cancelAudits(id)).length, 0);
  });

  test("a reason is required (400, nothing changes)", async () => {
    const id = await newOrder();
    for (const body of [{}, { reason: "   " }]) {
      const res = await cancel(id, X.agent.cookie, body);
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as { code: string }).code, "SERVICE_ORDER_CANCEL_REASON_REQUIRED");
    }
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, "Ordered");
  });

  test("tenant isolation: another brokerage's admin and agent get the same 404 as a missing id", async () => {
    const id = await newOrder();
    for (const who of [Y.admin, Y.agent]) {
      const f = await cancel(id, who.cookie);
      const m = await cancel(MISSING, who.cookie);
      assert.deepEqual({ s: f.status, b: await f.text() }, { s: m.status, b: await m.text() });
      assert.equal(f.status, 404);
    }
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, "Ordered");
  });

  test("signed out 401; Grow-only 403 Not entitled before any lookup", async () => {
    const id = await newOrder();
    assert.equal((await cancel(id, "")).status, 401);
    await setGrant(X.brokerageId, "run.access", false);
    try {
      for (const target of [id, MISSING]) {
        const res = await cancel(target, X.admin.cookie);
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as { error: string }).error, "Not entitled");
      }
    } finally {
      await setGrant(X.brokerageId, "run.access", true);
    }
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, "Ordered");
  });
});

describe("D6: cancellable states and money", { concurrency: false }, () => {
  test("InProgress / Completed / Failed orders can't be cancelled (409)", async () => {
    for (const status of ["InProgress", "Completed", "Failed"]) {
      const id = await newOrder();
      await db.update(serviceOrders).set({ status }).where(eq(serviceOrders.id, id));
      const res = await cancel(id, X.admin.cookie);
      assert.equal(res.status, 409, status);
      assert.equal(((await res.json()) as { code: string }).code, "SERVICE_ORDER_NOT_CANCELLABLE");
      assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, status);
    }
  });

  test("an order with a live payment can't be cancelled (409 HAS_PAYMENT)", async () => {
    const id = await newOrder();
    const pm = await call("POST", "/payments/payment-methods", X.agent.cookie, { scope: "Mine", providerCustomerRef: `cus_d6_${suffix}`, providerPaymentMethodRef: `pm_d6_${suffix}` });
    assert.ok(pm.status === 201 || pm.status === 200, await pm.clone().text());
    const charge = await call("POST", `/payments/service-orders/${id}/charge`, X.agent.cookie);
    assert.equal(charge.status, 201, await charge.clone().text());
    const res = await cancel(id, X.admin.cookie);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "SERVICE_ORDER_HAS_PAYMENT");
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, "Ordered");
  });

  test("a cancelled order is never charged (409 SERVICE_ORDER_CANCELLED, no payment row)", async () => {
    const id = await newOrder();
    assert.equal((await cancel(id, X.agent.cookie)).status, 200);
    const res = await call("POST", `/payments/service-orders/${id}/charge`, X.agent.cookie);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "SERVICE_ORDER_CANCELLED");
    assert.equal((await db.select().from(payments).where(eq(payments.serviceOrderId, id))).length, 0);
  });

  test("a cancelled order's verification can't be retried (re-order needs a deliberate new request)", async () => {
    const id = await newOrder();
    assert.equal((await cancel(id, X.agent.cookie)).status, 200);
    const [v] = await db.select().from(amlVerifications).where(eq(amlVerifications.serviceOrderId, id));
    await db.update(amlVerifications).set({ status: "Failed" }).where(eq(amlVerifications.id, v.id));
    const res = await call("POST", `/aml/${v.id}/retry`, X.agent.cookie);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /cancelled service order/);
    assert.equal((await db.select().from(serviceOrders).where(eq(serviceOrders.id, id)))[0].status, "Cancelled");
  });
});

describe("D6: repeat submits and concurrency", { concurrency: false }, () => {
  test("repeat cancel is idempotent: 200 cancelled:false, still one audit row", async () => {
    const id = await newOrder();
    assert.equal((await cancel(id, X.agent.cookie)).status, 200);
    const again = await cancel(id, X.agent.cookie);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { cancelled: boolean }).cancelled, false);
    assert.equal((await cancelAudits(id)).length, 1);
  });

  test("concurrent cancels: exactly one cancels, one audit row", async () => {
    const id = await newOrder();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => cancel(id, i % 2 ? X.admin.cookie : X.agent.cookie)));
    const bodies = await Promise.all(results.map(async (r) => ({ s: r.status, b: (await r.json()) as { cancelled?: boolean } })));
    assert.ok(bodies.every((x) => x.s === 200), JSON.stringify(bodies));
    assert.equal(bodies.filter((x) => x.b.cancelled === true).length, 1);
    assert.equal((await cancelAudits(id)).length, 1);
  });

  test("repeat AML request for the same party returns the existing order (200), no second order", async () => {
    const partyId = await addBuyer();
    const first = await call("POST", "/aml/request", X.agent.cookie, { propertyId, partyId });
    assert.equal(first.status, 201);
    const second = await call("POST", "/aml/request", X.admin.cookie, { propertyId, partyId });
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { created: boolean }).created, false);
    const rows = await db.select().from(serviceOrders).where(and(eq(serviceOrders.propertyId, propertyId), eq(serviceOrders.partyId, partyId)));
    assert.equal(rows.length, 1);
  });

  test("concurrent AML requests for the same party create exactly one service order and one verification", async () => {
    const partyId = await addBuyer();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call("POST", "/aml/request", i % 2 ? X.admin.cookie : X.agent.cookie, { propertyId, partyId })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200, 201], JSON.stringify(statuses));
    const orders = await db.select().from(serviceOrders).where(and(eq(serviceOrders.propertyId, propertyId), eq(serviceOrders.partyId, partyId)));
    const verifications = await db.select().from(amlVerifications).where(and(eq(amlVerifications.propertyId, propertyId), eq(amlVerifications.partyId, partyId)));
    assert.equal(orders.length, 1, "one billable order");
    assert.equal(verifications.length, 1);
    assert.equal(verifications[0].serviceOrderId, orders[0].id);
  });

  test("concurrent AML requests from another brokerage never create an order on this property", async () => {
    const partyId = await addBuyer();
    const results = await Promise.all(Array.from({ length: 4 }, () => call("POST", "/aml/request", Y.agent.cookie, { propertyId, partyId })));
    assert.ok(results.every((r) => r.status === 404));
    assert.equal((await db.select().from(serviceOrders).where(and(eq(serviceOrders.propertyId, propertyId), eq(serviceOrders.partyId, partyId)))).length, 0);
  });
});
