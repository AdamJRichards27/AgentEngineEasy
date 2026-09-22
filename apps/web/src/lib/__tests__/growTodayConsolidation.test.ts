import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rankExplanationLines,
  rankSummaryLine,
  signalWithholdingNotice,
  type GrowTodayAction,
  type GrowTodaySignalSummary,
} from "../growToday";

// AE GROW COMPLETION PROGRAM — SLICE W2-A. Pure-logic coverage for the display
// rules this slice added to the hand-maintained API mirror.
//
// A separate file from growToday.test.ts so that file's stage 3 coverage stays
// untouched and self-contained, matching the convention the API side uses for
// the same reason.
//
// TWO GUARANTEES LIVE HERE, AND BOTH ARE THE KIND THAT FAIL SILENTLY:
//
//   1. A COLD-CONTACT CARD MUST NOT DISPLAY A PRIORITY SCORE. Rule D cards
//      started carrying a whyItMatters so they could explain themselves when a
//      cap withholds a contact's signal. rankSummaryLine() renders
//      "priority N/100" for any non-null whyItMatters, so without an explicit
//      guard a plain "no contact recorded for 240 days" threshold rule would
//      have begun presenting itself to agents as a scored inference. It is not
//      one.
//   2. EVIDENCE THAT WAS MERGED OR HELD BACK MUST BE VISIBLE. A related signal
//      that exists in the API response but is rendered nowhere is, from the
//      agent's side, indistinguishable from one that was thrown away — which
//      is exactly what DECISION 3 asked AE not to do.

function signalCard(overrides: Partial<GrowTodayAction> = {}): GrowTodayAction {
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
    availableActions: [{ action: "ask_ae" }],
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
      factors: [{ label: "Evidence strength: Strong indicator", detail: "AE's own assessment.", points: 40 }],
      relatedSignals: [],
    },
    ...overrides,
  };
}

/** A Rule D card as the API now emits it: an explanation, but no evidence band. */
function coldCard(overrides: Partial<GrowTodayAction> = {}): GrowTodayAction {
  return signalCard({
    id: "relationship:9",
    type: "relationship_cold",
    rankScore: 34,
    confidenceBand: null,
    reason: "No contact recorded for 240 days.",
    recommendedAction: "Reach out to reconnect.",
    whyItMatters: {
      headline: "AE surfaced this contact because your own records show no recorded contact with them for 240 days.",
      talkingPoint: null,
      caution: "AE knows only that no contact was RECORDED in this period — it does not know that none happened.",
      confidenceBand: null,
      confidenceBandLabel: null,
      factors: [],
      relatedSignals: [],
    },
    ...overrides,
  });
}

test("W2-A — a cold-contact card explains itself but never renders a bare priority score", () => {
  const cold = coldCard();
  assert.ok(cold.whyItMatters !== null, "the fixture is the case that matters: an explanation IS present");
  assert.equal(
    rankSummaryLine(cold),
    null,
    "a threshold rule with no confidence band must not be dressed up as a scored inference",
  );
  // A real signal card is unaffected — the guard keys on the band, not on the
  // card type, so it cannot accidentally suppress the score where it belongs.
  assert.match(rankSummaryLine(signalCard()) ?? "", /Strong indicator · priority 76\/100/);
});

test("W2-A — a cold card with no factors and no related signals renders no explanation lines at all", () => {
  assert.deepEqual(rankExplanationLines(coldCard()), [], "nothing to itemise means render nothing, not an empty bullet");
});

test("W2-A — a consolidated sibling is rendered on the winning card, with its own stored explanation and no misleading points", () => {
  const card = signalCard({
    whyItMatters: {
      ...signalCard().whyItMatters!,
      relatedSignals: [
        {
          signalId: 88,
          signalType: "re_engagement_opportunity",
          title: "Long-dormant contact worth re-engaging",
          explanation: "The last contact recorded with this person was about 7 months ago.",
          confidenceBand: "WorthReviewing",
          confidenceBandLabel: "Worth reviewing",
          rankScore: 62,
          relationship: "consolidated_into_this_card",
        },
      ],
    },
  });

  const lines = rankExplanationLines(card);
  assert.equal(lines.length, 2, "the card's own factor, then the sibling it won against");
  assert.match(lines[1], /Long-dormant contact worth re-engaging/);
  assert.match(lines[1], /Worth reviewing/);
  assert.match(lines[1], /AE showed the stronger of the two/, "the agent is told WHY this evidence is not its own card");
  assert.match(lines[1], /last contact recorded with this person was about 7 months ago/, "the sibling's own wording survives");
  assert.ok(
    !/^[+−]/.test(lines[1]),
    "a related signal contributed nothing to THIS card's score, so showing it with a signed weight would imply it was added in",
  );
});

