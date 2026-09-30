// G-12 — tenant_isolation_rejection_total at Grow's by-id boundaries.
// A cross-tenant id stays the same status and body the route already
// returned. The counter moves once, with boundary "grow", only when that
// row exists in another brokerage. A missing id and a same-tenant success
// do not.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import {
  db,
  appraisalComparableSales,
  appraisalMarketCompetition,
  appraisals,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growCallRecordingConsents,
  growCallSessions,
  growCallTranscriptions,
  parties,
  properties,
} from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const DECLARED_BOUNDARIES = new Set([
  "property",
  "party",
  "transaction",
  "financial",
  "communications",
  "integrations",
  "pit_crew",
  "grow",
  "other",
]);

const MISSING_ID = 2_147_483_646;
const ENTITLEMENTS = [
  "grow.access",
  "grow.relationships.manage",
  "grow.properties.link",
  "grow.activities.manage",
  "grow.opportunities.manage",
  "grow.contacts.read",
  "grow.contacts.manage",
  "grow.calling.access",
  "grow.calling.recording",
  "grow.calling.transcription",
];

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let propertyBId: number;
let partyId: number;
let partyId2: number;
let partyBId: number;
let relationshipId: number;
let opportunityId: number;
let commitmentId: number;
let contactRelationshipId: number;
let appraisalId: number;
let appraisalBId: number;
let saleId: number;
let competitionId: number;
let callSessionId: number;
let callSessionBId: number;
let transcriptionId: number;
let recordingConsentId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function patchRaw(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "PATCH",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function deleteRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { method: "DELETE", headers: headers(cookie) });
}

function isolationSeries(): Array<{ boundary: string; value: number; labels: string }> {
  const found: Array<{ boundary: string; value: number; labels: string }> = [];
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
    const match = /^tenant_isolation_rejection_total\{(.+)\} (\d+)$/.exec(line);
    assert.ok(match, `unparsed metric line: ${line}`);
    const labels = match[1];
    const boundary = /^boundary="([^"]*)"$/.exec(labels);
    assert.ok(boundary, `only the boundary label is allowed, got ${labels}`);
    found.push({ boundary: boundary[1], value: Number(match[2]), labels });
  }
  return found;
}

function identifyingIds(): number[] {
  return [
    A.brokerageId,
    B.brokerageId,
    propertyId,
    propertyBId,
    partyId,
    partyId2,
    partyBId,
    relationshipId,
    opportunityId,
    commitmentId,
    contactRelationshipId,
    appraisalId,
    appraisalBId,
    saleId,
    competitionId,
    callSessionId,
    callSessionBId,
    transcriptionId,
    recordingConsentId,
    A.admin.user.id,
    A.agent.user.id,
    B.admin.user.id,
    B.agent.user.id,
  ];
}

function assertBoundedLabels(): void {
  for (const series of isolationSeries()) {
    assert.ok(DECLARED_BOUNDARIES.has(series.boundary), series.boundary);
    assert.equal(series.labels, `boundary="${series.boundary}"`);
    for (const id of identifyingIds()) {
      assert.equal(series.boundary.includes(String(id)), false, `label value contains id ${id}`);
    }
  }
}

function assertIncrement(boundary: string): void {
  const series = isolationSeries();
  assert.equal(series.length, 1);
  assert.equal(series[0].boundary, boundary);
  assert.equal(series[0].value, 1);
  assertBoundedLabels();
}

function assertNoIncrement(): void {
  assert.deepEqual(isolationSeries(), []);
}

async function assertJson(res: Response, status: number, body: string): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(await res.text(), body);
}

async function grant(brokerageId: number, keys: string[]) {
  await db.insert(entitlementGrants).values(keys.map((entitlementKey) => ({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  })));
  invalidateEntitlementCache(brokerageId);
}

