import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionTypeLabel,
  priorityLabel,
  priorityPillClass,
  formatWhen,
  canOfferChannel,
  contactabilityNotice,
  hasLinkedContact,
  rankExplanationLines,
  rankSummaryLine,
  signalWithholdingNotice,
  unlinkedContactNotice,
  type GrowTodayAction,
} from "../growToday";

// AE GROW Priority 1 — Daily Command Centre: pure-logic tests for the frontend display helpers.
// No React, no network — matches the convention lib/__tests__/productNav.test.ts already
// established for pure Grow-related logic on the web app.
//
// AE GROW "Brokerage-wide Signal Sweep" stage 3 — the file now also covers the
// two display rules that carry real product guarantees: a channel affordance
// is never offered for a contact who must not be contacted (and the guard
// fails closed), and a rank score is never renderable without the factors
// that produced it.

test("priorityLabel maps every priority to a human-readable label", () => {
  assert.equal(priorityLabel("DoNow"), "Do Now");
  assert.equal(priorityLabel("DoToday"), "Do Today");
  assert.equal(priorityLabel("KeepWarm"), "Keep Warm");
});

test("priorityPillClass never conveys urgency by colour alone -- DoNow/DoToday get a distinct tone, KeepWarm stays neutral", () => {
  assert.equal(priorityPillClass("DoNow"), "pill pill-danger");
  assert.equal(priorityPillClass("DoToday"), "pill pill-warning");
  assert.equal(priorityPillClass("KeepWarm"), "pill");
});

test("formatWhen returns null for a null input and a readable date string otherwise", () => {
  assert.equal(formatWhen(null), null);
  const formatted = formatWhen("2026-09-08T00:00:00.000Z");
  assert.ok(formatted !== null && formatted.length > 0);
  assert.ok(formatted !== null && formatted.includes("2026"));
});

/* ---------------------------------------------------------------------
 * Stage 3 fixtures.
 * -----------------------------------------------------------------*/

function action(overrides: Partial<GrowTodayAction> = {}): GrowTodayAction {
  return {
    id: "signal:1",
    type: "property_intelligence_signal",
    priority: "KeepWarm",
    partyId: 42,
    contactName: "Olive Owner",
    contactEmail: "olive@example.com",
    contactMobile: "+61400000000",
    relationshipType: null,
    propertyId: 7,
    propertyLabel: "1 Test St",
    opportunityId: null,
    appraisalId: null,
    commitmentId: null,
    reason: "Stored explanation.",
    recommendedAction: "Review this signal.",
    dueAt: null,
    lastActivityAt: null,
    availableActions: [
      { action: "add_note" },
      { action: "view_property", propertyId: 7 },
      { action: "email", partyId: 42 },
      { action: "sms", partyId: 42 },
      { action: "view_contact", partyId: 42 },
      { action: "ask_ae" },
    ],
    rankScore: 76,
    confidenceBand: "StrongIndicator",
    contactability: "contactable",
    contactabilityNote: null,
    whyItMatters: {
      headline: "They have owned this home for about 11 years.",
      talkingPoint: '"Would it be useful to know what it is worth today?"',
      caution: "AE has no information about this contact's private intentions.",
      confidenceBand: "StrongIndicator",
      confidenceBandLabel: "Strong indicator",
      factors: [
        { label: "Evidence strength: Strong indicator", detail: "AE's own assessment.", points: 40 },
        { label: "Owned for about 11 years", detail: "Tenure beyond the five-year floor.", points: 9 },
        { label: "Spoken to 2 days ago", detail: "Recent contact is on file.", points: -12 },
        { label: "A neutral factor", detail: "Contributed nothing.", points: 0 },
      ],
    },
    ...overrides,
  };
}

/* ---------------------------------------------------------------------
 * Consent display.
 * -----------------------------------------------------------------*/

