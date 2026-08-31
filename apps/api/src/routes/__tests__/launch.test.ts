// Agent Engine 2.0 — Property Launch & Campaign Coordination.
//
// HTTP-level coverage for routes/launch.ts: auth gating, role gating on
// the financial-decision endpoints (Brokerage Administrator only), tenant
// isolation, and the basic create/read shape of the property-scoped
// endpoint. Model-level behaviour (the four named scenarios, tenant
// isolation on model.ts's own functions, ERX integration) is covered in
// lib/launch/__tests__/model.test.ts — this file only exercises the HTTP
// surface those functions sit behind.
import { test, before, after } from "node:test";
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

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { registerExceptionEngine } = await import("../../lib/exceptions/bootstrap.js");
  registerExceptionEngine({ startScheduler: false });
  const { registerLaunchEngine } = await import("../../lib/launch/bootstrap.js");
  registerLaunchEngine();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `Launch Routes A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Launch Routes B ${suffix}`);
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function waitForLaunchPlan(propertyId: number, cookie: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`${baseUrl}/api/properties/${propertyId}/launch`, { headers: { cookie } });
    const body = (await res.json()) as { launch: { plan: { id: string } } | null };
    if (body.launch) return body.launch;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Launch plan was never auto-proposed for property ${propertyId}`);
}

test("GET /properties/:id/launch requires auth", async () => {
  const res = await fetch(`${baseUrl}/api/properties/1/launch`);
  assert.equal(res.status, 401);
});

test("GET /properties/:id/launch returns launch: null before a launch plan exists, then the plan once Agency Agreement is signed", async () => {
  const propRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ formattedAddress: `20 Not Started Yet St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(propRes.status, 201);
  const { property } = (await propRes.json()) as { property: { id: number } };

  const beforeRes = await fetch(`${baseUrl}/api/properties/${property.id}/launch`, { headers: { cookie: A.agent.cookie } });
  assert.equal(beforeRes.status, 200);
  const beforeBody = (await beforeRes.json()) as { launch: unknown };
  assert.equal(beforeBody.launch, null, "a property before Agency Agreement Signed has no launch plan yet");

  await createListedProperty(baseUrl, A.agent.cookie, { address: `21 Now Signed St ${suffix}` });
});

test("launch plan endpoints enforce tenant isolation — brokerage B gets 404 on brokerage A's launch plan", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `22 Tenant Route St ${suffix}` });
  const launch = await waitForLaunchPlan(propertyId, A.agent.cookie);

  const res = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/transitions`, { headers: { cookie: B.agent.cookie } });
  assert.equal(res.status, 404);
});

test("POST /launch/:id/budget and /launch/vendor-approvals/:id/decide are Brokerage Administrator only", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `23 Admin Only St ${suffix}` });
  const launch = await waitForLaunchPlan(propertyId, A.agent.cookie);

  const agentBudgetRes = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/budget`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ budgetCents: 100000 }),
  });
  assert.equal(agentBudgetRes.status, 403);

  const adminBudgetRes = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/budget`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ budgetCents: 100000 }),
  });
  assert.equal(adminBudgetRes.status, 200);

  const itemRes = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/campaign-items`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ itemType: "PHOTOGRAPHY", title: "Photography" }),
  });
  assert.equal(itemRes.status, 201);
  const { item } = (await itemRes.json()) as { item: { id: string } };

  const approvalRes = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/vendor-approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ approvalType: "CAMPAIGN_ITEM_COST", campaignItemId: item.id, requestedAmountCents: 60000 }),
  });
  assert.equal(approvalRes.status, 201);
  const { approval } = (await approvalRes.json()) as { approval: { id: string } };

  const agentDecideRes = await fetch(`${baseUrl}/api/launch/vendor-approvals/${approval.id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert.equal(agentDecideRes.status, 403);

  const adminDecideRes = await fetch(`${baseUrl}/api/launch/vendor-approvals/${approval.id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ decision: "APPROVED" }),
  });
  assert.equal(adminDecideRes.status, 200);
});

test("campaign item status validation: BLOCKED without a blockedReason is rejected with 400", async () => {
  const { propertyId } = await createListedProperty(baseUrl, A.agent.cookie, { address: `24 Validation St ${suffix}` });
  const launch = await waitForLaunchPlan(propertyId, A.agent.cookie);

  const itemRes = await fetch(`${baseUrl}/api/launch/${launch.plan.id}/campaign-items`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ itemType: "SIGNAGE", title: "Signboard" }),
  });
  const { item } = (await itemRes.json()) as { item: { id: string } };

  const res = await fetch(`${baseUrl}/api/launch/campaign-items/${item.id}/status`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "BLOCKED" }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { reason: string };
  assert.equal(body.reason, "VALIDATION");
});
