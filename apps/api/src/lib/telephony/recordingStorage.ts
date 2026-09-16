import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  documentObjectVersions,
  documents,
  type Document,
  type DocumentObjectVersion,
  type GrowCallSession,
} from "@aee/db";
import {
  configuredRetentionClasses,
  createLogicalDocumentSignedDownload,
  getStoredLogicalDocumentContent,
  ingestDocumentVersion,
  quarantineLogicalDocument,
  type IngestDocumentVersionResult,
  type StoredDocumentContent,
} from "../documentStorage.js";
import { logAudit } from "../audit.js";
import {
  assertCallSessionActorAuthorized,
  getCallSessionForBrokerage,
} from "./callSessions.js";
import { hasEntitlement } from "../entitlements/resolver.js";

/**
 * Step 3 recording storage deliberately has no route or provider capture
 * implementation.  The only production seam is an internal call from a
 * trusted server-side capture adapter.  In particular, this type contains no
 * client-controlled recordingPermitted/gate result field.
 */
export interface TrustedServerCaptureEvidence {
  readonly trustedByServer: true;
  readonly source: "server-telephony-provider";
  readonly captureId: string;
  readonly provider: string;
  readonly capturedAt: Date | string;
  readonly providerRecordingId?: string | null;
  readonly providerEventId?: string | null;
  readonly evidenceReference?: string | null;
  readonly providerEventVerified?: boolean;
}

export interface CallRecordingMetadataFields {
  readonly durationSeconds?: number | null;
  readonly channelCount?: number | null;
  readonly sampleRateHz?: number | null;
  readonly contentType?: string;
  readonly originalFilename?: string;
}

export interface StoreCallRecordingInput extends CallRecordingMetadataFields {
  brokerageId: number;
  callSessionId: number;
  /**
   * Optional compatibility selector. It must identify the service-owned
   * propertyless recording document for this exact call; a caller-selected
   * property document is rejected.
   */
  documentId?: number;
  captureEvidence: TrustedServerCaptureEvidence;
  actorUserId?: number;
  actor?: CallRecordingActor;
  replacementReason?: string;
  /**
   * Optional internal capture payload seam.  The current application never
   * calls this with provider audio.  Omitting it stores a deterministic,
   * text/plain metadata artifact.  Tests may supply a synthetic buffer to
   * exercise the existing object-storage/integrity path.
   */
  bytes?: Buffer;
  declaredMimeType?: string;
}

export interface StoreCallRecordingMetadataInput
  extends Omit<StoreCallRecordingInput, "bytes" | "declaredMimeType"> {
  metadata?: CallRecordingMetadataFields;
}

export interface CallRecordingMetadata {
  readonly schemaVersion: 1;
  readonly kind: "telephony-call-recording";
  readonly brokerageId: number;
  readonly callSessionId: number;
  readonly partyId: number;
  readonly captureId: string;
  readonly provider: string;
  readonly providerRecordingId: string | null;
  readonly providerEventId: string | null;
  readonly evidenceReference: string | null;
  readonly providerEventVerified: boolean;
  readonly capturedAt: string;
  readonly recordingStatusAtCapture: string;
  readonly recordingPermittedAtCapture: true;
  readonly recordingConsentIdAtCapture: number | null;
  readonly retentionClass: string;
  readonly contentType: string;
  readonly originalFilename: string;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRateHz: number | null;
}

export interface StoredCallRecording {
  readonly document: Document;
  readonly version: DocumentObjectVersion;
  readonly metadata: CallRecordingMetadata;
  readonly created: boolean;
  readonly outcome: IngestDocumentVersionResult["outcome"];
}

export interface CallRecordingActor {
  readonly userId: number;
  readonly role: string;
  readonly brokerageId: number;
}

export interface CallRecordingMetadataRead {
  readonly callSession: GrowCallSession;
  readonly document: Document;
  readonly version: DocumentObjectVersion;
  readonly metadata: CallRecordingMetadata;
}