test("stage 3 — a channel affordance is offered only when the contact is contactable, exists, has the channel on file, AND the server listed it", () => {
  assert.equal(canOfferChannel(action(), "email"), true);
  assert.equal(canOfferChannel(action(), "sms"), true);

  // The single most important case: a do-not-contact person is never offered
  // a channel, even if every other condition somehow still holds.
  const suppressed = action({
    contactability: "do_not_contact",
    contactabilityNote: "A do-not-contact listing is on file.",
  });
  assert.equal(canOfferChannel(suppressed, "email"), false, "a do-not-contact card must never offer Email");
  assert.equal(canOfferChannel(suppressed, "sms"), false, "a do-not-contact card must never offer SMS");

  // Fails closed on an unrecognised contactability value, so a future server
  // state this build has never heard of cannot accidentally enable outreach.
  const unknownState = action({ contactability: "quarantined" as never });
  assert.equal(canOfferChannel(unknownState, "email"), false, "an unrecognised contactability state must fail closed");

  // No contact at all (an observation-derived signal).
  assert.equal(canOfferChannel(action({ partyId: null }), "email"), false);
  // Channel not on file, including the whitespace-only case.
  assert.equal(canOfferChannel(action({ contactEmail: null }), "email"), false);
  assert.equal(canOfferChannel(action({ contactEmail: "   " }), "email"), false);
  assert.equal(canOfferChannel(action({ contactMobile: null }), "sms"), false);
  // The server did not list the action.
  assert.equal(canOfferChannel(action({ availableActions: [{ action: "ask_ae" }] }), "email"), false);
});

test("stage 3 — a do-not-contact card always renders a notice, using the server's own wording, and a contactable card renders none", () => {
  assert.equal(contactabilityNotice(action()), null);
  assert.equal(
    contactabilityNotice(action({ contactability: "do_not_contact", contactabilityNote: "Server wording." })),
    "Server wording.",
    "a consent decision is never re-worded in the frontend",
  );
  // A card can never be marked do_not_contact and still say nothing.
  const fallback = contactabilityNotice(action({ contactability: "do_not_contact", contactabilityNote: null }));
  assert.ok(typeof fallback === "string" && /must not be contacted/i.test(fallback));
});

test("stage 3 — hasLinkedContact / unlinkedContactNotice distinguish a person-anchored card from a property-anchored one", () => {
  assert.equal(hasLinkedContact(action()), true);
  assert.equal(unlinkedContactNotice(action()), null);

  const propertyOnly = action({ partyId: null, contactName: "1 Test St" });
  assert.equal(hasLinkedContact(propertyOnly), false);
  assert.match(
    unlinkedContactNotice(propertyOnly) ?? "",
    /No contact is linked/i,
    "the agent must be told why the contact actions are missing, not left guessing",
  );
});

/* ---------------------------------------------------------------------
 * Explainability display.
 * -----------------------------------------------------------------*/

test("stage 3 — the rank score is never renderable without its factors: a card with no explanation yields no lines and no summary", () => {
  const ruleAE = action({ whyItMatters: null, rankScore: 88, confidenceBand: null });
  assert.deepEqual(rankExplanationLines(ruleAE), [], "no explanation means render nothing, never a bare number");
  assert.equal(rankSummaryLine(ruleAE), null);
});

test("stage 3 — rankExplanationLines itemises each contributing factor with a sign, its label and its prose detail, and drops zero-weight noise", () => {
  const lines = rankExplanationLines(action());
  assert.equal(lines.length, 3, "a factor contributing nothing is not shown");
  assert.equal(lines[0], "+40 · Evidence strength: Strong indicator — AE's own assessment.");
  assert.equal(lines[1], "+9 · Owned for about 11 years — Tenure beyond the five-year floor.");
  assert.equal(lines[2], "−12 · Spoken to 2 days ago — Recent contact is on file.", "a negative factor is shown as a reduction");
  assert.ok(
    lines.every((l) => /—/.test(l)),
    "every line carries its prose justification, not just a number",
  );
});

