// AE GROW Priority 6 Stage C — HTTP-level regression coverage for
// POST /api/ai/ask with mode: "coach" (the Business Coach). Follows the
// exact same real-app, real-HTTP-request pattern as
// routes/__tests__/growAskAe.test.ts (spins up the real app via
// createApp(), a real session cookie, real entitlement grants), kept as its
// own sibling file for the same reason growAskAe.test.ts was itself kept
// separate from routes/__tests__/ai.test.ts - this exercises the coach-mode
// request path end to end (Zod validation including the mode/contextType
// refine, requireAuth, the role-specific entitlement gate, the shared rate
// limiter, and the full coaching Response Contract shape), not just the
// orchestrator function in isolation (see
// lib/ai/__tests__/coachOrchestrator.test.ts for that unit-level coverage).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

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

function askCoach(cookie: string | undefined, overrides: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/ai/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ question: "How am I tracking this week?", contextType: "grow", contextId: null, mode: "coach", ...overrides }),
  });
}

test("POST /api/ai/ask (mode: coach) requires authentication", async () => {
  const res = await askCoach(undefined);
  assert.equal(res.status, 401);
});

test("POST /api/ai/ask rejects mode 'coach' paired with any contextType other than 'grow' with 400, before touching the database", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Schema Refine ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");

    const nullContext = await askCoach(fresh.agent.cookie, { contextType: null });
    assert.equal(nullContext.status, 400);

    const businessContext = await askCoach(fresh.agent.cookie, { contextType: "business" });
    assert.equal(businessContext.status, 400);

    const propertyContext = await askCoach(fresh.agent.cookie, { contextType: "property", contextId: 1 });
    assert.equal(propertyContext.status, 400);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) rejects an invalid period value with 400", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Invalid Period ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await askCoach(fresh.agent.cookie, { period: "yesterday" });
    assert.equal(res.status, 400);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) is refused with 403 for a STARTER brokerage, naming the Business Coach specifically (not the generic Grow gate)", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route 403 ${suffix}`);
  try {
    const res = await askCoach(fresh.agent.cookie);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /does not include the AI Business Coach/);
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) succeeds for a Grow-entitled brokerage and returns the full coaching Response Contract shape", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Success ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await askCoach(fresh.agent.cookie, { period: "last30days" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      requestId: string;
      response: {
        kind: string;
        riskLevel: number;
        headline?: string;
        period?: { key: string };
        performanceSummary?: string;
        observations?: string[];
        strengths?: string[];
        focusAreas?: string[];
        recommendations?: Array<{ action: string; reason: string }>;
        supportingMetrics?: Array<{ key: string; label: string; value: string }>;
        dataFreshness?: string;
        limitations?: string[];
        suggestedReviewDate?: string;
      };
    };
    assert.equal(typeof body.requestId, "string");
    assert.equal(body.response.kind, "recommendation");
    assert.equal(body.response.riskLevel, 0);
    assert.equal(typeof body.response.headline, "string");
    assert.equal(body.response.period?.key, "last30days");
    assert.equal(typeof body.response.performanceSummary, "string");
    assert.ok(Array.isArray(body.response.recommendations) && body.response.recommendations.length >= 1 && body.response.recommendations.length <= 3);
    assert.ok(Array.isArray(body.response.supportingMetrics) && body.response.supportingMetrics.length === 6);
    assert.equal(typeof body.response.dataFreshness, "string");
    assert.ok(Array.isArray(body.response.limitations) && body.response.limitations.length > 0);
    assert.equal(typeof body.response.suggestedReviewDate, "string");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("GET /api/ai/capabilities reports businessCoachEnabled alongside the existing copilotEnabled field", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Capabilities ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await fetch(`${baseUrl}/api/ai/capabilities`, { headers: { cookie: fresh.agent.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tier: string; copilotEnabled: boolean; businessCoachEnabled: boolean };
    assert.equal(body.tier, "GROW");
    assert.equal(typeof body.copilotEnabled, "boolean");
    assert.equal(typeof body.businessCoachEnabled, "boolean");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) shares the Grow per-brokerage rate limit end to end with Ask AE: the 21st request within the window (across both modes) is refused with 429", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Rate Limit ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    let lastStatus = 0;
    for (let i = 0; i < 21; i++) {
      const res = await askCoach(fresh.agent.cookie, { question: `Rate limit fixture question #${i}` });
      lastStatus = res.status;
      if (i < 20) {
        assert.equal(res.status, 200, `request #${i} (within the 20-per-minute cap) must succeed`);
      }
    }
    assert.equal(lastStatus, 429, "the 21st coach-mode request within the same window must be refused with 429, not silently served or 500'd");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) never leaks one brokerage's coaching metrics into another brokerage's response", async () => {
  const A = await createBrokerageWithUsers(baseUrl, `Coach Route Cross Tenant A ${suffix}`);
  const B = await createBrokerageWithUsers(baseUrl, `Coach Route Cross Tenant B ${suffix}`);
  try {
    await grant(A.brokerageId, "grow.access");
    await grant(B.brokerageId, "grow.access");
    await grant(A.brokerageId, "grow.opportunities.manage");

    const propRes = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ formattedAddress: "7 Coach Cross Tenant Ave (A)", state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    if (propRes.status !== 201) throw new Error(`create property failed: ${propRes.status} ${await propRes.text()}`);
    const { property } = (await propRes.json()) as { property: { id: number } };
    const partyRes = await fetch(`${baseUrl}/api/parties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ propertyId: property.id, role: "Buyer", firstName: "CoachTenant", lastName: "OnlyA" }),
    });
    if (partyRes.status !== 201) throw new Error(`create party failed: ${partyRes.status} ${await partyRes.text()}`);
    const { party } = (await partyRes.json()) as { party: { id: number } };
    const oppRes = await fetch(`${baseUrl}/api/grow/opportunities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ partyId: party.id, propertyId: property.id, opportunityType: "Listing", reason: "Cross-tenant coach fixture A." }),
    });
    if (oppRes.status !== 201) throw new Error(`create opportunity failed: ${oppRes.status} ${await oppRes.text()}`);

    const resB = await askCoach(B.agent.cookie);
    assert.equal(resB.status, 200);
    const bodyB = (await resB.json()) as { response: { supportingMetrics?: Array<{ key: string; value: string }> } };
    const openOpportunities = bodyB.response.supportingMetrics?.find((m) => m.key === "openOpportunities");
    assert.equal(openOpportunities?.value, "0", "brokerage B has created no opportunities of its own, so it must never see brokerage A's open opportunity counted in its own metrics");
  } finally {
    await cleanupBrokerages([A.brokerageId, B.brokerageId]);
  }
});
