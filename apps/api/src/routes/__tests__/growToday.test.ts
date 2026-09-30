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
import { db, auditLogs, entitlementGrants, growOpportunitySignals } from "@aee/db";
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
  await grant(A.brokerageId, "grow.properties.link");
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
  await grant(B.brokerageId, "grow.properties.link");
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

// ---------------------------------------------------------------------
// AE GROW PRIORITY 3 — additive communication-action metadata on Today's
// availableActions ("email"/"sms"/"view_contact"). None of the ranking/
// ordering/dedup tests above are touched — this is a new, independent
// test(...) block asserting only the new, additive availableActions
// entries and contactEmail/contactMobile fields growToday.ts now carries
// (see that file's own AE GROW PRIORITY 3 header comment).
// ---------------------------------------------------------------------

test("AE Grow Priority 3 — Today's availableActions include email/sms/view_contact only when the contact actually has that field on file", async () => {
  const propertyId = await createProperty(A.agent.cookie, "19 Contact Actions Way");
  const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const bothChannelsPartyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Ellie",
    lastName: "BothChannels",
    email: `ellie-both-${uniqueSuffix}@example.com`,
    mobile: "0400111222",
  });
  const bothChannelsOppId = await createOpportunity(A.agent.cookie, {
    partyId: bothChannelsPartyId,
    propertyId,
    opportunityType: "Appraisal",
    reason: "Wants an appraisal and is reachable by email and SMS.",
  });

  const noChannelsPartyId = await createParty(A.agent.cookie, propertyId, {
    firstName: "Noah",
    lastName: "NoChannels",
  });
  const noChannelsOppId = await createOpportunity(A.agent.cookie, {
    partyId: noChannelsPartyId,
    propertyId,
    opportunityType: "Appraisal",
    reason: "Wants an appraisal but has no email or mobile on file.",
  });

  const { status, body } = await fetchToday(A.agent.cookie);
  assert.equal(status, 200);

  const bothAction = body.priorityActions.find((a: any) => a.id === `opportunity:${bothChannelsOppId}`);
  assert.ok(bothAction, "the both-channels opportunity must be surfaced on Today");
  assert.equal(bothAction.partyId, bothChannelsPartyId);
  assert.equal(bothAction.contactEmail, `ellie-both-${uniqueSuffix}@example.com`);
  assert.equal(bothAction.contactMobile, "0400111222");
  assert.ok(bothAction.availableActions.some((b: any) => b.action === "email" && b.partyId === bothChannelsPartyId));
  assert.ok(bothAction.availableActions.some((b: any) => b.action === "sms" && b.partyId === bothChannelsPartyId));
  assert.ok(bothAction.availableActions.some((b: any) => b.action === "view_contact" && b.partyId === bothChannelsPartyId));

  const noChannelsAction = body.priorityActions.find((a: any) => a.id === `opportunity:${noChannelsOppId}`);
  assert.ok(noChannelsAction, "the no-channels opportunity must still be surfaced on Today");
  assert.equal(noChannelsAction.partyId, noChannelsPartyId);
  assert.equal(noChannelsAction.contactEmail, null);
  assert.equal(noChannelsAction.contactMobile, null);
  assert.ok(
    !noChannelsAction.availableActions.some((b: any) => b.action === "email"),
    "no email action button when the contact has no email on file",
  );
  assert.ok(
    !noChannelsAction.availableActions.some((b: any) => b.action === "sms"),
    "no sms action button when the contact has no mobile on file",
  );
  assert.ok(
    noChannelsAction.availableActions.some((b: any) => b.action === "view_contact" && b.partyId === noChannelsPartyId),
    "view_contact is unconditional — it only needs partyId, which every action already carries",
  );
});