async function insertParty(brokerageId: number, firstName: string): Promise<number> {
  const [party] = await db.insert(parties).values({
    brokerageId,
    firstName,
    lastName: "Isolation",
    mobile: "0400000000",
  }).returning();
  return party!.id;
}

async function insertCallSession(brokerageId: number, ownerId: number, contactId: number): Promise<number> {
  const [session] = await db.insert(growCallSessions).values({
    brokerageId,
    partyId: contactId,
    initiatedByUserId: ownerId,
    destinationRaw: "0400000000",
    destinationNormalized: "+61400000000",
    destinationCountry: "AU",
    status: "READY",
  }).returning();
  return session!.id;
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

  A = await createBrokerageWithUsers(baseUrl, `G-12 Isolation A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `G-12 Isolation B ${suffix}`);
  await grant(A.brokerageId, ENTITLEMENTS);
  await grant(B.brokerageId, ENTITLEMENTS);

  const created = await postRaw("/properties", A.agent.cookie, {
    formattedAddress: `${suffix} Isolation St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(created.status, 201);
  propertyId = ((await created.json()) as { property: { id: number } }).property.id;

  const createdB = await postRaw("/properties", B.agent.cookie, {
    formattedAddress: `${suffix} Other St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(createdB.status, 201);
  propertyBId = ((await createdB.json()) as { property: { id: number } }).property.id;

  partyId = await insertParty(A.brokerageId, "Priva");
  partyId2 = await insertParty(A.brokerageId, "Second");
  partyBId = await insertParty(B.brokerageId, "Local");

  const relationship = await postRaw("/grow/relationships", A.agent.cookie, {
    partyId,
    relationshipType: "Owner",
    propertyId,
  });
  assert.equal(relationship.status, 201, await relationship.clone().text());
  relationshipId = ((await relationship.json()) as { relationship: { id: number } }).relationship.id;

  const opportunity = await postRaw("/grow/opportunities", A.agent.cookie, {
    partyId,
    opportunityType: "Appraisal",
    reason: "Isolation opportunity",
  });
  assert.equal(opportunity.status, 201, await opportunity.clone().text());
  opportunityId = ((await opportunity.json()) as { opportunity: { id: number } }).opportunity.id;

  const commitment = await postRaw(`/grow/contacts/${partyId}/commitments`, A.agent.cookie, {
    description: "Call back",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(commitment.status, 201, await commitment.clone().text());
  commitmentId = ((await commitment.json()) as { commitment: { id: number } }).commitment.id;

  const household = await postRaw(`/grow/contacts/${partyId}/relationships`, A.agent.cookie, {
    relatedPartyId: partyId2,
    relationshipType: "spouse_partner",
  });
  assert.equal(household.status, 201, await household.clone().text());
  contactRelationshipId = ((await household.json()) as { relationship: { id: number } }).relationship.id;

  const role = await postRaw(`/grow/contacts/${partyId}/roles`, A.agent.cookie, { role: "Prospect" });
  assert.equal(role.status, 201, await role.clone().text());

  const fromContact = await postRaw("/grow/appraisals/from-contact", A.agent.cookie, { partyId, propertyId });
  assert.equal(fromContact.status, 201, await fromContact.clone().text());
  appraisalId = ((await fromContact.json()) as { appraisal: { id: number } }).appraisal.id;

  const startedB = await postRaw(`/appraisals/by-property/${propertyBId}/start`, B.agent.cookie, {});
  assert.ok(startedB.status === 200 || startedB.status === 201, await startedB.clone().text());
  appraisalBId = ((await startedB.json()) as { appraisal: { id: number } }).appraisal.id;

  const sale = await postRaw(`/grow/appraisals/${appraisalId}/comparable-sales`, A.agent.cookie, {
    address: `${suffix} Comparable Sale`,
  });
  assert.equal(sale.status, 201, await sale.clone().text());
  saleId = ((await sale.json()) as { comparableSale: { id: number } }).comparableSale.id;

  const competition = await postRaw(`/grow/appraisals/${appraisalId}/market-competition`, A.agent.cookie, {
    address: `${suffix} Competition`,
  });
  assert.equal(competition.status, 201, await competition.clone().text());
  competitionId = ((await competition.json()) as { marketCompetition: { id: number } }).marketCompetition.id;

  callSessionId = await insertCallSession(A.brokerageId, A.agent.user.id, partyId);
  callSessionBId = await insertCallSession(B.brokerageId, B.agent.user.id, partyBId);

  const storageKey = `g12-isolation-${callSessionId}`;
  const [document] = await db.insert(documents).values({
    brokerageId: A.brokerageId,
    logicalOwnerType: "telephony-call",
    logicalOwnerId: callSessionId,
    documentType: "CallRecording",
    title: "G-12 isolation recording",
    status: "Generated",
    objectStorageKey: storageKey,
  }).returning();
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id,
    brokerageId: A.brokerageId,
    storageObjectKey: storageKey,
    version: 1,
    originalFilename: "recording.wav",
    displayFilename: "recording.wav",
    declaredMimeType: "audio/wav",
    detectedMimeType: "audio/wav",
    byteSize: 1,
    contentSha256: "0".repeat(64),
    source: "upload",
    objectStatus: "Active",
    uploadedBy: A.agent.user.id,
  }).returning();
  const [transcription] = await db.insert(growCallTranscriptions).values({
    brokerageId: A.brokerageId,
    callSessionId,
    partyId,
    recordingReference: version!.id,
    processingState: "PENDING",
    draftKeyPoints: [],
    draftCommitments: [],
    draftFollowups: [],
  }).returning();
  transcriptionId = transcription!.id;

  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId: A.brokerageId,
    partyId,
    scope: "STANDING",
    status: "ACTIVE",
    source: "WRITTEN",
    capturedByUserId: A.agent.user.id,
  }).returning();
  recordingConsentId = consent!.id;
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  if (ids.length > 0) {
    await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, ids));
    await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.brokerageId, ids));
    await db.delete(documents).where(inArray(documents.brokerageId, ids));
    const propertyRows = await db.select({ id: properties.id }).from(properties).where(inArray(properties.brokerageId, ids));
    const propertyIds = propertyRows.map((row) => row.id);
    if (propertyIds.length > 0) {
      const appraisalRows = await db.select({ id: appraisals.id }).from(appraisals).where(inArray(appraisals.propertyId, propertyIds));
      const appraisalIds = appraisalRows.map((row) => row.id);
      if (appraisalIds.length > 0) {
        await db.delete(appraisalComparableSales).where(inArray(appraisalComparableSales.appraisalId, appraisalIds));
        await db.delete(appraisalMarketCompetition).where(inArray(appraisalMarketCompetition.appraisalId, appraisalIds));
      }
    }
    await cleanupBrokerages(ids);
  }
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("G-12 tenant isolation rejection metric", { concurrency: 1 }, () => {
  test("a relationship in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/relationships/${relationshipId}`, B.agent.cookie, { status: "Historical" });
    await assertJson(res, 404, JSON.stringify({ error: "Relationship not found" }));
    assertIncrement("grow");
  });

  test("a missing relationship id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/relationships/${MISSING_ID}`, A.agent.cookie, { status: "Historical" });
    await assertJson(res, 404, JSON.stringify({ error: "Relationship not found" }));
    assertNoIncrement();
  });

  test("a malformed relationship id is still 400 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await patchRaw("/grow/relationships/abc", A.agent.cookie, { status: "Historical" });
    await assertJson(res, 400, JSON.stringify({ error: "Invalid relationship id" }));
    assertNoIncrement();
  });

  test("the caller's own relationship update still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/relationships/${relationshipId}`, A.agent.cookie, { isPrimary: false });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { relationship: { id: number; isPrimary: boolean } };
    assert.equal(body.relationship.id, relationshipId);
    assert.equal(body.relationship.isPrimary, false);
    assertNoIncrement();
  });

  test("linking another brokerage's property is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/grow/relationships", B.agent.cookie, {
      partyId: partyBId,
      relationshipType: "Owner",
      propertyId,
    });
    await assertJson(res, 404, JSON.stringify({ error: "Property not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("an activity citing another brokerage's opportunity is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/grow/activities", B.agent.cookie, {
      activityType: "note",
      summary: "not mine",
      opportunityId,
    });
    await assertJson(res, 404, JSON.stringify({ error: "Opportunity not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("an opportunity in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/opportunities/${opportunityId}`, B.agent.cookie, {
      recommendedNextAction: "call",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Opportunity not found" }));
    assertIncrement("grow");
  });

  test("a missing opportunity id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/opportunities/${MISSING_ID}`, A.agent.cookie, {
      recommendedNextAction: "call",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Opportunity not found" }));
    assertNoIncrement();
  });

  test("listing opportunities does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw("/grow/opportunities", B.agent.cookie);
    assert.equal(res.status, 200);
    await res.text();
    assertNoIncrement();
  });

  test("a contact in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/contacts/${partyId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Contact not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("a missing contact id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/contacts/${MISSING_ID}`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Contact not found in this brokerage" }));
    assertNoIncrement();
  });

  test("the caller's own contact still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/contacts/${partyId}`, A.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { contact: { id: number; firstName: string } };
    assert.equal(body.contact.id, partyId);
    assert.equal(body.contact.firstName, "Priva");
    assertNoIncrement();
  });

  test("removing a role in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await deleteRaw(`/grow/contacts/${partyId}/roles/Prospect`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Role assignment not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("removing a role that was never assigned does not increment", async () => {
    resetMetricsForTesting();
    const res = await deleteRaw(`/grow/contacts/${partyId}/roles/Investor`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Role assignment not found in this brokerage" }));
    assertNoIncrement();
  });

  test("relating to a contact in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw(`/grow/contacts/${partyBId}/relationships`, B.agent.cookie, {
      relatedPartyId: partyId,
      relationshipType: "family",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Both contacts must exist in this brokerage" }));
    assertIncrement("grow");
  });

  test("a household relationship in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await deleteRaw(`/grow/contacts/relationships/${contactRelationshipId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Relationship not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("a commitment in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/contacts/commitments/${commitmentId}`, B.agent.cookie, { status: "Completed" });
    await assertJson(res, 404, JSON.stringify({ error: "Commitment not found in this brokerage" }));
    assertIncrement("grow");
  });

  test("a property in another brokerage is still 404 on the appraisal read and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/appraisals/by-property/${propertyId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertIncrement("grow");
  });

  test("a missing property id on the appraisal read is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/appraisals/by-property/${MISSING_ID}`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertNoIncrement();
  });

  test("the caller's own appraisal read still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/appraisals/by-property/${propertyId}`, A.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { appraisal: { id: number } | null };
    assert.equal(body.appraisal?.id, appraisalId);
    assertNoIncrement();
  });

  test("a grow appraisal in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/appraisals/${appraisalId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Appraisal not found" }));
    assertIncrement("grow");
  });

  test("creating an appraisal from another brokerage's contact is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/grow/appraisals/from-contact", B.agent.cookie, {
      partyId,
      propertyId: propertyBId,
    });
    await assertJson(res, 404, JSON.stringify({ error: "Contact not found" }));
    assertIncrement("grow");
  });

  test("creating an appraisal from another brokerage's opportunity is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/grow/appraisals/from-opportunity", B.agent.cookie, { opportunityId });
    await assertJson(res, 404, JSON.stringify({ error: "Opportunity not found" }));
    assertIncrement("grow");
  });

  test("assigning another brokerage's user as appraisal owner is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/appraisals/${appraisalBId}`, B.agent.cookie, {
      ownerUserId: A.agent.user.id,
    });
    await assertJson(res, 404, JSON.stringify({ error: "Owner user not found" }));
    assertIncrement("grow");
  });

  test("updating a comparable sale from another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/appraisals/${appraisalBId}/comparable-sales/${saleId}`, B.agent.cookie, {
      address: "Should not apply",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Comparable sale not found." }));
    assertIncrement("grow");
  });

  test("a missing comparable sale id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/appraisals/${appraisalBId}/comparable-sales/${MISSING_ID}`, B.agent.cookie, {
      address: "Nobody",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Comparable sale not found." }));
    assertNoIncrement();
  });

  test("updating a market-competition entry from another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await patchRaw(`/grow/appraisals/${appraisalBId}/market-competition/${competitionId}`, B.agent.cookie, {
      address: "Should not apply",
    });
    await assertJson(res, 404, JSON.stringify({ error: "Market competition entry not found." }));
    assertIncrement("grow");
  });

  test("a call session in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${callSessionId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Call session not found in this brokerage." }));
    assertIncrement("grow");
  });

  test("a missing call session id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${MISSING_ID}`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Call session not found in this brokerage." }));
    assertNoIncrement();
  });

  test("the caller's own call session still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${callSessionId}`, A.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { callSession: { id: number } };
    assert.equal(body.callSession.id, callSessionId);
    assertNoIncrement();
  });

  test("call eligibility for another brokerage's contact is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/contacts/${partyId}/eligibility`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Contact not found." }));
    assertIncrement("grow");
  });

  test("creating a call for another brokerage's contact keeps its 400 body and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/grow/calls", B.agent.cookie, { partyId });
    await assertJson(res, 400, JSON.stringify({ error: "Contact not found in this brokerage." }));
    assertIncrement("grow");
  });

  test("a transcription in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${callSessionBId}/transcription/${transcriptionId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Transcription not found.", code: "NOT_FOUND" }));
    assertIncrement("grow");
  });

  test("a missing transcription id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${callSessionBId}/transcription/${MISSING_ID}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Transcription not found.", code: "NOT_FOUND" }));
    assertNoIncrement();
  });

  test("follow-ups for a call session in another brokerage are still 404 and increment once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/calls/${callSessionId}/transcription/${transcriptionId}/followups`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Call session not found.", code: "NOT_FOUND" }));
    assertIncrement("grow");
  });

  test("withdrawing a recording consent in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw(`/grow/calls/consent/${recordingConsentId}/withdraw`, B.agent.cookie, {});
    await assertJson(res, 404, JSON.stringify({ error: "Recording consent not found in this brokerage." }));
    assertIncrement("grow");
  });

  test("a missing recording consent id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await postRaw(`/grow/calls/consent/${MISSING_ID}/withdraw`, A.agent.cookie, {});
    await assertJson(res, 404, JSON.stringify({ error: "Recording consent not found in this brokerage." }));
    assertNoIncrement();
  });

  test("reading consent for another brokerage's contact is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/contacts/${partyId}/consent`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Contact not found." }));
    assertIncrement("grow");
  });

  test("naming another brokerage's user as consent reviewer is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw(`/grow/contacts/${partyBId}/consent`, B.agent.cookie, {
      channel: "EMAIL",
      source: "manual",
      captureMethod: "form",
      purpose: "marketing",
      scope: "general",
      inferredEvidenceReviewedByUserId: A.agent.user.id,
    });
    await assertJson(res, 404, JSON.stringify({ error: "User not found in this brokerage." }));
    assertIncrement("grow");
  });

  test("the caller's own consent read still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/grow/contacts/${partyId}/consent`, A.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { partyId: number };
    assert.equal(body.partyId, partyId);
    assertNoIncrement();
  });

  test("the caller's pending AI proposals are a session-scoped list and do not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw("/grow/ai-actions/pending-commitments", A.agent.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { proposals: unknown[] };
    assert.ok(Array.isArray(body.proposals));
    assertNoIncrement();
  });
});
