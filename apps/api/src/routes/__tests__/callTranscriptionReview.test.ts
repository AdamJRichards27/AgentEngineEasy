import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growActivities,
  growCallSessions,
  growCallTranscriptions,
  parties,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { saveCallTranscriptionReview } from "../../lib/telephony/callTranscriptionReview.js";
import { setCallTranscriptionProviderForTests } from "../../lib/telephony/callTranscriptions.js";
import { setCallTranscriptionDraftGatewayForTests } from "../../lib/telephony/callTranscriptionDrafts.js";
import { persistApprovedCallSummaryActivity } from "../../lib/telephony/callTranscriptionTimeline.js";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  devLogin,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
  ? process.env.SESSION_SECRET : "review-route-test-secret-012345678901234567890";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let A: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
let B: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
let other: DevLoginResult;
let fixtureId: number;
let fixtureSessionId: number;
let fixturePartyId: number;
let brokerageId: number;
const sourceVersionIds: number[] = [];
const sourceDocumentIds: number[] = [];

function url(path: string): string {
  return `${baseUrl}/api/grow/calls${path}`;
}

function contactUrl(path: string): string {
  return `${baseUrl}/api/grow/contacts${path}`;
}

function growUrl(path: string): string {
  return `${baseUrl}/api/grow${path}`;
}

function fullReviewState() {
  return [
    { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
    { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Human summary." },
    { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
    { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
    { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
  ];
}

async function saveReview(reviewState: unknown[], sessionId = fixtureSessionId, transcriptionId = fixtureId): Promise<Response> {
  return fetch(url(`/${sessionId}/transcription/${transcriptionId}/review`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reviewState }),
  });
}

async function activitiesFor(transcriptionId: number) {
  return db.select().from(growActivities).where(and(
    eq(growActivities.brokerageId, brokerageId),
    eq(growActivities.activityType, "call_summary"),
    eq(growActivities.source, "grow_call_transcriptions"),
    eq(growActivities.sourceId, String(transcriptionId)),
  ));
}

async function createFixture(): Promise<{ transcriptionId: number; sessionId: number; partyId: number; versionId: number; documentId: number }> {
  const [party] = await db.insert(parties).values({
    brokerageId, firstName: "Route", lastName: "Review", mobile: "+61400123456",
  }).returning();
  fixturePartyId = party!.id;
  const [session] = await db.insert(growCallSessions).values({
    brokerageId, partyId: party!.id, initiatedByUserId: A.agent.user.id,
    destinationRaw: "+61400123456", destinationNormalized: "+61400123456",
    destinationCountry: "AU", provider: "synthetic", status: "CONNECTED",
  }).returning();
  fixtureSessionId = session!.id;
  const storageKey = `route-review-${fixtureSessionId}`;
  const [document] = await db.insert(documents).values({
    brokerageId, logicalOwnerType: "telephony-call", logicalOwnerId: session!.id,
    documentType: "CallRecording", title: "Route review recording",
    status: "Generated", objectStorageKey: storageKey,
  }).returning();
  sourceDocumentIds.push(document!.id);
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id, brokerageId, storageObjectKey: storageKey, version: 1,
    originalFilename: "recording.wav", displayFilename: "recording.wav",
    declaredMimeType: "audio/wav", detectedMimeType: "audio/wav", byteSize: 1,
    contentSha256: "0".repeat(64), source: "upload", objectStatus: "Active",
    uploadedBy: A.agent.user.id,
  }).returning();
  sourceVersionIds.push(version!.id);
  const [transcription] = await db.insert(growCallTranscriptions).values({
    brokerageId, callSessionId: session!.id, partyId: party!.id,
    recordingReference: version!.id, processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Route machine transcript.", draftSummary: "Route machine summary.",
    draftKeyPoints: [{ id: "kp-1", text: "Route point." }],
    draftCommitments: [{ id: "com-1", text: "Route commitment." }],
    draftFollowups: [{ id: "fu-1", text: "Route follow-up." }],
  }).returning();
  fixtureId = transcription!.id;
  return {
    transcriptionId: transcription!.id,
    sessionId: session!.id,
    partyId: party!.id,
    versionId: version!.id,
    documentId: document!.id,
  };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected test server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `Review route ${Date.now()}`);
  B = await createBrokerageWithUsers(baseUrl, `Review route other brokerage ${Date.now()}`);
  brokerageId = A.brokerageId;
  other = await devLogin(baseUrl, {
    email: `review-route-other-${brokerageId}@test.invalid`,
    firstName: "Other", lastName: "Reviewer", brokerageName: A.admin.user.brokerageName!,
  });
  await db.insert(entitlementGrants).values({
    brokerageId, entitlementKey: "grow.calling.transcription", granteeType: "brokerage",
    granteeId: brokerageId, sourceType: "manual", status: "Active",
  });
  await db.insert(entitlementGrants).values([
    {
      brokerageId: B.brokerageId, entitlementKey: "grow.calling.transcription", granteeType: "brokerage",
      granteeId: B.brokerageId, sourceType: "manual", status: "Active",
    },
    {
      brokerageId: B.brokerageId, entitlementKey: "grow.calling.access", granteeType: "brokerage",
      granteeId: B.brokerageId, sourceType: "manual", status: "Active",
    },
    {
      brokerageId: B.brokerageId, entitlementKey: "grow.contacts.read", granteeType: "brokerage",
      granteeId: B.brokerageId, sourceType: "manual", status: "Active",
    },
  ]);
  invalidateEntitlementCache(brokerageId);
  invalidateEntitlementCache(B.brokerageId);
  await createFixture();
});