// ---------------------------------------------------------------------
// AE GROW PRIORITY 5 REMEDIATION — Rule F. Grow Today surfaces a Property
// Intelligence signal (growOpportunitySignals) as its own card, gated
// behind grow.propertyIntelligence.read and only at or above the
// WorthReviewing confidence bar. Rows are seeded by a direct db.insert
// against growOpportunitySignals — this file tests growToday.ts's own Rule
// F wiring, not the Property Intelligence service/rule-engine itself (that
// has its own dedicated HTTP-integration coverage in
// routes/__tests__/propertyIntelligence.test.ts) — so it is deliberately
// agnostic to how a signal row came to exist.
//
// Every test(...) block above this one is untouched by Rule F's addition
// to growToday.ts (same assertions, same fixtures, same file) and is
// itself the primary regression evidence that Rules A-E behave exactly as
// they did before this remediation. The two tests below add explicit,
// Rule-F-specific regression coverage on top of that: proving the new rule
// is invisible without its entitlement, and that its presence does not
// change how Rule D treats an unrelated, lower-confidence signal.
// ---------------------------------------------------------------------

test("Rule F — invisible without grow.propertyIntelligence.read; once entitled, a StrongIndicator signal surfaces as its own DoToday card and suppresses the same contact's Rule D 'cold relationship' card", async () => {
  const propertyId = await createProperty(A.agent.cookie, "20 Rule F Signal St");
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Selena", lastName: "SignalOwner" });
  const relationshipId = await createRelationship(A.agent.cookie, { partyId, propertyId, relationshipType: "owner" });

  // No entitlement yet: Rule F must not run at all, so this Active
  // relationship (no activity ever recorded) surfaces through Rule D exactly
  // like every other cold-contact fixture earlier in this file.
  const beforeGrant = await fetchToday(A.agent.cookie);
  assert.equal(beforeGrant.status, 200, "grow.access alone must still serve /today with grow.propertyIntelligence.read absent");
  const coldCardBeforeGrant = beforeGrant.body.priorityActions.find((a: any) => a.id === `relationship:${relationshipId}`);
  assert.ok(coldCardBeforeGrant, "Rule D must surface this contact normally while Rule F is not yet entitled");
  assert.equal(coldCardBeforeGrant.reason, "No contact recorded yet.");
  assert.ok(
    !beforeGrant.body.priorityActions.some((a: any) => a.partyId === partyId && a.type === "property_intelligence_signal"),
    "no signal card can appear before the signal even exists",
  );

  const [signal] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId,
      propertyId,
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      explanation: "This contact has been recorded as the owner of this property for approximately 11 years.",
      evidence: { fixture: "ruleF-strong" },
      source: "internal",
      confidenceBand: "StrongIndicator",
      dedupeKey: `rule-f-test-${suffix}-strong`,
    })
    .returning();

  const stillBeforeGrant = await fetchToday(A.agent.cookie);
  assert.ok(
    !stillBeforeGrant.body.priorityActions.some((a: any) => a.id === `signal:${signal.id}`),
    "a real, qualifying signal must still not surface on Today without grow.propertyIntelligence.read",
  );
  const coldCardStillBeforeGrant = stillBeforeGrant.body.priorityActions.find((a: any) => a.id === `relationship:${relationshipId}`);
  assert.ok(coldCardStillBeforeGrant, "Rule D's card for this contact must be completely unaffected by an un-entitled signal existing");

  await grant(A.brokerageId, "grow.propertyIntelligence.read");

  const afterGrant = await fetchToday(A.agent.cookie);
  assert.equal(afterGrant.status, 200);
  const signalCard = afterGrant.body.priorityActions.find((a: any) => a.id === `signal:${signal.id}`);
  assert.ok(signalCard, "once entitled, the qualifying signal must surface as its own Today card");
  assert.equal(signalCard.type, "property_intelligence_signal");
  assert.equal(signalCard.priority, "DoToday");
  assert.equal(signalCard.partyId, partyId);
  assert.equal(signalCard.propertyId, propertyId);
  assert.equal(signalCard.contactName, "Selena SignalOwner");
  assert.equal(signalCard.reason, "This contact has been recorded as the owner of this property for approximately 11 years.");
  assert.equal(
    signalCard.recommendedAction,
    "Review this signal on the property or contact record to decide whether it's worth acting on.",
  );
  assert.equal(signalCard.opportunityId, null, "Rule F never creates or references a growOpportunities row on its own");
  assert.ok(
    signalCard.availableActions.some((b: any) => b.action === "view_property" && b.propertyId === propertyId),
    "the card must link back to the property review surface",
  );
  assert.ok(
    signalCard.availableActions.some((b: any) => b.action === "view_contact" && b.partyId === partyId),
    "the card must link back to the contact review surface",
  );
  assert.ok(!signalCard.availableActions.some((b: any) => b.action === "update_next_action"), "Rule F must never imply an opportunity exists to update");

  // Rule D's card for the same contact must now be gone -- superseded by the
  // more specific, concrete signal card, exactly like Rule E already
  // suppresses Rule D for an appraisal-follow-up contact.
  assert.ok(
    !afterGrant.body.priorityActions.some((a: any) => a.id === `relationship:${relationshipId}`),
    "Rule F suppresses the generic Rule D 'cold relationship' card for the same contact once it fires",
  );
  const cardsForSelena = afterGrant.body.priorityActions.filter((a: any) => a.partyId === partyId);
  assert.equal(cardsForSelena.length, 1, "the contact must still appear exactly once on Today, never twice");
});

