// FU-1 — an Agent sees and acts on unlinked Grow commitments and
// opportunities only when they own them. Property-linked rows keep the
// own-property rule (the property's agent sees them even when someone else
// created them). Brokerage Administrator and Pit Crew stay brokerage-wide,
// including contacts. Refusal is the same 404 the route already uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, growCommitments, growOpportunities, users } from "@aee/db";
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
const brokerageName = `FU1 Unlinked Grow ${suffix}`;

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let brokerageId: number;
let propertyAId: number;
let contactId: number;
let unlinkedOpportunityId: number;
let propertyOpportunityId: number;
let completeId: number;
let cancelId: number;
let rescheduleId: number;
let propertyCommitmentId: number;

const GROW_KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
] as const;

const UNLINKED_OPPORTUNITY_REASON = "renting out a unit";
const COMPLETE_DESCRIPTION = "Send a market update";
const CANCEL_DESCRIPTION = "Cancel me later";
const RESCHEDULE_DESCRIPTION = "Move my market update";
const PROPERTY_COMMITMENT_DESCRIPTION = "Call about the listing";
const PROPERTY_OPPORTUNITY_REASON = "Appraisal on A's property";

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

async function patchRaw(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "PATCH",
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

interface TodayBody {
  counts: { openOpportunities: number; followUpsDue: number };
  priorityActions: Array<{ id: string; propertyId: number | null; type: string }>;
  firstRun: { contact: boolean; commitment: boolean; opportunity: boolean };
}

interface Contact360 {
  contact: { id: number };
  opportunities: Array<{ id: number; propertyId: number | null; reason: string }>;
  commitments: Array<{ id: number; propertyId: number | null; description: string }>;
  timeline: Array<{ summary: string }>;
  intelligence: { activeOpportunityCount: number; outstandingCommitmentCount: number };
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
    email: `fu1-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `fu1-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };

  for (const key of GROW_KEYS) await grant(brokerageId, key);

  const property = await postRaw("/properties", agentA.cookie, {
    formattedAddress: `${suffix} Agent A St`,
    state: "QLD",
    suburb: "Paddington",
    postcode: "4064",
  });
  assert.equal(property.status, 201, await property.clone().text());
  propertyAId = ((await property.json()) as { property: { id: number } }).property.id;

  const contact = await postRaw("/grow/contacts", agentA.cookie, {
    firstName: "Lou",
    lastName: `Owner${suffix}`,
    email: `lou-${suffix}@example.com`,
  });
  assert.equal(contact.status, 201, await contact.clone().text());
  contactId = ((await contact.json()) as { contact: { id: number } }).contact.id;

  const due = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  completeId = await createCommitment(agentA.cookie, COMPLETE_DESCRIPTION, due, null);
  cancelId = await createCommitment(agentA.cookie, CANCEL_DESCRIPTION, due, null);
  rescheduleId = await createCommitment(agentA.cookie, RESCHEDULE_DESCRIPTION, due, null);
  propertyCommitmentId = await createCommitment(admin.cookie, PROPERTY_COMMITMENT_DESCRIPTION, due, propertyAId);

  const unlinkedOpportunity = await postRaw("/grow/opportunities", agentA.cookie, {
    partyId: contactId,
    opportunityType: "Other",
    reason: UNLINKED_OPPORTUNITY_REASON,
  });
  assert.equal(unlinkedOpportunity.status, 201, await unlinkedOpportunity.clone().text());
  unlinkedOpportunityId = ((await unlinkedOpportunity.json()) as { opportunity: { id: number; propertyId: number | null } }).opportunity.id;

  const propertyOpportunity = await postRaw("/grow/opportunities", admin.cookie, {
    partyId: contactId,
    propertyId: propertyAId,
    opportunityType: "Appraisal",
    reason: PROPERTY_OPPORTUNITY_REASON,
  });
  assert.equal(propertyOpportunity.status, 201, await propertyOpportunity.clone().text());
  propertyOpportunityId = ((await propertyOpportunity.json()) as { opportunity: { id: number } }).opportunity.id;
});

