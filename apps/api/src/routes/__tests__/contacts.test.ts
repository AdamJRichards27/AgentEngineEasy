// AE GROW Priority 2 — permanent route-level HTTP regression coverage for
// apps/api/src/routes/contacts.ts (Contact 360 / Contact Intelligence & Relationship Timeline),
// mirroring grow.test.ts's conventions: real HTTP through requireAuth and a real session
// cookie, entitlements granted one at a time in the order routes need them so each test proves
// its *specific* gate, Brokerage A accumulating access while Brokerage B stays the "other
// tenant" for isolation checks (granted the SAME entitlements at the point isolation is tested,
// so a 404 there proves the row-level tenant check, not merely a missing entitlement).
//
// Covers §16's minimum matrix: Contact 360 retrieval/auth/entitlement/shape/404; tenant
// isolation across contacts/roles/household relationships/property relationships/timeline;
// multi-valued relationship-classification roles with duplicate prevention; contact<->property
// relationships via the existing Priority 1 route surfacing correctly on Contact 360 (proving
// no competing data store); the Relationship Timeline's deterministic ordering, correct
// aggregation, and — critically — no join-caused duplicate rows; and a light Priority 1
// integration smoke check.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, growActivities, growContactRoles, growContactRelationships } from "@aee/db";
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
const brokerageAName = `Contact 360 A ${suffix}`;
const brokerageBName = `Contact 360 B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

let aPartyId: number;
let freshPartyId: number;
let householdPartyCId: number;
let householdRelationshipId: number;
let commitmentIdToComplete: number;
let commitmentIdToCancel: number;

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

function contactsUrl(path: string) {
  return `${baseUrl}/api/grow/contacts${path}`;
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
    // ownership-review/AML side effects, which are irrelevant to Contact 360.
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Party", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
}

test("unauthenticated requests are rejected across the contacts surface", async () => {
  const endpoints: Array<[string, string]> = [
    ["GET", "/"],
    ["POST", "/"],
    ["GET", "/1"],
    ["POST", "/1/roles"],
    ["DELETE", "/1/roles/Prospect"],
    ["POST", "/1/relationships"],
    ["DELETE", "/relationships/1"],
    ["POST", "/1/commitments"],
    ["PATCH", "/commitments/1"],
  ];
  for (const [method, path] of endpoints) {
    const res = await fetch(contactsUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" || method === "PATCH" ? "{}" : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

test("GET / and GET /:partyId require grow.contacts.read; role/household mutations require grow.contacts.manage; commitment mutations require grow.activities.manage — grow.contacts.read alone unlocks none of them", async () => {
  const aPropertyId = await createProperty(A.agent.cookie, "1 Contact Intelligence Way");
  aPartyId = await createParty(A.agent.cookie, aPropertyId, { firstName: "Ada", lastName: "Prospect", email: uniqueEmail("ada") });

  const listBefore = await fetch(contactsUrl("/"), { headers: { cookie: A.agent.cookie } });
  assert.equal(listBefore.status, 403);
  const detailBefore = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(detailBefore.status, 403);

  await grant(A.brokerageId, "grow.contacts.read");

  const listAfter = await fetch(contactsUrl("/"), { headers: { cookie: A.agent.cookie } });
  assert.equal(listAfter.status, 200);
  const detailAfter = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(detailAfter.status, 200);

  const roleRes = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ role: "Prospect" }),
  });
  assert.equal(roleRes.status, 403, "grow.contacts.read must not unlock role assignment");
  const roleBody = (await roleRes.json()) as { reason: string };
  assert.equal(roleBody.reason, "ENTITLEMENT_MISSING");

  const relRes = await fetch(contactsUrl(`/${aPartyId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: 999999, relationshipType: "spouse_partner" }),
  });
  assert.equal(relRes.status, 403, "grow.contacts.read must not unlock household relationship creation");

  const commitRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Call next month", dueAt: "2027-01-01" }),
  });
  assert.equal(commitRes.status, 403, "grow.contacts.read must not unlock commitment creation");

  await grant(A.brokerageId, "grow.contacts.manage");
  await grant(A.brokerageId, "grow.activities.manage");
});

