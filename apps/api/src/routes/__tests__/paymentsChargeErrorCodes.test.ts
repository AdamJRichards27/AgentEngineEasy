// S-1b (Owner via Grok, 2026-10-21 00:15; transaction-services.md S-1 "map charge errors to stable codes instead of the
// raw message"). POST /payments/service-orders/:id/charge errors follow the existing `{ error, code }` convention:
//   SERVICE_ORDER_NOT_FOUND        404 { error: "Not found" }   (missing and cross-tenant indistinguishable)
//   PAYMENT_METHOD_REQUIRED        409 (agent-facing sentence, no ids)
//   SERVICE_ORDER_PROPERTY_MISSING 409 (defensive; unreachable via HTTP while the FK holds -> mapper unit test)
//   SERVICE_ORDER_CHARGE_FAILED    500 { error: "Charge failed" } for anything unexpected; internal text never sent.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
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
const MISSING = 999_999_941;
let A: Tenant;
let B: Tenant;
let soNoMethod: number;
let propNoMethod: number;

const charge = (id: number, cookie: string) => fetch(`${baseUrl}/api/payments/service-orders/${id}/charge`, { method: "POST", headers: { cookie } });
async function soFor(propertyId: number, cookie: string) {
  const res = await fetch(`${baseUrl}/api/aml/service-orders/by-property/${propertyId}`, { headers: { cookie } });
  return ((await res.json()) as { serviceOrders: Array<{ id: number }> }).serviceOrders[0].id;
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
  A = await createBrokerageWithUsers(baseUrl, `S1b A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `S1b B ${suffix}`);
  ({ propertyId: propNoMethod } = await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} S1b No Method St` }));
  soNoMethod = await soFor(propNoMethod, A.agent.cookie);
});

after(async () => {
  await cleanupBrokerages([A, B].map((t) => t?.brokerageId).filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S-1b: stable error codes on POST /payments/service-orders/:id/charge", { concurrency: false }, () => {
  test("SERVICE_ORDER_NOT_FOUND: 404, missing id", async () => {
    const res = await charge(MISSING, A.agent.cookie);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found", code: "SERVICE_ORDER_NOT_FOUND" });
  });

  test("SERVICE_ORDER_NOT_FOUND: cross-tenant id answers byte-identically to a missing id", async () => {
    const f = await charge(soNoMethod, B.agent.cookie);
    const m = await charge(MISSING, B.agent.cookie);
    assert.equal(f.status, 404);
    assert.equal(f.status, m.status);
    assert.equal(await f.text(), await m.text());
  });

  test("PAYMENT_METHOD_REQUIRED: 409 with an agent-facing sentence and no ids", async () => {
    const res = await charge(soNoMethod, A.agent.cookie);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; code: string };
    assert.equal(body.code, "PAYMENT_METHOD_REQUIRED");
    assert.equal(body.error, "No default payment method on file for this agent. Add one before charging.");
    assert.ok(!body.error.includes(String(soNoMethod)) && !body.error.includes(String(propNoMethod)));
    assert.deepEqual(Object.keys(body).sort(), ["code", "error"]);
  });

  test("mapper: every known code maps to its status; unknown errors -> 500 generic, no internal text", async () => {
    const { chargeErrorResponse } = await import("../payments.js");
    const { ServiceOrderChargeError } = await import("../../lib/payments.js");
    assert.deepEqual(chargeErrorResponse(new ServiceOrderChargeError("SERVICE_ORDER_NOT_FOUND")), { status: 404, body: { error: "Not found", code: "SERVICE_ORDER_NOT_FOUND" } });
    assert.equal(chargeErrorResponse(new ServiceOrderChargeError("PAYMENT_METHOD_REQUIRED")).status, 409);
    const pm = chargeErrorResponse(new ServiceOrderChargeError("SERVICE_ORDER_PROPERTY_MISSING"));
    assert.equal(pm.status, 409);
    assert.equal(pm.body.code, "SERVICE_ORDER_PROPERTY_MISSING");
    assert.ok(!/\d/.test(pm.body.error), "no ids in the sentence");
    const internal = new Error('duplicate key value violates unique constraint "payments_idempotency_key_unique" (host db-internal-7)');
    const u = chargeErrorResponse(internal);
    assert.deepEqual(u, { status: 500, body: { error: "Charge failed", code: "SERVICE_ORDER_CHARGE_FAILED" } });
    assert.ok(!JSON.stringify(u).includes("constraint"));
    assert.deepEqual(chargeErrorResponse("not even an Error"), u);
  });

  test("no raw-message 400 remains for any charge failure", async () => {
    for (const [id, cookie] of [[MISSING, A.agent.cookie], [soNoMethod, A.agent.cookie], [soNoMethod, B.agent.cookie]] as const) {
      const res = await charge(id, cookie);
      assert.notEqual(res.status, 400);
      const text = await res.text();
      assert.ok(!/ServiceOrder \d+|Property \d+/.test(text), `raw internal text leaked: ${text}`);
    }
  });
});
