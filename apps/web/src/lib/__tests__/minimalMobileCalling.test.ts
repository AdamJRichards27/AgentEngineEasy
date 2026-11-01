import { test } from "node:test";
import assert from "node:assert/strict";
import { callPlan, callRestriction, logCallHref, markHidden, numbersOf, returned, startCall, usableNumber, HIDE_WITHIN_MS, MIN_AWAY_MS, OFFER_WINDOW_MS } from "../../minimal/mobile/mobileCalling";
import type { GrowContactability, GrowContactabilityChannel, GrowContactabilityStatus } from "../contactability";

// AE Mobile (CC Task #64, M4/M5): Tap-to-Call rules. The dialler only; nothing recorded; only an explicit restriction stops a call.

function channel(status: GrowContactabilityStatus, over: Partial<GrowContactabilityChannel> = {}): GrowContactabilityChannel {
  return { channel: "PHONE_CALL", status, reasonCode: "POLICY_INVALID_WINDOW", decision: { recorded: false, decision: status, reasonCode: "X", reasonCodes: [], jurisdiction: null, policyVersion: null, purpose: "p", scope: "s", streamRecorded: false, evaluatedAt: "" }, lastRecordedDecision: null, consentState: "UNKNOWN", consent: null, streams: [], dncrStatus: "NOT_CHECKED", dncr: null, suppressed: false, suppression: null, ...over };
}
function ctab(status: GrowContactabilityStatus, ch: GrowContactabilityChannel | null = channel(status), reason = "POLICY_INVALID_WINDOW"): GrowContactability {
  return { evaluatedAt: "", status, statusReasonCode: reason, hasConsentRecords: false, awaitingPolicyApproval: status !== "ELIGIBLE", policies: [], channels: ch ? [ch] : [], activeSuppressions: [], history: [], historyTruncated: false } as GrowContactability;
}

test("a usable number: 6 to 15 digits, a leading + kept, symbols dropped, never one repeated digit", () => {
  assert.deepEqual(usableNumber("0491 570 156"), { display: "0491 570 156", dial: "0491570156" });
  assert.deepEqual(usableNumber("+61 491 570 156"), { display: "+61 491 570 156", dial: "+61491570156" });
  assert.deepEqual(usableNumber("(07) 5555-1234"), { display: "(07) 5555-1234", dial: "0755551234" });
  assert.deepEqual(usableNumber("  0491   570   156 "), { display: "0491 570 156", dial: "0491570156" });
  for (const bad of [null, undefined, "", "   ", "12345", "n/a", "unknown", "0000000", "1111111111", "1234567890123456", "abc"]) assert.equal(usableNumber(bad), null, String(bad));
});

test("an extension or a note is never dialled into the number", () => {
  assert.deepEqual(usableNumber("0491 570 156 ext 12"), { display: "0491 570 156", dial: "0491570156" });
  assert.deepEqual(usableNumber("07 5555 1234 x 99"), { display: "07 5555 1234", dial: "0755551234" });
  assert.equal(usableNumber("call after 5pm"), null);
});

test("no consent record is not a restriction: the call is offered with no prompt, in the pilot state and when cleared", () => {
  for (const c of [ctab("REVIEW_REQUIRED"), ctab("ELIGIBLE"), ctab("REVIEW_REQUIRED", null)]) {
    assert.equal(callRestriction(c), null);
    const plan = callPlan(numbersOf({ mobile: "0491 570 156" }), c, "Maya Okafor");
    assert.deepEqual(plan.options.map((o) => o.href), ["tel:0491570156"]);
    assert.equal(plan.restriction, null);
  }
});

test("a restriction recorded afterwards stops the call, in the consent engine's words", () => {
  assert.match(callRestriction(ctab("BLOCKED", channel("BLOCKED"), "SUPPRESSED")) ?? "", /^Do not contact\. .*explicit instruction/);
  assert.match(callRestriction(ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { suppressed: true }))) ?? "", /explicit instruction/);
  assert.match(callRestriction(ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { dncrStatus: "LISTED" }))) ?? "", /Do Not Call Register/);
  assert.match(callRestriction(ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { consentState: "WITHDRAWN" }))) ?? "", /withdrew consent/);
  assert.match(callRestriction(ctab("REVIEW_REQUIRED", channel("BLOCKED", { reasonCode: "WITHDRAWN" }))) ?? "", /withdrew consent/);
  for (const c of [ctab("BLOCKED", null, "SUPPRESSED"), ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { suppressed: true })), ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { dncrStatus: "LISTED" })), ctab("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { consentState: "WITHDRAWN" }))]) {
    assert.deepEqual(callPlan([{ label: "Mobile", number: "0491 570 156" }], c).options, [], "no call button");
  }
});