export type CallRecordingStorageErrorCode =
  | "CALL_NOT_FOUND"
  | "RECORDING_NOT_PERMITTED"
  | "CAPTURE_EVIDENCE_INVALID"
  | "RECORDING_DOCUMENT_NOT_FOUND"
  | "RECORDING_DOCUMENT_LINK_CONFLICT"
  | "RECORDING_NOT_FOUND"
  | "RECORDING_UNAVAILABLE"
  | "RETENTION_CLASS_NOT_CONFIGURED"
  | "RECORDING_METADATA_INVALID"
  | "RECORDING_METADATA_CORRUPT"
  | "RECORDING_METADATA_CONFLICT"
  | "RECORDING_RETENTION_MISMATCH"
  | "RECORDING_ACCESS_DENIED";

export class CallRecordingStorageError extends Error {
  readonly code: CallRecordingStorageErrorCode;

  constructor(code: CallRecordingStorageErrorCode, message: string) {
    super(message);
    this.name = "CallRecordingStorageError";
    this.code = code;
  }
}

export const CALL_RECORDING_RETENTION_CLASS_ENV = "TELEPHONY_RECORDING_RETENTION_CLASS";
export const DEFAULT_CALL_RECORDING_RETENTION_CLASS = "legal-pending";
export const CALL_RECORDING_METADATA_SCHEMA_VERSION = 1 as const;
export const CALL_RECORDING_LOGICAL_OWNER_TYPE = "telephony-call";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_METADATA_BYTES = 32 * 1024;

function recordingLogicalOwner(brokerageId: number, callSessionId: number) {
  return {
    kind: CALL_RECORDING_LOGICAL_OWNER_TYPE,
    brokerageId,
    ownerId: callSessionId,
  };
}

/**
 * The named class is an application retention label only.  `legal-pending`
 * intentionally does not claim a statutory period; legal review and operator
 * configuration remain pending.
 */
export function configuredCallRecordingRetentionClass(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured =
    env[CALL_RECORDING_RETENTION_CLASS_ENV] ??
    DEFAULT_CALL_RECORDING_RETENTION_CLASS;
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(configured) ||
    !configuredRetentionClasses(env).includes(configured)
  ) {
    throw new CallRecordingStorageError(
      "RETENTION_CLASS_NOT_CONFIGURED",
      `${CALL_RECORDING_RETENTION_CLASS_ENV} must name one of DOCUMENT_STORAGE_RETENTION_CLASSES`,
    );
  }
  return configured;
}

// Descriptive alias for callers that use "telephony" terminology in their
// integration module; both names resolve to the same validated setting.
export const configuredTelephonyRecordingRetentionClass =
  configuredCallRecordingRetentionClass;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function validOptionalNumber(value: unknown, name: string, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      `${name} must be a finite non-negative value within the supported range`,
    );
  }
  return value;
}

function assertReference(value: unknown, name: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new CallRecordingStorageError(
        "CAPTURE_EVIDENCE_INVALID",
        `${name} is required in trusted server capture evidence`,
      );
    }
    return null;
  }
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) {
    throw new CallRecordingStorageError(
      "CAPTURE_EVIDENCE_INVALID",
      `${name} contains unsupported characters or is too long`,
    );
  }
  return value;
}

function normaliseCaptureEvidence(
  evidence: TrustedServerCaptureEvidence,
): TrustedServerCaptureEvidence {
  if (
    !evidence ||
    evidence.trustedByServer !== true ||
    evidence.source !== "server-telephony-provider"
  ) {
    throw new CallRecordingStorageError(
      "CAPTURE_EVIDENCE_INVALID",
      "Recording storage requires trusted server capture evidence",
    );
  }
  const captureId = assertReference(evidence.captureId, "captureId", true);
  const provider = assertReference(evidence.provider, "provider", true);
  const capturedAt = new Date(evidence.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new CallRecordingStorageError(
      "CAPTURE_EVIDENCE_INVALID",
      "capturedAt must be a valid timestamp",
    );
  }
  return {
    trustedByServer: true,
    source: "server-telephony-provider",
    captureId: captureId!,
    provider: provider!,
    capturedAt,
    providerRecordingId: assertReference(evidence.providerRecordingId, "providerRecordingId"),
    providerEventId: assertReference(evidence.providerEventId, "providerEventId"),
    evidenceReference: assertReference(evidence.evidenceReference, "evidenceReference"),
    providerEventVerified: evidence.providerEventVerified === true,
  };
}

