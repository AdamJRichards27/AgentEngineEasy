// AE GROW Completion W2-D — RANKING PARITY FOR CONTACT-ANCHORED SIGNALS.
//
// The Project Owner's decision requires that a signal about a PERSON, with no
// verified property association, is not automatically ranked below a signal
// that happens to have one.
//
// That requirement is already met, and it is met BY CONSTRUCTION rather than
// by a rule: lib/grow/signalRanking.ts contains no reference to propertyId at
// all. It scores evidence strength, signal type, per-rule evidence depth,
// provenance/freshness, re-raise persistence, relationship state and
// contactability — and a property anchor is not an input to any of them.
//
// So this file does not FIX anything. It PINS the property, which is the
// valuable thing to do with a correct-by-accident invariant: a later change
// that quietly starts consulting a property (a "properties we know about rank
// higher" tweak, a null-property penalty, a propertyLabel-dependent score)
// fails here rather than shipping as an invisible bias against exactly the
// signals W2-D exists to surface.
//
// It also pins the OTHER standing rule this module carries, because the same
// change that introduces a property bias is the kind of change that would
// reach for a new priority band: A SIGNAL CAN NEVER BE "DoNow". DoNow belongs
// to a dated commitment an agent actually made to a real person; a signal is
// AE's inference, and an inference must not outrank a kept promise.
//
// Pure unit test — no database, no fixtures. rankSignal() takes no database
// access, which is itself part of the design being protected here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  rankSignal,
  SIGNAL_DO_TODAY_MIN_SCORE,
  SIGNAL_SCORE_MAX,
  type RankableSignal,
  type SignalContactState,
} from "../signalRanking.js";

const NOW = new Date("2026-03-01T00:00:00.000Z");

function signal(overrides: Partial<RankableSignal> = {}): RankableSignal {
  return {
    signalType: "re_engagement_opportunity",
    title: "Long-dormant contact worth re-engaging",
    explanation: "A dormant contact with an existing relationship. This is not a prediction about their plans.",
    confidenceBand: "StrongIndicator",
    source: "internal",
    evidence: { schemaVersion: 1, rule: "re_engagement_opportunity", observations: [], unknowns: [], agentAction: "Consider getting back in touch." },
    reRaiseCount: 0,
    computedAt: NOW,
    sourceTimestamp: null,
    ...overrides,
  };
}

function contactState(overrides: Partial<SignalContactState> = {}): SignalContactState {
  return {
    hasLinkedContact: true,
    hasOpenOpportunity: false,
    lastActivityAt: null,
    contactability: "contactable",
    propertyLabel: null,
    ...overrides,
  };
}

test("W2-D: a contact-anchored signal is not penalised for having no property", () => {
  // The ONLY thing that differs between these two is whether the caller had a
  // property label to hand — which is the only property-shaped input
  // rankSignal accepts at all. A contact-anchored signal has none.
  const withoutProperty = rankSignal(signal(), contactState({ propertyLabel: null }), NOW);
  const withProperty = rankSignal(signal(), contactState({ propertyLabel: "12 Example St, Testville" }), NOW);

  assert.equal(
    withoutProperty.score,
    withProperty.score,
    "having no property must not cost a signal a single point — the property is not an input to the score",
  );
  assert.equal(withoutProperty.priority, withProperty.priority, "and it must not cost it a priority band either");

  // The label may legitimately change the TALKING POINT (a concrete address
  // makes a better sentence than none), which is presentation, not ranking.
  // Nothing about the factors that produced the score may differ.
  assert.deepEqual(
    withoutProperty.factors.map((f) => ({ label: f.label, points: f.points })),
    withProperty.factors.map((f) => ({ label: f.label, points: f.points })),
    "the itemised score breakdown is identical, factor for factor",
  );
});

test("W2-D: an always-contact-anchored signal type can outrank a property-anchored one on evidence alone", () => {
  // re_engagement_opportunity is the ONLY always-contact-anchored rule, and it
  // sits mid-table on type weight. A strong one must still be able to beat a
  // weak property-anchored signal — i.e. the ordering is decided by evidence,
  // not by which anchor the signal happens to have.
  const contactAnchored = rankSignal(
    signal({ signalType: "re_engagement_opportunity", confidenceBand: "StrongIndicator" }),
    contactState({ lastActivityAt: null }),
    NOW,
  );
  const propertyAnchored = rankSignal(
    signal({ signalType: "recent_nearby_sales_activity", confidenceBand: "Emerging", source: "test_provider", sourceTimestamp: new Date("2025-01-01T00:00:00.000Z") }),
    // A property-anchored observation has no linked contact at all.
    contactState({ hasLinkedContact: false, propertyLabel: "12 Example St, Testville" }),
    NOW,
  );

  assert.ok(
    contactAnchored.score > propertyAnchored.score,
    `a strongly-evidenced contact-anchored signal (${contactAnchored.score}) outranks a weak property-anchored one (${propertyAnchored.score})`,
  );
});

test("W2-D: no signal reaches DoNow, however strong — not even a maximal contact-anchored one", () => {
  // Every lever pushed as far as it goes: strongest band, the
  // highest-weighted signal type, deep evidence, AE's own record, repeatedly
  // re-raised, nobody working the contact, never contacted.
  const maximal = rankSignal(
    signal({
      signalType: "stale_previous_appraisal",
      confidenceBand: "StrongIndicator",
      evidence: { overdueDays: 100000 },
      reRaiseCount: 1000,
    }),
    contactState({ hasLinkedContact: true, hasOpenOpportunity: false, lastActivityAt: null }),
    NOW,
  );

  assert.ok(maximal.score >= SIGNAL_DO_TODAY_MIN_SCORE, "the fixture really is a top-of-the-list signal");
  assert.ok(maximal.score <= SIGNAL_SCORE_MAX, "the score is bounded");
  assert.equal(maximal.priority, "DoToday", "the strongest possible signal earns Do Today, never Do Now");

  // The same, contact-anchored. Being about a person rather than a property
  // must not be the thing that unlocks a band either.
  const maximalContactAnchored = rankSignal(
    signal({ signalType: "re_engagement_opportunity", confidenceBand: "StrongIndicator", reRaiseCount: 1000 }),
    contactState({ lastActivityAt: null }),
    NOW,
  );
  assert.notEqual(maximalContactAnchored.priority as string, "DoNow", "a signal is an inference and can never outrank a kept promise");
});

test("W2-D: the ranking module has no knowledge of a property anchor at all", () => {
  // The structural pin. Ranking parity for contact-anchored signals holds
  // today because this module cannot see a property to discriminate on. If
  // that stops being true, this test is where it is noticed — and whoever
  // makes that change must come and justify it here, with the three tests
  // above as the specification.
  const source = readFileSync(new URL("../signalRanking.ts", import.meta.url), "utf8");

  // Strip comments first: the module header and this feature's own commentary
  // legitimately DISCUSS properties, and a prose mention must not fail a test
  // about executable behaviour.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const forbidden of [/\bpropertyId\b/, /\bproperty_id\b/, /\bpropertyIds\b/]) {
    assert.doesNotMatch(
      code,
      forbidden,
      `signalRanking.ts must not read a property anchor (${forbidden}). If a property genuinely belongs in the ranking model, ` +
        `that is a Project Owner decision about whether contact-anchored signals may be ranked below property-anchored ones — not a refactor.`,
    );
  }

  // propertyLabel IS allowed — it is presentation input for the talking point,
  // and the first test in this file pins that it cannot move the score.
  assert.match(code, /propertyLabel/, "propertyLabel remains the one property-shaped input, and it is display-only");
});
