// AE GROW Priority 1 — Daily Command Centre: permanent route-level HTTP
// regression coverage for GET /grow/today and PATCH /grow/opportunities/:id
// (apps/api/src/routes/grow.ts, apps/api/src/lib/growToday.ts). Mirrors
// grow.test.ts's own conventions (real HTTP through requireAuth and the real
// session cookie, sequential/narrative brokerage-A-accumulates-entitlements
// structure, brokerage B kept separately entitled for isolation checks) — a
// new file rather than an extension of grow.test.ts purely to keep this
// feature's fixtures (specific dates, specific opportunity/relationship
// shapes for each deterministic rule) self-contained and easy to read on
// their own.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, entitlementGrants } from "@aee/db";
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
const brokerageAName = `Grow Today A ${suffix}`;
const brokerageBName = `Grow Today B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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

  await grant(A.brokerageId, "grow.access");
  await grant(A.brokerageId, "grow.relationships.manage");
  await grant(A.brokerageId, "grow.activities.manage");
  await grant(A.brokerageId, "grow.opportunities.manage");
  await grant(B.brokerageId, "grow.access");
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
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

async function createRelationship(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/relationships"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create relationship failed: ${res.status} ${await res.text()}`);
  const { relationship } = (await res.json()) as { relationship: { id: number } };
  return relationship.id;
}

async function createActivity(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create activity failed: ${res.status} ${await res.text()}`);
}

async function createOpportunity(cookie: string, body: Record<string, unknown>) {
  const res = await fetch(growUrl("/opportunities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`create opportunity failed: ${res.status} ${await res.text()}`);
  const { opportunity } = (await res.json()) as { opportunity: { id: number } };
  return opportunity.id;
}

async function fetchToday(cookie: string) {
  const res = await fetch(growUrl("/today"), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as any };
}

test("unauthenticated requests to /today and PATCH /opportunities/:id are rejected", async () => {
  const todayRes = await fetch(growUrl("/today"));
  assert.equal(todayRes.status, 401);

  const patchRes = await fetch(growUrl("/opportunities/1"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nextActionDueAt: new Date().toISOString() }),
  });
  assert.equal(patchRes.status, 401);
});

test("GET /today requires grow.access, and is available with grow.access alone (no *.manage key needed)", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Today Unentitled ${suffix}`);
  try {
    const before_ = await fetch(growUrl("/today"), { headers: { cookie: fresh.agent.cookie } });
    assert.equal(before_.status, 403);

    await grant(fresh.brokerageId, "grow.access");
    const after_ = await fetch(growUrl("/today"), { headers: { cookie: fresh.agent.cookie } });
    assert.equal(
      after_.status,
      200,
      "grow.access alone (no relationships/activities/opportunities manage key) must be enough to read Today",
    );
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("a brand-new, entitled brokerage with zero Grow data gets the purposeful-empty-state signal, not an error", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Today Empty ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    const { status, body } = await fetchToday(fresh.agent.cookie);
    assert.equal(status, 200);
    assert.equal(body.hasAnyGrowData, false);
    assert.deepEqual(body.priorityActions, []);
    assert.deepEqual(body.counts, { priorityActions: 0, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 });
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});

test("an overdue opportunity next-action surfaces as Do Now with a human-readable reason, and counts as a follow-up due", async () => {
  const propertyId = await createProperty(A.agent.cookie, "10 Overdue Follow-Up St");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Olive", lastName: "Overdue" });
  const opportunityId = await createOpportunity(A.agent.cookie, {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Expressed interest in selling.",
  });

  const overdue = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const patchRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: overdue.toISOString(), recommendedNextAction: "Call Olive back." }),
  });
  assert.equal(patchRes.status, 200);

  const { status, body } = await fetchToday(A.agent.cookie);
  assert.equal(status, 200);
  const action = body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.ok(action, "overdue opportunity must appear in priorityActions");
  assert.equal(action.priority, "DoNow");
  assert.equal(action.contactName, "Olive Overdue");
  assert.equal(action.recommendedAction, "Call Olive back.");
  assert.match(action.reason, /Follow-up was due/);
  assert.equal(action.propertyId, propertyId);
  assert.ok(action.availableActions.some((b: any) => b.action === "update_next_action" && b.opportunityId === opportunityId));
  assert.ok(action.availableActions.some((b: any) => b.action === "view_property" && b.propertyId === propertyId));
  assert.ok(action.availableActions.some((b: any) => b.action === "add_note"));
  assert.ok(action.availableActions.some((b: any) => b.action === "ask_ae"));
  assert.ok(body.counts.followUpsDue >= 1);
});