function assertContentType(contentType: string | undefined): string {
  const value = contentType?.trim().toLowerCase() || "text/plain";
  // Metadata storage intentionally uses the existing text document path.  No
  // new audio MIME allow-list is introduced by this step.
  if (value !== "text/plain") {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      "Step 3 recording storage accepts text/plain metadata payloads only",
    );
  }
  return value;
}

function assertFilename(filename: string | undefined, callSessionId: number): string {
  const value = filename?.trim() || `call-${callSessionId}-recording-metadata.txt`;
  if (
    value.length > 255 ||
    value.includes("/") ||
    value.includes("\\") ||
    !value.toLowerCase().endsWith(".txt")
  ) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      "Recording metadata filename must be a safe .txt filename",
    );
  }
  return value;
}

/**
 * Pure metadata builder exported for focused storage tests and for the future
 * capture adapter.  It intentionally accepts the server-loaded permission
 * snapshot rather than evaluating any consent/gate rule.
 */
export function buildCallRecordingMetadata(input: {
  brokerageId: number;
  callSessionId: number;
  partyId: number;
  recordingStatusAtCapture: string;
  recordingConsentIdAtCapture: number | null;
  retentionClass: string;
  captureEvidence: TrustedServerCaptureEvidence;
  contentType: string;
  originalFilename: string;
  metadata?: CallRecordingMetadataFields;
}): CallRecordingMetadata {
  const evidence = normaliseCaptureEvidence(input.captureEvidence);
  if (
    !Number.isSafeInteger(input.brokerageId) ||
    input.brokerageId < 1 ||
    !Number.isSafeInteger(input.callSessionId) ||
    input.callSessionId < 1 ||
    !Number.isSafeInteger(input.partyId) ||
    input.partyId < 1
  ) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      "Tenant, call, and party identifiers must be positive integers",
    );
  }
  return {
    schemaVersion: CALL_RECORDING_METADATA_SCHEMA_VERSION,
    kind: "telephony-call-recording",
    brokerageId: input.brokerageId,
    callSessionId: input.callSessionId,
    partyId: input.partyId,
    captureId: evidence.captureId,
    provider: evidence.provider,
    providerRecordingId: evidence.providerRecordingId ?? null,
    providerEventId: evidence.providerEventId ?? null,
    evidenceReference: evidence.evidenceReference ?? null,
    providerEventVerified: evidence.providerEventVerified === true,
    capturedAt: new Date(evidence.capturedAt).toISOString(),
    recordingStatusAtCapture: input.recordingStatusAtCapture,
    recordingPermittedAtCapture: true,
    recordingConsentIdAtCapture: input.recordingConsentIdAtCapture,
    retentionClass: input.retentionClass,
    contentType: assertContentType(input.contentType),
    originalFilename: input.originalFilename,
    durationSeconds: validOptionalNumber(input.metadata?.durationSeconds, "durationSeconds", 24 * 60 * 60),
    channelCount: validOptionalNumber(input.metadata?.channelCount, "channelCount", 128),
    sampleRateHz: validOptionalNumber(input.metadata?.sampleRateHz, "sampleRateHz", 1_000_000),
  };
}

export function isCallRecordingMetadata(value: unknown): value is CallRecordingMetadata {
  const metadata = asRecord(value);
  return (
    metadata?.kind === "telephony-call-recording" &&
    metadata.schemaVersion === CALL_RECORDING_METADATA_SCHEMA_VERSION &&
    Number.isSafeInteger(metadata.brokerageId) &&
    Number.isSafeInteger(metadata.callSessionId) &&
    Number.isSafeInteger(metadata.partyId) &&
    typeof metadata.captureId === "string" &&
    typeof metadata.provider === "string" &&
    typeof metadata.providerEventVerified === "boolean" &&
    typeof metadata.capturedAt === "string" &&
    typeof metadata.recordingStatusAtCapture === "string" &&
    metadata.recordingPermittedAtCapture === true &&
    typeof metadata.retentionClass === "string" &&
    typeof metadata.contentType === "string" &&
    typeof metadata.originalFilename === "string"
  );
}

