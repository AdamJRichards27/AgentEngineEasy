import { createHash } from "node:crypto";
import type {
  CallTranscriptionItemReview,
  GrowCallTranscription,
  LiveNotesRetentionAudit,
} from "@aee/db";

export const FORWARD_REVIEW_SAVE_PURGE_ID = "forward-review-save";
export const FORWARD_REVIEW_DISCARD_PURGE_ID = "forward-review-discard";

export function hashTranscript(transcript: string): string {
  return createHash("sha256").update(transcript, "utf8").digest("hex");
}

export function stripTranscriptText(
  reviewState: CallTranscriptionItemReview[],
): CallTranscriptionItemReview[] {
  return reviewState.map((item) => (
    item.itemType === "TRANSCRIPT" ? { ...item, editedText: null } : item
  ));
}

/**
 * The interim transcript is returned only while a person still has to review
 * it. Every later state omits the transcript and any saved transcript text.
 */
export function projectCallTranscriptionForClient(row: GrowCallTranscription): GrowCallTranscription {
  const reviewState = stripTranscriptText(row.reviewState ?? []);
  if (row.processingState === "AWAITING_AGENT_REVIEW") {
    return { ...row, reviewState };
  }
  return { ...row, transcript: null, reviewState };
}

export function mergeRetentionAudit(
  existing: LiveNotesRetentionAudit | null | undefined,
  patch: LiveNotesRetentionAudit,
): LiveNotesRetentionAudit {
  return {
    ...(existing ?? {}),
    ...patch,
    schemaVersion: 1,
  };
}

export function approvedStructuredOutputCounts(
  items: Array<Pick<CallTranscriptionItemReview, "itemType" | "decision">>,
): NonNullable<LiveNotesRetentionAudit["structuredOutputCounts"]> {
  const approved = items.filter((item) => item.decision === "APPROVED");
  return {
    summary: approved.filter((item) => item.itemType === "SUMMARY").length,
    keyPoints: approved.filter((item) => item.itemType === "KEY_POINT").length,
    commitments: approved.filter((item) => item.itemType === "COMMITMENT").length,
    followups: approved.filter((item) => item.itemType === "FOLLOWUP").length,
  };
}

export function captureRetentionAudit(input: {
  consentReference: number | null;
  audioDurationSeconds: number | null;
  recordingByteCount: number | null;
}): LiveNotesRetentionAudit {
  return {
    schemaVersion: 1,
    captureRecorded: true,
    processingRecorded: false,
    humanReviewRecorded: false,
    consentReference: input.consentReference,
    providerId: null,
    audioDurationSeconds: input.audioDurationSeconds,
    recordingByteCount: input.recordingByteCount,
    transcriptCharCount: null,
    transcriptSha256: null,
    structuredOutputCounts: null,
    purgedAt: null,
    purgeMigrationId: null,
    reviewedByUserId: null,
    reviewedAt: null,
  };
}

export function processingRetentionAudit(
  existing: LiveNotesRetentionAudit | null | undefined,
  input: {
    providerId: string;
    audioDurationSeconds: number | null;
    transcript: string;
    structuredOutputCounts: LiveNotesRetentionAudit["structuredOutputCounts"];
  },
): LiveNotesRetentionAudit {
  return mergeRetentionAudit(existing, {
    processingRecorded: true,
    providerId: input.providerId,
    audioDurationSeconds: input.audioDurationSeconds ?? existing?.audioDurationSeconds ?? null,
    transcriptCharCount: input.transcript.length,
    transcriptSha256: hashTranscript(input.transcript),
    structuredOutputCounts: input.structuredOutputCounts,
    purgedAt: null,
    purgeMigrationId: null,
  });
}

export function reviewPurgeRetentionAudit(
  existing: LiveNotesRetentionAudit | null | undefined,
  input: {
    purgeMigrationId: string;
    humanReviewRecorded: boolean;
    consentReference: number | null;
    recordingByteCount: number | null;
    transcript: string | null;
    structuredOutputCounts: LiveNotesRetentionAudit["structuredOutputCounts"];
    reviewedByUserId: number | null;
    reviewedAt: string | null;
    purgedAt: string;
  },
): LiveNotesRetentionAudit {
  return mergeRetentionAudit(existing, {
    captureRecorded: true,
    processingRecorded: true,
    humanReviewRecorded: input.humanReviewRecorded,
    consentReference: input.consentReference ?? existing?.consentReference ?? null,
    recordingByteCount: input.recordingByteCount ?? existing?.recordingByteCount ?? null,
    transcriptCharCount: input.transcript?.length ?? existing?.transcriptCharCount ?? null,
    transcriptSha256: input.transcript ? hashTranscript(input.transcript) : existing?.transcriptSha256 ?? null,
    structuredOutputCounts: input.structuredOutputCounts,
    purgedAt: input.purgedAt,
    purgeMigrationId: input.purgeMigrationId,
    reviewedByUserId: input.reviewedByUserId,
    reviewedAt: input.reviewedAt,
  });
}

export function intentionallyClearedRecording(row: Pick<GrowCallTranscription, "recordingReference" | "retentionAudit">): boolean {
  return row.recordingReference == null && (
    typeof row.retentionAudit?.purgedAt === "string" ||
    typeof row.retentionAudit?.purgeMigrationId === "string"
  );
}
