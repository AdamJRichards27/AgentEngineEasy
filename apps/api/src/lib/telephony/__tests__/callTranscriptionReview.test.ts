import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  brokerages,
  db,
  documentObjectVersions,
  documents,
  entitlementGrants,
  growActivities,
  growCallSessions,
  growCallTranscriptions,
  parties,
  users,
} from "@aee/db";
import { invalidateEntitlementCache } from "../../entitlements/resolver.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";
import {
  CallTranscriptionReviewError,
  discardCallTranscription,
  getCallTranscriptionForReview,
  listCallTranscriptionsForContact,
  saveCallTranscriptionReview,
} from "../callTranscriptionReview.js";
import { setCallTranscriptionAuditFailureForTests } from "../callTranscriptions.js";
import { persistApprovedCallSummaryActivity } from "../callTranscriptionTimeline.js";

let brokerageId: number;
let foreignBrokerageId: number;
let ownerId: number;
let otherAgentId: number;
let ownerPartyId: number;
let ownerRole = "Agent";
let foreignOwnerId: number;
let fixtureNumber = 0;

const actor = () => ({ userId: ownerId, role: ownerRole, brokerageId });
const review = (items: Array<Record<string, unknown>>) => ({ reviewState: items });
const transcriptReview = (text = "Human reviewed transcript.") => ({
  itemType: "TRANSCRIPT", itemId: "transcript", decision: "APPROVED", editedText: text,
});

async function createFixture(options: {
  summary?: string | null;
  keyPoints?: Array<{ id: string; text: string }>;
  commitments?: Array<{ id: string; text: string }>;
  followups?: Array<{ id: string; text: string }>;
  processingState?: "AWAITING_AGENT_REVIEW" | "APPROVED" | "PARTIALLY_APPROVED";
} = {}) {
  fixtureNumber += 1;
  const [party] = await db.insert(parties).values({
    brokerageId, firstName: "Review", lastName: `Fixture ${fixtureNumber}`,
  }).returning();
  const [session] = await db.insert(growCallSessions).values({
    brokerageId, partyId: party!.id, initiatedByUserId: ownerId,
    destinationRaw: "+61400111222", destinationNormalized: "+61400111222",
    destinationCountry: "AU", provider: "synthetic", status: "CONNECTED",
  }).returning();
  const key = `review-test-${brokerageId}-${fixtureNumber}`;
  const [document] = await db.insert(documents).values({
    brokerageId, logicalOwnerType: "telephony-call", logicalOwnerId: session!.id,
    documentType: "CallRecording", title: "Synthetic call recording",
    status: "Generated", objectStorageKey: key,
  }).returning();
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document!.id, brokerageId, storageObjectKey: key, version: 1,
    originalFilename: "recording.wav", displayFilename: "recording.wav",
    declaredMimeType: "audio/wav", detectedMimeType: "audio/wav", byteSize: 1,
    contentSha256: "0".repeat(64), source: "upload", objectStatus: "Active",
    uploadedBy: ownerId,
  }).returning();
  const [transcription] = await db.insert(growCallTranscriptions).values({
    brokerageId, callSessionId: session!.id, partyId: party!.id,
    recordingReference: version!.id, processingState: options.processingState ?? "AWAITING_AGENT_REVIEW",
    transcript: "Original machine transcript.",
    draftSummary: options.summary === undefined ? "Machine summary." : options.summary,
    draftKeyPoints: options.keyPoints ?? [{ id: "kp-1", text: "Machine key point." }],
    draftCommitments: options.commitments ?? [{ id: "com-1", text: "Machine commitment." }],
    draftFollowups: options.followups ?? [{ id: "fu-1", text: "Machine follow-up." }],
  }).returning();
  return { party: party!, session: session!, document: document!, version: version!, transcription: transcription! };
}

