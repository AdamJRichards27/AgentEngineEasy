import assert from "node:assert/strict";
import test from "node:test";
import {
  canRetryProposalState,
  COMPLETED_AFTER_RECOVERY_MESSAGE,
  formatProposalExpiry,
  initialProposalState,
  isProposalBusy,
  isProposalExpired,
  permissionDeniedMessage,
  proposalCardStatusLabel,
  provenanceLabel,
  stateForProposalError,
  viewFromAskAgentProposal,
  viewFromPendingProposal,
} from "../commitmentProposals";

const NOW = new Date("2026-09-19T00:00:00.000Z");

test("expiry is shown as whole hours remaining, then minutes, then Expired", () => {
  assert.equal(formatProposalExpiry("2026-09-19T23:59:00.000Z", NOW), "Expires in 23h");
  assert.equal(formatProposalExpiry("2026-09-20T00:00:00.000Z", NOW), "Expires in 24h");
  assert.equal(formatProposalExpiry("2026-09-19T00:40:00.000Z", NOW), "Expires in 40m");
  assert.equal(formatProposalExpiry("2026-09-19T00:00:20.000Z", NOW), "Expires in 1m");
  assert.equal(formatProposalExpiry("2026-09-19T00:00:00.000Z", NOW), "Expired");
  assert.equal(formatProposalExpiry("2026-09-18T20:00:00.000Z", NOW), "Expired");
  assert.equal(formatProposalExpiry(null, NOW), null);
  assert.equal(formatProposalExpiry("garbage", NOW), null);
  assert.equal(isProposalExpired("2026-09-18T20:00:00.000Z", NOW), true);
  assert.equal(isProposalExpired(null, NOW), false);
});

test("error mapping covers the F4.0 governed approve/reject/execute outcomes", () => {
  assert.equal(stateForProposalError({ status: 404, reason: "NOT_FOUND" }), "not_available");
  assert.equal(stateForProposalError({ status: 409, reason: "EXPIRED" }), "expired");
  assert.equal(stateForProposalError({ status: 409, reason: "WRONG_STATUS" }), "already_actioned");
  assert.equal(stateForProposalError({ status: 403, reason: "ENTITLEMENT_DENIED" }), "permission_denied");
  assert.equal(stateForProposalError({ status: 403, reason: "EXECUTOR_NOT_AUTHORISED" }), "permission_denied");
  assert.equal(stateForProposalError({ status: 403, reason: "APPROVER_ROLE_FORBIDDEN" }), "permission_denied");
  assert.equal(stateForProposalError({ status: 400 }), "validation_error");
  assert.equal(stateForProposalError({ status: 409, reason: "APPROVAL_MISSING" }), "recoverable_failure");
  assert.equal(stateForProposalError({ status: 500 }), "recoverable_failure");
});

test("COMPLETED_AFTER_RECOVERY is never retryable and tells the agent to check commitments", () => {
  const state = stateForProposalError({ status: 409, reason: "COMPLETED_AFTER_RECOVERY", sideEffectApplied: true });
  assert.equal(state, "completed_after_recovery");
  assert.equal(stateForProposalError({ status: 409, sideEffectApplied: true }), "completed_after_recovery");
  assert.equal(canRetryProposalState(state), false);
  assert.match(COMPLETED_AFTER_RECOVERY_MESSAGE, /may already have been created/);
  assert.match(COMPLETED_AFTER_RECOVERY_MESSAGE, /Commitments/);
  assert.match(COMPLETED_AFTER_RECOVERY_MESSAGE, /don’t try again/);
  for (const other of ["expired", "already_actioned", "not_available", "permission_denied", "executed", "rejected"] as const) {
    assert.equal(canRetryProposalState(other), false, `${other} must not offer a retry`);
  }
  assert.equal(canRetryProposalState("recoverable_failure"), true);
});

test("permission messaging distinguishes entitlement and executor denials", () => {
  assert.match(permissionDeniedMessage("ENTITLEMENT_DENIED"), /access doesn’t include/);
  assert.match(permissionDeniedMessage("EXECUTOR_NOT_AUTHORISED"), /Only the person who approved/);
  assert.match(permissionDeniedMessage("APPROVER_ROLE_FORBIDDEN"), /don’t have authority/);
});

