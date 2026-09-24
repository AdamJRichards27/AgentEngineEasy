// AE GROW COMPLETION PROGRAM — SLICE W2-A. Pure unit coverage for
// lib/grow/signalRanking.ts.
//
// NO DATABASE, NO HTTP, NO CLOCK. That module is deliberately pure — it takes
// `now` as an argument and reads nothing it was not handed — so its contract
// can be asserted directly instead of inferred from a route response. The
// route-level behaviour these rules produce is covered separately in
// routes/__tests__/growSignalSurface.test.ts and
// routes/__tests__/growTodayConsolidation.test.ts.
//
// WHAT IS BEING PROTECTED HERE:
//
//   1. THE WORDING RULES. Every narrative AE puts in an agent's mouth must be
//      hedged and must assert nothing about a homeowner's intentions. That is
//      a product guarantee, not a style preference, and it is the kind of
//      thing that erodes one well-meaning edit at a time.
//   2. THE TIE-BREAK. compareSignalStrength() is the single authority for
//      which of two signals about one person becomes the card. Without its
//      row-id tiebreak, equally-scored cards order by whatever the database
//      returned, and an agent's day reshuffles on refresh.
//   3. THE SINGLE-SOURCED THRESHOLD. COLD_CONTACT_THRESHOLD_DAYS used to exist
//      in two files kept equal by a comment. The exports being equal is not
//      enough: two assignments that both happen to be 21 would still pass
//      that check. The source lock below fails if either production file
//      hardcodes the threshold number a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COLD_CONTACT_THRESHOLD_DAYS,
  PER_PARTY_SIGNAL_SELECTOR,
  compareSignalStrength,
  rankSignal,
  ruleDWinsOverSignal,
  type RankableSignal,
  type SignalContactState,
} from "../grow/signalRanking.js";
import { COLD_CONTACT_THRESHOLD_DAYS as GROW_TODAY_COLD_THRESHOLD } from "../growToday.js";

const NOW = new Date("2026-09-21T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function signal(overrides: Partial<RankableSignal> = {}): RankableSignal {
  return {
    signalType: "re_engagement_opportunity",
    title: "Long-dormant contact worth re-engaging",
    explanation: "Stored, already-hedged explanation.",
    confidenceBand: "StrongIndicator",
    source: "internal",
    evidence: { dormantDays: 210 },
    reRaiseCount: 0,
    computedAt: NOW,
    sourceTimestamp: null,
    ...overrides,
  };
}

function state(overrides: Partial<SignalContactState> = {}): SignalContactState {
  return {
    hasLinkedContact: true,
    hasOpenOpportunity: false,
    lastActivityAt: new Date(NOW.getTime() - 210 * DAY),
    contactability: "contactable",
    propertyLabel: "1 Dormant St",
    ...overrides,
  };
}

/* =====================================================================
 * B-4 — THE FLAGSHIP SIGNAL FINALLY HAS SOMETHING TO SAY.
 * ===================================================================*/

test("B-4 — re_engagement_opportunity produces a talking point instead of falling through to the null default", () => {
  const { narrative } = rankSignal(signal(), state(), NOW);
  assert.ok(
    narrative.talkingPoint !== null,
    "the sweep's highest-volume signal type had NO case in buildNarrative and got talkingPoint: null on every card",
  );
  // The default branch echoes "title. explanation" verbatim; a real case does not.
  assert.ok(
    !narrative.headline.startsWith("Long-dormant contact worth re-engaging. Stored,"),
    "a real case must be reached, not the generic default",
  );
});

test("B-4 — the re-engagement talking point is a QUESTION and asserts nothing about the contact's intentions", () => {
  const { narrative } = rankSignal(signal(), state(), NOW);
  const point = narrative.talkingPoint ?? "";

  assert.ok(point.includes("?"), "every talking point is a question or an offer the agent may choose to make");
  // The specific over-reaches this wording exists to avoid. AE has no
  // information about anybody's plans and nothing it says may read as if it
  // does.
  assert.ok(
    !/\b(is|are|will be|must be|wants? to|plans? to|ready to|thinking of|looking to)\s+(sell|selling|move|moving|list|listing)\b/i.test(point),
    `a talking point must never assert the contact's intentions; got: ${point}`,
  );
  assert.ok(!/\bshould\b/i.test(point), "AE does not tell a homeowner what they should do");
  // And it offers a graceful exit rather than pressing.
  assert.match(point, /would|shall|is there/i, "the offer is phrased tentatively, leaving the contact an easy no");
});