function callRecordingMetadataFromVersion(
  version: DocumentObjectVersion,
): CallRecordingMetadata | null {
  const metadata = asRecord(version.metadata);
  return isCallRecordingMetadata(metadata?.callRecording)
    ? (metadata!.callRecording as CallRecordingMetadata)
    : null;
}

function assertStoredVersionMetadata(
  version: DocumentObjectVersion,
  input?: {
    brokerageId: number;
    callSessionId: number;
    captureEvidence?: TrustedServerCaptureEvidence;
    retentionClass?: string;
  },
): CallRecordingMetadata {
  const metadata = callRecordingMetadataFromVersion(version);
  if (!metadata) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_CORRUPT",
      "Stored telephony version is missing its authoritative recording metadata",
    );
  }
  if (
    version.source !== "telephony" ||
    metadata.brokerageId !== version.brokerageId ||
    metadata.retentionClass !== version.retentionClass
  ) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_CORRUPT",
      "Stored recording metadata does not match immutable version ownership or retention",
    );
  }
  const owner = asRecord(asRecord(version.metadata)?.logicalOwner);
  if (!owner) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_CORRUPT",
      "Stored recording metadata is not owned by its logical call owner",
    );
  }
  if (input) {
    const expectedOwner = recordingLogicalOwner(
      input.brokerageId,
      input.callSessionId,
    );
    if (
      owner.kind !== expectedOwner.kind ||
      owner.brokerageId !== expectedOwner.brokerageId ||
      owner.ownerId !== expectedOwner.ownerId
    ) {
      throw new CallRecordingStorageError(
        "RECORDING_METADATA_CONFLICT",
        "Capture evidence does not match the authoritative stored logical owner",
      );
    }
    if (
      metadata.brokerageId !== input.brokerageId ||
      metadata.callSessionId !== input.callSessionId ||
      (input.captureEvidence &&
        metadata.captureId !== input.captureEvidence.captureId)
    ) {
      throw new CallRecordingStorageError(
        "RECORDING_METADATA_CONFLICT",
        "Capture evidence does not match the authoritative stored recording metadata",
      );
    }
    if (input.retentionClass && version.retentionClass !== input.retentionClass) {
      throw new CallRecordingStorageError(
        "RECORDING_RETENTION_MISMATCH",
        "The configured recording retention class changed for an existing capture",
      );
    }
    if (input.captureEvidence) {
      const evidence = normaliseCaptureEvidence(input.captureEvidence);
      if (
        metadata.provider !== evidence.provider ||
        metadata.capturedAt !== new Date(evidence.capturedAt).toISOString() ||
        metadata.providerRecordingId !== (evidence.providerRecordingId ?? null) ||
        metadata.providerEventId !== (evidence.providerEventId ?? null) ||
        metadata.evidenceReference !== (evidence.evidenceReference ?? null) ||
        metadata.providerEventVerified !== (evidence.providerEventVerified === true)
      ) {
        throw new CallRecordingStorageError(
          "RECORDING_METADATA_CONFLICT",
          "Capture evidence does not match the authoritative stored recording metadata",
        );
      }
    }
  }
  return metadata;
}

export function serializeCallRecordingMetadata(metadata: CallRecordingMetadata): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
  if (bytes.length > MAX_METADATA_BYTES) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      "Recording metadata exceeds the supported metadata payload size",
    );
  }
  return bytes;
}

async function loadCallSession(
  brokerageId: number,
  callSessionId: number,
): Promise<GrowCallSession> {
  try {
    return await getCallSessionForBrokerage(brokerageId, callSessionId);
  } catch (error) {
    // Avoid coupling this storage seam to the call-session error class while
    // keeping tenant/call lookup failures explicit to callers.
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "GrowCallSessionNotFoundError"
    ) {
      throw new CallRecordingStorageError(
        "CALL_NOT_FOUND",
        `Call session ${callSessionId} was not found in brokerage ${brokerageId}`,
      );
    }
    throw error;
  }
}

