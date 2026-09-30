// G-UAT-7 — GET /grow/today firstRun. Existence only, scoped the same way
// the caller already sees Grow rows. No new write, and the existing Today
// fields are not recalculated from this probe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, users } from "@aee/db";
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

const NONE = {
  contact: false,
  propertyLink: false,
  activity: false,
  commitment: false,
  opportunity: false,
  appraisal: false,
};

const KEYS = [
  "grow.access",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
] as const;

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

async function grant(brokerageId: number) {
  for (const entitlementKey of KEYS) {
    await db.insert(entitlementGrants).values({
      brokerageId,
      entitlementKey,
      granteeType: "brokerage",
      granteeId: brokerageId,
      sourceType: "manual",
      status: "Active",
    });
  }
  invalidateEntitlementCache(brokerageId);
}

async function post(cookie: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
}

async function fetchToday(cookie: string) {
  const res = await fetch(`${baseUrl}/api/grow/today`, { headers: { cookie } });
  const body = (await res.json()) as {
    hasAnyGrowData: boolean;
    counts: { priorityActions: number; followUpsDue: number; openOpportunities: number; contactsNeedingAttention: number };
    priorityActions: unknown[];
    signalSummary: unknown;
    generatedAt: string;
    firstRun: typeof NONE;
  };
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

function existingFields(body: Awaited<ReturnType<typeof fetchToday>>) {
  return {
    hasAnyGrowData: body.hasAnyGrowData,
    counts: body.counts,
    priorityActions: body.priorityActions,
    signalSummary: body.signalSummary,
  };
}

async function createProperty(cookie: string, address: string) {
  const res = await post(cookie, "/properties", {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createContact(cookie: string, name: string) {
  const res = await post(cookie, "/grow/contacts", { name, email: `${name.replace(/\s+/g, "-").toLowerCase()}-${suffix}@example.com` });
  assert.equal(res.status, 201, await res.clone().text());
  const { contact } = (await res.json()) as { contact: { id: number } };
  return contact.id;
}

test("an empty brokerage has every first-run step false, and a contact does not change the existing Today fields", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `G-UAT-7 Empty ${suffix}`);
  const other = await createBrokerageWithUsers(baseUrl, `G-UAT-7 Empty Other ${suffix}`);
  try {
    await grant(fresh.brokerageId);
    await grant(other.brokerageId);

    const before = await fetchToday(fresh.agent.cookie);
    assert.deepEqual(before.firstRun, NONE);
    assert.equal(before.hasAnyGrowData, false);
    assert.deepEqual(before.priorityActions, []);
    assert.deepEqual(before.counts, {
      priorityActions: 0,
      followUpsDue: 0,
      openOpportunities: 0,
      contactsNeedingAttention: 0,
    });
    assert.equal(typeof before.generatedAt, "string");
    assert.ok(before.signalSummary);

    await createContact(other.agent.cookie, "Other Only");
    const stillEmpty = await fetchToday(fresh.agent.cookie);
    assert.deepEqual(stillEmpty.firstRun, NONE, "another brokerage's contact does not count");
    assert.deepEqual(existingFields(stillEmpty), existingFields(before));

    await createContact(fresh.agent.cookie, "Ada Contact");
    const after = await fetchToday(fresh.agent.cookie);
    assert.deepEqual(after.firstRun, { ...NONE, contact: true });
    assert.deepEqual(existingFields(after), existingFields(before), "a party is not an input to the existing Today buckets");

    const otherAfter = await fetchToday(other.agent.cookie);
    assert.deepEqual(otherAfter.firstRun, { ...NONE, contact: true });
    assert.equal(otherAfter.firstRun.propertyLink, false);
  } finally {
    await cleanupBrokerages([fresh.brokerageId, other.brokerageId]);
  }
});

test("each first-run step flips when its row exists, and a property-less relationship is not a property link", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `G-UAT-7 Steps ${suffix}`);
  const other = await createBrokerageWithUsers(baseUrl, `G-UAT-7 Steps Other ${suffix}`);
  try {
    await grant(fresh.brokerageId);
    await grant(other.brokerageId);

    const partyId = await createContact(fresh.agent.cookie, "Step Contact");
    assert.deepEqual((await fetchToday(fresh.agent.cookie)).firstRun, { ...NONE, contact: true });
    assert.deepEqual((await fetchToday(other.agent.cookie)).firstRun, NONE);

    const unlinked = await post(fresh.agent.cookie, "/grow/relationships", {
      partyId,
      relationshipType: "buyer",
    });
    assert.equal(unlinked.status, 201, await unlinked.clone().text());
    const afterUnlinked = await fetchToday(fresh.agent.cookie);
    assert.equal(afterUnlinked.firstRun.propertyLink, false, "a relationship with no property is not a link");
    assert.equal(afterUnlinked.firstRun.contact, true);
    assert.equal(afterUnlinked.firstRun.activity, false);

    const propertyId = await createProperty(fresh.agent.cookie, `${suffix} Linked St`);
    const linked = await post(fresh.agent.cookie, "/grow/relationships", {
      partyId,
      propertyId,
      relationshipType: "owner",
    });
    assert.equal(linked.status, 201, await linked.clone().text());
    assert.equal((await fetchToday(fresh.agent.cookie)).firstRun.propertyLink, true);
    assert.equal((await fetchToday(other.agent.cookie)).firstRun.propertyLink, false);

    const note = await post(fresh.agent.cookie, "/grow/activities", {
      partyId,
      activityType: "note",
      summary: "Spoke about the property.",
    });
    assert.equal(note.status, 201, await note.clone().text());
    const afterNote = await fetchToday(fresh.agent.cookie);
    assert.equal(afterNote.firstRun.activity, true);
    assert.equal(afterNote.firstRun.commitment, false);

    const beforeCommitment = await fetchToday(fresh.agent.cookie);
    const dueAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const commitment = await post(fresh.agent.cookie, `/grow/contacts/${partyId}/commitments`, {
      description: "Call next month",
      dueAt,
    });
    assert.equal(commitment.status, 201, await commitment.clone().text());
    const afterCommitment = await fetchToday(fresh.agent.cookie);
    assert.equal(afterCommitment.firstRun.commitment, true);
    assert.equal(
      afterCommitment.counts.followUpsDue,
      beforeCommitment.counts.followUpsDue,
      "a future commitment marks the step done without changing the due-today bucket",
    );
    assert.equal((await fetchToday(other.agent.cookie)).firstRun.commitment, false);

    const opportunity = await post(fresh.agent.cookie, "/grow/opportunities", {
      partyId,
      propertyId,
      opportunityType: "Listing",
      reason: "They asked about selling.",
    });
    assert.equal(opportunity.status, 201, await opportunity.clone().text());
    assert.equal((await fetchToday(fresh.agent.cookie)).firstRun.opportunity, true);
    assert.equal((await fetchToday(fresh.agent.cookie)).firstRun.appraisal, false);
    assert.equal((await fetchToday(other.agent.cookie)).firstRun.opportunity, false);

    const appraisal = await post(fresh.agent.cookie, "/grow/appraisals/from-contact", { partyId, propertyId });
    assert.equal(appraisal.status, 201, await appraisal.clone().text());
    assert.deepEqual((await fetchToday(fresh.agent.cookie)).firstRun, {
      contact: true,
      propertyLink: true,
      activity: true,
      commitment: true,
      opportunity: true,
      appraisal: true,
    });
    assert.deepEqual((await fetchToday(other.agent.cookie)).firstRun, NONE);
  } finally {
    await cleanupBrokerages([fresh.brokerageId, other.brokerageId]);
  }
});

