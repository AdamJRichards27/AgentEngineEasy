import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { documentObjectVersions } from "./documents";
import { parties } from "./property";
import { growCallSessions } from "./telephony";
import { brokerages, users } from "./users";

// F3 processing/review is a peer lifecycle, not another call-session status.
// Text enums with database checks follow the consent-controls convention.
export const GROW_CALL_TRANSCRIPTION_PROCESSING_STATES = [
  "PENDING",
  "MEDIA_PROCESSING",
  "TRANSCRIBING",
  "AWAITING_AGENT_REVIEW",
  "APPROVED",
  "PARTIALLY_APPROVED",
  "DISCARDED",
  "FAILED",
  "DELETION_SCHEDULED",
  "DELETED",
] as const;
export type GrowCallTranscriptionProcessingState = (typeof GROW_CALL_TRANSCRIPTION_PROCESSING_STATES)[number];

export const GROW_CALL_TRANSCRIPTION_REVIEW_ITEM_TYPES = ["TRANSCRIPT", "SUMMARY", "KEY_POINT", "COMMITMENT", "FOLLOWUP"] as const;
export const GROW_CALL_TRANSCRIPTION_REVIEW_DECISIONS = ["PENDING", "APPROVED", "REJECTED"] as const;

// Stable IDs link candidates to their individual review entries. These are
// draft payloads only, never foreign keys to real commitments or follow-ups.
export const callTranscriptionDraftItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  dueAt: z.string().datetime().nullable().optional(),
});
export type CallTranscriptionDraftItem = z.infer<typeof callTranscriptionDraftItemSchema>;

export const callTranscriptionItemReviewSchema = z.object({
  itemType: z.enum(GROW_CALL_TRANSCRIPTION_REVIEW_ITEM_TYPES),
  // SUMMARY uses the reserved itemId "summary"; other IDs match draft items.
  itemId: z.string().min(1),
  decision: z.enum(GROW_CALL_TRANSCRIPTION_REVIEW_DECISIONS),
  reviewedByUserId: z.number().int().positive().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  editedText: z.string().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
});
export type CallTranscriptionItemReview = z.infer<typeof callTranscriptionItemReviewSchema>;

/**
 * Audit metadata for a live-notes row. Never conversation content, never an
 * object-storage key, and never the recording version id.
 *
 * Lifecycle (structured-output-only):
 * 1. While a call is PENDING, MEDIA_PROCESSING, or TRANSCRIBING, the recording
 *    version id is stored so the mock provider can read the audio. No transcript
 *    is stored yet. Consent, entitlement, and the recording ledger are checked
 *    on every attempt. Live providers stay off.
 * 2. AWAITING_AGENT_REVIEW is the only state that stores the transcript. It
 *    exists so a person can review it. The recording version id stays for this
 *    window so the existing source-ledger check can still refuse a decision if
 *    the recording is no longer this tenant's active source.
 * 3. Save and discard finish the review in one transaction. Save writes the
 *    approved notes (summary, key points, commitments, follow-ups) and then
 *    clears the transcript and the recording version id. Discard clears the
 *    same conversation content and keeps any structured drafts already on the
 *    row. The parent row, consent rows, and approval columns stay.
 * 4. After that, reads do not return the transcript. Object-storage files are
 *    not deleted here.
 */
export type LiveNotesRetentionAudit = {
  schemaVersion?: 1;
  captureRecorded?: boolean;
  processingRecorded?: boolean;
  humanReviewRecorded?: boolean;
  consentReference?: number | null;
  providerId?: string | null;
  audioDurationSeconds?: number | null;
  recordingByteCount?: number | null;
  transcriptCharCount?: number | null;
  transcriptSha256?: string | null;
  structuredOutputCounts?: {
    summary: number;
    keyPoints: number;
    commitments: number;
    followups: number;
  } | null;
  purgedAt?: string | null;
  /** Historical migration id, or forward-review-save / forward-review-discard. */
  purgeMigrationId?: string | null;
  reviewedByUserId?: number | null;
  reviewedAt?: string | null;
};

