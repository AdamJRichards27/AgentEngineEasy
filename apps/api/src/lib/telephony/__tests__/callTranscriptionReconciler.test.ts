import assert from "node:assert/strict";
import { test } from "node:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  brokerages,
  db,
  documentObjectVersions,
  documents,
  growCallSessions,
  growCallTranscriptions,
  parties,
  users,
} from "@aee/db";
import { CALL_TRANSCRIPTION_STALE_AFTER_MS } from "../callTranscriptionPolicy.js";
import {
  configuredCallTranscriptionReconciliation,
  isCallTranscriptionTenantMismatch,
  reconcileAbandonedCallTranscriptions,
  setCallTranscriptionReconciliationBeforeTransitionForTests,
} from "../callTranscriptionReconciliation.js";
import { setCallTranscriptionAuditFailureForTests } from "../callTranscriptions.js";

let brokerageId: number;
let userId: number;
let partyId: number;
let fixtureAfterId = 0;
const createdSessionIds: number[] = [];
const createdDocumentIds: number[] = [];
const createdVersionIds: number[] = [];
const createdTranscriptionIds: number[] = [];

const now = new Date("2035-01-01T00:00:00.000Z");
const staleAt = new Date(now.getTime() - 20 * 60 * 1_000);
const freshAt = new Date(now.getTime() - 2 * 60 * 1_000);

async function source(options: {
  brokerage?: number;
  party?: number;
  status?: string;
  deletedAt?: Date;
} = {}): Promise<{ sessionId: number; versionId: number }> {
  const ownerBrokerage = options.brokerage ?? brokerageId;
  const ownerParty = options.party ?? partyId;
  const [session] = await db.insert(growCallSessions).values({
    brokerageId: ownerBrokerage,
    partyId: ownerParty,
    initiatedByUserId: userId,
    destinationRaw: "+61400000000",
    destinationNormalized: "+61400000000",
    destinationCountry: "AU",
    provider: "synthetic",
    status: "CONNECTED",
  }).returning();
  assert.ok(session);
  createdSessionIds.push(session.id);
  const [document] = await db.insert(documents).values({
    brokerageId: ownerBrokerage,
    logicalOwnerType: "telephony-call",
    logicalOwnerId: session.id,
    documentType: "CallRecordingMetadata",
    title: `Test call ${session.id}`,
  }).returning();
  assert.ok(document);
  createdDocumentIds.push(document.id);
  const [version] = await db.insert(documentObjectVersions).values({
    documentId: document.id,
    brokerageId: ownerBrokerage,
    storageObjectKey: `reconciliation-test/${document.id}`,
    version: 1,
    originalFilename: "call.txt",
    displayFilename: "call.txt",
    declaredMimeType: "text/plain",
    detectedMimeType: "text/plain",
    byteSize: 1,
    contentSha256: "a".repeat(64),
    source: "telephony",
    objectStatus: options.status ?? "Active",
    deletedAt: options.deletedAt,
    metadata: { logicalOwner: { kind: "telephony-call", brokerageId: ownerBrokerage, ownerId: session.id } },
  }).returning();
  assert.ok(version);
  createdVersionIds.push(version.id);
  return { sessionId: session.id, versionId: version.id };
}

async function artifact(
  state: "MEDIA_PROCESSING" | "TRANSCRIBING" | "PENDING" | "AWAITING_AGENT_REVIEW" | "APPROVED" | "FAILED",
  sourceRow: { sessionId: number; versionId: number },
  updatedAt = staleAt,
  retryCount: number | null = 0,
  brokerage = brokerageId,
  party = partyId,
): Promise<number> {
  const [row] = await db.insert(growCallTranscriptions).values({
    brokerageId: brokerage,
    callSessionId: sourceRow.sessionId,
    partyId: party,
    recordingReference: sourceRow.versionId,
    processingState: state,
    retryCount,
    updatedAt,
  }).returning();
  assert.ok(row);
  createdTranscriptionIds.push(row.id);
  return row.id;
}

async function row(id: number) {
  const [value] = await db.select().from(growCallTranscriptions)
    .where(eq(growCallTranscriptions.id, id));
  return value;
}

test.before(async () => {
  process.env.NODE_ENV = "test";
  const [brokerage] = await db.insert(brokerages).values({ name: `Reconciler ${Date.now()}` }).returning();
  assert.ok(brokerage);
  brokerageId = brokerage.id;
  const [user] = await db.insert(users).values({
    authProviderId: `reconciler-${brokerageId}`,
    email: `reconciler-${brokerageId}@example.test`,
    firstName: "Reconcile",
    lastName: "Test",
    role: "Agent",
    brokerageId,
  }).returning();
  assert.ok(user);
  userId = user.id;
  const [party] = await db.insert(parties).values({
    brokerageId,
    firstName: "Reconcile",
    lastName: "Caller",
  }).returning();
  assert.ok(party);
  partyId = party.id;
  const [latest] = await db.select({
    maxId: sql<number>`coalesce(max(${growCallTranscriptions.id}), 0)`,
  }).from(growCallTranscriptions);
  fixtureAfterId = Number(latest?.maxId ?? 0);
});