before(async () => {
  const [brokerage] = await db.insert(brokerages).values({ name: `Review test ${Date.now()}` }).returning();
  brokerageId = brokerage!.id;
  const [owner] = await db.insert(users).values({
    authProviderId: `review-owner-${brokerageId}`, email: `review-owner-${brokerageId}@test.invalid`,
    firstName: "Review", lastName: "Owner", role: "Agent", brokerageId,
  }).returning();
  ownerId = owner!.id;
  const [other] = await db.insert(users).values({
    authProviderId: `review-other-${brokerageId}`, email: `review-other-${brokerageId}@test.invalid`,
    firstName: "Review", lastName: "Other", role: "Agent", brokerageId,
  }).returning();
  otherAgentId = other!.id;
  const [foreign] = await db.insert(brokerages).values({ name: `Foreign review test ${Date.now()}` }).returning();
  foreignBrokerageId = foreign!.id;
  const [foreignUser] = await db.insert(users).values({
    authProviderId: `review-foreign-${foreignBrokerageId}`, email: `review-foreign-${foreignBrokerageId}@test.invalid`,
    firstName: "Foreign", lastName: "Owner", role: "Agent", brokerageId: foreignBrokerageId,
  }).returning();
  foreignOwnerId = foreignUser!.id;
  await db.insert(entitlementGrants).values([
    { brokerageId, entitlementKey: "grow.calling.transcription", granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" },
    { brokerageId: foreignBrokerageId, entitlementKey: "grow.calling.transcription", granteeType: "brokerage", granteeId: foreignBrokerageId, sourceType: "manual", status: "Active" },
  ]);
  invalidateEntitlementCache(brokerageId);
  invalidateEntitlementCache(foreignBrokerageId);
  const fixture = await createFixture();
  ownerPartyId = fixture.party.id;
});

after(async () => {
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.brokerageId, [brokerageId, foreignBrokerageId]));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.brokerageId, [brokerageId, foreignBrokerageId]));
  await db.delete(documents).where(inArray(documents.brokerageId, [brokerageId, foreignBrokerageId]));
  await cleanupBrokerages([brokerageId, foreignBrokerageId]);
});