export const growCallTranscriptions = pgTable(
  "grow_call_transcriptions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    callSessionId: integer("call_session_id").notNull().references(() => growCallSessions.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    // Recording version id. Required while processing and during human review.
    // Cleared in the same transaction that finishes review. Nullable so a
    // finished row does not keep a pointer at the audio. The document and
    // object-storage bytes are not deleted by that clear.
    recordingReference: integer("recording_reference").references(() => documentObjectVersions.id),
    // Hash of the recording bytes. Kept after the version id is cleared so a
    // repeat request can find the finished row without storing the audio pointer.
    recordingContentSha256: text("recording_content_sha256"),
    retentionAudit: jsonb("retention_audit").$type<LiveNotesRetentionAudit>().notNull().default(sql`'{}'::jsonb`),
    processingState: text("processing_state", { enum: GROW_CALL_TRANSCRIPTION_PROCESSING_STATES })
      .notNull()
      .default("PENDING"),
    transcriptionProviderReference: text("transcription_provider_reference"),
    transcript: text("transcript"),
    draftSummary: text("draft_summary"),
    draftKeyPoints: jsonb("draft_key_points").$type<CallTranscriptionDraftItem[]>(),
    draftCommitments: jsonb("draft_commitments").$type<CallTranscriptionDraftItem[]>(),
    draftFollowups: jsonb("draft_followups").$type<CallTranscriptionDraftItem[]>(),
    reviewState: jsonb("review_state").$type<CallTranscriptionItemReview[]>().notNull().default([]),
    failureReason: text("failure_reason"),
    retryCount: integer("retry_count").default(0),
    lastError: text("last_error"),
    // No default approval: future explicit human-save logic owns these.
    approvedBy: integer("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    callRecordingUnique: uniqueIndex("grow_call_transcriptions_call_recording_unique")
      .on(table.callSessionId, table.recordingReference),
    brokerageCallSessionIdx: index("grow_call_transcriptions_brokerage_call_session_idx")
      .on(table.brokerageId, table.callSessionId),
    brokeragePartyIdx: index("grow_call_transcriptions_brokerage_party_idx").on(table.brokerageId, table.partyId),
    brokerageProcessingStateIdx: index("grow_call_transcriptions_brokerage_processing_state_idx")
      .on(table.brokerageId, table.processingState),
    recordingReferenceIdx: index("grow_call_transcriptions_recording_reference_idx").on(table.recordingReference),
    processingStateCheck: check(
      "grow_call_transcriptions_processing_state_check",
      sql`${table.processingState} in ('PENDING', 'MEDIA_PROCESSING', 'TRANSCRIBING', 'AWAITING_AGENT_REVIEW', 'APPROVED', 'PARTIALLY_APPROVED', 'DISCARDED', 'FAILED', 'DELETION_SCHEDULED', 'DELETED')`,
    ),
    draftKeyPointsArrayCheck: check(
      "grow_call_transcriptions_draft_key_points_array_check", sql`jsonb_typeof(${table.draftKeyPoints}) = 'array'`,
    ),
    draftCommitmentsArrayCheck: check(
      "grow_call_transcriptions_draft_commitments_array_check", sql`jsonb_typeof(${table.draftCommitments}) = 'array'`,
    ),
    draftFollowupsArrayCheck: check(
      "grow_call_transcriptions_draft_followups_array_check", sql`jsonb_typeof(${table.draftFollowups}) = 'array'`,
    ),
    reviewStateArrayCheck: check(
      "grow_call_transcriptions_review_state_array_check", sql`jsonb_typeof(${table.reviewState}) = 'array'`,
    ),
    retryCountCheck: check("grow_call_transcriptions_retry_count_check", sql`${table.retryCount} >= 0`),
    approvalMetadataCheck: check(
      "grow_call_transcriptions_approval_metadata_check",
      sql`(${table.approvedBy} is null) = (${table.approvedAt} is null)`,
    ),
  }),
);

// Same-tenant call/party/recording/reviewer consistency must be re-resolved by
// future tenant-scoped services, as for existing Grow tables; plain FKs alone
// do not enforce that relationship. This schema adds no processing or CRM writes.
export const insertGrowCallTranscriptionSchema = createInsertSchema(growCallTranscriptions, {
  draftKeyPoints: z.array(callTranscriptionDraftItemSchema).nullable().optional(),
  draftCommitments: z.array(callTranscriptionDraftItemSchema).nullable().optional(),
  draftFollowups: z.array(callTranscriptionDraftItemSchema).nullable().optional(),
  reviewState: z.array(callTranscriptionItemReviewSchema).optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertGrowCallTranscription = z.infer<typeof insertGrowCallTranscriptionSchema>;
export type GrowCallTranscription = typeof growCallTranscriptions.$inferSelect;
