// AE GROW Priority 6 Stage C — pure unit tests for coaching/responseBuilder.ts.
//
// Every buildCoachX function is exercised against a hand-built
// BusinessCoachContext fixture (never the database, never the AI provider) —
// these are exactly the deterministic functions that make "no model-
// arithmetic" true by construction (see responseBuilder.ts's own header
// comment), so their output must be pinned down precisely here.
//
// AE GROW Priority 6 Stage C TIMEZONE REMEDIATION: makePeriodView()'s
// default PeriodView now carries a real timeZone/timeZoneSource/timeBasis
// (Australia/Brisbane, fallback), and a new test below pins down that
// buildCoachSuggestedReviewDate's output, when read back in the coaching
// timezone, lands on the correct LOCAL calendar date even at an instant
// where the UTC and local calendar dates already disagree.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_COACH_RECOMMENDATIONS,
  COACH_STANDARD_LIMITATIONS,
  buildCoachFocusAreas,
  buildCoachHeadline,
  buildCoachLimitations,
  buildCoachObservations,
  buildCoachPerformanceSummary,
  buildCoachRecommendations,
  buildCoachStrengths,
  buildCoachSuggestedReviewDate,
  buildCoachSupportingMetrics,
} from "../responseBuilder.js";
import { STALE_APPRAISAL_DAYS, STALL_THRESHOLD_DAYS } from "../metrics.js";
import { localDateKey } from "../timezone.js";
import type { PeriodView } from "../period.js";
import type {
  ActivityConsistencyMetric,
  AppraisalMomentumMetric,
  CommitmentPerformanceMetric,
  GrowTodayPatternsMetric,
  OpportunityPipelineHealthMetric,
  PeriodComparisonMetric,
  RelationshipEngagementMetric,
} from "../metrics.js";
import type { BusinessCoachContext } from "../../types.js";

function makePeriodView(overrides: Partial<PeriodView> = {}): PeriodView {
  return {
    key: "last7days",
    label: "Last 7 days",
    start: "2026-03-08T00:00:00.000Z",
    end: "2026-03-15T00:00:00.000Z",
    isComplete: true,
    durationDays: 7,
    timeZone: "Australia/Brisbane",
    timeZoneSource: "fallback",
    timeBasis: "Local calendar time in Australia/Brisbane, this application's default timezone (no brokerage timezone is configured yet).",
    ...overrides,
  };
}

function makeActivity(overrides: Partial<ActivityConsistencyMetric> = {}): ActivityConsistencyMetric {
  return {
    period: makePeriodView(),
    sampleSize: 0,
    truncated: false,
    totalActivities: 12,
    activitiesByType: { Call: 12 },
    activeDays: 5,
    totalDaysInPeriod: 7,
    activeDayRate: 5 / 7,
    longestGapDays: 1,
    limitations: [],
    ...overrides,
  };
}

function makeCommitments(overrides: Partial<CommitmentPerformanceMetric> = {}): CommitmentPerformanceMetric {
  return {
    period: makePeriodView(),
    sampleSize: 0,
    truncated: false,
    totalDue: 5,
    completed: 4,
    completionRate: 0.8,
    currentlyOverdueCount: 0,
    currentlyOverdueTruncated: false,
    averageOverdueAgeDays: null,
    repeatedOverdueContacts: [],
    repeatedOverdueTruncated: false,
    limitations: [],
    ...overrides,
  };
}

function makeAppraisals(overrides: Partial<AppraisalMomentumMetric> = {}): AppraisalMomentumMetric {
  return {
    period: makePeriodView(),
    sampleSize: 0,
    truncated: false,
    created: 1,
    byStatus: { DRAFT: 1 },
    wonCount: 0,
    lostCount: 0,
    followUpDueCount: 0,
    staleCount: 0,
    staleTruncated: false,
    limitations: [],
    ...overrides,
  };
}

function makeOpportunities(overrides: Partial<OpportunityPipelineHealthMetric> = {}): OpportunityPipelineHealthMetric {
  return {
    period: makePeriodView(),
    sampleSize: 0,
    truncated: false,
    openCount: 4,
    byStage: { New: 2, Contacted: 2 },
    newInPeriod: 1,
    newFromSignalsInPeriod: 0,
    averageAgeDays: 10,
    stalled: [],
    stalledTruncated: false,
    limitations: [],
    ...overrides,
  };
}

