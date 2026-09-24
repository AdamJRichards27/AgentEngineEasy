// G-6 — one user-facing name for each Grow record.
//
// A due follow-up is an opportunity next action or an appraisal follow-up
// that is due. It lives on that record. It is not a grow_commitments row.
//
// A commitment is an Open grow_commitments row: a promise already recorded.
// Approving a proposal creates one. It does not set a due follow-up.
//
// A call follow-up is a FOLLOWUP item from a call transcript review. A call
// commitment is a COMMITMENT item from that same review. Either can be
// proposed as a commitment. Neither is a due follow-up, and neither is an
// Open commitment until that proposal is approved and created.

/** Kind label on an opportunity or appraisal card that is due. */
export const DUE_FOLLOW_UP_LABEL = "Due follow-up";

/** Kind label on an Open grow_commitments card. */
export const COMMITMENT_LABEL = "Commitment";

/**
 * Grow Today headline for counts.followUpsDue.
 * That number counts opportunity and appraisal due follow-ups together with
 * open commitments due today or overdue. The label names both records.
 */
export const DUE_TODAY_COUNT_LABEL = "Due follow-ups & commitments";

export const DUE_TODAY_COUNT_HINT =
  "Opportunity and appraisal due follow-ups, plus open commitments due today or overdue. A due follow-up is a next step on that record. A commitment is a promise already recorded.";

export const SET_DUE_FOLLOW_UP_LABEL = "Set due follow-up";
export const SAVE_DUE_FOLLOW_UP_LABEL = "Save due follow-up";

export const DUE_FOLLOW_UP_FORM_HINT =
  "This sets a due follow-up on the opportunity. It does not create a commitment.";

/** Contact 360 shows the soonest open commitment. It is not a due follow-up. */
export const NEXT_COMMITMENT_LABEL = "Next commitment:";
export const NO_OPEN_COMMITMENT = "No open commitment.";

export const CALL_FOLLOW_UP_LABEL = "Call follow-up";
export const CALL_COMMITMENT_LABEL = "Call commitment";
export const CALL_FOLLOW_UPS_GROUP = "Call follow-ups";
export const CALL_COMMITMENTS_GROUP = "Call commitments";

export const CALL_ITEMS_TITLE = "Call follow-ups and call commitments";
export const CALL_ITEMS_HELP =
  "Approved call follow-ups and call commitments can be proposed as commitments. Nothing is created until you approve. This does not set a due follow-up on an opportunity or appraisal.";
export const CALL_ITEMS_EMPTY = "No approved call commitments or call follow-ups in this review.";
export const CALL_ITEMS_LOADING = "Loading items from this call…";
export const PROPOSE_SELECTED_LABEL = "Propose selected items";

export const PROPOSED_COMMITMENT_PREFIX = "Proposed commitment";
export const COMMITMENT_CREATED_HEADING = "Commitment created";
export const COMMITMENT_MAY_EXIST_HEADING = "Commitment may already have been created";

export const ASK_DUE_FOLLOW_UPS_QUESTION = "What due follow-ups are overdue?";

/**
 * Stored proposals used to call a commitment a "follow-up commitment".
 * Display the record's name. A due follow-up and a call follow-up are left
 * alone — those phrases name different records.
 */
export function showCommitmentNotFollowUp(summary: string): string {
  return summary.replace(/\bfollow-up commitment\b/gi, "commitment");
}
