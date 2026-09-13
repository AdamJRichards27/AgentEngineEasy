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
//
// TIMEZONE REMEDIATION (Stage C project-owner-required coverage): one test
// near the end of this file proves the "client timezone override attempt"
// case at the real HTTP boundary - a client-supplied timeZone field in the
// request body must never influence the resolved period, because
// routes/ai.ts's askSchema (a non-strict Zod object) silently drops any
// field it does not itself declare before askCopilot() is ever called. The
// existing success test below is also extended to assert the period's
// timeZone/timeZoneSource/timeBasis fields are present and well-formed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, growCommitments, aiActionRequests } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
// business_coach is a non-default-on AiRole (see
// apps/api/src/lib/ai/featureFlags.ts's ROLE_FLAG_ENV) - AI_ENABLED already
// defaults to true, but the per-role flag does not, so every coach-mode
// request in this file would otherwise be refused as feature-disabled
// before the tier/entitlement gate this file actually means to exercise is
// ever reached. Node's test runner isolates each *.test.ts file into its
// own process, so this assignment cannot leak into any other test file.
process.env.AI_BUSINESS_COACH_ENABLED = "true";

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

/**
 * createBrokerageWithUsers()'s underlying dev-login auto-grants "run.access"
 * to every brand-new brokerage at creation (routes/auth.ts's first-user-in-
 * a-brokerage path), so a brokerage that only ever calls
 * grant(..., "grow.access") on top of that actually resolves to PRO tier
 * (grow.access AND run.access), not GROW. Used by the one test below that
 * specifically asserts a GROW (not PRO) tier value, so that brokerage needs
 * its auto-granted run.access revoked first to be genuinely GROW-only.
 */
async function revokeRunAccess(brokerageId: number) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

function askCoach(cookie: string | undefined, overrides: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/ai/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ question: "How am I tracking this week?", contextType: "grow", contextId: null, mode: "coach", ...overrides }),
  });
}

// AE GROW Priority 6 Stage D remediation pass - the same real-HTTP-seeding
// recipe routes/__tests__/growAskAe.test.ts already established and relies
// on for its own "growFocusItemId" and cross-tenant tests, duplicated here
// verbatim rather than imported (per this file's own existing convention of
// duplicating small per-file fixture helpers - see grant()/askCoach() above,
// neither of which is imported from growAskAe.test.ts either). Seeding a
// concrete due date through the real POST/PATCH API, instead of inserting a
// growOpportunities row directly, means the grounding data this section's
// tests exercise is produced exactly the way a real agent using the product
// would produce it - not a shortcut that could mask a real gap between the
// test fixture and the real write path.
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
        period?: { key: string; timeZone: string; timeZoneSource: string; timeBasis: string };
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
    // Stage C timezone remediation: the period must carry a real IANA
    // timezone identifier (never a fixed UTC offset) and disclose its
    // provenance - this brokerage has no Communications Hub timezone
    // configured, so it must resolve via the fallback tier.
    assert.equal(typeof body.response.period?.timeZone, "string");
    assert.ok(body.response.period!.timeZone.includes("/"), "an IANA timezone identifier, never a fixed UTC offset");
    assert.ok(["brokerage", "fallback"].includes(body.response.period?.timeZoneSource ?? ""));
    assert.equal(typeof body.response.period?.timeBasis, "string");
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
    await revokeRunAccess(fresh.brokerageId);
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