test("GET / lists contacts scoped to the caller's brokerage, supports search, and supports filtering by role", async () => {
  const bobPropertyId = await createProperty(A.agent.cookie, "2 Contact List Ave");
  const bobPartyId = await createParty(A.agent.cookie, bobPropertyId, { firstName: "Bob", lastName: "Buyer", email: uniqueEmail("bob") });

  const listRes = await fetch(contactsUrl("/"), { headers: { cookie: A.agent.cookie } });
  const listBody = (await listRes.json()) as { contacts: Array<{ id: number; displayName: string }> };
  assert.equal(listRes.status, 200);
  assert.ok(listBody.contacts.some((c) => c.id === aPartyId));
  assert.ok(listBody.contacts.some((c) => c.id === bobPartyId));

  const searchRes = await fetch(contactsUrl("/?search=Bob"), { headers: { cookie: A.agent.cookie } });
  const searchBody = (await searchRes.json()) as { contacts: Array<{ id: number }> };
  assert.equal(searchRes.status, 200);
  assert.ok(searchBody.contacts.some((c) => c.id === bobPartyId));
  assert.ok(!searchBody.contacts.some((c) => c.id === aPartyId), "search for 'Bob' must not also return Ada");

  const roleRes = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ role: "Prospect" }),
  });
  assert.equal(roleRes.status, 201, JSON.stringify(await roleRes.json()));

  const roleFilterRes = await fetch(contactsUrl("/?role=Prospect"), { headers: { cookie: A.agent.cookie } });
  const roleFilterBody = (await roleFilterRes.json()) as { contacts: Array<{ id: number }> };
  assert.equal(roleFilterRes.status, 200);
  assert.ok(roleFilterBody.contacts.some((c) => c.id === aPartyId));
  assert.ok(!roleFilterBody.contacts.some((c) => c.id === bobPartyId), "role filter must exclude a contact that was never assigned that role");
});

test("POST /:partyId/roles supports multiple roles per contact and is idempotent; validates the role enum; DELETE removes exactly one role assignment", async () => {
  const secondRoleRes = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ role: "Buyer" }),
  });
  const secondRoleBody = (await secondRoleRes.json()) as { role: { id: number; role: string } };
  assert.equal(secondRoleRes.status, 201, JSON.stringify(secondRoleBody));

  const detailRes = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  const detailBody = (await detailRes.json()) as { roles: string[] };
  assert.equal(detailRes.status, 200);
  assert.deepEqual([...detailBody.roles].sort(), ["Buyer", "Prospect"]);

  // Re-assigning an already-held role is idempotent: 200, no duplicate row.
  const reassignRes = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ role: "Prospect" }),
  });
  assert.equal(reassignRes.status, 200);
  const rowsAfterReassign = await db
    .select()
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, aPartyId), eq(growContactRoles.role, "Prospect")));
  assert.equal(rowsAfterReassign.length, 1, "re-assigning an already-held role must not create a duplicate row");

  const invalidRes = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ role: "NotARealRole" }),
  });
  assert.equal(invalidRes.status, 400);

  const removeRes = await fetch(contactsUrl(`/${aPartyId}/roles/Buyer`), { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(removeRes.status, 204);

  const afterRemoveRes = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  const afterRemoveBody = (await afterRemoveRes.json()) as { roles: string[] };
  assert.deepEqual(afterRemoveBody.roles, ["Prospect"]);

  const removeAgainRes = await fetch(contactsUrl(`/${aPartyId}/roles/Buyer`), { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(removeAgainRes.status, 404, "removing a role assignment that no longer exists must 404, not silently succeed");
});

test("Contact 360 enforces tenant isolation: Brokerage B cannot read, list, or assign/remove roles on Brokerage A's contact even while holding the same entitlements", async () => {
  await grant(B.brokerageId, "grow.contacts.read");
  await grant(B.brokerageId, "grow.contacts.manage");
  await grant(B.brokerageId, "grow.activities.manage");

  const crossTenantGet = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantGet.status, 404, "Brokerage B must never read Brokerage A's contact, even by guessing its id");

  const crossTenantList = await fetch(contactsUrl("/"), { headers: { cookie: B.agent.cookie } });
  const crossTenantListBody = (await crossTenantList.json()) as { contacts: Array<{ id: number }> };
  assert.equal(crossTenantList.status, 200);
  assert.ok(!crossTenantListBody.contacts.some((c) => c.id === aPartyId), "Brokerage B's contact list must never include Brokerage A's rows");

  const crossTenantRoleAssign = await fetch(contactsUrl(`/${aPartyId}/roles`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ role: "Prospect" }),
  });
  assert.equal(crossTenantRoleAssign.status, 404);

  const crossTenantRoleDelete = await fetch(contactsUrl(`/${aPartyId}/roles/Prospect`), { method: "DELETE", headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantRoleDelete.status, 404);
});