test("an opportunity next-action due today surfaces as Do Today", async () => {
  const propertyId = await createProperty(A.agent.cookie, "11 Due Today Ave");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Dana", lastName: "DueToday" });
  const opportunityId = await createOpportunity(A.agent.cookie, {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Requested a market update.",
  });

  await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: new Date().toISOString() }),
  });

  const { body } = await fetchToday(A.agent.cookie);
  const action = body.priorityActions.find((a: any) => a.id === `opportunity:${opportunityId}`);
  assert.ok(action);
  assert.equal(action.priority, "DoToday");
  assert.equal(action.reason, "Follow-up is due today.");
});

test("an opportunity next-action due in the future is not surfaced on Today at all, but still counts toward Open Opportunities", async () => {
  const propertyId = await createProperty(A.agent.cookie, "12 Future Follow-Up Rd");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Frankie", lastName: "Future" });
  const opportunityId = await createOpportunity(A.agent.cookie, {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Wants to sell next year.",
  });

  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: future.toISOString() }),
  });

  const { body } = await fetchToday(A.agent.cookie);
  assert.ok(!body.priorityActions.some((a: any) => a.id === `opportunity:${opportunityId}`));
  assert.ok(body.counts.openOpportunities >= 1);
});

test("a new Appraisal opportunity with no next action set defaults to Do Today; a non-Appraisal type with no next action defaults to Keep Warm", async () => {
  const propertyId = await createProperty(A.agent.cookie, "13 Appraisal Close");
  const appraisalPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Ana", lastName: "Appraisal" });
  const appraisalOppId = await createOpportunity(A.agent.cookie, {
    partyId: appraisalPartyId,
    propertyId,
    opportunityType: "Appraisal",
    reason: "Enquired about a market appraisal.",
  });

  const otherPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Otto", lastName: "Other" });
  const otherOppId = await createOpportunity(A.agent.cookie, {
    partyId: otherPartyId,
    propertyId,
    opportunityType: "PropertyManagement",
    reason: "Asked about property management.",
  });

  const { body } = await fetchToday(A.agent.cookie);
  const appraisalAction = body.priorityActions.find((a: any) => a.id === `opportunity:${appraisalOppId}`);
  const otherAction = body.priorityActions.find((a: any) => a.id === `opportunity:${otherOppId}`);
  assert.ok(appraisalAction);
  assert.equal(appraisalAction.priority, "DoToday");
  assert.ok(otherAction);
  assert.equal(otherAction.priority, "KeepWarm");
});

test("an Active relationship with no contact ever recorded surfaces as Keep Warm; one contacted recently does not appear at all", async () => {
  const propertyId = await createProperty(A.agent.cookie, "14 Cold Contact Way");
  const neverContactedPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Nora", lastName: "NeverContacted" });
  await createRelationship(A.agent.cookie, { partyId: neverContactedPartyId, propertyId, relationshipType: "owner" });

  const recentlyContactedPartyId = await createParty(A.agent.cookie, propertyId, { firstName: "Rex", lastName: "RecentlyContacted" });
  await createRelationship(A.agent.cookie, { partyId: recentlyContactedPartyId, propertyId, relationshipType: "owner" });
  await createActivity(A.agent.cookie, {
    partyId: recentlyContactedPartyId,
    propertyId,
    activityType: "call",
    summary: "Quick check-in call.",
    occurredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const { body } = await fetchToday(A.agent.cookie);
  const neverAction = body.priorityActions.find((a: any) => a.partyId === neverContactedPartyId);
  assert.ok(neverAction, "a party with an Active relationship and zero recorded activity must be surfaced");
  assert.equal(neverAction.priority, "KeepWarm");
  assert.equal(neverAction.reason, "No contact recorded yet.");
  assert.equal(neverAction.relationshipType, "owner");

  const recentAction = body.priorityActions.find((a: any) => a.partyId === recentlyContactedPartyId);
  assert.equal(recentAction, undefined, "a party contacted well within the cold-contact threshold must not be surfaced");
});

test("an Active relationship with contact recorded 30 days ago surfaces as Keep Warm with the day count in the reason", async () => {
  const propertyId = await createProperty(A.agent.cookie, "15 Long Overdue Contact Rd");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Wanda", lastName: "WentCold" });
  await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "prospective_seller" });
  await createActivity(A.agent.cookie, {
    partyId,
    propertyId,
    activityType: "email",
    summary: "Sent a market update email.",
    occurredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  });

  const { body } = await fetchToday(A.agent.cookie);
  const action = body.priorityActions.find((a: any) => a.partyId === partyId);
  assert.ok(action);
  assert.equal(action.priority, "KeepWarm");
  assert.match(action.reason, /No contact recorded for \d+ days\./);
});

