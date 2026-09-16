import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { and, asc, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import {
  db,
  auditLogs,
  documentObjectVersions,
  documents,
  properties,
  type Document,
  type DocumentObjectVersion,
} from "@aee/db";
import {
  MAX_SIGNED_DOWNLOAD_SECONDS,
  ObjectIntegrityError,
  ObjectStorageRequestError,
  createObjectStorageProvider,
  type ObjectStorageProvider,
  type ReadinessResult as ProviderReadinessResult,
} from "@aee/integration-object-storage";
import { logAudit } from "./audit.js";

const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const DEFAULT_ESIGN_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_ESIGN_MAX_DOCUMENTS = 5;
const DEFAULT_PENDING_RECONCILE_AFTER_SECONDS = 5 * 60;
const DEFAULT_PENDING_QUARANTINE_AFTER_SECONDS = 24 * 60 * 60;
const DEFAULT_PENDING_RECONCILE_BATCH_SIZE = 50;
const DEFAULT_PENDING_RECONCILE_INTERVAL_SECONDS = 5 * 60;
const DEFAULT_SIGNED_DOWNLOAD_SECONDS = 300;
const DEFAULT_RETENTION_CLASSES = ["legal-pending", "transaction", "signed-agreement", "general"];

const MIME_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

export type DocumentStorageErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "EMPTY_DOCUMENT"
  | "DOCUMENT_TOO_LARGE"
  | "UNSUPPORTED_DOCUMENT_TYPE"
  | "DOCUMENT_TYPE_MISMATCH"
  | "REPLACEMENT_REASON_REQUIRED"
  | "INVALID_RETENTION_CLASS"
  | "DOCUMENT_UNAVAILABLE"
  | "DOCUMENT_INTEGRITY_FAILURE";

export class DocumentStorageError extends Error {
  constructor(
    readonly code: DocumentStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentStorageError";
  }
}

export interface IngestDocumentVersionInput {
  documentId: number;
  brokerageId: number;
  actorUserId?: number;
  bytes: Buffer;
  originalFilename: string;
  declaredMimeType: string;
  replacementReason?: string;
  retentionClass?: string;
  retainUntil?: Date;
  source: "upload" | "generated" | "esign" | "telephony";
  sourceProvider?: string;
  providerDocumentId?: string;
  webhookVerified?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Logical ownership is deliberately metadata-driven so the immutable
 * document/version ledger can support non-property records without creating a
 * parallel storage table.  The owner is checked while the document advisory
 * lock is held, not only in a caller preflight query.
 */
interface LogicalDocumentOwner {
  kind: string;
  brokerageId: number;
  ownerId: number;
}

export interface IngestDocumentVersionResult {
  version: DocumentObjectVersion;
  created: boolean;
  outcome: "created" | "resumed" | "deduplicated";
}

type DatabaseTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export interface StoredDocumentContent {
  document: Document;
  version: DocumentObjectVersion | null;
  bytes: Buffer;
  contentType: string;
  displayFilename: string;
}

let providerOverride: ObjectStorageProvider | null = null;
let cachedProvider: ObjectStorageProvider | null = null;

function storageProvider(): ObjectStorageProvider {
  if (providerOverride) return providerOverride;
  cachedProvider ??= createObjectStorageProvider();
  return cachedProvider;
}

/** Test seam; production code always uses the configured singleton provider. */
export function setDocumentStorageProviderForTests(provider: ObjectStorageProvider | null): void {
  providerOverride = provider;
  if (!provider) cachedProvider = null;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function configuredMaxDocumentBytes(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedInteger(env.DOCUMENT_STORAGE_MAX_BYTES, DEFAULT_MAX_DOCUMENT_BYTES, 1, 100 * 1024 * 1024, "DOCUMENT_STORAGE_MAX_BYTES");
}

export function configuredEsignMaxDocumentBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseBoundedInteger(
    env.DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES,
    DEFAULT_ESIGN_MAX_DOCUMENT_BYTES,
    1,
    10 * 1024 * 1024,
    "DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES",
  );
}

export function configuredEsignMaxDocuments(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parseBoundedInteger(
    env.DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS,
    DEFAULT_ESIGN_MAX_DOCUMENTS,
    1,
    10,
    "DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS",
  );
}

export function configuredDocumentWebhookMaxBytes(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const encodedDocumentBytes =
    Math.ceil(configuredEsignMaxDocumentBytes(env) / 3) * 4;
  const boundedMetadataBytesPerDocument = 8 * 1024;
  const envelopeOverheadBytes = 64 * 1024;
  return (
    configuredEsignMaxDocuments(env) *
      (encodedDocumentBytes + boundedMetadataBytesPerDocument) +
    envelopeOverheadBytes
  );
}

export function configuredPendingReconciliation(
  env: NodeJS.ProcessEnv = process.env,
): {
  reconcileAfterMs: number;
  quarantineAfterMs: number;
  batchSize: number;
  intervalMs: number;
} {
  const reconcileAfterSeconds = parseBoundedInteger(
    env.DOCUMENT_STORAGE_PENDING_RECONCILE_AFTER_SECONDS,
    DEFAULT_PENDING_RECONCILE_AFTER_SECONDS,
    30,
    7 * 24 * 60 * 60,
    "DOCUMENT_STORAGE_PENDING_RECONCILE_AFTER_SECONDS",
  );
  const quarantineAfterSeconds = parseBoundedInteger(
    env.DOCUMENT_STORAGE_PENDING_QUARANTINE_AFTER_SECONDS,
    DEFAULT_PENDING_QUARANTINE_AFTER_SECONDS,
    60,
    30 * 24 * 60 * 60,
    "DOCUMENT_STORAGE_PENDING_QUARANTINE_AFTER_SECONDS",
  );
  if (quarantineAfterSeconds <= reconcileAfterSeconds) {
    throw new Error(
      "DOCUMENT_STORAGE_PENDING_QUARANTINE_AFTER_SECONDS must exceed DOCUMENT_STORAGE_PENDING_RECONCILE_AFTER_SECONDS",
    );
  }
  return {
    reconcileAfterMs: reconcileAfterSeconds * 1_000,
    quarantineAfterMs: quarantineAfterSeconds * 1_000,
    batchSize: parseBoundedInteger(
      env.DOCUMENT_STORAGE_PENDING_RECONCILE_BATCH_SIZE,
      DEFAULT_PENDING_RECONCILE_BATCH_SIZE,
      1,
      500,
      "DOCUMENT_STORAGE_PENDING_RECONCILE_BATCH_SIZE",
    ),
    intervalMs:
      parseBoundedInteger(
        env.DOCUMENT_STORAGE_PENDING_RECONCILE_INTERVAL_SECONDS,
        DEFAULT_PENDING_RECONCILE_INTERVAL_SECONDS,
        30,
        24 * 60 * 60,
        "DOCUMENT_STORAGE_PENDING_RECONCILE_INTERVAL_SECONDS",
      ) * 1_000,
  };
}

export function configuredSignedDownloadSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return parseBoundedInteger(
    env.DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS,
    DEFAULT_SIGNED_DOWNLOAD_SECONDS,
    1,
    MAX_SIGNED_DOWNLOAD_SECONDS,
    "DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS",
  );
}

function configuredSignedDownloadSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.DOCUMENT_STORAGE_SIGNING_SECRET;
  if (env.NODE_ENV === "production" && !configured) {
    throw new Error("Production requires DOCUMENT_STORAGE_SIGNING_SECRET");
  }
  const value = configured ?? env.SESSION_SECRET ?? "development-only-document-link-secret";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 32) {
    throw new Error("DOCUMENT_STORAGE_SIGNING_SECRET must contain at least 32 bytes");
  }
  return bytes;
}