test("partial joins still prove a foreign tenant from every present relation", () => {
  const transcription = { brokerageId: 10, callSessionId: 20, partyId: 30 };
  assert.equal(isCallTranscriptionTenantMismatch({
    transcription,
    session: { id: 20, brokerageId: 99, partyId: 30 },
    party: null,
    version: null,
    document: null,
  }), true, "foreign call remains a tenant mismatch when later joins are absent");
  assert.equal(isCallTranscriptionTenantMismatch({
    transcription,
    session: null,
    party: { brokerageId: 99 },
    version: null,
    document: null,
  }), true, "foreign party remains a tenant mismatch when other joins are absent");
  assert.equal(isCallTranscriptionTenantMismatch({
    transcription,
    session: null,
    party: null,
    version: { brokerageId: 99, documentId: 40, metadata: null },
    document: null,
  }), true, "foreign version remains a tenant mismatch when document join is absent");
});

test.after(async () => {
  setCallTranscriptionAuditFailureForTests(null);
  setCallTranscriptionReconciliationBeforeTransitionForTests(null);
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.id, createdTranscriptionIds));
  await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.id, createdVersionIds));
  await db.delete(documents).where(inArray(documents.id, createdDocumentIds));
  await db.delete(growCallSessions).where(inArray(growCallSessions.id, createdSessionIds));
  await db.delete(parties).where(eq(parties.id, partyId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
});

test("defaults are bounded and stale media/transcribing rows fail with counters and audit", async () => {
  const configured = configuredCallTranscriptionReconciliation({
    CALL_TRANSCRIPTION_STALE_AFTER_MS: undefined,
    CALL_TRANSCRIPTION_RECONCILE_BATCH_SIZE: undefined,
    CALL_TRANSCRIPTION_RECONCILE_INTERVAL_MS: undefined,
  });
  assert.equal(configured.staleAfterMs, CALL_TRANSCRIPTION_STALE_AFTER_MS);
  const media = await artifact("MEDIA_PROCESSING", await source());
  const transcribing = await artifact("TRANSCRIBING", await source());
  const fresh = await artifact("TRANSCRIBING", await source(), freshAt);
  const microsecond = await artifact("TRANSCRIBING", await source());
  await db.update(growCallTranscriptions).set({
    updatedAt: sql`timestamp '2034-12-31 23:39:59.000456'`,
  }).where(eq(growCallTranscriptions.id, microsecond));
  const result = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId, batchSize: 100 });
  assert.deepEqual(
    {
      scanned: result.scanned,
      failedAbandoned: result.failedAbandoned,
      failedUnavailable: result.failedUnavailable,
      failedDeleted: result.failedDeleted,
      failedTenantMismatch: result.failedTenantMismatch,
    },
    { scanned: 3, failedAbandoned: 3, failedUnavailable: 0, failedDeleted: 0, failedTenantMismatch: 0 },
  );
  assert.equal((await row(media))?.processingState, "FAILED");
  assert.equal((await row(transcribing))?.failureReason, "PROCESSING_ABANDONED");
  assert.equal((await row(fresh))?.processingState, "TRANSCRIBING");
  assert.equal((await row(microsecond))?.processingState, "FAILED");
  const audits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.brokerageId, brokerageId),
    eq(auditLogs.recordType, "grow_call_transcription"),
  ));
  assert.equal(audits.filter((audit) => audit.updatedValue === "PROCESSING_ABANDONED").length, 3);
  assert.ok(audits.filter((audit) => audit.updatedValue === "PROCESSING_ABANDONED").every((audit) => audit.userId === null));
});

test("bounded ascending cursors do not starve rows and repeated sweeps are no-ops", async () => {
  const ids = await Promise.all([1, 2, 3].map(async () => artifact("TRANSCRIBING", await source())));
  ids.sort((a, b) => a - b);
  const first = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId, batchSize: 2 });
  assert.equal(first.scanned, 2);
  assert.equal(first.failedAbandoned, 2);
  assert.equal(first.nextCursor, ids[1]);
  const second = await reconcileAbandonedCallTranscriptions({ now, afterId: first.nextCursor!, batchSize: 2 });
  assert.equal(second.scanned, 1);
  assert.equal(second.failedAbandoned, 1);
  assert.equal(second.nextCursor, null);
  const repeat = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId, batchSize: 100 });
  assert.deepEqual(repeat, {
    scanned: 0,
    failedAbandoned: 0,
    failedUnavailable: 0,
    failedDeleted: 0,
    failedTenantMismatch: 0,
    skippedConcurrentTransition: 0,
    deferredTransitionError: 0,
    nextCursor: null,
  });
});

