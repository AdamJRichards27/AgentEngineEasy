// Section 15 — who may authorise an outbound message.
//
// Accountable humans are users on the message, not the external recipient.
// How each classification counts them (verified against the communications
// suite, not invented here):
//
//   TRANSACTIONAL — the sender alone is enough. Scenario 1 sends with no
//     approval and no second user.
//   MARKETING — an approval record is required, and the sender may be that
//     approver. Scenario 6 is the same user requesting and approving.
//     Marketing counts the approval, not a second person. That rule stays.
//   Send-on-behalf — sendOnBehalfOfUserId is a second accountable human.
//     requiresApproval is already true, and scenarios 2 and 4 have that
//     other user approve before the message can leave.
//   SERVICE — B-5. The old requiresApproval fell through to false, so the
//     sender alone could queue it. A service message is not allowed when
//     that sender is the only accountable human. Someone else has to approve.
//     Naming an on-behalf user does not let the sender approve themselves.

export const APPROVAL_REQUIRED_BEFORE_SEND =
  "This message requires approval before it can be sent — request approval first.";

export const SERVICE_NEEDS_ANOTHER_HUMAN =
  "A service message needs someone other than the sender to approve it.";

export interface AccountableHumanInput {
  senderUserId?: number | null;
  sendOnBehalfOfUserId?: number | null;
  approverUserId?: number | null;
}

/** Distinct user ids who can authorise this message. External recipients are not included. */
export function accountableHumanUserIds(input: AccountableHumanInput): number[] {
  const ids: number[] = [];
  for (const id of [input.senderUserId, input.sendOnBehalfOfUserId, input.approverUserId]) {
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function requiresApproval(message: {
  classification: string;
  sendOnBehalfOfUserId: number | null;
}): boolean {
  if (message.classification === "MARKETING") return true;
  if (message.classification === "SERVICE") return true;
  if (message.sendOnBehalfOfUserId != null) return true;
  return false;
}

/**
 * SERVICE fails closed unless the approver is a different user from the
 * sender. A null sender has no second human to compare against, so it
 * fails closed too. Other classifications do not use this gate: marketing
 * self-approval stays allowed.
 */
export function serviceApproverIsAnotherHuman(
  message: { classification: string; senderUserId: number | null },
  approverUserId: number,
): boolean {
  if (message.classification !== "SERVICE") return true;
  if (message.senderUserId == null) return false;
  return approverUserId !== message.senderUserId;
}

/**
 * True when a SERVICE message is still authorised only by the sender.
 * A null approver means nobody else has approved. The sender approving
 * does not add a human. A distinct approver clears it, including when an
 * on-behalf user is already named — that second id is not an approval.
 */
export function serviceHasOnlyTheSender(
  message: { classification: string; senderUserId: number | null },
  approverUserId: number | null,
): boolean {
  if (message.classification !== "SERVICE") return false;
  if (approverUserId == null) return true;
  return !serviceApproverIsAnotherHuman(message, approverUserId);
}