after(async () => {
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, [brokerageId]));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.id, sourceVersionIds));
  await db.delete(documents).where(inArray(documents.id, sourceDocumentIds));
  await cleanupBrokerages([brokerageId, B.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("HTTP read/save contract is authenticated, entitled, owner-scoped, and returns reviewed transcription", async () => {
  const unauthenticated = await fetch(url(`/contacts/${fixturePartyId}/transcriptions`));
  assert.equal(unauthenticated.status, 401);
  const listed = await fetch(url(`/contacts/${fixturePartyId}/transcriptions`), {
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(listed.status, 200);
  const listBody = await listed.json() as { transcriptions: Array<{ id: number }> };
  assert.equal(listBody.transcriptions.some((row) => row.id === fixtureId), true);
  assert.equal((await activitiesFor(fixtureId)).length, 0, "Timeline is explicit-Save only");

  const deniedRead = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}`), {
    headers: { cookie: other.cookie },
  });
  assert.equal(deniedRead.status, 403);
  const deniedSave = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}/review`), {
    method: "POST", headers: { "content-type": "application/json", cookie: other.cookie },
    body: JSON.stringify({ reviewState: [] }),
  });
  assert.equal(deniedSave.status, 403);

  const saved = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}/review`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reviewState: [
      { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Route human transcript." },
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Route summary." },
      { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
      { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
      { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
    ] }),
  });
  const savedText = await saved.text();
  assert.equal(saved.status, 200, savedText);
  const savedBody = JSON.parse(savedText) as {
    transcription: { processingState: string; approvedBy: number; transcript: string | null; recordingReference: number | null };
  };
  assert.equal(savedBody.transcription.processingState, "APPROVED");
  assert.equal(savedBody.transcription.approvedBy, A.agent.user.id);
  const activities = await activitiesFor(fixtureId);
  assert.equal(activities.length, 1);
  const activity = activities[0]!;
  assert.equal(activity.activityType, "call_summary");
  assert.equal(activity.source, "grow_call_transcriptions");
  assert.equal(activity.sourceId, String(fixtureId));
  assert.equal(activity.partyId, fixturePartyId);
  assert.equal(activity.brokerageId, brokerageId);
  assert.equal(activity.responsibleUserId, A.agent.user.id);
  const details = activity.details as {
    partyId: number; callSessionId: number; transcriptionId: number;
    approvedBy: number; approvedAt: string;
    approvedContent: { summary: string | null; keyPoints: Array<{ id: string; text: string }>; commitments: Array<{ id: string; text: string }>; followups: Array<{ id: string; text: string }> };
  };
  assert.equal(details.partyId, fixturePartyId);
  assert.equal(details.callSessionId, fixtureSessionId);
  assert.equal(details.transcriptionId, fixtureId);
  assert.equal(details.approvedBy, A.agent.user.id);
  assert.equal(details.approvedAt, activity.occurredAt.toISOString());
  assert.deepEqual(details.approvedContent, {
    summary: "Route summary.",
    keyPoints: [{ id: "kp-1", text: "Route point." }],
    commitments: [{ id: "com-1", text: "Route commitment." }],
    followups: [{ id: "fu-1", text: "Route follow-up." }],
  });
  assert.match(activity.summary, /Route summary/);
  assert.match(activity.summary, /Route commitment/);
  assert.doesNotMatch(savedText, /Route human transcript|Route machine transcript/);
  assert.equal(savedBody.transcription.transcript, null);
  assert.equal(savedBody.transcription.recordingReference, null);
  const [stored] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixtureId));
  assert.equal(stored?.transcript, null);
  assert.equal(stored?.recordingReference, null);
  assert.equal(stored?.draftSummary, "Route machine summary.");
  assert.equal(stored?.approvedBy, A.agent.user.id);
  const reread = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}`), {
    headers: { cookie: A.agent.cookie },
  });
  const rereadText = await reread.text();
  assert.equal(reread.status, 200, rereadText);
  assert.doesNotMatch(rereadText, /Route human transcript|Route machine transcript/);
});

