// AE GROW Priority 6 Stage B — HTTP-level regression coverage for
// POST /ai/ask with contextType: "grow". Follows the same real-app,
// real-HTTP-request pattern as routes/__tests__/ai.test.ts and
// routes/__tests__/growToday.test.ts (spins up the real app via
// createApp(), a real session cookie, real entitlement grants) so this
// exercises the exact same request path a real client hits - request
// validation (Zod), requireAuth, the entitlement gate, the rate limiter,
// and the full Response Contract shape, all together, not just the
// orchestrator function in isolation (see
// lib/ai/__tests__/growOrchestrator.test.ts for that unit-level coverage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

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
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function askGrow(cookie: string | undefined, overrides: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/ai/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ question: "Who should I call today?", contextType: "grow", contextId: null, ...overrides }),
  });
}

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createOverdueOpportunity(cookie: string, propertyId: number, partyId: number, reason: string) {
  const createRes = await fetch(`${baseUrl}/api/grow/opportunities`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ partyId, propertyId, opportunityType: "Listing", reason }),
  });
  if (createRes.status !== 201) throw new Error(`create opportunity failed: ${createRes.status} ${await createRes.text()}`);
  const { opportunity } = (await createRes.json()) as { opportunity: { id: number } };

  const patchRes = await fetch(`${baseUrl}/api/grow/opportunities/${opportunity.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ nextActionDueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
  });
  if (patchRes.status !== 200) throw new Error(`patch opportunity failed: ${patchRes.status} ${await patchRes.text()}`);
  return opportunity.id;
}

test("POST /api/ai/ask (grow) requires authentication", async () => {
  const res = await askGrow(undefined);
  assert.equal(res.status, 401);
});

test("POST /api/ai/ask (grow) is refused with 403 for a brokerage without grow.access, even though it can use RUN Copilot", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route 403 ${suffix}`);
  try {
    const growRes = await askGrow(fresh.agent.cookie);
    assert.equal(growRes.status, 403);
    const growBody = (await growRes.json()) as { error: string };
    assert.match(growBody.error, /Grow or Pro plan/);

    const copilotRes = await fetch(`${baseUrl}/api/ai/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ question: "How many active properties do I have?", contextType: null, contextId: null }),
    });
    assert.equal(copilotRes.status, 200, "the new Grow gate must never block a STARTER brokerage's existing, non-Grow Copilot access");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (grow) rejects an oversized question (>2000 chars) and an oversized growFocusItemId (>64 chars) with 400, before touching the database", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Validation ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");

    const oversizedQuestion = await askGrow(fresh.agent.cookie, { question: "x".repeat(2001) });
    assert.equal(oversizedQuestion.status, 400);

    const oversizedFocusId = await askGrow(fresh.agent.cookie, { growFocusItemId: "x".repeat(65) });
    assert.equal(oversizedFocusId.status, 400);

    const emptyQuestion = await askGrow(fresh.agent.cookie, { question: "" });
    assert.equal(emptyQuestion.status, 400);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (grow) succeeds for an entitled brokerage and returns the full Grow Response Contract shape", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Success ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    const res = await askGrow(fresh.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      requestId: string;
      response: {
        kind: string;
        riskLevel: number;
        limitations?: string[];
        dataFreshness?: string;
        supportingRecords?: unknown[];
        suggestedNextStep?: string;
      };
    };
    assert.equal(typeof body.requestId, "string");
    assert.equal(body.response.riskLevel, 0);
    assert.ok(["fact", "summary", "indicator", "unknown"].includes(body.response.kind));
    assert.ok(Array.isArray(body.response.limitations) && body.response.limitations.length > 0);
    assert.equal(typeof body.response.dataFreshness, "string");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (grow) with growFocusItemId set returns a suggestedNextStep matching that item's own recommended action", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Focus ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    // createOverdueOpportunity below POSTs/PATCHes /api/grow/opportunities,
    // which requires its own separate grow.opportunities.manage entitlement
    // (apps/api/src/routes/grow.ts) - grow.access alone only gates the GET routes.
    await grant(fresh.brokerageId, "grow.opportunities.manage");
    const propertyId = await createProperty(fresh.agent.cookie, "5 Route Focus Item Ave");
    const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Fiona", lastName: "RouteFocus" });
    const opportunityId = await createOverdueOpportunity(fresh.agent.cookie, propertyId, partyId, "Route-level focus item fixture.");
    const focusId = `opportunity:${opportunityId}`;

    const res = await askGrow(fresh.agent.cookie, { question: "Explain this item to me.", growFocusItemId: focusId });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { response: { suggestedNextStep?: string; supportingRecords?: Array<{ recordType: string; recordId: number; label: string; deepLink: string | null }> } };
    assert.equal(typeof body.response.suggestedNextStep, "string");
    assert.ok(body.response.supportingRecords && body.response.supportingRecords.length > 0);
    // buildGrowSupportingRecords (apps/api/src/lib/ai/orchestrator.ts) checks
    // propertyId before opportunityId/appraisalId/partyId - a real, deep-linkable
    // /properties/:id record deliberately wins over a plain, deepLink: null
    // opportunity/party record whenever the focused item has a property (see
    // that function's own header comment, and its own already-passing unit
    // test "a focused, property-linked item gets a real /properties/:id deep
    // link" in lib/ai/__tests__/growOrchestrator.test.ts). This fixture's
    // opportunity has a property, so the focused item's supportingRecord is
    // the property, not the contact - asserting "Fiona RouteFocus" here was
    // wrong; the property's own address is the correct, intended label.
    assert.equal(body.response.supportingRecords![0].recordType, "property");
    assert.equal(body.response.supportingRecords![0].recordId, propertyId);
    assert.equal(body.response.supportingRecords![0].label, "5 Route Focus Item Ave");
    assert.equal(body.response.supportingRecords![0].deepLink, `/properties/${propertyId}`);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (grow) enforces the per-brokerage rate limit end to end: the 21st request within the window is refused with 429", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Rate Limit ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.ai.use");
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await askGrow(fresh.agent.cookie, { question: `Rate limit fixture question #${i}` });
      lastStatus = res.status;
      if (i < 20) {
        assert.equal(res.status, 200, `request #${i} (within the 20-per-minute cap) must succeed`);
      }
    }
    assert.equal(lastStatus, 429, "the 21st request within the same window must be refused with 429, not silently served or 500'd");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (grow) never leaks one brokerage's Grow data into another brokerage's response", async () => {
  const A = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Cross Tenant A ${suffix}`);
  const B = await createBrokerageWithUsers(baseUrl, `Grow Ask AE Route Cross Tenant B ${suffix}`);
  try {
    await grant(A.brokerageId, "grow.access");
    await grant(A.brokerageId, "grow.ai.use");
    await grant(B.brokerageId, "grow.access");
    await grant(B.brokerageId, "grow.ai.use");
    // createOverdueOpportunity below (brokerage A only) needs
    // grow.opportunities.manage separately from grow.access.
    await grant(A.brokerageId, "grow.opportunities.manage");

    const propertyA = await createProperty(A.agent.cookie, "6 Route Cross Tenant Ave (A)");
    const partyA = await createParty(A.agent.cookie, propertyA, { firstName: "Tenant", lastName: "OnlyA" });
    await createOverdueOpportunity(A.agent.cookie, propertyA, partyA, "Cross-tenant route fixture A.");

    const resB = await askGrow(B.agent.cookie, { question: "Who should I call today?" });
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { response: { supportingRecords?: Array<{ label: string }> } };
    const labelsB = (bodyB.response.supportingRecords ?? []).map((r) => r.label);
    assert.ok(!labelsB.includes("Tenant OnlyA"), "brokerage B's response must never reference brokerage A's contact");
    assert.ok(!labelsB.includes("6 Route Cross Tenant Ave (A)"), "brokerage B's response must never reference brokerage A's property either");
  } finally {
    await cleanupBrokerages([A.brokerageId, B.brokerageId]);
  }
});