export function configuredRetentionClasses(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = (env.DOCUMENT_STORAGE_RETENTION_CLASSES ?? DEFAULT_RETENTION_CLASSES.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || values.some((value) => !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) {
    throw new Error("DOCUMENT_STORAGE_RETENTION_CLASSES must be a comma-separated list of safe class names");
  }
  return [...new Set(values)];
}

export function assertDocumentStorageConfigured(env: NodeJS.ProcessEnv = process.env): void {
  configuredMaxDocumentBytes(env);
  configuredEsignMaxDocumentBytes(env);
  configuredEsignMaxDocuments(env);
  configuredPendingReconciliation(env);
  configuredSignedDownloadSeconds(env);
  configuredSignedDownloadSecret(env);
  configuredRetentionClasses(env);
  const provider = (env.OBJECT_STORAGE_PROVIDER ?? "local").toLowerCase();
  if (env.NODE_ENV === "production" && provider !== "s3") {
    throw new Error("Production requires OBJECT_STORAGE_PROVIDER=s3; local document storage is development/test only");
  }
  createObjectStorageProvider(env);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function logicalDocumentOwner(value: unknown): LogicalDocumentOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "logicalOwner")) return null;
  const owner = record.logicalOwner;
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Logical document owner metadata is malformed",
    );
  }
  const candidate = owner as Record<string, unknown>;
  if (
    typeof candidate.kind !== "string" ||
    !Number.isSafeInteger(candidate.brokerageId) ||
    !Number.isSafeInteger(candidate.ownerId)
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Logical document owner metadata is malformed",
    );
  }
  return {
    kind: candidate.kind,
    brokerageId: candidate.brokerageId as number,
    ownerId: candidate.ownerId as number,
  };
}

function assertLogicalDocumentOwnershipWithinLock(input: {
  current: DocumentObjectVersion | null;
  document: Document;
  brokerageId: number;
  source: IngestDocumentVersionInput["source"];
  retentionClass: string;
  metadata: Record<string, unknown> | undefined;
}): void {
  const requestedOwner = logicalDocumentOwner(input.metadata);
  const existingDocumentOwner =
    input.document.brokerageId !== null &&
    input.document.logicalOwnerType !== null &&
    input.document.logicalOwnerId !== null
      ? {
          kind: input.document.logicalOwnerType,
          brokerageId: input.document.brokerageId,
          ownerId: input.document.logicalOwnerId,
        }
      : null;
  const existingVersionOwner = input.current
    ? logicalDocumentOwner(input.current.metadata)
    : null;
  const existingOwner = existingVersionOwner ?? existingDocumentOwner;

  if (existingOwner && input.source !== "telephony") {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Logical documents may only receive telephony versions",
    );
  }
  if (
    existingDocumentOwner &&
    input.current &&
    !existingVersionOwner
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A stored logical document version is missing its logical owner",
    );
  }
  if (
    existingDocumentOwner &&
    existingVersionOwner &&
    (existingDocumentOwner.kind !== existingVersionOwner.kind ||
      existingDocumentOwner.brokerageId !== existingVersionOwner.brokerageId ||
      existingDocumentOwner.ownerId !== existingVersionOwner.ownerId)
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Document and version logical owners disagree",
    );
  }
  if (
    existingOwner &&
    input.current &&
    input.current.source !== "telephony"
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Stored logical document versions must use the telephony source",
    );
  }
  if (
    input.document.propertyId === null &&
    existingOwner === null &&
    requestedOwner === null
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A propertyless document requires a complete logical owner",
    );
  }
  if (existingOwner && !requestedOwner) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A logical document owner is required for this document",
    );
  }
  if (!requestedOwner) return;
  if (requestedOwner.brokerageId !== input.brokerageId) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Logical document owner does not belong to the requested brokerage",
    );
  }
  if (
    input.document.propertyId !== null &&
    existingOwner === null
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A property-backed document cannot be claimed by a logical non-property owner",
    );
  }
  if (input.document.propertyId === null && existingDocumentOwner === null) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A propertyless document cannot be claimed without its stored logical owner",
    );
  }
  if (
    existingOwner &&
    (existingOwner.kind !== requestedOwner.kind ||
      existingOwner.brokerageId !== requestedOwner.brokerageId ||
      existingOwner.ownerId !== requestedOwner.ownerId)
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Document is already owned by a different logical record",
    );
  }
  if (
    input.document.brokerageId !== null &&
    input.document.brokerageId !== requestedOwner.brokerageId
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Document tenant owner does not match the requested logical owner",
    );
  }
  if (input.source !== "telephony") {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Logical document versions must use the telephony source",
    );
  }
  if (
    input.current &&
    existingOwner &&
    input.current.source === "telephony" &&
    input.current.retentionClass !== input.retentionClass
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "The logical recording owner has an authoritative retention class",
    );
  }
}

function normaliseMimeType(value: string): string {
  return value.split(";", 1)[0].trim().toLowerCase();
}

export function sanitiseDocumentFilename(input: string): string {
  const basename = path.posix.basename(input.replace(/\\/g, "/")).normalize("NFKC");
  const sanitised = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  return sanitised || "document";
}

export function detectDocumentMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return "text/plain";
    } catch {
      // Not valid UTF-8 text.
    }
  }
  return null;
}

