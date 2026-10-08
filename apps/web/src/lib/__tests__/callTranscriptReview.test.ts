import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewItems,
  REVIEW_SAVE_CONSENT_WITHDRAWN_MESSAGE,
  reviewSaveErrorMessage,
  serializeReviewItems,
  showsInterimCallTranscript,
  transcriptionStatusLabel,
  validateReviewItems,
} from "../callTranscriptReview";

test("maps processing states without suggesting review", () => {
  assert.equal(transcriptionStatusLabel("PENDING"), "Processing call");
  assert.equal(transcriptionStatusLabel("MEDIA_PROCESSING"), "Processing call");
  assert.equal(transcriptionStatusLabel("TRANSCRIBING"), "Processing call");
});

test("maps review, saved, discarded and failure states to agent labels", () => {
  assert.equal(showsInterimCallTranscript("AWAITING_AGENT_REVIEW"), true);
  assert.equal(showsInterimCallTranscript("APPROVED"), false);
  assert.equal(showsInterimCallTranscript("PARTIALLY_APPROVED"), false);
  assert.equal(showsInterimCallTranscript("DISCARDED"), false);
  assert.equal(showsInterimCallTranscript("FAILED"), false);
  assert.equal(transcriptionStatusLabel("AWAITING_AGENT_REVIEW"), "Needs review");
  assert.equal(transcriptionStatusLabel("APPROVED"), "Saved to contact");
  assert.equal(transcriptionStatusLabel("PARTIALLY_APPROVED"), "Saved to contact");
  assert.equal(transcriptionStatusLabel("DISCARDED"), "Discarded");
  assert.equal(transcriptionStatusLabel("FAILED"), "Processing failed");
});

test("maps recording deletion and availability failures safely", () => {
  assert.equal(transcriptionStatusLabel("DELETED"), "Recording unavailable");
  assert.equal(transcriptionStatusLabel("DELETION_SCHEDULED"), "Recording unavailable");
  assert.equal(transcriptionStatusLabel("FAILED", "RECORDING_UNAVAILABLE"), "Recording unavailable");
  assert.equal(transcriptionStatusLabel("FAILED", "RECORDING_DELETED"), "Recording unavailable");
  assert.equal(transcriptionStatusLabel("UNEXPECTED_STATE"), "Processing failed");
});

test("keeps independent decisions and text when serializing manual review items", () => {
  const items = [
    { id: "point-1", itemType: "KEY_POINT" as const, text: "Original", editedText: "Kept", rejectionReason: "", decision: "APPROVED" as const },
    { id: "manual-1", itemType: "FOLLOWUP" as const, text: "", editedText: "Call Friday", rejectionReason: "Not this week", manual: true, decision: "REJECTED" as const },
  ];
  assert.equal(validateReviewItems(items), null);
  assert.deepEqual(serializeReviewItems(items), [
    { itemType: "KEY_POINT", itemId: "point-1", decision: "APPROVED", editedText: "Kept", rejectionReason: null },
    { itemType: "FOLLOWUP", itemId: "manual-1", decision: "REJECTED", editedText: "Call Friday", rejectionReason: "Not this week" },
  ]);
  assert.equal(validateReviewItems([{ ...items[0], editedText: "   " }]), "Enter text for every item you accept before saving.");
  assert.equal(validateReviewItems([{ ...items[1], editedText: "" }]), "Enter text for each item you added, or remove it before saving.");
});

test("creates every AI draft as an independently undecided review item", () => {
  const items = createReviewItems(
    "Draft summary",
    [{ id: "point-1", text: "First point" }, { id: "point-2", text: "Second point" }],
    [{ id: "commitment-1", text: "A commitment" }],
    [{ id: "followup-1", text: "A follow-up" }],
  );

  assert.deepEqual(
    items.map(({ id, itemType, text, editedText, decision }) => ({ id, itemType, text, editedText, decision })),
    [
      { id: "summary", itemType: "SUMMARY", text: "Draft summary", editedText: "Draft summary", decision: undefined },
      { id: "point-1", itemType: "KEY_POINT", text: "First point", editedText: "First point", decision: undefined },
      { id: "point-2", itemType: "KEY_POINT", text: "Second point", editedText: "Second point", decision: undefined },
      { id: "commitment-1", itemType: "COMMITMENT", text: "A commitment", editedText: "A commitment", decision: undefined },
      { id: "followup-1", itemType: "FOLLOWUP", text: "A follow-up", editedText: "A follow-up", decision: undefined },
    ],
  );
  assert.equal(validateReviewItems(items), "Choose Accept or Reject for every draft item before saving.");

  const independentlyDecided = items.map((item, index) => ({
    ...item,
    decision: index % 2 === 0 ? "APPROVED" as const : "REJECTED" as const,
  }));
  assert.equal(validateReviewItems(independentlyDecided), null);
  assert.deepEqual(
    serializeReviewItems(independentlyDecided).map(({ itemId, decision }) => ({ itemId, decision })),
    [
      { itemId: "summary", decision: "APPROVED" },
      { itemId: "point-1", decision: "REJECTED" },
      { itemId: "point-2", decision: "APPROVED" },
      { itemId: "commitment-1", decision: "REJECTED" },
      { itemId: "followup-1", decision: "APPROVED" },
    ],
  );
});

test("a withdrawn-consent save shows that the review cannot be saved and discard is still available", () => {
  assert.equal(
    reviewSaveErrorMessage({ status: 409, code: "CONSENT_WITHDRAWN", friendly: "Recording consent has been withdrawn; no new transcription or AI processing is permitted." }, "fallback"),
    REVIEW_SAVE_CONSENT_WITHDRAWN_MESSAGE,
  );
  assert.match(REVIEW_SAVE_CONSENT_WITHDRAWN_MESSAGE, /can’t be saved/);
  assert.match(REVIEW_SAVE_CONSENT_WITHDRAWN_MESSAGE, /discard the transcript/);
  assert.equal(reviewSaveErrorMessage({ friendly: "Check the review and try again." }, "fallback"), "Check the review and try again.");
  assert.equal(reviewSaveErrorMessage(new Error("nope"), "fallback"), "fallback");
});
