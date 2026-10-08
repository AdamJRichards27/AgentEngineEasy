// UAT-V2 — an Agent sees only their own property-linked Grow rows.
// Brokerage Administrator and Pit Crew stay brokerage-wide. A contact with
// no property stays visible to every Grow user in the brokerage, as do
// contact-only relationships and activities. An unlinked commitment or
// opportunity is visible to the Agent who owns it, and to Admin and Pit
// Crew, not to another Agent. A property the caller cannot see is the same
// 404 a cross-tenant read already returns.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, appraisals, entitlementGrants, users } from "@aee/db";
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
const brokerageName = `UAT-V2 Grow Visibility ${suffix}`;

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
let sharedContactId: number;
let appraisalAId: number;
let appraisalBId: number;

const GROW_KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.propertyIntelligence.read",
] as const;

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

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await postRaw("/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { property: { id: number } };
  return body.property.id;
}

interface Contact360 {
  contact: { id: number; displayName: string };
  properties: Array<{ propertyId: number | null }>;
  opportunities: Array<{ id: number; propertyId: number | null }>;
  activities: Array<{ id: number; propertyId: number | null }>;
  commitments: Array<{ id: number; propertyId: number | null }>;
  timeline: Array<{ propertyId: number | null; summary: string }>;
  intelligence: { relatedPropertyCount: number; activeOpportunityCount: number };
}

function propertyIds(rows: Array<{ propertyId: number | null }>): Array<number | null> {
  return rows.map((row) => row.propertyId).sort((a, b) => (a ?? 0) - (b ?? 0));
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
    email: `uatv2-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `uatv2-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };
  agentWithNone = await devLogin(baseUrl, {
    email: `uatv2-agent-none-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "None",
    brokerageName,
  });
  other = await createBrokerageWithUsers(baseUrl, `UAT-V2 Grow Visibility Other ${suffix}`);

  for (const id of [brokerageId, other.brokerageId]) {
    for (const key of GROW_KEYS) await grant(id, key);
  }

  propertyAId = await createProperty(agentA.cookie, `${suffix} Agent A St`);
  propertyBId = await createProperty(agentB.cookie, `${suffix} Agent B St`);
  foreignPropertyId = await createProperty(other.agent.cookie, `${suffix} Foreign St`);

  const contact = await postRaw("/grow/contacts", agentA.cookie, {
    firstName: "Shared",
    lastName: `Contact${suffix}`,
    email: `shared-${suffix}@example.com`,
  });
  assert.equal(contact.status, 201, await contact.clone().text());
  sharedContactId = ((await contact.json()) as { contact: { id: number } }).contact.id;

  for (const [cookie, propertyId] of [
    [agentA.cookie, propertyAId],
    [agentB.cookie, propertyBId],
  ] as const) {
    const relationship = await postRaw("/grow/relationships", cookie, {
      partyId: sharedContactId,
      propertyId,
      relationshipType: "owner",
    });
    assert.equal(relationship.status, 201, await relationship.clone().text());
    const activity = await postRaw("/grow/activities", cookie, {
      partyId: sharedContactId,
      propertyId,
      activityType: "note",
      summary: `Note on property ${propertyId}`,
    });
    assert.equal(activity.status, 201, await activity.clone().text());
    const opportunity = await postRaw("/grow/opportunities", cookie, {
      partyId: sharedContactId,
      propertyId,
      opportunityType: "Appraisal",
      reason: `Opportunity on property ${propertyId}`,
    });
    assert.equal(opportunity.status, 201, await opportunity.clone().text());
    const commitment = await postRaw(`/grow/contacts/${sharedContactId}/commitments`, cookie, {
      description: `Promise about property ${propertyId}`,
      dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      propertyId,
    });
    assert.equal(commitment.status, 201, await commitment.clone().text());
    const appraisal = await postRaw("/grow/appraisals/from-contact", cookie, {
      partyId: sharedContactId,
      propertyId,
    });
    assert.equal(appraisal.status, 201, await appraisal.clone().text());
    const appraisalId = ((await appraisal.json()) as { appraisal: { id: number } }).appraisal.id;
    if (propertyId === propertyAId) appraisalAId = appraisalId;
    else appraisalBId = appraisalId;
    await db
      .update(appraisals)
      .set({ status: "FOLLOW_UP", followUpAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .where(eq(appraisals.id, appraisalId));
  }

  const contactOnlyRelationship = await postRaw("/grow/relationships", agentA.cookie, {
    partyId: sharedContactId,
    relationshipType: "prospect",
  });
  assert.equal(contactOnlyRelationship.status, 201, await contactOnlyRelationship.clone().text());
  const contactOnlyActivity = await postRaw("/grow/activities", agentA.cookie, {
    partyId: sharedContactId,
    activityType: "note",
    summary: "Contact-only note",
  });
  assert.equal(contactOnlyActivity.status, 201, await contactOnlyActivity.clone().text());
  const contactOnlyOpportunity = await postRaw("/grow/opportunities", agentA.cookie, {
    partyId: sharedContactId,
    opportunityType: "Other",
    reason: "Contact-only opportunity",
  });
  assert.equal(contactOnlyOpportunity.status, 201, await contactOnlyOpportunity.clone().text());
  const contactOnlyCommitment = await postRaw(`/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
    description: "Contact-only promise",
    dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(contactOnlyCommitment.status, 201, await contactOnlyCommitment.clone().text());
});

