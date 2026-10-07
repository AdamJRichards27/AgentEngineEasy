import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  brokerages,
  db,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growActivities,
  growCallRecordingConsents,
  growCallSessions,
  growCallTranscriptions,
  LIVE_NOTES_CONTENT_PURGE_SQL,
  LIVE_NOTES_PURGE_DRY_RUN_SQL,
  LIVE_NOTES_PURGE_MIGRATION_ID,
  LIVE_NOTES_RECORDING_SHA_BACKFILL_SQL,
  parties,
  users,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";
import {
  CallTranscriptionReviewError,
  saveCallTranscriptionReview,
} from "../callTranscriptionReview.js";

const brokerageIds: number[] = [];

async function brokerage(name: string) {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  brokerageIds.push(row!.id);
  return row!;
}

async function user(brokerageId: number, role = "Agent") {
  const [row] = await db.insert(users).values({
    authProviderId: `retention-${brokerageId}-${role}-${Date.now()}`,
    email: `retention-${brokerageId}-${Math.random().toString(16).slice(2)}@test.invalid`,
    firstName: "Retention",
    lastName: role,
    role,
    brokerageId,
  }).returning();
  return row!;
}

async function recording(brokerageId: number, ownerId: number, partyId: number, sha: string) {
  const [session] = await db.insert(growCallSessions).values({
    brokerageId,
    partyId,
    initiatedByUserId: ownerId,
    destinationRaw: "+61400111000",
    destinationNormalized: "+61400111000",
    destinationCountry: "AU",
    provider: "synthetic",
    status: "COMPLETED",
  }).returning();
  const key = `retention-${session!.id}-${sha.slice(0, 8)}`;
  const [document] = await db.insert(documents).values({
    brokerageId,
    logicalOwnerType: "telephony-call",
    logicalOwnerId: session!.id,
    documentType: "CallRecording",
    title: "Retained recording",
    status: "Generated",
    objectStorageKey: key,
  }).returning();
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id,
    brokerageId,
    storageObjectKey: key,
    version: 1,
    originalFilename: "recording.wav",
    displayFilename: "recording.wav",
    declaredMimeType: "audio/wav",
    detectedMimeType: "audio/wav",
    byteSize: 4,
    contentSha256: sha,
    source: "upload",
    objectStatus: "Active",
    uploadedBy: ownerId,
  }).returning();
  return { session: session!, document: document!, version: version! };
}

after(async () => {
  if (brokerageIds.length === 0) return;
  await db.delete(growActivities).where(inArray(growActivities.brokerageId, brokerageIds));
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, brokerageIds));
  await db.delete(growCallSessions).where(inArray(growCallSessions.brokerageId, brokerageIds));
  await db.delete(growCallRecordingConsents).where(inArray(growCallRecordingConsents.brokerageId, brokerageIds));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.brokerageId, brokerageIds));
  await db.delete(documents).where(inArray(documents.brokerageId, brokerageIds));
  await cleanupBrokerages(brokerageIds);
});

test("the historical purge migration is the next statement and includes the dry-run query", () => {
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../../packages/db/migrations",
  );
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"));
  const purgeFile = files.find((name) => name.startsWith("0034_"));
  assert.ok(purgeFile, "migration 0034 must exist");
  const sqlText = readFileSync(path.join(migrationsDir, purgeFile), "utf8");
  assert.match(sqlText, new RegExp(LIVE_NOTES_PURGE_MIGRATION_ID));
  assert.ok(sqlText.includes(LIVE_NOTES_RECORDING_SHA_BACKFILL_SQL));
  assert.ok(sqlText.includes(LIVE_NOTES_CONTENT_PURGE_SQL));
  assert.ok(sqlText.includes(LIVE_NOTES_PURGE_DRY_RUN_SQL));
  assert.match(sqlText, /does not delete object storage|does not delete storage objects/i);
});

