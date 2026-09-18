import { and, eq } from "drizzle-orm";
import {
  db,
  documentObjectVersions,
  documents,
  growCallSessions,
  growCallTranscriptions,
  parties,
  users,
  type CallTranscriptionDraftItem,
  type CallTranscriptionItemReview,
  type GrowCallTranscription,
} from "@aee/db";
import { hasEntitlement } from "../entitlements/resolver.js";
import {
  assertCallSessionActorAuthorized,
  getCallSessionForBrokerage,
  GrowCallSessionAuthorizationError,
  GrowCallSessionNotFoundError,
} from "./callSessions.js";
import type { ConsentTransaction } from "../consentControlsPersistence.js";

const MAX_REVIEW_ITEMS = 500;
const MAX_ITEM_ID_LENGTH = 256;
const MAX_REVIEW_TEXT_LENGTH = 100_000;
const MAX_REJECTION_REASON_LENGTH = 2_000;

export type TranscriptionReviewItemInput = {
  itemType: "TRANSCRIPT" | "SUMMARY" | "KEY_POINT" | "COMMITMENT" | "FOLLOWUP";
  itemId: string;
  decision: "APPROVED" | "REJECTED";
  editedText?: string | null;
  rejectionReason?: string | null;
};

export class CallTranscriptionReviewError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "ACCESS_DENIED"
      | "ENTITLEMENT_REQUIRED"
      | "STALE"
      | "TERMINAL"
      | "CONCURRENT",
    message: string,
  ) {
    super(message);
    this.name = "CallTranscriptionReviewError";
  }
}

type ReviewActor = { userId: number; role: string; brokerageId: number };

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isReviewItemType(value: unknown): value is TranscriptionReviewItemInput["itemType"] {
  return value === "TRANSCRIPT" || value === "SUMMARY" || value === "KEY_POINT" ||
    value === "COMMITMENT" || value === "FOLLOWUP";
}

function parseReviewBody(value: unknown): TranscriptionReviewItemInput[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Request body must be an object.");
  }
  let encodedSize: number;
  try {
    encodedSize = JSON.stringify(value).length;
  } catch {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Request body is not serializable.");
  }
  if (encodedSize > 1_000_000) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Request body is too large.");
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "reviewState" || !Array.isArray(body.reviewState)) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Request body must contain only reviewState.");
  }
  if (body.reviewState.length > MAX_REVIEW_ITEMS) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Too many review items.");
  }
  return body.reviewState.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new CallTranscriptionReviewError("INVALID_INPUT", `Invalid review item at index ${index}.`);
    }
    const item = raw as Record<string, unknown>;
    const allowed = new Set(["itemType", "itemId", "decision", "editedText", "rejectionReason"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      throw new CallTranscriptionReviewError("INVALID_INPUT", "Reviewer and review timestamp are server fields.");
    }
    if (!isReviewItemType(item.itemType) || typeof item.itemId !== "string" ||
        item.itemId.length < 1 || item.itemId.length > MAX_ITEM_ID_LENGTH ||
        (item.decision !== "APPROVED" && item.decision !== "REJECTED")) {
      throw new CallTranscriptionReviewError("INVALID_INPUT", `Invalid review item at index ${index}.`);
    }
    for (const key of ["editedText", "rejectionReason"] as const) {
      if (item[key] !== undefined && item[key] !== null &&
          (typeof item[key] !== "string" ||
            item[key].length > (key === "editedText" ? MAX_REVIEW_TEXT_LENGTH : MAX_REJECTION_REASON_LENGTH))) {
        throw new CallTranscriptionReviewError("INVALID_INPUT", `Invalid ${key} at index ${index}.`);
      }
    }
    return {
      itemType: item.itemType,
      itemId: item.itemId,
      decision: item.decision,
      editedText: item.editedText as string | null | undefined,
      rejectionReason: item.rejectionReason as string | null | undefined,
    };
  });
}

function draftItems(row: GrowCallTranscription, type: TranscriptionReviewItemInput["itemType"]): CallTranscriptionDraftItem[] {
  if (type === "KEY_POINT") return row.draftKeyPoints ?? [];
  if (type === "COMMITMENT") return row.draftCommitments ?? [];
  if (type === "FOLLOWUP") return row.draftFollowups ?? [];
  return [];
}