test("GET /:partyId rejects a non-numeric id with 400 and a nonexistent id with 404", async () => {
  const invalidRes = await fetch(contactsUrl("/not-a-number"), { headers: { cookie: A.agent.cookie } });
  assert.equal(invalidRes.status, 400);

  const nonexistentRes = await fetch(contactsUrl("/999999999"), { headers: { cookie: A.agent.cookie } });
  assert.equal(nonexistentRes.status, 404);
});

test("GET /:partyId returns the full Contact 360 shape for a brand-new contact: identity, empty collections, a single CONTACT_CREATED timeline entry, and a deterministic-only intelligence summary with no predictive/scoring fields", async () => {
  const propertyId = await createProperty(A.agent.cookie, "3 Fresh Contact Rd");
  freshPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Fresh", lastName: "Contact", email: uniqueEmail("fresh") });

  const res = await fetch(contactsUrl(`/${freshPartyId}`), { headers: { cookie: A.agent.cookie } });
  const body = (await res.json()) as {
    contact: { id: number; displayName: string };
    assignedAgentUserId: number | null;
    roles: string[];
    householdRelationships: unknown[];
    properties: unknown[];
    opportunities: unknown[];
    activities: unknown[];
    commitments: unknown[];
    timeline: Array<{ type: string }>;
    intelligence: Record<string, unknown>;
  };
  assert.equal(res.status, 200, JSON.stringify(body));

  assert.equal(body.contact.id, freshPartyId);
  assert.equal(body.contact.displayName, "Fresh Contact");
  assert.equal(body.assignedAgentUserId, null);
  assert.deepEqual(body.roles, []);
  assert.deepEqual(body.householdRelationships, []);
  assert.deepEqual(body.properties, []);
  assert.deepEqual(body.opportunities, []);
  assert.deepEqual(body.activities, []);
  assert.deepEqual(body.commitments, []);

  assert.equal(body.timeline.length, 1);
  assert.equal(body.timeline[0]!.type, "CONTACT_CREATED");

  assert.deepEqual(body.intelligence, {
    roles: [],
    relatedPropertyCount: 0,
    mostRecentInteractionAt: null,
    daysSinceLastInteraction: null,
    nextFollowUpAt: null,
    nextFollowUpDescription: null,
    activeOpportunityCount: 0,
    recentActivityCount: 0,
    outstandingCommitmentCount: 0,
    relationshipAgeDays: null,
  });

  // §9 — must never leak a predictive/scoring field onto the deterministic summary, even
  // accidentally. The deepEqual above already enforces this by exact key match; asserted
  // again explicitly here so the intent isn't lost if the shape above is ever loosened.
  const forbiddenKeys = ["confidenceScore", "scoreExplanation", "sellerProbability", "opportunityScore", "intentScore"];
  for (const key of forbiddenKeys) {
    assert.ok(!(key in body.intelligence), `intelligence must never contain ${key}`);
  }
});