function validateDocumentBytes(
  bytes: Buffer,
  originalFilename: string,
  declaredMimeType: string,
  env: NodeJS.ProcessEnv = process.env,
): { displayFilename: string; declaredMimeType: string; detectedMimeType: string; extension: string; contentSha256: string } {
  if (bytes.length === 0) {
    throw new DocumentStorageError("EMPTY_DOCUMENT", "Document content must not be empty");
  }
  if (bytes.length > configuredMaxDocumentBytes(env)) {
    throw new DocumentStorageError("DOCUMENT_TOO_LARGE", "Document exceeds the configured size limit");
  }
  const displayFilename = sanitiseDocumentFilename(originalFilename);
  const declared = normaliseMimeType(declaredMimeType);
  const detected = detectDocumentMimeType(bytes);
  if (!detected || !MIME_EXTENSIONS[detected] || !MIME_EXTENSIONS[declared]) {
    throw new DocumentStorageError("UNSUPPORTED_DOCUMENT_TYPE", "Document type is not allowed");
  }
  if (detected !== declared) {
    throw new DocumentStorageError("DOCUMENT_TYPE_MISMATCH", "Declared document type does not match its bytes");
  }
  const extension = path.extname(displayFilename).toLowerCase();
  if (!MIME_EXTENSIONS[detected].includes(extension)) {
    throw new DocumentStorageError("DOCUMENT_TYPE_MISMATCH", "Document filename extension does not match its bytes");
  }
  return {
    displayFilename,
    declaredMimeType: declared,
    detectedMimeType: detected,
    extension,
    contentSha256: sha256(bytes),
  };
}

async function loadDocumentInBrokerage(
  documentId: number,
  brokerageId: number,
  access?: LogicalDocumentOwner,
): Promise<Document | null> {
  if (access) {
    const [row] = await db
      .select({ document: documents })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.brokerageId, brokerageId),
          eq(documents.brokerageId, access.brokerageId),
          eq(documents.logicalOwnerType, access.kind),
          eq(documents.logicalOwnerId, access.ownerId),
          isNull(documents.propertyId),
        ),
      );
    return row?.document ?? null;
  }
  const [row] = await db
    .select({ document: documents })
    .from(documents)
    .innerJoin(properties, eq(documents.propertyId, properties.id))
    .where(
      and(
        eq(documents.id, documentId),
        eq(properties.brokerageId, brokerageId),
      ),
    );
  return row?.document ?? null;
}

async function validateDocumentVersionIngestionInput(
  input: IngestDocumentVersionInput,
): Promise<{
  document: Document;
  validated: {
    displayFilename: string;
    declaredMimeType: string;
    detectedMimeType: string;
    extension: string;
    contentSha256: string;
  };
  retentionClass: string;
}> {
  const document = await loadDocumentInBrokerage(
    input.documentId,
    input.brokerageId,
    input.source === "telephony"
      ? logicalDocumentOwner(input.metadata) ?? undefined
      : undefined,
  );
  if (!document) {
    throw new DocumentStorageError(
      "DOCUMENT_NOT_FOUND",
      `Document ${input.documentId} not found`,
    );
  }
  const validated = validateDocumentBytes(
    input.bytes,
    input.originalFilename,
    input.declaredMimeType,
  );
  const retentionClass = input.retentionClass ?? "legal-pending";
  if (!configuredRetentionClasses().includes(retentionClass)) {
    throw new DocumentStorageError(
      "INVALID_RETENTION_CLASS",
      "Unsupported document retention class",
    );
  }

  // This is deliberately repeated under the authoritative advisory lock in
  // ingestDocumentVersion. The preflight copy lets a multi-document caller
  // reject its whole batch before the first object or metadata write.
  const [current] = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, input.documentId),
        eq(documentObjectVersions.brokerageId, input.brokerageId),
      ),
    )
    .orderBy(desc(documentObjectVersions.version))
    .limit(1);
  const sameBytes =
    current?.contentSha256 === validated.contentSha256 &&
    current.byteSize === input.bytes.length;
  if (current?.objectStatus === "PendingUpload" && !sameBytes) {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "A previous document ingestion is still pending reconciliation",
    );
  }
  if (
    current &&
    !(sameBytes && current.objectStatus === "Active") &&
    !(sameBytes && current.objectStatus === "PendingUpload") &&
    !input.replacementReason?.trim()
  ) {
    throw new DocumentStorageError(
      "REPLACEMENT_REASON_REQUIRED",
      "A replacement reason is required when creating a new document version",
    );
  }

  return { document, validated, retentionClass };
}

/**
 * Validate tenant ownership, bytes, MIME/extension, limits, retention, and
 * replacement constraints without creating metadata or writing an object.
 */
export async function preflightDocumentVersionIngestion(
  input: IngestDocumentVersionInput,
): Promise<void> {
  await validateDocumentVersionIngestionInput(input);
}

async function versionForKey(
  documentId: number,
  brokerageId: number,
  storageObjectKey: string,
): Promise<DocumentObjectVersion | null> {
  const [version] = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, documentId),
        eq(documentObjectVersions.brokerageId, brokerageId),
        eq(documentObjectVersions.storageObjectKey, storageObjectKey),
      ),
    )
    .limit(1);
  return version ?? null;
}

