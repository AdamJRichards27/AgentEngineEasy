import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProposePayload,
  canProposeCandidate,
  cardRequestForCandidate,
  CONSENT_BLOCKED_MESSAGE,
  createFollowupDrafts,
  dateInputToIso,
  followupErrorMessage,
  followupInvalidationKeys,
  followupKey,
  followupStatus,
  isDraftDueDateConfirmed,
  isDraftReady,
  isoToDateInput,
  mergeFollowupDrafts,
  mergeRetainedProposals,
  proposeDisabledReason,
  retainOutcomes,
  setDraftDueDate,
  setDraftDueDateConfirmed,
  summarizeProposeOutcomes,
  viewFromFollowupRequest,
  type CallFollowupCandidate,
  type FollowupActionRequestSummary,
  type FollowupDraft,
} from "../callFollowups";

const NOW = new Date("2026-09-19T00:00:00.000Z");

function candidate(overrides: Partial<CallFollowupCandidate> = {}): CallFollowupCandidate {
  return {
    itemType: "COMMITMENT",
    itemId: "c-1",
    text: "Send the appraisal pack",
    suggestedDueAt: null,
    consentBlocked: false,
    existingProposal: { visibility: "NONE" },
    latestProposalStatus: null,
    canPropose: true,
    ...overrides,
  };
}

function request(overrides: Partial<FollowupActionRequestSummary> = {}): FollowupActionRequestSummary {
  return {
    actionRequestId: 501,
    status: "AWAITING_APPROVAL",
    dueAt: "2026-09-25T00:00:00.000Z",
    description: "Send the appraisal pack",
    proposedByUserId: 7,
    createdAt: "2026-09-18T12:00:00.000Z",
    expiresAt: "2026-09-19T12:00:00.000Z",
    ...overrides,
  };
}

function confirmedDraft(dueDate: string, selected = true): FollowupDraft {
  return setDraftDueDateConfirmed({ selected, dueDate, confirmedDueDate: null }, true);
}

test("dateInputToIso converts a YYYY-MM-DD date to an ISO-8601 UTC-midnight timestamp", () => {
  assert.equal(dateInputToIso("2026-10-01"), "2026-10-01T00:00:00.000Z");
  assert.equal(dateInputToIso(" 2026-02-28 "), "2026-02-28T00:00:00.000Z");
  assert.equal(dateInputToIso("2026-02-30"), null, "impossible calendar dates are rejected");
  assert.equal(dateInputToIso(""), null);
  assert.equal(dateInputToIso("01/10/2026"), null);
  assert.equal(dateInputToIso("2026-10-01T09:00"), null);
});

test("isoToDateInput pre-fills a date input from a suggested ISO timestamp", () => {
  assert.equal(isoToDateInput("2026-10-01T00:00:00.000Z", "Australia/Brisbane"), "2026-10-01");
  assert.equal(isoToDateInput(null), "");
  assert.equal(isoToDateInput("not a date"), "");
});

// Date semantics (F4 date remediation): the pre-filled date is the calendar
// date on which the suggested instant falls in the agent's time zone — the
// same date Grow displays for that instant — never the UTC calendar date.
test("AEST (Brisbane, UTC+10, no DST): a suggestion is pre-filled with its Brisbane calendar date, including across UTC and local midnight", () => {
  const zone = "Australia/Brisbane";
  assert.equal(isoToDateInput("2026-09-24T23:00:00.000Z", zone), "2026-09-25", "9am Fri 25 Sep AEST is still the 24th in UTC");
  assert.equal(isoToDateInput("2026-09-24T13:59:59.000Z", zone), "2026-09-24", "23:59:59 local stays on the 24th");
  assert.equal(isoToDateInput("2026-09-24T14:00:00.000Z", zone), "2026-09-25", "local midnight starts the 25th");
  assert.equal(isoToDateInput("2026-09-25T00:00:00.000Z", zone), "2026-09-25", "UTC midnight is 10am the same day");
  assert.equal(isoToDateInput("2026-09-25T13:59:59.999Z", zone), "2026-09-25");
});