test("full approval, partial mixed decisions, manual items, transcript edits, and AI-off transcript-only review", async () => {
  const full = await createFixture({ summary: null, keyPoints: [], commitments: [], followups: [] });
  const saved = await saveCallTranscriptionReview({
    brokerageId, callSessionId: full.session.id, transcriptionId: full.transcription.id, actor: actor(),
    body: review([transcriptReview("Edited transcript.")]),
  });
  assert.equal(saved.processingState, "APPROVED");
  assert.equal(saved.approvedBy, ownerId);
  assert.ok(saved.approvedAt);
  assert.equal(saved.transcript, "Original machine transcript.");

  const mixed = await createFixture();
  const mixedSaved = await saveCallTranscriptionReview({
    brokerageId, callSessionId: mixed.session.id, transcriptionId: mixed.transcription.id, actor: actor(),
    body: review([
      transcriptReview(),
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Kept summary." },
      { itemType: "KEY_POINT", itemId: "kp-1", decision: "REJECTED", editedText: "Machine key point.", rejectionReason: "Not supported." },
      { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
      { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
      { itemType: "KEY_POINT", itemId: "manual-extra", decision: "REJECTED", editedText: "Rejected manual item." },
    ]),
  });
  assert.equal(mixedSaved.processingState, "PARTIALLY_APPROVED");
  assert.equal(mixedSaved.reviewState.every((item) => item.reviewedByUserId === ownerId && item.reviewedAt), true);

  const allRejected = await createFixture();
  const allRejectedSaved = await saveCallTranscriptionReview({
    brokerageId, callSessionId: allRejected.session.id, transcriptionId: allRejected.transcription.id, actor: actor(),
    body: review([
      transcriptReview(),
      { itemType: "SUMMARY", itemId: "summary", decision: "REJECTED", editedText: "Machine summary." },
      { itemType: "KEY_POINT", itemId: "kp-1", decision: "REJECTED", editedText: "Machine key point." },
      { itemType: "COMMITMENT", itemId: "com-1", decision: "REJECTED", editedText: "Machine commitment." },
      { itemType: "FOLLOWUP", itemId: "fu-1", decision: "REJECTED", editedText: "Machine follow-up." },
    ]),
  });
  assert.equal(allRejectedSaved.processingState, "PARTIALLY_APPROVED");
});

test("save is atomic, preserves raw transcript/drafts, writes only the review columns plus updatedAt, and discard only changes processing state and updatedAt", async () => {
  const fixture = await createFixture();
  const before = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcription.id));
  const saved = await saveCallTranscriptionReview({
    brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: actor(),
    body: review([
      transcriptReview("Human text"),
      { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Human summary" },
      { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
      { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
      { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
    ]),
  });
  assert.equal(saved.transcript, before[0]!.transcript);
  assert.deepEqual(saved.draftKeyPoints, before[0]!.draftKeyPoints);
  assert.deepEqual(saved.draftCommitments, before[0]!.draftCommitments);
  assert.deepEqual(saved.draftFollowups, before[0]!.draftFollowups);
  assert.equal(saved.draftSummary, before[0]!.draftSummary);
  const discardedFixture = await createFixture();
  const discardBefore = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, discardedFixture.transcription.id));
  const discarded = await discardCallTranscription({
    brokerageId, callSessionId: discardedFixture.session.id, transcriptionId: discardedFixture.transcription.id,
    actor: actor(), body: {},
  });
  assert.equal(discarded.processingState, "DISCARDED");
  assert.deepEqual(discarded.reviewState, discardBefore[0]!.reviewState);
  assert.equal(discarded.approvedBy, discardBefore[0]!.approvedBy);
  assert.equal(discarded.transcript, discardBefore[0]!.transcript);
  assert.deepEqual(discarded.draftKeyPoints, discardBefore[0]!.draftKeyPoints);
});

test("rejects pending/duplicate/unknown/forged metadata/incomplete/invalid reviews and terminal replay", async () => {
  const fixture = await createFixture();
  const valid = [transcriptReview(), { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED" },
    { itemType: "KEY_POINT", itemId: "kp-1", decision: "APPROVED" },
    { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
    { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" }];
  const cases = [
    [...valid.slice(0, 1), { itemType: "SUMMARY", itemId: "summary", decision: "PENDING" }],
    [...valid, valid[1]!],
    [transcriptReview(), { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED" }, { itemType: "KEY_POINT", itemId: "unknown", decision: "APPROVED" }],
    [{ ...transcriptReview(), reviewedByUserId: otherAgentId }],
    [...valid.slice(0, 1), { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED" }],
    [...valid, { itemType: "KEY_POINT", itemId: "manual-empty", decision: "REJECTED", editedText: "" }],
    [{ ...transcriptReview(), itemType: "BAD" }],
  ];
  for (const items of cases) {
    await assert.rejects(
      saveCallTranscriptionReview({ brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: actor(), body: review(items) }),
      (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "INVALID_INPUT",
    );
  }
  const terminal = await createFixture({ processingState: "APPROVED" });
  await assert.rejects(
    saveCallTranscriptionReview({ brokerageId, callSessionId: terminal.session.id, transcriptionId: terminal.transcription.id, actor: actor(), body: review(valid) }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "TERMINAL",
  );
});

test("enforces owner, tenant, cross-call, entitlement, read isolation, and concurrent replay safety", async () => {
  const fixture = await createFixture();
  const otherActor = { userId: otherAgentId, role: "Agent", brokerageId };
  await assert.rejects(
    getCallTranscriptionForReview({ brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: otherActor }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "ACCESS_DENIED",
  );
  await assert.rejects(
    getCallTranscriptionForReview({ brokerageId: foreignBrokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: { userId: foreignOwnerId, role: "Agent", brokerageId: foreignBrokerageId } }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "NOT_FOUND",
  );
  const list = await listCallTranscriptionsForContact({ brokerageId, partyId: ownerPartyId, actor: actor() });
  assert.equal(list.some((row) => row.id === fixture.transcription.id), false, "fixture belongs to another call/party and must not leak");
  const race = await createFixture({ summary: null, keyPoints: [], commitments: [], followups: [] });
  const body = review([transcriptReview()]);
  const results = await Promise.allSettled([
    saveCallTranscriptionReview({ brokerageId, callSessionId: race.session.id, transcriptionId: race.transcription.id, actor: actor(), body }),
    discardCallTranscription({ brokerageId, callSessionId: race.session.id, transcriptionId: race.transcription.id, actor: actor(), body: {} }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("source-unavailable read labels override an earlier provider failure without changing the artefact", async () => {
  for (const objectStatus of ["SoftDeleted", "Quarantined"] as const) {
    const fixture = await createFixture();
    await db.update(growCallTranscriptions).set({
      processingState: "FAILED", failureReason: "PROVIDER_FAILED", lastError: "PROVIDER_FAILED",
    }).where(eq(growCallTranscriptions.id, fixture.transcription.id));
    await db.update(documentObjectVersions).set({ objectStatus })
      .where(eq(documentObjectVersions.id, fixture.version.id));
    const read = await getCallTranscriptionForReview({
      brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: actor(),
    });
    assert.equal(read?.failureReason, objectStatus === "SoftDeleted" ? "RECORDING_DELETED" : "RECORDING_UNAVAILABLE");
    assert.equal(read?.transcript, null);
    const [persisted] = await db.select().from(growCallTranscriptions)
      .where(eq(growCallTranscriptions.id, fixture.transcription.id));
    assert.equal(persisted?.failureReason, "PROVIDER_FAILED");
    assert.equal(persisted?.transcript, fixture.transcription.transcript);
  }
});

test("keeps authorized reads visible but redacts transcript data when the source is deleted, and rejects source/caller mismatches", async () => {
  const deleted = await createFixture();
  await db.update(documentObjectVersions).set({ objectStatus: "SoftDeleted", deletedAt: new Date() })
    .where(eq(documentObjectVersions.id, deleted.version.id));
  const read = await getCallTranscriptionForReview({
    brokerageId, callSessionId: deleted.session.id, transcriptionId: deleted.transcription.id, actor: actor(),
  });
  assert.equal(read?.processingState, "FAILED");
  assert.equal(read?.failureReason, "RECORDING_DELETED");
  assert.equal(read?.transcript, null);
  assert.equal(read?.draftSummary, null);
  assert.deepEqual(read?.reviewState, []);

  const mismatched = await createFixture();
  const [otherParty] = await db.insert(parties).values({ brokerageId, firstName: "Wrong", lastName: "Party" }).returning();
  await db.update(growCallTranscriptions).set({ partyId: otherParty!.id })
    .where(eq(growCallTranscriptions.id, mismatched.transcription.id));
  await assert.rejects(
    getCallTranscriptionForReview({
      brokerageId, callSessionId: mismatched.session.id, transcriptionId: mismatched.transcription.id, actor: actor(),
    }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    getCallTranscriptionForReview({
      brokerageId: foreignBrokerageId, callSessionId: mismatched.session.id,
      transcriptionId: mismatched.transcription.id,
      actor: { userId: ownerId, role: ownerRole, brokerageId: foreignBrokerageId },
    }),
    (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "ACCESS_DENIED",
  );
});

/**
 * Independent-review remediation C: agent Save and Discard are strictly
 * audited inside the same transaction as the state mutation.
 */
async function reviewAudits(transcriptionId: number) {
  return db.select().from(auditLogs).where(and(
    eq(auditLogs.brokerageId, brokerageId),
    eq(auditLogs.recordType, "grow_call_transcription"),
    eq(auditLogs.recordId, String(transcriptionId)),
  ));
}

async function callSummaryActivities(transcriptionId: number) {
  return db.select().from(growActivities).where(and(
    eq(growActivities.brokerageId, brokerageId),
    eq(growActivities.source, "grow_call_transcriptions"),
    eq(growActivities.sourceId, String(transcriptionId)),
  ));
}

const mixedReview = () => review([
  transcriptReview("Sensitive edited transcript text."),
  { itemType: "SUMMARY", itemId: "summary", decision: "APPROVED", editedText: "Sensitive summary text." },
  { itemType: "KEY_POINT", itemId: "kp-1", decision: "REJECTED", rejectionReason: "Sensitive rejection reason." },
  { itemType: "COMMITMENT", itemId: "com-1", decision: "APPROVED" },
  { itemType: "FOLLOWUP", itemId: "fu-1", decision: "APPROVED" },
]);

test("save and discard each write exactly one strict audit row with ids, states, and decision counts only", async () => {
  const saved = await createFixture();
  const savedBefore = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, saved.transcription.id));
  const savedRow = await saveCallTranscriptionReview({
    brokerageId, callSessionId: saved.session.id, transcriptionId: saved.transcription.id, actor: actor(),
    body: mixedReview(),
  }, persistApprovedCallSummaryActivity);
  assert.equal(savedRow.processingState, "PARTIALLY_APPROVED");
  assert.ok(savedRow.updatedAt.getTime() >= savedBefore[0]!.updatedAt.getTime());
  assert.equal(savedRow.updatedAt.getTime(), savedRow.approvedAt!.getTime());
  const saveAudits = await reviewAudits(saved.transcription.id);
  assert.equal(saveAudits.length, 1);
  const saveAudit = saveAudits[0]!;
  assert.equal(saveAudit.action, "grow_call_transcription_review_saved");
  assert.equal(saveAudit.userId, ownerId);
  assert.equal(saveAudit.brokerageId, brokerageId);
  assert.equal(saveAudit.previousValue, "AWAITING_AGENT_REVIEW");
  assert.equal(saveAudit.providerReference, `call:${saved.session.id}:recording:${saved.version.id}`);
  assert.ok(saveAudit.createdAt);
  assert.deepEqual(JSON.parse(saveAudit.updatedValue!), {
    transcriptionId: saved.transcription.id,
    callSessionId: saved.session.id,
    partyId: saved.party.id,
    processingState: "PARTIALLY_APPROVED",
    decisionCounts: {
      approved: 4,
      rejected: 1,
      total: 5,
      byItemType: {
        TRANSCRIPT: { approved: 1, rejected: 0 },
        SUMMARY: { approved: 1, rejected: 0 },
        KEY_POINT: { approved: 0, rejected: 1 },
        COMMITMENT: { approved: 1, rejected: 0 },
        FOLLOWUP: { approved: 1, rejected: 0 },
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(saveAudit), /Sensitive|Machine|Fixture/);

  const discarded = await createFixture();
  const discardBefore = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, discarded.transcription.id));
  const discardedRow = await discardCallTranscription({
    brokerageId, callSessionId: discarded.session.id, transcriptionId: discarded.transcription.id, actor: actor(), body: {},
  });
  assert.equal(discardedRow.processingState, "DISCARDED");
  assert.ok(discardedRow.updatedAt.getTime() >= discardBefore[0]!.updatedAt.getTime());
  const discardAudits = await reviewAudits(discarded.transcription.id);
  assert.equal(discardAudits.length, 1);
  const discardAudit = discardAudits[0]!;
  assert.equal(discardAudit.action, "grow_call_transcription_discarded");
  assert.equal(discardAudit.userId, ownerId);
  assert.equal(discardAudit.brokerageId, brokerageId);
  assert.equal(discardAudit.previousValue, "AWAITING_AGENT_REVIEW");
  assert.deepEqual(JSON.parse(discardAudit.updatedValue!), {
    transcriptionId: discarded.transcription.id,
    callSessionId: discarded.session.id,
    partyId: discarded.party.id,
    processingState: "DISCARDED",
  });
  assert.doesNotMatch(JSON.stringify(discardAudit), /Machine|Fixture/);
});

test("a strict review audit outage rolls back save (including its Timeline snapshot) and discard", async () => {
  for (const operation of ["save", "discard"] as const) {
    const fixture = await createFixture();
    const [before] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcription.id));
    setCallTranscriptionAuditFailureForTests(
      operation === "save" ? "grow_call_transcription_review_saved" : "grow_call_transcription_discarded",
    );
    try {
      await assert.rejects(
        operation === "save"
          ? saveCallTranscriptionReview({
            brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: actor(),
            body: mixedReview(),
          }, persistApprovedCallSummaryActivity)
          : discardCallTranscription({
            brokerageId, callSessionId: fixture.session.id, transcriptionId: fixture.transcription.id, actor: actor(), body: {},
          }),
        (error: unknown) => error instanceof CallTranscriptionReviewError && error.code === "AUDIT_FAILURE",
      );
    } finally {
      setCallTranscriptionAuditFailureForTests(null);
    }
    const [after] = await db.select().from(growCallTranscriptions).where(eq(growCallTranscriptions.id, fixture.transcription.id));
    assert.deepEqual(after, before, `${operation} state must roll back`);
    assert.equal((await callSummaryActivities(fixture.transcription.id)).length, 0, `${operation} Timeline must roll back`);
    assert.equal((await reviewAudits(fixture.transcription.id)).length, 0, `${operation} audits must roll back`);
  }
  // Control: once the audit store recovers, Save commits state, Timeline, and audit together.
  const recovered = await createFixture();
  await saveCallTranscriptionReview({
    brokerageId, callSessionId: recovered.session.id, transcriptionId: recovered.transcription.id, actor: actor(),
    body: mixedReview(),
  }, persistApprovedCallSummaryActivity);
  assert.equal((await callSummaryActivities(recovered.transcription.id)).length, 1);
  assert.equal((await reviewAudits(recovered.transcription.id)).length, 1);
});