test("the interim transcript is returned only while review is open, and skipping transcript approval saves nothing", async () => {
  const fixture = await createFixture();
  const open = await fetch(url(`/${fixture.sessionId}/transcription/${fixture.transcriptionId}`), {
    headers: { cookie: A.agent.cookie },
  });
  const openText = await open.text();
  assert.equal(open.status, 200, openText);
  assert.match(openText, /Route machine transcript/);
  const rejected = await saveReview([
    { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Notes only" },
  ], fixture.sessionId, fixture.transcriptionId);
  assert.equal(rejected.status, 400);
  const [row] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(row?.transcript, "Route machine transcript.");
  assert.equal(row?.recordingReference, fixture.versionId);
  assert.equal(row?.processingState, "AWAITING_AGENT_REVIEW");
  assert.equal(row?.approvedBy, null);
});

test("HTTP discard uses the standardized no-review path and rejects client metadata", async () => {
  await createFixture();
  const rejected = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}/discard`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reviewedByUserId: A.agent.user.id }),
  });
  assert.equal(rejected.status, 400);
  const discarded = await fetch(url(`/${fixtureSessionId}/transcription/${fixtureId}/discard`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: "{}",
  });
  assert.equal(discarded.status, 200);
  const body = await discarded.json() as { transcription: { processingState: string } };
  assert.equal(body.transcription.processingState, "DISCARDED");
  assert.equal((await activitiesFor(fixtureId)).length, 0);
});

test("cross-brokerage actors cannot read or write recording, transcription review, or its Contact Timeline", async () => {
  const fixture = await createFixture();
  const listResponse = await fetch(url(`/contacts/${fixture.partyId}/transcriptions`), {
    headers: { cookie: B.agent.cookie },
  });
  assert.equal(listResponse.status, 200);
  assert.deepEqual(await listResponse.json(), { transcriptions: [] });

  const requests: Array<{ path: string; method?: "GET" | "POST"; body?: unknown }> = [
    { path: `/${fixture.sessionId}/transcription/${fixture.transcriptionId}` },
    { path: `/${fixture.sessionId}/recording/status` },
    { path: `/${fixture.sessionId}/transcription/${fixture.transcriptionId}/review`, method: "POST", body: { reviewState: fullReviewState() } },
    { path: `/${fixture.sessionId}/transcription/${fixture.transcriptionId}/discard`, method: "POST", body: {} },
  ];
  for (const request of requests) {
    const response = await fetch(url(request.path), {
      method: request.method ?? "GET",
      headers: { "content-type": "application/json", cookie: B.agent.cookie },
      body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
    });
    assert.equal(response.status, 404, `${request.method ?? "GET"} ${request.path}`);
  }

  const timelineRead = await fetch(contactUrl(`/${fixture.partyId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(timelineRead.status, 404);
  assert.equal((await activitiesFor(fixture.transcriptionId)).length, 0);
  const [unchanged] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(unchanged!.processingState, "AWAITING_AGENT_REVIEW");
  assert.deepEqual(unchanged!.reviewState, []);
});

test("cross-brokerage transcription initiation is uniformly not found for existing and absent recording tuples", async () => {
  const fixture = await createFixture();
  const existingTupleResponse = await fetch(url(`/${fixture.sessionId}/transcription`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ recordingReference: fixture.versionId }),
  });
  const existingTupleBody = await existingTupleResponse.text();

  const absentTupleResponse = await fetch(url(`/${fixture.sessionId}/transcription`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ recordingReference: 2_000_000_000 }),
  });
  const absentTupleBody = await absentTupleResponse.text();

  const missingCallResponse = await fetch(url("/2000000000/transcription"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.agent.cookie },
    body: JSON.stringify({ recordingReference: 2_000_000_000 }),
  });
  const missingCallBody = await missingCallResponse.text();

  const [unchanged] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(unchanged!.processingState, "AWAITING_AGENT_REVIEW");
  assert.deepEqual(unchanged!.reviewState, []);
  assert.equal((await activitiesFor(fixture.transcriptionId)).length, 0);

  assert.equal(
    absentTupleResponse.status,
    404,
    `absent foreign tuple must be hidden: ${absentTupleBody}`,
  );
  assert.equal(
    existingTupleResponse.status,
    404,
    `existing foreign tuple must be indistinguishable from absent tuple; existing=${existingTupleBody}; absent=${absentTupleBody}`,
  );
  assert.equal(missingCallResponse.status, 404);
  assert.equal(existingTupleBody, absentTupleBody);
  assert.equal(existingTupleBody, missingCallBody);
  assert.deepEqual(JSON.parse(existingTupleBody), {
    error: "Call session not found in this brokerage.",
    code: "CALL_NOT_FOUND",
  });
  // Per-request correlation IDs/dates vary independently of resource existence.
  for (const header of ["content-type", "content-length", "etag", "cache-control", "server-timing"]) {
    assert.equal(existingTupleResponse.headers.get(header), absentTupleResponse.headers.get(header), header);
    assert.equal(existingTupleResponse.headers.get(header), missingCallResponse.headers.get(header), header);
  }
});