test("initial card state never auto-executes and reflects expiry", () => {
  assert.equal(initialProposalState({ status: "AWAITING_APPROVAL", expiresAt: "2026-09-19T10:00:00.000Z" }, NOW), "review");
  assert.equal(initialProposalState({ status: "AWAITING_APPROVAL", expiresAt: "2026-09-18T10:00:00.000Z" }, NOW), "expired");
  assert.equal(initialProposalState({ status: "APPROVED", expiresAt: null }, NOW), "approved");
  assert.equal(initialProposalState({ status: "COMPLETED", expiresAt: null }, NOW), "already_actioned");
});

test("busy states disable every action while a governed call is in flight", () => {
  assert.equal(isProposalBusy("approving"), true);
  assert.equal(isProposalBusy("executing"), true);
  assert.equal(isProposalBusy("rejecting"), true);
  assert.equal(isProposalBusy("review"), false);
});

test("card status label follows the live card state", () => {
  assert.equal(proposalCardStatusLabel("review", "AWAITING_APPROVAL"), "Awaiting approval");
  assert.equal(proposalCardStatusLabel("executed", "AWAITING_APPROVAL"), "Commitment created");
  assert.equal(proposalCardStatusLabel("expired", "AWAITING_APPROVAL"), "Expired");
  assert.equal(proposalCardStatusLabel("completed_after_recovery", "APPROVED"), "May already be created");
});

test("provenance label appears only for call-review proposals", () => {
  assert.equal(provenanceLabel({ source: "call_review", transcriptionId: 1, itemType: "COMMITMENT", itemId: "a" }), "From call review");
  assert.equal(provenanceLabel(null), null);
});

test("pending-commitments rows adapt to the card view with provenance and no id-only evidence", () => {
  const view = viewFromPendingProposal(
    {
      id: 9,
      actionKey: "CREATE_GROW_COMMITMENT",
      humanReadableSummary: "Create commitment for party #3",
      input: {
        partyId: 3,
        description: "Call back about the listing",
        dueAt: "2026-09-25T00:00:00.000Z",
        reason: "Follow-up approved in call review",
        evidenceSummary: "callSession:1 transcription:2 item:FOLLOWUP:f-1",
      },
      status: "AWAITING_APPROVAL",
      createdAt: "2026-09-18T12:00:00.000Z",
      expiresAt: "2026-09-19T12:00:00.000Z",
      provenance: { source: "call_review", transcriptionId: 2, itemType: "FOLLOWUP", itemId: "f-1" },
    },
    "Jo Citizen",
  );
  assert.equal(view.actionRequestId, 9);
  assert.equal(view.summary, "Call back about the listing");
  assert.equal(view.contactName, "Jo Citizen");
  assert.equal(view.dueAt, "2026-09-25T00:00:00.000Z");
  assert.equal(view.evidenceSummary, null);
  assert.equal(provenanceLabel(view.provenance), "From call review");

  const plain = viewFromPendingProposal(
    { id: 10, actionKey: "CREATE_GROW_COMMITMENT", humanReadableSummary: "Summary", input: null, status: "AWAITING_APPROVAL", createdAt: "", expiresAt: null, provenance: null },
    "Jo Citizen",
  );
  assert.equal(plain.summary, "Summary");
  assert.equal(plain.provenance, null);
});

test("Ask AE proposals adapt without losing any Stage D field", () => {
  const view = viewFromAskAgentProposal({
    actionRequestId: 4,
    actionKey: "CREATE_GROW_COMMITMENT",
    humanReadableSummary: "Follow up with Jo",
    contactName: "Jo Citizen",
    partyId: 3,
    dueAt: "2026-09-25T00:00:00.000Z",
    timeZone: "Australia/Brisbane",
    relatedPropertyId: null,
    relatedOpportunityId: null,
    reason: "Overdue follow-up",
    evidenceSummary: "Last contact 40 days ago",
    status: "APPROVED",
    expiresAt: null,
    reviewUrl: "/grow",
  });
  assert.deepEqual(view, {
    actionRequestId: 4,
    summary: "Follow up with Jo",
    contactName: "Jo Citizen",
    dueAt: "2026-09-25T00:00:00.000Z",
    timeZone: "Australia/Brisbane",
    reason: "Overdue follow-up",
    evidenceSummary: "Last contact 40 days ago",
    status: "APPROVED",
    expiresAt: null,
    reviewUrl: "/grow",
    provenance: null,
  });
});