test("historical purge keeps structured outputs, clears conversation content, and can be re-run", async () => {
  const tenant = await brokerage(`Retention purge ${Date.now()}`);
  const owner = await user(tenant.id);
  const [party] = await db.insert(parties).values({
    brokerageId: tenant.id, firstName: "Pat", lastName: "Held",
  }).returning();
  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId: tenant.id,
    partyId: party!.id,
    scope: "PER_CALL",
    status: "ACTIVE",
    source: "VERBAL_ON_CALL",
    capturedByUserId: owner.id,
  }).returning();
  const approvedRecording = await recording(tenant.id, owner.id, party!.id, "a".repeat(64));
  await db.update(growCallSessions).set({ recordingConsentId: consent!.id })
    .where(eq(growCallSessions.id, approvedRecording.session.id));
  const approvedAt = new Date("2026-01-02T00:00:00.000Z");
  const [approved] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: approvedRecording.session.id,
    partyId: party!.id,
    recordingReference: approvedRecording.version.id,
    processingState: "APPROVED",
    transcript: "Full conversation that must be removed.",
    draftSummary: "Kept summary.",
    draftKeyPoints: [{ id: "kp-1", text: "Kept point." }],
    draftCommitments: [{ id: "com-1", text: "Kept commitment." }],
    draftFollowups: [{ id: "fu-1", text: "Kept follow-up." }],
    reviewState: [
      { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Full conversation that must be removed.", reviewedByUserId: owner.id, reviewedAt: approvedAt.toISOString() },
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Kept summary.", reviewedByUserId: owner.id, reviewedAt: approvedAt.toISOString() },
    ],
    approvedBy: owner.id,
    approvedAt,
  }).returning();
  await db.insert(growActivities).values({
    brokerageId: tenant.id,
    partyId: party!.id,
    activityType: "call_summary",
    occurredAt: approvedAt,
    summary: "Kept summary.",
    details: { approvedContent: { summary: "Kept summary." } },
    responsibleUserId: owner.id,
    source: "grow_call_transcriptions",
    sourceId: String(approved!.id),
  });

  const discardedRecording = await recording(tenant.id, owner.id, party!.id, "b".repeat(64));
  const [discarded] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: discardedRecording.session.id,
    partyId: party!.id,
    recordingReference: discardedRecording.version.id,
    processingState: "DISCARDED",
    transcript: "Discarded conversation.",
    draftSummary: "Unapproved draft.",
  }).returning();

  const awaitingRecording = await recording(tenant.id, owner.id, party!.id, "c".repeat(64));
  const [awaiting] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: awaitingRecording.session.id,
    partyId: party!.id,
    recordingReference: awaitingRecording.version.id,
    processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Still waiting for a person.",
    draftSummary: "Draft still in review.",
  }).returning();

  const unconfirmedRecording = await recording(tenant.id, owner.id, party!.id, "d".repeat(64));
  const [unconfirmed] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: unconfirmedRecording.session.id,
    partyId: party!.id,
    recordingReference: unconfirmedRecording.version.id,
    processingState: "APPROVED",
    transcript: "Transcript with no structured output.",
    approvedBy: owner.id,
    approvedAt,
    reviewState: [
      { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Transcript with no structured output.", reviewedByUserId: owner.id, reviewedAt: approvedAt.toISOString() },
    ],
  }).returning();

  const failedRecording = await recording(tenant.id, owner.id, party!.id, "e".repeat(64));
  const [failed] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: failedRecording.session.id,
    partyId: party!.id,
    recordingReference: failedRecording.version.id,
    processingState: "FAILED",
    transcript: "Failed before any notes were kept.",
    failureReason: "PROVIDER_FAILED",
  }).returning();

  const scoped = (statement: string) => sql.raw(`${statement}\nAND transcription.brokerage_id = ${tenant.id}`);
  await db.execute(scoped(LIVE_NOTES_RECORDING_SHA_BACKFILL_SQL));
  await db.execute(scoped(LIVE_NOTES_CONTENT_PURGE_SQL));

  const [purgedApproved] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, approved!.id));
  assert.equal(purgedApproved?.transcript, null);
  assert.equal(purgedApproved?.recordingReference, null);
  assert.equal(purgedApproved?.recordingContentSha256, "a".repeat(64));
  assert.equal(purgedApproved?.draftSummary, "Kept summary.");
  assert.deepEqual(purgedApproved?.draftKeyPoints, [{ id: "kp-1", text: "Kept point." }]);
  assert.deepEqual(purgedApproved?.draftCommitments, [{ id: "com-1", text: "Kept commitment." }]);
  assert.deepEqual(purgedApproved?.draftFollowups, [{ id: "fu-1", text: "Kept follow-up." }]);
  assert.equal(purgedApproved?.approvedBy, owner.id);
  assert.equal(purgedApproved?.approvedAt?.toISOString(), approvedAt.toISOString());
  assert.equal(purgedApproved?.processingState, "APPROVED");
  const transcriptItem = purgedApproved?.reviewState.find((item) => item.itemType === "TRANSCRIPT");
  const summaryItem = purgedApproved?.reviewState.find((item) => item.itemType === "SUMMARY");
  assert.equal(transcriptItem?.decision, "APPROVED");
  assert.equal(transcriptItem?.editedText, null);
  assert.equal(transcriptItem?.reviewedByUserId, owner.id);
  assert.equal(summaryItem?.editedText, "Kept summary.");
  assert.equal(purgedApproved?.retentionAudit?.purgeMigrationId, LIVE_NOTES_PURGE_MIGRATION_ID);
  assert.equal(purgedApproved?.retentionAudit?.transcriptCharCount, "Full conversation that must be removed.".length);
  assert.equal(typeof purgedApproved?.retentionAudit?.purgedAt, "string");
  const [activity] = await db.select().from(growActivities).where(and(
    eq(growActivities.sourceId, String(approved!.id)),
    eq(growActivities.activityType, "call_summary"),
  ));
  assert.equal(activity?.summary, "Kept summary.");
  const [consentAfter] = await db.select().from(growCallRecordingConsents).where(eq(growCallRecordingConsents.id, consent!.id));
  assert.deepEqual(consentAfter, consent);
  const [versionAfter] = await db.select().from(documentObjectVersions).where(eq(documentObjectVersions.id, approvedRecording.version.id));
  assert.equal(versionAfter?.objectStatus, "Active");
  assert.equal(versionAfter?.storageObjectKey, approvedRecording.version.storageObjectKey);
  assert.equal(versionAfter?.contentSha256, "a".repeat(64));

  const [purgedDiscard] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, discarded!.id));
  assert.equal(purgedDiscard?.processingState, "DISCARDED");
  assert.equal(purgedDiscard?.transcript, null);
  assert.equal(purgedDiscard?.recordingReference, null);
  assert.equal(purgedDiscard?.draftSummary, "Unapproved draft.");
  assert.equal(purgedDiscard?.retentionAudit?.purgeMigrationId, LIVE_NOTES_PURGE_MIGRATION_ID);

  const [heldReview] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, awaiting!.id));
  assert.equal(heldReview?.transcript, "Still waiting for a person.");
  assert.equal(heldReview?.recordingReference, awaitingRecording.version.id);
  assert.equal(heldReview?.retentionAudit?.purgeMigrationId, undefined);

  const [heldUnconfirmed] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, unconfirmed!.id));
  assert.equal(heldUnconfirmed?.transcript, "Transcript with no structured output.");
  assert.equal(heldUnconfirmed?.recordingReference, unconfirmedRecording.version.id);
  assert.equal(heldUnconfirmed?.approvedBy, owner.id);

  const [heldFailed] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, failed!.id));
  assert.equal(heldFailed?.transcript, "Failed before any notes were kept.");
  assert.equal(heldFailed?.recordingReference, failedRecording.version.id);

  const purgedAt = purgedApproved?.retentionAudit?.purgedAt;
  await db.execute(scoped(LIVE_NOTES_CONTENT_PURGE_SQL));
  const [rerun] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, approved!.id));
  assert.equal(rerun?.retentionAudit?.purgedAt, purgedAt);
  assert.equal(rerun?.transcript, null);
  assert.equal(rerun?.updatedAt?.toISOString(), purgedApproved?.updatedAt?.toISOString());
  const [stillHeld] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, unconfirmed!.id));
  assert.equal(stillHeld?.transcript, "Transcript with no structured output.");
});

