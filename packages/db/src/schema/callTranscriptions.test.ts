import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  brokerages,
  db,
  documentObjectVersions,
  documents,
  GROW_CALL_TRANSCRIPTION_PROCESSING_STATES,
  growCallSessions,
  growCallTranscriptions,
  parties,
  users,
} from "../index.js";

const documentedFailureReasons = [
  "RECORDING_UNAVAILABLE",
  "RECORDING_DELETED",
  "TRANSCRIPTION_TIMEOUT",
  "PROVIDER_ERROR",
  "MALFORMED_PROVIDER_RESPONSE",
  "PROCESSING_ABANDONED",
  "TENANT_MISMATCH",
  "ACCESS_DENIED",
  "ENTITLEMENT_REQUIRED",
  "INVALID_INPUT",
  "RECORDING_REFERENCE_MISMATCH",
  "F2_EVIDENCE_MISSING",
  "F2_EVIDENCE_INVALID",
  "CONSENT_WITHDRAWN",
  "LIVE_PROVIDER_DISABLED",
  "MISSING_PROVIDER_CREDENTIALS",
  "PROVIDER_CONFIGURATION_ERROR",
  "INVALID_AUDIO",
  "AUDIT_FAILURE",
] as const;

let brokerageId: number;
let userId: number;
let partyId: number;
let sessionId: number;
let documentId: number;
let versionId: number;
let transcriptionId: number;

before(async () => {
  const nonce = `${Date.now()}-${process.pid}`;
  const [brokerage] = await db.insert(brokerages).values({ name: `F3 schema ${nonce}` }).returning();
  assert.ok(brokerage);
  brokerageId = brokerage.id;
  const [user] = await db.insert(users).values({
    authProviderId: `f3-schema-${nonce}`,
    email: `f3-schema-${nonce}@example.test`,
    firstName: "F3",
    lastName: "Schema",
    role: "Agent",
    brokerageId,
  }).returning();
  assert.ok(user);
  userId = user.id;
  const [party] = await db.insert(parties).values({ brokerageId, firstName: "F3", lastName: "Caller" }).returning();
  assert.ok(party);
  partyId = party.id;
  const [session] = await db.insert(growCallSessions).values({
    brokerageId,
    partyId,
    initiatedByUserId: userId,
    destinationRaw: "+61400000000",
    destinationNormalized: "+61400000000",
    destinationCountry: "AU",
    provider: "synthetic",
    status: "COMPLETED",
  }).returning();
  assert.ok(session);
  sessionId = session.id;
  const [document] = await db.insert(documents).values({
    brokerageId,
    logicalOwnerType: "telephony-call",
    logicalOwnerId: sessionId,
    documentType: "CallRecordingMetadata",
    title: "F3 schema recording",
  }).returning();
  assert.ok(document);
  documentId = document.id;
  const [version] = await db.insert(documentObjectVersions).values({
    documentId,
    brokerageId,
    storageObjectKey: `f3-schema/${nonce}`,
    version: 1,
    originalFilename: "call.wav",
    displayFilename: "call.wav",
    declaredMimeType: "audio/wav",
    detectedMimeType: "audio/wav",
    byteSize: 4,
    contentSha256: "a".repeat(64),
    source: "telephony",
    metadata: { logicalOwner: { kind: "telephony-call", brokerageId, ownerId: sessionId } },
  }).returning();
  assert.ok(version);
  versionId = version.id;
});

after(async () => {
  if (transcriptionId) await db.delete(growCallTranscriptions).where(eq(growCallTranscriptions.id, transcriptionId));
  if (versionId) await db.delete(documentObjectVersions).where(eq(documentObjectVersions.id, versionId));
  if (documentId) await db.delete(documents).where(eq(documents.id, documentId));
  if (sessionId) await db.delete(growCallSessions).where(eq(growCallSessions.id, sessionId));
  if (partyId) await db.delete(parties).where(eq(parties.id, partyId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
  if (brokerageId) await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
});

test("F3 table defaults, F2 recording reference, JSONB arrays, and enumerated state storage match the schema contract", async () => {
  const [created] = await db.insert(growCallTranscriptions).values({
    brokerageId,
    callSessionId: sessionId,
    partyId,
    recordingReference: versionId,
  }).returning();
  assert.ok(created);
  transcriptionId = created.id;
  assert.equal(created.processingState, "PENDING");
  assert.equal(created.recordingReference, versionId);
  assert.equal(created.retryCount, 0);
  assert.deepEqual(created.reviewState, []);
  assert.equal(created.approvedBy, null);
  assert.equal(created.approvedAt, null);

  const jsonb = {
    draftKeyPoints: [{ id: "kp-1", text: "Point" }],
    draftCommitments: [{ id: "commitment-1", text: "Commitment", dueAt: null }],
    draftFollowups: [{ id: "followup-1", text: "Follow up" }],
    reviewState: [{
      itemType: "TRANSCRIPT" as const,
      itemId: "transcript",
      decision: "PENDING" as const,
      reviewedByUserId: null,
      reviewedAt: null,
    }],
  };
  const [withJsonb] = await db.update(growCallTranscriptions).set(jsonb)
    .where(eq(growCallTranscriptions.id, transcriptionId)).returning();
  assert.deepEqual(withJsonb?.draftKeyPoints, jsonb.draftKeyPoints);
  assert.deepEqual(withJsonb?.draftCommitments, jsonb.draftCommitments);
  assert.deepEqual(withJsonb?.draftFollowups, jsonb.draftFollowups);
  assert.deepEqual(withJsonb?.reviewState, jsonb.reviewState);

  for (const processingState of GROW_CALL_TRANSCRIPTION_PROCESSING_STATES) {
    const [row] = await db.update(growCallTranscriptions).set({ processingState })
      .where(eq(growCallTranscriptions.id, transcriptionId)).returning();
    assert.equal(row?.processingState, processingState);
  }
});

test("database rejects non-array JSONB and unknown processing states", async () => {
  const checkViolation = (error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === "23514" || (error as { code?: string }).code === "23514";
  };
  for (const column of ["draft_key_points", "draft_commitments", "draft_followups", "review_state"]) {
    await assert.rejects(db.execute(sql`
      update grow_call_transcriptions
      set ${sql.identifier(column)} = '{"not":"an array"}'::jsonb
      where id = ${transcriptionId}
    `), checkViolation, `${column} must reject an object with a CHECK violation`);
  }
  await assert.rejects(db.execute(sql`
    update grow_call_transcriptions
    set processing_state = 'NOT_A_REAL_STATE'
    where id = ${transcriptionId}
  `), checkViolation);
});

test("schema stores each documented failureReason on a terminal FAILED artifact", async () => {
  for (const failureReason of documentedFailureReasons) {
    const [row] = await db.update(growCallTranscriptions).set({
      processingState: "FAILED",
      failureReason,
    }).where(eq(growCallTranscriptions.id, transcriptionId)).returning();
    assert.equal(row?.processingState, "FAILED", failureReason);
    assert.equal(row?.failureReason, failureReason);
  }
});

test("call and immutable F2 recording tuple is idempotent at the database boundary", async () => {
  await assert.rejects(db.insert(growCallTranscriptions).values({
    brokerageId,
    callSessionId: sessionId,
    partyId,
    recordingReference: versionId,
  }), (error: unknown) => {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === "23505" || (error as { code?: string }).code === "23505";
  });
  const rows = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, transcriptionId));
  assert.equal(rows.length, 1);
});
