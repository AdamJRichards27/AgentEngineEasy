import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  db,
  growCallTranscriptions,
  growCallRecordingConsents,
  growConsentDecisions,
  documentObjectVersions,
  documents,
  users,
  type GrowCallTranscription,
} from "@aee/db";
import {
  buildCallTranscriptionProvider,
  loadVoiceTranscriptionConfig,
} from "../ai/voice/gateway.js";
import { isGrowCallSummaryEnabled } from "../ai/featureFlags.js";
import { generateCallTranscriptionDrafts } from "./callTranscriptionDrafts.js";
import {
  assertTranscriptSizeIsSane,
  TranscriptionProviderError,
  type TranscriptionProvider,
} from "../ai/voice/types.js";
import { validateVoiceAudioUpload } from "../ai/voice/audioValidation.js";
import { logAudit } from "../audit.js";
import { hasEntitlement } from "../entitlements/resolver.js";
import { type ConsentTransaction, writeAuditInTransaction } from "../consentControlsPersistence.js";
import {
  getCallSessionForBrokerage,
  GrowCallSessionAuthorizationError,
  GrowCallSessionNotFoundError,
} from "./callSessions.js";
import {
  CallRecordingStorageError,
  getCallRecordingContent,
} from "./recordingStorage.js";
import { LIVE_RECORDING_APPROVAL_ENV } from "./recordingGates.js";
import {
  CALL_TRANSCRIPTION_MAX_RETRIES,
  boundedCallTranscriptionTimeout,
  callTranscriptionRetryDelayMs,
  classifyCallTranscriptionFailure,
  isRetryableCallTranscriptionFailure,
  type CallTranscriptionFailureReason,
} from "./callTranscriptionPolicy.js";

/**
 * F3's input intentionally has no client-supplied permission, gate, consent,
 * or provider fields.  The recording version and the earlier F2 audit trail
 * are both re-read on the server before this can claim a transcription.
 */
export interface InitiateCallTranscriptionInput {
  brokerageId: number;
  callSessionId: number;
  recordingReference: number;
  actor: {
    userId: number;
    role: string;
    brokerageId: number;
  };
}

export type CallTranscriptionErrorCode =
  | "INVALID_INPUT"
  | "ACCESS_DENIED"
  | "ENTITLEMENT_REQUIRED"
  | "CALL_NOT_FOUND"
  | "RECORDING_UNAVAILABLE"
  | "RECORDING_DELETED"
  | "RECORDING_REFERENCE_MISMATCH"
  | "F2_EVIDENCE_MISSING"
  | "F2_EVIDENCE_INVALID"
  | "CONSENT_WITHDRAWN"
  | "PROVIDER_FAILED"
  | "TENANT_MISMATCH"
  | "LIVE_PROVIDER_DISABLED";

export class CallTranscriptionError extends Error {
  constructor(
    readonly code: CallTranscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CallTranscriptionError";
  }
}

let testProviderOverride: TranscriptionProvider | null = null;
let testAuditFailureAction: string | null = null;

/**
 * The only dependency-injection seam. It is deliberately unavailable outside
 * NODE_ENV=test, so production cannot bypass gateway provider activation.
 */
export function setCallTranscriptionProviderForTests(
  provider: TranscriptionProvider | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Call transcription provider override is test-only.");
  }
  testProviderOverride = provider;
}

/** Test-only strict-audit outage seam; production always writes through logAudit. */
export function setCallTranscriptionAuditFailureForTests(action: string | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Call transcription audit override is test-only.");
  }
  testAuditFailureAction = action;
}