test("same-brokerage non-owner POST transcription is denied with no row data and no owner-row mutation in any state", async () => {
  let providerCalls = 0;
  let draftCalls = 0;
  setCallTranscriptionProviderForTests({
    name: "mock",
    async transcribe() {
      providerCalls += 1;
      return { provider: "mock", transcript: "must not be produced", durationSeconds: null, latencyMs: 1 };
    },
  });
  setCallTranscriptionDraftGatewayForTests(async () => {
    draftCalls += 1;
    throw new Error("must not be called");
  });
  try {
    for (const state of ["AWAITING_AGENT_REVIEW", "APPROVED", "PENDING", "TRANSCRIBING"] as const) {
      const fixture = await createFixture();
      await db.update(growCallTranscriptions).set({
        processingState: state,
        retryCount: state === "TRANSCRIBING" ? 1 : 0,
        approvedBy: state === "APPROVED" ? A.agent.user.id : null,
        approvedAt: state === "APPROVED" ? new Date() : null,
      }).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
      const snapshot = async () => db.select({
        row: growCallTranscriptions,
        updatedAtToken: sql<string>`${growCallTranscriptions.updatedAt}::text`,
      }).from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
      const before = await snapshot();
      const response = await fetch(url(`/${fixture.sessionId}/transcription`), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: other.cookie },
        body: JSON.stringify({ recordingReference: fixture.versionId }),
      });
      const text = await response.text();
      assert.equal(response.status, 403, `${state}: ${text}`);
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.equal(body.code, "ACCESS_DENIED");
      assert.deepEqual(Object.keys(body).sort(), ["code", "error"], state);
      assert.doesNotMatch(text, /Route machine|Route point|Route commitment|Route follow-up|transcript"|draft/i, state);
      assert.deepEqual(await snapshot(), before, `${state} owner row must be byte-identical`);
      assert.equal((await activitiesFor(fixture.transcriptionId)).length, 0);
    }
    assert.equal(providerCalls, 0);
    assert.equal(draftCalls, 0);
  } finally {
    setCallTranscriptionProviderForTests(null);
    setCallTranscriptionDraftGatewayForTests(null);
  }
});