test("POST /api/ai/ask (mode: coach) ignores a client-supplied timeZone override - the response always uses the server-resolved (brokerage or default) timezone, never a client-asserted one", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route TZ Override ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const res = await askCoach(fresh.agent.cookie, { period: "last7days", timeZone: "Pacific/Fiji" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { response: { period?: { timeZone: string; timeZoneSource: string } } };
    assert.notEqual(
      body.response.period?.timeZone,
      "Pacific/Fiji",
      "a client-supplied timeZone field must never reach the response - routes/ai.ts's non-strict Zod schema silently strips it before askCopilot() ever sees it",
    );
    assert.equal(
      body.response.period?.timeZoneSource,
      "fallback",
      "this brokerage has no Communications Hub timezone configured, so the only legitimate source is the application default",
    );
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

// ---------------------------------------------------------------------------
// AE GROW Priority 6 Stage D remediation pass - dedicated Business Coach
// coverage for the CREATE_GROW_COMMITMENT proposal path.
//
// Everything above this point is pre-existing Stage C coverage (entitlement
// gating, tier, rate limiting, cross-tenant metrics isolation, timezone) and
// predates Stage D. None of it proves that an authenticated mode: "coach"
// request reaches the same governed CREATE_GROW_COMMITMENT proposal flow as
// plain Grow Ask AE - that is specifically what the three tests below close,
// at the real HTTP route (this file's own createApp()/fetch() harness), not
// by calling selectGrowCommitmentCandidate or another isolated orchestrator
// helper directly and describing that as integration coverage (see
// lib/ai/__tests__/growCommitmentAction.test.ts §4 for that separate,
// already-existing unit-level coverage of the helper functions themselves).
//
// Grounding data is seeded through the real POST/PATCH HTTP API via
// createProperty/createParty/createOverdueOpportunity above - the exact
// same real-write recipe routes/__tests__/growAskAe.test.ts already
// established for its own "growFocusItemId" test - never by inserting a
// growOpportunities row directly, so a passing test here proves the real
// write path, not a shortcut around it.
//
// The "missing entitlement" negative case in the required test matrix is
// deliberately not duplicated here: the pre-existing "is refused with 403
// for a STARTER brokerage" test above already proves the whole request -
// including any Stage D proposal attempt - is refused before the proposal
// path is ever reached, for both modes. Re-testing it here would be
// redundant coverage of the same gate, not additional proof.
// ---------------------------------------------------------------------------

test("POST /api/ai/ask (mode: coach) with a grounded, dated follow-up produces an AWAITING_APPROVAL CREATE_GROW_COMMITMENT proposal, through the real HTTP route and orchestrator together - server-selected role, brokerage-scoped grounding data, no client-supplied role/actorType trusted", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route Commitment Proposal ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.opportunities.manage");
    // AE GROW Priority 6 Stage D remediation pass (CI-diagnosed fix):
    // CREATE_GROW_COMMITMENT's own registry entry (actions/registry.ts)
    // declares requiredEntitlementKey: "grow.activities.manage" - a
    // separate entitlement from grow.opportunities.manage above, which
    // only gates the ordinary /api/grow/opportunities CRUD routes used to
    // seed this fixture. Without this grant the Policy Engine correctly
    // denies the proposal with ENTITLEMENT_DENIED (a clean, silent policy
    // decision, not a crash), which is exactly what CI run #333 caught.
    await grant(fresh.brokerageId, "grow.activities.manage");
    const propertyId = await createProperty(fresh.agent.cookie, "9 Coach Commitment Ave");
    const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Priya", lastName: "CoachCommitment" });
    await createOverdueOpportunity(fresh.agent.cookie, propertyId, partyId, "Coach-mode commitment fixture - overdue follow-up.");

    // A client-supplied role/actorType must never be accepted or trusted.
    // routes/ai.ts's askSchema declares no role field at all, and (like the
    // pre-existing "ignores a client-supplied timeZone override" test
    // above already proves for timeZone) a non-strict Zod object silently
    // drops any field it does not itself declare before askCopilot() ever
    // sees it. This call deliberately tries to smuggle both fields in.
    const res = await askCoach(fresh.agent.cookie, { role: "system_change", actorType: "AI" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      response: {
        headline?: string;
        // Deliberately typed loosely (Record<string, unknown>, not a named
        // interface) - this test asserts on the proposal's runtime values,
        // not on a locally-guessed field-type declaration that could drift
        // out of sync with the real summarizeGrowCommitmentProposal() return
        // type and fail the workspace typecheck step for the wrong reason.
        proposedCommitment?: Record<string, unknown>;
      };
    };

    // The full Business Coach Response Contract shape (headline etc. - see
    // the pre-existing "succeeds ... returns the full coaching Response
    // Contract shape" test above) is present only when the server resolved
    // role === "business_coach" server-side from mode: "coach". This is the
    // same observable evidence that test already relies on for role
    // selection, and it is also the proof that the smuggled role/actorType
    // fields above had no effect - a client-selected "system_change" role
    // would never produce this shape.
    assert.equal(typeof body.response.headline, "string");

    assert.ok(body.response.proposedCommitment, "a concrete, dated, brokerage-owned follow-up must produce a proposal in coach mode, exactly as it does in plain Grow Ask AE mode");
    const proposal = body.response.proposedCommitment!;
    assert.equal(proposal.actionKey, "CREATE_GROW_COMMITMENT");
    assert.equal(proposal.partyId, partyId, "the proposal must reference the real, brokerage-owned party that was actually seeded through the HTTP API - never a model-generated identifier");
    assert.equal(proposal.contactName, "Priya CoachCommitment");
    assert.equal(proposal.status, "AWAITING_APPROVAL", "the proposal must require human approval - it can never arrive already-executed");
    assert.equal(proposal.reviewUrl, "/grow");

    const commitmentsAfterProposal = await db.select().from(growCommitments).where(eq(growCommitments.brokerageId, fresh.brokerageId));
    assert.equal(commitmentsAfterProposal.length, 0, "a proposal alone must never create a growCommitments row - nothing is created until a human explicitly approves it");

    const actionRequests = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, fresh.brokerageId));
    assert.equal(actionRequests.length, 1, "exactly one action request must exist - this single HTTP call must not create duplicates or any other domain record");
    assert.equal(actionRequests[0].actionKey, "CREATE_GROW_COMMITMENT");
    assert.equal(actionRequests[0].actorType, "AI", "the request must be attributed to the server's own internal AI actor, never to the client-supplied actorType field this call tried to smuggle in");
    assert.equal(actionRequests[0].status, "AWAITING_APPROVAL");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) creates no proposal when no concrete, dated follow-up exists yet - an opportunity with no next-action date set is not concrete enough to ground a proposal on", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Coach Route No Grounded Follow-up ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.opportunities.manage");
    const propertyId = await createProperty(fresh.agent.cookie, "11 Coach No Followup Ave");
    const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Noor", lastName: "NoFollowup" });
    // Deliberately no createOverdueOpportunity()/PATCH step here - the
    // opportunity is left with no nextActionDueAt, so it surfaces on Grow
    // Today (as an "opportunity_no_action_set" item, per growToday.ts) but
    // is not concrete/dated enough for selectGrowCommitmentCandidate to
    // treat as grounding data (see lib/ai/__tests__/growCommitmentAction.test.ts
    // §4's own "no qualifying item, returns null" unit coverage of that
    // same rule - this test proves the identical rule holds at the real
    // HTTP boundary, for coach mode specifically).
    const createRes = await fetch(`${baseUrl}/api/grow/opportunities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: fresh.agent.cookie },
      body: JSON.stringify({ partyId, propertyId, opportunityType: "Listing", reason: "No concrete follow-up yet fixture." }),
    });
    if (createRes.status !== 201) throw new Error(`create opportunity failed: ${createRes.status} ${await createRes.text()}`);

    const res = await askCoach(fresh.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { response: { headline?: string; proposedCommitment?: unknown } };
    assert.equal(typeof body.response.headline, "string", "still a real, full coach response - only the proposal is absent");
    assert.equal(body.response.proposedCommitment, undefined, "no concrete dated follow-up exists, so no proposal must be created even though this brokerage is otherwise fully Grow-entitled");

    const actionRequests = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, fresh.brokerageId));
    assert.equal(actionRequests.length, 0, "no action request of any kind must be created when there is nothing concrete to ground one on");
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("POST /api/ai/ask (mode: coach) never proposes a commitment against, or leaks any detail of, another brokerage's grounded follow-up - both brokerages hold an identical entitlement set, so tenant scoping is the only possible explanation for the difference", async () => {
  const ours = await createBrokerageWithUsers(baseUrl, `Coach Route Tenant Isolation Ours ${suffix}`);
  const foreign = await createBrokerageWithUsers(baseUrl, `Coach Route Tenant Isolation Foreign ${suffix}`);
  try {
    await grant(ours.brokerageId, "grow.access");
    await grant(ours.brokerageId, "grow.opportunities.manage");
    await grant(foreign.brokerageId, "grow.access");
    await grant(foreign.brokerageId, "grow.opportunities.manage");

    const foreignPropertyId = await createProperty(foreign.agent.cookie, "13 Zenith Foreign Ave");
    const foreignPartyId = await createParty(foreign.agent.cookie, foreignPropertyId, { firstName: "Zenith", lastName: "ForeignContact" });
    await createOverdueOpportunity(
      foreign.agent.cookie,
      foreignPropertyId,
      foreignPartyId,
      "Zenith foreign brokerage overdue follow-up - must never reach the other brokerage.",
    );

    const res = await askCoach(ours.agent.cookie);
    assert.equal(res.status, 200);
    const rawBody = await res.text();
    assert.ok(!rawBody.includes("Zenith"), "the foreign contact's name and the foreign fixture's distinctive reason text must never appear anywhere in our brokerage's response");
    assert.ok(!rawBody.includes("Foreign Ave"), "the foreign property's address must never appear anywhere in our brokerage's response");

    const body = JSON.parse(rawBody) as { response: { headline?: string; proposedCommitment?: unknown } };
    assert.equal(typeof body.response.headline, "string", "still a real, full coach response for our own brokerage");
    assert.equal(
      body.response.proposedCommitment,
      undefined,
      "our brokerage has no grounded follow-up of its own, so no proposal must be created regardless of what the foreign brokerage has - and it must certainly never be created FROM the foreign brokerage's data",
    );

    const ourActionRequests = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, ours.brokerageId));
    assert.equal(ourActionRequests.length, 0, "no action request must exist in our brokerage referencing the foreign brokerage's contact or property");

    const foreignActionRequests = await db.select().from(aiActionRequests).where(eq(aiActionRequests.brokerageId, foreign.brokerageId));
    assert.equal(foreignActionRequests.length, 0, "the foreign brokerage's own overdue follow-up was never itself asked about in coach mode by its own agent in this test, so it correctly has no proposal either - this asserts our fixture setup did not accidentally create one as a side effect");
  } finally {
    await cleanupBrokerages([ours.brokerageId, foreign.brokerageId]);
  }
});