test("Rule F — an Emerging-band signal DOES surface on Today (as the weakest Keep Warm item), and Rules A-E ranking/ordering is unaffected by Rule F cards being mixed in", async () => {
  // AE GROW "Brokerage-wide Signal Sweep" stage 3 — THIS TEST'S EXPECTATION
  // WAS DELIBERATELY INVERTED.
  //
  // It previously asserted that an Emerging-band signal "must never be
  // promoted onto Today, regardless of entitlement". That was the Priority 5
  // Remediation behaviour, and it is the wrong product: the strategy is
  // identifying and nurturing FUTURE SELLERS, including contacts with no
  // obvious current signal — which is precisely what the Emerging band is.
  // Filtering it left only a present-tense alert engine. Stage 3 surfaces the
  // band, ranked low, instead of discarding it. See lib/growToday.ts's
  // MAX_EMERGING_SIGNAL_ACTIONS comment.
  await grant(A.brokerageId, "grow.propertyIntelligence.read");

  const emergingPropertyId = await createProperty(A.agent.cookie, "21 Emerging Signal St");
  const emergingPartyId = await createParty(A.agent.cookie, emergingPropertyId, { firstName: "Emery", lastName: "Emerging" });
  const emergingRelationshipId = await createRelationship(A.agent.cookie, {
    partyId: emergingPartyId,
    propertyId: emergingPropertyId,
    relationshipType: "owner",
  });
  const [emergingSignal] = await db
    .insert(growOpportunitySignals)
    .values({
      brokerageId: A.brokerageId,
      partyId: emergingPartyId,
      propertyId: emergingPropertyId,
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      explanation: "Emerging-band fixture; stage 3 surfaces this as a quiet Keep Warm card.",
      evidence: { fixture: "ruleF-emerging", approximateTenureYears: 5 },
      source: "internal",
      confidenceBand: "Emerging",
      dedupeKey: `rule-f-test-${suffix}-emerging`,
    })
    .returning();

  // A fresh Do Now overdue-opportunity fixture, exactly like the very first
  // Rule A/B/C test in this file, run again here to prove the priority
  // ordering contract (DoNow, then DoToday, then KeepWarm) still holds with
  // Rule F cards mixed into the same list.
  const doNowPropertyId = await createProperty(A.agent.cookie, "22 Rule F Ordering Overdue St");
  const doNowPartyId = await createParty(A.agent.cookie, doNowPropertyId, { firstName: "Orson", lastName: "OverdueAgain" });
  const doNowOppId = await createOpportunity(A.agent.cookie, {
    partyId: doNowPartyId,
    propertyId: doNowPropertyId,
    opportunityType: "Listing",
    reason: "Second overdue fixture for Rule F ordering regression.",
  });
  await fetch(growUrl(`/opportunities/${doNowOppId}`), {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ nextActionDueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() }),
  });

  const { body } = await fetchToday(A.agent.cookie);

  const emergingCard = body.priorityActions.find((a: any) => a.id === `signal:${emergingSignal.id}`);
  assert.ok(emergingCard, "stage 3: an Emerging-band signal must surface — it is the future-seller population the strategy targets");
  assert.equal(emergingCard.type, "property_intelligence_signal");
  assert.equal(emergingCard.confidenceBand, "Emerging");
  assert.equal(emergingCard.priority, "KeepWarm", "an Emerging signal is surfaced quietly, never as urgent work");
  assert.ok(emergingCard.whyItMatters, "every surfaced signal must carry its explanation");
  assert.ok(body.signalSummary.emergingSurfaced >= 1);

  // Rule F still suppresses Rule D's generic nudge for the same contact — an
  // Emerging signal is a more specific reason than "no contact recorded".
  assert.ok(
    !body.priorityActions.some((a: any) => a.id === `relationship:${emergingRelationshipId}`),
    "a surfaced Rule F card still supersedes the same contact's generic Rule D card",
  );

  const doNowIndex = body.priorityActions.findIndex((a: any) => a.id === `opportunity:${doNowOppId}`);
  const keepWarmIndex = body.priorityActions.findIndex((a: any) => a.id === `signal:${emergingSignal.id}`);
  assert.ok(doNowIndex !== -1 && keepWarmIndex !== -1);
  assert.ok(doNowIndex < keepWarmIndex, "DoNow items must still sort ahead of KeepWarm items with Rule F in play");
  for (let i = 1; i < body.priorityActions.length; i++) {
    const priorityOrder: Record<string, number> = { DoNow: 0, DoToday: 1, KeepWarm: 2 };
    assert.ok(
      priorityOrder[body.priorityActions[i - 1].priority] <= priorityOrder[body.priorityActions[i].priority],
      "the full returned list must remain sorted by priority end to end",
    );
  }
});

