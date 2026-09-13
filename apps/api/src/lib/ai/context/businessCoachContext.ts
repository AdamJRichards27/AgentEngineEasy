// AE GROW Priority 6 Stage C — Business Coach context builder.
//
// Mirrors context/growContext.ts's own role in Stage B: the ONE place that
// assembles every deterministic coaching figure a Business Coach request can
// use, before the AI provider is ever called (see orchestrator.ts's
// askCopilot and coaching/responseBuilder.ts, which only ever read fields
// off the finished BusinessCoachContext — neither one queries the database
// or does its own arithmetic). Every fetch below is brokerageId-scoped by
// the coaching/metrics.ts function it calls; this file adds no query of its
// own beyond what those functions already do.
//
// Grow Today reuse: `grow` here is the SAME GrowContext contextEngine.ts
// already builds via buildGrowContext() for a plain Grow Ask AE request —
// this function never re-queries growToday.ts itself, per the Stage C
// authorisation's "don't duplicate Stage B tools/queries where composition
// suffices."
//
// Comparison reuse: "currently overdue"/"currently stale"/"currently open"
// facts are NOT period-bound (see metrics.ts's own comments), so the SAME
// overdue/stale/open row sets are reused for both the current and previous
// period's CommitmentPerformance/AppraisalMomentum/OpportunityPipelineHealth
// snapshots — only the period-bound "due in period"/"created in period"/
// "new in period" halves differ between them. This avoids two redundant
// "as of now" queries per request.
import {
  computeActivityConsistency,
  computeAppraisalMomentum,
  computeCommitmentPerformance,
  computeGrowTodayPatterns,
  computeOpportunityPipelineHealth,
  computePeriodComparison,
  computeRelationshipEngagement,
  fetchActiveRelationships,
  fetchActivityRows,
  fetchAppraisalsCreatedInPeriod,
  fetchCommitmentsDueInPeriod,
  fetchCurrentlyOverdueCommitments,
  fetchOpenOpportunities,
  fetchOpportunitiesCreatedInPeriod,
  fetchPromotedSignalOpportunityIds,
  fetchRecentActivityByParty,
  fetchStaleAppraisals,
  RECENT_ENGAGEMENT_THRESHOLD_DAYS,
} from "../coaching/metrics.js";
import { resolvePeriod, resolvePreviousComparablePeriod, toPeriodView, type CoachingPeriodKey } from "../coaching/period.js";
import type { BusinessCoachContext, GrowContext } from "../types.js";

export interface BuildBusinessCoachContextInput {
  period: CoachingPeriodKey;
  startDate?: string | null;
  endDate?: string | null;
  // Injectable so this function (and everything it calls) is deterministic
  // and testable without depending on the real wall clock.
  now?: Date;
}

export async function buildBusinessCoachContext(
  brokerageId: number,
  grow: GrowContext | null,
  input: BuildBusinessCoachContextInput,
): Promise<BusinessCoachContext> {
  const now = input.now ?? new Date();
  const period = resolvePeriod({ period: input.period, startDate: input.startDate, endDate: input.endDate, now });
  const previousPeriod = resolvePreviousComparablePeriod(period);
  const recentSince = new Date(now.getTime() - RECENT_ENGAGEMENT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  const [
    activityRows,
    previousActivityRows,
    dueCommitmentRows,
    previousDueCommitmentRows,
    overdueCommitmentRows,
    appraisalCreatedRows,
    previousAppraisalCreatedRows,
    staleAppraisalRows,
    openOpportunityRows,
    opportunityCreatedRows,
    previousOpportunityCreatedRows,
    promotedOpportunityIds,
    relationshipRows,
    recentActivityRows,
  ] = await Promise.all([
    fetchActivityRows(brokerageId, period),
    fetchActivityRows(brokerageId, previousPeriod),
    fetchCommitmentsDueInPeriod(brokerageId, period),
    fetchCommitmentsDueInPeriod(brokerageId, previousPeriod),
    fetchCurrentlyOverdueCommitments(brokerageId, now),
    fetchAppraisalsCreatedInPeriod(brokerageId, period),
    fetchAppraisalsCreatedInPeriod(brokerageId, previousPeriod),
    fetchStaleAppraisals(brokerageId, now),
    fetchOpenOpportunities(brokerageId),
    fetchOpportunitiesCreatedInPeriod(brokerageId, period),
    fetchOpportunitiesCreatedInPeriod(brokerageId, previousPeriod),
    fetchPromotedSignalOpportunityIds(brokerageId),
    fetchActiveRelationships(brokerageId),
    fetchRecentActivityByParty(brokerageId, recentSince),
  ]);

  const activity = computeActivityConsistency(activityRows, period);
  const previousActivity = computeActivityConsistency(previousActivityRows, previousPeriod);
  const commitments = computeCommitmentPerformance(dueCommitmentRows, overdueCommitmentRows, period, now);
  const previousCommitments = computeCommitmentPerformance(previousDueCommitmentRows, overdueCommitmentRows, previousPeriod, now);
  const appraisalsMetric = computeAppraisalMomentum(appraisalCreatedRows, staleAppraisalRows, period, now);
  const previousAppraisals = computeAppraisalMomentum(previousAppraisalCreatedRows, staleAppraisalRows, previousPeriod, now);
  const opportunities = computeOpportunityPipelineHealth(openOpportunityRows, opportunityCreatedRows, promotedOpportunityIds, period, now);
  const previousOpportunities = computeOpportunityPipelineHealth(openOpportunityRows, previousOpportunityCreatedRows, promotedOpportunityIds, previousPeriod, now);
  const relationships = computeRelationshipEngagement(relationshipRows, recentActivityRows);
  const growToday = computeGrowTodayPatterns(grow);
  const comparison = computePeriodComparison(
    { period, activity, commitments, appraisals: appraisalsMetric, opportunities },
    { period: previousPeriod, activity: previousActivity, commitments: previousCommitments, appraisals: previousAppraisals, opportunities: previousOpportunities },
  );

  return {
    asOf: now.toISOString(),
    period: toPeriodView(period),
    previousPeriod: toPeriodView(previousPeriod),
    activity,
    commitments,
    appraisals: appraisalsMetric,
    opportunities,
    relationships,
    growToday,
    comparison,
  };
}
