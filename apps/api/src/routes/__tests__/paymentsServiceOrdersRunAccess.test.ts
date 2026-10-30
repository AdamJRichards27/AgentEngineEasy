// S-1 (Owner via Grok, 2026-10-20 22:19; spec orchestrator/specs/transaction-services.md S-1, acceptance 4):
// /payments/service-orders/* requires run.access (existing requireEntitlement("run.access")).
// Matrix on the caller's own brokerage: Grow-only, none -> 403 "Not entitled" before any read/charge;
// Run-only, both -> unchanged. Signed out -> 401. Cross-tenant (run.access) -> same 404 as a missing id.
// The AML flow that creates/surfaces service orders (GET /aml/service-orders/by-property) is not regressed.
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
const MISSING = 999_999_931;
let X: Tenant; // owns the service order; entitlements toggled per case
let Y: Tenant; // other brokerage, run.access
let soId: number;
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
async function as(type: "grow" | "run" | "both" | "none") {
  await setGrant(X.brokerageId, "run.access", type === "run" || type === "both");
  await setGrant(X.brokerageId, "grow.access", type === "grow" || type === "both");
}
const routes = (id: number): Array<[string, string]> => [
  ["GET", `/payments/service-orders/${id}`],
  ["GET", `/payments/service-orders/${id}/payments`],
  ["POST", `/payments/service-orders/${id}/charge`],
];
async function paymentCount() {
  return (await db.select({ id: payments.id }).from(payments).where(eq(payments.serviceOrderId, soId))).length;
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
  X = await createBrokerageWithUsers(baseUrl, `S1 X ${suffix}`);
  Y = await createBrokerageWithUsers(baseUrl, `S1 Y ${suffix}`);
  ({ propertyId } = await createListedProperty(baseUrl, X.agent.cookie, { address: `${suffix} S1 Service Order St` }));
  const pm = await call("POST", "/payments/payment-methods", X.agent.cookie, { scope: "Mine", providerCustomerRef: `cus_s1_${suffix}`, providerPaymentMethodRef: `pm_s1_${suffix}` });
  assert.equal(pm.status, 201, await pm.text());
  const so = await call("GET", `/aml/service-orders/by-property/${propertyId}`, X.agent.cookie);
  assert.equal(so.status, 200);
  soId = ((await so.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
});

after(async () => {
  await cleanupBrokerages([X, Y].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S-1: /payments/service-orders/* requires run.access", { concurrency: false }, () => {
  test("signed out: 401 on all three", async () => {
    for (const [m, p] of routes(soId)) assert.equal((await call(m, p)).status, 401, `${m} ${p}`);
  });

  for (const type of ["grow", "none"] as const) {
    test(`${type === "grow" ? "Grow-only" : "no entitlement"}: 403 Not entitled on all three, own order, and no charge happens`, async () => {
      await as(type);
      const before = await paymentCount();
      for (const role of ["agent", "admin"] as const) {
        for (const [m, p] of routes(soId)) {
          const res = await call(m, p, X[role].cookie);
          const text = await res.text();
          assert.equal(res.status, 403, `${type}/${role} ${m} ${p} -> ${res.status} ${text}`);
          assert.equal((JSON.parse(text) as { error?: string }).error, "Not entitled");
          assert.ok(!text.includes(String(propertyId)), "no service-order data in the 403");
        }
      }
      assert.equal(await paymentCount(), before, "no payment created without run.access");
    });
  }

  test("Run-only: unchanged — read, charge (201), list payments", async () => {
    await as("run");
    const get = await call("GET", `/payments/service-orders/${soId}`, X.agent.cookie);
    assert.equal(get.status, 200, await get.clone().text());
    const charge = await call("POST", `/payments/service-orders/${soId}/charge`, X.agent.cookie);
    assert.equal(charge.status, 201, await charge.clone().text());
    const list = await call("GET", `/payments/service-orders/${soId}/payments`, X.agent.cookie);
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as { payments: unknown[] }).payments.length, 1);
  });

  test("both: unchanged — read, idempotent charge (200), list payments", async () => {
    await as("both");
    assert.equal((await call("GET", `/payments/service-orders/${soId}`, X.admin.cookie)).status, 200);
    assert.equal((await call("POST", `/payments/service-orders/${soId}/charge`, X.agent.cookie)).status, 200);
    assert.equal((await call("GET", `/payments/service-orders/${soId}/payments`, X.admin.cookie)).status, 200);
  });

  test("cross-tenant (run.access): foreign id answers exactly like a missing id; no charge", async () => {
    await as("run");
    const before = await paymentCount();
    const f = routes(soId), m = routes(MISSING);
    for (let i = 0; i < f.length; i++) {
      const fr = await call(f[i][0], f[i][1], Y.agent.cookie);
      const mr = await call(m[i][0], m[i][1], Y.agent.cookie);
      const ft = (await fr.text()).replaceAll(String(soId), "<ID>");
      const mt = (await mr.text()).replaceAll(String(MISSING), "<ID>");
      // GET .../payments answers 200 {"payments":[]} for both (pre-existing, indistinguishable); others 404.
      if (fr.status === 200) assert.equal(ft, '{"payments":[]}', `${f[i][1]} leaked rows`);
      assert.deepEqual({ s: fr.status, b: ft }, { s: mr.status, b: mt }, `${f[i][0]} ${f[i][1]} existence leak`);
    }
    assert.equal(await paymentCount(), before);
  });

  test("cross-tenant without run.access: 403 regardless of id (entitlement checked first, no existence signal)", async () => {
    await setGrant(Y.brokerageId, "run.access", false);
    for (const id of [soId, MISSING]) for (const [m, p] of routes(id)) assert.equal((await call(m, p, Y.agent.cookie)).status, 403, `${m} ${p}`);
    await setGrant(Y.brokerageId, "run.access", true);
  });

  test("AML flow not regressed: service orders still listed by property with run.access", async () => {
    await as("run");
    const res = await call("GET", `/aml/service-orders/by-property/${propertyId}`, X.agent.cookie);
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders.some((s) => s.id === soId));
  });
});