async function authorizeCallRecordingActor(
  session: GrowCallSession,
  brokerageId: number,
  actor?: CallRecordingActor,
): Promise<void> {
  if (!actor) return;
  if (actor.brokerageId !== brokerageId) {
    throw new CallRecordingStorageError(
      "RECORDING_ACCESS_DENIED",
      "Recording actor does not belong to the requested brokerage",
    );
  }
  try {
    assertCallSessionActorAuthorized(session, actor.userId, actor.role);
  } catch {
    throw new CallRecordingStorageError(
      "RECORDING_ACCESS_DENIED",
      "Recording access requires the session owner or a brokerage administrator",
    );
  }
  const entitled = await hasEntitlement(
    {
      id: actor.userId,
      role: actor.role,
      brokerageId,
    },
    "grow.calling.recording",
  );
  if (!entitled) {
    throw new CallRecordingStorageError(
      "RECORDING_ACCESS_DENIED",
      "Recording access requires the grow.calling.recording entitlement",
    );
  }
}

async function loadDocumentForBrokerage(
  documentId: number,
  brokerageId: number,
  callSessionId: number,
): Promise<Document> {
  const [row] = await db
    .select({ document: documents })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.brokerageId, brokerageId),
        eq(documents.logicalOwnerType, CALL_RECORDING_LOGICAL_OWNER_TYPE),
        eq(documents.logicalOwnerId, callSessionId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new CallRecordingStorageError(
      "RECORDING_DOCUMENT_LINK_CONFLICT",
      `Document ${documentId} is not the service-owned propertyless document for call ${callSessionId}`,
    );
  }
  if (row.document.propertyId !== null) {
    throw new CallRecordingStorageError(
      "RECORDING_DOCUMENT_LINK_CONFLICT",
      "A call recording document must not be property-backed",
    );
  }
  return row.document;
}

async function getOrCreateRecordingDocument(
  brokerageId: number,
  callSessionId: number,
  requestedDocumentId?: number,
): Promise<Document> {
  if (requestedDocumentId !== undefined) {
    return loadDocumentForBrokerage(
      requestedDocumentId,
      brokerageId,
      callSessionId,
    );
  }

  const owner = recordingLogicalOwner(brokerageId, callSessionId);
  return db.transaction(async (tx) => {
    // The document lock serializes retries for one logical call even before a
    // version exists. Version ownership is checked again under the document
    // lock in ingestDocumentVersion.
    await tx.execute(sql`select pg_advisory_xact_lock(${callSessionId})`);
    const [existing] = await tx
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.brokerageId, brokerageId),
          eq(documents.logicalOwnerType, owner.kind),
          eq(documents.logicalOwnerId, owner.ownerId),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.propertyId !== null) {
        throw new CallRecordingStorageError(
          "RECORDING_DOCUMENT_LINK_CONFLICT",
          "A call recording document must not be property-backed",
        );
      }
      return existing;
    }
    const [created] = await tx
      .insert(documents)
      .values({
        propertyId: null,
        brokerageId,
        logicalOwnerType: owner.kind,
        logicalOwnerId: owner.ownerId,
        documentType: "CallRecordingMetadata",
        title: `Call ${callSessionId} recording metadata`,
        metadata: {
          logicalOwner: owner,
          telephonyRecordingDocument: true,
        },
      })
      .returning();
    if (!created) {
      throw new CallRecordingStorageError(
        "RECORDING_DOCUMENT_NOT_FOUND",
        "Recording metadata document could not be created",
      );
    }
    return created;
  });
}

function assertTargetVersionsAreRecordingOnly(
  versions: DocumentObjectVersion[],
  brokerageId: number,
  callSessionId: number,
): void {
  for (const version of versions) {
    const metadata = assertStoredVersionMetadata(version);
    if (
      metadata.brokerageId !== brokerageId ||
      metadata.callSessionId !== callSessionId
    ) {
      throw new CallRecordingStorageError(
        "RECORDING_DOCUMENT_LINK_CONFLICT",
        "The designated recording document is linked to a different call session",
      );
    }
  }
}

function resultFromIngestion(
  document: Document,
  metadata: CallRecordingMetadata,
  result: IngestDocumentVersionResult,
): StoredCallRecording {
  return {
    document,
    version: result.version,
    metadata,
    created: result.created,
    outcome: result.outcome,
  };
}

/**
 * Store a permitted capture's metadata and optional internal synthetic
 * payload.  The authoritative call row is loaded by brokerage + call id; no
 * caller-provided permission boolean or gate result is consulted.
 */