after(async () => {
  await cleanupBrokerages([brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

async function createCommitment(cookie: string, description: string, dueAt: string, propertyId: number | null): Promise<number> {
  const res = await postRaw(`/grow/contacts/${contactId}/commitments`, cookie, {
    description,
    dueAt,
    ...(propertyId === null ? {} : { propertyId }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { commitment: { id: number } }).commitment.id;
}

async function contact360(cookie: string): Promise<Contact360> {
  const res = await getRaw(`/grow/contacts/${contactId}`, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Contact360;
}

async function today(cookie: string): Promise<TodayBody> {
  const res = await getRaw("/grow/today", cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as TodayBody;
}

function idsOf(rows: Array<{ id: number }>): number[] {
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

test("Agent B cannot see or act on Agent A's unlinked commitments and opportunities; the owner, admin, and Pit Crew still can", async () => {
  const ownedOpportunityIds = [unlinkedOpportunityId, propertyOpportunityId].sort((a, b) => a - b);
  const ownedCommitmentIds = [completeId, cancelId, rescheduleId, propertyCommitmentId].sort((a, b) => a - b);
  const unlinkedCommitmentIds = [completeId, cancelId, rescheduleId];

  const listedB = await getRaw("/grow/opportunities", agentB.cookie);
  assert.equal(listedB.status, 200);
  const opportunitiesB = ((await listedB.json()) as { opportunities: Array<{ id: number }> }).opportunities;
  assert.deepEqual(idsOf(opportunitiesB), []);

  const viewB = await contact360(agentB.cookie);
  assert.equal(viewB.contact.id, contactId);
  assert.deepEqual(viewB.opportunities, []);
  assert.deepEqual(viewB.commitments, []);
  assert.equal(viewB.intelligence.activeOpportunityCount, 0);
  assert.equal(viewB.intelligence.outstandingCommitmentCount, 0);
  const timelineB = JSON.stringify(viewB.timeline);
  assert.equal(timelineB.includes(UNLINKED_OPPORTUNITY_REASON), false);
  assert.equal(timelineB.includes(COMPLETE_DESCRIPTION), false);
  assert.equal(timelineB.includes(PROPERTY_COMMITMENT_DESCRIPTION), false);

  const todayB = await today(agentB.cookie);
  const todayIdsB = todayB.priorityActions.map((card) => card.id);
  for (const id of [...unlinkedCommitmentIds, propertyCommitmentId]) {
    assert.equal(todayIdsB.includes(`commitment:${id}`), false);
  }
  assert.equal(todayIdsB.includes(`opportunity:${unlinkedOpportunityId}`), false);
  assert.equal(todayIdsB.includes(`opportunity:${propertyOpportunityId}`), false);
  assert.equal(todayB.counts.openOpportunities, 0);
  assert.equal(todayB.counts.followUpsDue, 0);
  assert.equal(todayB.firstRun.contact, true);
  assert.equal(todayB.firstRun.commitment, false);
  assert.equal(todayB.firstRun.opportunity, false);

  const overviewB = await getRaw("/grow/overview", agentB.cookie);
  assert.deepEqual(await overviewB.json(), { relationshipCount: 0, activityCount: 0, openOpportunityCount: 0 });

  const contactsB = await getRaw(`/grow/contacts?search=Owner${suffix}`, agentB.cookie);
  const contactRowsB = ((await contactsB.json()) as { contacts: Array<{ id: number }> }).contacts;
  assert.ok(contactRowsB.some((row) => row.id === contactId));

  const dueBefore = await db
    .select({ dueAt: growCommitments.dueAt, status: growCommitments.status })
    .from(growCommitments)
    .where(eq(growCommitments.id, rescheduleId));
  const completeAttempt = await patchRaw(`/grow/contacts/commitments/${completeId}`, agentB.cookie, { status: "Completed" });
  assert.equal(completeAttempt.status, 404);
  assert.deepEqual(await completeAttempt.json(), { error: "Commitment not found in this brokerage" });
  const cancelAttempt = await patchRaw(`/grow/contacts/commitments/${cancelId}`, agentB.cookie, { status: "Cancelled" });
  assert.equal(cancelAttempt.status, 404);
  assert.deepEqual(await cancelAttempt.json(), { error: "Commitment not found in this brokerage" });
  const rescheduleAttempt = await patchRaw(`/grow/contacts/commitments/${rescheduleId}`, agentB.cookie, {
    dueAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.equal(rescheduleAttempt.status, 404);
  assert.deepEqual(await rescheduleAttempt.json(), { error: "Commitment not found in this brokerage" });
  const editAttempt = await patchRaw(`/grow/opportunities/${unlinkedOpportunityId}`, agentB.cookie, {
    recommendedNextAction: "should not land",
  });
  assert.equal(editAttempt.status, 404);
  assert.deepEqual(await editAttempt.json(), { error: "Opportunity not found" });
  const fromOpportunity = await postRaw("/grow/appraisals/from-opportunity", agentB.cookie, {
    opportunityId: unlinkedOpportunityId,
  });
  assert.equal(fromOpportunity.status, 404);
  assert.deepEqual(await fromOpportunity.json(), { error: "Opportunity not found" });

  const stillOpen = await db
    .select({ id: growCommitments.id, status: growCommitments.status, dueAt: growCommitments.dueAt })
    .from(growCommitments)
    .where(and(eq(growCommitments.brokerageId, brokerageId)));
  for (const id of unlinkedCommitmentIds) {
    const row = stillOpen.find((item) => item.id === id);
    assert.equal(row?.status, "Open");
  }
  assert.equal(stillOpen.find((item) => item.id === rescheduleId)?.dueAt.toISOString(), dueBefore[0].dueAt.toISOString());
  const [opportunityStill] = await db
    .select({ recommendedNextAction: growOpportunities.recommendedNextAction })
    .from(growOpportunities)
    .where(eq(growOpportunities.id, unlinkedOpportunityId));
  assert.equal(opportunityStill.recommendedNextAction, null);

  for (const cookie of [agentA.cookie, admin.cookie, pitCrew.cookie]) {
    const listed = await getRaw("/grow/opportunities", cookie);
    const rows = ((await listed.json()) as { opportunities: Array<{ id: number }> }).opportunities;
    assert.deepEqual(idsOf(rows), ownedOpportunityIds);
    const view = await contact360(cookie);
    assert.deepEqual(idsOf(view.opportunities), ownedOpportunityIds);
    assert.deepEqual(idsOf(view.commitments), ownedCommitmentIds);
    assert.equal(view.intelligence.activeOpportunityCount, 2);
    assert.equal(view.intelligence.outstandingCommitmentCount, 4);
    const body = await today(cookie);
    const cardIds = body.priorityActions.map((card) => card.id);
    for (const id of ownedCommitmentIds) assert.ok(cardIds.includes(`commitment:${id}`));
    assert.ok(cardIds.includes(`opportunity:${unlinkedOpportunityId}`));
    assert.ok(cardIds.includes(`opportunity:${propertyOpportunityId}`));
    assert.equal(body.counts.openOpportunities, 2);
    assert.equal(body.counts.followUpsDue, 4);
    assert.equal(body.firstRun.commitment, true);
    assert.equal(body.firstRun.opportunity, true);
    const overview = await getRaw("/grow/overview", cookie);
    assert.equal(((await overview.json()) as { openOpportunityCount: number }).openOpportunityCount, 2);
  }

  const propertyCommitmentForA = (await contact360(agentA.cookie)).commitments.find((row) => row.id === propertyCommitmentId);
  assert.equal(propertyCommitmentForA?.propertyId, propertyAId);
  const propertyOpportunityForA = (await contact360(agentA.cookie)).opportunities.find((row) => row.id === propertyOpportunityId);
  assert.equal(propertyOpportunityForA?.propertyId, propertyAId);

  const contactsPit = await getRaw(`/grow/contacts?search=Owner${suffix}`, pitCrew.cookie);
  const contactRowsPit = ((await contactsPit.json()) as { contacts: Array<{ id: number }> }).contacts;
  assert.ok(contactRowsPit.some((row) => row.id === contactId));

  const completed = await patchRaw(`/grow/contacts/commitments/${completeId}`, agentA.cookie, { status: "Completed" });
  assert.equal(completed.status, 200, await completed.clone().text());
  assert.equal(((await completed.json()) as { commitment: { status: string } }).commitment.status, "Completed");

  const edited = await patchRaw(`/grow/opportunities/${unlinkedOpportunityId}`, agentA.cookie, {
    recommendedNextAction: "Call Lou",
  });
  assert.equal(edited.status, 200, await edited.clone().text());

  const cancelled = await patchRaw(`/grow/contacts/commitments/${cancelId}`, admin.cookie, {
    status: "Cancelled",
    cancelReason: "No longer needed",
  });
  assert.equal(cancelled.status, 200, await cancelled.clone().text());
  assert.equal(((await cancelled.json()) as { commitment: { status: string } }).commitment.status, "Cancelled");

  const adminEdit = await patchRaw(`/grow/opportunities/${unlinkedOpportunityId}`, admin.cookie, {
    recommendedNextAction: "Admin follow-up",
  });
  assert.equal(adminEdit.status, 200, await adminEdit.clone().text());

  const rescheduledTo = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
  const rescheduled = await patchRaw(`/grow/contacts/commitments/${rescheduleId}`, pitCrew.cookie, { dueAt: rescheduledTo });
  assert.equal(rescheduled.status, 200, await rescheduled.clone().text());
  const [moved] = await db.select({ dueAt: growCommitments.dueAt, status: growCommitments.status }).from(growCommitments).where(eq(growCommitments.id, rescheduleId));
  assert.equal(moved.status, "Open");
  assert.equal(moved.dueAt.toISOString(), new Date(rescheduledTo).toISOString());

  const todayBAfter = await today(agentB.cookie);
  assert.equal(todayBAfter.priorityActions.some((card) => card.id.startsWith("commitment:") || card.id.startsWith("opportunity:")), false);
  assert.equal(todayBAfter.counts.openOpportunities, 0);
  assert.equal(todayBAfter.firstRun.commitment, false);
  assert.equal(todayBAfter.firstRun.opportunity, false);
});
