// AE GROW Priority 6 Stage C — Business Coach response builder.
//
// Every function here is PURE and DETERMINISTIC: it reads only the already-
// computed BusinessCoachContext (coaching/metrics.ts's output) and produces
// plain text/structured fields — never a database call, never the AI
// provider, never today's real wall clock (a `now` is always passed in
// where one is needed). This is deliberate: the "no model-arithmetic" /
// "never let the model recompute a metric" requirement is enforced by
// construction here, not by asking the model nicely in the prompt — every
// number in a coaching response is produced by this file (or copied
// verbatim from BusinessCoachContext), and the model's own generated text
// (orchestrator.ts's `generation.response.text`) becomes the response's
// free-text `summary` narrative alongside these fields, never a source of
// truth for a figure.
//
// Mirrors orchestrator.ts's existing small Grow helpers (buildGrowSupportingRecords,
// buildGrowSuggestedNextStep, GROW_LIMITATIONS) — kept in their own file
// rather than inline in orchestrator.ts because this rule engine is
// materially larger and benefits from its own focused unit tests.
import { MIN_SAMPLE_SIZE_FOR_TREND, RECENT_ENGAGEMENT_THRESHOLD_DAYS, STALE_APPRAISAL_DAYS, STALL_THRESHOLD_DAYS } from "../coaching/metrics.js";
import type { PeriodView } from "../coaching/period.js";
import type { BusinessCoachContext, CoachingRecommendation, CoachingSupportingMetric } from "../types.js";

export const MAX_COACH_RECOMMENDATIONS = 3;

// Restated in the response payload itself (not only the system prompt) for
// the same reason Stage B's GROW_LIMITATIONS is — a consumer of this API
// that renders the structured fields without also rendering the system
// prompt must still see these constraints.
export const COACH_STANDARD_LIMITATIONS: string[] = [
  "This coaching answer is based only on data already recorded in Grow — it is not a live check of any external source and does not know about calls, emails, or meetings that were never logged.",
  "AE has no information about a contact's private plans or motivations, and does not predict who is likely to buy or sell.",
  "These are suggestions for you to consider, not instructions AE has carried out or will carry out — they do not replace your own professional judgement.",
];

function periodPhrase(period: PeriodView): string {
  switch (period.key) {
    case "last7days":
      return "your last 7 days";
    case "last30days":
      return "your last 30 days";
    case "currentMonth":
      return "this month so far";
    case "previousPeriod":
      return "last month";
    default:
      return `the period from ${period.start.slice(0, 10)} to ${period.end.slice(0, 10)}`;
  }
}

export function buildCoachHeadline(coach: BusinessCoachContext): string {
  return `A look at ${periodPhrase(coach.period)}`;
}

export function buildCoachPerformanceSummary(coach: BusinessCoachContext): string {
  const parts: string[] = [];

  parts.push(
    `The available data shows ${coach.activity.totalActivities} recorded ${coach.activity.totalActivities === 1 ? "activity" : "activities"} across ${coach.activity.activeDays} of the last ${coach.activity.totalDaysInPeriod} days.`,
  );

  if (coach.commitments.totalDue > 0 && coach.commitments.completionRate !== null) {
    const pct = Math.round(coach.commitments.completionRate * 100);
    parts.push(`${coach.commitments.completed} of ${coach.commitments.totalDue} commitments due in this period were completed (${pct}%).`);
  } else {
    parts.push("There is not yet enough information to determine a commitment completion rate for this period.");
  }

  parts.push(`${coach.opportunities.openCount} opportunities are currently open, with ${coach.opportunities.newInPeriod} new in this period.`);

  if (coach.appraisals.created > 0) {
    parts.push(`${coach.appraisals.created} ${coach.appraisals.created === 1 ? "appraisal was" : "appraisals were"} created in this period.`);
  }

  return parts.join(" ");
}

export function buildCoachObservations(coach: BusinessCoachContext): string[] {
  const observations: string[] = [];

  for (const delta of coach.comparison.deltas) {
    if (delta.direction === "insufficient_data") continue;
    if (delta.direction === "stable") {
      observations.push(`${delta.label} was stable compared with the previous period.`);
      continue;
    }
    const verb = delta.direction === "increased" ? "increased" : "decreased";
    const pct = delta.percentChange !== null ? ` (${delta.percentChange > 0 ? "+" : ""}${Math.round(delta.percentChange)}%)` : "";
    observations.push(`${delta.label} ${verb}${pct} compared with the previous period.`);
  }

  if (coach.commitments.currentlyOverdueCount > 0) {
    observations.push(
      `This may warrant attention because ${coach.commitments.currentlyOverdueCount} ${coach.commitments.currentlyOverdueCount === 1 ? "commitment is" : "commitments are"} currently overdue.`,
    );
  }
  if (coach.opportunities.stalled.length > 0) {
    observations.push(
      `This may warrant attention because ${coach.opportunities.stalled.length} open ${coach.opportunities.stalled.length === 1 ? "opportunity has" : "opportunities have"} had no recorded contact in ${STALL_THRESHOLD_DAYS}+ days.`,
    );
  }
  if (coach.appraisals.staleCount > 0) {
    observations.push(
      `This may warrant attention because ${coach.appraisals.staleCount} ${coach.appraisals.staleCount === 1 ? "appraisal has" : "appraisals have"} had no update in ${STALE_APPRAISAL_DAYS}+ days.`,
    );
  }

  return observations;
}