test("a party with both an open opportunity and a cold Active relationship only produces one Today card, not two", async () => {
  const propertyId = await createProperty(A.agent.cookie, "16 One Card Per Person Cl");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Uma", lastName: "Unified" });
  await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "prospective_seller" });
  await createOpportunity(A.agent.cookie, {
    partyId,
    propertyId,
    opportunityType: "Appraisal",
    reason: "Follow-up appraisal opportunity.",
  });

  const { body } = await fetchToday(A.agent.cookie);
  const cardsForParty = body.priorityActions.filter((a: any) => a.partyId === partyId);
  assert.equal(cardsForParty.length, 1, "a contact must never appear twice on Today for the same day's data");
  assert.equal(cardsForParty[0].type, "opportunity_no_action_set");
});

test("GET /today never returns another brokerage's contacts, opportunities, or counts", async () => {
  const bPropertyId = await createProperty(B.agent.cookie, "17 Cross Tenant Today Ave");
  const bPartyId = await createParty(B.agent.cookie, bPropertyId, { firstName: "Bianca", lastName: "BrokerageB" });
  await grant(B.brokerageId, "grow.relationships.manage");
  await createRelationship(B.agent.cookie, { partyId: bPartyId, propertyId: bPropertyId, relationshipType: "owner" });

  const { body: aBody } = await fetchToday(A.agent.cookie);
  assert.ok(!aBody.priorityActions.some((a: any) => a.partyId === bPartyId), "Brokerage A's Today must never include Brokerage B's contact");

  const { body: bBody } = await fetchToday(B.agent.cookie);
  const bAction = bBody.priorityActions.find((a: any) => a.partyId === bPartyId);
  assert.ok(bAction, "Brokerage B's own newly-created cold contact must appear in its own Today");
  assert.equal(bAction.contactName, "Bianca BrokerageB");
});

test("PATCH /opportunities/:id requires grow.opportunities.manage, validates input, enforces tenant isolation, and writes an audit log entry", async () => {
  const propertyId = await createProperty(A.agent.cookie, "18 Patch Validation St");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Pat", lastName: "Patchable" });
  const opportunityId = await createOpportunity(A.agent.cookie, {
    partyId,
    propertyId,
    opportunityType: "Listing",
    reason: "Testing PATCH.",
  });

  // Brokerage B genuinely lacks grow.opportunities.manage at this point in the file — proves the
  // route requires its own entitlement, not just grow.access.
  const forbiddenRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ recommendedNextAction: "Should be blocked" }),
  });
  assert.equal(forbiddenRes.status, 403);

  const missingBodyRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(missingBodyRes.status, 400);

  const badDateRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: "not-a-date" }),
  });
  assert.equal(badDateRes.status, 400);

  await grant(B.brokerageId, "grow.opportunities.manage");
  const crossTenantRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ recommendedNextAction: "Cross tenant, now entitled" }),
  });
  assert.equal(
    crossTenantRes.status,
    404,
    "Brokerage B must never be able to patch Brokerage A's opportunity, even once B holds the entitlement",
  );

  const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const okRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: dueAt.toISOString(), recommendedNextAction: "Send updated appraisal pack." }),
  });
  const okBody = (await okRes.json()) as { opportunity: { id: number; nextActionDueAt: string; recommendedNextAction: string } };
  assert.equal(okRes.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.opportunity.recommendedNextAction, "Send updated appraisal pack.");
  assert.equal(new Date(okBody.opportunity.nextActionDueAt).toISOString(), dueAt.toISOString());

  const clearRes = await fetch(growUrl(`/opportunities/${opportunityId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: null }),
  });
  const clearBody = (await clearRes.json()) as { opportunity: { nextActionDueAt: string | null } };
  assert.equal(clearRes.status, 200);
  assert.equal(clearBody.opportunity.nextActionDueAt, null, "nextActionDueAt must be explicitly clearable, not just settable");

  const auditRows = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "grow_opportunity"), eq(auditLogs.recordId, String(opportunityId))));
  assert.ok(auditRows.length > 0, "every successful PATCH must leave a real audit_logs row, not a silent update");
  assert.equal(auditRows[auditRows.length - 1].action, "grow_opportunity_next_action_updated");
});
