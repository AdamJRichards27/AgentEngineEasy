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

export const growCallTranscriptions = pgTable(
  "grow_call_transcriptions",
  {
    id: serial("id").primaryKey(),
    brokerageId: integer("brokerage_id").notNull().references(() => brokerages.id),
    callSessionId: integer("call_session_id").notNull().references(() => growCallSessions.id),
    partyId: integer("party_id").notNull().references(() => parties.id),
    // Canonical immutable F2 recording version; no duplicated document row,
    // recording bytes, object key, or retention policy.
    recordingReference: integer("recording_reference").notNull().references(() => documentObjectVersions.id),
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