export async function storeCallRecording(
  input: StoreCallRecordingInput,
): Promise<StoredCallRecording> {
  const session = await loadCallSession(input.brokerageId, input.callSessionId);
  await authorizeCallRecordingActor(session, input.brokerageId, input.actor);
  if (
    session.recordingPermitted !== true ||
    session.recordingStatus !== "PERMITTED_NOT_CAPTURED"
  ) {
    throw new CallRecordingStorageError(
      "RECORDING_NOT_PERMITTED",
      "Call recording storage requires the authoritative session to be permitted and not yet captured",
    );
  }
  const evidence = normaliseCaptureEvidence(input.captureEvidence);
  const retentionClass = configuredCallRecordingRetentionClass();
  const document = await getOrCreateRecordingDocument(
    input.brokerageId,
    input.callSessionId,
    input.documentId,
  );
  const existingVersions = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, document.id),
        eq(documentObjectVersions.brokerageId, input.brokerageId),
      ),
    )
    .orderBy(desc(documentObjectVersions.version));
  assertTargetVersionsAreRecordingOnly(
    existingVersions,
    input.brokerageId,
    input.callSessionId,
  );

  const contentType = assertContentType(input.declaredMimeType);
  const originalFilename = assertFilename(input.originalFilename, input.callSessionId);
  const metadata = buildCallRecordingMetadata({
    brokerageId: input.brokerageId,
    callSessionId: input.callSessionId,
    partyId: session.partyId,
    recordingStatusAtCapture: session.recordingStatus,
    recordingConsentIdAtCapture: session.recordingConsentId,
    retentionClass,
    captureEvidence: evidence,
    contentType,
    originalFilename,
    metadata: input,
  });

  const matchingCapture = existingVersions.find((version) => {
    const versionMetadata = callRecordingMetadataFromVersion(version);
    return versionMetadata?.captureId === metadata.captureId;
  });
  let authoritativeMetadata: CallRecordingMetadata | undefined;
  if (matchingCapture) {
    authoritativeMetadata = assertStoredVersionMetadata(matchingCapture, {
      brokerageId: input.brokerageId,
      callSessionId: input.callSessionId,
      captureEvidence: evidence,
      retentionClass,
    });
  }
  if (matchingCapture?.objectStatus === "Active") {
    return resultFromIngestion(document, authoritativeMetadata!, {
      version: matchingCapture,
      created: false,
      outcome: "deduplicated",
    });
  }
  if (matchingCapture?.objectStatus === "Quarantined") {
    throw new CallRecordingStorageError(
      "RECORDING_UNAVAILABLE",
      "The matching recording capture is quarantined",
    );
  }

  const bytes = input.bytes
    ? Buffer.from(input.bytes)
    : serializeCallRecordingMetadata(authoritativeMetadata ?? metadata);
  if (bytes.length === 0) {
    throw new CallRecordingStorageError(
      "RECORDING_METADATA_INVALID",
      "Recording storage cannot ingest an empty payload",
    );
  }
  let ingested: IngestDocumentVersionResult;
  try {
    ingested = await ingestDocumentVersion({
      documentId: document.id,
      brokerageId: input.brokerageId,
      actorUserId: input.actorUserId,
      bytes,
      originalFilename,
      declaredMimeType: contentType,
      replacementReason: input.replacementReason ?? `Capture ${metadata.captureId}`,
      retentionClass,
      source: "telephony",
      sourceProvider: evidence.provider,
      providerDocumentId: evidence.providerRecordingId ?? metadata.captureId,
      webhookVerified: evidence.providerEventVerified,
      metadata: {
        logicalOwner: recordingLogicalOwner(
          input.brokerageId,
          input.callSessionId,
        ),
        callRecording: metadata,
      },
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "DocumentStorageError" &&
      (error as { code?: unknown }).code === "DOCUMENT_UNAVAILABLE"
    ) {
      throw new CallRecordingStorageError(
        "RECORDING_DOCUMENT_LINK_CONFLICT",
        "The recording document is already owned by a different logical call",
      );
    }
    throw error;
  }

  await logAudit(
    {
      brokerageId: input.brokerageId,
      userId: input.actorUserId,
      action: "grow_call_recording_stored",
      recordType: "grow_call_recording",
      recordId: String(input.callSessionId),
      propertyId: document.propertyId,
      providerReference: evidence.providerRecordingId ?? metadata.captureId,
      updatedValue: JSON.stringify({
        documentId: document.id,
        versionId: ingested.version.id,
        version: ingested.version.version,
        captureId: metadata.captureId,
        retentionClass,
        objectStatus: ingested.version.objectStatus,
      }),
    },
    { strict: true },
  );

  const storedMetadata = assertStoredVersionMetadata(ingested.version, {
    brokerageId: input.brokerageId,
    callSessionId: input.callSessionId,
    captureEvidence: evidence,
    retentionClass,
  });
  return resultFromIngestion(document, storedMetadata, ingested);
}