function makeRelationships(overrides: Partial<RelationshipEngagementMetric> = {}): RelationshipEngagementMetric {
  return {
    sampleSize: 0,
    truncated: false,
    totalActiveRelationships: 10,
    distinctContacts: 10,
    byType: { Owner: 10 },
    recentlyEngagedContacts: 10,
    noRecentActivityContacts: 0,
    noRecentActivityList: [],
    noRecentActivityTruncated: false,
    activityTruncated: false,
    limitations: [],
    ...overrides,
  };
}

function makeGrowToday(overrides: Partial<GrowTodayPatternsMetric> = {}): GrowTodayPatternsMetric {
  return {
    generatedAt: "2026-03-15T00:00:00.000Z",
    hasAnyGrowData: true,
    totalItems: 0,
    byPriority: {},
    byType: {},
    topReasons: [],
    limitations: [],
    ...overrides,
  };
}

function makeComparison(overrides: Partial<PeriodComparisonMetric> = {}): PeriodComparisonMetric {
  return {
    currentPeriod: makePeriodView(),
    previousPeriod: makePeriodView({ key: "custom", label: "7 days before \"Last 7 days\"", start: "2026-03-01T00:00:00.000Z", end: "2026-03-08T00:00:00.000Z" }),
    deltas: [],
    limitations: [],
    ...overrides,
  };
}

