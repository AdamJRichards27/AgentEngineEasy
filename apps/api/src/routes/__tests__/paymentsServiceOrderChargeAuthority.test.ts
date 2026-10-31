// Owner t174u(4) (CC #37): POST /payments/service-orders/:id/charge debits the
// property listing agent's saved card, so only that listing agent or a
// Brokerage Administrator of the same brokerage may trigger it.
//   - Pit Crew (same brokerage): 403 SERVICE_ORDER_CHARGE_FORBIDDEN, no payment row, no provider call.
//   - Any other Agent in the brokerage: the same 404 as a missing id (no disclosure).
//   - Cross-brokerage callers (Admin or Agent): the same 404 as a missing id.
//   - Denial happens before the idempotent "already settled" return, so a denied
//     caller learns nothing about payment state.
//   - Every attempt (charged, already settled, denied, failed) writes one audit row
//     with caller, role and outcome code, and never card data.
// Synthetic data only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, auditLogs, entitlementGrants, payments, users } from "@aee/db";
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
let X: Tenant; // listing agent = X.agent; X.admin = Brokerage Administrator
let Y: Tenant; // another brokerage
let otherAgent: DevLoginResult; // second Agent in X, not the listing agent
let pitCrew: DevLoginResult; // Pit Crew in X
let soBySelf: number; // charged by the listing agent
let soByAdmin: number; // charged by X's Brokerage Administrator
let soNoMethod: number; // property whose listing agent has no stored method (failure audit)
let propBySelf: number;
const PM_REF = `pm_chg_auth_${suffix}`;
const CUS_REF = `cus_chg_auth_${suffix}`;