test("when the answer cannot be read, the call is not offered", () => {
  for (const c of [null, undefined]) {
    assert.match(callRestriction(c) ?? "", /couldn’t check/);
    assert.deepEqual(callPlan([{ label: "Mobile", number: "0491 570 156" }], c).options, []);
  }
});

test("every button names the number it will dial; several numbers give several buttons; the same number twice is one", () => {
  const two = callPlan([{ label: "Mobile", number: "0491 570 156" }, { label: "Work", number: "07 5555 1234" }], ctab("ELIGIBLE"), "Maya Okafor");
  assert.deepEqual(two.options.map((o) => o.text), ["Call mobile 0491 570 156", "Call work 07 5555 1234"]);
  assert.deepEqual(two.options.map((o) => o.href), ["tel:0491570156", "tel:0755551234"]);
  assert.deepEqual(two.options.map((o) => o.aria), ["Call Maya Okafor, mobile 0491 570 156", "Call Maya Okafor, work 07 5555 1234"]);
  const dupe = callPlan([{ label: "Mobile", number: "0491 570 156" }, { label: "Work", number: "0491570156" }], ctab("ELIGIBLE"));
  assert.equal(dupe.options.length, 1);
  assert.equal(callPlan([{ label: "Mobile", number: "0491 570 156" }, { label: "Work", number: "n/a" }], ctab("ELIGIBLE")).options.length, 1, "an unusable one is simply not offered");
});

test("no usable number: no button; whether a number is recorded at all is reported", () => {
  assert.deepEqual(callPlan(numbersOf({ mobile: null }), ctab("ELIGIBLE")), { options: [], restriction: null, unusable: false });
  assert.deepEqual(callPlan(numbersOf({ mobile: "12345" }), ctab("ELIGIBLE")), { options: [], restriction: null, unusable: true });
  assert.deepEqual(numbersOf({ mobile: "0491 570 156" }), [{ label: "Mobile", number: "0491 570 156" }], "the record holds one number today");
});

// ── after the call ───────────────────────────────────────────────────────

const base = { partyId: 12, name: "Maya Okafor", label: "Mobile", display: "0491 570 156", startedAt: 1_000 };

test("Log call is offered only after the agent was really away: hidden soon after the tap, then back after a few seconds", () => {
  let c = markHidden(startCall(base), 1_000 + 800);
  assert.equal(c?.hiddenAt, 1_800);
  assert.deepEqual(returned(c, 1_800 + MIN_AWAY_MS).offer?.partyId, 12);
  assert.equal(returned(c, 1_800 + MIN_AWAY_MS - 1).offer, null, "a dismissed dialler prompt is not a call");
  assert.equal(returned(c, 1_800 + MIN_AWAY_MS).keep, null, "one offer per tap");
  c = markHidden(startCall(base), 1_000 + HIDE_WITHIN_MS + 1);
  assert.equal(c, null, "the page was hidden for another reason, long after the tap");
  assert.equal(returned(startCall(base), 5_000).offer, null, "never hidden: nothing to offer");
  assert.notEqual(returned(startCall(base), 5_000).keep, null, "still waiting to see if the dialler takes over");
});

test("a stale offer is dropped, and returning with nothing pending offers nothing", () => {
  const c = markHidden(startCall(base), 1_100);
  assert.equal(returned(c, 1_100 + OFFER_WINDOW_MS + 5_000).offer, null);
  assert.deepEqual(returned(null, 10), { offer: null, keep: null });
  assert.equal(markHidden(null, 5), null);
});

test("Log call goes to Contact 360 with the call form opened, never straight to a saved record", () => {
  assert.equal(logCallHref(12), "/grow/contacts/12?log=call");
});