test("AEDT (Sydney in summer, UTC+11) and ACDT (Adelaide, UTC+10:30): suggestions are pre-filled with the local calendar date", () => {
  assert.equal(isoToDateInput("2026-01-14T13:00:00.000Z", "Australia/Sydney"), "2026-01-15", "AEDT local midnight");
  assert.equal(isoToDateInput("2026-01-14T12:59:59.000Z", "Australia/Sydney"), "2026-01-14");
  assert.equal(isoToDateInput("2026-01-14T22:00:00.000Z", "Australia/Sydney"), "2026-01-15", "9am AEDT on the 15th");
  assert.equal(isoToDateInput("2026-01-14T13:30:00.000Z", "Australia/Adelaide"), "2026-01-15", "ACDT local midnight");
  assert.equal(isoToDateInput("2026-01-14T13:29:59.000Z", "Australia/Adelaide"), "2026-01-14");
  assert.equal(isoToDateInput("2026-01-14T16:00:00.000Z", "Australia/Perth"), "2026-01-15", "AWST local midnight (UTC+8)");
});

test("UTC boundary: UTC-midnight and just-before-UTC-midnight suggestions resolve per zone, and UTC itself is unchanged", () => {
  for (const zone of ["Australia/Brisbane", "Australia/Sydney", "Australia/Melbourne", "Australia/Adelaide", "Australia/Darwin", "Australia/Perth", "Australia/Hobart"]) {
    assert.equal(isoToDateInput("2026-10-01T00:00:00.000Z", zone), "2026-10-01", `${zone}: UTC midnight is the same calendar day`);
    assert.equal(isoToDateInput("2026-09-30T23:59:59.000Z", zone), "2026-10-01", `${zone}: 23:59:59 UTC is already the next day locally`);
  }
  assert.equal(isoToDateInput("2026-09-30T23:59:59.000Z", "UTC"), "2026-09-30");
  assert.equal(isoToDateInput("2026-10-01T00:00:00.000Z", "UTC"), "2026-10-01");
});

test("DST transitions (Sydney): the local calendar date is correct either side of the October and April clock changes", () => {
  const zone = "Australia/Sydney";
  // Clocks go forward at 02:00 AEST on Sunday 4 October 2026.
  assert.equal(isoToDateInput("2026-10-03T13:59:59.000Z", zone), "2026-10-03", "last second of Sat 3 Oct (AEST)");
  assert.equal(isoToDateInput("2026-10-03T14:00:00.000Z", zone), "2026-10-04", "00:00 AEST Sun 4 Oct");
  assert.equal(isoToDateInput("2026-10-03T16:00:00.000Z", zone), "2026-10-04", "03:00 AEDT, just after the change");
  assert.equal(isoToDateInput("2026-10-04T12:59:59.000Z", zone), "2026-10-04", "last second of Sun 4 Oct (AEDT)");
  assert.equal(isoToDateInput("2026-10-04T13:00:00.000Z", zone), "2026-10-05", "00:00 AEDT Mon 5 Oct");
  // Clocks go back at 03:00 AEDT on Sunday 5 April 2026.
  assert.equal(isoToDateInput("2026-04-04T13:00:00.000Z", zone), "2026-04-05", "00:00 AEDT Sun 5 Apr");
  assert.equal(isoToDateInput("2026-04-04T16:30:00.000Z", zone), "2026-04-05", "during the repeated 02:00-03:00 hour");
  assert.equal(isoToDateInput("2026-04-05T13:59:59.000Z", zone), "2026-04-05", "last second of Sun 5 Apr (AEST)");
  assert.equal(isoToDateInput("2026-04-05T14:00:00.000Z", zone), "2026-04-06", "00:00 AEST Mon 6 Apr");
  // Brisbane has no DST: the same instants keep a fixed UTC+10 offset.
  assert.equal(isoToDateInput("2026-10-04T13:00:00.000Z", "Australia/Brisbane"), "2026-10-04");
});