test("clearing conversation content does not relax entitlement, transcript approval, or consent", async () => {
  const tenant = await brokerage(`Retention gates ${Date.now()}`);
  const owner = await user(tenant.id);
  const [party] = await db.insert(parties).values({
    brokerageId: tenant.id, firstName: "Gate", lastName: "Check",
  }).returning();
  const source = await recording(tenant.id, owner.id, party!.id, "f".repeat(64));
  const [consent] = await db.insert(growCallRecordingConsents).values({
    brokerageId: tenant.id,
    partyId: party!.id,
    scope: "PER_CALL",
    status: "ACTIVE",
    source: "VERBAL_ON_CALL",
    capturedByUserId: owner.id,
  }).returning();
  await db.update(growCallSessions).set({ recordingConsentId: consent!.id })
    .where(eq(growCallSessions.id, source.session.id));
  const [row] = await db.insert(growCallTranscriptions).values({
    brokerageId: tenant.id,
    callSessionId: source.session.id,
    partyId: party!.id,
    recordingReference: source.version.id,
    processingState: "AWAITING_AGENT_REVIEW",
    transcript: "Conversation still under review.",
    draftSummary: "A note.",
  }).returning();
  const actor = { userId: owner.id, role: owner.role, brokerageId: tenant.id };
  invalidateEntitlementCache(tenant.id);
  await assert.rejects(
    saveCallTranscriptionReview({
      brokerageId: tenant.id,
      callSessionId: source.session.id,
      transcriptionId: row!.id,
      actor,
      body: { reviewState: [
        { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Conversation still under review." },
        { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "A note." },
      ] },
    }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "ENTITLEMENT_REQUIRED",
  );
  const [denied] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, row!.id));
  assert.equal(denied?.transcript, "Conversation still under review.");
  assert.equal(denied?.recordingReference, source.version.id);

  await db.insert(entitlementGrants).values({
    brokerageId: tenant.id,
    entitlementKey: "grow.calling.transcription",
    granteeType: "brokerage",
    granteeId: tenant.id,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(tenant.id);
  await assert.rejects(
    saveCallTranscriptionReview({
      brokerageId: tenant.id,
      callSessionId: source.session.id,
      transcriptionId: row!.id,
      actor,
      body: { reviewState: [
        { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "A note." },
      ] },
    }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "INVALID_INPUT",
  );
  const [stillOpen] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, row!.id));
  assert.equal(stillOpen?.processingState, "AWAITING_AGENT_REVIEW");
  assert.equal(stillOpen?.transcript, "Conversation still under review.");
  assert.equal(stillOpen?.approvedBy, null);

  await saveCallTranscriptionReview({
    brokerageId: tenant.id,
    callSessionId: source.session.id,
    transcriptionId: row!.id,
    actor,
    body: { reviewState: [
      { itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: "Conversation still under review." },
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "A note." },
    ] },
  });
  const [saved] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, row!.id));
  assert.equal(saved?.transcript, null);
  assert.equal(saved?.recordingReference, null);
  assert.equal(saved?.approvedBy, owner.id);
  assert.equal(saved?.draftSummary, "A note.");
  assert.equal(saved?.retentionAudit?.consentReference, consent!.id);
  const [consentAfter] = await db.select().from(growCallRecordingConsents).where(eq(growCallRecordingConsents.id, consent!.id));
  assert.deepEqual(consentAfter, consent);
  const [versionAfter] = await db.select().from(documentObjectVersions).where(eq(documentObjectVersions.id, source.version.id));
  assert.equal(versionAfter?.objectStatus, "Active");
});
