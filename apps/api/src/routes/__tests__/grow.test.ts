// F-05: permanent route-level HTTP regression coverage for
// apps/api/src/routes/grow.ts (Grow Stage A's relationship / activity /
// opportunity surface). Exercises the router over real HTTP, through
// requireAuth and the real session cookie, so a regression in the route
// wiring itself -- a missing entitlement gate, a tenant-scope check
// accidentally dropped, a changed status code -- is caught here even if the
// underlying db / domain-event code still behaves correctly in isolation.
//
// Grow is opt-in, not free-tier: every protected route requires an explicit
// entitlementGrants row (see lib/entitlements/resolver.ts's "grants are the
// sole source of truth" comment, and its 30s in-memory cache, which is why
// every grant below is followed by invalidateEntitlementCache()). Tests are
// deliberately sequential and narrative rather than independent: Brokerage A
// accumulates entitlements one at a time, in the order its routes need them,
// so each test proves that route's *specific* entitlement key is what
// unlocks it -- not grow.access alone, not some earlier grant. Brokerage B
// is kept minimally entitled throughout and used as the "other tenant" for
// isolation checks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, domainEvents, entitlementGrants, growActivities } from "@aee/db";
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
const brokerageAName = `F-05 Grow A ${suffix}`;
const brokerageBName = `F-05 Grow B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let createdRelationshipId: number;
let createdOpportunityId: number;

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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
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

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
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
    // "Buyer" (not "Seller") deliberately sidesteps parties.ts's Seller-only
    // ownership-review/AML side effects, which are irrelevant to Grow.
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Party", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

test("unauthenticated requests are rejected across the grow surface", async () => {
  const endpoints: Array<[string, string]> = [
    ["GET", "/access"],
    ["GET", "/overview"],
    ["GET", "/relationships"],
    ["POST", "/relationships"],
    ["GET", "/activities"],
    ["POST", "/activities"],
    ["GET", "/opportunities"],
    ["POST", "/opportunities"],
  ];
  for (const [method, path] of endpoints) {
    const res = await fetch(growUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

test("GET /access reports entitlement state honestly and is never itself gated by grow.access", async () => {
  const before_ = await fetch(growUrl("/access"), { headers: { cookie: A.agent.cookie } });
  assert.equal(before_.status, 200, "the whole point of /access is that it never 403s -- it IS the locked-shell signal");
  const beforeBody = (await before_.json()) as { entitled: boolean; entitlements: string[] };
  assert.equal(beforeBody.entitled, false, "a brokerage with zero entitlementGrants rows must not be reported as entitled");
  assert.deepEqual(beforeBody.entitlements, []);

  await grant(A.brokerageId, "grow.access");

  const after_ = await fetch(growUrl("/access"), { headers: { cookie: A.agent.cookie } });
  assert.equal(after_.status, 200);
  const afterBody = (await after_.json()) as { entitled: boolean; entitlements: string[] };
  assert.equal(afterBody.entitled, true);
  assert.ok(afterBody.entitlements.includes("grow.access"));
});

test("grow.access unlocks the four read routes but grants no write access of its own", async () => {
  // A now has grow.access (granted above) but none of the *.manage keys yet.
  const reads: string[] = ["/overview", "/relationships", "/activities", "/opportunities"];
  for (const path of reads) {
    const res = await fetch(growUrl(path), { headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 200, `GET ${path} should be readable with only grow.access`);
  }

  const writes: Array<[string, Record<string, unknown>]> = [
    ["/relationships", { partyId: 1, propertyId: 1, relationshipType: "prospective_buyer" }],
    ["/activities", { activityType: "note", summary: "irrelevant -- must be blocked before validation runs" }],
    ["/opportunities", { partyId: 1, opportunityType: "Appraisal", reason: "irrelevant -- must be blocked before validation runs" }],
  ];
  for (const [path, body] of writes) {
    const res = await fetch(growUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 403, `POST ${path} must require its own *.manage entitlement, not just grow.access`);
    const responseBody = (await res.json()) as { reason: string };
    assert.equal(responseBody.reason, "ENTITLEMENT_MISSING");
  }

  // Brokerage B has been granted nothing at all yet -- the read routes must
  // still 403 there, proving grow.access is brokerage-scoped, not global.
  const bRes = await fetch(growUrl("/overview"), { headers: { cookie: B.agent.cookie } });
  assert.equal(bRes.status, 403);
});

test("POST /relationships validates required fields, enforces tenant isolation on both party and property, and publishes an audit-accurate RELATIONSHIP_CREATED event", async () => {
  await grant(A.brokerageId, "grow.relationships.manage");

  const missingRes = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: 1 }),
  });
  assert.equal(missingRes.status, 400);

  const aPropertyId = await createProperty(A.agent.cookie, "1 Grow Relationship Way");
  const aPartyId = await createParty(A.agent.cookie, aPropertyId);

  // A real property and a real party that both genuinely exist -- but in
  // Brokerage B -- proves the tenant check inspects the referenced rows
  // themselves, not merely whether *a* row with that id exists anywhere.
  const bPropertyId = await createProperty(B.agent.cookie, "2 Cross Tenant Close");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId);

  const crossTenantRes = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: bPartyId, propertyId: bPropertyId, relationshipType: "prospective_buyer" }),
  });
  assert.equal(crossTenantRes.status, 404);
  const crossTenantBody = (await crossTenantRes.json()) as { error: string };
  assert.match(crossTenantBody.error, /not found in this brokerage/i);

  const okRes = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId, propertyId: aPropertyId, relationshipType: "prospective_buyer", role: "Executor" }),
  });
  const okBody = (await okRes.json()) as { relationship: { id: number; relationshipType: string } };
  assert.equal(okRes.status, 201, JSON.stringify(okBody));
  assert.equal(okBody.relationship.relationshipType, "prospective_buyer");
  createdRelationshipId = okBody.relationship.id;

  const events = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "RELATIONSHIP_CREATED"), eq(domainEvents.brokerageId, A.brokerageId)));
  assert.ok(events.length > 0, "RELATIONSHIP_CREATED must be persisted as a real domain_events row, not silently dropped");
  const last = events[events.length - 1];
  assert.equal(last.causationId, null, "must follow the codebase-wide causationId convention fixed under F-03");
  assert.match(
    last.correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "correlationId must be a real UUID",
  );
});

test("PATCH /relationships/:id enforces tenant isolation independently of holding the entitlement, and publishes RELATIONSHIP_UPDATED on success", async () => {
  // Brokerage B is given grow.relationships.manage here specifically so this
  // test isolates the row-level tenant check from the entitlement gate
  // already proven above -- B having the *entitlement* must still not be
  // enough to reach A's row.
  await grant(B.brokerageId, "grow.relationships.manage");

  const crossTenantRes = await fetch(growUrl(`/relationships/${createdRelationshipId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ status: "Historical" }),
  });
  assert.equal(crossTenantRes.status, 404, "Brokerage B must never be able to update Brokerage A's relationship row, even by guessing its id");

  const okRes = await fetch(growUrl(`/relationships/${createdRelationshipId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "Historical" }),
  });
  const okBody = (await okRes.json()) as { relationship: { status: string } };
  assert.equal(okRes.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.relationship.status, "Historical");

  const events = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "RELATIONSHIP_UPDATED"), eq(domainEvents.brokerageId, A.brokerageId)));
  assert.ok(events.length > 0);
  const last = events[events.length - 1];
  assert.equal(last.causationId, null);
  assert.match(last.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("POST /activities requires grow.activities.manage even though GET /activities only needs grow.access, and validates required fields", async () => {
  const beforeGrantRes = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ activityType: "note", summary: "must be blocked -- activities.manage not granted yet" }),
  });
  assert.equal(beforeGrantRes.status, 403);

  await grant(A.brokerageId, "grow.activities.manage");

  const missingRes = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ summary: "missing activityType" }),
  });
  assert.equal(missingRes.status, 400);

  const okRes = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ activityType: "call", summary: "Called to introduce Grow." }),
  });
  const okBody = (await okRes.json()) as { activity: { id: number; activityType: string } };
  assert.equal(okRes.status, 201, JSON.stringify(okBody));
  assert.equal(okBody.activity.activityType, "call");

  // GET /activities never needed activities.manage -- only grow.access, granted earlier.
  const listRes = await fetch(growUrl("/activities"), { headers: { cookie: A.agent.cookie } });
  const listBody = (await listRes.json()) as { activities: Array<{ id: number }> };
  assert.equal(listRes.status, 200);
  assert.ok(listBody.activities.some((a) => a.id === okBody.activity.id));
});

test("POST /opportunities validates required fields, enforces tenant isolation on partyId, and publishes an audit-accurate OPPORTUNITY_CREATED event", async () => {
  await grant(A.brokerageId, "grow.opportunities.manage");

  const missingRes = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ opportunityType: "Appraisal" }),
  });
  assert.equal(missingRes.status, 400);

  const bPropertyId = await createProperty(B.agent.cookie, "3 Cross Tenant Opportunity Rd");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId);

  const crossTenantRes = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: bPartyId, opportunityType: "Appraisal", reason: "should 404 -- party belongs to Brokerage B" }),
  });
  assert.equal(crossTenantRes.status, 404);

  const aPropertyId = await createProperty(A.agent.cookie, "4 Grow Opportunity St");
  const aPartyId = await createParty(A.agent.cookie, aPropertyId);

  const okRes = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: aPartyId, opportunityType: "Appraisal", reason: "Enquired about a market appraisal." }),
  });
  const okBody = (await okRes.json()) as { opportunity: { id: number; status: string } };
  assert.equal(okRes.status, 201, JSON.stringify(okBody));
  assert.equal(okBody.opportunity.status, "Open");
  createdOpportunityId = okBody.opportunity.id;

  const events = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "OPPORTUNITY_CREATED"), eq(domainEvents.brokerageId, A.brokerageId)));
  assert.ok(events.length > 0);
  const last = events[events.length - 1];
  assert.equal(last.causationId, null);
  assert.match(last.correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("GET /relationships and GET /opportunities never return another brokerage's rows", async () => {
  await grant(B.brokerageId, "grow.access");

  const relRes = await fetch(growUrl("/relationships"), { headers: { cookie: B.agent.cookie } });
  const relBody = (await relRes.json()) as { relationships: Array<{ id: number }> };
  assert.equal(relRes.status, 200);
  assert.ok(
    !relBody.relationships.some((r) => r.id === createdRelationshipId),
    "Brokerage B's relationship list must never include Brokerage A's rows",
  );

  const oppRes = await fetch(growUrl("/opportunities"), { headers: { cookie: B.agent.cookie } });
  const oppBody = (await oppRes.json()) as { opportunities: Array<{ id: number }> };
  assert.equal(oppRes.status, 200);
  assert.ok(
    !oppBody.opportunities.some((o) => o.id === createdOpportunityId),
    "Brokerage B's opportunity list must never include Brokerage A's rows",
  );
});

// Confirmed MEDIUM: tenant-isolation gap on POST /activities (AGENT ENGINE 2.0 -- STEP 2).
// partyId/propertyId/opportunityId were inserted straight from the request body with no check
// that they belong to the caller's brokerageId, unlike the sibling POST /relationships and
// POST /opportunities handlers in this same file. These two tests prove the fix mirrors that
// same established per-file convention: reject a cross-tenant reference for whichever of the
// three (all optional) fields is supplied, insert nothing when rejected, and otherwise behave
// exactly as before.
test("POST /activities enforces tenant isolation independently on partyId, propertyId, and opportunityId", async () => {
  // Real party/property/opportunity rows that genuinely exist -- but in Brokerage B -- prove the
  // check inspects the referenced rows themselves, not merely whether *a* row with that id exists
  // anywhere. Mirrors the same cross-tenant proof already used for POST /relationships above.
  const bPropertyId = await createProperty(B.agent.cookie, "5 Cross Tenant Activity Ave");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId);

  await grant(B.brokerageId, "grow.opportunities.manage");
  const bOppRes = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ partyId: bPartyId, opportunityType: "Appraisal", reason: "Brokerage B's own opportunity" }),
  });
  const bOppBody = (await bOppRes.json()) as { opportunity: { id: number } };
  assert.equal(bOppRes.status, 201, JSON.stringify(bOppBody));
  const bOpportunityId = bOppBody.opportunity.id;

  const attempts: Array<[string, Record<string, unknown>]> = [
    ["partyId", { activityType: "note", summary: "CROSS-TENANT partyId must be rejected", partyId: bPartyId }],
    ["propertyId", { activityType: "note", summary: "CROSS-TENANT propertyId must be rejected", propertyId: bPropertyId }],
    ["opportunityId", { activityType: "note", summary: "CROSS-TENANT opportunityId must be rejected", opportunityId: bOpportunityId }],
  ];
  for (const [field, body] of attempts) {
    const res = await fetch(growUrl("/activities"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 404, `${field} belonging to Brokerage B must be rejected, got ${res.status}`);
    const resBody = (await res.json()) as { error: string };
    assert.match(resBody.error, /not found in this brokerage/i);
  }

  const dangling = await db
    .select()
    .from(growActivities)
    .where(
      and(
        eq(growActivities.brokerageId, A.brokerageId),
        eq(growActivities.summary, "CROSS-TENANT partyId must be rejected"),
      ),
    );
  assert.equal(dangling.length, 0, "a rejected cross-tenant reference must never be inserted, even as a dangling row");
});

test("POST /activities still creates successfully when partyId/propertyId/opportunityId belong to the caller's own brokerage, or are omitted entirely", async () => {
  const aPropertyId = await createProperty(A.agent.cookie, "6 Grow Activity Close");
  const aPartyId = await createParty(A.agent.cookie, aPropertyId);

  const ownIdsRes = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({
      activityType: "note",
      summary: "Own-brokerage references should still be accepted",
      partyId: aPartyId,
      propertyId: aPropertyId,
      opportunityId: createdOpportunityId,
    }),
  });
  const ownIdsBody = (await ownIdsRes.json()) as {
    activity: { id: number; partyId: number | null; propertyId: number | null; opportunityId: number | null };
  };
  assert.equal(ownIdsRes.status, 201, JSON.stringify(ownIdsBody));
  assert.equal(ownIdsBody.activity.partyId, aPartyId);
  assert.equal(ownIdsBody.activity.propertyId, aPropertyId);
  assert.equal(ownIdsBody.activity.opportunityId, createdOpportunityId);

  const noRefsRes = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ activityType: "note", summary: "No party, property, or opportunity references at all" }),
  });
  const noRefsBody = (await noRefsRes.json()) as {
    activity: { id: number; partyId: number | null; propertyId: number | null; opportunityId: number | null };
  };
  assert.equal(noRefsRes.status, 201, JSON.stringify(noRefsBody));
  assert.equal(noRefsBody.activity.partyId, null);
  assert.equal(noRefsBody.activity.propertyId, null);
  assert.equal(noRefsBody.activity.opportunityId, null);
});
