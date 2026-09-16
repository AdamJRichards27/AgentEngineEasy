import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import {
  db,
  brokerages,
  users,
  parties,
  properties,
  documents,
  growCallSessions,
  documentObjectVersions,
  auditLogs,
} from "@aee/db";
import {
  buildCallRecordingMetadata,
  CallRecordingStorageError,
  configuredCallRecordingRetentionClass,
  DEFAULT_CALL_RECORDING_RETENTION_CLASS,
  getCallRecordingContent,
  getCallRecordingMetadata,
  quarantineCallRecording,
  serializeCallRecordingMetadata,
  storeCallRecording,
} from "../recordingStorage.js";
import { cleanupBrokerages } from "../../../routes/__tests__/testSupport.js";
import {
  createDocumentSignedDownload,
  DocumentStorageError,
  getStoredDocumentContent,
  ingestDocumentVersion,
  setDocumentStorageProviderForTests,
} from "../../documentStorage.js";

const evidence = {
  trustedByServer: true as const,
  source: "server-telephony-provider" as const,
  captureId: "capture-123",
  provider: "sandbox",
  providerRecordingId: "sandbox-recording-123",
  providerEventId: "sandbox-event-123",
  evidenceReference: "server-event-123",
  capturedAt: new Date("2026-01-02T03:04:05.000Z"),
  providerEventVerified: true,
};

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();

  async putObject(key: string, content: string | Buffer): Promise<{ key: string }> {
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }

  async getObject(key: string): Promise<Buffer> {
    const value = this.objects.get(key);
    if (!value) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(value);
  }

  async headObject(key: string) {
    const bytes = await this.getObject(key);
    return {
      key,
      size: bytes.length,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return {
      url: `memory://${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1_000),
    };
  }

  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }

  async checkReadiness() {
    return { ready: true };
  }
}

const storage = new MemoryStorage();
let brokerageId: number;
let userId: number;
let partyId: number;
let callSessionId: number;
const previousRetentionClasses = process.env.DOCUMENT_STORAGE_RETENTION_CLASSES;
const previousTelephonyRetentionClass = process.env.TELEPHONY_RECORDING_RETENTION_CLASS;

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

test.before(async () => {
  process.env.DOCUMENT_STORAGE_RETENTION_CLASSES = "legal-pending,general";
  setDocumentStorageProviderForTests(storage);
  const [brokerage] = await db
    .insert(brokerages)
    .values({ name: `Recording storage test ${Date.now()}` })
    .returning();
  brokerageId = brokerage!.id;
  const [user] = await db
    .insert(users)
    .values({
      authProviderId: `recording-storage-${brokerageId}`,
      email: `recording-storage-${brokerageId}@example.com`,
      firstName: "Storage",
      lastName: "Test",
      role: "Agent",
      brokerageId,
    })
    .returning();
  userId = user!.id;
  const [party] = await db
    .insert(parties)
    .values({
      brokerageId,
      firstName: "Synthetic",
      lastName: "Caller",
      email: `synthetic-caller-${brokerageId}@example.com`,
    })
    .returning();
  partyId = party!.id;
  const [session] = await db
    .insert(growCallSessions)
    .values({
      brokerageId,
      partyId,
      initiatedByUserId: userId,
      destinationRaw: "+61400111222",
      destinationNormalized: "+61400111222",
      destinationCountry: "AU",
      provider: "sandbox",
      status: "CONNECTED",
      recordingRequested: true,
      recordingPermitted: true,
      recordingStatus: "PERMITTED_NOT_CAPTURED",
    })
    .returning();
  callSessionId = session!.id;
});

test.after(async () => {
  setDocumentStorageProviderForTests(null);
  if (previousRetentionClasses === undefined) delete process.env.DOCUMENT_STORAGE_RETENTION_CLASSES;
  else process.env.DOCUMENT_STORAGE_RETENTION_CLASSES = previousRetentionClasses;
  if (previousTelephonyRetentionClass === undefined) delete process.env.TELEPHONY_RECORDING_RETENTION_CLASS;
  else process.env.TELEPHONY_RECORDING_RETENTION_CLASS = previousTelephonyRetentionClass;
  // cleanupBrokerages predates the document object ledger and intentionally
  // does not remove immutable versions. Remove this test-owned ledger data
  // first so the disposable brokerage can be deleted without FK violations.
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db
    .delete(documentObjectVersions)
    .where(eq(documentObjectVersions.brokerageId, brokerageId));
  await db.delete(documents).where(eq(documents.brokerageId, brokerageId));
  await cleanupBrokerages([brokerageId]);
});

test("stores synthetic recording metadata through document versions with tenant/call scope", async () => {
  const syntheticBytes = Buffer.from("synthetic recording payload\n", "utf8");
  const stored = await storeCallRecording({
    brokerageId,
    callSessionId,
    captureEvidence: evidence,
    bytes: syntheticBytes,
    originalFilename: `call-${callSessionId}-recording-metadata.txt`,
    declaredMimeType: "text/plain",
  });
  assert.equal(stored.created, true);
  assert.equal(stored.version.source, "telephony");
  assert.equal(stored.version.retentionClass, "legal-pending");
  assert.equal(stored.document.propertyId, null);
  assert.equal(stored.document.brokerageId, brokerageId);
  assert.equal(stored.document.logicalOwnerType, "telephony-call");
  assert.equal(stored.document.logicalOwnerId, callSessionId);
  assert.deepEqual(stored.version.metadata, {
    logicalOwner: {
      kind: "telephony-call",
      brokerageId,
      ownerId: callSessionId,
    },
    callRecording: stored.metadata,
  });

  const [ledger] = await db
    .select()
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.id, stored.version.id));
  assert.equal(ledger?.contentSha256, createHash("sha256").update(syntheticBytes).digest("hex"));
  assert.ok(
    (await db.select().from(auditLogs).where(eq(auditLogs.recordId, String(callSessionId))))
      .some((audit) => audit.action === "grow_call_recording_stored"),
  );

  const metadata = await getCallRecordingMetadata({ brokerageId, callSessionId });
  assert.equal(metadata?.version.id, stored.version.id);
  assert.equal(metadata?.metadata.captureId, evidence.captureId);
  const content = await getCallRecordingContent({ brokerageId, callSessionId });
  assert.deepEqual(content?.bytes, syntheticBytes);

  const versionsBeforeForgedCapture = await db
    .select({ id: documentObjectVersions.id })
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.brokerageId, brokerageId));
  await assert.rejects(
    storeCallRecording({
      brokerageId,
      callSessionId,
      captureEvidence: {
        ...evidence,
        trustedByServer: false,
      } as unknown as typeof evidence,
      bytes: Buffer.from("forged synthetic capture\n", "utf8"),
      originalFilename: `call-${callSessionId}-forged.txt`,
      declaredMimeType: "text/plain",
    }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "CAPTURE_EVIDENCE_INVALID",
  );
  const versionsAfterForgedCapture = await db
    .select({ id: documentObjectVersions.id })
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.brokerageId, brokerageId));
  assert.deepEqual(
    versionsAfterForgedCapture.map((row) => row.id),
    versionsBeforeForgedCapture.map((row) => row.id),
    "forged capture evidence must not create a document version",
  );
  await assert.rejects(
    storeCallRecording({
      brokerageId,
      callSessionId,
      actor: {
        userId,
        role: "Agent",
        brokerageId: brokerageId + 999_998,
      },
      captureEvidence: evidence,
      bytes: Buffer.from("cross-brokerage synthetic capture\n", "utf8"),
      originalFilename: `call-${callSessionId}-cross-brokerage.txt`,
      declaredMimeType: "text/plain",
    }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "RECORDING_ACCESS_DENIED",
    "storage must authorize the actor brokerage before reading or writing a recording",
  );

  const duplicate = await storeCallRecording({
    brokerageId,
    callSessionId,
    captureEvidence: evidence,
    bytes: Buffer.from("a different retry payload\n", "utf8"),
    originalFilename: `call-${callSessionId}-recording-metadata.txt`,
    declaredMimeType: "text/plain",
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.outcome, "deduplicated");
  assert.equal(duplicate.metadata.retentionClass, "legal-pending");

  const retentionClassBeforeMismatch = process.env.TELEPHONY_RECORDING_RETENTION_CLASS;
  try {
    process.env.TELEPHONY_RECORDING_RETENTION_CLASS = "general";
    await assert.rejects(
      storeCallRecording({
        brokerageId,
        callSessionId,
        captureEvidence: evidence,
        originalFilename: `call-${callSessionId}-recording-metadata.txt`,
        declaredMimeType: "text/plain",
      }),
      (error: unknown) =>
        error instanceof CallRecordingStorageError &&
        error.code === "RECORDING_RETENTION_MISMATCH",
    );
  } finally {
    if (retentionClassBeforeMismatch === undefined) {
      delete process.env.TELEPHONY_RECORDING_RETENTION_CLASS;
    } else {
      process.env.TELEPHONY_RECORDING_RETENTION_CLASS = retentionClassBeforeMismatch;
    }
  }
  const authoritativeRead = await getCallRecordingMetadata({ brokerageId, callSessionId });
  assert.equal(authoritativeRead?.metadata.retentionClass, "legal-pending");

  await assert.rejects(
    getCallRecordingMetadata({ brokerageId: brokerageId + 999_999, callSessionId }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError && error.code === "CALL_NOT_FOUND",
  );
  await assert.rejects(
    getCallRecordingMetadata({ brokerageId: brokerageId + 999_998, callSessionId }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError && error.code === "CALL_NOT_FOUND",
  );
  await assert.rejects(
    getCallRecordingMetadata({
      brokerageId,
      callSessionId,
      actor: {
        userId,
        role: "Agent",
        brokerageId: brokerageId + 999_998,
      },
    }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "RECORDING_ACCESS_DENIED",
    "a cross-brokerage actor must not read the recording even with a valid call id",
  );

  const quarantined = await quarantineCallRecording({
    brokerageId,
    callSessionId,
  });
  assert.equal(quarantined?.objectStatus, "Quarantined");
  await assert.rejects(
    getCallRecordingContent({ brokerageId, callSessionId }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError && error.code === "RECORDING_UNAVAILABLE",
  );
});

test("a caller cannot reuse a propertyless recording owner for another call", async () => {
  const [session] = await db
    .insert(growCallSessions)
    .values({
      brokerageId,
      partyId,
      initiatedByUserId: userId,
      destinationRaw: "+61400111333",
      destinationNormalized: "+61400111333",
      destinationCountry: "AU",
      provider: "sandbox",
      status: "CONNECTED",
      recordingRequested: true,
      recordingPermitted: true,
      recordingStatus: "PERMITTED_NOT_CAPTURED",
    })
    .returning();
  const [recordingDocument] = await db
    .select()
    .from(documents)
    .where(eq(documents.logicalOwnerId, callSessionId))
    .limit(1);
  assert.ok(recordingDocument);

  await assert.rejects(
    storeCallRecording({
      brokerageId,
      callSessionId: session!.id,
      documentId: recordingDocument!.id,
      actorUserId: userId,
      captureEvidence: {
        ...evidence,
        captureId: "capture-for-another-call",
      },
      originalFilename: `call-${session!.id}-recording-metadata.txt`,
      declaredMimeType: "text/plain",
    }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "RECORDING_DOCUMENT_LINK_CONFLICT",
  );
});

test("generic document storage rejects propertyless logical documents", async () => {
  const [recordingDocument] = await db
    .select()
    .from(documents)
    .where(eq(documents.logicalOwnerId, callSessionId))
    .limit(1);
  assert.ok(recordingDocument);

  assert.equal(
    await getStoredDocumentContent(recordingDocument!.id, brokerageId),
    null,
  );
  await assert.rejects(
    createDocumentSignedDownload(recordingDocument!.id, brokerageId),
    (error: unknown) =>
      error instanceof DocumentStorageError &&
      error.code === "DOCUMENT_NOT_FOUND",
  );
  await assert.rejects(
    ingestDocumentVersion({
      documentId: recordingDocument!.id,
      brokerageId,
      bytes: Buffer.from("generic upload attempt", "utf8"),
      originalFilename: "generic-upload.txt",
      declaredMimeType: "text/plain",
      source: "upload",
      replacementReason: "generic route rejection test",
    }),
    (error: unknown) =>
      error instanceof DocumentStorageError &&
      error.code === "DOCUMENT_NOT_FOUND",
  );
});

test("logical recording retention remains authoritative under the document lock", async () => {
  const [recordingDocument] = await db
    .select()
    .from(documents)
    .where(eq(documents.logicalOwnerId, callSessionId))
    .limit(1);
  assert.ok(recordingDocument);
  await assert.rejects(
    ingestDocumentVersion({
      documentId: recordingDocument!.id,
      brokerageId,
      bytes: Buffer.from("retention authority attempt", "utf8"),
      originalFilename: "retention-authority.txt",
      declaredMimeType: "text/plain",
      replacementReason: "retention authority test",
      retentionClass: "general",
      source: "telephony",
      metadata: {
        logicalOwner: {
          kind: "telephony-call",
          brokerageId,
          ownerId: callSessionId,
        },
      },
    }),
    (error: unknown) =>
      error instanceof DocumentStorageError &&
      error.code === "DOCUMENT_UNAVAILABLE",
  );
});

test("document ownership constraints reject missing and mixed logical owners", async () => {
  await assert.rejects(
    db
      .insert(documents)
      .values({
        propertyId: null,
        brokerageId,
        documentType: "CallRecordingMetadata",
        title: "Missing logical owner",
      }),
    (error: unknown) => postgresErrorCode(error) === "23514",
  );

  const [property] = await db
    .insert(properties)
    .values({
      brokerageId,
      agentId: userId,
      formattedAddress: `${brokerageId} Constraint Test Street`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    })
    .returning();
  assert.ok(property);
  await assert.rejects(
    db
      .insert(documents)
      .values({
        propertyId: property!.id,
        brokerageId,
        logicalOwnerType: "telephony-call",
        logicalOwnerId: callSessionId + 30_000,
        documentType: "CallRecordingMetadata",
        title: "Mixed ownership",
      }),
    (error: unknown) => postgresErrorCode(error) === "23514",
  );
});

test("scoped recording access rejects an actor without owner/admin and entitlement authorization", async () => {
  await assert.rejects(
    getCallRecordingMetadata({
      brokerageId,
      callSessionId,
      actor: {
        userId,
        role: "Agent",
        brokerageId,
      },
    }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "RECORDING_ACCESS_DENIED",
  );
});

test("document logical ownership remains invariant across concurrent ingestion attempts", async () => {
  const ownerCallId = callSessionId + 10_000;
  const competingCallId = callSessionId + 20_000;
  const [logicalDocument] = await db
    .insert(documents)
    .values({
      brokerageId,
      propertyId: null,
      logicalOwnerType: "telephony-call",
      logicalOwnerId: ownerCallId,
      documentType: "CallRecordingMetadata",
      title: "Concurrent logical owner test",
      metadata: {
        logicalOwner: {
          kind: "telephony-call",
          brokerageId,
          ownerId: ownerCallId,
        },
      },
    })
    .returning();
  assert.ok(logicalDocument);

  const attempt = (ownerId: number, suffix: string) =>
    ingestDocumentVersion({
      documentId: logicalDocument!.id,
      brokerageId,
      bytes: Buffer.from(`concurrent-${suffix}`, "utf8"),
      originalFilename: `concurrent-${suffix}.txt`,
      declaredMimeType: "text/plain",
      source: "telephony",
      sourceProvider: "sandbox",
      providerDocumentId: `concurrent-${suffix}`,
      replacementReason: `concurrent owner ${suffix}`,
      metadata: {
        logicalOwner: {
          kind: "telephony-call",
          brokerageId,
          ownerId,
        },
      },
    });
  const results = await Promise.allSettled([
    attempt(ownerCallId, "owner"),
    attempt(competingCallId, "competing"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(
    ["DOCUMENT_NOT_FOUND", "DOCUMENT_UNAVAILABLE"].includes(
      (rejected.reason as { code?: string }).code ?? "",
    ),
  );
});

test("recording retention is a named configured class, not a fabricated legal period", () => {
  assert.equal(
    configuredCallRecordingRetentionClass({
      DOCUMENT_STORAGE_RETENTION_CLASSES: "legal-pending,general",
    }),
    DEFAULT_CALL_RECORDING_RETENTION_CLASS,
  );
  assert.equal(
    configuredCallRecordingRetentionClass({
      DOCUMENT_STORAGE_RETENTION_CLASSES: "legal-pending,telephony-review",
      TELEPHONY_RECORDING_RETENTION_CLASS: "telephony-review",
    }),
    "telephony-review",
  );
  assert.throws(
    () =>
      configuredCallRecordingRetentionClass({
        DOCUMENT_STORAGE_RETENTION_CLASSES: "general",
        TELEPHONY_RECORDING_RETENTION_CLASS: "365-days",
      }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "RETENTION_CLASS_NOT_CONFIGURED",
  );
});

test("recording metadata links the tenant and call without evaluating permission gates", () => {
  const metadata = buildCallRecordingMetadata({
    brokerageId: 41,
    callSessionId: 72,
    partyId: 93,
    recordingStatusAtCapture: "PERMITTED_NOT_CAPTURED",
    recordingConsentIdAtCapture: 101,
    retentionClass: "legal-pending",
    captureEvidence: evidence,
    contentType: "text/plain",
    originalFilename: "call-72-recording-metadata.txt",
    metadata: {
      durationSeconds: 12,
      channelCount: 1,
      sampleRateHz: 8_000,
    },
  });

  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.kind, "telephony-call-recording");
  assert.equal(metadata.brokerageId, 41);
  assert.equal(metadata.callSessionId, 72);
  assert.equal(metadata.captureId, "capture-123");
  assert.equal(metadata.recordingPermittedAtCapture, true);
  assert.equal(metadata.retentionClass, "legal-pending");
  assert.equal("retentionDays" in metadata, false);

  // Synthetic text is the only payload this test creates.  The service's
  // normal metadata-only path uses this same deterministic artifact.
  const syntheticBytes = serializeCallRecordingMetadata(metadata);
  assert.ok(syntheticBytes.length > 0);
  assert.deepEqual(JSON.parse(syntheticBytes.toString("utf8")), metadata);
});

test("untrusted capture evidence is rejected before any storage payload is built", () => {
  assert.throws(
    () =>
      buildCallRecordingMetadata({
        brokerageId: 1,
        callSessionId: 2,
        partyId: 3,
        recordingStatusAtCapture: "PERMITTED_NOT_CAPTURED",
        recordingConsentIdAtCapture: null,
        retentionClass: "legal-pending",
        captureEvidence: {
          ...evidence,
          trustedByServer: false,
        } as unknown as typeof evidence,
        contentType: "text/plain",
        originalFilename: "call-2-recording-metadata.txt",
      }),
    (error: unknown) =>
      error instanceof CallRecordingStorageError &&
      error.code === "CAPTURE_EVIDENCE_INVALID",
  );
});