test("POST /:partyId/relationships creates a household relationship, dedups it bidirectionally, rejects self-relationships and invalid types, and both contacts see it on their own Contact 360 page", async () => {
  const propertyId = await createProperty(A.agent.cookie, "4 Household Close");
  householdPartyCId = await createParty(A.agent.cookie, propertyId, { firstName: "Cara", lastName: "Spouse", email: uniqueEmail("cara") });

  const invalidTypeRes = await fetch(contactsUrl(`/${aPartyId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: householdPartyCId, relationshipType: "not_a_real_type" }),
  });
  assert.equal(invalidTypeRes.status, 400);

  const selfRes = await fetch(contactsUrl(`/${aPartyId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: aPartyId, relationshipType: "spouse_partner" }),
  });
  assert.equal(selfRes.status, 400);

  const createRes = await fetch(contactsUrl(`/${aPartyId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: householdPartyCId, relationshipType: "spouse_partner", note: "Married" }),
  });
  const createBody = (await createRes.json()) as { relationship: { id: number } };
  assert.equal(createRes.status, 201, JSON.stringify(createBody));
  householdRelationshipId = createBody.relationship.id;

  // Reverse direction, same type: dedups onto the same row rather than creating a second one.
  const reverseRes = await fetch(contactsUrl(`/${householdPartyCId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: aPartyId, relationshipType: "spouse_partner" }),
  });
  const reverseBody = (await reverseRes.json()) as { relationship: { id: number } };
  assert.equal(reverseRes.status, 200, JSON.stringify(reverseBody));
  assert.equal(reverseBody.relationship.id, householdRelationshipId);

  const allRowsForPair = await db
    .select()
    .from(growContactRelationships)
    .where(and(eq(growContactRelationships.partyId, aPartyId), eq(growContactRelationships.relationshipType, "spouse_partner")));
  assert.equal(allRowsForPair.length, 1, "the reverse-direction POST must not have created a second row");

  // The fix under test: BOTH sides must see the relationship on their own Contact 360 page, not
  // only whichever contact happened to be the `partyId` column in the stored row.
  const aDetail = (await (await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } })).json()) as {
    householdRelationships: Array<{ id: number; relatedPartyId: number; relatedPartyDisplayName: string; relationshipType: string }>;
  };
  assert.equal(aDetail.householdRelationships.length, 1);
  assert.equal(aDetail.householdRelationships[0]!.relatedPartyId, householdPartyCId);
  assert.equal(aDetail.householdRelationships[0]!.relatedPartyDisplayName, "Cara Spouse");
  assert.equal(aDetail.householdRelationships[0]!.relationshipType, "spouse_partner");

  const cDetail = (await (await fetch(contactsUrl(`/${householdPartyCId}`), { headers: { cookie: A.agent.cookie } })).json()) as {
    householdRelationships: Array<{ id: number; relatedPartyId: number; relatedPartyDisplayName: string; relationshipType: string }>;
  };
  assert.equal(cDetail.householdRelationships.length, 1, "Cara's own Contact 360 page must also show the relationship, even though Ada's party row was the one stored as `partyId`");
  assert.equal(cDetail.householdRelationships[0]!.relatedPartyId, aPartyId);
  assert.equal(cDetail.householdRelationships[0]!.relatedPartyDisplayName, "Ada Prospect");
});

test("POST /:partyId/relationships rejects a cross-tenant relatedPartyId; DELETE /relationships/:id enforces tenant isolation before removing the row", async () => {
  const bPropertyId = await createProperty(B.agent.cookie, "5 Cross Tenant Household Rd");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId, { firstName: "Bee", lastName: "Other", email: uniqueEmail("bee") });

  const crossTenantRes = await fetch(contactsUrl(`/${aPartyId}/relationships`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ relatedPartyId: bPartyId, relationshipType: "family" }),
  });
  assert.equal(crossTenantRes.status, 404);

  const crossTenantDeleteRes = await fetch(contactsUrl(`/relationships/${householdRelationshipId}`), {
    method: "DELETE",
    headers: { cookie: B.agent.cookie },
  });
  assert.equal(crossTenantDeleteRes.status, 404, "Brokerage B must not be able to delete Brokerage A's household relationship");

  const deleteRes = await fetch(contactsUrl(`/relationships/${householdRelationshipId}`), { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(deleteRes.status, 204);

  const afterDeleteRes = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  const afterDeleteBody = (await afterDeleteRes.json()) as { householdRelationships: unknown[] };
  assert.deepEqual(afterDeleteBody.householdRelationships, []);

  const deleteAgainRes = await fetch(contactsUrl(`/relationships/${householdRelationshipId}`), { method: "DELETE", headers: { cookie: A.agent.cookie } });
  assert.equal(deleteAgainRes.status, 404);
});

test("Priority 1 integration: a contact<->property relationship created via the existing POST /grow/relationships route (routes/grow.ts) appears in this contact's Contact 360 properties list and intelligence, proving Grow extends the canonical relationship table rather than creating a second one", async () => {
  await grant(A.brokerageId, "grow.access");
  await grant(A.brokerageId, "grow.relationships.manage");

  const propertyId = await createProperty(A.agent.cookie, "6 Priority One Integration St");

  const createRelRes = await fetch(`${baseUrl}/api/grow/relationships`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: freshPartyId, propertyId, relationshipType: "prospective_buyer" }),
  });
  const createRelBody = (await createRelRes.json()) as { relationship: { id: number } };
  assert.equal(createRelRes.status, 201, JSON.stringify(createRelBody));

  const detailRes = await fetch(contactsUrl(`/${freshPartyId}`), { headers: { cookie: A.agent.cookie } });
  const detailBody = (await detailRes.json()) as {
    properties: Array<{ relationshipId: number; propertyId: number; relationshipType: string }>;
    intelligence: { relatedPropertyCount: number };
  };
  assert.equal(detailRes.status, 200);
  assert.ok(detailBody.properties.some((p) => p.relationshipId === createRelBody.relationship.id && p.propertyId === propertyId));
  assert.equal(detailBody.intelligence.relatedPropertyCount, 1);

  // The existing Priority 1 GET /grow/relationships list still returns it unaffected — Priority
  // 2 only added a partyId-scoped read on top, never a competing write path.
  const listRes = await fetch(`${baseUrl}/api/grow/relationships`, { headers: { cookie: A.agent.cookie } });
  const listBody = (await listRes.json()) as { relationships: Array<{ id: number }> };
  assert.equal(listRes.status, 200);
  assert.ok(listBody.relationships.some((r) => r.id === createRelBody.relationship.id));
});