test("an agent does not get credit for another agent's property-linked rows; admin and pit crew do; contacts stay brokerage-wide", async () => {
  const name = `G-UAT-7 Visibility ${suffix}`;
  const created = await createBrokerageWithUsers(baseUrl, name);
  const other = await createBrokerageWithUsers(baseUrl, `G-UAT-7 Visibility Other ${suffix}`);
  let agentB: DevLoginResult | undefined;
  let pitCrew: DevLoginResult | undefined;
  try {
    await grant(created.brokerageId);
    await grant(other.brokerageId);
    agentB = await devLogin(baseUrl, {
      email: `guat7-agent-b-${suffix}@example.com`,
      firstName: "Agent",
      lastName: "Bee",
      brokerageName: name,
    });
    pitCrew = await devLogin(baseUrl, {
      email: `guat7-pit-${suffix}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: name,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

    const propertyId = await createProperty(agentB.cookie, `${suffix} Agent B St`);
    const partyId = await createContact(agentB.cookie, "Shared Contact");
    const linked = await post(agentB.cookie, "/grow/relationships", {
      partyId,
      propertyId,
      relationshipType: "owner",
    });
    assert.equal(linked.status, 201, await linked.clone().text());
    const note = await post(agentB.cookie, "/grow/activities", {
      partyId,
      propertyId,
      activityType: "note",
      summary: "Note on B's property.",
    });
    assert.equal(note.status, 201, await note.clone().text());
    const commitment = await post(agentB.cookie, `/grow/contacts/${partyId}/commitments`, {
      description: "Follow up on B's property",
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      propertyId,
    });
    assert.equal(commitment.status, 201, await commitment.clone().text());
    const opportunity = await post(agentB.cookie, "/grow/opportunities", {
      partyId,
      propertyId,
      opportunityType: "Appraisal",
      reason: "B's opportunity.",
    });
    assert.equal(opportunity.status, 201, await opportunity.clone().text());
    const appraisal = await post(agentB.cookie, "/grow/appraisals/from-contact", { partyId, propertyId });
    assert.equal(appraisal.status, 201, await appraisal.clone().text());

    const hiddenFromA = {
      contact: true,
      propertyLink: false,
      activity: false,
      commitment: false,
      opportunity: false,
      appraisal: false,
    };
    const visible = {
      contact: true,
      propertyLink: true,
      activity: true,
      commitment: true,
      opportunity: true,
      appraisal: true,
    };
    assert.deepEqual((await fetchToday(created.agent.cookie)).firstRun, hiddenFromA);
    assert.deepEqual((await fetchToday(agentB.cookie)).firstRun, visible);
    assert.deepEqual((await fetchToday(created.admin.cookie)).firstRun, visible);
    assert.deepEqual((await fetchToday(pitCrew.cookie)).firstRun, visible);
    assert.deepEqual((await fetchToday(other.agent.cookie)).firstRun, NONE);

    const contactLevel = await post(agentB.cookie, "/grow/activities", {
      partyId,
      activityType: "note",
      summary: "Contact-level note.",
    });
    assert.equal(contactLevel.status, 201, await contactLevel.clone().text());
    const agentAAfter = await fetchToday(created.agent.cookie);
    assert.equal(agentAAfter.firstRun.activity, true, "a contact-level activity stays visible to every agent");
    assert.equal(agentAAfter.firstRun.propertyLink, false);
    assert.equal(agentAAfter.firstRun.appraisal, false);
    assert.deepEqual((await fetchToday(other.agent.cookie)).firstRun, NONE);
  } finally {
    await cleanupBrokerages([created.brokerageId, other.brokerageId]);
  }
});
