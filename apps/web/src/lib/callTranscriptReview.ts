export type TranscriptDisplayState =
  | "Processing call"
  | "Needs review"
  | "Saved to contact"
  | "Processing failed"
  | "Recording unavailable"
  | "Discarded";

/** The full transcript is shown only while the review step is still open. */
export function showsInterimCallTranscript(processingState: string): boolean {
  return processingState === "AWAITING_AGENT_REVIEW";
}

export function transcriptionStatusLabel(state: string, failureReason?: string | null): TranscriptDisplayState {
  if (state === "PENDING" || state === "MEDIA_PROCESSING" || state === "TRANSCRIBING") return "Processing call";
  if (state === "AWAITING_AGENT_REVIEW") return "Needs review";
  if (state === "APPROVED" || state === "PARTIALLY_APPROVED") return "Saved to contact";
  if (state === "DISCARDED") return "Discarded";
  if (
    state === "DELETED" ||
    state === "DELETION_SCHEDULED" ||
    failureReason === "RECORDING_UNAVAILABLE" ||
    failureReason === "RECORDING_DELETED"
  ) {
    return "Recording unavailable";
  }
  return "Processing failed";
}

export type ReviewDecision = "APPROVED" | "REJECTED";
export type ReviewItemType = "SUMMARY" | "KEY_POINT" | "COMMITMENT" | "FOLLOWUP";

export interface ReviewDraftItem {
  id: string;
  text: string;
  manual?: boolean;
}

export interface LocalReviewItem extends ReviewDraftItem {
  itemType: ReviewItemType;
  decision?: ReviewDecision;
  editedText: string;
  rejectionReason: string;
}

export interface SerializedReviewItem {
  itemType: ReviewItemType;
  itemId: string;
  decision: ReviewDecision;
  editedText: string | null;
  rejectionReason: string | null;
}

export function createReviewItems(
  summary: string | null | undefined,
  keyPoints: ReviewDraftItem[] | null | undefined,
  commitments: ReviewDraftItem[] | null | undefined,
  followups: ReviewDraftItem[] | null | undefined,
): LocalReviewItem[] {
  const groups: Array<[ReviewItemType, ReviewDraftItem[]]> = [
    ["SUMMARY", summary ? [{ id: "summary", text: summary }] : []],
    ["KEY_POINT", keyPoints ?? []],
    ["COMMITMENT", commitments ?? []],
    ["FOLLOWUP", followups ?? []],
  ];
  return groups.flatMap(([itemType, items]) =>
    items.map((item) => ({ ...item, itemType, editedText: item.text, rejectionReason: "" })),
  );
}

export function validateReviewItems(items: LocalReviewItem[]): string | null {
  if (items.some((item) => !item.decision)) return "Choose Accept or Reject for every draft item before saving.";
  if (items.some((item) => item.decision === "APPROVED" && !item.editedText.trim())) {
    return "Enter text for every item you accept before saving.";
  }
  if (items.some((item) => item.manual && !item.editedText.trim())) {
    return "Enter text for each item you added, or remove it before saving.";
  }
  return null;
}

export function serializeReviewItems(items: LocalReviewItem[]): SerializedReviewItem[] {
  return items.map((item) => ({
    itemType: item.itemType,
    itemId: item.id,
    decision: item.decision as ReviewDecision,
    // Manual entries must retain their entered text even when rejected: the
    // server uses it to validate a real manually authored draft item.
    editedText: item.manual || item.decision === "APPROVED" ? item.editedText : null,
    rejectionReason: item.decision === "REJECTED" ? item.rejectionReason || null : null,
  }));
}