function makeCoachContext(overrides: Partial<BusinessCoachContext> = {}): BusinessCoachContext {
  return {
    asOf: "2026-03-15T00:00:00.000Z",
    period: makePeriodView(),
    previousPeriod: makePeriodView({ key: "custom" }),
    activity: makeActivity(),
    commitments: makeCommitments(),
    appraisals: makeAppraisals(),
    opportunities: makeOpportunities(),
    relationships: makeRelationships(),
    growToday: makeGrowToday(),
    comparison: makeComparison(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCoachHeadline
// ---------------------------------------------------------------------------

test("buildCoachHeadline: maps every named period key to a natural-language phrase", () => {
  assert.equal(buildCoachHeadline(makeCoachContext({ period: makePeriodView({ key: "last7days" }) })), "A look at your last 7 days");
  assert.equal(buildCoachHeadline(makeCoachContext({ period: makePeriodView({ key: "last30days" }) })), "A look at your last 30 days");
  assert.equal(buildCoachHeadline(makeCoachContext({ period: makePeriodView({ key: "currentMonth" }) })), "A look at this month so far");
  assert.equal(buildCoachHeadline(makeCoachContext({ period: makePeriodView({ key: "previousPeriod" }) })), "A look at last month");
});

test("buildCoachHeadline: a custom period falls back to its explicit date range", () => {
  const context = makeCoachContext({ period: makePeriodView({ key: "custom", start: "2026-01-01T00:00:00.000Z", end: "2026-01-10T00:00:00.000Z" }) });
  assert.equal(buildCoachHeadline(context), "A look at the period from 2026-01-01 to 2026-01-10");
});

// ---------------------------------------------------------------------------
// buildCoachPerformanceSummary
// ---------------------------------------------------------------------------

test("buildCoachPerformanceSummary: states activity, commitment completion, pipeline, and appraisal figures from the context alone", () => {
  const context = makeCoachContext({
    activity: makeActivity({ totalActivities: 12, activeDays: 5, totalDaysInPeriod: 7 }),
    commitments: makeCommitments({ totalDue: 5, completed: 4, completionRate: 0.8 }),
    opportunities: makeOpportunities({ openCount: 4, newInPeriod: 1 }),
    appraisals: makeAppraisals({ created: 2 }),
  });
  const summary = buildCoachPerformanceSummary(context);
  assert.match(summary, /12 recorded activities across 5 of the last 7 days/);
  assert.match(summary, /4 of 5 commitments due in this period were completed \(80%\)/);
  assert.match(summary, /4 opportunities are currently open, with 1 new in this period/);
  assert.match(summary, /2 appraisals were created in this period/);
});

test("buildCoachPerformanceSummary: uses singular phrasing for exactly one activity/appraisal, and an honest caveat when there is no commitment data", () => {
  const context = makeCoachContext({
    activity: makeActivity({ totalActivities: 1, activeDays: 1, totalDaysInPeriod: 7 }),
    commitments: makeCommitments({ totalDue: 0, completed: 0, completionRate: null }),
    appraisals: makeAppraisals({ created: 1 }),
  });
  const summary = buildCoachPerformanceSummary(context);
  assert.match(summary, /1 recorded activity across/);
  assert.match(summary, /There is not yet enough information to determine a commitment completion rate/);
  assert.match(summary, /1 appraisal was created in this period/);
});

// ---------------------------------------------------------------------------
// buildCoachObservations
// ---------------------------------------------------------------------------

test("buildCoachObservations: skips insufficient_data deltas, states stable deltas without a percentage, and states changed deltas with a signed percentage", () => {
  const context = makeCoachContext({
    comparison: makeComparison({
      deltas: [
        { metric: "totalActivities", label: "Recorded activity", current: 20, previous: 16, absoluteChange: 4, percentChange: 25.4, direction: "increased" },
        { metric: "activeDays", label: "Active prospecting days", current: 5, previous: 5, absoluteChange: 0, percentChange: 0, direction: "stable" },
        { metric: "commitmentCompletionRatePercent", label: "Commitment completion rate", current: null, previous: null, absoluteChange: null, percentChange: null, direction: "insufficient_data" },
        { metric: "appraisalsCreated", label: "Appraisals created", current: 1, previous: 3, absoluteChange: -2, percentChange: -66.7, direction: "decreased" },
      ],
    }),
  });
  const observations = buildCoachObservations(context);
  assert.ok(observations.some((o) => o === "Recorded activity increased (+25%) compared with the previous period."));
  assert.ok(observations.some((o) => o === "Active prospecting days was stable compared with the previous period."));
  assert.ok(observations.some((o) => o === "Appraisals created decreased (-67%) compared with the previous period."));
  assert.ok(!observations.some((o) => o.includes("Commitment completion rate")), "an insufficient_data delta must never be stated as an observation");
});

test(`buildCoachObservations: adds attention-flagging observations for overdue commitments, stalled opportunities (${STALL_THRESHOLD_DAYS}+ days), and stale appraisals (${STALE_APPRAISAL_DAYS}+ days)`, () => {
  const context = makeCoachContext({
    commitments: makeCommitments({ currentlyOverdueCount: 2 }),
    opportunities: makeOpportunities({ stalled: [{ opportunityId: 1, partyId: 1, stage: "New", daysSinceContact: 30 }] }),
    appraisals: makeAppraisals({ staleCount: 1 }),
  });
  const observations = buildCoachObservations(context);
  assert.ok(observations.some((o) => o.includes("This may warrant attention because 2 commitments are currently overdue")));
  assert.ok(observations.some((o) => o.includes("1 open opportunity has had no recorded contact")));
  assert.ok(observations.some((o) => o.includes("1 appraisal has had no update")));
});

// ---------------------------------------------------------------------------
// buildCoachStrengths
// ---------------------------------------------------------------------------

test("buildCoachStrengths: recognises a strong completion rate, zero overdue commitments, a non-stalling pipeline, and a consistent activity rate", () => {
  const context = makeCoachContext({
    commitments: makeCommitments({ completionRate: 0.9, totalDue: 5, currentlyOverdueCount: 0 }),
    opportunities: makeOpportunities({ openCount: 5, stalled: [] }),
    activity: makeActivity({ activeDayRate: 0.7, activeDays: 5, totalDaysInPeriod: 7 }),
  });
  const strengths = buildCoachStrengths(context);
  assert.ok(strengths.some((s) => s.includes("A strong commitment completion rate (90%)")));
  assert.ok(strengths.some((s) => s === "No commitments are currently overdue."));
  assert.ok(strengths.some((s) => s === "No open opportunities currently show signs of stalling."));
  assert.ok(strengths.some((s) => s.includes("Activity was recorded on 5 of 7 days")));
});

test("buildCoachStrengths: a low completion rate, overdue commitments, or a small sample size produce no false strengths", () => {
  const context = makeCoachContext({
    commitments: makeCommitments({ completionRate: 0.9, totalDue: 1, currentlyOverdueCount: 1 }),
    opportunities: makeOpportunities({ openCount: 5, stalled: [{ opportunityId: 1, partyId: 1, stage: "New", daysSinceContact: 25 }] }),
    activity: makeActivity({ activeDayRate: 0.2 }),
  });
  const strengths = buildCoachStrengths(context);
  assert.equal(strengths.length, 0, "a sample of 1 must not qualify as a 'strong completion rate' regardless of the rate itself");
});

// ---------------------------------------------------------------------------
// buildCoachFocusAreas
// ---------------------------------------------------------------------------

test("buildCoachFocusAreas: names every underlying concern the metrics actually show, and nothing else", () => {
  const healthyContext = makeCoachContext();
  assert.deepEqual(buildCoachFocusAreas(healthyContext), []);

  const concerningContext = makeCoachContext({
    commitments: makeCommitments({ currentlyOverdueCount: 3 }),
    opportunities: makeOpportunities({ stalled: [{ opportunityId: 1, partyId: 1, stage: "New", daysSinceContact: 30 }] }),
    appraisals: makeAppraisals({ staleCount: 2 }),
    relationships: makeRelationships({ noRecentActivityContacts: 4 }),
    activity: makeActivity({ totalActivities: 0 }),
  });
  const focusAreas = buildCoachFocusAreas(concerningContext);
  assert.equal(focusAreas.length, 5);
  assert.ok(focusAreas.some((f) => f.includes("3 overdue commitments")));
  assert.ok(focusAreas.some((f) => f.includes("1 open opportunity")));
  assert.ok(focusAreas.some((f) => f.includes("2 appraisals")));
  assert.ok(focusAreas.some((f) => f.includes("4 contacts")));
  assert.ok(focusAreas.some((f) => f === "No activity was recorded in this period."));
});

// ---------------------------------------------------------------------------
// buildCoachRecommendations
// ---------------------------------------------------------------------------

test(`buildCoachRecommendations: never returns more than MAX_COACH_RECOMMENDATIONS (${MAX_COACH_RECOMMENDATIONS}), prioritised overdue > stalled > stale > relationships > activity`, () => {
  assert.equal(MAX_COACH_RECOMMENDATIONS, 3);
  const context = makeCoachContext({
    commitments: makeCommitments({ currentlyOverdueCount: 1 }),
    opportunities: makeOpportunities({ stalled: [{ opportunityId: 1, partyId: 1, stage: "New", daysSinceContact: 30 }] }),
    appraisals: makeAppraisals({ staleCount: 1 }),
    relationships: makeRelationships({ noRecentActivityContacts: 1 }),
    activity: makeActivity({ activeDayRate: 0.1 }),
  });
  const recommendations = buildCoachRecommendations(context);
  assert.equal(recommendations.length, MAX_COACH_RECOMMENDATIONS);
  assert.match(recommendations[0].action, /Follow up on the 1 overdue commitment\./);
  assert.equal(recommendations[0].evidenceStrength, "Strong");
  assert.match(recommendations[1].action, /Review the 1 open opportunity with no recent contact\./);
  assert.match(recommendations[2].action, /Check in on the 1 appraisal with no recent update\./);
});

test("buildCoachRecommendations: every recommendation is evidence-based (has a reason) and carries a suggested timeframe and a progress measure", () => {
  const context = makeCoachContext({ commitments: makeCommitments({ currentlyOverdueCount: 1 }) });
  const [recommendation] = buildCoachRecommendations(context);
  assert.ok(recommendation.reason.length > 0);
  assert.ok(recommendation.suggestedTimeframe && recommendation.suggestedTimeframe.length > 0);
  assert.ok(recommendation.progressMeasure && recommendation.progressMeasure.length > 0);
});

test("buildCoachRecommendations: when nothing needs attention, falls back to a single 'keep up the routine' recommendation rather than an empty list", () => {
  const healthyContext = makeCoachContext({ activity: makeActivity({ activeDayRate: 0.7 }) });
  const recommendations = buildCoachRecommendations(healthyContext);
  assert.equal(recommendations.length, 1);
  assert.match(recommendations[0].action, /Keep up your current follow-up and prospecting routine\./);
});

// ---------------------------------------------------------------------------
// buildCoachSupportingMetrics
// ---------------------------------------------------------------------------

test("buildCoachSupportingMetrics: returns exactly six pre-formatted, self-documenting entries", () => {
  const context = makeCoachContext({
    activity: makeActivity({ activeDays: 5, totalDaysInPeriod: 7 }),
    commitments: makeCommitments({ completionRate: 0.625, currentlyOverdueCount: 2 }),
    opportunities: makeOpportunities({ openCount: 6, stalled: [{ opportunityId: 1, partyId: 1, stage: "New", daysSinceContact: 25 }] }),
    appraisals: makeAppraisals({ staleCount: 1 }),
  });
  const metrics = buildCoachSupportingMetrics(context);
  assert.equal(metrics.length, 6);
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  assert.equal(byKey.get("activeDays")?.value, "5 of 7");
  assert.equal(byKey.get("commitmentCompletionRate")?.value, "63%");
  assert.equal(byKey.get("overdueCommitments")?.value, "2");
  assert.equal(byKey.get("openOpportunities")?.value, "6");
  assert.equal(byKey.get("stalledOpportunities")?.value, "1");
  assert.equal(byKey.get("staleAppraisals")?.value, "1");
  for (const metric of metrics) {
    assert.ok(metric.definition.length > 0, `${metric.key} must carry a human-readable definition`);
  }
});

test("buildCoachSupportingMetrics: an undefined completion rate (no commitments due) is shown honestly, never as 0%", () => {
  const context = makeCoachContext({ commitments: makeCommitments({ completionRate: null, totalDue: 0 }) });
  const metrics = buildCoachSupportingMetrics(context);
  const rate = metrics.find((m) => m.key === "commitmentCompletionRate");
  assert.equal(rate?.value, "Not enough data");
});

// ---------------------------------------------------------------------------
// buildCoachLimitations
// ---------------------------------------------------------------------------

test("buildCoachLimitations: always includes the standard coaching disclaimers plus every metric's own limitations, deduplicated", () => {
  const sharedLimitation = "A shared limitation string that two different metrics both happen to disclose.";
  const context = makeCoachContext({
    activity: makeActivity({ limitations: [sharedLimitation] }),
    commitments: makeCommitments({ limitations: [sharedLimitation] }),
  });
  const limitations = buildCoachLimitations(context);
  for (const standard of COACH_STANDARD_LIMITATIONS) {
    assert.ok(limitations.includes(standard));
  }
  const occurrences = limitations.filter((l) => l === sharedLimitation).length;
  assert.equal(occurrences, 1, "a limitation repeated across two metrics must appear only once in the merged list");
});

// ---------------------------------------------------------------------------
// buildCoachSuggestedReviewDate
// ---------------------------------------------------------------------------

test("buildCoachSuggestedReviewDate: a weekly cadence for a short/custom period, fortnightly for a monthly-shaped one", () => {
  const now = new Date("2026-03-15T00:00:00.000Z");
  const weekly = buildCoachSuggestedReviewDate(makeCoachContext({ period: makePeriodView({ key: "last7days" }) }), now);
  assert.equal(weekly, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());

  for (const key of ["last30days", "currentMonth", "previousPeriod"] as const) {
    const fortnightly = buildCoachSuggestedReviewDate(makeCoachContext({ period: makePeriodView({ key }) }), now);
    assert.equal(fortnightly, new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(), `period key ${key} must use the fortnightly cadence`);
  }

  const customWeekly = buildCoachSuggestedReviewDate(makeCoachContext({ period: makePeriodView({ key: "custom" }) }), now);
  assert.equal(customWeekly, new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
});

test("buildCoachSuggestedReviewDate: REQUIRED CASE - the review date, read in the coaching timezone, lands exactly N days after TODAY'S LOCAL calendar date, even when the UTC calendar date already disagrees with the local one at the moment of asking", () => {
  // `now` is 20:00 UTC, which in Australia/Brisbane (+10:00, no DST) is
  // already 06:00 on the FOLLOWING day (16 March) - a suggested-review-date
  // calculation that silently used the UTC calendar day instead of the
  // resolved coaching timezone's local calendar day would land one day
  // early.
  const now = new Date("2026-03-15T20:00:00.000Z");
  const context = makeCoachContext({ period: makePeriodView({ key: "last7days", timeZone: "Australia/Brisbane", timeZoneSource: "fallback" }) });
  const reviewDateIso = buildCoachSuggestedReviewDate(context, now);
  assert.equal(
    localDateKey(new Date(reviewDateIso), "Australia/Brisbane"),
    "2026-03-23",
    "today is already 16 March in Brisbane local time, so a 7-day-cadence review date must land on 23 March local, not 22 March (the UTC calendar date's own +7)",
  );
});