function validateReviewState(row: GrowCallTranscription, items: TranscriptionReviewItemInput[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.itemType}:${item.itemId}`;
    if (seen.has(key)) throw new CallTranscriptionReviewError("INVALID_INPUT", "Duplicate review item.");
    seen.add(key);
  }

  const transcript = items.filter((item) => item.itemType === "TRANSCRIPT");
  if (transcript.length !== 1 || transcript[0].itemId !== "transcript" ||
      transcript[0].decision !== "APPROVED" || !nonEmpty(transcript[0].editedText)) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "The transcript must be explicitly approved exactly once.");
  }

  const summary = items.filter((item) => item.itemType === "SUMMARY");
  if (summary.length > 1 || (summary.length === 1 && summary[0].itemId !== "summary")) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Invalid summary review item.");
  }
  if (row.draftSummary !== null && row.draftSummary !== undefined && summary.length !== 1) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "The draft summary requires a decision.");
  }
  if (row.draftSummary === null && summary.length === 1 && !nonEmpty(summary[0].editedText)) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "A manual summary must contain text.");
  }

  for (const type of ["KEY_POINT", "COMMITMENT", "FOLLOWUP"] as const) {
    const drafts = draftItems(row, type);
    const draftIds = new Set(drafts.map((draft) => draft.id));
    const reviews = items.filter((item) => item.itemType === type);
    for (const review of reviews) {
      if (review.itemId.startsWith("manual-") && review.itemId.length > "manual-".length) {
        if (!nonEmpty(review.editedText)) {
          throw new CallTranscriptionReviewError("INVALID_INPUT", "Manual review items must contain text.");
        }
      } else if (!draftIds.has(review.itemId)) {
        throw new CallTranscriptionReviewError("INVALID_INPUT", "Review item does not match a draft item.");
      }
    }
    for (const draft of drafts) {
      if (!reviews.some((review) => review.itemId === draft.id)) {
        throw new CallTranscriptionReviewError("INVALID_INPUT", "Every draft item requires a decision.");
      }
    }
  }
}

async function assertReviewActor(actor: ReviewActor, expectedBrokerageId: number): Promise<void> {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0 ||
      !Number.isSafeInteger(actor.brokerageId) || actor.brokerageId <= 0 ||
      !actor.role.trim() || actor.brokerageId !== expectedBrokerageId) {
    throw new CallTranscriptionReviewError("ACCESS_DENIED", "The review actor is not authorized.");
  }
  const [user] = await db.select({ id: users.id, role: users.role, brokerageId: users.brokerageId })
    .from(users).where(eq(users.id, actor.userId)).limit(1);
  if (!user || user.brokerageId !== actor.brokerageId || user.role !== actor.role) {
    throw new CallTranscriptionReviewError("ACCESS_DENIED", "The review actor is not authorized.");
  }
  if (!await hasEntitlement({ id: user.id, role: user.role, brokerageId: user.brokerageId }, "grow.calling.transcription")) {
    throw new CallTranscriptionReviewError("ENTITLEMENT_REQUIRED", "Call transcription requires the grow.calling.transcription entitlement.");
  }
}

async function loadReviewRow(
  brokerageId: number,
  callSessionId: number,
  transcriptionId: number,
  actor: ReviewActor,
  readOnly = false,
): Promise<GrowCallTranscription> {
  let session;
  try {
    session = await getCallSessionForBrokerage(brokerageId, callSessionId, { id: actor.userId, role: actor.role });
  } catch (error) {
    if (error instanceof GrowCallSessionNotFoundError) {
      throw new CallTranscriptionReviewError("NOT_FOUND", error.message);
    }
    if (error instanceof GrowCallSessionAuthorizationError) {
      throw new CallTranscriptionReviewError("ACCESS_DENIED", error.message);
    }
    throw error;
  }
  const [row] = await db.select().from(growCallTranscriptions).where(and(
    eq(growCallTranscriptions.id, transcriptionId),
    eq(growCallTranscriptions.callSessionId, callSessionId),
    eq(growCallTranscriptions.brokerageId, brokerageId),
  )).limit(1);
  if (!row) throw new CallTranscriptionReviewError("NOT_FOUND", "Transcription not found.");
  if (session.partyId !== row.partyId) {
    throw new CallTranscriptionReviewError("NOT_FOUND", "Transcription source does not belong to this call.");
  }
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(
    eq(parties.id, row.partyId),
    eq(parties.brokerageId, brokerageId),
  )).limit(1);
  if (!party) throw new CallTranscriptionReviewError("NOT_FOUND", "Transcription contact is not in this brokerage.");
  const unavailable = await sourceLedgerStatus(db, row);
  if (unavailable) {
    if (readOnly) return unavailableReadProjection(row, unavailable);
    throw new CallTranscriptionReviewError("STALE", "The transcription recording source is no longer available.");
  }
  return row;
}

function assertMutable(row: GrowCallTranscription): void {
  if (row.processingState === "APPROVED" || row.processingState === "PARTIALLY_APPROVED" ||
      row.processingState === "DISCARDED" || row.processingState === "DELETED" ||
      row.processingState === "DELETION_SCHEDULED") {
    throw new CallTranscriptionReviewError("TERMINAL", "This transcription is already terminal.");
  }
  if (row.processingState !== "AWAITING_AGENT_REVIEW") {
    throw new CallTranscriptionReviewError("STALE", "This transcription is not ready for review.");
  }
}

/**
 * Review never reads recording bytes. It still fail-closes if the immutable
 * source ledger is no longer tenant-owned and active.
 */
type SourceUnavailableReason = "RECORDING_DELETED" | "RECORDING_UNAVAILABLE";

async function sourceLedgerStatus(
  executor: typeof db | ConsentTransaction,
  row: Pick<GrowCallTranscription, "brokerageId" | "callSessionId" | "recordingReference">,
  lock = false,
): Promise<SourceUnavailableReason | null> {
  const query = executor.select({
    objectStatus: documentObjectVersions.objectStatus,
    deletedAt: documentObjectVersions.deletedAt,
    destroyedAt: documentObjectVersions.destroyedAt,
  }).from(documentObjectVersions)
    .innerJoin(documents, eq(documentObjectVersions.documentId, documents.id))
    .where(and(
      eq(documentObjectVersions.id, row.recordingReference),
      eq(documentObjectVersions.brokerageId, row.brokerageId),
      eq(documents.brokerageId, row.brokerageId),
      eq(documents.logicalOwnerType, "telephony-call"),
      eq(documents.logicalOwnerId, row.callSessionId),
      eq(documents.objectStorageKey, documentObjectVersions.storageObjectKey),
    )).limit(1);
  const result = lock ? await query.for("update") : await query;
  const [source] = result;
  if (!source) return "RECORDING_UNAVAILABLE";
  if (source.objectStatus === "SoftDeleted" || source.objectStatus === "Destroyed" ||
      source.objectStatus === "Deleted" || source.deletedAt !== null || source.destroyedAt !== null) {
    return "RECORDING_DELETED";
  }
  if (source.objectStatus !== "Active") return "RECORDING_UNAVAILABLE";
  return null;
}

async function assertSourceLedger(
  executor: typeof db | ConsentTransaction,
  row: Pick<GrowCallTranscription, "brokerageId" | "callSessionId" | "recordingReference">,
  lock = false,
): Promise<void> {
  if (await sourceLedgerStatus(executor, row, lock)) {
    throw new CallTranscriptionReviewError("STALE", "The transcription recording source is no longer available.");
  }
}

function unavailableReadProjection(
  row: GrowCallTranscription,
  reason: SourceUnavailableReason,
): GrowCallTranscription {
  return {
    ...row,
    processingState: "FAILED",
    transcriptionProviderReference: null,
    transcript: null,
    draftSummary: null,
    draftKeyPoints: null,
    draftCommitments: null,
    draftFollowups: null,
    reviewState: [],
    // Current source availability takes precedence over an earlier processing
    // error in this read-only projection; the persisted failure is unchanged.
    failureReason: reason,
    lastError: reason,
    approvedBy: null,
    approvedAt: null,
  };
}

export async function saveCallTranscriptionReview(input: {
  brokerageId: number;
  callSessionId: number;
  transcriptionId: number;
  actor: ReviewActor;
  body: unknown;
}, onReviewSaved?: (
  tx: ConsentTransaction,
  transcription: GrowCallTranscription,
) => Promise<void>): Promise<GrowCallTranscription> {
  await assertReviewActor(input.actor, input.brokerageId);
  const items = parseReviewBody(input.body);
  await loadReviewRow(input.brokerageId, input.callSessionId, input.transcriptionId, input.actor);
  // The row is re-validated after the lock below. This first read only
  // resolves access/source status before entering the commit transaction.

  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(growCallTranscriptions).where(and(
      eq(growCallTranscriptions.id, input.transcriptionId),
      eq(growCallTranscriptions.callSessionId, input.callSessionId),
      eq(growCallTranscriptions.brokerageId, input.brokerageId),
    )).for("update");
    if (!locked) throw new CallTranscriptionReviewError("NOT_FOUND", "Transcription not found.");
    await assertSourceLedger(tx, locked, true);
    assertMutable(locked);
    validateReviewState(locked, items);
    const reviewedAt = new Date().toISOString();
    const reviewState: CallTranscriptionItemReview[] = items.map((item) => ({
      ...item,
      reviewedByUserId: input.actor.userId,
      reviewedAt,
      editedText: item.editedText ?? null,
      rejectionReason: item.rejectionReason ?? null,
    }));
    const processingState = reviewState.some((item) => item.decision === "REJECTED")
      ? "PARTIALLY_APPROVED" as const : "APPROVED" as const;
    const [updated] = await tx.update(growCallTranscriptions).set({
      reviewState,
      processingState,
      approvedBy: input.actor.userId,
      approvedAt: new Date(reviewedAt),
    }).where(and(
      eq(growCallTranscriptions.id, locked.id),
      eq(growCallTranscriptions.processingState, "AWAITING_AGENT_REVIEW"),
    )).returning();
    if (!updated) throw new CallTranscriptionReviewError("CONCURRENT", "Review changed concurrently; retry.");
    // Explicit Save only: persist its passive Timeline snapshot before commit.
    // The row lock and terminal-state guard reject both retries and concurrent
    // duplicates. A failed snapshot write rolls the approval back as well.
    await onReviewSaved?.(tx, updated);
    return updated;
  });
}

export async function discardCallTranscription(input: {
  brokerageId: number;
  callSessionId: number;
  transcriptionId: number;
  actor: ReviewActor;
  body: unknown;
}): Promise<GrowCallTranscription> {
  await assertReviewActor(input.actor, input.brokerageId);
  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body) ||
      Object.keys(input.body as object).length !== 0) {
    throw new CallTranscriptionReviewError("INVALID_INPUT", "Discard accepts an empty object only.");
  }
  await loadReviewRow(input.brokerageId, input.callSessionId, input.transcriptionId, input.actor);
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(growCallTranscriptions).where(and(
      eq(growCallTranscriptions.id, input.transcriptionId),
      eq(growCallTranscriptions.callSessionId, input.callSessionId),
      eq(growCallTranscriptions.brokerageId, input.brokerageId),
    )).for("update");
    if (!locked) throw new CallTranscriptionReviewError("NOT_FOUND", "Transcription not found.");
    await assertSourceLedger(tx, locked, true);
    assertMutable(locked);
    const [updated] = await tx.update(growCallTranscriptions).set({ processingState: "DISCARDED" })
      .where(and(
        eq(growCallTranscriptions.id, locked.id),
        eq(growCallTranscriptions.processingState, "AWAITING_AGENT_REVIEW"),
      )).returning();
    if (!updated) throw new CallTranscriptionReviewError("CONCURRENT", "Review changed concurrently; retry.");
    return updated;
  });
}

export async function getCallTranscriptionForReview(input: {
  brokerageId: number;
  callSessionId: number;
  transcriptionId: number;
  actor: ReviewActor;
}): Promise<GrowCallTranscription | null> {
  await assertReviewActor(input.actor, input.brokerageId);
  return loadReviewRow(input.brokerageId, input.callSessionId, input.transcriptionId, input.actor, true);
}

export async function listCallTranscriptionsForContact(input: {
  brokerageId: number;
  partyId: number;
  actor: ReviewActor;
}): Promise<GrowCallTranscription[]> {
  await assertReviewActor(input.actor, input.brokerageId);
  const rows = await db.select({ transcription: growCallTranscriptions, session: growCallSessions })
    .from(growCallTranscriptions)
    .innerJoin(growCallSessions, eq(growCallSessions.id, growCallTranscriptions.callSessionId))
    .innerJoin(parties, eq(parties.id, growCallTranscriptions.partyId))
    .where(and(
      eq(growCallTranscriptions.brokerageId, input.brokerageId),
      eq(growCallTranscriptions.partyId, input.partyId),
      eq(growCallSessions.brokerageId, input.brokerageId),
      eq(parties.brokerageId, input.brokerageId),
    ));
  const visible: GrowCallTranscription[] = [];
  for (const candidate of rows) {
    try {
      assertCallSessionActorAuthorized(candidate.session, input.actor.userId, input.actor.role);
      if (candidate.session.partyId !== candidate.transcription.partyId) continue;
      const unavailable = await sourceLedgerStatus(db, candidate.transcription);
      visible.push(unavailable
        ? unavailableReadProjection(candidate.transcription, unavailable)
        : candidate.transcription);
    } catch (error) {
      if (error instanceof GrowCallSessionAuthorizationError) continue;
      throw error;
    }
  }
  return visible;
}