test("partial approval snapshots only approved content, including edited and manual items", async () => {
  await createFixture();
  const reviewState = [
    { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
    { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Edited approved summary." },
    { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED", editedText: "Edited point." },
    { itemType: "KEY_POINT", itemId: "manual-added", decision: "APPROVED", editedText: "Manual approved point." },
    { itemType: "COMMITMENT", itemId: "com-1", decision: "REJECTED", editedText: "Rejected commitment must not leak." },
    { itemType: "FOLLOWUP", itemId: "fu-1", decision: "REJECTED", editedText: "Rejected follow-up must not leak." },
  ];
  const response = await saveReview(reviewState);
  assert.equal(response.status, 200, await response.text());
  const [reviewed] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixtureId));
  assert.equal(reviewed!.processingState, "PARTIALLY_APPROVED");
  const [activity] = await activitiesFor(fixtureId);
  assert.ok(activity);
  assert.deepEqual((activity.details as { approvedContent: unknown }).approvedContent, {
    summary: "Edited approved summary.",
    keyPoints: [
      { id: "kp-1", text: "Edited point." },
      { id: "manual-added", text: "Manual approved point." },
    ],
    commitments: [],
    followups: [],
  });
  assert.doesNotMatch(activity.summary, /Rejected commitment|Rejected follow-up/);
});

test("a review with only the required transcript approved creates an empty approved subset", async () => {
  await createFixture();
  const rejected = [
    { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Human transcript." },
    { itemType: "SUMMARY", itemId: "summary", decision: "REJECTED", editedText: "Rejected summary." },
    { itemType: "KEY_POINT", itemId: "kp-1", decision: "REJECTED", editedText: "Rejected point." },
    { itemType: "COMMITMENT", itemId: "com-1", decision: "REJECTED", editedText: "Rejected commitment." },
    { itemType: "FOLLOWUP", itemId: "fu-1", decision: "REJECTED", editedText: "Rejected follow-up." },
  ];
  const response = await saveReview(rejected);
  assert.equal(response.status, 200, await response.text());
  const [reviewed] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixtureId));
  assert.equal(reviewed!.processingState, "PARTIALLY_APPROVED");
  const [activity] = await activitiesFor(fixtureId);
  assert.ok(activity);
  assert.deepEqual((activity.details as { approvedContent: unknown }).approvedContent, {
    summary: null, keyPoints: [], commitments: [], followups: [],
  });
  assert.doesNotMatch(activity.summary, /Human transcript|Rejected/);
});

test("sequential and concurrent duplicate saves produce exactly one Timeline entry", async () => {
  await createFixture();
  const first = await saveReview(fullReviewState());
  assert.equal(first.status, 200, await first.text());
  const duplicate = await saveReview(fullReviewState());
  assert.equal(duplicate.status, 409);
  assert.equal((await activitiesFor(fixtureId)).length, 1);

  await createFixture();
  const responses = await Promise.all([saveReview(fullReviewState()), saveReview(fullReviewState())]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.equal(responses.filter((response) => response.status === 409).length, 1);
  assert.equal((await activitiesFor(fixtureId)).length, 1);
});

test("failed Timeline persistence rolls back approval and leaves no activity", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    saveCallTranscriptionReview({
      brokerageId,
      callSessionId: fixture.sessionId,
      transcriptionId: fixture.transcriptionId,
      actor: { userId: A.agent.user.id, role: A.agent.user.role, brokerageId },
      body: { reviewState: fullReviewState() },
    }, async (tx, row) => {
      await persistApprovedCallSummaryActivity(tx, row);
      throw new Error("injected Timeline failure");
    }),
    /injected Timeline failure/,
  );
  const [row] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(row!.processingState, "AWAITING_AGENT_REVIEW");
  assert.equal((await activitiesFor(fixture.transcriptionId)).length, 0);
  const retry = await saveReview(fullReviewState(), fixture.sessionId, fixture.transcriptionId);
  assert.equal(retry.status, 200, await retry.text());
  assert.equal((await activitiesFor(fixture.transcriptionId)).length, 1);
});

