// UAT-V1 — an Agent sees only properties they are the agent for on the
// property list, Home counts, and the property reads reached from that list.
// Brokerage Administrator and Pit Crew stay brokerage-wide. A property the
// caller cannot see is the same 404 a cross-tenant read already returns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, properties, users } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `UAT-V1 Visibility ${suffix}`;

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let agentWithNone: DevLoginResult;
let other: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let brokerageId: number;
let propertyAId: number;
let propertyBId: number;
let foreignPropertyId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<{ id: number; agentId: number }> {
  const res = await postRaw("/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { property: { id: number; agentId: number } };
  return body.property;
}

interface HomeSummary {
  exceptions: Array<{ propertyId: number; label: string }>;
  nextActions: Array<{ propertyId: number }>;
  activeProperties: Array<{ id: number; address: string }>;
  upcomingSettlements: Array<{ propertyId: number }>;
}

async function homeSummary(cookie: string): Promise<HomeSummary> {
  const res = await getRaw("/home/summary", cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as HomeSummary;
}

async function listedPropertyIds(cookie: string): Promise<number[]> {
  const res = await getRaw("/properties", cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { properties: Array<{ id: number }> };
  return body.properties.map((p) => p.id).sort((a, b) => a - b);
}

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

  const created = await createBrokerageWithUsers(baseUrl, brokerageName);
  admin = created.admin;
  agentA = created.agent;
  brokerageId = created.brokerageId;
  agentB = await devLogin(baseUrl, {
    email: `uatv1-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `uatv1-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };
  agentWithNone = await devLogin(baseUrl, {
    email: `uatv1-agent-none-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "None",
    brokerageName,
  });
  other = await createBrokerageWithUsers(baseUrl, `UAT-V1 Visibility Other ${suffix}`);

  const propertyA = await createProperty(agentA.cookie, `${suffix} Agent A St`);
  assert.equal(propertyA.agentId, agentA.user.id);
  propertyAId = propertyA.id;
  const propertyB = await createProperty(agentB.cookie, `${suffix} Agent B St`);
  assert.equal(propertyB.agentId, agentB.user.id);
  propertyBId = propertyB.id;
  await db.update(properties).set({ ownershipReviewRequired: true }).where(eq(properties.id, propertyBId));
  foreignPropertyId = (await createProperty(other.agent.cookie, `${suffix} Foreign St`)).id;

  const party = await postRaw("/parties", agentA.cookie, {
    propertyId: propertyAId,
    role: "Seller",
    firstName: "Ada",
    lastName: "Owner",
    email: `ada-uatv1-${suffix}@example.com`,
  });
  assert.equal(party.status, 201, await party.text());
});

after(async () => {
  await cleanupBrokerages([brokerageId, other?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("an Agent sees only their own properties, and Home counts match that set", async () => {
  assert.deepEqual(await listedPropertyIds(agentA.cookie), [propertyAId]);
  assert.deepEqual(await listedPropertyIds(agentB.cookie), [propertyBId]);
  assert.deepEqual(await listedPropertyIds(agentWithNone.cookie), []);

  const homeA = await homeSummary(agentA.cookie);
  assert.deepEqual(homeA.activeProperties.map((p) => p.id), [propertyAId]);
  assert.equal(homeA.activeProperties.length, (await listedPropertyIds(agentA.cookie)).length);
  assert.deepEqual(homeA.exceptions, []);
  assert.deepEqual(homeA.nextActions, []);
  assert.deepEqual(homeA.upcomingSettlements, []);

  const homeB = await homeSummary(agentB.cookie);
  assert.deepEqual(homeB.activeProperties.map((p) => p.id), [propertyBId]);
  assert.equal(homeB.exceptions.length, 1);
  assert.equal(homeB.exceptions[0].propertyId, propertyBId);
  assert.equal(homeB.exceptions[0].label, "Ownership mismatch needs review");
  assert.deepEqual(homeB.nextActions, []);
  assert.deepEqual(homeB.upcomingSettlements, []);

  const homeNone = await homeSummary(agentWithNone.cookie);
  assert.deepEqual(homeNone.activeProperties, []);
  assert.deepEqual(homeNone.exceptions, []);
  assert.deepEqual(homeNone.nextActions, []);
  assert.deepEqual(homeNone.upcomingSettlements, []);
});

test("an Agent gets 404 on another Agent's property detail, timeline, workspace, and parties", async () => {
  const detail = await getRaw(`/properties/${propertyBId}`, agentA.cookie);
  assert.equal(detail.status, 404);
  assert.deepEqual(await detail.json(), { error: "Not found" });

  const timeline = await getRaw(`/properties/${propertyBId}/timeline`, agentA.cookie);
  assert.equal(timeline.status, 404);
  assert.deepEqual(await timeline.json(), { error: `Property ${propertyBId} not found` });

  const workspace = await getRaw(`/properties/${propertyBId}/workspace`, agentA.cookie);
  assert.equal(workspace.status, 404);
  assert.deepEqual(await workspace.json(), { error: "Not found" });

  const parties = await getRaw(`/parties/by-property/${propertyBId}`, agentA.cookie);
  assert.equal(parties.status, 404);
  assert.deepEqual(await parties.json(), { error: "Not found" });

  const ownDetail = await getRaw(`/properties/${propertyAId}`, agentA.cookie);
  assert.equal(ownDetail.status, 200);
  const ownWorkspace = await getRaw(`/properties/${propertyAId}/workspace`, agentA.cookie);
  assert.equal(ownWorkspace.status, 200);
  const ownTimeline = await getRaw(`/properties/${propertyAId}/timeline`, agentA.cookie);
  assert.equal(ownTimeline.status, 200);
  const ownParties = await getRaw(`/parties/by-property/${propertyAId}`, agentA.cookie);
  assert.equal(ownParties.status, 200);
  const ownPartiesBody = (await ownParties.json()) as { parties: Array<{ party: { firstName: string | null } | null }> };
  assert.equal(ownPartiesBody.parties[0]?.party?.firstName, "Ada");
});

test("a Brokerage Administrator and Pit Crew still see brokerage-wide properties and Home counts", async () => {
  const expectedIds = [propertyAId, propertyBId].sort((a, b) => a - b);
  assert.deepEqual(await listedPropertyIds(admin.cookie), expectedIds);
  assert.deepEqual(await listedPropertyIds(pitCrew.cookie), expectedIds);

  for (const cookie of [admin.cookie, pitCrew.cookie]) {
    const home = await homeSummary(cookie);
    assert.deepEqual(
      home.activeProperties.map((p) => p.id).sort((a, b) => a - b),
      expectedIds,
    );
    assert.equal(home.exceptions.length, 1);
    assert.equal(home.exceptions[0].propertyId, propertyBId);
    const detail = await getRaw(`/properties/${propertyBId}`, cookie);
    assert.equal(detail.status, 200);
    const timeline = await getRaw(`/properties/${propertyBId}/timeline`, cookie);
    assert.equal(timeline.status, 200);
  }
});

test("cross-tenant property reads stay 404 with the same bodies", async () => {
  const detail = await getRaw(`/properties/${foreignPropertyId}`, agentA.cookie);
  assert.equal(detail.status, 404);
  assert.deepEqual(await detail.json(), { error: "Not found" });

  const timeline = await getRaw(`/properties/${foreignPropertyId}/timeline`, agentA.cookie);
  assert.equal(timeline.status, 404);
  assert.deepEqual(await timeline.json(), { error: `Property ${foreignPropertyId} not found` });

  const workspace = await getRaw(`/properties/${foreignPropertyId}/workspace`, agentA.cookie);
  assert.equal(workspace.status, 404);
  assert.deepEqual(await workspace.json(), { error: "Not found" });

  const parties = await getRaw(`/parties/by-property/${foreignPropertyId}`, agentA.cookie);
  assert.equal(parties.status, 404);
  assert.deepEqual(await parties.json(), { error: "Not found" });

  const adminDetail = await getRaw(`/properties/${foreignPropertyId}`, admin.cookie);
  assert.equal(adminDetail.status, 404);
  assert.deepEqual(await adminDetail.json(), { error: "Not found" });

  const listed = await listedPropertyIds(other.agent.cookie);
  assert.deepEqual(listed, [foreignPropertyId]);
  const homeOther = await homeSummary(other.agent.cookie);
  assert.deepEqual(homeOther.activeProperties.map((p) => p.id), [foreignPropertyId]);
});