async function quarantinePendingVersion(input: {
  version: DocumentObjectVersion;
  reason: string;
  action: string;
  actorUserId?: number;
  providerReference?: string;
  quarantinedAt?: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${input.version.documentId})`);
    const [quarantined] = await tx
      .update(documentObjectVersions)
      .set({
        objectStatus: "Quarantined",
        quarantinedAt: input.quarantinedAt ?? new Date(),
      })
      .where(
        and(
          eq(documentObjectVersions.id, input.version.id),
          eq(documentObjectVersions.objectStatus, "PendingUpload"),
        ),
      )
      .returning();
    if (!quarantined) return false;
    await tx.insert(auditLogs).values({
      userId: input.actorUserId ?? null,
      action: input.action,
      recordType: "document_object_version",
      recordId: String(input.version.id),
      propertyId: input.version.propertyId,
      providerReference: input.providerReference ?? null,
      previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
      updatedValue: JSON.stringify({
        objectStatus: "Quarantined",
        reason: input.reason,
      }),
    });
    return true;
  });
}

async function finalizePendingVersion(input: {
  version: DocumentObjectVersion;
  action: string;
  actorUserId?: number;
  providerReference?: string;
}): Promise<DocumentObjectVersion> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${input.version.documentId})`);
    const [currentVersion] = await tx
      .select()
      .from(documentObjectVersions)
      .where(eq(documentObjectVersions.id, input.version.id));
    if (!currentVersion) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document version is unavailable for finalization",
      );
    }
    if (currentVersion.objectStatus === "Active") return currentVersion;
    if (currentVersion.objectStatus !== "PendingUpload") {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document version requires reconciliation before finalization",
      );
    }
    const [currentDocument] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, currentVersion.documentId));
    if (!currentDocument) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document metadata no longer has a parent document",
      );
    }
    const activeVersionId = Number(
      (currentDocument.metadata as Record<string, unknown> | null)
        ?.activeObjectVersionId ?? 0,
    );
    if (activeVersionId > currentVersion.id) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "A newer document version is already active",
      );
    }
    const [activeVersion] = await tx
      .update(documentObjectVersions)
      .set({ objectStatus: "Active" })
      .where(
        and(
          eq(documentObjectVersions.id, currentVersion.id),
          eq(documentObjectVersions.objectStatus, "PendingUpload"),
        ),
      )
      .returning();
    if (!activeVersion) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document version could not be finalized",
      );
    }
    await tx
      .update(documents)
      .set({
        objectStorageKey: activeVersion.storageObjectKey,
        metadata: {
          ...((currentDocument.metadata as Record<string, unknown> | null) ?? {}),
          activeObjectVersionId: activeVersion.id,
          contentSha256: activeVersion.contentSha256,
          byteSize: activeVersion.byteSize,
          detectedMimeType: activeVersion.detectedMimeType,
          version: activeVersion.version,
        },
        updatedAt: new Date(),
      })
      .where(eq(documents.id, currentVersion.documentId));
    await tx.insert(auditLogs).values({
      userId: input.actorUserId ?? null,
      action: input.action,
      recordType: "document_object_version",
      recordId: String(activeVersion.id),
      propertyId: activeVersion.propertyId,
      providerReference: input.providerReference ?? null,
      previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
      updatedValue: JSON.stringify({
        objectStatus: "Active",
        documentId: activeVersion.documentId,
        version: activeVersion.version,
      }),
    });
    return activeVersion;
  });
}