/** Shared by the terminal reconciler's strict-audit test path. */
export function shouldFailCallTranscriptionAuditForTests(action: string): boolean {
  if (process.env.NODE_ENV !== "test") return false;
  return testAuditFailureAction === action;
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseEvidence(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/**
 * Durable failure values are an allowlist, not provider/runtime exception
 * strings.  Keeping this conversion at the processing boundary also means a
 * future provider cannot accidentally leak response text into the database.
 */
function durableFailureReason(error: unknown): CallTranscriptionFailureReason {
  if (error instanceof CallTranscriptionError) {
    const value = error.code as string;
    if (
      value === "RECORDING_UNAVAILABLE" ||
      value === "RECORDING_DELETED" ||
      value === "TENANT_MISMATCH" ||
      value === "F2_EVIDENCE_MISSING" ||
      value === "F2_EVIDENCE_INVALID" ||
      value === "CONSENT_WITHDRAWN" ||
      value === "ACCESS_DENIED" ||
      value === "ENTITLEMENT_REQUIRED" ||
      value === "INVALID_INPUT" ||
      value === "RECORDING_REFERENCE_MISMATCH"
    ) return value as CallTranscriptionFailureReason;
    if (value === "CALL_NOT_FOUND") return "RECORDING_UNAVAILABLE";
    if (value === "LIVE_PROVIDER_DISABLED") return value;
    if (value === "PROVIDER_FAILED") return "AUDIT_FAILURE";
  }
  return classifyCallTranscriptionFailure(error);
}

/**
 * Denials that describe the caller rather than the recording source. These
 * must never be converted into a durable state transition on an artifact the
 * caller did not claim: a non-owner, unentitled, or mismatched actor cannot
 * fail somebody else's transcription.
 */
function isActorSpecificDenial(error: unknown): boolean {
  return error instanceof CallTranscriptionError && (
    error.code === "ACCESS_DENIED" ||
    error.code === "ENTITLEMENT_REQUIRED" ||
    error.code === "TENANT_MISMATCH" ||
    error.code === "INVALID_INPUT"
  );
}

function isDeletedRecordingStatus(status: string | null | undefined): boolean {
  return status === "SoftDeleted" || status === "Destroyed" || status === "Deleted";
}

function sameNullable<T>(column: T, value: unknown) {
  return sql`${column} is not distinct from ${value}`;
}

const transcriptionUpdatedAtToken = sql<string>`${growCallTranscriptions.updatedAt}::text`.as("updated_at_token");
function sameUpdatedAtToken(token: string) {
  return sql`${growCallTranscriptions.updatedAt}::text = ${token}`;
}

type TranscriptionSnapshot = {
  row: GrowCallTranscription;
  updatedAtToken: string;
};

async function strictAudit(
  input: Pick<InitiateCallTranscriptionInput, "brokerageId" | "callSessionId" | "recordingReference"> & {
    userId?: number;
    action: string;
    reason: string;
    transcriptionId?: number;
  },
): Promise<void> {
  try {
    if (testAuditFailureAction === input.action) throw new Error("synthetic strict audit outage");
    await logAudit({
      brokerageId: input.brokerageId,
      userId: input.userId,
      action: input.action,
      recordType: "grow_call_transcription",
      recordId: String(input.transcriptionId ?? input.callSessionId),
      // References only: never transcript, recording bytes, object key, or
      // provider credentials are written into audit data.
      providerReference: `call:${input.callSessionId}:recording:${input.recordingReference}`,
      updatedValue: input.reason,
    }, { strict: true });
  } catch {
    throw new CallTranscriptionError("PROVIDER_FAILED", "The transcription state audit could not be recorded.");
  }
}

async function strictAuditInTransaction(
  tx: ConsentTransaction,
  input: Parameters<typeof strictAudit>[0],
): Promise<void> {
  try {
    if (testAuditFailureAction === input.action) throw new Error("synthetic strict audit outage");
    await logAudit({
      brokerageId: input.brokerageId,
      userId: input.userId,
      action: input.action,
      recordType: "grow_call_transcription",
      recordId: String(input.transcriptionId ?? input.callSessionId),
      providerReference: `call:${input.callSessionId}:recording:${input.recordingReference}`,
      updatedValue: input.reason,
    }, { strict: true, write: (audit) => writeAuditInTransaction(tx, audit) });
  } catch {
    // Throw inside the transaction so the paired state write is rolled back,
    // while giving the route a typed fail-closed error.
    throw new CallTranscriptionError("PROVIDER_FAILED", "The transcription state audit could not be recorded.");
  }
}

async function reject(
  input: InitiateCallTranscriptionInput,
  code: CallTranscriptionErrorCode,
  message: string,
): Promise<never> {
  // There is no tenant-safe foreign-key target to audit when the tenant
  // identifier itself is malformed. All tenant-addressable rejects below are
  // strict-audited; malformed transport input still receives a typed error.
  if (!validId(input?.brokerageId)) {
    throw new CallTranscriptionError(code, message);
  }
  await strictAudit({
    ...input,
    userId: validId(input.actor?.userId) ? input.actor.userId : undefined,
    action: "grow_call_transcription_rejected",
    reason: code,
  });
  throw new CallTranscriptionError(code, message);
}

/**
 * F3 does not re-evaluate F2's live gates. It verifies the immutable,
 * persisted outcome that confirmInCallRecording recorded at the time of
 * confirmation, along with the independently persisted confirmation event.
 */
async function assertPersistedF2Evidence(input: InitiateCallTranscriptionInput, recording: {
  metadata: {
    partyId: number;
    capturedAt: string;
    provider: string;
    recordingStatusAtCapture: string;
    recordingPermittedAtCapture: true;
    recordingConsentIdAtCapture: number | null;
  };
  callSession: {
    partyId: number;
    recordingConsentId: number | null;
    destinationCountry: string;
    provider: string;
  };
}): Promise<void> {
  const captureAt = new Date(recording.metadata.capturedAt);
  if (
    Number.isNaN(captureAt.getTime()) ||
    captureAt.getTime() > Date.now() ||
    recording.metadata.recordingStatusAtCapture !== "PERMITTED_NOT_CAPTURED" ||
    recording.metadata.recordingPermittedAtCapture !== true ||
    recording.metadata.recordingConsentIdAtCapture === null ||
    recording.metadata.recordingConsentIdAtCapture !== recording.callSession.recordingConsentId
  ) {
    await reject(input, "F2_EVIDENCE_INVALID", "The recording does not retain a valid F2 capture permission snapshot.");
  }
  const captureConsentId = recording.metadata.recordingConsentIdAtCapture as number | null;
  if (captureConsentId === null) {
    // Kept explicit for TypeScript and defensive future metadata changes.
    await reject(input, "F2_EVIDENCE_INVALID", "The recording does not retain a valid F2 capture permission snapshot.");
  }
  const requiredCaptureConsentId = captureConsentId as number;

  const audits = await db
    .select()
    .from(auditLogs)
    .where(and(
      eq(auditLogs.brokerageId, input.brokerageId),
      eq(auditLogs.recordType, "grow_call_session"),
      eq(auditLogs.recordId, String(input.callSessionId)),
    ))
    .orderBy(desc(auditLogs.id));

  const confirmations = audits.filter((audit) =>
    audit.action === "grow_call_recording_confirmation_received" &&
    audit.updatedValue === "CONFIRMED" &&
    audit.userId !== null &&
    new Date(audit.createdAt).getTime() <= captureAt.getTime(),
  );
  if (confirmations.length === 0) {
    await reject(input, "F2_EVIDENCE_MISSING", "No persisted in-call recording confirmation supports this capture.");
  }

  const enabledAudits = audits.filter((audit) =>
    audit.action === "grow_call_recording_enabled" &&
    audit.userId !== null &&
    new Date(audit.createdAt).getTime() <= captureAt.getTime(),
  );

  for (const enabled of enabledAudits) {
    const evidence = parseEvidence(enabled.updatedValue);
    const gates = asRecord(evidence?.gates);
    const entitlement = asRecord(gates?.entitlement);
    const legalPolicy = asRecord(gates?.legalPolicy);
    const legacy = asRecord(gates?.legacyConsentAndDisclosure);
    const adapter = asRecord(gates?.adapterCapability);
    const operational = asRecord(gates?.operationalApproval);
    const evaluatedAt = new Date(typeof evidence?.evaluatedAt === "string" ? evidence.evaluatedAt : "");
    const allFivePassed = evidence?.allPassed === true &&
      evidence?.requested === true &&
      !Number.isNaN(evaluatedAt.getTime()) &&
      evaluatedAt.getTime() <= captureAt.getTime() &&
      ["entitlement", "legalPolicy", "legacyConsentAndDisclosure", "adapterCapability", "operationalApproval"]
        .every((key) => asRecord(gates?.[key])?.passed === true);
    const consentMatches =
      legacy?.consentId === requiredCaptureConsentId &&
      legacy?.disclosedInCall === true &&
      legacy?.confirmedInCall === true;
    const gateBindings =
      entitlement?.entitlementKey === "grow.calling.recording" &&
      adapter?.provider === recording.metadata.provider &&
      recording.metadata.provider === recording.callSession.provider &&
      operational?.flag === LIVE_RECORDING_APPROVAL_ENV;
    const decisionId = evidence?.outboundDecisionId;
    const confirmation = confirmations.find((audit) =>
      audit.userId === enabled.userId &&
      new Date(audit.createdAt).getTime() <= new Date(enabled.createdAt).getTime(),
    );
    if (!allFivePassed || !consentMatches || !gateBindings || !confirmation || !validId(decisionId)) continue;

    const [decision] = await db.select().from(growConsentDecisions).where(and(
      eq(growConsentDecisions.id, decisionId),
      eq(growConsentDecisions.brokerageId, input.brokerageId),
      eq(growConsentDecisions.partyId, recording.metadata.partyId),
    )).limit(1);
    const decisionEvidence = asRecord(decision?.evidence);
    const request = asRecord(decisionEvidence?.request);
    const [recordingConsent] = await db.select().from(growCallRecordingConsents).where(and(
      eq(growCallRecordingConsents.id, requiredCaptureConsentId),
      eq(growCallRecordingConsents.brokerageId, input.brokerageId),
      eq(growCallRecordingConsents.partyId, recording.metadata.partyId),
    )).limit(1);
    if (
      decision?.decision === "ELIGIBLE" &&
      decision.decidedByUserId === enabled.userId &&
      evidence?.outboundReasonCode === decision.reasonCode &&
      new Date(decision.evaluatedAt).getTime() <= captureAt.getTime() &&
      decision.channel === "PHONE_CALL" &&
      decision.jurisdiction === legalPolicy?.jurisdiction &&
      decision.jurisdiction === recording.callSession.destinationCountry &&
      decision.policyVersion === legalPolicy?.policyVersion &&
      recordingConsent?.id === requiredCaptureConsentId &&
      recordingConsent.jurisdiction === legacy?.consentJurisdiction &&
      request?.brokerageId === input.brokerageId &&
      request?.partyId === recording.metadata.partyId &&
      request?.channel === "PHONE_CALL" &&
      request?.purpose === "PHONE_CALL" &&
      request?.scope === "OUTBOUND"
    ) {
      return;
    }
  }
  await reject(input, enabledAudits.length === 0 ? "F2_EVIDENCE_MISSING" : "F2_EVIDENCE_INVALID", "The recording is not supported by complete persisted F2 confirmation evidence.");
}

function isRecordingConsentWithdrawn(consent: {
  status: string;
  withdrawnAt: Date | null;
} | undefined): boolean {
  // Deny by default: only a present, never-withdrawn consent row permits new
  // processing. Withdrawal never deletes the recording, transcript, or evidence.
  return !consent || consent.status === "WITHDRAWN" || consent.withdrawnAt !== null;
}

/**
 * F2 evidence proves consent existed at capture time. Withdrawal is a later,
 * current-state fact: re-read the persisted consent row before every provider
 * submission and before any transcript is sent to AI drafting.
 */
async function assertRecordingConsentNotWithdrawn(
  input: InitiateCallTranscriptionInput,
  consentId: number | null,
  partyId: number,
): Promise<void> {
  const [consent] = validId(consentId)
    ? await db.select({
      status: growCallRecordingConsents.status,
      withdrawnAt: growCallRecordingConsents.withdrawnAt,
    }).from(growCallRecordingConsents).where(and(
      eq(growCallRecordingConsents.id, consentId),
      eq(growCallRecordingConsents.brokerageId, input.brokerageId),
      eq(growCallRecordingConsents.partyId, partyId),
    )).limit(1)
    : [];
  if (isRecordingConsentWithdrawn(consent)) {
    await reject(input, "CONSENT_WITHDRAWN", "Recording consent has been withdrawn; no new transcription or AI processing is permitted.");
  }
}

async function validateSource(input: InitiateCallTranscriptionInput) {
  let session;
  try {
    session = await getCallSessionForBrokerage(input.brokerageId, input.callSessionId, {
      id: input.actor.userId,
      role: input.actor.role,
    });
  } catch (error) {
    if (error instanceof GrowCallSessionNotFoundError) {
      return reject(input, "CALL_NOT_FOUND", error.message);
    }
    if (error instanceof GrowCallSessionAuthorizationError) {
      return reject(input, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  let recording;
  try {
    // This loader enforces the existing recording entitlement and uses the
    // document-storage logical-owner + integrity verification path.
    recording = await getCallRecordingContent({
      brokerageId: input.brokerageId,
      callSessionId: input.callSessionId,
      actor: {
        userId: input.actor.userId,
        role: input.actor.role,
        brokerageId: input.actor.brokerageId,
      },
    });
  } catch (error) {
    if (error instanceof CallRecordingStorageError && error.code === "RECORDING_ACCESS_DENIED") {
      // Caller-specific (owner/admin or recording entitlement) denial, not a
      // source failure: it must never fail an artifact on the caller's behalf.
      return reject(input, "ACCESS_DENIED", "The transcription actor cannot access this recording.");
    }
    if (error instanceof CallRecordingStorageError) {
      // If storage failed, only inspect the version through the same tenant
      // and logical-owner binding as the recording loader. Never use a bare
      // version-id probe: that would disclose whether another tenant's
      // deleted object exists.
      const [version] = await db.select({
        objectStatus: documentObjectVersions.objectStatus,
        deletedAt: documentObjectVersions.deletedAt,
        destroyedAt: documentObjectVersions.destroyedAt,
      }).from(documentObjectVersions)
        .innerJoin(documents, eq(documentObjectVersions.documentId, documents.id))
        .where(and(
          eq(documentObjectVersions.id, input.recordingReference),
          eq(documentObjectVersions.brokerageId, input.brokerageId),
          eq(documents.brokerageId, input.brokerageId),
          eq(documents.logicalOwnerType, "telephony-call"),
          eq(documents.logicalOwnerId, input.callSessionId),
        )).limit(1);
      return reject(
        input,
        isDeletedRecordingStatus(version?.objectStatus) || version?.deletedAt != null || version?.destroyedAt != null
          ? "RECORDING_DELETED"
          : "RECORDING_UNAVAILABLE",
        isDeletedRecordingStatus(version?.objectStatus) || version?.deletedAt != null || version?.destroyedAt != null
          ? "The recording has been deleted."
          : "The recording is unavailable for transcription.",
      );
    }
    // documentStorage can surface integrity/object-read errors beneath the
    // telephony loader. Do not expose them or proceed without verified bytes.
    return reject(input, "RECORDING_UNAVAILABLE", "The recording is unavailable for transcription.");
  }
  if (!recording || !recording.version || recording.version.id !== input.recordingReference) {
    return reject(input, "RECORDING_REFERENCE_MISMATCH", "The recording reference is not the active recording for this call.");
  }
  if (
    recording.bytes.length === 0 ||
    recording.document.brokerageId !== input.brokerageId ||
    recording.metadata.brokerageId !== input.brokerageId ||
    recording.metadata.callSessionId !== input.callSessionId ||
    recording.metadata.partyId !== session.partyId ||
    recording.version.objectStatus !== "Active"
  ) {
    return reject(
      input,
      isDeletedRecordingStatus(recording.version.objectStatus)
        ? "RECORDING_DELETED"
        : "RECORDING_UNAVAILABLE",
      isDeletedRecordingStatus(recording.version.objectStatus)
        ? "The recording has been deleted."
        : "The recording content or tenant binding is invalid.",
    );
  }
  await assertPersistedF2Evidence(input, {
    metadata: recording.metadata,
    callSession: session,
  });
  await assertRecordingConsentNotWithdrawn(
    input,
    recording.metadata.recordingConsentIdAtCapture,
    recording.metadata.partyId,
  );
  return { session, recording };
}

/**
 * Authorization is intentionally re-resolved for every provider attempt.
 * validateSource's recording entitlement is not a substitute for the
 * transcription entitlement or current actor membership.
 */
async function assertCurrentAttemptAuthorization(
  input: InitiateCallTranscriptionInput,
): Promise<void> {
  const [currentActor] = await db.select({ id: users.id, role: users.role }).from(users).where(and(
    eq(users.id, input.actor.userId),
    eq(users.brokerageId, input.brokerageId),
  )).limit(1);
  if (!currentActor || currentActor.role !== input.actor.role) {
    return reject(input, "ACCESS_DENIED", "The transcription actor is no longer authorized.");
  }
  if (!await hasEntitlement({
    id: input.actor.userId,
    role: currentActor.role,
    brokerageId: input.brokerageId,
  }, "grow.calling.transcription")) {
    return reject(input, "ENTITLEMENT_REQUIRED", "Call transcription entitlement is no longer active.");
  }
}

async function findArtifact(input: InitiateCallTranscriptionInput): Promise<GrowCallTranscription> {
  const [artifact] = await db.select().from(growCallTranscriptions).where(and(
    eq(growCallTranscriptions.callSessionId, input.callSessionId),
    eq(growCallTranscriptions.recordingReference, input.recordingReference),
    eq(growCallTranscriptions.brokerageId, input.brokerageId),
  )).limit(1);
  if (!artifact) throw new CallTranscriptionError("PROVIDER_FAILED", "The transcription artifact could not be loaded.");
  return artifact;
}

/**
 * Re-check and lock the exact tenant-owned recording ledger row immediately
 * before the transcript/draft CAS. A source can be quarantined after the
 * last read but before this transaction begins; locking the joined document
 * and version makes that race deterministic without changing F2 validation.
 */
async function lockActiveRecordingForCommit(
  tx: ConsentTransaction,
  input: InitiateCallTranscriptionInput,
  consent: { consentId: number | null; partyId: number },
): Promise<void> {
  // Lock the capture consent as well, so a withdrawal that commits while AI
  // drafting was in flight can never be overtaken by this transcript commit.
  const [currentConsent] = validId(consent.consentId)
    ? await tx.select({
      status: growCallRecordingConsents.status,
      withdrawnAt: growCallRecordingConsents.withdrawnAt,
    }).from(growCallRecordingConsents).where(and(
      eq(growCallRecordingConsents.id, consent.consentId),
      eq(growCallRecordingConsents.brokerageId, input.brokerageId),
      eq(growCallRecordingConsents.partyId, consent.partyId),
    )).for("update")
    : [];
  if (isRecordingConsentWithdrawn(currentConsent)) {
    throw new CallTranscriptionError(
      "CONSENT_WITHDRAWN",
      "Recording consent has been withdrawn; no new transcription or AI processing is permitted.",
    );
  }

  const [source] = await tx.select({
    document: documents,
    version: documentObjectVersions,
  }).from(documentObjectVersions)
    .innerJoin(documents, eq(documentObjectVersions.documentId, documents.id))
    .where(and(
      eq(documentObjectVersions.id, input.recordingReference),
      eq(documentObjectVersions.brokerageId, input.brokerageId),
      eq(documents.brokerageId, input.brokerageId),
      eq(documents.logicalOwnerType, "telephony-call"),
      eq(documents.logicalOwnerId, input.callSessionId),
      eq(documents.objectStorageKey, documentObjectVersions.storageObjectKey),
    ))
    .for("update");

  if (!source) {
    throw new CallTranscriptionError(
      "RECORDING_UNAVAILABLE",
      "The recording is no longer available for transcription.",
    );
  }
  if (
    source.version.objectStatus !== "Active" ||
    source.version.deletedAt !== null ||
    source.version.destroyedAt !== null
  ) {
    throw new CallTranscriptionError(
      isDeletedRecordingStatus(source.version.objectStatus) ||
        source.version.deletedAt !== null ||
        source.version.destroyedAt !== null
        ? "RECORDING_DELETED"
        : "RECORDING_UNAVAILABLE",
      isDeletedRecordingStatus(source.version.objectStatus) ||
        source.version.deletedAt !== null ||
        source.version.destroyedAt !== null
        ? "The recording has been deleted."
        : "The recording is no longer available for transcription.",
    );
  }
}

export async function initiateCallTranscription(
  input: InitiateCallTranscriptionInput,
): Promise<GrowCallTranscription> {
  if (
    !validId(input?.brokerageId) ||
    !validId(input?.callSessionId) ||
    !validId(input?.recordingReference) ||
    !input.actor ||
    !validId(input.actor.userId) ||
    !input.actor.role?.trim() ||
    input.actor.brokerageId !== input.brokerageId
  ) {
    return reject(
      input,
      input.actor?.brokerageId !== input.brokerageId ? "TENANT_MISMATCH" : "INVALID_INPUT",
      input.actor?.brokerageId !== input.brokerageId
        ? "The actor and request tenant do not match."
        : "A valid tenant, actor, call session, and recording reference are required.",
    );
  }
  const [actor] = await db.select({ id: users.id, role: users.role }).from(users).where(and(
    eq(users.id, input.actor.userId),
    eq(users.brokerageId, input.brokerageId),
  )).limit(1);
  if (!actor || actor.role !== input.actor.role) {
    return reject(input, "ACCESS_DENIED", "The transcription actor is not in this brokerage.");
  }
  if (!await hasEntitlement({ id: input.actor.userId, role: input.actor.role, brokerageId: input.brokerageId }, "grow.calling.transcription")) {
    return reject(input, "ENTITLEMENT_REQUIRED", "Call transcription requires the grow.calling.transcription entitlement.");
  }
  // Ownership is resolved before any existing artifact is read, returned, or
  // transitioned. A same-brokerage non-owner must never receive transcript or
  // draft data and must never be able to fail the owner's in-flight row.
  try {
    await getCallSessionForBrokerage(input.brokerageId, input.callSessionId, {
      id: input.actor.userId,
      role: input.actor.role,
    });
  } catch (error) {
    if (error instanceof GrowCallSessionNotFoundError) {
      return reject(input, "CALL_NOT_FOUND", error.message);
    }
    if (error instanceof GrowCallSessionAuthorizationError) {
      return reject(input, "ACCESS_DENIED", error.message);
    }
    throw error;
  }

  const existingForKey = await db.select({
    row: growCallTranscriptions,
    updatedAtToken: transcriptionUpdatedAtToken,
  }).from(growCallTranscriptions).where(and(
    eq(growCallTranscriptions.brokerageId, input.brokerageId),
    eq(growCallTranscriptions.callSessionId, input.callSessionId),
    eq(growCallTranscriptions.recordingReference, input.recordingReference),
  )).limit(1);
  let existingSnapshot = existingForKey[0];
  let existing = existingSnapshot?.row;

  /**
   * A source failure discovered after a row exists is a state transition, not
   * a request rejection.  The CAS includes every claim-fence field so an old
   * attempt cannot overwrite a reconciler claim.
   */
  const failOwned = async (
    snapshot: TranscriptionSnapshot,
    reason: CallTranscriptionFailureReason,
  ): Promise<GrowCallTranscription> => {
    const row = snapshot.row;
    const failed = await db.transaction(async (tx) => {
      const [updated] = await tx.update(growCallTranscriptions).set({
        processingState: "FAILED",
        failureReason: reason,
        lastError: reason,
        updatedAt: new Date(),
      }).where(and(
        eq(growCallTranscriptions.brokerageId, input.brokerageId),
        eq(growCallTranscriptions.id, row.id),
        eq(growCallTranscriptions.processingState, row.processingState),
        sameNullable(growCallTranscriptions.retryCount, row.retryCount),
        sameUpdatedAtToken(snapshot.updatedAtToken),
      )).returning();
      if (updated) {
        await strictAuditInTransaction(tx, {
          ...input,
          userId: input.actor.userId,
          transcriptionId: updated.id,
          action: "grow_call_transcription_provider_failed",
          reason,
        });
      }
      return updated;
    });
    return failed ?? findArtifact(input);
  };

  // A replay of a terminal artifact never revalidates or submits again.
  if (existing && existing.processingState !== "PENDING" && existing.processingState !== "TRANSCRIBING") {
    return existing;
  }

  // Existing in-flight work is owned by its current claimant.  We still
  // inspect the source so deletion/quarantine can promptly fail an owned row.
  if (existing?.processingState === "TRANSCRIBING") {
    try {
      await validateSource(input);
    } catch (error) {
      // Caller-specific denials are request rejections, never transitions.
      if (isActorSpecificDenial(error)) throw error;
      return failOwned(existingSnapshot!, durableFailureReason(error));
    }
    return existing;
  }

  // All provenance checks occur before the atomic row insert.  For an
  // existing PENDING row, a failed source check must fail that row rather than
  // leaving an orphaned pending artifact.
  let source;
  try {
    source = await validateSource(input);
  } catch (error) {
    if (existingSnapshot && !isActorSpecificDenial(error)) {
      return failOwned(existingSnapshot, durableFailureReason(error));
    }
    throw error;
  }
  const insertion = await db.transaction(async (tx) => {
    const [created] = await tx.insert(growCallTranscriptions).values({
      brokerageId: input.brokerageId,
      callSessionId: input.callSessionId,
      partyId: source.session.partyId,
      recordingReference: input.recordingReference,
      processingState: "PENDING",
    }).onConflictDoNothing({
      target: [growCallTranscriptions.callSessionId, growCallTranscriptions.recordingReference],
    }).returning();
    if (created) {
      const [createdToken] = await tx.select({
        updatedAtToken: transcriptionUpdatedAtToken,
      }).from(growCallTranscriptions).where(eq(growCallTranscriptions.id, created.id));
      await strictAuditInTransaction(tx, {
        ...input,
        userId: input.actor.userId,
        transcriptionId: created.id,
        action: "grow_call_transcription_created",
        reason: "PENDING",
      });
      return {
        snapshot: { row: created, updatedAtToken: createdToken!.updatedAtToken },
        created: true,
      };
    }
    const [existing] = await tx.select({
      row: growCallTranscriptions,
      updatedAtToken: transcriptionUpdatedAtToken,
    }).from(growCallTranscriptions).where(and(
      eq(growCallTranscriptions.brokerageId, input.brokerageId),
      eq(growCallTranscriptions.callSessionId, input.callSessionId),
      eq(growCallTranscriptions.recordingReference, input.recordingReference),
    )).limit(1);
    if (!existing) throw new CallTranscriptionError("CALL_NOT_FOUND", new GrowCallSessionNotFoundError().message);
    return { snapshot: existing, created: false };
  });
  const artifactSnapshot = insertion.snapshot;
  const artifact = artifactSnapshot.row;
  if (artifact.processingState !== "PENDING") return artifact;

  const claimed = await db.transaction(async (tx) => {
    const [updated] = await tx.update(growCallTranscriptions).set({
      processingState: "TRANSCRIBING",
      updatedAt: new Date(),
    }).where(and(
      eq(growCallTranscriptions.id, artifact.id),
      eq(growCallTranscriptions.brokerageId, input.brokerageId),
      eq(growCallTranscriptions.processingState, "PENDING"),
      sameNullable(growCallTranscriptions.retryCount, artifact.retryCount),
      sameUpdatedAtToken(artifactSnapshot.updatedAtToken),
    )).returning();
    if (updated) {
      await strictAuditInTransaction(tx, {
        ...input, userId: input.actor.userId, transcriptionId: updated.id,
        action: "grow_call_transcription_processing", reason: "TRANSCRIBING",
      });
    }
    if (!updated) return null;
    const [updatedToken] = await tx.select({
      updatedAtToken: transcriptionUpdatedAtToken,
    }).from(growCallTranscriptions).where(eq(growCallTranscriptions.id, updated.id));
    return { row: updated, updatedAtToken: updatedToken!.updatedAtToken };
  });
  if (!claimed) return findArtifact(input);

  let claim = claimed;
  const config = loadVoiceTranscriptionConfig();
  const timeoutMs = boundedCallTranscriptionTimeout(config.timeoutMs);
  const correlationId = randomUUID();
  let provider: TranscriptionProvider | null = null;

  for (;;) {
    let result;
    let reason: CallTranscriptionFailureReason | null = null;
    try {
      // Re-load content/owner/evidence before every attempt.  This is also
      // what prevents retries after a source is deleted or quarantined.
      const revalidated = await validateSource(input);
      await assertCurrentAttemptAuthorization(input);
      provider ??= testProviderOverride ?? buildCallTranscriptionProvider({
        ...config,
        timeoutMs,
      });
      const activeProvider = provider;
      let mimeType = revalidated.recording.contentType;
      if (activeProvider.name !== "mock") {
        if (process.env.LIVE_CALL_TRANSCRIPTION_APPROVED !== "true") {
          throw new TranscriptionProviderError(
            provider.name,
            "live_provider_disabled",
            "Live call transcription is not approved.",
          );
        }
        mimeType = validateVoiceAudioUpload(
          revalidated.recording.bytes,
          revalidated.recording.contentType,
        ).detectedMimeType;
      }
      const request = activeProvider.transcribe({
        audioBytes: revalidated.recording.bytes,
        mimeType,
        timeoutMs,
        correlationId,
      });
      const timeout = new Promise<never>((_, rejectPromise) => {
        setTimeout(() => rejectPromise(
          new TranscriptionProviderError(activeProvider.name, "timeout", "Transcription timed out."),
        ), timeoutMs);
      });
      result = await Promise.race([request, timeout]);
      if (
        !result ||
        result.provider !== activeProvider.name ||
        typeof result.transcript !== "string" ||
        (result.durationSeconds !== null &&
          (typeof result.durationSeconds !== "number" || !Number.isFinite(result.durationSeconds) || result.durationSeconds < 0)) ||
        typeof result.latencyMs !== "number" ||
        !Number.isFinite(result.latencyMs) ||
        result.latencyMs < 0
      ) {
        throw new TranscriptionProviderError(provider.name, "malformed_response", "Provider response shape is invalid.");
      }
      assertTranscriptSizeIsSane(result.transcript, activeProvider.name);
      const transcript = result.transcript.trim();
      if (!transcript) {
        throw new TranscriptionProviderError(activeProvider.name, "empty_transcript", "Provider returned an empty transcript.");
      }
      // Never let a result cross a changed provenance boundary. This also
      // re-reads current consent: a withdrawal during transcription stops the
      // transcript from ever reaching the AI drafting gateway.
      await validateSource(input);
      // The transcript provider and draft generator are separate trust
      // boundaries. Re-resolve actor membership and transcription entitlement
      // immediately before sending transcript data to AI.
      await assertCurrentAttemptAuthorization(input);
      let drafts: Awaited<ReturnType<typeof generateCallTranscriptionDrafts>> = {
        draftSummary: null,
        draftKeyPoints: null,
        draftCommitments: null,
        draftFollowups: null,
      };
      if (isGrowCallSummaryEnabled()) {
        try {
          drafts = await generateCallTranscriptionDrafts({
            transcriptionId: claim.row.id,
            brokerageId: input.brokerageId,
            transcript,
          });
        } catch (error) {
          // The draft helper is deliberately total. Keep this boundary
          // defensive as well so an unexpected helper regression can never
          // consume transcription retry budget or prevent the transcript
          // from reaching human review.
          try {
            const { logger } = await import("@aee/events");
            logger.warn("call_transcription_draft_generation_failed", {
              brokerageId: input.brokerageId,
              transcriptionId: claim.row.id,
              error: error instanceof Error ? error.message : "unknown error",
            });
          } catch {
            // Logging is best effort; draft generation remains non-fatal.
          }
        }
      }
      // AI may wait while the source or caller authorization changes. Only
      // commit transcript and drafts after both are revalidated again.
      const committedSource = await validateSource(input);
      await assertCurrentAttemptAuthorization(input);
      const completed = await db.transaction(async (tx) => {
        await lockActiveRecordingForCommit(tx, input, {
          consentId: committedSource.recording.metadata.recordingConsentIdAtCapture,
          partyId: committedSource.recording.metadata.partyId,
        });
        const [updated] = await tx.update(growCallTranscriptions).set({
          processingState: "AWAITING_AGENT_REVIEW",
          transcript,
          draftSummary: drafts.draftSummary,
          draftKeyPoints: drafts.draftKeyPoints,
          draftCommitments: drafts.draftCommitments,
          draftFollowups: drafts.draftFollowups,
          transcriptionProviderReference: result!.provider,
          failureReason: null,
          lastError: null,
          updatedAt: new Date(),
        }).where(and(
          eq(growCallTranscriptions.brokerageId, input.brokerageId),
          eq(growCallTranscriptions.id, claim.row.id),
          eq(growCallTranscriptions.processingState, "TRANSCRIBING"),
          sameNullable(growCallTranscriptions.retryCount, claim.row.retryCount),
          sameUpdatedAtToken(claim.updatedAtToken),
        )).returning();
        if (updated) {
          await strictAuditInTransaction(tx, {
            ...input,
            userId: input.actor.userId,
            transcriptionId: updated.id,
            action: "grow_call_transcription_completed",
            reason: "AWAITING_AGENT_REVIEW",
          });
        }
        return updated;
      });
      return completed ?? findArtifact(input);
    } catch (error) {
      reason = durableFailureReason(error);
    }

    // Source/evidence/permission/deletion failures are permanent for this
    // artifact. They must not consume provider retry budget.
    if (!isRetryableCallTranscriptionFailure(reason)) {
      return failOwned(claim, reason);
    }

    const retryCount = claim.row.retryCount ?? 0;
    // If the strict terminal-failure audit is unavailable, do not turn an
    // ambiguous state transition into repeated provider submissions. The
    // test-only seam mirrors the production fail-closed audit outcome.
    if (shouldFailCallTranscriptionAuditForTests("grow_call_transcription_provider_failed")) {
      return failOwned(claim, reason);
    }
    if (retryCount >= CALL_TRANSCRIPTION_MAX_RETRIES) {
      return failOwned(claim, reason);
    }

    const rescheduled = await db.transaction(async (tx) => {
      const [updated] = await tx.update(growCallTranscriptions).set({
        // TRANSCRIBING is retained as the active claim during the bounded
        // backoff; a duplicate caller therefore cannot submit another call.
        processingState: "TRANSCRIBING",
        retryCount: retryCount + 1,
        failureReason: reason,
        lastError: reason,
        updatedAt: new Date(),
      }).where(and(
        eq(growCallTranscriptions.brokerageId, input.brokerageId),
        eq(growCallTranscriptions.id, claim.row.id),
        eq(growCallTranscriptions.processingState, "TRANSCRIBING"),
        sameNullable(growCallTranscriptions.retryCount, claim.row.retryCount),
        sameUpdatedAtToken(claim.updatedAtToken),
      )).returning();
      if (updated) {
        await strictAuditInTransaction(tx, {
          ...input,
          userId: input.actor.userId,
          transcriptionId: updated.id,
          action: "grow_call_transcription_retry_scheduled",
          reason,
        });
      }
      if (!updated) return null;
      const [updatedToken] = await tx.select({
        updatedAtToken: transcriptionUpdatedAtToken,
      }).from(growCallTranscriptions).where(eq(growCallTranscriptions.id, updated.id));
      return { row: updated, updatedAtToken: updatedToken!.updatedAtToken };
    });
    if (!rescheduled) return findArtifact(input);
    claim = rescheduled;
    const delay = callTranscriptionRetryDelayMs(claim.row.retryCount ?? 0);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