test("Rule F — hasAnyGrowData reports true when a qualifying signal is the only reason a brokerage has anything to show today", async () => {
  const fresh = await createBrokerageWithUsers(baseUrl, `Grow Today Rule F Only ${suffix}`);
  try {
    await grant(fresh.brokerageId, "grow.access");
    await grant(fresh.brokerageId, "grow.propertyIntelligence.read");

    const emptyBefore = await fetchToday(fresh.agent.cookie);
    assert.equal(emptyBefore.status, 200);
    assert.equal(emptyBefore.body.hasAnyGrowData, false);

    const propertyId = await createProperty(fresh.agent.cookie, "1 Rule F Only St");
    const partyId = await createParty(fresh.agent.cookie, propertyId, { firstName: "Sam", lastName: "RuleFOnly" });
    const [signal] = await db
      .insert(growOpportunitySignals)
      .values({
        brokerageId: fresh.brokerageId,
        partyId,
        propertyId,
        signalType: "long_ownership_tenure",
        title: "Long ownership tenure",
        explanation: "The only actionable item this brokerage has today.",
        evidence: { fixture: "ruleF-only" },
        source: "internal",
        confidenceBand: "StrongIndicator",
        dedupeKey: `rule-f-test-${suffix}-only`,
      })
      .returning();

    const { status, body } = await fetchToday(fresh.agent.cookie);
    assert.equal(status, 200);
    assert.equal(
      body.hasAnyGrowData,
      true,
      "a real Rule F signal must count as 'this brokerage has Grow data', not fall through to the onboarding empty state",
    );
    assert.ok(body.priorityActions.some((a: any) => a.id === `signal:${signal.id}`));
  } finally {
    await cleanupBrokerages([fresh.brokerageId]);
  }
});