test("approved Timeline snapshot remains independently deletable from recording, transcript, AI draft, and source rows", async () => {
  const fixture = await createFixture();
  const response = await saveReview(fullReviewState(), fixture.sessionId, fixture.transcriptionId);
  assert.equal(response.status, 200, await response.text());
  const [beforeActivity] = await activitiesFor(fixture.transcriptionId);
  assert.ok(beforeActivity);
  // The review fixture intentionally grants only the transcription entitlement.
  // Grant the read entitlement locally because this test also verifies the
  // independent Contact 360 Timeline projection; production auth remains
  // unchanged.
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.contacts.read",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
  const beforeContact = await fetch(contactUrl(`/${fixture.partyId}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(beforeContact.status, 200);
  const beforeContactBody = await beforeContact.json();

  // Destroy the recording object first while retaining the transcript and AI
  // draft, proving the approved Timeline snapshot is not backed by playable
  // recording storage.
  await db.update(documentObjectVersions).set({ objectStatus: "Destroyed", destroyedAt: new Date() })
    .where(eq(documentObjectVersions.id, fixture.versionId));
  assert.deepEqual(await activitiesFor(fixture.transcriptionId), [beforeActivity]);
  const [afterRecordingDeletion] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(afterRecordingDeletion!.transcript, null);
  assert.equal(afterRecordingDeletion!.recordingReference, null);
  assert.equal(afterRecordingDeletion!.draftSummary, "Route machine summary.");
  assert.doesNotMatch(JSON.stringify(beforeActivity), /Route machine transcript/);

  // Redact only the provider transcript; AI candidates still exist and the
  // approved passive snapshot remains byte-for-byte unchanged.
  await db.update(growCallTranscriptions).set({ transcript: null })
    .where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.deepEqual(await activitiesFor(fixture.transcriptionId), [beforeActivity]);
  const [afterTranscriptDeletion] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.equal(afterTranscriptDeletion!.transcript, null);
  assert.equal(afterTranscriptDeletion!.draftSummary, "Route machine summary.");

  // Independently redact AI candidates/review decisions after the provider
  // transcript has gone.
  await db.update(growCallTranscriptions).set({
    draftSummary: null, draftKeyPoints: null, draftCommitments: null,
    draftFollowups: null, reviewState: [], processingState: "DELETED",
  }).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.deepEqual(await activitiesFor(fixture.transcriptionId), [beforeActivity]);

  // Finally delete each actual source row in FK order. The Timeline activity
  // has no FK to any transient source and remains queryable after each delete.
  await db.delete(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcriptionId));
  assert.deepEqual(await activitiesFor(fixture.transcriptionId), [beforeActivity]);
  await db.delete(documentObjectVersions).where(eq(documentObjectVersions.id, fixture.versionId));
  await db.delete(documents).where(eq(documents.id, fixture.documentId));
  assert.deepEqual(await activitiesFor(fixture.transcriptionId), [beforeActivity]);
  await db.delete(growCallSessions).where(eq(growCallSessions.id, fixture.sessionId));
  const [afterDeletion] = await activitiesFor(fixture.transcriptionId);
  assert.deepEqual(afterDeletion, beforeActivity);
  const afterContact = await fetch(contactUrl(`/${fixture.partyId}`), { headers: { cookie: A.agent.cookie } });
  assert.equal(afterContact.status, 200);
  const afterContactBody = await afterContact.json();

  // AE GROW Completion W3-A (A-6): Contact 360 now also returns a
  // `contactability` block, and its consent evaluation is computed at READ
  // time (the consent rules depend on the instant — expiry, review dates, the
  // policy's contact window). Two reads therefore carry different
  // evaluatedAt stamps and the body is legitimately no longer byte-identical.
  // The subject of this test is unaffected, so it still compares everything
  // else exactly, and compares the consent block with only those read-time
  // stamps normalised — deleting a recording, a transcript or an AI draft must
  // not change one recorded fact about whether this contact may be contacted.
  const withoutReadTime = (body: unknown) =>
    JSON.parse(
      JSON.stringify((body as { contactability: unknown }).contactability).replace(
        /"evaluatedAt":"[^"]*"/g,
        '"evaluatedAt":"<read time>"',
      ),
    );
  const { contactability: _beforeContactability, ...beforeRest } = beforeContactBody as { contactability: unknown };
  const { contactability: _afterContactability, ...afterRest } = afterContactBody as { contactability: unknown };
  assert.deepEqual(afterRest, beforeRest);
  assert.deepEqual(withoutReadTime(afterContactBody), withoutReadTime(beforeContactBody));
});

test("manual activity creation rejects call_summary and creates zero rows", async () => {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey: "grow.activities.manage",
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
  const before = await db.select().from(growActivities).where(and(
    eq(growActivities.brokerageId, brokerageId),
    eq(growActivities.activityType, "call_summary"),
  ));
  const response = await fetch(growUrl("/activities"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ activityType: "call_summary", summary: "Forged summary." }),
  });
  assert.equal(response.status, 400, await response.text());
  const after = await db.select().from(growActivities).where(and(
    eq(growActivities.brokerageId, brokerageId),
    eq(growActivities.activityType, "call_summary"),
  ));
  assert.equal(after.length, before.length);
});

test("call_summary Timeline activities have no foreign key to transient call sources", async () => {
  const result = await db.execute(sql`
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'grow_activities'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name IN ('grow_call_transcriptions', 'grow_call_sessions', 'document_object_versions')
  `);
  assert.equal(result.rows.length, 0);
});