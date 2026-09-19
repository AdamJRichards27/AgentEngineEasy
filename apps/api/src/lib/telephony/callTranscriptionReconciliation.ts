import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  documentObjectVersions,
  documents,
  growCallSessions,
  growCallTranscriptions,
  parties,
} from "@aee/db";
import { writeAuditInTransaction } from "../consentControlsPersistence.js";
import { shouldFailCallTranscriptionAuditForTests } from "./callTranscriptions.js";
import {
  CALL_TRANSCRIPTION_STALE_AFTER_MS,
} from "./callTranscriptionPolicy.js";

const MAX_BATCH_SIZE = 500;
const MIN_STALE_AFTER_MS = 120_000;
const MAX_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const RECORDING_LOGICAL_OWNER_TYPE = "telephony-call";
let beforeTransitionForTests: ((row: ReconciliationRow) => Promise<void>) | null = null;

/** Test-only race seam; production reconciliation has no callback path. */
export function setCallTranscriptionReconciliationBeforeTransitionForTests(
  callback: ((row: ReconciliationRow) => Promise<void>) | null,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Call transcription reconciliation test seam is test-only.");
  }
  beforeTransitionForTests = callback;
}

type ReconciliationRow = {
  transcription: typeof growCallTranscriptions.$inferSelect;
  updatedAtToken: string;
  session: typeof growCallSessions.$inferSelect | null;
  party: typeof parties.$inferSelect | null;
  version: typeof documentObjectVersions.$inferSelect | null;
  document: typeof documents.$inferSelect | null;
};

export interface CallTranscriptionTenantMismatchInput {
  transcription: Pick<typeof growCallTranscriptions.$inferSelect, "brokerageId" | "callSessionId" | "partyId">;
  session: Pick<typeof growCallSessions.$inferSelect, "id" | "brokerageId" | "partyId"> | null;
  party: Pick<typeof parties.$inferSelect, "brokerageId"> | null;
  version: Pick<typeof documentObjectVersions.$inferSelect, "brokerageId" | "documentId" | "metadata"> | null;
  document: Pick<typeof documents.$inferSelect, "id" | "brokerageId" | "propertyId" | "logicalOwnerType" | "logicalOwnerId"> | null;
}

export interface CallTranscriptionReconciliationResult {
  scanned: number;
  failedAbandoned: number;
  failedUnavailable: number;
  failedDeleted: number;
  failedTenantMismatch: number;
  skippedConcurrentTransition: number;
  deferredTransitionError: number;
  nextCursor: number | null;
}

export interface CallTranscriptionReconciliationOptions {
  afterId?: number;
  now?: Date;
  batchSize?: number;
  staleAfterMs?: number;
}

export function configuredCallTranscriptionReconciliation(
  env: NodeJS.ProcessEnv = process.env,
): { staleAfterMs: number; batchSize: number; intervalMs: number } {
  const integer = (name: string, value: string | undefined, fallback: number, min: number, max: number) => {
    if (value === undefined || value === "") return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsed;
  };
  return {
    staleAfterMs: integer(
      "CALL_TRANSCRIPTION_STALE_AFTER_MS",
      env.CALL_TRANSCRIPTION_STALE_AFTER_MS,
      CALL_TRANSCRIPTION_STALE_AFTER_MS,
      MIN_STALE_AFTER_MS,
      MAX_STALE_AFTER_MS,
    ),
    batchSize: integer(
      "CALL_TRANSCRIPTION_RECONCILE_BATCH_SIZE",
      env.CALL_TRANSCRIPTION_RECONCILE_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      1,
      MAX_BATCH_SIZE,
    ),
    intervalMs: integer(
      "CALL_TRANSCRIPTION_RECONCILE_INTERVAL_MS",
      env.CALL_TRANSCRIPTION_RECONCILE_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      30_000,
      24 * 60 * 60 * 1_000,
    ),
  };
}

function validDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function validateOptions(
  options: CallTranscriptionReconciliationOptions,
  configured: ReturnType<typeof configuredCallTranscriptionReconciliation>,
): Required<Pick<CallTranscriptionReconciliationOptions, "afterId" | "now" | "batchSize" | "staleAfterMs">> {
  const afterId = options.afterId ?? 0;
  const batchSize = options.batchSize ?? configured.batchSize;
  const staleAfterMs = options.staleAfterMs ?? configured.staleAfterMs;
  const now = options.now ?? new Date();
  if (
    !Number.isSafeInteger(afterId) ||
    afterId < 0 ||
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_BATCH_SIZE ||
    !Number.isInteger(staleAfterMs) ||
    staleAfterMs < MIN_STALE_AFTER_MS ||
    staleAfterMs > MAX_STALE_AFTER_MS ||
    !validDate(now)
  ) {
    throw new Error("Invalid call transcription reconciliation options");
  }
  return { afterId, now, batchSize, staleAfterMs };
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type FailureReason =
  | "PROCESSING_ABANDONED"
  | "RECORDING_UNAVAILABLE"
  | "RECORDING_DELETED"
  | "TENANT_MISMATCH";

export function isCallTranscriptionTenantMismatch(
  row: CallTranscriptionTenantMismatchInput,
): boolean {
  const { transcription, session, party, version, document } = row;
  // Do not require a complete join before proving a foreign linkage. A
  // partially missing source row must not turn a present foreign row into an
  // apparently ordinary unavailable recording.
  if (session && (
    session.brokerageId !== transcription.brokerageId ||
    session.partyId !== transcription.partyId
  )) return true;
  if (party && party.brokerageId !== transcription.brokerageId) return true;
  if (version && version.brokerageId !== transcription.brokerageId) return true;
  if (document && (
    document.brokerageId !== transcription.brokerageId ||
    document.propertyId !== null ||
    document.logicalOwnerType !== RECORDING_LOGICAL_OWNER_TYPE ||
    document.logicalOwnerId !== transcription.callSessionId
  )) return true;
  if (version && document && version.documentId !== document.id) return true;
  const versionMetadata = metadataRecord(version?.metadata);
  const recordingMetadata = metadataRecord(versionMetadata?.callRecording);
  if (!recordingMetadata) return false;
  return (
    recordingMetadata.brokerageId !== transcription.brokerageId ||
    recordingMetadata.callSessionId !== transcription.callSessionId ||
    recordingMetadata.partyId !== transcription.partyId
  );
}

function tenantMismatch(row: ReconciliationRow): boolean {
  return isCallTranscriptionTenantMismatch(row);
}

function failureReason(row: ReconciliationRow): FailureReason {
  if (tenantMismatch(row)) return "TENANT_MISMATCH";
  const { session, party, version, document } = row;
  if (!session || !party || !version || !document) {
    return version?.objectStatus === "SoftDeleted" ||
      version?.objectStatus === "Destroyed" ||
      version?.deletedAt != null ||
      version?.destroyedAt != null
      ? "RECORDING_DELETED"
      : "RECORDING_UNAVAILABLE";
  }
  if (
    version.objectStatus === "SoftDeleted" ||
    version.objectStatus === "Destroyed" ||
    version.deletedAt != null ||
    version.destroyedAt != null
  ) {
    return "RECORDING_DELETED";
  }
  if (version.objectStatus !== "Active") return "RECORDING_UNAVAILABLE";
  return "PROCESSING_ABANDONED";
}

/**
 * Reconciles only terminal, abandoned processing rows. This function never
 * calls a transcription provider and deliberately does not resubmit work.
 * Every state transition and its system audit row commit in one transaction.
 */
export async function reconcileAbandonedCallTranscriptions(
  options: CallTranscriptionReconciliationOptions = {},
): Promise<CallTranscriptionReconciliationResult> {
  const configured = configuredCallTranscriptionReconciliation();
  const { afterId, now, batchSize, staleAfterMs } = validateOptions(options, configured);
  const cutoff = new Date(now.getTime() - staleAfterMs);
  const rows = await db
    .select({
      transcription: growCallTranscriptions,
      updatedAtToken: sql<string>`${growCallTranscriptions.updatedAt}::text`,
      session: growCallSessions,
      party: parties,
      version: documentObjectVersions,
      document: documents,
    })
    .from(growCallTranscriptions)
    .leftJoin(growCallSessions, eq(growCallTranscriptions.callSessionId, growCallSessions.id))
    .leftJoin(parties, eq(growCallTranscriptions.partyId, parties.id))
    .leftJoin(documentObjectVersions, eq(growCallTranscriptions.recordingReference, documentObjectVersions.id))
    .leftJoin(documents, eq(documentObjectVersions.documentId, documents.id))
    .where(and(
      inArray(growCallTranscriptions.processingState, ["MEDIA_PROCESSING", "TRANSCRIBING"]),
      lte(growCallTranscriptions.updatedAt, cutoff),
      gt(growCallTranscriptions.id, afterId),
    ))
    .orderBy(asc(growCallTranscriptions.id))
    .limit(batchSize);

  const result: CallTranscriptionReconciliationResult = {
    scanned: rows.length,
    failedAbandoned: 0,
    failedUnavailable: 0,
    failedDeleted: 0,
    failedTenantMismatch: 0,
    skippedConcurrentTransition: 0,
    deferredTransitionError: 0,
    nextCursor: rows.length === batchSize ? rows[rows.length - 1]!.transcription.id : null,
  };

  for (const selected of rows) {
    const row = selected as ReconciliationRow;
    const reason = failureReason(row);
    try {
      if (beforeTransitionForTests) await beforeTransitionForTests(row);
      const transitioned = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(growCallTranscriptions)
          .set({
            processingState: "FAILED",
            failureReason: reason,
            lastError: reason,
            // This is terminal reconciliation, not a resubmission. retryCount
            // is intentionally left untouched, including when it is null.
            updatedAt: now,
          })
          .where(and(
            eq(growCallTranscriptions.id, row.transcription.id),
            eq(growCallTranscriptions.brokerageId, row.transcription.brokerageId),
            eq(growCallTranscriptions.processingState, row.transcription.processingState),
            lte(growCallTranscriptions.updatedAt, cutoff),
            // node-postgres materialises timestamp without time zone as a
            // millisecond Date. Compare the raw PostgreSQL text token too,
            // otherwise a defaultNow() value with microseconds can never CAS.
            sql`${growCallTranscriptions.updatedAt}::text = ${row.updatedAtToken}`,
            sql`${growCallTranscriptions.retryCount} is not distinct from ${row.transcription.retryCount}`,
          ))
          .returning({ id: growCallTranscriptions.id });
        if (!updated) return false;
        if (
          shouldFailCallTranscriptionAuditForTests("grow_call_transcription_reconciled") ||
          shouldFailCallTranscriptionAuditForTests("grow_call_transcription_reconciliation_failed") ||
          shouldFailCallTranscriptionAuditForTests("grow_call_transcription_processing_abandoned")
        ) {
          throw new Error("synthetic strict audit outage");
        }
        await writeAuditInTransaction(tx, {
          brokerageId: row.transcription.brokerageId,
          userId: null,
          action: "grow_call_transcription_reconciled",
          recordType: "grow_call_transcription",
          recordId: String(row.transcription.id),
          previousValue: row.transcription.processingState,
          updatedValue: reason,
          providerReference: `call:${row.transcription.callSessionId}:recording:${row.transcription.recordingReference}`,
        });
        return true;
      });
      if (!transitioned) {
        result.skippedConcurrentTransition += 1;
      } else if (reason === "PROCESSING_ABANDONED") {
        result.failedAbandoned += 1;
      } else if (reason === "RECORDING_UNAVAILABLE") {
        result.failedUnavailable += 1;
      } else if (reason === "RECORDING_DELETED") {
        result.failedDeleted += 1;
      } else {
        result.failedTenantMismatch += 1;
      }
    } catch {
      result.deferredTransitionError += 1;
    }
  }
  // A deferred or concurrently changed row may still be eligible on the next
  // sweep. Restarting from the beginning avoids cursor starvation when new
  // stale rows arrive while a full batch is being processed.
  if (result.skippedConcurrentTransition > 0 || result.deferredTransitionError > 0) {
    result.nextCursor = null;
  }
  return result;
}
