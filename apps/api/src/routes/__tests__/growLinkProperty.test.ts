// G-UAT-3 — linking a property on POST /grow/relationships.
// grow.relationships.manage stays the gate for every relationship. A body
// that names a propertyId also needs grow.properties.link. A hidden property
// and a cross-brokerage property keep the existing 404. A duplicate link is
// 409 and does not insert a second row. prospective_seller is a real type:
// Contact 360 lists it, and Grow Today surfaces that contact the same way
// the existing cold-contact tests do.
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { db, entitlementGrants, growRelationships, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `G-UAT-3 Link ${suffix}`;

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let brokerageId: number;
let manageOnly: { agent: DevLoginResult; brokerageId: number };
let other: { agent: DevLoginResult; brokerageId: number };

let propertyAId: number;
let propertyBId: number;
let foreignPropertyId: number;
let contactId: number;

describe("G-UAT-3 link property", { concurrency: 1 }, () => {
before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const created = await createBrokerageWithUsers(baseUrl, brokerageName);
  admin = created.admin;
  agentA = created.agent;
  brokerageId = created.brokerageId;
  agentB = await devLogin(baseUrl, {
    email: `guat3-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `guat3-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

  const manageOnlyBrokerage = await createBrokerageWithUsers(baseUrl, `G-UAT-3 Manage Only ${suffix}`);
  manageOnly = { agent: manageOnlyBrokerage.agent, brokerageId: manageOnlyBrokerage.brokerageId };
  other = await createBrokerageWithUsers(baseUrl, `G-UAT-3 Other ${suffix}`);

  for (const key of [
    "grow.access",
    "grow.contacts.read",
    "grow.contacts.manage",
    "grow.relationships.manage",
    "grow.properties.link",
  ]) {
    await grant(brokerageId, key);
    await grant(other.brokerageId, key);
  }
  for (const key of ["grow.access", "grow.contacts.read", "grow.contacts.manage", "grow.relationships.manage"]) {
    await grant(manageOnly.brokerageId, key);
  }

  propertyAId = await createProperty(agentA.cookie, `${suffix} Agent A St`);
  propertyBId = await createProperty(agentB.cookie, `${suffix} Agent B St`);
  foreignPropertyId = await createProperty(other.agent.cookie, `${suffix} Foreign St`);
  contactId = await createContact(agentA.cookie, "Shared", `shared-${suffix}@example.com`);
});

after(async () => {
  await cleanupBrokerages([brokerageId, manageOnly?.brokerageId, other?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(id: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId: id,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: id,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(id);
}

function post(cookie: string, path: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await post(cookie, "/properties", {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createContact(cookie: string, firstName: string, email: string): Promise<number> {
  const res = await post(cookie, "/grow/contacts", { firstName, lastName: "Contact", email });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { contact: { id: number } }).contact.id;
}

async function linksFor(id: number, partyId: number, propertyId: number, relationshipType: string) {
  return db
    .select({ id: growRelationships.id })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, id),
        eq(growRelationships.partyId, partyId),
        eq(growRelationships.propertyId, propertyId),
        eq(growRelationships.relationshipType, relationshipType),
      ),
    );
}

function isolationCount(): number {
  let total = 0;
  for (const line of renderMetricsText().split("\n")) {
    const match = /^tenant_isolation_rejection_total\{boundary="grow"\} (\d+)$/.exec(line);
    if (match) total += Number(match[1]);
  }
  return total;
}

test("linking a property requires grow.properties.link, and a relationship with no property keeps grow.relationships.manage", async () => {
  const propertyId = await createProperty(manageOnly.agent.cookie, `${suffix} Manage Only St`);
  const partyId = await createContact(manageOnly.agent.cookie, "NoLink", `nolink-${suffix}@example.com`);

  const denied = await post(manageOnly.agent.cookie, "/grow/relationships", {
    partyId,
    propertyId,
    relationshipType: "owner",
  });
  assert.equal(denied.status, 403);
  const deniedBody = (await denied.json()) as { reason: string; entitlementKey: string };
  assert.equal(deniedBody.reason, "ENTITLEMENT_MISSING");
  assert.equal(deniedBody.entitlementKey, "grow.properties.link");
  assert.equal((await linksFor(manageOnly.brokerageId, partyId, propertyId, "owner")).length, 0);

  const withoutManage = await createBrokerageWithUsers(baseUrl, `G-UAT-3 No Manage ${suffix}`);
  try {
    const noManage = await post(withoutManage.agent.cookie, "/grow/relationships", {
      partyId: 1,
      relationshipType: "prospective_seller",
    });
    assert.equal(noManage.status, 403);
    const noManageBody = (await noManage.json()) as { entitlementKey: string };
    assert.equal(noManageBody.entitlementKey, "grow.relationships.manage");
  } finally {
    await cleanupBrokerages([withoutManage.brokerageId]);
  }

  const contactOnly = await post(manageOnly.agent.cookie, "/grow/relationships", {
    partyId,
    relationshipType: "prospective_seller",
  });
  assert.equal(contactOnly.status, 201, await contactOnly.clone().text());
  const contactOnlyBody = (await contactOnly.json()) as { relationship: { propertyId: number | null; relationshipType: string } };
  assert.equal(contactOnlyBody.relationship.propertyId, null);
  assert.equal(contactOnlyBody.relationship.relationshipType, "prospective_seller");
});

test("an Agent cannot link another Agent's property, and Brokerage Administrator and Pit Crew can link any property in the brokerage", async () => {
  const hidden = await post(agentA.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyBId,
    relationshipType: "owner",
  });
  assert.equal(hidden.status, 404);
  const hiddenBody = (await hidden.json()) as { error: string };
  assert.equal(hiddenBody.error, "Property not found in this brokerage");
  assert.equal((await linksFor(brokerageId, contactId, propertyBId, "owner")).length, 0);

  const adminLink = await post(admin.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyBId,
    relationshipType: "owner",
  });
  assert.equal(adminLink.status, 201, await adminLink.clone().text());

  const pitLink = await post(pitCrew.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyBId,
    relationshipType: "landlord",
  });
  assert.equal(pitLink.status, 201, await pitLink.clone().text());
});

test("a property from another brokerage is rejected with the existing isolation response", async () => {
  resetMetricsForTesting();
  const res = await post(agentA.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: foreignPropertyId,
    relationshipType: "owner",
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "Property not found in this brokerage");
  assert.equal(isolationCount(), 1);
  assert.equal((await linksFor(brokerageId, contactId, foreignPropertyId, "owner")).length, 0);
});

test("a duplicate link returns 409 with the existing relationship id and does not create another row", async () => {
  const first = await post(agentA.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyAId,
    relationshipType: "owner",
  });
  assert.equal(first.status, 201, await first.clone().text());
  const firstId = ((await first.json()) as { relationship: { id: number } }).relationship.id;

  const again = await post(agentA.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyAId,
    relationshipType: "owner",
  });
  assert.equal(again.status, 409);
  const againBody = (await again.json()) as { error: string; relationshipId: number };
  assert.equal(againBody.relationshipId, firstId);
  assert.match(againBody.error, /already linked/);
  assert.equal((await linksFor(brokerageId, contactId, propertyAId, "owner")).length, 1);

  const otherType = await post(agentA.cookie, "/grow/relationships", {
    partyId: contactId,
    propertyId: propertyAId,
    relationshipType: "buyer",
  });
  assert.equal(otherType.status, 201, await otherType.clone().text());
});

test("prospective_seller is accepted, listed on Contact 360, and surfaced on Grow Today", async () => {
  const partyId = await createContact(agentA.cookie, "Future", `future-${suffix}@example.com`);
  const created = await post(agentA.cookie, "/grow/relationships", {
    partyId,
    propertyId: propertyAId,
    relationshipType: "prospective_seller",
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = (await created.json()) as { relationship: { id: number; relationshipType: string } };
  const relationshipId = createdBody.relationship.id;
  assert.equal(createdBody.relationship.relationshipType, "prospective_seller");

  const detail = await fetch(`${baseUrl}/api/grow/contacts/${partyId}`, { headers: { cookie: agentA.cookie } });
  assert.equal(detail.status, 200, await detail.clone().text());
  const detailBody = (await detail.json()) as {
    properties: Array<{ relationshipId: number; propertyId: number | null; relationshipType: string }>;
  };
  const listed = detailBody.properties.find((row) => row.relationshipId === relationshipId);
  assert.ok(listed, "Contact 360 properties includes the new link");
  assert.equal(listed.propertyId, propertyAId);
  assert.equal(listed.relationshipType, "prospective_seller");

  // Same assertion growToday.test.ts uses for this type: an Active
  // prospective_seller with no recorded contact is a Keep Warm card.
  // Today's Emerging confidence band is the property-intelligence signal
  // surface that file already covers; this link does not write a signal.
  const today = await fetch(`${baseUrl}/api/grow/today`, { headers: { cookie: agentA.cookie } });
  assert.equal(today.status, 200, await today.clone().text());
  const todayBody = (await today.json()) as {
    priorityActions: Array<{ partyId: number; relationshipType: string | null; priority: string; type: string }>;
  };
  const card = todayBody.priorityActions.find((action) => action.partyId === partyId);
  assert.ok(card, "Grow Today includes the future seller");
  assert.equal(card.relationshipType, "prospective_seller");
  assert.equal(card.type, "relationship_cold");
  assert.equal(card.priority, "KeepWarm");
});
});