export function buildCoachStrengths(coach: BusinessCoachContext): string[] {
  const strengths: string[] = [];

  if (coach.commitments.completionRate !== null && coach.commitments.totalDue >= MIN_SAMPLE_SIZE_FOR_TREND && coach.commitments.completionRate >= 0.8) {
    strengths.push(`A strong commitment completion rate (${Math.round(coach.commitments.completionRate * 100)}%) over this period.`);
  }
  if (coach.commitments.currentlyOverdueCount === 0) {
    strengths.push("No commitments are currently overdue.");
  }
  if (coach.opportunities.openCount > 0 && coach.opportunities.stalled.length === 0) {
    strengths.push("No open opportunities currently show signs of stalling.");
  }
  if (coach.activity.activeDayRate !== null && coach.activity.activeDayRate >= 0.6) {
    strengths.push(`Activity was recorded on ${coach.activity.activeDays} of ${coach.activity.totalDaysInPeriod} days in this period, a consistent pattern.`);
  }

  return strengths;
}

export function buildCoachFocusAreas(coach: BusinessCoachContext): string[] {
  const focusAreas: string[] = [];

  if (coach.commitments.currentlyOverdueCount > 0) {
    focusAreas.push(`${coach.commitments.currentlyOverdueCount} overdue ${coach.commitments.currentlyOverdueCount === 1 ? "commitment" : "commitments"}.`);
  }
  if (coach.opportunities.stalled.length > 0) {
    focusAreas.push(`${coach.opportunities.stalled.length} open ${coach.opportunities.stalled.length === 1 ? "opportunity" : "opportunities"} with no recent contact.`);
  }
  if (coach.appraisals.staleCount > 0) {
    focusAreas.push(`${coach.appraisals.staleCount} ${coach.appraisals.staleCount === 1 ? "appraisal" : "appraisals"} with no recent update.`);
  }
  if (coach.relationships.noRecentActivityContacts > 0) {
    focusAreas.push(`${coach.relationships.noRecentActivityContacts} contacts with no activity recorded in the last ${RECENT_ENGAGEMENT_THRESHOLD_DAYS} days.`);
  }
  if (coach.activity.totalActivities === 0) {
    focusAreas.push("No activity was recorded in this period.");
  }

  return focusAreas;
}

interface RecommendationCandidate {
  priority: number;
  recommendation: CoachingRecommendation;
}