/**
 * Metadata-only convenience contract.  It never produces audio; omitted
 * bytes become a deterministic text/plain metadata artifact.
 */
export async function storeCallRecordingMetadata(
  input: StoreCallRecordingMetadataInput,
): Promise<StoredCallRecording> {
  const metadata = input.metadata ?? {};
  return storeCallRecording({
    ...input,
    durationSeconds: metadata.durationSeconds,
    channelCount: metadata.channelCount,
    sampleRateHz: metadata.sampleRateHz,
    contentType: metadata.contentType,
    originalFilename: metadata.originalFilename,
  });
}

/**
 * Internal-only seam for a future server-side telephony adapter. The adapter
 * supplies trusted evidence and metadata after its provider callback; this
 * module deliberately contains no provider webhook or audio-capture code.
 */
export type ServerCaptureMetadataProducer = (
  input: StoreCallRecordingMetadataInput,
) => Promise<StoredCallRecording>;

export interface ServerCaptureMetadataAdapter {
  produce: ServerCaptureMetadataProducer;
}

export function createServerCaptureMetadataAdapter(
  producer: ServerCaptureMetadataProducer = storeCallRecordingMetadata,
): ServerCaptureMetadataAdapter {
  return {
    produce: async (input) => producer(input),
  };
}

async function findCallRecordingVersion(
  brokerageId: number,
  callSessionId: number,
  actor?: CallRecordingActor,
): Promise<CallRecordingMetadataRead | null> {
  const callSession = await loadCallSession(brokerageId, callSessionId);
  await authorizeCallRecordingActor(callSession, brokerageId, actor);
  const rows = await db
    .select({ document: documents, version: documentObjectVersions })
    .from(documentObjectVersions)
    .innerJoin(documents, eq(documentObjectVersions.documentId, documents.id))
    .where(
      and(
        eq(documentObjectVersions.brokerageId, brokerageId),
        eq(documents.brokerageId, brokerageId),
        eq(documents.logicalOwnerType, CALL_RECORDING_LOGICAL_OWNER_TYPE),
        eq(documents.logicalOwnerId, callSessionId),
      ),
    )
    .orderBy(desc(documentObjectVersions.id));

  for (const row of rows) {
    const metadata = callRecordingMetadataFromVersion(row.version);
    if (
      metadata &&
      metadata.brokerageId === brokerageId &&
      metadata.callSessionId === callSessionId
    ) {
      const storedMetadata = assertStoredVersionMetadata(row.version, {
        brokerageId,
        callSessionId,
      });
      if (
        row.document.propertyId !== null ||
        row.document.logicalOwnerType !== CALL_RECORDING_LOGICAL_OWNER_TYPE ||
        row.document.logicalOwnerId !== callSessionId
      ) {
        throw new CallRecordingStorageError(
          "RECORDING_METADATA_CORRUPT",
          "Stored recording document is not a propertyless logical call owner",
        );
      }
      if (row.version.objectStatus !== "Active") {
        throw new CallRecordingStorageError(
          "RECORDING_UNAVAILABLE",
          "The call recording is not currently available",
        );
      }
      return {
        callSession,
        document: row.document,
        version: row.version,
        metadata: storedMetadata,
      };
    }
  }
  return null;
}

/**
 * Tenant + call scoped metadata lookup.  The call session is loaded through
 * the existing tenant-aware call metadata chokepoint before version rows are
 * inspected.
 */