test("POST /:partyId/commitments validates required fields and enforces tenant isolation on an optional propertyId", async () => {
  const missingRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Missing dueAt" }),
  });
  assert.equal(missingRes.status, 400);

  const badDateRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Bad date", dueAt: "not-a-date" }),
  });
  assert.equal(badDateRes.status, 400);

  const bPropertyId = await createProperty(B.agent.cookie, "7 Cross Tenant Commitment Ave");
  const crossTenantPropertyRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Cross-tenant property must be rejected", dueAt: "2027-01-01", propertyId: bPropertyId }),
  });
  assert.equal(crossTenantPropertyRes.status, 404);

  const okRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Call next month", dueAt: "2027-02-01" }),
  });
  const okBody = (await okRes.json()) as { commitment: { id: number; status: string } };
  assert.equal(okRes.status, 201, JSON.stringify(okBody));
  assert.equal(okBody.commitment.status, "Open");
  commitmentIdToComplete = okBody.commitment.id;

  const secondRes = await fetch(contactsUrl(`/${aPartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Send market report", dueAt: "2027-03-01" }),
  });
  const secondBody = (await secondRes.json()) as { commitment: { id: number } };
  assert.equal(secondRes.status, 201, JSON.stringify(secondBody));
  commitmentIdToCancel = secondBody.commitment.id;
});

test("PATCH /commitments/:id completes a commitment, records exactly one growActivities row and a Timeline COMMITMENT_COMPLETED entry, and rejects completing it a second time", async () => {
  const beforeActivityRows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.partyId, aPartyId), eq(growActivities.activityType, "task_completion")));

  const completeRes = await fetch(contactsUrl(`/commitments/${commitmentIdToComplete}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "Completed" }),
  });
  const completeBody = (await completeRes.json()) as { commitment: { status: string; completedAt: string | null } };
  assert.equal(completeRes.status, 200, JSON.stringify(completeBody));
  assert.equal(completeBody.commitment.status, "Completed");
  assert.ok(completeBody.commitment.completedAt);

  const afterActivityRows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.partyId, aPartyId), eq(growActivities.activityType, "task_completion")));
  assert.equal(afterActivityRows.length, beforeActivityRows.length + 1, "completing a commitment must record exactly one growActivities row");

  const detailRes = await fetch(contactsUrl(`/${aPartyId}`), { headers: { cookie: A.agent.cookie } });
  const detailBody = (await detailRes.json()) as { timeline: Array<{ type: string; sourceId: number }> };
  assert.ok(detailBody.timeline.some((e) => e.type === "COMMITMENT_COMPLETED" && e.sourceId === commitmentIdToComplete));

  const invalidStatusRes = await fetch(contactsUrl(`/commitments/${commitmentIdToComplete}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "Open" }),
  });
  assert.equal(invalidStatusRes.status, 400, "status must be Completed or Cancelled, not a reversion to Open");

  const doubleCompleteRes = await fetch(contactsUrl(`/commitments/${commitmentIdToComplete}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "Completed" }),
  });
  assert.equal(doubleCompleteRes.status, 409, "a commitment that is already Completed cannot be completed again");
});

test("PATCH /commitments/:id cancels a commitment with a reason, and enforces tenant isolation", async () => {
  const cancelRes = await fetch(contactsUrl(`/commitments/${commitmentIdToCancel}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ status: "Cancelled", cancelReason: "No longer needed" }),
  });
  const cancelBody = (await cancelRes.json()) as { commitment: { status: string; cancelReason: string | null } };
  assert.equal(cancelRes.status, 200, JSON.stringify(cancelBody));
  assert.equal(cancelBody.commitment.status, "Cancelled");
  assert.equal(cancelBody.commitment.cancelReason, "No longer needed");

  const crossTenantRes = await fetch(contactsUrl(`/commitments/${commitmentIdToCancel}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ status: "Completed" }),
  });
  assert.equal(crossTenantRes.status, 404, "Brokerage B must not be able to mutate Brokerage A's commitment");
});