// Every candidate is evidence-based (only fires when the underlying metric
// says so), phrased as a suggestion, carries a suggested timeframe and a way
// to measure progress, and is capped at MAX_COACH_RECOMMENDATIONS — never
// more "high-value priorities" than the Stage C authorisation allows.
export function buildCoachRecommendations(coach: BusinessCoachContext): CoachingRecommendation[] {
  const candidates: RecommendationCandidate[] = [];

  if (coach.commitments.currentlyOverdueCount > 0) {
    candidates.push({
      priority: 100 + coach.commitments.currentlyOverdueCount,
      recommendation: {
        action: `Follow up on the ${coach.commitments.currentlyOverdueCount} overdue ${coach.commitments.currentlyOverdueCount === 1 ? "commitment" : "commitments"}.`,
        reason: "The available data shows these commitments have passed their due date without being marked complete.",
        relatedMetric: "commitmentPerformance.currentlyOverdueCount",
        suggestedTimeframe: "This week",
        progressMeasure: "Progress could be measured by the number of overdue commitments falling to zero.",
        evidenceStrength: "Strong",
      },
    });
  }

  if (coach.opportunities.stalled.length > 0) {
    candidates.push({
      priority: 90 + coach.opportunities.stalled.length,
      recommendation: {
        action: `Review the ${coach.opportunities.stalled.length} open ${coach.opportunities.stalled.length === 1 ? "opportunity" : "opportunities"} with no recent contact.`,
        reason: `This may warrant attention because these opportunities have had no recorded contact in ${STALL_THRESHOLD_DAYS} days or more.`,
        relatedMetric: "opportunityPipelineHealth.stalled",
        suggestedTimeframe: "This week",
        progressMeasure: "Progress could be measured by a recorded contact or an updated stage on each opportunity.",
        evidenceStrength: "Moderate",
      },
    });
  }

  if (coach.appraisals.staleCount > 0) {
    candidates.push({
      priority: 80 + coach.appraisals.staleCount,
      recommendation: {
        action: `Check in on the ${coach.appraisals.staleCount} ${coach.appraisals.staleCount === 1 ? "appraisal" : "appraisals"} with no recent update.`,
        reason: `This may warrant attention because these appraisals have not been updated in ${STALE_APPRAISAL_DAYS} days or more.`,
        relatedMetric: "appraisalMomentum.staleCount",
        suggestedTimeframe: "This week",
        progressMeasure: "Progress could be measured by an updated status or follow-up date on each appraisal.",
        evidenceStrength: "Moderate",
      },
    });
  }

  if (coach.relationships.noRecentActivityContacts > 0) {
    candidates.push({
      priority: 70 + Math.min(coach.relationships.noRecentActivityContacts, 20),
      recommendation: {
        action: `Reconnect with ${coach.relationships.noRecentActivityContacts} contacts with no recent activity.`,
        reason: `The available data shows no recorded activity with these contacts in the last ${RECENT_ENGAGEMENT_THRESHOLD_DAYS} days.`,
        relatedMetric: "relationshipEngagement.noRecentActivityContacts",
        suggestedTimeframe: "This month",
        progressMeasure: "Progress could be measured by a recorded activity against each contact.",
        evidenceStrength: "Preliminary",
      },
    });
  }

  if (coach.activity.activeDayRate !== null && coach.activity.activeDayRate < 0.3) {
    candidates.push({
      priority: 60,
      recommendation: {
        action: "Aim for more consistent daily prospecting activity.",
        reason: `The available data shows activity was recorded on ${coach.activity.activeDays} of ${coach.activity.totalDaysInPeriod} days in this period.`,
        relatedMetric: "activityConsistency.activeDayRate",
        suggestedTimeframe: "Next period",
        progressMeasure: "Progress could be measured by an increase in active days next period.",
        evidenceStrength: "Preliminary",
      },
    });
  }

  if (candidates.length === 0) {
    return [
      {
        action: "Keep up your current follow-up and prospecting routine.",
        reason: "The available data does not show any overdue commitments, stalled opportunities, or stale appraisals in this period.",
        suggestedTimeframe: "Ongoing",
        progressMeasure: "Progress could be measured by maintaining current activity and completion levels next period.",
        evidenceStrength: "Preliminary",
      },
    ];
  }

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .slice(0, MAX_COACH_RECOMMENDATIONS)
    .map((candidate) => candidate.recommendation);
}

export function buildCoachSupportingMetrics(coach: BusinessCoachContext): CoachingSupportingMetric[] {
  return [
    {
      key: "activeDays",
      label: "Active days",
      value: `${coach.activity.activeDays} of ${coach.activity.totalDaysInPeriod}`,
      definition: "Calendar days in the period with at least one recorded Grow activity.",
    },
    {
      key: "commitmentCompletionRate",
      label: "Commitment completion rate",
      value: coach.commitments.completionRate !== null ? `${Math.round(coach.commitments.completionRate * 100)}%` : "Not enough data",
      definition: "Commitments due in the period that were marked Completed, divided by all commitments due in the period.",
    },
    {
      key: "overdueCommitments",
      label: "Currently overdue commitments",
      value: String(coach.commitments.currentlyOverdueCount),
      definition: "Open commitments whose due date has already passed, as of now.",
    },
    {
      key: "openOpportunities",
      label: "Open opportunities",
      value: String(coach.opportunities.openCount),
      definition: "Opportunities with status Open, as of now.",
    },
    {
      key: "stalledOpportunities",
      label: "Stalled opportunities",
      value: String(coach.opportunities.stalled.length),
      definition: `Open opportunities with no recorded contact in ${STALL_THRESHOLD_DAYS}+ days.`,
    },
    {
      key: "staleAppraisals",
      label: "Appraisals needing an update",
      value: String(coach.appraisals.staleCount),
      definition: `Non-final appraisals with no update in ${STALE_APPRAISAL_DAYS}+ days.`,
    },
  ];
}

export function buildCoachLimitations(coach: BusinessCoachContext): string[] {
  const limitations = new Set<string>(COACH_STANDARD_LIMITATIONS);
  for (const l of coach.activity.limitations) limitations.add(l);
  for (const l of coach.commitments.limitations) limitations.add(l);
  for (const l of coach.appraisals.limitations) limitations.add(l);
  for (const l of coach.opportunities.limitations) limitations.add(l);
  for (const l of coach.relationships.limitations) limitations.add(l);
  for (const l of coach.growToday.limitations) limitations.add(l);
  for (const l of coach.comparison.limitations) limitations.add(l);
  return Array.from(limitations);
}

// A weekly cadence for a short (last7days/custom) period, fortnightly for a
// monthly-shaped one — deliberately simple and documented rather than a
// "smart" schedule with no basis in the data.
export function buildCoachSuggestedReviewDate(coach: BusinessCoachContext, now: Date): string {
  const longCadenceKeys = new Set(["last30days", "currentMonth", "previousPeriod"]);
  const days = longCadenceKeys.has(coach.period.key) ? 14 : 7;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