export async function ingestDocumentVersion(
  input: IngestDocumentVersionInput,
): Promise<IngestDocumentVersionResult> {
  const { document, validated, retentionClass } =
    await validateDocumentVersionIngestionInput(input);

  const pending = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${input.documentId})`);
    const [lockedDocument] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .limit(1);
    if (!lockedDocument) {
      throw new DocumentStorageError(
        "DOCUMENT_NOT_FOUND",
        `Document ${input.documentId} not found`,
      );
    }
    const [current] = await tx
      .select()
      .from(documentObjectVersions)
      .where(
        and(
          eq(documentObjectVersions.documentId, input.documentId),
          eq(documentObjectVersions.brokerageId, input.brokerageId),
        ),
      )
      .orderBy(desc(documentObjectVersions.version))
      .limit(1);
    assertLogicalDocumentOwnershipWithinLock({
      current: current ?? null,
      document: lockedDocument,
      brokerageId: input.brokerageId,
      source: input.source,
      retentionClass,
      metadata: input.metadata,
    });

    const sameBytes =
      current?.contentSha256 === validated.contentSha256 &&
      current.byteSize === input.bytes.length;
    if (current && sameBytes && current.objectStatus === "Active") {
      return { version: current, metadataCreated: false, alreadyActive: true };
    }
    if (current?.objectStatus === "PendingUpload") {
      if (sameBytes) {
        return { version: current, metadataCreated: false, alreadyActive: false };
      }
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "A previous document ingestion is still pending reconciliation",
      );
    }
    if (current && !input.replacementReason?.trim()) {
      throw new DocumentStorageError(
        "REPLACEMENT_REASON_REQUIRED",
        "A replacement reason is required when creating a new document version",
      );
    }

    const versionNumber = (current?.version ?? 0) + 1;
    const key = [
      "tenants",
      String(input.brokerageId),
      "documents",
      String(input.documentId),
      `${randomUUID()}-v${versionNumber}${validated.extension}`,
    ].join("/");
    const [created] = await tx
      .insert(documentObjectVersions)
      .values({
        documentId: lockedDocument.id,
        brokerageId: input.brokerageId,
        propertyId: lockedDocument.propertyId,
        packageId: lockedDocument.packageId,
        storageObjectKey: key,
        version: versionNumber,
        previousVersionId: current?.id ?? null,
        originalFilename: input.originalFilename,
        displayFilename: validated.displayFilename,
        declaredMimeType: validated.declaredMimeType,
        detectedMimeType: validated.detectedMimeType,
        byteSize: input.bytes.length,
        contentSha256: validated.contentSha256,
        source: input.source,
        sourceProvider: input.sourceProvider ?? null,
        providerDocumentId: input.providerDocumentId ?? null,
        webhookVerified: input.webhookVerified ?? false,
        uploadedBy: input.actorUserId ?? null,
        replacementReason: input.replacementReason?.trim() || null,
        retentionClass,
        retainUntil: input.retainUntil ?? null,
        objectStatus: "PendingUpload",
        metadata: input.metadata ?? null,
      })
      .returning();
    await tx.insert(auditLogs).values({
      userId: input.actorUserId ?? null,
      action: "document_version_upload_pending",
      recordType: "document_object_version",
      recordId: String(created.id),
      propertyId: created.propertyId,
      providerReference: input.providerDocumentId ?? null,
      updatedValue: JSON.stringify({
        objectStatus: "PendingUpload",
        documentId: created.documentId,
        version: created.version,
        source: created.source,
      }),
    });
    return { version: created, metadataCreated: true, alreadyActive: false };
  });

  if (pending.alreadyActive) {
    return {
      version: pending.version,
      created: false,
      outcome: "deduplicated",
    };
  }

  const provider = storageProvider();
  let acknowledgement;
  try {
    await provider.putObject(
      pending.version.storageObjectKey,
      input.bytes,
      validated.detectedMimeType,
    );
    acknowledgement = await provider.headObject(pending.version.storageObjectKey);
  } catch (error) {
    await logAudit({
      userId: input.actorUserId,
      action: "document_version_storage_write_failed",
      recordType: "document_object_version",
      recordId: String(pending.version.id),
      propertyId: pending.version.propertyId,
      providerReference: input.providerDocumentId,
      previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
      updatedValue: JSON.stringify({
        objectStatus: "PendingUpload",
        retryable: true,
      }),
    });
    throw error;
  }
  if (
    acknowledgement.size !== input.bytes.length ||
    acknowledgement.checksumSha256 !== validated.contentSha256
  ) {
    await quarantinePendingVersion({
      version: pending.version,
      reason: "storage acknowledgement checksum or size mismatch",
      action: "document_version_integrity_quarantined",
      actorUserId: input.actorUserId,
      providerReference: input.providerDocumentId,
    });
    throw new DocumentStorageError(
      "DOCUMENT_INTEGRITY_FAILURE",
      "Stored document acknowledgement did not match the ingested bytes",
    );
  }

  let finalized: DocumentObjectVersion;
  try {
    finalized = await finalizePendingVersion({
      version: pending.version,
      action: pending.metadataCreated
        ? "document_version_upload_activated"
        : "document_version_upload_reconciled",
      actorUserId: input.actorUserId,
      providerReference: input.providerDocumentId,
    });
  } catch (error) {
    await logAudit({
      userId: input.actorUserId,
      action: "document_version_finalization_failed",
      recordType: "document_object_version",
      recordId: String(pending.version.id),
      propertyId: pending.version.propertyId,
      providerReference: input.providerDocumentId,
      previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
      updatedValue: JSON.stringify({
        objectStatus: "PendingUpload",
        retryable: true,
      }),
    });
    throw error;
  }

  return {
    version: finalized,
    created: pending.metadataCreated,
    outcome: pending.metadataCreated ? "created" : "resumed",
  };
}

/**
 * Ingest a related document set without exposing a partially active set.
 *
 * The caller supplies the transaction that owns the parent state transition.
 * Every document advisory lock is acquired in stable order before validation.
 * Pending metadata for the complete batch is staged before provider I/O, and
 * no version is activated until every object has been written and verified.
 * A retryable provider failure therefore leaves only resumable PendingUpload
 * rows; deterministic validation failures leave no mutation at all.
 */
export async function ingestDocumentVersionBatch(
  inputs: IngestDocumentVersionInput[],
  tx: DatabaseTransaction,
): Promise<IngestDocumentVersionResult[]> {
  if (inputs.length === 0) return [];

  const uniqueDocumentIds = [...new Set(inputs.map((input) => input.documentId))];
  if (uniqueDocumentIds.length !== inputs.length) {
    throw new DocumentStorageError(
      "DOCUMENT_TYPE_MISMATCH",
      "A document may only appear once in an ingestion batch",
    );
  }
  uniqueDocumentIds.sort((left, right) => left - right);
  for (const documentId of uniqueDocumentIds) {
    await tx.execute(sql`select pg_advisory_xact_lock(${documentId})`);
  }

  const validatedInputs: Array<{
    input: IngestDocumentVersionInput;
    document: Document;
    validated: {
      displayFilename: string;
      declaredMimeType: string;
      detectedMimeType: string;
      extension: string;
      contentSha256: string;
    };
    retentionClass: string;
    current: DocumentObjectVersion | null;
    sameBytes: boolean;
  }> = [];

  // Validate the entire batch under all locks before inserting the first row.
  for (const input of inputs) {
    const [row] = await tx
      .select({ document: documents })
      .from(documents)
      .innerJoin(properties, eq(documents.propertyId, properties.id))
      .where(
        and(
          eq(documents.id, input.documentId),
          eq(properties.brokerageId, input.brokerageId),
        ),
      );
    if (!row?.document) {
      throw new DocumentStorageError(
        "DOCUMENT_NOT_FOUND",
        `Document ${input.documentId} not found`,
      );
    }
    const validated = validateDocumentBytes(
      input.bytes,
      input.originalFilename,
      input.declaredMimeType,
    );
    const retentionClass = input.retentionClass ?? "legal-pending";
    if (!configuredRetentionClasses().includes(retentionClass)) {
      throw new DocumentStorageError(
        "INVALID_RETENTION_CLASS",
        "Unsupported document retention class",
      );
    }
    const [current] = await tx
      .select()
      .from(documentObjectVersions)
      .where(
        and(
          eq(documentObjectVersions.documentId, input.documentId),
          eq(documentObjectVersions.brokerageId, input.brokerageId),
        ),
      )
      .orderBy(desc(documentObjectVersions.version))
      .limit(1);
    assertLogicalDocumentOwnershipWithinLock({
      current: current ?? null,
      document: row.document,
      brokerageId: input.brokerageId,
      source: input.source,
      retentionClass,
      metadata: input.metadata,
    });
    const sameBytes =
      current?.contentSha256 === validated.contentSha256 &&
      current.byteSize === input.bytes.length;
    if (current?.objectStatus === "PendingUpload" && !sameBytes) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "A previous document ingestion is still pending reconciliation",
      );
    }
    if (
      current &&
      !(sameBytes && current.objectStatus === "Active") &&
      !(sameBytes && current.objectStatus === "PendingUpload") &&
      !input.replacementReason?.trim()
    ) {
      throw new DocumentStorageError(
        "REPLACEMENT_REASON_REQUIRED",
        "A replacement reason is required when creating a new document version",
      );
    }
    validatedInputs.push({
      input,
      document: row.document,
      validated,
      retentionClass,
      current: current ?? null,
      sameBytes,
    });
  }

  const pendingInputs: Array<{
    input: IngestDocumentVersionInput;
    version: DocumentObjectVersion;
    metadataCreated: boolean;
    alreadyActive: boolean;
    detectedMimeType: string;
    contentSha256: string;
  }> = [];

  for (const item of validatedInputs) {
    if (
      item.current &&
      item.sameBytes &&
      item.current.objectStatus === "Active"
    ) {
      pendingInputs.push({
        input: item.input,
        version: item.current,
        metadataCreated: false,
        alreadyActive: true,
        detectedMimeType: item.validated.detectedMimeType,
        contentSha256: item.validated.contentSha256,
      });
      continue;
    }
    if (
      item.current &&
      item.sameBytes &&
      item.current.objectStatus === "PendingUpload"
    ) {
      pendingInputs.push({
        input: item.input,
        version: item.current,
        metadataCreated: false,
        alreadyActive: false,
        detectedMimeType: item.validated.detectedMimeType,
        contentSha256: item.validated.contentSha256,
      });
      continue;
    }

    const versionNumber = (item.current?.version ?? 0) + 1;
    const key = [
      "tenants",
      String(item.input.brokerageId),
      "documents",
      String(item.input.documentId),
      `${randomUUID()}-v${versionNumber}${item.validated.extension}`,
    ].join("/");
    const [created] = await tx
      .insert(documentObjectVersions)
      .values({
        documentId: item.document.id,
        brokerageId: item.input.brokerageId,
        propertyId: item.document.propertyId,
        packageId: item.document.packageId,
        storageObjectKey: key,
        version: versionNumber,
        previousVersionId: item.current?.id ?? null,
        originalFilename: item.input.originalFilename,
        displayFilename: item.validated.displayFilename,
        declaredMimeType: item.validated.declaredMimeType,
        detectedMimeType: item.validated.detectedMimeType,
        byteSize: item.input.bytes.length,
        contentSha256: item.validated.contentSha256,
        source: item.input.source,
        sourceProvider: item.input.sourceProvider ?? null,
        providerDocumentId: item.input.providerDocumentId ?? null,
        webhookVerified: item.input.webhookVerified ?? false,
        uploadedBy: item.input.actorUserId ?? null,
        replacementReason: item.input.replacementReason?.trim() || null,
        retentionClass: item.retentionClass,
        retainUntil: item.input.retainUntil ?? null,
        objectStatus: "PendingUpload",
        metadata: item.input.metadata ?? null,
      })
      .returning();
    await tx.insert(auditLogs).values({
      userId: item.input.actorUserId ?? null,
      action: "document_version_upload_pending",
      recordType: "document_object_version",
      recordId: String(created.id),
      propertyId: created.propertyId,
      providerReference: item.input.providerDocumentId ?? null,
      updatedValue: JSON.stringify({
        objectStatus: "PendingUpload",
        documentId: created.documentId,
        version: created.version,
        source: created.source,
      }),
    });
    pendingInputs.push({
      input: item.input,
      version: created,
      metadataCreated: true,
      alreadyActive: false,
      detectedMimeType: item.validated.detectedMimeType,
      contentSha256: item.validated.contentSha256,
    });
  }

  const provider = storageProvider();
  for (const pending of pendingInputs) {
    if (pending.alreadyActive) continue;
    try {
      await provider.putObject(
        pending.version.storageObjectKey,
        pending.input.bytes,
        pending.detectedMimeType,
      );
      const acknowledgement = await provider.headObject(
        pending.version.storageObjectKey,
      );
      if (
        acknowledgement.size !== pending.input.bytes.length ||
        acknowledgement.checksumSha256 !== pending.contentSha256
      ) {
        await tx
          .update(documentObjectVersions)
          .set({
            objectStatus: "Quarantined",
            quarantinedAt: new Date(),
          })
          .where(
            and(
              eq(documentObjectVersions.id, pending.version.id),
              eq(documentObjectVersions.objectStatus, "PendingUpload"),
            ),
          );
        await tx.insert(auditLogs).values({
          userId: pending.input.actorUserId ?? null,
          action: "document_version_integrity_quarantined",
          recordType: "document_object_version",
          recordId: String(pending.version.id),
          propertyId: pending.version.propertyId,
          providerReference: pending.input.providerDocumentId ?? null,
          previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
          updatedValue: JSON.stringify({
            objectStatus: "Quarantined",
            reason: "storage acknowledgement checksum or size mismatch",
          }),
        });
        throw new DocumentStorageError(
          "DOCUMENT_INTEGRITY_FAILURE",
          "Stored document acknowledgement did not match the ingested bytes",
        );
      }
    } catch (error) {
      await tx.insert(auditLogs).values({
        userId: pending.input.actorUserId ?? null,
        action: "document_version_storage_write_failed",
        recordType: "document_object_version",
        recordId: String(pending.version.id),
        propertyId: pending.version.propertyId,
        providerReference: pending.input.providerDocumentId ?? null,
        previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
        updatedValue: JSON.stringify({
          objectStatus:
            error instanceof DocumentStorageError &&
            error.code === "DOCUMENT_INTEGRITY_FAILURE"
              ? "Quarantined"
              : "PendingUpload",
          retryable: true,
        }),
      });
      throw error;
    }
  }

  // Every provider write is verified. Activate the complete batch as part of
  // the caller's transaction so package/signature state and active pointers
  // commit or roll back together.
  const results: IngestDocumentVersionResult[] = [];
  for (const pending of pendingInputs) {
    if (pending.alreadyActive) {
      results.push({
        version: pending.version,
        created: false,
        outcome: "deduplicated",
      });
      continue;
    }
    const [activeVersion] = await tx
      .update(documentObjectVersions)
      .set({ objectStatus: "Active" })
      .where(
        and(
          eq(documentObjectVersions.id, pending.version.id),
          eq(documentObjectVersions.objectStatus, "PendingUpload"),
        ),
      )
      .returning();
    if (!activeVersion) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document version could not be finalized",
      );
    }
    const [currentDocument] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, activeVersion.documentId));
    if (!currentDocument) {
      throw new DocumentStorageError(
        "DOCUMENT_UNAVAILABLE",
        "Pending document metadata no longer has a parent document",
      );
    }
    await tx
      .update(documents)
      .set({
        objectStorageKey: activeVersion.storageObjectKey,
        metadata: {
          ...((currentDocument.metadata as Record<string, unknown> | null) ?? {}),
          activeObjectVersionId: activeVersion.id,
          contentSha256: activeVersion.contentSha256,
          byteSize: activeVersion.byteSize,
          detectedMimeType: activeVersion.detectedMimeType,
          version: activeVersion.version,
        },
        updatedAt: new Date(),
      })
      .where(eq(documents.id, activeVersion.documentId));
    await tx.insert(auditLogs).values({
      userId: pending.input.actorUserId ?? null,
      action: pending.metadataCreated
        ? "document_version_upload_activated"
        : "document_version_upload_reconciled",
      recordType: "document_object_version",
      recordId: String(activeVersion.id),
      propertyId: activeVersion.propertyId,
      providerReference: pending.input.providerDocumentId ?? null,
      previousValue: JSON.stringify({ objectStatus: "PendingUpload" }),
      updatedValue: JSON.stringify({
        objectStatus: "Active",
        documentId: activeVersion.documentId,
        version: activeVersion.version,
      }),
    });
    results.push({
      version: activeVersion,
      created: pending.metadataCreated,
      outcome: pending.metadataCreated ? "created" : "resumed",
    });
  }
  return results;
}

function isObjectNotFound(error: unknown): boolean {
  return (
    (error instanceof ObjectStorageRequestError && error.statusCode === 404) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT")
  );
}

export interface PendingDocumentReconciliationResult {
  scanned: number;
  finalized: number;
  quarantinedMissing: number;
  quarantinedIntegrity: number;
  deferredMissing: number;
  deferredProviderError: number;
  deferredTransitionError: number;
  skippedConcurrentTransition: number;
  nextCursor: number | null;
}

export interface PendingDocumentReconciliationOptions {
  now?: Date;
  afterId?: number;
  limit?: number;
  reconcileAfterMs?: number;
  quarantineAfterMs?: number;
}

export async function reconcilePendingDocumentVersions(
  options: PendingDocumentReconciliationOptions = {},
): Promise<PendingDocumentReconciliationResult> {
  const configured = configuredPendingReconciliation();
  const now = options.now ?? new Date();
  const reconcileAfterMs = options.reconcileAfterMs ?? configured.reconcileAfterMs;
  const quarantineAfterMs =
    options.quarantineAfterMs ?? configured.quarantineAfterMs;
  const limit = options.limit ?? configured.batchSize;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    reconcileAfterMs < 0 ||
    quarantineAfterMs < reconcileAfterMs
  ) {
    throw new Error("Invalid pending document reconciliation options");
  }
  const afterId = options.afterId ?? 0;
  const rows = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.objectStatus, "PendingUpload"),
        // E-sign completions are multi-document batches. Finalizing one row
        // here could expose a partial signed set while its envelope remains
        // Sent. Only an authenticated provider redelivery may resume and
        // atomically activate those rows through ingestDocumentVersionBatch.
        ne(documentObjectVersions.source, "esign"),
        lte(
          documentObjectVersions.createdAt,
          new Date(now.getTime() - reconcileAfterMs),
        ),
        gt(documentObjectVersions.id, afterId),
      ),
    )
    .orderBy(asc(documentObjectVersions.id))
    .limit(limit);
  const result: PendingDocumentReconciliationResult = {
    scanned: rows.length,
    finalized: 0,
    quarantinedMissing: 0,
    quarantinedIntegrity: 0,
    deferredMissing: 0,
    deferredProviderError: 0,
    deferredTransitionError: 0,
    skippedConcurrentTransition: 0,
    nextCursor: rows.length === limit ? rows[rows.length - 1]!.id : null,
  };
  const provider = storageProvider();

  for (const version of rows) {
    let bytes: Buffer;
    try {
      const head = await provider.headObject(version.storageObjectKey);
      bytes = await provider.getObject(version.storageObjectKey);
      if (
        head.size !== version.byteSize ||
        bytes.length !== version.byteSize ||
        head.checksumSha256 !== version.contentSha256 ||
        sha256(bytes) !== version.contentSha256
      ) {
        const transitioned = await quarantinePendingVersion({
          version,
          action: "document_version_pending_integrity_quarantined",
          reason:
            "aged pending object checksum or size did not match immutable metadata",
          providerReference: version.providerDocumentId ?? undefined,
          quarantinedAt: now,
        });
        if (transitioned) result.quarantinedIntegrity += 1;
        else result.skippedConcurrentTransition += 1;
        continue;
      }
    } catch (error) {
      if (isObjectNotFound(error)) {
        if (now.getTime() - version.createdAt.getTime() >= quarantineAfterMs) {
          try {
            const transitioned = await quarantinePendingVersion({
              version,
              action: "document_version_pending_missing_quarantined",
              reason:
                "pending object remained absent beyond the reconciliation window",
              providerReference: version.providerDocumentId ?? undefined,
              quarantinedAt: now,
            });
            if (transitioned) result.quarantinedMissing += 1;
            else result.skippedConcurrentTransition += 1;
          } catch {
            result.deferredTransitionError += 1;
          }
        } else {
          result.deferredMissing += 1;
        }
      } else {
        result.deferredProviderError += 1;
      }
      continue;
    }

    try {
      await finalizePendingVersion({
        version,
        action: "document_version_pending_reconciled",
        providerReference: version.providerDocumentId ?? undefined,
      });
      result.finalized += 1;
    } catch {
      result.deferredTransitionError += 1;
    }
  }

  return result;
}

async function getStoredDocumentContentWithAccess(
  documentId: number,
  brokerageId: number,
  access?: LogicalDocumentOwner,
): Promise<StoredDocumentContent | null> {
  const document = await loadDocumentInBrokerage(documentId, brokerageId, access);
  if (!document || !document.objectStorageKey) return null;
  const version = await versionForKey(
    documentId,
    brokerageId,
    document.objectStorageKey,
  );
  if (!version && process.env.NODE_ENV === "production") {
    throw new DocumentStorageError(
      "DOCUMENT_UNAVAILABLE",
      "Legacy document must be reconciled into immutable version metadata before production access",
    );
  }
  if (version && version.objectStatus !== "Active") {
    throw new DocumentStorageError("DOCUMENT_UNAVAILABLE", "Stored document is not available");
  }
  try {
    const bytes = await storageProvider().getObject(document.objectStorageKey);
    if (
      version &&
      (bytes.length !== version.byteSize || sha256(bytes) !== version.contentSha256)
    ) {
      throw new DocumentStorageError(
        "DOCUMENT_INTEGRITY_FAILURE",
        "Stored document failed byte-for-byte integrity verification",
      );
    }
    return {
      document,
      version,
      bytes,
      contentType: version?.detectedMimeType ?? "text/plain",
      displayFilename: version?.displayFilename ?? `document-${document.id}.txt`,
    };
  } catch (error) {
    if (error instanceof ObjectIntegrityError) {
      throw new DocumentStorageError(
        "DOCUMENT_INTEGRITY_FAILURE",
        "Stored document failed byte-for-byte integrity verification",
      );
    }
    throw error;
  }
}

/**
 * Internal telephony-only loader. Generic document routes must use
 * getStoredDocumentContent(), which intentionally resolves property-backed
 * documents only.
 */
export async function getStoredLogicalDocumentContent(
  documentId: number,
  brokerageId: number,
  access: LogicalDocumentOwner,
): Promise<StoredDocumentContent | null> {
  return getStoredDocumentContentWithAccess(documentId, brokerageId, access);
}

export async function getStoredDocumentContent(
  documentId: number,
  brokerageId: number,
): Promise<StoredDocumentContent | null> {
  return getStoredDocumentContentWithAccess(documentId, brokerageId);
}

export async function createDocumentSignedDownload(
  documentId: number,
  brokerageId: number,
): Promise<{ version: DocumentObjectVersion; download: { url: string; expiresAt: Date } }> {
  const document = await loadDocumentInBrokerage(documentId, brokerageId);
  const version = document?.objectStorageKey
    ? await versionForKey(documentId, brokerageId, document.objectStorageKey)
    : null;
  if (
    !document ||
    !version ||
    version.objectStatus !== "Active" ||
    document.objectStorageKey !== version.storageObjectKey
  ) {
    throw new DocumentStorageError("DOCUMENT_NOT_FOUND", `Document ${documentId} not found`);
  }
  // Verify the exact bytes before issuing access. Redemption verifies again,
  // so corruption or quarantine after link creation still fails closed.
  await getStoredDocumentContentWithAccess(documentId, brokerageId);
  const expiresAt = new Date(Date.now() + configuredSignedDownloadSeconds() * 1_000);
  const expires = Math.floor(expiresAt.getTime() / 1_000);
  const payload = `${version.id}\n${expires}`;
  const signature = createHmac("sha256", configuredSignedDownloadSecret())
    .update(payload)
    .digest("base64url");
  return {
    version,
    download: {
      url: `/api/documents/signed-download/${version.id}?expires=${expires}&signature=${signature}`,
      expiresAt,
    },
  };
}

/** Internal telephony-only signed-reference loader. */
export async function createLogicalDocumentSignedDownload(
  documentId: number,
  brokerageId: number,
  access: LogicalDocumentOwner,
): Promise<{ version: DocumentObjectVersion; download: { url: string; expiresAt: Date } }> {
  const document = await loadDocumentInBrokerage(documentId, brokerageId, access);
  const version = document?.objectStorageKey
    ? await versionForKey(documentId, brokerageId, document.objectStorageKey)
    : null;
  if (
    !document ||
    !version ||
    version.objectStatus !== "Active" ||
    document.objectStorageKey !== version.storageObjectKey
  ) {
    throw new DocumentStorageError("DOCUMENT_NOT_FOUND", `Document ${documentId} not found`);
  }
  await getStoredDocumentContentWithAccess(documentId, brokerageId, access);
  const expiresAt = new Date(Date.now() + configuredSignedDownloadSeconds() * 1_000);
  const expires = Math.floor(expiresAt.getTime() / 1_000);
  const payload = `${version.id}\n${expires}`;
  const signature = createHmac("sha256", configuredSignedDownloadSecret())
    .update(payload)
    .digest("base64url");
  return {
    version,
    download: {
      url: `/api/documents/signed-download/${version.id}?expires=${expires}&signature=${signature}`,
      expiresAt,
    },
  };
}

function verifySignedDownloadToken(
  versionId: number,
  expires: number,
  suppliedSignature: string,
): void {
  if (
    !Number.isSafeInteger(versionId) ||
    versionId < 1 ||
    !Number.isSafeInteger(expires) ||
    expires < Math.floor(Date.now() / 1_000) ||
    expires > Math.floor(Date.now() / 1_000) + MAX_SIGNED_DOWNLOAD_SECONDS ||
    !suppliedSignature
  ) {
    throw new DocumentStorageError("DOCUMENT_UNAVAILABLE", "Signed document link is invalid or expired");
  }
  const expected = createHmac("sha256", configuredSignedDownloadSecret())
    .update(`${versionId}\n${expires}`)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new DocumentStorageError("DOCUMENT_UNAVAILABLE", "Signed document link is invalid or expired");
  }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new DocumentStorageError("DOCUMENT_UNAVAILABLE", "Signed document link is invalid or expired");
  }
}

export async function redeemDocumentSignedDownload(
  versionId: number,
  expires: number,
  signature: string,
): Promise<StoredDocumentContent> {
  verifySignedDownloadToken(versionId, expires, signature);
  const [row] = await db
    .select({ document: documents, version: documentObjectVersions })
    .from(documentObjectVersions)
    .innerJoin(documents, eq(documentObjectVersions.documentId, documents.id))
    .where(eq(documentObjectVersions.id, versionId));
  if (
    !row ||
    row.version.objectStatus !== "Active" ||
    row.document.objectStorageKey !== row.version.storageObjectKey
  ) {
    throw new DocumentStorageError("DOCUMENT_UNAVAILABLE", "Signed document link is unavailable");
  }
  const bytes = await storageProvider().getObject(row.version.storageObjectKey);
  if (
    bytes.length !== row.version.byteSize ||
    sha256(bytes) !== row.version.contentSha256
  ) {
    throw new DocumentStorageError(
      "DOCUMENT_INTEGRITY_FAILURE",
      "Stored document failed byte-for-byte integrity verification",
    );
  }
  return {
    document: row.document,
    version: row.version,
    bytes,
    contentType: row.version.detectedMimeType,
    displayFilename: row.version.displayFilename,
  };
}

export async function quarantineDocument(
  documentId: number,
  brokerageId: number,
): Promise<DocumentObjectVersion> {
  const document = await loadDocumentInBrokerage(documentId, brokerageId);
  const version = document?.objectStorageKey
    ? await versionForKey(documentId, brokerageId, document.objectStorageKey)
    : null;
  if (!document || !version || version.objectStatus !== "Active") {
    throw new DocumentStorageError("DOCUMENT_NOT_FOUND", `Document ${documentId} not found`);
  }
  const [updated] = await db
    .update(documentObjectVersions)
    .set({ objectStatus: "Quarantined", quarantinedAt: new Date() })
    .where(
      and(
        eq(documentObjectVersions.id, version.id),
        eq(documentObjectVersions.brokerageId, brokerageId),
      ),
    )
    .returning();
  return updated;
}

/** Internal telephony-only quarantine loader. */
export async function quarantineLogicalDocument(
  documentId: number,
  brokerageId: number,
  access: LogicalDocumentOwner,
): Promise<DocumentObjectVersion> {
  const document = await loadDocumentInBrokerage(documentId, brokerageId, access);
  const version = document?.objectStorageKey
    ? await versionForKey(documentId, brokerageId, document.objectStorageKey)
    : null;
  if (!document || !version || version.objectStatus !== "Active") {
    throw new DocumentStorageError("DOCUMENT_NOT_FOUND", `Document ${documentId} not found`);
  }
  const [updated] = await db
    .update(documentObjectVersions)
    .set({ objectStatus: "Quarantined", quarantinedAt: new Date() })
    .where(
      and(
        eq(documentObjectVersions.id, version.id),
        eq(documentObjectVersions.brokerageId, brokerageId),
      ),
    )
    .returning();
  return updated;
}

export async function checkDocumentStorageReadiness(): Promise<ProviderReadinessResult> {
  return storageProvider().checkReadiness();
}