test("stage 3 — the rank summary states the band and explicitly disclaims being a prediction", () => {
  const summary = rankSummaryLine(action()) ?? "";
  assert.match(summary, /Strong indicator/);
  assert.match(summary, /76\/100/);
  assert.match(summary, /not a prediction/i, "the score orders a list; it must never read as a likelihood of selling");
  assert.ok(!/%/.test(summary), "the score must never be rendered as a percentage");
});

/* ---------------------------------------------------------------------
 * Honesty about what is not shown.
 * -----------------------------------------------------------------*/

test("stage 3 — signalWithholdingNotice says nothing when nothing is held back, and names both reasons when something is", () => {
  assert.equal(signalWithholdingNotice({ surfaced: 3, emergingSurfaced: 1, emergingWithheld: 0, withheldDoNotContact: 0 }), null);
  assert.equal(signalWithholdingNotice(undefined), null, "an older API response without the field must not crash the screen");

  const capped = signalWithholdingNotice({ surfaced: 10, emergingSurfaced: 10, emergingWithheld: 4, withheldDoNotContact: 0 }) ?? "";
  assert.match(capped, /4 more early signals are held back/);
  assert.match(capped, /still visible on the contact and property records/, "a held-back item must never look deleted");

  const both = signalWithholdingNotice({ surfaced: 10, emergingSurfaced: 10, emergingWithheld: 1, withheldDoNotContact: 2 }) ?? "";
  assert.match(both, /1 more early signal is held back/, "singular wording when exactly one is held back");
  assert.match(both, /2 signals are withheld because the contact must not be contacted/);

  const dncOnly = signalWithholdingNotice({ surfaced: 1, emergingSurfaced: 0, emergingWithheld: 0, withheldDoNotContact: 1 }) ?? "";
  assert.match(dncOnly, /1 signal is withheld because the contact must not be contacted/);
  assert.ok(!/early signal/.test(dncOnly), "the notice only mentions reasons that actually applied");
});

/* ---------------------------------------------------------------------
 * F-1 — commitment cards use the existing contactability display rules.
 * -----------------------------------------------------------------*/

test("F-1 — only a commitment card carries a kind label", () => {
  assert.equal(actionTypeLabel("commitment"), "Commitment");
  assert.equal(actionTypeLabel("opportunity_follow_up"), null);
  assert.equal(actionTypeLabel("appraisal_follow_up"), null);
  assert.equal(actionTypeLabel("relationship_cold"), null);
  assert.equal(actionTypeLabel("property_intelligence_signal"), null);
  assert.equal(actionTypeLabel("opportunity_no_action_set"), null);
});

test("F-1 — a do-not-contact commitment card cannot offer outreach, and a contactable one can", () => {
  const suppressed = action({
    id: "commitment:9",
    type: "commitment",
    commitmentId: 9,
    priority: "DoNow",
    contactability: "do_not_contact",
    contactabilityNote: "A do-not-contact listing is on file.",
    contactEmail: "should-not-be-used@example.com",
    contactMobile: "+61400000999",
    availableActions: [
      { action: "add_note" },
      { action: "email", partyId: 42 },
      { action: "sms", partyId: 42 },
      { action: "view_contact", partyId: 42 },
    ],
    whyItMatters: null,
    confidenceBand: null,
    rankScore: 0,
  });
  assert.equal(canOfferChannel(suppressed, "email"), false);
  assert.equal(canOfferChannel(suppressed, "sms"), false);
  assert.match(contactabilityNotice(suppressed) ?? "", /do-not-contact listing/i);

  const contactable = action({
    id: "commitment:10",
    type: "commitment",
    commitmentId: 10,
    priority: "DoToday",
    whyItMatters: null,
    confidenceBand: null,
  });
  assert.equal(canOfferChannel(contactable, "email"), true);
  assert.equal(canOfferChannel(contactable, "sms"), true);
  assert.equal(contactabilityNotice(contactable), null);
  assert.equal(rankSummaryLine(contactable), null, "a commitment is a recorded promise, not a scored signal");
});
