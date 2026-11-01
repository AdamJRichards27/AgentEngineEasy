import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMobileContactLayout, type MobileContactOptions } from "../../minimal/mobile/mobileContactLayout";
import { HISTORY_VISIBLE } from "../../minimal/mobile/mobilePeopleConfig";
import type { GrowContact360 } from "../growContact360";
import type { GrowContactability, GrowContactabilityChannel, GrowContactabilityStatus } from "../contactability";

// AE Mobile (CC Task #64, M4): the phone Contact 360 layout, built from the existing payload shape.

const NOW = new Date("2026-11-02T09:00:00Z");
const OPTS: MobileContactOptions = { now: NOW, canLog: true };
const OVERDUE = "2026-10-30T00:00:00Z";
const LATER = "2026-11-06T00:00:00Z";

function channel(status: GrowContactabilityStatus, over: Partial<GrowContactabilityChannel> = {}): GrowContactabilityChannel {
  return {
    channel: "PHONE_CALL", status, reasonCode: status === "ELIGIBLE" ? "EXPRESS_CONSENT_ELIGIBLE" : "POLICY_INVALID_WINDOW",
    decision: { recorded: false, decision: status, reasonCode: "X", reasonCodes: [], jurisdiction: null, policyVersion: null, purpose: "p", scope: "s", streamRecorded: false, evaluatedAt: "" },
    lastRecordedDecision: null, consentState: "UNKNOWN", consent: null, streams: [], dncrStatus: "NOT_CHECKED", dncr: null, suppressed: false, suppression: null, ...over,
  };
}
function consent(status: GrowContactabilityStatus, ch: GrowContactabilityChannel = channel(status), over: Partial<GrowContactability> = {}): GrowContactability {
  return {
    evaluatedAt: "2026-11-02T09:00:00Z", status, statusReasonCode: status === "BLOCKED" ? "SUPPRESSED" : "POLICY_INVALID_WINDOW", hasConsentRecords: true,
    awaitingPolicyApproval: status !== "ELIGIBLE", policies: [], channels: [ch], activeSuppressions: [], history: [], historyTruncated: false, ...over,
  };
}
function contact(o: Partial<GrowContact360> = {}): GrowContact360 {
  return {
    contact: { id: 12, partyType: "Person", firstName: "Maya", middleName: null, lastName: "Okafor", organisationName: null, displayName: "Maya Okafor", email: "maya@example.com", mobile: "0491 570 156", residentialAddress: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    assignedAgentUserId: null, roles: ["Seller", "PastClient"], householdRelationships: [], properties: [], opportunities: [], activities: [], commitments: [], timeline: [],
    intelligence: { roles: [], relatedPropertyCount: 0, mostRecentInteractionAt: null, daysSinceLastInteraction: null, nextFollowUpAt: null, nextFollowUpDescription: null, activeOpportunityCount: 0, recentActivityCount: 0, outstandingCommitmentCount: 0, relationshipAgeDays: null },
    contactability: consent("REVIEW_REQUIRED"), ...o,
  };
}
const commitment = (id: number, description: string, dueAt: string, over: Partial<GrowContact360["commitments"][number]> = {}) => ({ id, description, dueAt, status: "Open", propertyId: null, opportunityId: null, completedAt: null, cancelledAt: null, cancelReason: null, ...over });
const layout = (data: GrowContact360, o: Partial<MobileContactOptions> = {}) => buildMobileContactLayout(data, { ...OPTS, ...o });

test("tap to call: a prominent call that names the number, with no consent prompt, notice or card", () => {
  const l = layout(contact());
  assert.deepEqual(l.call.options.map((o) => [o.text, o.href]), [["Call mobile 0491 570 156", "tel:0491570156"]]);
  assert.equal("consent" in l, false, "the layout has no consent card at all");
  assert.equal("restriction" in l.call, false);
});

test("FINAL DIRECTIVE: every consent state gets a Call button: missing, review, eligible, blocked, withdrawn, suppressed, on the register, unreadable", () => {
  const states = [
    ["no block at all", null],
    ["review required (no consent recorded)", consent("REVIEW_REQUIRED")],
    ["eligible", consent("ELIGIBLE")],
    ["do not contact (overall blocked)", consent("BLOCKED")],
    ["phone channel blocked", consent("REVIEW_REQUIRED", channel("BLOCKED", { reasonCode: "WITHDRAWN" }))],
    ["consent withdrawn", consent("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { consentState: "WITHDRAWN" }))],
    ["suppressed", consent("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { suppressed: true }))],
    ["Do Not Call Register listed", consent("REVIEW_REQUIRED", channel("REVIEW_REQUIRED", { dncrStatus: "LISTED" }))],
    ["everything at once", consent("BLOCKED", channel("BLOCKED", { suppressed: true, dncrStatus: "LISTED", consentState: "WITHDRAWN" }))],
  ] as const;
  for (const [label, c] of states) {
    const l = layout(contact({ contactability: c as never }));
    assert.deepEqual(l.call.options.map((o) => o.href), ["tel:0491570156"], label);
    assert.equal("consent" in l, false, label);
  }
});

test("no number, or one that cannot be dialled, gives no call button and no warning", () => {
  for (const m of [null, "", "   ", "12345", "n/a", "0000000"]) {
    const call = layout(contact({ contact: { ...contact().contact, mobile: m } })).call;
    assert.deepEqual(call.options, [], String(m));
  }
  assert.equal(layout(contact({ contact: { ...contact().contact, mobile: "12345" } })).call.unusable, true);
  assert.equal(layout(contact({ contact: { ...contact().contact, mobile: null } })).call.unusable, false);
});

test("the next step: an overdue commitment first, then the next due, with Mark done and Reschedule", () => {
  const l = layout(contact({ commitments: [commitment(2, "Send comparable sales", LATER), commitment(1, "Call back", OVERDUE), commitment(3, "Already done", OVERDUE, { status: "Completed" })] }));
  assert.equal(l.nextStep.kind, "commitment");
  assert.equal(l.nextStep.title, "Call back");
  assert.equal(l.nextStep.when, "Overdue");
  assert.equal(l.nextStep.overdue, true);
  assert.equal(l.nextStep.commitmentId, 1);
  assert.deepEqual(l.nextStep.primary, { kind: "complete", label: "Mark done" });
  assert.deepEqual(l.nextStep.secondary, { kind: "reschedule", label: "Reschedule" });
  const later = layout(contact({ commitments: [commitment(2, "Send comparable sales", LATER)] }));
  assert.equal(later.nextStep.overdue, false);
  assert.match(later.nextStep.when ?? "", /Nov 2026/);
});

test("the next step falls back to an open opportunity, then the intelligence follow-up, then nothing", () => {
  const opp = layout(contact({ opportunities: [{ id: 5, opportunityType: "Appraisal", status: "Open", stage: "Qualified", reason: null, nextActionDueAt: OVERDUE, recommendedNextAction: "Send the appraisal", propertyId: null }, { id: 6, opportunityType: "Sale", status: "Lost", stage: "x", reason: null, nextActionDueAt: null, recommendedNextAction: "Ignore", propertyId: null }] }));
  assert.equal(opp.nextStep.kind, "opportunity");
  assert.equal(opp.nextStep.title, "Send the appraisal");
  assert.equal(opp.nextStep.overdue, true);
  assert.deepEqual(opp.nextStep.primary, { kind: "full-record", label: "Open the full record to update it" }, "no verified phone route sets an opportunity's follow-up");
  const intel = layout(contact({ intelligence: { ...contact().intelligence, nextFollowUpAt: LATER, nextFollowUpDescription: "Check in" } }));
  assert.equal(intel.nextStep.kind, "follow-up");
  assert.equal(intel.nextStep.title, "Check in");
  assert.equal(intel.nextStep.primary, null);
  const none = layout(contact());
  assert.equal(none.nextStep.kind, "none");
  assert.equal(none.nextStep.title, "No next step set");
  assert.deepEqual(none.nextStep.primary, { kind: "add-commitment", label: "Add a commitment" });
});

test("without grow.activities.manage no write button is offered; only the full record", () => {
  const data = contact({ commitments: [commitment(1, "Call back", OVERDUE), commitment(2, "Send it", LATER)] });
  const l = layout(data, { canLog: false });
  assert.equal(l.canLog, false);
  assert.equal(l.nextStep.primary, null);
  assert.equal(l.nextStep.secondary, null);
  assert.equal(layout(contact(), { canLog: false }).nextStep.primary, null);
  assert.equal(l.fullRecordHref, "/grow/contacts/12?view=full");
});

test("commitments: the next step is not listed again, overdue first, with property context, and counts", () => {
  const data = contact({
    properties: [{ relationshipId: 1, propertyId: 77, propertyAddress: "7 Jacaranda Street", relationshipType: "Owner", role: null, status: "Active", isPrimary: true, validFrom: "x", validTo: null }],
    commitments: [commitment(1, "Later", LATER), commitment(2, "Over B", "2026-10-31T00:00:00Z", { propertyId: 77 }), commitment(3, "Over A", OVERDUE), commitment(4, "Done", OVERDUE, { status: "Completed" }), commitment(5, "Dropped", OVERDUE, { status: "Cancelled" })],
  });
  const l = layout(data);
  assert.equal(l.nextStep.commitmentId, 3, "the most overdue is the next step");
  assert.deepEqual(l.commitments.map((c) => c.id), [2, 1], "the rest, overdue first");
  assert.equal(l.openCommitmentCount, 3);
  assert.equal(l.closedCommitmentCount, 2);
  assert.equal(l.commitments[0].context, "7 Jacaranda Street");
  assert.match(l.commitments[0].dueText, /^Overdue · was due /);
  assert.match(l.commitments[1].dueText, /^Due /);
});

test("properties: only active links, one address for everyone, relationships in plain words with the role", () => {
  const rel = (id: number, propertyId: number | null, status: string, relationshipType = "owner", role: string | null = null) => ({ relationshipId: id, propertyId, propertyAddress: propertyId ? `${id} Main St` : null, relationshipType, role, status, isPrimary: id === 1, validFrom: "x", validTo: null });
  const data = contact({ properties: [rel(1, 5, "Active", "co_owner"), rel(2, 6, "Historical"), rel(3, null, "Active"), rel(4, 8, "Active", "related_party", "Executor"), rel(5, 9, "Active", "prospective_seller"), rel(6, 10, "Active", "owner", "Owner"), rel(7, 11, "Active", "some_new_type")] });
  const rows = layout(data).properties;
  assert.deepEqual(rows.map((p) => p.key), [1, 3, 4, 5, 6, 7], "an ended (Historical) link is not shown");
  assert.equal(rows[0].href, "/grow/properties/5", "the Grow property page, as search opens it");
  assert.equal(rows[0].primary, true);
  assert.equal(rows[1].href, null);
  assert.equal(rows[1].label, "Not linked to a property");
  assert.deepEqual(rows.map((p) => p.relationship), ["Co-owner", "Owner", "Related party · Executor", "Future seller", "Owner", "Some new type"]);
  assert.equal(rows.some((p) => /_/.test(p.relationship)), false, "never the stored snake_case value");
});

test("history: newest first, six shown, the rest behind Show all, in plain words", () => {
  const events = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, type: i % 2 ? "call" : "commitment_created", occurredAt: `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00Z`, summary: `Event ${i}`, propertyId: null, propertyLabel: i === 8 ? "7 Main St" : null, opportunityId: null }));
  const l = layout(contact({ timeline: events }));
  assert.equal(HISTORY_VISIBLE, 6);
  assert.equal(l.history.length, 6);
  assert.equal(l.historyHiddenCount, 3);
  assert.equal(l.history[0].text, "Event 8", "newest first");
  assert.equal(l.history[0].context, "7 Main St");
  assert.deepEqual([...new Set(l.history.map((h) => h.kind))].sort(), ["Call", "Commitment created"]);
  const all = layout(contact({ timeline: events }), { expandedHistory: true });
  assert.equal(all.history.length, 9);
  assert.equal(all.historyHiddenCount, 0);
});

test("identity: roles in plain words, initials, an email only when there is one, no property count", () => {
  const l = layout(contact());
  assert.deepEqual(l.roleChips, ["Seller", "Past client"]);
  assert.equal(l.initials, "MO");
  assert.equal(l.email, "maya@example.com");
  assert.equal(layout(contact({ contact: { ...contact().contact, email: "  " } })).email, null);
  assert.equal(layout(contact({ contact: { ...contact().contact, displayName: " " } })).name, "Unnamed contact");
  assert.doesNotMatch(JSON.stringify(l), /relatedPropertyCount|linked propert/i);
});

test("pure: a frozen payload is not changed", () => {
  const data = contact({ commitments: [commitment(1, "A", OVERDUE)], timeline: [{ id: "e", type: "note", occurredAt: OVERDUE, summary: "s", propertyId: null, propertyLabel: null, opportunityId: null }] });
  const copy = JSON.parse(JSON.stringify(data));
  const deepFreeze = (v: unknown): unknown => { if (v && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
  deepFreeze(data);
  assert.doesNotThrow(() => layout(data));
  assert.deepEqual(data, copy);
});