test("B-4 — the caution names the actual limit of what a gap in AE's records proves", () => {
  const { narrative } = rankSignal(signal(), state(), NOW);
  assert.match(
    narrative.caution,
    /does not prove none happened/i,
    "an absent activity row means nobody RECORDED a contact, not that none occurred",
  );
  assert.match(narrative.caution, /no information about this contact's private intentions/i);
});

test("B-4 — the never-contacted variant is worded differently from the long-dormant one, and both stay hedged", () => {
  const dormant = rankSignal(signal(), state(), NOW).narrative;
  const never = rankSignal(
    signal({ title: "Known contact who has never been contacted", evidence: { dormantDays: 900 } }),
    state({ lastActivityAt: null }),
    NOW,
  ).narrative;

  assert.notEqual(never.headline, dormant.headline, "'never spoken to' and 'went quiet' are different situations");
  assert.match(never.headline, /no contact of any kind ever recorded/i);
  assert.ok((never.talkingPoint ?? "").includes("?"));
  assert.ok(!/\bwill\b/i.test(never.talkingPoint ?? ""), "no predictions in either variant");
});

test("B-4 — a missing dormantDays in the evidence blob degrades the wording instead of throwing or inventing a number", () => {
  // `evidence` is jsonb written by a module this one does not own, so every
  // read of it has to be total.
  const { narrative } = rankSignal(signal({ evidence: {} }), state(), NOW);
  assert.match(narrative.headline, /a long time/i, "an unreadable evidence blob degrades to a vague phrase");
  assert.ok(!/\bNaN\b|undefined|null/.test(narrative.headline), "and never leaks a broken value into agent-facing copy");
});

test("B-4 — a do-not-contact contact gets no talking point for this signal type either", () => {
  // The belt-and-braces branch in rankSignal() must still win over any new
  // narrative case: adding a case must never create a path to suggesting an
  // approach to somebody who must not be approached.
  const ranking = rankSignal(signal(), state({ contactability: "do_not_contact" }), NOW);
  assert.equal(ranking.score, 0);
  assert.equal(ranking.priority, "KeepWarm");
  assert.equal(ranking.narrative.talkingPoint, null, "a new narrative case must not reopen the consent hole");
  assert.match(ranking.narrative.headline, /must not be approached/i);
});

/* =====================================================================
 * F-3 — THE "STRONGER SIGNAL" SELECTOR.
 * ===================================================================*/

test("F-3 — compareSignalStrength orders by score, and breaks exact ties by row id so ordering is deterministic", () => {
  assert.ok(compareSignalStrength({ score: 70, rowId: 9 }, { score: 60, rowId: 1 }) < 0, "higher score leads");
  assert.ok(compareSignalStrength({ score: 60, rowId: 1 }, { score: 70, rowId: 9 }) > 0);

  // THE TIEBREAK IS LOAD-BEARING. Two signals with identical inputs score
  // identically; without this the comparator returns 0 and the surrounding
  // sort leaves them in whatever order they arrived in.
  assert.ok(compareSignalStrength({ score: 68, rowId: 4 }, { score: 68, rowId: 11 }) < 0, "the lower row id leads a tie");
  assert.notEqual(compareSignalStrength({ score: 68, rowId: 4 }, { score: 68, rowId: 11 }), 0);

  // Sorting the same set from two different starting orders must converge.
  const items = [
    { score: 68, rowId: 11 },
    { score: 68, rowId: 4 },
    { score: 72, rowId: 30 },
    { score: 68, rowId: 7 },
  ];
  const forward = [...items].sort(compareSignalStrength).map((i) => i.rowId);
  const reversed = [...items].reverse().sort(compareSignalStrength).map((i) => i.rowId);
  assert.deepEqual(forward, [30, 4, 7, 11]);
  assert.deepEqual(reversed, forward, "the result must not depend on the order the rows happened to arrive in");
});

test("F-3 — the selector is declared explicitly, so the pending Project Owner decision is visible in code rather than implied", () => {
  // "Stronger signal" was undefined in code before this slice: SIGNAL_TYPE_POINTS
  // gave an ordering but nothing declared it the authority, and it disagrees
  // with total rankScore. Naming the choice is what makes it reviewable and
  // trivially reversible.
  assert.equal(PER_PARTY_SIGNAL_SELECTOR, "rankScore");
});

test("F-3 — the selector genuinely disagrees with signal-type weight, so choosing between them is a real decision", () => {
  // This is the pair named in the audit: a StrongIndicator re-engagement
  // (type weight 10) against a WorthReviewing long-tenure (type weight 18).
  // If these ever stopped diverging, the selector constant would become
  // decorative and this test would say so.
  const reEngagement = rankSignal(signal(), state(), NOW);
  const longTenure = rankSignal(
    signal({
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      confidenceBand: "WorthReviewing",
      // Six years is one year past the rule's own five-year floor, so the
      // evidence-depth component contributes almost nothing and the band gap
      // decides. (A much longer tenure closes the gap — at nine years the two
      // land on the same score, which is exactly why the row-id tiebreak above
      // is not optional.)
      evidence: { approximateTenureYears: 6 },
    }),
    state(),
    NOW,
  );

  assert.ok(
    reEngagement.score > longTenure.score,
    `rankScore puts the re-engagement first (${reEngagement.score} vs ${longTenure.score}) while SIGNAL_TYPE_POINTS puts long tenure first — the two authorities really do conflict`,
  );
  assert.ok(
    compareSignalStrength({ score: reEngagement.score, rowId: 2 }, { score: longTenure.score, rowId: 1 }) < 0,
    "and the implemented selector follows rankScore",
  );
});

test("F-5 — Rule D wins the one-card contest only when its rank is strictly higher", () => {
  // A tie keeps the signal. It is the more specific card, which is why a
  // surfaced signal still suppresses the generic cold nudge.
  assert.equal(ruleDWinsOverSignal(38, 34), true, "a never-contacted cold card (38) beats a weak Emerging signal");
  assert.equal(ruleDWinsOverSignal(38, 38), false, "an equal score keeps the signal");
  assert.equal(ruleDWinsOverSignal(38, 48), false, "a stronger signal still suppresses Rule D");
  assert.equal(ruleDWinsOverSignal(37, 34), true, "a long-cold relationship still beats a weaker signal");
});

/* =====================================================================
 * F-7 — ONE DEFINITION OF "COLD".
 * ===================================================================*/

test("F-7 — Grow Today and the signal ranker read the SAME cold threshold, not two constants kept equal by a comment", () => {
  // The point is not that the numbers are equal — they were equal before too.
  // It is that there is now only one of them, so tuning it cannot give the two
  // surfaces different definitions of the same word without anything failing.
  assert.equal(GROW_TODAY_COLD_THRESHOLD, COLD_CONTACT_THRESHOLD_DAYS);
  assert.equal(COLD_CONTACT_THRESHOLD_DAYS, 21, "the shipped value is unchanged by the single-sourcing");
});

// Block comments keep their newlines so a hit can name a line. Line comments
// are cut, but `https://` is not a comment. Same approach as the G-5 web lock.
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  return withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function linesMatching(source: string, pattern: RegExp): string[] {
  return source.split("\n").flatMap((line, index) => (pattern.test(line) ? [`${index + 1}: ${line.trim()}`] : []));
}

test("F-7 — the cold threshold number is hardcoded once, in signalRanking, and Grow Today imports that export", () => {
  // Equality of the two exports does not catch a second `= 21` that happens
  // to match. This reads the production sources (comments stripped) so a
  // duplicate assignment, or a bare `21` at either call site, fails here.
  const rankingRaw = readFileSync(new URL("../grow/signalRanking.ts", import.meta.url), "utf8");
  const todayRaw = readFileSync(new URL("../growToday.ts", import.meta.url), "utf8");
  const ranking = stripComments(rankingRaw);
  const today = stripComments(todayRaw);

  const assignment = /COLD_CONTACT_THRESHOLD_DAYS\s*=\s*(\d+)/g;
  assert.deepEqual(
    [...ranking.matchAll(assignment)].map((match) => match[1]),
    ["21"],
    "signalRanking.ts is the one declaration, and the shipped value stays 21",
  );
  assert.deepEqual(
    [...today.matchAll(assignment)],
    [],
    "growToday.ts must not declare its own COLD_CONTACT_THRESHOLD_DAYS",
  );

  const rankingLiterals = linesMatching(ranking, /\b21\b/);
  assert.equal(
    rankingLiterals.length,
    1,
    `a second literal 21 in signalRanking.ts is a second cold threshold: ${rankingLiterals.join("; ")}`,
  );
  assert.match(rankingLiterals[0] ?? "", /COLD_CONTACT_THRESHOLD_DAYS\s*=\s*21/);

  const todayLiterals = linesMatching(today, /\b21\b/);
  assert.deepEqual(
    todayLiterals,
    [],
    `growToday.ts must not hardcode 21; it imports the shared threshold. Hits: ${todayLiterals.join("; ")}`,
  );

  assert.match(
    today,
    /import\s*\{[\s\S]*?\bCOLD_CONTACT_THRESHOLD_DAYS\b[\s\S]*?\}\s*from\s*"\.\/grow\/signalRanking\.js"/,
    "Grow Today must import the shared export",
  );
  assert.match(today, /export\s*\{\s*COLD_CONTACT_THRESHOLD_DAYS\s*\}/, "Grow Today re-exports the same binding");
  assert.match(today, /days\s*>=\s*COLD_CONTACT_THRESHOLD_DAYS/);
  assert.match(ranking, /days\s*>=\s*COLD_CONTACT_THRESHOLD_DAYS/);

  // The old instruction was a comment that told the next editor to keep two
  // copies equal. That sentence must not come back in either production file.
  assert.doesNotMatch(rankingRaw, /keep in sync|kept in sync/i);
  assert.doesNotMatch(todayRaw, /keep in sync|kept in sync/i);
});

test("F-7 — the cold factor fires at exactly the shared threshold and not a day before", () => {
  const atThreshold = rankSignal(
    signal(),
    state({ lastActivityAt: new Date(NOW.getTime() - COLD_CONTACT_THRESHOLD_DAYS * DAY) }),
    NOW,
  );
  assert.ok(
    atThreshold.factors.some((f) => /No contact recorded for \d+ days/.test(f.label)),
    "a contact exactly at the threshold counts as cold",
  );

  const justInside = rankSignal(
    signal(),
    state({ lastActivityAt: new Date(NOW.getTime() - (COLD_CONTACT_THRESHOLD_DAYS - 1) * DAY) }),
    NOW,
  );
  assert.ok(
    !justInside.factors.some((f) => /No contact recorded for \d+ days/.test(f.label)),
    "a contact one day inside the threshold does not",
  );
});