export async function getCallRecordingMetadata(input: {
  brokerageId: number;
  callSessionId: number;
  actor?: CallRecordingActor;
}): Promise<CallRecordingMetadataRead | null> {
  const result = await findCallRecordingVersion(
    input.brokerageId,
    input.callSessionId,
    input.actor,
  );
  if (result) {
    await logAudit(
      {
        brokerageId: input.brokerageId,
        action: "grow_call_recording_metadata_read",
        recordType: "grow_call_recording",
        recordId: String(input.callSessionId),
        propertyId: result.document.propertyId,
        providerReference: result.metadata.providerRecordingId ?? result.metadata.captureId,
        updatedValue: JSON.stringify({
          documentId: result.document.id,
          versionId: result.version.id,
        }),
      },
      { strict: false },
    );
  }
  return result;
}

/**
 * Content/reference access stays tenant + call scoped by resolving the linked
 * active version first.  It reuses documentStorage's byte integrity check and
 * does not expose provider keys.
 */
export async function getCallRecordingContent(input: {
  brokerageId: number;
  callSessionId: number;
  actor?: CallRecordingActor;
}): Promise<(StoredDocumentContent & { metadata: CallRecordingMetadata }) | null> {
  const result = await getCallRecordingMetadata(input);
  if (!result) return null;
  const stored = await getStoredLogicalDocumentContent(
    result.document.id,
    input.brokerageId,
    recordingLogicalOwner(input.brokerageId, input.callSessionId),
  );
  if (!stored || stored.version?.id !== result.version.id) {
    throw new CallRecordingStorageError(
      "RECORDING_UNAVAILABLE",
      "The linked call recording version is no longer the active document version",
    );
  }
  return { ...stored, metadata: result.metadata };
}

/**
 * Issue the existing signed document reference only after a tenant + call
 * lookup. The bearer URL remains governed by documentStorage's existing
 * expiry/quarantine semantics; a future public route must still require the
 * same brokerage + call scope before calling this function.
 */
export async function createCallRecordingReference(input: {
  brokerageId: number;
  callSessionId: number;
  actor?: CallRecordingActor;
}): Promise<{
  version: DocumentObjectVersion;
  download: { url: string; expiresAt: Date };
} | null> {
  const result = await getCallRecordingMetadata(input);
  if (!result) return null;
  const signed = await createLogicalDocumentSignedDownload(
    result.document.id,
    input.brokerageId,
    recordingLogicalOwner(input.brokerageId, input.callSessionId),
  );
  if (signed.version.id !== result.version.id) {
    throw new CallRecordingStorageError(
      "RECORDING_UNAVAILABLE",
      "The linked call recording version is no longer the active document version",
    );
  }
  return signed;
}

/**
 * Quarantine is delegated to documentStorage so object lifecycle state and
 * audit semantics stay shared with all other stored documents.
 */
export async function quarantineCallRecording(input: {
  brokerageId: number;
  callSessionId: number;
  actorUserId?: number;
  actor?: CallRecordingActor;
}): Promise<DocumentObjectVersion | null> {
  if (input.actorUserId !== undefined && !input.actor) {
    throw new CallRecordingStorageError(
      "RECORDING_ACCESS_DENIED",
      "Quarantine requires the complete authorized recording actor context",
    );
  }
  const result = await getCallRecordingMetadata(input);
  if (!result) return null;
  const version = await quarantineLogicalDocument(
    result.document.id,
    input.brokerageId,
    recordingLogicalOwner(input.brokerageId, input.callSessionId),
  );
  if (version.id !== result.version.id) {
    throw new CallRecordingStorageError(
      "RECORDING_UNAVAILABLE",
      "The linked call recording version changed before quarantine",
    );
  }
  await logAudit(
    {
      brokerageId: input.brokerageId,
      userId: input.actorUserId,
      action: "grow_call_recording_quarantined",
      recordType: "grow_call_recording",
      recordId: String(input.callSessionId),
      propertyId: result.document.propertyId,
      providerReference: result.metadata.providerRecordingId ?? result.metadata.captureId,
      updatedValue: JSON.stringify({
        documentId: result.document.id,
        versionId: version.id,
        objectStatus: version.objectStatus,
      }),
    },
    { strict: true },
  );
  return version;
}