async function call(method: string, path: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
const charge = (id: number, cookie: string) => call("POST", `/payments/service-orders/${id}/charge`, cookie);
async function grantRun(brokerageId: number) {
  const rows = await db.select().from(entitlementGrants).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  if (rows.length === 0) {
    await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: "run.access", granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  } else {
    await db.update(entitlementGrants).set({ status: "Active" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  }
  invalidateEntitlementCache(brokerageId);
}
async function serviceOrderFor(propertyId: number, cookie: string): Promise<number> {
  const so = await call("GET", `/aml/service-orders/by-property/${propertyId}`, cookie);
  assert.equal(so.status, 200, await so.clone().text());
  return ((await so.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
}
async function paymentsFor(serviceOrderId: number) {
  return db.select().from(payments).where(eq(payments.serviceOrderId, serviceOrderId));
}
async function chargeAuditRows(serviceOrderId: number) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.recordType, "service_order"),
        eq(auditLogs.recordId, String(serviceOrderId)),
        inArray(auditLogs.action, ["service_order_charged", "service_order_charge_denied", "service_order_charge_failed"]),
      ),
    )
    .orderBy(desc(auditLogs.id));
}
function assertNoCardData(row: Record<string, unknown>) {
  const text = JSON.stringify(row);
  assert.ok(!text.includes(PM_REF), "no payment-method provider ref in audit");
  assert.ok(!text.includes(CUS_REF), "no provider customer ref in audit");
  assert.ok(!/last4|card_?number|cvc|exp_?(month|year)/i.test(text), "no card fields in audit");
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
  X = await createBrokerageWithUsers(baseUrl, `ChgAuth X ${suffix}`);
  Y = await createBrokerageWithUsers(baseUrl, `ChgAuth Y ${suffix}`);
  otherAgent = await devLogin(baseUrl, { email: `other-agent-chgauth-${suffix}@example.com`, firstName: "Other", lastName: "Agent", brokerageName: `ChgAuth X ${suffix}` });
  pitCrew = await devLogin(baseUrl, { email: `pitcrew-chgauth-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: `ChgAuth X ${suffix}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  assert.equal(otherAgent.user.role, "Agent");
  assert.equal(otherAgent.user.brokerageId, X.brokerageId);
  await grantRun(X.brokerageId);
  await grantRun(Y.brokerageId);

  ({ propertyId: propBySelf } = await createListedProperty(baseUrl, X.agent.cookie, { address: `${suffix} Self Charge St` }));
  const { propertyId: propByAdmin } = await createListedProperty(baseUrl, X.agent.cookie, { address: `${suffix} Admin Charge St` });
  const pm = await call("POST", "/payments/payment-methods", X.agent.cookie, { scope: "Mine", providerCustomerRef: CUS_REF, providerPaymentMethodRef: PM_REF });
  assert.equal(pm.status, 201, await pm.text());
  soBySelf = await serviceOrderFor(propBySelf, X.agent.cookie);
  soByAdmin = await serviceOrderFor(propByAdmin, X.agent.cookie);
  const { propertyId: propNoMethod } = await createListedProperty(baseUrl, otherAgent.cookie, { address: `${suffix} No Method St` });
  soNoMethod = await serviceOrderFor(propNoMethod, otherAgent.cookie);
});

after(async () => {
  await cleanupBrokerages([X, Y].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t174u(4): saved-card charge restricted to the listing agent and same-brokerage Brokerage Administrators", { concurrency: false }, () => {
  test("chargeAuthorizationFor: role matrix", async () => {
    const { chargeAuthorizationFor } = await import("../../lib/payments.js");
    assert.equal(typeof chargeAuthorizationFor, "function", "authorization helper exists");
    const prop = { agentId: 10 };
    assert.equal(chargeAuthorizationFor({ id: 10, role: "Agent" }, prop), "allowed");
    assert.equal(chargeAuthorizationFor({ id: 99, role: "Brokerage Administrator" }, prop), "allowed");
    assert.equal(chargeAuthorizationFor({ id: 11, role: "Agent" }, prop), "not_found");
    assert.equal(chargeAuthorizationFor({ id: 10, role: "Pit Crew" }, prop), "forbidden", "Pit Crew never charges, even if somehow recorded as agentId");
    assert.equal(chargeAuthorizationFor({ id: 12, role: "Pit Crew" }, prop), "forbidden");
    assert.equal(chargeAuthorizationFor({ id: 10, role: "Something Else" }, prop), "not_found", "unknown roles fail closed");
  });

  test("Pit Crew in the same brokerage: 403 SERVICE_ORDER_CHARGE_FORBIDDEN, no payment, no ids in the body", async () => {
    const res = await charge(soBySelf, pitCrew.cookie);
    const text = await res.text();
    assert.equal(res.status, 403, text);
    const body = JSON.parse(text) as { error: string; code: string };
    assert.equal(body.code, "SERVICE_ORDER_CHARGE_FORBIDDEN");
    assert.ok(!text.includes(String(soBySelf)) && !text.includes(String(propBySelf)));
    assert.equal((await paymentsFor(soBySelf)).length, 0, "Pit Crew must never create a payment");
  });

  test("another Agent in the same brokerage: same 404 as a missing id, no payment", async () => {
    const f = await charge(soBySelf, otherAgent.cookie);
    const m = await charge(MISSING, otherAgent.cookie);
    assert.equal(f.status, 404);
    assert.equal(await f.text(), await m.text());
    assert.equal((await paymentsFor(soBySelf)).length, 0);
  });

  test("cross-brokerage Admin and Agent: same 404 as a missing id, no payment", async () => {
    for (const who of [Y.admin, Y.agent]) {
      const f = await charge(soBySelf, who.cookie);
      const m = await charge(MISSING, who.cookie);
      assert.equal(f.status, 404);
      assert.equal(await f.text(), await m.text());
    }
    assert.equal((await paymentsFor(soBySelf)).length, 0);
  });

  test("listing agent: 201 charges their own default method", async () => {
    const res = await charge(soBySelf, X.agent.cookie);
    assert.equal(res.status, 201, await res.clone().text());
    const body = (await res.json()) as { created: boolean; payment: { status: string } };
    assert.equal(body.created, true);
    assert.equal(body.payment.status, "Succeeded");
    assert.equal((await paymentsFor(soBySelf)).length, 1);
  });

  test("same-brokerage Brokerage Administrator: 201, then the listing agent's repeat is idempotent (200)", async () => {
    const res = await charge(soByAdmin, X.admin.cookie);
    assert.equal(res.status, 201, await res.clone().text());
    const again = await charge(soByAdmin, X.agent.cookie);
    assert.equal(again.status, 200);
    assert.equal((await paymentsFor(soByAdmin)).length, 1);
  });

  test("denial precedes the idempotent return: Pit Crew and other agents learn nothing about an already-settled order", async () => {
    const pc = await charge(soBySelf, pitCrew.cookie);
    assert.equal(pc.status, 403);
    const pcText = await pc.text();
    assert.ok(!pcText.includes("Succeeded") && !pcText.includes("payment\""), "no payment state to Pit Crew");
    const oa = await charge(soBySelf, otherAgent.cookie);
    assert.equal(oa.status, 404);
    assert.deepEqual(await oa.json(), { error: "Not found", code: "SERVICE_ORDER_NOT_FOUND" });
    assert.equal((await paymentsFor(soBySelf)).length, 1, "still exactly one payment");
  });

  test("failed attempt (listing agent with no stored method): 409 and a service_order_charge_failed audit row", async () => {
    const res = await charge(soNoMethod, otherAgent.cookie);
    assert.equal(res.status, 409);
    const [row] = await chargeAuditRows(soNoMethod);
    assert.equal(row.action, "service_order_charge_failed");
    assert.equal(row.userId, otherAgent.user.id);
    assert.deepEqual(JSON.parse(row.updatedValue ?? "{}"), { outcome: "failed", callerRole: "Agent", code: "PAYMENT_METHOD_REQUIRED" });
  });

  test("every attempt is audited with caller, role and outcome — and never card data", async () => {
    const selfRows = await chargeAuditRows(soBySelf);
    const byUser = (userId: number, action: string) => selfRows.filter((r) => r.userId === userId && r.action === action);
    // Pit Crew: two denials (before and after settlement), with the property id since the order is in their brokerage.
    const pc = byUser(pitCrew.user.id, "service_order_charge_denied");
    assert.equal(pc.length, 2);
    for (const r of pc) {
      assert.deepEqual(JSON.parse(r.updatedValue ?? "{}"), { outcome: "denied", callerRole: "Pit Crew", code: "SERVICE_ORDER_CHARGE_FORBIDDEN" });
      assert.equal(r.propertyId, propBySelf);
      assert.equal(r.brokerageId, X.brokerageId);
    }
    const oa = byUser(otherAgent.user.id, "service_order_charge_denied");
    assert.equal(oa.length, 2);
    for (const r of oa) assert.deepEqual(JSON.parse(r.updatedValue ?? "{}"), { outcome: "denied", callerRole: "Agent", code: "SERVICE_ORDER_NOT_FOUND" });
    // Cross-brokerage: denied, attributed to the caller's own brokerage, and no foreign property id recorded.
    for (const who of [Y.admin, Y.agent]) {
      const rows = byUser(who.user.id, "service_order_charge_denied");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].brokerageId, Y.brokerageId);
      assert.equal(rows[0].propertyId, null);
    }
    const charged = byUser(X.agent.user.id, "service_order_charged");
    assert.equal(charged.length, 1);
    const v = JSON.parse(charged[0].updatedValue ?? "{}") as Record<string, unknown>;
    assert.equal(v.outcome, "charged");
    assert.equal(v.callerRole, "Agent");
    assert.equal(v.paymentStatus, "Succeeded");
    assert.equal(typeof v.amountCents, "number");
    const adminRows = await chargeAuditRows(soByAdmin);
    const adminCharged = adminRows.find((r) => r.userId === X.admin.user.id && r.action === "service_order_charged");
    assert.ok(adminCharged, "Brokerage Administrator charge audited");
    assert.equal(JSON.parse(adminCharged!.updatedValue ?? "{}").callerRole, "Brokerage Administrator");
    const repeat = adminRows.find((r) => r.userId === X.agent.user.id && r.action === "service_order_charged");
    assert.equal(JSON.parse(repeat!.updatedValue ?? "{}").outcome, "already_settled");
    for (const r of [...selfRows, ...adminRows]) assertNoCardData(r as unknown as Record<string, unknown>);
  });
});