test("Relationship Timeline: aggregates every source table with no join-caused duplicates, in newest-first deterministic order, and stays tenant-isolated", async () => {
  await grant(A.brokerageId, "grow.opportunities.manage");

  const propertyId1 = await createProperty(A.agent.cookie, "8 Timeline Rd");
  const timelinePartyId = await createParty(A.agent.cookie, propertyId1, { firstName: "Tim", lastName: "Line", email: uniqueEmail("tim") });

  // 3 relationships + 2 activities + 1 opportunity + 1 commitment. A join across these four
  // tables (instead of the deliberate per-table-query + in-memory-merge design) would produce a
  // cross product — this test proves that never happens, by asserting an EXACT event count and
  // unique event ids, not just "at least the expected events".
  const relationshipTypes = ["prospective_buyer", "tenant", "landlord"];
  for (const relationshipType of relationshipTypes) {
    const res = await fetch(`${baseUrl}/api/grow/relationships`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ partyId: timelinePartyId, propertyId: propertyId1, relationshipType }),
    });
    assert.equal(res.status, 201, await res.text());
  }

  for (const summary of ["First call", "Second call"]) {
    const res = await fetch(`${baseUrl}/api/grow/activities`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: A.agent.cookie },
      body: JSON.stringify({ activityType: "call", summary, partyId: timelinePartyId }),
    });
    assert.equal(res.status, 201, await res.text());
  }

  const oppRes = await fetch(`${baseUrl}/api/grow/opportunities`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ partyId: timelinePartyId, opportunityType: "Appraisal", reason: "Enquired about a market appraisal" }),
  });
  assert.equal(oppRes.status, 201, await oppRes.text());

  const commitRes = await fetch(contactsUrl(`/${timelinePartyId}/commitments`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ description: "Follow up after holiday", dueAt: "2027-04-01" }),
  });
  assert.equal(commitRes.status, 201, await commitRes.text());

  const detailRes = await fetch(contactsUrl(`/${timelinePartyId}`), { headers: { cookie: A.agent.cookie } });
  const detailBody = (await detailRes.json()) as {
    timeline: Array<{ id: string; type: string; occurredAt: string }>;
  };
  assert.equal(detailRes.status, 200);

  // 1 CONTACT_CREATED + 3 PROPERTY_RELATIONSHIP_ESTABLISHED + 2 ACTIVITY_LOGGED +
  // 1 OPPORTUNITY_CREATED + 1 COMMITMENT_CREATED = 8, never a multiplied cross-product of that.
  assert.equal(detailBody.timeline.length, 8, JSON.stringify(detailBody.timeline));

  const ids = detailBody.timeline.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "every Timeline entry id must be unique — no join-caused duplicate rows");

  const countByType = (type: string) => detailBody.timeline.filter((e) => e.type === type).length;
  assert.equal(countByType("CONTACT_CREATED"), 1);
  assert.equal(countByType("PROPERTY_RELATIONSHIP_ESTABLISHED"), 3);
  assert.equal(countByType("ACTIVITY_LOGGED"), 2);
  assert.equal(countByType("OPPORTUNITY_CREATED"), 1);
  assert.equal(countByType("COMMITMENT_CREATED"), 1);

  for (let i = 1; i < detailBody.timeline.length; i++) {
    assert.ok(
      detailBody.timeline[i - 1]!.occurredAt >= detailBody.timeline[i]!.occurredAt,
      `Timeline not in newest-first order at index ${i}: ${detailBody.timeline[i - 1]!.occurredAt} < ${detailBody.timeline[i]!.occurredAt}`,
    );
  }

  // Tenant isolation: Brokerage B (already holding grow.contacts.read from an earlier test)
  // must not be able to reach this Timeline via a cross-tenant partyId.
  const crossTenantRes = await fetch(contactsUrl(`/${timelinePartyId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantRes.status, 404);
});

test("Priority 1 integration: GET /grow/today still resolves successfully after Priority 2's additions to the Grow schema and routes", async () => {
  const res = await fetch(`${baseUrl}/api/grow/today`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(body && typeof body === "object");
});
