// UAT-V3 — an Agent cannot write Grow rows against another Agent's property,
// and cannot mutate a row already tied to one. The refusal is the same 404
// that route already uses for a missing or cross-tenant id. Contact-level
// rows (null property) stay writable. Brokerage Administrator and Pit Crew
// stay brokerage-wide. Ask AE context uses the same own-property set.
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  aiActionRequests,
  appraisals,
  entitlementGrants,
  growActivities,
  growCommitments,
  growOpportunities,
  growOpportunitySignals,
  growRelationships,
  users,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { restrictedPropertyIdsFor } from "../../lib/propertyVisibility.js";
import { buildGrowContext } from "../../lib/ai/context/growContext.js";
import { buildBusinessCoachContext } from "../../lib/ai/context/businessCoachContext.js";
import { createApprovedGrowCommitment, GrowCommitmentValidationError } from "../../lib/growCommitmentActions.js";
import { proposeMatch } from "../../lib/propertyIntelligence/matches.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `UAT-V3 Grow Writes ${suffix}`;

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let other: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let brokerageId: number;
let propertyAId: number;
let propertyBId: number;
let foreignPropertyId: number;
let sharedContactId: number;
let relationshipBId: number;
let opportunityAId: number;
let opportunityBId: number;
let commitmentBId: number;
let commitmentBCancelId: number;
let appraisalAId: number;
let appraisalBId: number;
let matchBId: number;
let signalBId: number;
let signalContactId: number;