test("confirmed date round trip: the payload date is UTC midnight of the confirmed day and displays as that day in every Australian zone", () => {
  for (const zone of ["Australia/Brisbane", "Australia/Sydney", "Australia/Adelaide", "Australia/Darwin", "Australia/Perth", "Australia/Hobart"]) {
    for (const day of ["2026-01-15", "2026-04-05", "2026-04-06", "2026-10-04", "2026-10-05", "2026-12-31"]) {
      const iso = dateInputToIso(day)!;
      assert.equal(iso, `${day}T00:00:00.000Z`);
      assert.equal(isoToDateInput(iso, zone), day, `${zone}: ${day} displays as the same day`);
    }
  }
});

test("an Australian pre-fill still requires explicit confirmation, and only the confirmed day is sent", () => {
  const suggested = candidate({ suggestedDueAt: "2026-09-24T23:00:00.000Z" });
  let drafts = createFollowupDrafts([suggested], "Australia/Brisbane");
  const key = followupKey(suggested);
  assert.equal(drafts[key]!.dueDate, "2026-09-25", "Brisbane agent sees Friday 25 September");
  assert.equal(drafts[key]!.confirmedDueDate, null);
  drafts = { ...drafts, [key]: { ...drafts[key]!, selected: true } };
  assert.deepEqual(buildProposePayload([suggested], drafts, false).items, [], "selected but unconfirmed sends nothing");
  drafts = { ...drafts, [key]: setDraftDueDateConfirmed(drafts[key]!, true) };
  assert.deepEqual(buildProposePayload([suggested], drafts, false).items, [
    { itemType: suggested.itemType, itemId: suggested.itemId, dueAt: "2026-09-25T00:00:00.000Z" },
  ]);
  const merged = mergeFollowupDrafts({}, [suggested], "Australia/Sydney");
  assert.equal(merged[key]!.dueDate, "2026-09-25", "merge applies the same zone rule");
});

test("an unrecognised time zone falls back to the agent's zone instead of throwing", () => {
  for (const iso of ["2026-10-01T00:00:00.000Z", "2026-09-30T23:30:00.000Z", "2026-10-01T12:00:00.000Z"]) {
    assert.equal(isoToDateInput(iso, "Not/AZone"), isoToDateInput(iso), "fallback is the agent's own zone");
    assert.equal(isoToDateInput(iso, ""), isoToDateInput(iso));
  }
});

test("a suggested due date is pre-filled but never counts as confirmed", () => {
  const drafts = createFollowupDrafts([candidate({ suggestedDueAt: "2026-10-01T00:00:00.000Z" })], "Australia/Brisbane");
  const draft = drafts[followupKey({ itemType: "COMMITMENT", itemId: "c-1" })]!;
  assert.equal(draft.dueDate, "2026-10-01");
  assert.equal(draft.confirmedDueDate, null);
  assert.equal(draft.selected, false);
  assert.equal(isDraftDueDateConfirmed(draft), false);
  assert.equal(isDraftReady(candidate(), { ...draft, selected: true }, false), false, "selected + pre-filled is still not ready");
});

test("confirmation is explicit, applies to the shown date only, and is cleared when the date changes", () => {
  let draft: FollowupDraft = { selected: true, dueDate: "2026-10-01", confirmedDueDate: null };
  draft = setDraftDueDateConfirmed(draft, true);
  assert.equal(isDraftDueDateConfirmed(draft), true);
  draft = setDraftDueDate(draft, "2026-10-02");
  assert.equal(isDraftDueDateConfirmed(draft), false, "changing the date requires a fresh confirmation");
  draft = setDraftDueDateConfirmed(draft, true);
  assert.equal(draft.confirmedDueDate, "2026-10-02");
  draft = setDraftDueDateConfirmed(draft, false);
  assert.equal(isDraftDueDateConfirmed(draft), false);
  assert.equal(isDraftDueDateConfirmed(setDraftDueDateConfirmed({ selected: true, dueDate: "", confirmedDueDate: null }, true)), false,
    "an empty/invalid date cannot be confirmed");
});