after(async () => {
  await cleanupBrokerages([brokerageId, other?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function contact360(cookie: string): Promise<Contact360> {
  const res = await getRaw(`/grow/contacts/${sharedContactId}`, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Contact360;
}

test("an Agent does not see another Agent's property-linked Grow rows, and still sees contact-only rows", async () => {
  const relationships = await getRaw("/grow/relationships", agentA.cookie);
  assert.equal(relationships.status, 200);
  const relationshipRows = ((await relationships.json()) as { relationships: Array<{ propertyId: number | null }> }).relationships;
  assert.deepEqual(propertyIds(relationshipRows), [null, propertyAId]);

  const activities = await getRaw("/grow/activities", agentA.cookie);
  const activityRows = ((await activities.json()) as { activities: Array<{ propertyId: number | null; summary: string }> }).activities;
  assert.deepEqual(propertyIds(activityRows), [null, propertyAId]);
  assert.ok(activityRows.some((row) => row.summary === "Contact-only note"));

  const opportunities = await getRaw("/grow/opportunities", agentA.cookie);
  const opportunityRows = ((await opportunities.json()) as { opportunities: Array<{ propertyId: number | null }> }).opportunities;
  assert.deepEqual(propertyIds(opportunityRows), [null, propertyAId]);

  const overview = await getRaw("/grow/overview", agentA.cookie);
  assert.deepEqual(await overview.json(), { relationshipCount: 2, activityCount: 2, openOpportunityCount: 2 });

  const today = await getRaw("/grow/today", agentA.cookie);
  assert.equal(today.status, 200, await today.clone().text());
  const todayBody = (await today.json()) as { priorityActions: Array<{ propertyId: number | null; type: string }> };
  const todayPropertyIds = todayBody.priorityActions.map((card) => card.propertyId);
  assert.ok(!todayPropertyIds.includes(propertyBId), "a Today card must not name Agent B's property");
  assert.ok(todayPropertyIds.includes(propertyAId));
  assert.ok(todayPropertyIds.includes(null));
  assert.ok(todayBody.priorityActions.some((card) => card.type === "appraisal_follow_up" && card.propertyId === propertyAId));
  assert.ok(!todayBody.priorityActions.some((card) => card.type === "appraisal_follow_up" && card.propertyId === propertyBId));

  const pipeline = await getRaw("/grow/appraisals/pipeline", agentA.cookie);
  const pipelineRows = ((await pipeline.json()) as { appraisals: Array<{ id: number; propertyId: number }> }).appraisals;
  assert.deepEqual(pipelineRows.map((row) => row.id), [appraisalAId]);

  const ownAppraisal = await getRaw(`/grow/appraisals/${appraisalAId}`, agentA.cookie);
  assert.equal(ownAppraisal.status, 200);
  const hiddenAppraisal = await getRaw(`/grow/appraisals/${appraisalBId}`, agentA.cookie);
  assert.equal(hiddenAppraisal.status, 404);
  assert.deepEqual(await hiddenAppraisal.json(), { error: "Appraisal not found" });

  const ownRunAppraisal = await getRaw(`/appraisals/by-property/${propertyAId}`, agentA.cookie);
  assert.equal(ownRunAppraisal.status, 200);
  const hiddenRunAppraisal = await getRaw(`/appraisals/by-property/${propertyBId}`, agentA.cookie);
  assert.equal(hiddenRunAppraisal.status, 404);
  assert.deepEqual(await hiddenRunAppraisal.json(), { error: "Not found" });

  const ownIntelligence = await getRaw(`/grow/property-intelligence/property/${propertyAId}`, agentA.cookie);
  assert.equal(ownIntelligence.status, 200);
  const hiddenIntelligence = await getRaw(`/grow/property-intelligence/property/${propertyBId}`, agentA.cookie);
  assert.equal(hiddenIntelligence.status, 404);
  assert.deepEqual(await hiddenIntelligence.json(), { error: "Property not found" });
  const hiddenMatches = await getRaw(`/grow/property-intelligence/property/${propertyBId}/matches`, agentA.cookie);
  assert.equal(hiddenMatches.status, 404);
  assert.deepEqual(await hiddenMatches.json(), { error: "Property not found" });
  const hiddenSignals = await getRaw(`/grow/property-intelligence/property/${propertyBId}/signals`, agentA.cookie);
  assert.equal(hiddenSignals.status, 404);
  assert.deepEqual(await hiddenSignals.json(), { error: "Property not found" });

  const view = await contact360(agentA.cookie);
  assert.equal(view.contact.id, sharedContactId);
  assert.deepEqual(propertyIds(view.properties), [null, propertyAId]);
  assert.deepEqual(propertyIds(view.opportunities), [null, propertyAId]);
  assert.deepEqual(propertyIds(view.activities), [null, propertyAId]);
  assert.deepEqual(propertyIds(view.commitments), [null, propertyAId]);
  assert.ok(!view.timeline.some((event) => event.propertyId === propertyBId));
  assert.ok(view.timeline.some((event) => event.propertyId === null));
  assert.ok(view.timeline.some((event) => event.propertyId === propertyAId));
  assert.equal(view.intelligence.relatedPropertyCount, 1);
  assert.equal(view.intelligence.activeOpportunityCount, 2);

  const contactIntelligence = await getRaw(`/grow/property-intelligence/contact/${sharedContactId}`, agentA.cookie);
  assert.equal(contactIntelligence.status, 200);
  const contactIntelligenceBody = (await contactIntelligence.json()) as { properties: Array<{ propertyId: number }> };
  assert.deepEqual(
    contactIntelligenceBody.properties.map((entry) => entry.propertyId).sort((a, b) => a - b),
    [propertyAId],
  );
});

test("an Agent with no properties still sees the shared contact and contact-only relationships and activities", async () => {
  const listed = await getRaw(`/grow/contacts?search=Contact${suffix}`, agentWithNone.cookie);
  assert.equal(listed.status, 200);
  const contacts = ((await listed.json()) as { contacts: Array<{ id: number }> }).contacts;
  assert.ok(contacts.some((contact) => contact.id === sharedContactId));

  const view = await contact360(agentWithNone.cookie);
  assert.equal(view.contact.id, sharedContactId);
  assert.deepEqual(propertyIds(view.properties), [null]);
  assert.deepEqual(propertyIds(view.opportunities), []);
  assert.deepEqual(propertyIds(view.activities), [null]);
  assert.deepEqual(propertyIds(view.commitments), []);
  assert.equal(view.intelligence.relatedPropertyCount, 0);
  assert.equal(view.intelligence.activeOpportunityCount, 0);

  const today = await getRaw("/grow/today", agentWithNone.cookie);
  const todayBody = (await today.json()) as {
    priorityActions: Array<{ propertyId: number | null; type: string }>;
    counts: { openOpportunities: number };
    firstRun: { commitment: boolean; opportunity: boolean };
  };
  assert.ok(todayBody.priorityActions.every((card) => card.propertyId === null));
  assert.ok(!todayBody.priorityActions.some((card) => card.type === "commitment" || card.type.startsWith("opportunity")));
  assert.equal(todayBody.counts.openOpportunities, 0);
  assert.equal(todayBody.firstRun.commitment, false);
  assert.equal(todayBody.firstRun.opportunity, false);
});

test("Brokerage Administrator and Pit Crew still see every property-linked Grow row", async () => {
  for (const cookie of [admin.cookie, pitCrew.cookie]) {
    const relationships = await getRaw("/grow/relationships", cookie);
    const relationshipRows = ((await relationships.json()) as { relationships: Array<{ propertyId: number | null }> }).relationships;
    assert.deepEqual(propertyIds(relationshipRows), [null, propertyAId, propertyBId]);

    const pipeline = await getRaw("/grow/appraisals/pipeline", cookie);
    const pipelineIds = ((await pipeline.json()) as { appraisals: Array<{ id: number }> }).appraisals.map((row) => row.id).sort((a, b) => a - b);
    assert.deepEqual(pipelineIds, [appraisalAId, appraisalBId].sort((a, b) => a - b));

    const appraisalB = await getRaw(`/grow/appraisals/${appraisalBId}`, cookie);
    assert.equal(appraisalB.status, 200);
    const runAppraisalB = await getRaw(`/appraisals/by-property/${propertyBId}`, cookie);
    assert.equal(runAppraisalB.status, 200);
    const intelligenceB = await getRaw(`/grow/property-intelligence/property/${propertyBId}`, cookie);
    assert.equal(intelligenceB.status, 200);

    const view = await contact360(cookie);
    assert.deepEqual(propertyIds(view.properties), [null, propertyAId, propertyBId]);
    assert.equal(view.intelligence.relatedPropertyCount, 2);

    const today = await getRaw("/grow/today", cookie);
    const todayBody = (await today.json()) as { priorityActions: Array<{ propertyId: number | null }> };
    const ids = new Set(todayBody.priorityActions.map((card) => card.propertyId));
    assert.ok(ids.has(propertyAId));
    assert.ok(ids.has(propertyBId));
    assert.ok(ids.has(null));
  }
});

test("cross-tenant Grow reads stay 404 and do not include this brokerage's rows", async () => {
  const relationships = await getRaw("/grow/relationships", other.agent.cookie);
  const relationshipRows = ((await relationships.json()) as { relationships: Array<{ propertyId: number | null }> }).relationships;
  assert.equal(relationshipRows.length, 0);

  const contact = await getRaw(`/grow/contacts/${sharedContactId}`, other.agent.cookie);
  assert.equal(contact.status, 404);

  const appraisal = await getRaw(`/grow/appraisals/${appraisalAId}`, other.agent.cookie);
  assert.equal(appraisal.status, 404);
  assert.deepEqual(await appraisal.json(), { error: "Appraisal not found" });

  const runAppraisal = await getRaw(`/appraisals/by-property/${propertyAId}`, other.agent.cookie);
  assert.equal(runAppraisal.status, 404);
  assert.deepEqual(await runAppraisal.json(), { error: "Not found" });

  const intelligence = await getRaw(`/grow/property-intelligence/property/${foreignPropertyId}`, agentA.cookie);
  assert.equal(intelligence.status, 404);
  assert.deepEqual(await intelligence.json(), { error: "Property not found" });

  const foreignOwn = await getRaw(`/grow/property-intelligence/property/${foreignPropertyId}`, other.agent.cookie);
  assert.equal(foreignOwn.status, 200);
});

test("a contact search still returns the shared contact, and creating a contact does not require a property", async () => {
  for (const cookie of [agentA.cookie, agentB.cookie, admin.cookie, pitCrew.cookie]) {
    const listed = await getRaw(`/grow/contacts?search=Contact${suffix}`, cookie);
    assert.equal(listed.status, 200);
    const contacts = ((await listed.json()) as { contacts: Array<{ id: number }> }).contacts;
    assert.ok(contacts.some((contact) => contact.id === sharedContactId));
  }

  const created = await postRaw("/grow/contacts", agentB.cookie, {
    firstName: "Second",
    lastName: `Contact${suffix}`,
    email: `second-${suffix}@example.com`,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdId = ((await created.json()) as { contact: { id: number } }).contact.id;
  const visibleToA = await getRaw(`/grow/contacts/${createdId}`, agentA.cookie);
  assert.equal(visibleToA.status, 200);
  const body = (await visibleToA.json()) as Contact360;
  assert.equal(body.contact.id, createdId);
  assert.deepEqual(body.properties, []);
});