const GROW_KEYS = [
  "grow.access",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.relationships.manage",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.propertyIntelligence.read",
  "grow.propertyIntelligence.manage",
  "run.access",
] as const;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: headers(cookie, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const res = await send("POST", "/properties", cookie, {
    formattedAddress: address,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { property: { id: number } };
  return body.property.id;
}

describe("UAT-V3 grow write visibility", { concurrency: 1 }, () => {
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
      email: `uatv3-agent-b-${suffix}@example.com`,
      firstName: "Agent",
      lastName: "Bee",
      brokerageName,
    });
    pitCrew = await devLogin(baseUrl, {
      email: `uatv3-pit-${suffix}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
    pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };
    other = await createBrokerageWithUsers(baseUrl, `UAT-V3 Grow Writes Other ${suffix}`);

    for (const id of [brokerageId, other.brokerageId]) {
      for (const key of GROW_KEYS) await grant(id, key);
    }

    propertyAId = await createProperty(agentA.cookie, `${suffix} Agent A St`);
    propertyBId = await createProperty(agentB.cookie, `${suffix} Agent B St`);
    foreignPropertyId = await createProperty(other.agent.cookie, `${suffix} Foreign St`);

    const contact = await send("POST", "/grow/contacts", agentA.cookie, {
      firstName: "Shared",
      lastName: `Contact${suffix}`,
      email: `shared-v3-${suffix}@example.com`,
    });
    assert.equal(contact.status, 201, await contact.clone().text());
    sharedContactId = ((await contact.json()) as { contact: { id: number } }).contact.id;

    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    const relationshipA = await send("POST", "/grow/relationships", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyAId,
      relationshipType: "owner",
    });
    assert.equal(relationshipA.status, 201, await relationshipA.clone().text());
    const relationshipB = await send("POST", "/grow/relationships", agentB.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      relationshipType: "landlord",
    });
    assert.equal(relationshipB.status, 201, await relationshipB.clone().text());
    relationshipBId = ((await relationshipB.json()) as { relationship: { id: number } }).relationship.id;
    const contactRelationship = await send("POST", "/grow/relationships", agentA.cookie, {
      partyId: sharedContactId,
      relationshipType: "prospect",
    });
    assert.equal(contactRelationship.status, 201, await contactRelationship.clone().text());

    for (const [cookie, propertyId, summary] of [
      [agentA.cookie, propertyAId, "A property note"],
      [agentB.cookie, propertyBId, "B property note"],
    ] as const) {
      const activity = await send("POST", "/grow/activities", cookie, {
        partyId: sharedContactId,
        propertyId,
        activityType: "note",
        summary,
      });
      assert.equal(activity.status, 201, await activity.clone().text());
    }
    const contactActivity = await send("POST", "/grow/activities", agentA.cookie, {
      partyId: sharedContactId,
      activityType: "note",
      summary: "Contact-only note",
    });
    assert.equal(contactActivity.status, 201, await contactActivity.clone().text());

    const opportunityA = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyAId,
      opportunityType: "Appraisal",
      reason: "A property opportunity",
    });
    assert.equal(opportunityA.status, 201, await opportunityA.clone().text());
    opportunityAId = ((await opportunityA.json()) as { opportunity: { id: number } }).opportunity.id;
    const opportunityB = await send("POST", "/grow/opportunities", agentB.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      opportunityType: "Appraisal",
      reason: "B property opportunity",
    });
    assert.equal(opportunityB.status, 201, await opportunityB.clone().text());
    opportunityBId = ((await opportunityB.json()) as { opportunity: { id: number } }).opportunity.id;
    const contactOpportunity = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      opportunityType: "General",
      reason: "Contact-only opportunity",
    });
    assert.equal(contactOpportunity.status, 201, await contactOpportunity.clone().text());

    const commitmentA = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
      description: "A property promise",
      dueAt: past,
      propertyId: propertyAId,
    });
    assert.equal(commitmentA.status, 201, await commitmentA.clone().text());
    const commitmentB = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentB.cookie, {
      description: "B property promise",
      dueAt: past,
      propertyId: propertyBId,
    });
    assert.equal(commitmentB.status, 201, await commitmentB.clone().text());
    commitmentBId = ((await commitmentB.json()) as { commitment: { id: number } }).commitment.id;
    const commitmentBCancel = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentB.cookie, {
      description: "B property promise to cancel",
      dueAt: past,
      propertyId: propertyBId,
    });
    assert.equal(commitmentBCancel.status, 201, await commitmentBCancel.clone().text());
    commitmentBCancelId = ((await commitmentBCancel.json()) as { commitment: { id: number } }).commitment.id;
    const contactCommitment = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
      description: "Contact-only promise",
      dueAt: past,
    });
    assert.equal(contactCommitment.status, 201, await contactCommitment.clone().text());

    for (const [cookie, propertyId, slot] of [
      [agentA.cookie, propertyAId, "A"],
      [agentB.cookie, propertyBId, "B"],
    ] as const) {
      const appraisal = await send("POST", "/grow/appraisals/from-contact", cookie, {
        partyId: sharedContactId,
        propertyId,
      });
      assert.equal(appraisal.status, 201, await appraisal.clone().text());
      const appraisalId = ((await appraisal.json()) as { appraisal: { id: number } }).appraisal.id;
      if (slot === "A") appraisalAId = appraisalId;
      else appraisalBId = appraisalId;
      await db
        .update(appraisals)
        .set({
          status: "FOLLOW_UP",
          followUpAt: new Date(past),
          pricingCommentary: "untouched",
        })
        .where(eq(appraisals.id, appraisalId));
    }

    const match = await proposeMatch({
      brokerageId,
      propertyId: propertyBId,
      provider: "mock",
      externalId: `uat-v3-${suffix}-match`,
    });
    matchBId = match.id;
    const [signalB] = await db
      .insert(growOpportunitySignals)
      .values({
        brokerageId,
        partyId: sharedContactId,
        propertyId: propertyBId,
        signalType: "long_ownership_tenure",
        title: "B property signal",
        explanation: "Fixture",
        evidence: { factors: [] },
        source: "internal",
        confidenceBand: "WorthReviewing",
        status: "Active",
        dedupeKey: `uat-v3-${suffix}-b`,
      })
      .returning({ id: growOpportunitySignals.id });
    signalBId = signalB.id;
    const [signalContact] = await db
      .insert(growOpportunitySignals)
      .values({
        brokerageId,
        partyId: sharedContactId,
        propertyId: null,
        signalType: "long_ownership_tenure",
        title: "Contact signal",
        explanation: "Fixture",
        evidence: { factors: [] },
        source: "internal",
        confidenceBand: "WorthReviewing",
        status: "Active",
        dedupeKey: `uat-v3-${suffix}-contact`,
      })
      .returning({ id: growOpportunitySignals.id });
    signalContactId = signalContact.id;
  });

  after(async () => {
    await cleanupBrokerages([brokerageId, other?.brokerageId]);
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("Ask AE context for an Agent omits another Agent's property-linked Grow rows; admin keeps them", async () => {
    const restrictA = await restrictedPropertyIdsFor({
      id: agentA.user.id,
      role: "Agent",
      brokerageId,
    });
    const restrictAdmin = await restrictedPropertyIdsFor({
      id: admin.user.id,
      role: "Brokerage Administrator",
      brokerageId,
    });
    assert.equal(restrictAdmin, null);
    assert.ok(restrictA?.includes(propertyAId));
    assert.ok(!restrictA?.includes(propertyBId));

    const ctxA = await buildGrowContext(brokerageId, null, restrictA);
    const ctxAdmin = await buildGrowContext(brokerageId, null, restrictAdmin);

    const propertyIdsOf = (rows: Array<{ propertyId: number | null }>) => rows.map((row) => row.propertyId);
    assert.ok(!propertyIdsOf(ctxA.todayItems).includes(propertyBId));
    assert.ok(propertyIdsOf(ctxA.todayItems).includes(propertyAId));
    assert.ok(propertyIdsOf(ctxA.todayItems).includes(null));
    assert.ok(propertyIdsOf(ctxAdmin.todayItems).includes(propertyAId));
    assert.ok(propertyIdsOf(ctxAdmin.todayItems).includes(propertyBId));
    assert.ok(propertyIdsOf(ctxAdmin.todayItems).includes(null));

    assert.ok(ctxA.recentActivity.some((row) => row.summary === "A property note"));
    assert.ok(ctxA.recentActivity.some((row) => row.summary === "Contact-only note"));
    assert.ok(!ctxA.recentActivity.some((row) => row.summary === "B property note"));
    assert.ok(ctxAdmin.recentActivity.some((row) => row.summary === "B property note"));

    assert.ok(ctxA.dueCommitments.some((row) => row.description === "A property promise"));
    assert.ok(ctxA.dueCommitments.some((row) => row.description === "Contact-only promise"));
    assert.ok(!ctxA.dueCommitments.some((row) => row.description === "B property promise"));
    assert.ok(ctxAdmin.dueCommitments.some((row) => row.description === "B property promise"));

    assert.ok(!ctxA.relationshipBreakdown.some((row) => row.relationshipType === "landlord"));
    assert.ok(ctxA.relationshipBreakdown.some((row) => row.relationshipType === "prospect"));
    assert.ok(ctxAdmin.relationshipBreakdown.some((row) => row.relationshipType === "landlord"));

    const agentOpen = ctxA.opportunityPipeline.reduce((sum, row) => sum + row.count, 0);
    const adminOpen = ctxAdmin.opportunityPipeline.reduce((sum, row) => sum + row.count, 0);
    assert.equal(agentOpen, 2);
    assert.equal(adminOpen, 3);

    const coachA = await buildBusinessCoachContext(brokerageId, ctxA, {
      period: "last7days",
      restrictToPropertyIds: restrictA,
    });
    const coachAdmin = await buildBusinessCoachContext(brokerageId, ctxAdmin, {
      period: "last7days",
      restrictToPropertyIds: null,
    });
    assert.equal(coachA.opportunities.openCount, 2);
    assert.equal(coachAdmin.opportunities.openCount, 3);
    assert.ok(coachAdmin.relationships.totalActiveRelationships > coachA.relationships.totalActiveRelationships);
  });

  test("an Agent is refused on another Agent's property and still writes their own and contact-level rows", async () => {
    const hiddenRelationship = await send("POST", "/grow/relationships", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      relationshipType: "owner",
    });
    assert.equal(hiddenRelationship.status, 404);
    assert.deepEqual(await hiddenRelationship.json(), { error: "Property not found in this brokerage" });

    const patchRelationship = await send("PATCH", `/grow/relationships/${relationshipBId}`, agentA.cookie, {
      status: "Historical",
    });
    assert.equal(patchRelationship.status, 404);
    assert.deepEqual(await patchRelationship.json(), { error: "Relationship not found" });
    const [relationshipStill] = await db
      .select({ status: growRelationships.status })
      .from(growRelationships)
      .where(eq(growRelationships.id, relationshipBId));
    assert.equal(relationshipStill.status, "Active");

    const ownRelationship = await send("POST", "/grow/relationships", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyAId,
      relationshipType: "owner",
    });
    assert.equal(ownRelationship.status, 201, await ownRelationship.clone().text());
    const contactRelationship = await send("POST", "/grow/relationships", agentA.cookie, {
      partyId: sharedContactId,
      relationshipType: "prospect",
    });
    assert.equal(contactRelationship.status, 201, await contactRelationship.clone().text());
    assert.equal(
      ((await contactRelationship.json()) as { relationship: { propertyId: number | null } }).relationship.propertyId,
      null,
    );

    const hiddenActivity = await send("POST", "/grow/activities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      activityType: "note",
      summary: "should not land",
    });
    assert.equal(hiddenActivity.status, 404);
    assert.deepEqual(await hiddenActivity.json(), { error: "Property not found in this brokerage" });
    const ownActivity = await send("POST", "/grow/activities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyAId,
      activityType: "note",
      summary: "A second note",
    });
    assert.equal(ownActivity.status, 201, await ownActivity.clone().text());
    const contactActivity = await send("POST", "/grow/activities", agentA.cookie, {
      partyId: sharedContactId,
      activityType: "note",
      summary: "Another contact-only note",
    });
    assert.equal(contactActivity.status, 201, await contactActivity.clone().text());

    const hiddenOpportunity = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      opportunityType: "Appraisal",
      reason: "should not land",
    });
    assert.equal(hiddenOpportunity.status, 404);
    assert.deepEqual(await hiddenOpportunity.json(), { error: "Property not found in this brokerage" });
    const foreignOpportunity = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: foreignPropertyId,
      opportunityType: "Appraisal",
      reason: "foreign property",
    });
    assert.equal(foreignOpportunity.status, 404);
    assert.deepEqual(await foreignOpportunity.json(), { error: "Property not found in this brokerage" });
    const foreignRows = await db
      .select({ id: growOpportunities.id })
      .from(growOpportunities)
      .where(eq(growOpportunities.propertyId, foreignPropertyId));
    assert.equal(foreignRows.length, 0);

    const ownOpportunity = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyAId,
      opportunityType: "Appraisal",
      reason: "A second opportunity",
    });
    assert.equal(ownOpportunity.status, 201, await ownOpportunity.clone().text());
    const contactOpportunity = await send("POST", "/grow/opportunities", agentA.cookie, {
      partyId: sharedContactId,
      opportunityType: "General",
      reason: "Another contact-only opportunity",
    });
    assert.equal(contactOpportunity.status, 201, await contactOpportunity.clone().text());

    const patchOpportunity = await send("PATCH", `/grow/opportunities/${opportunityBId}`, agentA.cookie, {
      recommendedNextAction: "should not land",
    });
    assert.equal(patchOpportunity.status, 404);
    assert.deepEqual(await patchOpportunity.json(), { error: "Opportunity not found" });
    const [opportunityStill] = await db
      .select({ recommendedNextAction: growOpportunities.recommendedNextAction })
      .from(growOpportunities)
      .where(eq(growOpportunities.id, opportunityBId));
    assert.equal(opportunityStill.recommendedNextAction, null);
    const patchOwn = await send("PATCH", `/grow/opportunities/${opportunityAId}`, agentA.cookie, {
      recommendedNextAction: "Call them",
    });
    assert.equal(patchOwn.status, 200, await patchOwn.clone().text());

    const hiddenCommitment = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
      description: "should not land",
      dueAt: new Date().toISOString(),
      propertyId: propertyBId,
    });
    assert.equal(hiddenCommitment.status, 404);
    assert.deepEqual(await hiddenCommitment.json(), { error: "Property not found in this brokerage" });
    const contactCommitment = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
      description: "Another contact-only promise",
      dueAt: new Date().toISOString(),
    });
    assert.equal(contactCommitment.status, 201, await contactCommitment.clone().text());
    const ownCommitment = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, agentA.cookie, {
      description: "A second property promise",
      dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      propertyId: propertyAId,
    });
    assert.equal(ownCommitment.status, 201, await ownCommitment.clone().text());
    const ownCommitmentId = ((await ownCommitment.json()) as { commitment: { id: number } }).commitment.id;

    const completeHidden = await send("PATCH", `/grow/contacts/commitments/${commitmentBId}`, agentA.cookie, {
      status: "Completed",
    });
    assert.equal(completeHidden.status, 404);
    assert.deepEqual(await completeHidden.json(), { error: "Commitment not found in this brokerage" });
    const cancelHidden = await send("PATCH", `/grow/contacts/commitments/${commitmentBCancelId}`, agentA.cookie, {
      status: "Cancelled",
      cancelReason: "should not land",
    });
    assert.equal(cancelHidden.status, 404);
    assert.deepEqual(await cancelHidden.json(), { error: "Commitment not found in this brokerage" });
    const stillOpen = await db
      .select({ id: growCommitments.id, status: growCommitments.status })
      .from(growCommitments)
      .where(and(eq(growCommitments.brokerageId, brokerageId), eq(growCommitments.propertyId, propertyBId)));
    assert.ok(stillOpen.every((row) => row.status === "Open"));
    const completionsBefore = await db
      .select({ id: growActivities.id })
      .from(growActivities)
      .where(and(eq(growActivities.brokerageId, brokerageId), eq(growActivities.activityType, "task_completion")));
    assert.equal(completionsBefore.length, 0);

    const completeOwn = await send("PATCH", `/grow/contacts/commitments/${ownCommitmentId}`, agentA.cookie, {
      status: "Completed",
    });
    assert.equal(completeOwn.status, 200, await completeOwn.clone().text());
    const completionsAfter = await db
      .select({ propertyId: growActivities.propertyId, summary: growActivities.summary })
      .from(growActivities)
      .where(and(eq(growActivities.brokerageId, brokerageId), eq(growActivities.activityType, "task_completion")));
    assert.equal(completionsAfter.length, 1);
    assert.equal(completionsAfter[0].propertyId, propertyAId);

    const hiddenFromContact = await send("POST", "/grow/appraisals/from-contact", agentA.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
    });
    assert.equal(hiddenFromContact.status, 404);
    assert.deepEqual(await hiddenFromContact.json(), { error: "Property not found" });
    const hiddenFromOpportunity = await send("POST", "/grow/appraisals/from-opportunity", agentA.cookie, {
      opportunityId: opportunityBId,
    });
    assert.equal(hiddenFromOpportunity.status, 404);
    assert.deepEqual(await hiddenFromOpportunity.json(), { error: "Opportunity not found" });
    const ownFromOpportunity = await send("POST", "/grow/appraisals/from-opportunity", agentA.cookie, {
      opportunityId: opportunityAId,
    });
    assert.equal(ownFromOpportunity.status, 201, await ownFromOpportunity.clone().text());

    const hiddenMutations: Array<{ method: string; suffix: string; body?: unknown }> = [
      { method: "PATCH", suffix: "", body: { pricingCommentary: "changed" } },
      { method: "POST", suffix: "/status", body: { toStatus: "PREPARING" } },
      { method: "POST", suffix: "/outcome", body: { outcome: "LOST" } },
      { method: "POST", suffix: "/follow-up", body: { followUpAt: new Date().toISOString() } },
      { method: "POST", suffix: "/send", body: {} },
      { method: "POST", suffix: "/market-position/generate" },
      { method: "POST", suffix: "/presentation/generate" },
      { method: "POST", suffix: "/run-handoff" },
      { method: "POST", suffix: "/comparable-sales", body: { address: "1 Hidden St" } },
      { method: "PATCH", suffix: "/comparable-sales/1", body: { address: "1 Hidden St" } },
      { method: "DELETE", suffix: "/comparable-sales/1" },
      { method: "POST", suffix: "/market-competition", body: { address: "1 Hidden St" } },
      { method: "PATCH", suffix: "/market-competition/1", body: { address: "1 Hidden St" } },
      { method: "DELETE", suffix: "/market-competition/1" },
    ];
    for (const mutation of hiddenMutations) {
      const res = await send(mutation.method, `/grow/appraisals/${appraisalBId}${mutation.suffix}`, agentA.cookie, mutation.body);
      assert.equal(res.status, 404, `${mutation.method} ${mutation.suffix}: ${await res.clone().text()}`);
      assert.deepEqual(await res.json(), { error: "Appraisal not found" });
    }
    const [appraisalStill] = await db
      .select({ status: appraisals.status, pricingCommentary: appraisals.pricingCommentary })
      .from(appraisals)
      .where(eq(appraisals.id, appraisalBId));
    assert.equal(appraisalStill.status, "FOLLOW_UP");
    assert.equal(appraisalStill.pricingCommentary, "untouched");

    const ownAppraisal = await send("PATCH", `/grow/appraisals/${appraisalAId}`, agentA.cookie, {
      pricingCommentary: "Agent A update",
    });
    assert.equal(ownAppraisal.status, 200, await ownAppraisal.clone().text());

    for (const suffix of ["/start", "", "/finalise"] as const) {
      const res = await send("POST", `/appraisals/by-property/${propertyBId}${suffix}`, agentA.cookie, suffix === "" ? {} : undefined);
      assert.equal(res.status, 404, `POST /appraisals/by-property/${suffix || "(update)"}: ${await res.clone().text()}`);
      assert.deepEqual(await res.json(), { error: "Not found" });
    }
    const ownStart = await send("POST", `/appraisals/by-property/${propertyAId}/start`, agentA.cookie);
    assert.ok(ownStart.status === 200 || ownStart.status === 201, await ownStart.clone().text());
    const ownUpdate = await send("POST", `/appraisals/by-property/${propertyAId}`, agentA.cookie, {
      priceRangeLow: "500000",
      priceRangeHigh: "600000",
    });
    assert.equal(ownUpdate.status, 200, await ownUpdate.clone().text());

    const confirm = await send("POST", `/grow/property-intelligence/matches/${matchBId}/confirm`, agentA.cookie);
    assert.equal(confirm.status, 404);
    assert.deepEqual(await confirm.json(), { error: "Match not found" });
    const reject = await send("POST", `/grow/property-intelligence/matches/${matchBId}/reject`, agentA.cookie, {});
    assert.equal(reject.status, 404);
    assert.deepEqual(await reject.json(), { error: "Match not found" });
    const review = await send("POST", `/grow/property-intelligence/signals/${signalBId}/review`, agentA.cookie);
    assert.equal(review.status, 404);
    assert.deepEqual(await review.json(), { error: "Signal not found" });
    const dismiss = await send("POST", `/grow/property-intelligence/signals/${signalBId}/dismiss`, agentA.cookie, {
      dismissedReason: "no",
    });
    assert.equal(dismiss.status, 404);
    assert.deepEqual(await dismiss.json(), { error: "Signal not found" });
    const promote = await send("POST", `/grow/property-intelligence/signals/${signalBId}/promote`, agentA.cookie);
    assert.equal(promote.status, 404);
    assert.deepEqual(await promote.json(), { error: "Signal not found" });
    const recalculate = await send("POST", `/grow/property-intelligence/property/${propertyBId}/recalculate`, agentA.cookie);
    assert.equal(recalculate.status, 404);
    assert.deepEqual(await recalculate.json(), { error: "Property not found" });

    const [signalStill] = await db
      .select({ status: growOpportunitySignals.status })
      .from(growOpportunitySignals)
      .where(eq(growOpportunitySignals.id, signalBId));
    assert.equal(signalStill.status, "Active");

    const contactReview = await send("POST", `/grow/property-intelligence/signals/${signalContactId}/review`, agentA.cookie);
    assert.equal(contactReview.status, 200, await contactReview.clone().text());
    const ownRecalculate = await send("POST", `/grow/property-intelligence/property/${propertyAId}/recalculate`, agentA.cookie);
    assert.equal(ownRecalculate.status, 200, await ownRecalculate.clone().text());
  });

  test("Brokerage Administrator and Pit Crew still write property-linked Grow rows anywhere in the brokerage", async () => {
    const adminRelationship = await send("POST", "/grow/relationships", admin.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      relationshipType: "landlord",
    });
    assert.equal(adminRelationship.status, 201, await adminRelationship.clone().text());
    const adminPatch = await send("PATCH", `/grow/relationships/${relationshipBId}`, admin.cookie, { status: "Historical" });
    assert.equal(adminPatch.status, 200, await adminPatch.clone().text());
    const pitActivity = await send("POST", "/grow/activities", pitCrew.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      activityType: "note",
      summary: "Pit crew note on B",
    });
    assert.equal(pitActivity.status, 201, await pitActivity.clone().text());
    const adminOpportunity = await send("POST", "/grow/opportunities", admin.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
      opportunityType: "Appraisal",
      reason: "Admin on B",
    });
    assert.equal(adminOpportunity.status, 201, await adminOpportunity.clone().text());
    const pitCommitment = await send("POST", `/grow/contacts/${sharedContactId}/commitments`, pitCrew.cookie, {
      description: "Pit crew promise on B",
      dueAt: new Date().toISOString(),
      propertyId: propertyBId,
    });
    assert.equal(pitCommitment.status, 201, await pitCommitment.clone().text());
    const pitCommitmentId = ((await pitCommitment.json()) as { commitment: { id: number } }).commitment.id;
    const pitComplete = await send("PATCH", `/grow/contacts/commitments/${pitCommitmentId}`, pitCrew.cookie, {
      status: "Completed",
    });
    assert.equal(pitComplete.status, 200, await pitComplete.clone().text());
    const adminAppraisal = await send("POST", "/grow/appraisals/from-contact", admin.cookie, {
      partyId: sharedContactId,
      propertyId: propertyBId,
    });
    assert.equal(adminAppraisal.status, 201, await adminAppraisal.clone().text());
    const pitStart = await send("POST", `/appraisals/by-property/${propertyBId}/start`, pitCrew.cookie);
    assert.ok(pitStart.status === 200 || pitStart.status === 201, await pitStart.clone().text());
    const adminRecalculate = await send("POST", `/grow/property-intelligence/property/${propertyBId}/recalculate`, admin.cookie);
    assert.equal(adminRecalculate.status, 200, await adminRecalculate.clone().text());
    const adminConfirm = await send("POST", `/grow/property-intelligence/matches/${matchBId}/confirm`, admin.cookie);
    assert.equal(adminConfirm.status, 200, await adminConfirm.clone().text());
  });

  test("an Ask AE commitment action cannot name a property the acting Agent cannot see", async () => {
    await assert.rejects(
      () =>
        createApprovedGrowCommitment({
          brokerageId,
          createdBy: agentA.user.id,
          partyId: sharedContactId,
          description: "Should not land",
          dueAt: new Date().toISOString(),
          propertyId: propertyBId,
        }),
      (err: unknown) => err instanceof GrowCommitmentValidationError,
    );
    const hiddenRows = await db
      .select({ id: growCommitments.id })
      .from(growCommitments)
      .where(and(eq(growCommitments.description, "Should not land"), eq(growCommitments.brokerageId, brokerageId)));
    assert.equal(hiddenRows.length, 0);

    const contactLevel = await createApprovedGrowCommitment({
      brokerageId,
      createdBy: agentA.user.id,
      partyId: sharedContactId,
      description: "Agent A contact-level AI promise",
      dueAt: new Date().toISOString(),
      propertyId: null,
    });
    assert.equal(contactLevel.propertyId, null);

    const adminCreated = await createApprovedGrowCommitment({
      brokerageId,
      createdBy: admin.user.id,
      partyId: sharedContactId,
      description: "Admin AI promise on B",
      dueAt: new Date().toISOString(),
      propertyId: propertyBId,
    });
    assert.equal(adminCreated.propertyId, propertyBId);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(aiActionRequests).values([
      {
        brokerageId,
        userId: agentA.user.id,
        actorType: "AI",
        actionKey: "CREATE_GROW_COMMITMENT",
        authorityLevel: 4,
        riskLevel: 2,
        inputPayload: { propertyId: propertyBId, partyId: sharedContactId, description: "hidden proposal" },
        inputPayloadHash: `uat-v3-hidden-${suffix}`,
        humanReadableSummary: "Hidden property proposal",
        status: "AWAITING_APPROVAL",
        expiresAt,
      },
      {
        brokerageId,
        userId: agentA.user.id,
        actorType: "AI",
        actionKey: "CREATE_GROW_COMMITMENT",
        authorityLevel: 4,
        riskLevel: 2,
        inputPayload: { propertyId: null, partyId: sharedContactId, description: "contact proposal" },
        inputPayloadHash: `uat-v3-contact-${suffix}`,
        humanReadableSummary: "Contact-level proposal",
        status: "AWAITING_APPROVAL",
        expiresAt,
      },
      {
        brokerageId,
        userId: admin.user.id,
        actorType: "AI",
        actionKey: "CREATE_GROW_COMMITMENT",
        authorityLevel: 4,
        riskLevel: 2,
        inputPayload: { propertyId: propertyBId, partyId: sharedContactId, description: "admin proposal" },
        inputPayloadHash: `uat-v3-admin-${suffix}`,
        humanReadableSummary: "Admin property proposal",
        status: "AWAITING_APPROVAL",
        expiresAt,
      },
    ]);

    const agentList = await send("GET", "/grow/ai-actions/pending-commitments", agentA.cookie);
    assert.equal(agentList.status, 200, await agentList.clone().text());
    const agentProposals = ((await agentList.json()) as { proposals: Array<{ humanReadableSummary: string }> }).proposals;
    assert.ok(agentProposals.some((row) => row.humanReadableSummary === "Contact-level proposal"));
    assert.ok(!agentProposals.some((row) => row.humanReadableSummary === "Hidden property proposal"));

    const adminList = await send("GET", "/grow/ai-actions/pending-commitments", admin.cookie);
    assert.equal(adminList.status, 200, await adminList.clone().text());
    const adminProposals = ((await adminList.json()) as { proposals: Array<{ humanReadableSummary: string }> }).proposals;
    assert.ok(adminProposals.some((row) => row.humanReadableSummary === "Admin property proposal"));
  });
});