test("buildProposePayload includes only selected, explicitly confirmed, proposable items", () => {
  const candidates = [
    candidate({ itemId: "confirmed" }),
    candidate({ itemId: "prefilled-unconfirmed", suggestedDueAt: "2026-10-03T00:00:00.000Z" }),
    candidate({ itemId: "unselected" }),
    candidate({ itemType: "FOLLOWUP", itemId: "followup-confirmed" }),
    candidate({ itemId: "already-open", canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request() } }),
  ];
  const drafts: Record<string, FollowupDraft> = {
    ...createFollowupDrafts(candidates),
    "COMMITMENT:confirmed": confirmedDraft("2026-10-01"),
    "COMMITMENT:prefilled-unconfirmed": { selected: true, dueDate: "2026-10-03", confirmedDueDate: null },
    "COMMITMENT:unselected": confirmedDraft("2026-10-04", false),
    "FOLLOWUP:followup-confirmed": confirmedDraft("2026-10-05"),
    "COMMITMENT:already-open": confirmedDraft("2026-10-06"),
  };
  assert.deepEqual(buildProposePayload(candidates, drafts, false), {
    items: [
      { itemType: "COMMITMENT", itemId: "confirmed", dueAt: "2026-10-01T00:00:00.000Z" },
      { itemType: "FOLLOWUP", itemId: "followup-confirmed", dueAt: "2026-10-05T00:00:00.000Z" },
    ],
  });
});

test("the propose payload never carries description, partyId, brokerageId or any other field", () => {
  const candidates = [candidate({ itemId: "a" }), candidate({ itemType: "FOLLOWUP", itemId: "b" })];
  const drafts = { "COMMITMENT:a": confirmedDraft("2026-10-01"), "FOLLOWUP:b": confirmedDraft("2026-10-02") };
  const payload = buildProposePayload(candidates, drafts, false);
  assert.deepEqual(Object.keys(payload), ["items"]);
  for (const item of payload.items) {
    assert.deepEqual(Object.keys(item).sort(), ["dueAt", "itemId", "itemType"]);
  }
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["description", "partyId", "brokerageId", "text", "actorType", "Send the appraisal pack"]) {
    assert.equal(serialized.includes(forbidden), false, `payload must not contain ${forbidden}`);
  }
});

test("consent-blocked responses disable proposing entirely", () => {
  const candidates = [candidate({ consentBlocked: true, canPropose: false })];
  const drafts = { "COMMITMENT:c-1": confirmedDraft("2026-10-01") };
  assert.equal(canProposeCandidate(candidates[0]!, true), false);
  assert.equal(proposeDisabledReason(candidates, drafts, true), CONSENT_BLOCKED_MESSAGE);
  assert.deepEqual(buildProposePayload(candidates, drafts, true), { items: [] });
  // Even if a stale candidate still says canPropose, the response-level flag wins.
  assert.deepEqual(buildProposePayload([candidate()], drafts, true), { items: [] });
  assert.equal(followupErrorMessage({ status: 409, code: "CONSENT_WITHDRAWN" }), CONSENT_BLOCKED_MESSAGE);
});