test("W2-A — a signal held back by the daily cap is rendered on the cold card that replaced it, and says so", () => {
  const cold = coldCard({
    whyItMatters: {
      ...coldCard().whyItMatters!,
      relatedSignals: [
        {
          signalId: 91,
          signalType: "long_ownership_tenure",
          title: "Long ownership tenure",
          explanation: "Recorded as the owner of this property for approximately 9 years.",
          confidenceBand: "Emerging",
          confidenceBandLabel: "Emerging",
          rankScore: 31,
          relationship: "withheld_by_daily_cap",
        },
      ],
    },
  });

  const lines = rankExplanationLines(cold);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /held back by today's limit/, "a withheld signal must never look like one that does not exist");
  assert.match(lines[0], /Long ownership tenure/);
  // Still no score on this card, even though it now carries evidence.
  assert.equal(rankSummaryLine(cold), null);
});

test("W2-A — an older API response with no relatedSignals field renders the factors and does not throw", () => {
  const legacy = signalCard();
  // Exactly what a server predating this slice sends: the field is simply absent.
  delete (legacy.whyItMatters as Partial<NonNullable<GrowTodayAction["whyItMatters"]>>).relatedSignals;
  assert.equal(rankExplanationLines(legacy).length, 1, "a hand-maintained mirror must degrade, never crash the screen");
});

/* ---------------------------------------------------------------------
 * Honesty about what is not shown.
 * -----------------------------------------------------------------*/

const EMPTY: GrowTodaySignalSummary = {
  surfaced: 0,
  emergingSurfaced: 0,
  emergingWithheld: 0,
  withheldDoNotContact: 0,
  consolidatedIntoStrongerSignal: 0,
  withheldByActionCap: 0,
  limitations: [],
};

test("W2-A — the withholding notice stays silent when nothing was merged, capped or truncated", () => {
  assert.equal(signalWithholdingNotice(EMPTY), null);
  assert.equal(signalWithholdingNotice({ ...EMPTY, surfaced: 5, emergingSurfaced: 2 }), null);
});

test("W2-A — merged signals are reported as merged, not as hidden: the evidence is on the card for that contact", () => {
  const one = signalWithholdingNotice({ ...EMPTY, consolidatedIntoStrongerSignal: 1 }) ?? "";
  assert.match(one, /1 signal was merged into a stronger signal for the same contact/);
  assert.match(one, /nobody appears twice/, "the notice explains the BENEFIT, so a merge does not read as a loss");

  const many = signalWithholdingNotice({ ...EMPTY, consolidatedIntoStrongerSignal: 4 }) ?? "";
  assert.match(many, /4 signals were merged/, "plural wording when more than one was merged");
});

test("W2-A — the total priority-action cap is stated, so a truncated day never looks like a complete one", () => {
  const notice = signalWithholdingNotice({ ...EMPTY, withheldByActionCap: 25 }) ?? "";
  assert.match(notice, /25 lower-priority items are not shown because today's list is capped/);
  assert.match(notice, /still visible on the contact and property records/);

  const single = signalWithholdingNotice({ ...EMPTY, withheldByActionCap: 1 }) ?? "";
  assert.match(single, /1 lower-priority item is not shown/, "singular wording when exactly one was cut");
});

test("W2-A — server-stated read limitations are rendered verbatim, never compressed into a count", () => {
  const limitation = "At least 500 active signals exist; Today reads the 500 with the strongest evidence bands.";
  const notice = signalWithholdingNotice({ ...EMPTY, limitations: [limitation] }) ?? "";
  assert.ok(
    notice.includes(limitation),
    "each limitation names a specific bound and where the full list lives; summarising it away throws out the only actionable part",
  );

  // Reasons and limitations coexist without either swallowing the other.
  const both = signalWithholdingNotice({ ...EMPTY, emergingWithheld: 2, limitations: [limitation] }) ?? "";
  assert.match(both, /2 more early signals are held back/);
  assert.ok(both.includes(limitation));
});

test("W2-A — a response from a server predating this slice degrades to stage 3's own notice rather than crashing", () => {
  // The three W2-A fields are absent entirely, which is precisely the drift
  // case this mirror's header documents having been bitten by twice.
  const legacy = { surfaced: 10, emergingSurfaced: 10, emergingWithheld: 3, withheldDoNotContact: 0 };
  const notice = signalWithholdingNotice(legacy) ?? "";
  assert.match(notice, /3 more early signals are held back/);
  assert.ok(!/merged|capped/.test(notice), "the notice only mentions reasons it actually has data for");
});