test("terminal review states are untouched and source deletion/unavailability have scoped reasons", async () => {
  const approved = await artifact("APPROVED", await source());
  const failed = await artifact("FAILED", await source());
  const deleted = await artifact("TRANSCRIBING", await source({ status: "SoftDeleted", deletedAt: staleAt }));
  const unavailable = await artifact("MEDIA_PROCESSING", await source({ status: "Quarantined" }));
  const result = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId });
  assert.equal(result.failedDeleted, 1);
  assert.equal(result.failedUnavailable, 1);
  assert.equal((await row(deleted))?.failureReason, "RECORDING_DELETED");
  assert.equal((await row(unavailable))?.failureReason, "RECORDING_UNAVAILABLE");
  assert.equal((await row(approved))?.processingState, "APPROVED");
  assert.equal((await row(failed))?.processingState, "FAILED");
});

test("foreign linkage only fails the own artifact and never writes the foreign tenant", async () => {
  const [foreignBrokerage] = await db.insert(brokerages).values({ name: `Reconciler foreign ${Date.now()}` }).returning();
  assert.ok(foreignBrokerage);
  const [foreignUser] = await db.insert(users).values({
    authProviderId: `reconciler-foreign-${foreignBrokerage.id}`,
    email: `reconciler-foreign-${foreignBrokerage.id}@example.test`,
    firstName: "Foreign",
    lastName: "Test",
    role: "Agent",
    brokerageId: foreignBrokerage.id,
  }).returning();
  assert.ok(foreignUser);
  const [foreignParty] = await db.insert(parties).values({ brokerageId: foreignBrokerage.id, firstName: "Foreign" }).returning();
  assert.ok(foreignParty);
  const foreign = await source({ brokerage: foreignBrokerage.id, party: foreignParty.id });
  const foreignArtifact = await artifact("TRANSCRIBING", foreign, freshAt, 0, foreignBrokerage.id, foreignParty.id);
  const ownSource = await source();
  const own = await artifact(
    "TRANSCRIBING",
    { sessionId: ownSource.sessionId, versionId: foreign.versionId },
    staleAt,
  );
  const result = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId });
  assert.equal(result.failedTenantMismatch, 1);
  assert.equal((await row(own))?.failureReason, "TENANT_MISMATCH");
  assert.equal((await row(foreignArtifact))?.processingState, "TRANSCRIBING");
  await db.delete(growCallTranscriptions).where(inArray(growCallTranscriptions.id, [foreignArtifact, own]));
  await db.delete(documentObjectVersions).where(eq(documentObjectVersions.id, foreign.versionId));
  await db.delete(documents).where(eq(documents.id, (await db.select({ id: documents.id }).from(documents).where(eq(documents.logicalOwnerId, foreign.sessionId)))[0]!.id));
  await db.delete(growCallSessions).where(eq(growCallSessions.id, foreign.sessionId));
  await db.delete(parties).where(eq(parties.id, foreignParty.id));
  await db.delete(users).where(eq(users.id, foreignUser.id));
  await db.delete(brokerages).where(eq(brokerages.id, foreignBrokerage.id));
});

test("CAS skips progress races, and strict audit outages defer then recover", async () => {
  const raced = await artifact("TRANSCRIBING", await source());
  setCallTranscriptionReconciliationBeforeTransitionForTests(async (snapshot) => {
    await db.update(growCallTranscriptions).set({ retryCount: 1, updatedAt: new Date(now.getTime() - 1_000) })
      .where(eq(growCallTranscriptions.id, snapshot.transcription.id));
  });
  const race = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId });
  assert.equal(race.skippedConcurrentTransition, 1);
  assert.equal((await row(raced))?.processingState, "TRANSCRIBING");
  setCallTranscriptionReconciliationBeforeTransitionForTests(null);
  await db.update(growCallTranscriptions).set({ updatedAt: freshAt })
    .where(eq(growCallTranscriptions.id, raced));

  const audited = await artifact("MEDIA_PROCESSING", await source());
  setCallTranscriptionAuditFailureForTests("grow_call_transcription_reconciled");
  const deferred = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId, batchSize: 1 });
  assert.equal(deferred.deferredTransitionError, 1);
  assert.equal(deferred.nextCursor, null, "deferred full batches must restart their cursor");
  assert.equal((await row(audited))?.processingState, "MEDIA_PROCESSING");
  assert.equal((await db.select().from(auditLogs).where(and(
    eq(auditLogs.brokerageId, brokerageId),
    eq(auditLogs.recordType, "grow_call_transcription"),
    eq(auditLogs.recordId, String(audited)),
  ))).length, 0);
  setCallTranscriptionAuditFailureForTests(null);
  const recovered = await reconcileAbandonedCallTranscriptions({ now, afterId: fixtureAfterId, batchSize: 1 });
  assert.equal(recovered.failedAbandoned, 1);
  assert.equal((await row(audited))?.processingState, "FAILED");
});