test("proposeDisabledReason explains exactly why the propose button is disabled", () => {
  const candidates = [candidate()];
  assert.equal(proposeDisabledReason(candidates, createFollowupDrafts(candidates), false), "Select at least one follow-up to propose.");
  assert.equal(
    proposeDisabledReason(candidates, { "COMMITMENT:c-1": { selected: true, dueDate: "2026-10-01", confirmedDueDate: null } }, false),
    "Confirm the due date for each selected follow-up.",
  );
  assert.equal(proposeDisabledReason(candidates, { "COMMITMENT:c-1": confirmedDraft("2026-10-01") }, false), null);
  assert.equal(
    proposeDisabledReason([candidate({ canPropose: false, existingProposal: { visibility: "ALREADY_PROPOSED" } })], {}, false),
    "Every follow-up from this call has already been proposed.",
  );
});

test("mergeFollowupDrafts keeps local edits and never auto-confirms new items", () => {
  const first = [candidate({ itemId: "a" })];
  const current = { "COMMITMENT:a": confirmedDraft("2026-10-01") };
  const merged = mergeFollowupDrafts(current, [...first, candidate({ itemId: "b", suggestedDueAt: "2026-10-09T00:00:00.000Z" })], "Australia/Brisbane");
  assert.deepEqual(merged["COMMITMENT:a"], current["COMMITMENT:a"]);
  assert.deepEqual(merged["COMMITMENT:b"], { selected: false, dueDate: "2026-10-09", confirmedDueDate: null });
});

test("status labels cover proposed, expired, completed and already-proposed items", () => {
  assert.deepEqual(followupStatus(candidate(), NOW), { label: "Not proposed yet", tone: "neutral" });
  assert.deepEqual(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request() } }), NOW),
    { label: "Proposed — awaiting approval (expires in 12h)", tone: "warning" },
  );
  assert.deepEqual(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request({ expiresAt: "2026-09-18T23:00:00.000Z" }) } }), NOW),
    { label: "Proposal expired — refresh to propose again", tone: "danger" },
  );
  assert.deepEqual(
    followupStatus(candidate({ latestProposalStatus: "EXPIRED" }), NOW),
    { label: "Previous proposal expired — you can propose it again", tone: "danger" },
  );
  assert.deepEqual(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request({ status: "COMPLETED" }) } }), NOW),
    { label: "Commitment created", tone: "success" },
  );
  assert.deepEqual(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "ALREADY_PROPOSED" } }), NOW),
    { label: "Already proposed by another user", tone: "neutral" },
  );
  assert.equal(followupStatus(candidate({ latestProposalStatus: "REJECTED" }), NOW).label, "Previous proposal rejected — you can propose it again");
  assert.equal(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request({ status: "APPROVED" }) } }), NOW).label,
    "Approved — commitment not created yet",
  );
});

test("a request whose commitment may already exist (late completion after recovery) is labelled 'check Commitments', never 'propose again'", () => {
  const mayExist = followupStatus(candidate({
    canPropose: false,
    existingProposal: { visibility: "VISIBLE", actionRequest: request({ status: "FAILED", commitmentMayExist: true }) },
  }), NOW);
  assert.deepEqual(mayExist, { label: "Commitment may already exist — check Commitments", tone: "warning" });
  assert.deepEqual(
    followupStatus(candidate({ canPropose: false, latestProposalStatus: "COMMITMENT_MAY_EXIST" }), NOW),
    { label: "Commitment may already exist — check Commitments", tone: "warning" },
  );
  assert.doesNotMatch(mayExist.label, /propose it again/);
  // A FAILED request with no possible side effect keeps the retry copy.
  assert.equal(
    followupStatus(candidate({ latestProposalStatus: "FAILED" }), NOW).label,
    "Previous proposal didn’t complete — you can propose it again",
  );
  assert.equal(
    followupStatus(candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request({ status: "COMPLETED", commitmentMayExist: true }) } }), NOW).label,
    "Commitment created",
  );
});

test("an already-proposed-by-another-user item never exposes any proposal details or card", () => {
  const other = candidate({ canPropose: false, existingProposal: { visibility: "ALREADY_PROPOSED" } });
  assert.equal(cardRequestForCandidate(other, {}), null);
});

