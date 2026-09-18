import {
  growActivities,
  type CallTranscriptionDraftItem,
  type GrowCallTranscription,
} from "@aee/db";
import type { ConsentTransaction } from "../consentControlsPersistence.js";

type ApprovedItem = { id: string; text: string };

/**
 * Called only by the explicit review Save route, inside its locked approval
 * transaction. Provenance IDs are scalar snapshots, never foreign keys to
 * recordings, sessions, or transcriptions. No downstream actions are invoked.
 */
export async function persistApprovedCallSummaryActivity(
  tx: ConsentTransaction,
  transcription: GrowCallTranscription,
): Promise<void> {
  if ((transcription.processingState !== "APPROVED" &&
      transcription.processingState !== "PARTIALLY_APPROVED") ||
      transcription.approvedBy === null || transcription.approvedAt === null) {
    throw new Error("A call summary Timeline entry requires an approved review.");
  }

  const approved = (transcription.reviewState ?? []).filter((item) => item.decision === "APPROVED");
  const resolveText = (editedText: string | null | undefined, original: string | null | undefined): string => {
    const text = editedText ?? original;
    if (text === null || text === undefined) {
      throw new Error("Approved review content is missing.");
    }
    return text;
  };
  const items = (
    type: "KEY_POINT" | "COMMITMENT" | "FOLLOWUP",
    drafts: CallTranscriptionDraftItem[] | null,
  ): ApprovedItem[] => approved.filter((item) => item.itemType === type).map((item) => ({
    id: item.itemId,
    text: resolveText(item.editedText, drafts?.find((draft) => draft.id === item.itemId)?.text),
  }));
  const summaryReview = approved.find((item) => item.itemType === "SUMMARY");
  const approvedContent = {
    summary: summaryReview ? resolveText(summaryReview.editedText, transcription.draftSummary) : null,
    keyPoints: items("KEY_POINT", transcription.draftKeyPoints),
    commitments: items("COMMITMENT", transcription.draftCommitments),
    followups: items("FOLLOWUP", transcription.draftFollowups),
  };

  // Timeline aggregation reads activity.summary directly. Store the complete
  // approved subset here too; it must never join back to transient source data.
  const sections = ["Approved call summary"];
  if (approvedContent.summary !== null) sections.push(approvedContent.summary);
  for (const [label, entries] of [
    ["Key points", approvedContent.keyPoints],
    ["Commitments", approvedContent.commitments],
    ["Follow-ups", approvedContent.followups],
  ] as const) {
    if (entries.length) sections.push(`${label}:\n${entries.map((item) => `- ${item.text}`).join("\n")}`);
  }
  if (sections.length === 1) sections.push("No summary items approved.");

  await tx.insert(growActivities).values({
    brokerageId: transcription.brokerageId,
    partyId: transcription.partyId,
    activityType: "call_summary",
    occurredAt: transcription.approvedAt,
    summary: sections.join("\n\n"),
    details: {
      partyId: transcription.partyId,
      callSessionId: transcription.callSessionId,
      transcriptionId: transcription.id,
      approvedBy: transcription.approvedBy,
      approvedAt: transcription.approvedAt.toISOString(),
      approvedContent,
    },
    responsibleUserId: transcription.approvedBy,
    source: "grow_call_transcriptions",
    sourceId: String(transcription.id),
  });
}
