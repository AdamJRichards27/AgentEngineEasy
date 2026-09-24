// B-5 — a SERVICE message is not allowed when the only accountable human
// is the sender.
//
// TRANSACTIONAL counts one human (the sender) as enough to send.
// MARKETING counts an approval record, and the sender may be that approver.
// Send-on-behalf counts a second user, who has to approve.
// SERVICE used to follow TRANSACTIONAL. This lock fails if that returns:
// the sender alone must not satisfy requiresApproval, and the sender
// approving must not count as another human.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accountableHumanUserIds,
  requiresApproval,
  serviceApproverIsAnotherHuman,
  serviceHasOnlyTheSender,
} from "../approvalPolicy.js";

test("B-5 lock: SERVICE is not allowed when the only accountable human is the sender", () => {
  const senderOnly = { classification: "SERVICE" as const, senderUserId: 7, sendOnBehalfOfUserId: null };

  assert.equal(requiresApproval(senderOnly), true, "the sender alone must not be able to queue a SERVICE message");
  assert.equal(
    serviceApproverIsAnotherHuman(senderOnly, senderOnly.senderUserId),
    false,
    "the sender approving their own SERVICE message is still only the sender",
  );
  assert.equal(serviceHasOnlyTheSender(senderOnly, null), true);
  assert.equal(serviceHasOnlyTheSender(senderOnly, senderOnly.senderUserId), true);

  const otherHuman = 8;
  assert.equal(serviceApproverIsAnotherHuman(senderOnly, otherHuman), true);
  assert.equal(serviceHasOnlyTheSender(senderOnly, otherHuman), false);
  assert.deepEqual(accountableHumanUserIds({ senderUserId: senderOnly.senderUserId, approverUserId: otherHuman }), [
    senderOnly.senderUserId,
    otherHuman,
  ]);
});

test("B-5 lock: naming an on-behalf user does not let the sender approve their own SERVICE message", () => {
  const message = { classification: "SERVICE" as const, senderUserId: 4, sendOnBehalfOfUserId: 9 };
  assert.equal(requiresApproval(message), true);
  assert.equal(serviceApproverIsAnotherHuman(message, message.senderUserId), false);
  assert.equal(serviceHasOnlyTheSender(message, message.senderUserId), true);
  assert.equal(serviceApproverIsAnotherHuman(message, message.sendOnBehalfOfUserId), true);
  assert.equal(serviceHasOnlyTheSender(message, message.sendOnBehalfOfUserId), false);
  assert.deepEqual(
    accountableHumanUserIds({
      senderUserId: message.senderUserId,
      sendOnBehalfOfUserId: message.sendOnBehalfOfUserId,
      approverUserId: message.sendOnBehalfOfUserId,
    }),
    [4, 9],
  );
});

test("B-5 lock: a SERVICE message with no sender still fails closed", () => {
  assert.equal(serviceApproverIsAnotherHuman({ classification: "SERVICE", senderUserId: null }, 3), false);
  assert.equal(serviceHasOnlyTheSender({ classification: "SERVICE", senderUserId: null }, 3), true);
});

test("other classifications keep their own human counts", () => {
  assert.equal(requiresApproval({ classification: "TRANSACTIONAL", sendOnBehalfOfUserId: null }), false);
  assert.equal(serviceHasOnlyTheSender({ classification: "TRANSACTIONAL", senderUserId: 1 }, null), false);
  assert.deepEqual(accountableHumanUserIds({ senderUserId: 1 }), [1]);

  assert.equal(requiresApproval({ classification: "MARKETING", sendOnBehalfOfUserId: null }), true);
  assert.equal(serviceApproverIsAnotherHuman({ classification: "MARKETING", senderUserId: 1 }, 1), true);

  assert.equal(requiresApproval({ classification: "TRANSACTIONAL", sendOnBehalfOfUserId: 2 }), true);
  assert.deepEqual(accountableHumanUserIds({ senderUserId: 1, sendOnBehalfOfUserId: 1 }), [1]);
  assert.deepEqual(accountableHumanUserIds({ senderUserId: 1, sendOnBehalfOfUserId: 2 }), [1, 2]);
});