test("cards render for open visible proposals and for proposals from this session", () => {
  const open = candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request() } });
  assert.equal(cardRequestForCandidate(open, {})?.actionRequestId, 501);
  const completed = candidate({ canPropose: false, existingProposal: { visibility: "VISIBLE", actionRequest: request({ status: "COMPLETED" }) } });
  assert.equal(cardRequestForCandidate(completed, {}), null);
  const local = retainOutcomes({}, [
    { itemType: "COMMITMENT", itemId: "c-1", status: "PROPOSED", actionRequest: request({ actionRequestId: 777 }) },
    { itemType: "FOLLOWUP", itemId: "x", status: "ALREADY_PROPOSED", actionRequest: null },
  ]);
  assert.deepEqual(Object.keys(local), ["COMMITMENT:c-1"]);
  assert.equal(cardRequestForCandidate(completed, local)?.actionRequestId, 777);
});

test("summarizeProposeOutcomes reports each outcome status and that nothing is created yet", () => {
  assert.equal(
    summarizeProposeOutcomes([
      { itemType: "COMMITMENT", itemId: "a", status: "PROPOSED", actionRequest: request() },
      { itemType: "COMMITMENT", itemId: "b", status: "EXISTING", actionRequest: request() },
      { itemType: "FOLLOWUP", itemId: "c", status: "ALREADY_PROPOSED", actionRequest: null },
    ]),
    "1 proposal created — awaiting your approval; 1 already proposed; 1 already proposed by another user. Nothing is created until you approve.",
  );
});

test("follow-up error codes map to specific agent-facing messages", () => {
  assert.match(followupErrorMessage({ status: 409, code: "WRONG_STATE" }), /saved call review/);
  assert.match(followupErrorMessage({ status: 403, code: "ENTITLEMENT_REQUIRED" }), /Brokerage Administrator/);
  assert.match(followupErrorMessage({ status: 403, code: "ACCESS_DENIED" }), /can’t propose follow-ups/);
  assert.match(followupErrorMessage({ status: 403, code: "POLICY_DENIED" }), /blocked by policy/);
  assert.match(followupErrorMessage({ status: 404, code: "NOT_FOUND" }), /no longer available/);
  assert.match(followupErrorMessage({ status: 400, code: "INVALID_INPUT" }), /due dates/);
  assert.match(followupErrorMessage({ status: 503, code: "AUDIT_FAILURE" }), /Nothing was proposed/);
  assert.match(followupErrorMessage({ status: 503, code: "AUDIT_INCOMPLETE" }), /won’t create duplicates/);
  assert.equal(followupErrorMessage({ status: 500, friendly: "Server said no" }), "Server said no");
});

test("view adapter labels call-review provenance and uses the approved text, never ids as evidence", () => {
  const view = viewFromFollowupRequest(request({ description: null }), candidate({ itemType: "FOLLOWUP" }), { transcriptionId: 71, contactName: "Jo Citizen" });
  assert.equal(view.summary, "Send the appraisal pack");
  assert.equal(view.contactName, "Jo Citizen");
  assert.equal(view.evidenceSummary, null);
  assert.deepEqual(view.provenance, { source: "call_review", transcriptionId: 71, itemType: "FOLLOWUP", itemId: "c-1" });
});

test("invalidation covers follow-ups, pending proposals, the contact and activities", () => {
  assert.deepEqual(followupInvalidationKeys(12), [["grow-call-followups"], ["grow-pending-commitments"], ["grow-contact", 12], ["grow-activities"]]);
});

test("mergeRetainedProposals keeps acted-on cards after the refreshed list drops them", () => {
  const merged = mergeRetainedProposals([{ actionRequestId: 1 }, { actionRequestId: 2 }], [{ actionRequestId: 2 }, { actionRequestId: 3 }]);
  assert.deepEqual(merged.map((item) => item.actionRequestId), [1, 2, 3]);
});
