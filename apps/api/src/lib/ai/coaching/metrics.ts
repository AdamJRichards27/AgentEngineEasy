// AE GROW Priority 6 Stage C — Business Coach coaching metrics service.
//
// Every metric below is split into a thin, tenant-scoped, capped DB-fetch
// function (fetchX) and a pure, exported, independently-unit-testable
// compute function (computeX) that operates only on plain fetched row
// arrays — mirroring orchestrator.ts's own classifyGrowResponseKind-style
// pure-function pattern and Stage C's own period.ts. No compute function
// ever touches the database, the clock (a `now`/`period` is always passed
// in), or the AI provider — every number a coaching response can state is
// therefore produced HERE, deterministically, before the model is ever
// called (see coaching/responseBuilder.ts and orchestrator.ts's askCopilot).
//
// Tenant isolation: every fetch function takes brokerageId as its first
// argument and scopes its query by it directly (or, for `appraisals` — which
// carries no brokerageId column of its own — via an inner join to
// `properties.brokerageId`, the same pattern lib/growToday.ts already uses
// for the exact same table). None of these functions accept a client-
// supplied tenant filter. An optional restrictToPropertyIds argument is the
// caller's own restrictedPropertyIdsFor result (null, the default, leaves
// the brokerage-wide query unchanged) and is not a tenant selector.
//
// Bounding: every list is capped by one of the *_ROW_CAP constants below
// before it reaches a compute function, and every compute function reports
// whether its input was truncated so a coaching response can say so rather
// than silently presenting a partial count as complete.
//
// Timezone: periods are resolved by coaching/period.ts against the
// brokerage's resolved local timezone (coaching/timezone.ts) — AE GROW
// Priority 6 Stage C's timezone remediation. Every date comparison here
// still arrives as a plain Date needing no further handling EXCEPT
// computeActivityConsistency's own "which calendar day is this activity
// on" bucketing below, which must bucket by the period's resolved local
// calendar day (period.timeZone), not a bare UTC date slice — see that
// function's own comment for why.
import { and, asc, desc, eq, gte, isNotNull, lt, notInArray } from "drizzle-orm";
import { visibleLinkedPropertySql, visibleRequiredPropertySql } from "../../propertyVisibility.js";
import {
  db,
  appraisals,
  growActivities,
  growCommitments,
  growOpportunities,
  growOpportunitySignals,
  growRelationships,
  properties,
} from "@aee/db";
import { resolvePreviousComparablePeriod, toPeriodView, type PeriodView, type ResolvedPeriod } from "./period.js";
import { localDateKey } from "./timezone.js";
import type { GrowContext } from "../types.js";

// ---------------------------------------------------------------------------
// Shared bounds and thresholds — documented, adjustable constants rather than
// magic numbers buried in query/compute logic, matching this codebase's own
// established style (see growToday.ts's COLD_CONTACT_THRESHOLD_DAYS).
// ---------------------------------------------------------------------------

export const ACTIVITY_ROW_CAP = 2000;
export const COMMITMENT_ROW_CAP = 2000;
export const OPPORTUNITY_ROW_CAP = 1000;
export const APPRAISAL_ROW_CAP = 500;
export const RELATIONSHIP_ROW_CAP = 2000;
export const SIGNAL_ROW_CAP = 500;

export const STALLED_LIST_CAP = 10;
export const REPEATED_OVERDUE_LIST_CAP = 10;
export const NO_RECENT_ACTIVITY_LIST_CAP = 10;

// Reuses growToday.ts's own COLD_CONTACT_THRESHOLD_DAYS value (21) rather
// than inventing a second, different "how long is too long" number for the
// same underlying concept of relationship/opportunity staleness.
export const STALL_THRESHOLD_DAYS = 21;
export const STALE_APPRAISAL_DAYS = 21;
export const RECENT_ENGAGEMENT_THRESHOLD_DAYS = 21;

export const REPEATED_OVERDUE_THRESHOLD = 2;
export const MIN_SAMPLE_SIZE_FOR_TREND = 3;

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

// ---------------------------------------------------------------------------
// Activity consistency
// ---------------------------------------------------------------------------

export interface ActivityRow {
  id: number;
  partyId: number | null;
  activityType: string;
  occurredAt: Date;
}

export async function fetchActivityRows(
  brokerageId: number,
  period: ResolvedPeriod,
  restrictToPropertyIds: number[] | null = null,
): Promise<ActivityRow[]> {
  return db
    .select({ id: growActivities.id, partyId: growActivities.partyId, activityType: growActivities.activityType, occurredAt: growActivities.occurredAt })
    .from(growActivities)
    .where(and(
      eq(growActivities.brokerageId, brokerageId),
      gte(growActivities.occurredAt, period.start),
      lt(growActivities.occurredAt, period.end),
      visibleLinkedPropertySql(growActivities.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(growActivities.occurredAt))
    .limit(ACTIVITY_ROW_CAP);
}

export interface ActivityConsistencyMetric {
  period: PeriodView;
  sampleSize: number;
  truncated: boolean;
  totalActivities: number;
  activitiesByType: Record<string, number>;
  activeDays: number;
  totalDaysInPeriod: number;
  activeDayRate: number | null;
  longestGapDays: number | null;
  limitations: string[];
}

// Definition: totalActivities = every growActivities row recorded in the
// period (brokerageId-scoped). activeDays = distinct LOCAL calendar days
// (in the period's resolved timezone, coaching/timezone.ts) within the
// period that have at least one such row. activeDayRate = activeDays /
// totalDaysInPeriod. longestGapDays = the longest run of consecutive
// inactive days between two active days (null when fewer than two active
// days exist — a single data point cannot describe a gap).
export function computeActivityConsistency(rows: ActivityRow[], period: ResolvedPeriod): ActivityConsistencyMetric {
  const activitiesByType: Record<string, number> = {};
  const activeDaySet = new Set<string>();
  for (const row of rows) {
    activitiesByType[row.activityType] = (activitiesByType[row.activityType] ?? 0) + 1;
    // AE GROW Priority 6 Stage C timezone remediation: bucket by the
    // period's resolved LOCAL calendar day, not a bare UTC date slice — an
    // activity logged late at night in an AU/NZ zone (e.g. 11pm AEDT) can
    // fall on the FOLLOWING UTC calendar date, which previously miscounted
    // it against the wrong day for any agent outside UTC entirely.
    activeDaySet.add(localDateKey(row.occurredAt, period.timeZone));
  }

  const activeDays = activeDaySet.size;
  const totalDaysInPeriod = Math.max(1, period.durationDays);
  const activeDayRate = activeDays / totalDaysInPeriod;

  let longestGapDays: number | null = null;
  if (activeDays >= 2) {
    const sortedDays = Array.from(activeDaySet).sort();
    let maxGap = 0;
    // Each entry in sortedDays is a "yyyy-mm-dd" LOCAL calendar-day key
    // (localDateKey). Anchoring each one to UTC midnight here is only a
    // convenient way to get a Date object for whole-day subtraction — it
    // does not reinterpret the key as a UTC date, and the resulting day
    // COUNT between two such anchors is identical regardless of which real
    // timezone the keys came from, since both use the same anchoring
    // convention consistently.
    for (let i = 1; i < sortedDays.length; i++) {
      const prev = new Date(`${sortedDays[i - 1]}T00:00:00.000Z`);
      const curr = new Date(`${sortedDays[i]}T00:00:00.000Z`);
      const gap = daysBetween(curr, prev);
      if (gap > maxGap) maxGap = gap;
    }
    longestGapDays = maxGap;
  }

  const limitations: string[] = [];
  if (rows.length >= ACTIVITY_ROW_CAP) {
    limitations.push(
      `This period has at least ${ACTIVITY_ROW_CAP} recorded activities; consistency figures are based on the first ${ACTIVITY_ROW_CAP} in date order and may not reflect the full period.`,
    );
  }
  if (!period.isComplete) {
    limitations.push("This period is still in progress, so its activity rate is not directly comparable to a completed period.");
  }

  return {
    period: toPeriodView(period),
    sampleSize: rows.length,
    truncated: rows.length >= ACTIVITY_ROW_CAP,
    totalActivities: rows.length,
    activitiesByType,
    activeDays,
    totalDaysInPeriod,
    activeDayRate,
    longestGapDays,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Commitment performance
// ---------------------------------------------------------------------------

export interface CommitmentRow {
  id: number;
  partyId: number;
  dueAt: Date;
  status: string; // Open | Completed | Cancelled
  completedAt: Date | null;
}

export async function fetchCommitmentsDueInPeriod(
  brokerageId: number,
  period: ResolvedPeriod,
  restrictToPropertyIds: number[] | null = null,
): Promise<CommitmentRow[]> {
  return db
    .select({ id: growCommitments.id, partyId: growCommitments.partyId, dueAt: growCommitments.dueAt, status: growCommitments.status, completedAt: growCommitments.completedAt })
    .from(growCommitments)
    .where(and(
      eq(growCommitments.brokerageId, brokerageId),
      gte(growCommitments.dueAt, period.start),
      lt(growCommitments.dueAt, period.end),
      visibleLinkedPropertySql(growCommitments.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(growCommitments.dueAt))
    .limit(COMMITMENT_ROW_CAP);
}

// "Currently overdue" is deliberately NOT period-bound — an overdue
// commitment from before the requested period is still overdue right now,
// and hiding it because it fell due before the period started would
// understate what the agent actually needs to act on today.
export async function fetchCurrentlyOverdueCommitments(
  brokerageId: number,
  now: Date,
  restrictToPropertyIds: number[] | null = null,
): Promise<CommitmentRow[]> {
  return db
    .select({ id: growCommitments.id, partyId: growCommitments.partyId, dueAt: growCommitments.dueAt, status: growCommitments.status, completedAt: growCommitments.completedAt })
    .from(growCommitments)
    .where(and(
      eq(growCommitments.brokerageId, brokerageId),
      eq(growCommitments.status, "Open"),
      lt(growCommitments.dueAt, now),
      visibleLinkedPropertySql(growCommitments.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(growCommitments.dueAt))
    .limit(COMMITMENT_ROW_CAP);
}

export interface CommitmentPerformanceMetric {
  period: PeriodView;
  sampleSize: number;
  truncated: boolean;
  totalDue: number;
  completed: number;
  completionRate: number | null;
  currentlyOverdueCount: number;
  currentlyOverdueTruncated: boolean;
  averageOverdueAgeDays: number | null;
  repeatedOverdueContacts: Array<{ partyId: number; overdueCount: number }>;
  repeatedOverdueTruncated: boolean;
  limitations: string[];
}

// Definition: totalDue = commitments whose dueAt falls in the period
// (regardless of current status). completed = of those, status ===
// "Completed". completionRate = completed / totalDue (null when totalDue is
// 0 — there is nothing to divide by, not a 0% rate). currentlyOverdueCount /
// averageOverdueAgeDays / repeatedOverdueContacts are all computed from the
// separate "as of now" overdue fetch, not from the period-bound one.
export function computeCommitmentPerformance(
  dueInPeriodRows: CommitmentRow[],
  currentlyOverdueRows: CommitmentRow[],
  period: ResolvedPeriod,
  now: Date,
): CommitmentPerformanceMetric {
  const totalDue = dueInPeriodRows.length;
  const completed = dueInPeriodRows.filter((row) => row.status === "Completed").length;
  const completionRate = totalDue > 0 ? completed / totalDue : null;

  const overdueByParty = new Map<number, number>();
  for (const row of currentlyOverdueRows) {
    overdueByParty.set(row.partyId, (overdueByParty.get(row.partyId) ?? 0) + 1);
  }
  const repeatedOverdueContactsAll = Array.from(overdueByParty.entries())
    .filter(([, count]) => count >= REPEATED_OVERDUE_THRESHOLD)
    .map(([partyId, overdueCount]) => ({ partyId, overdueCount }))
    .sort((a, b) => b.overdueCount - a.overdueCount);

  const overdueAges = currentlyOverdueRows.map((row) => daysBetween(now, row.dueAt));
  const averageOverdueAgeDays = overdueAges.length > 0 ? overdueAges.reduce((a, b) => a + b, 0) / overdueAges.length : null;

  const limitations: string[] = [];
  if (dueInPeriodRows.length >= COMMITMENT_ROW_CAP) {
    limitations.push(`This period has at least ${COMMITMENT_ROW_CAP} commitments due; completion figures are based on the first ${COMMITMENT_ROW_CAP} in due-date order.`);
  }
  if (totalDue === 0) {
    limitations.push("No commitments were due in this period, so a completion rate cannot be calculated.");
  }
  if (!period.isComplete) {
    limitations.push("This period is still in progress; some commitments due later in the period may not yet show as completed.");
  }

  return {
    period: toPeriodView(period),
    sampleSize: totalDue,
    truncated: dueInPeriodRows.length >= COMMITMENT_ROW_CAP,
    totalDue,
    completed,
    completionRate,
    currentlyOverdueCount: currentlyOverdueRows.length,
    currentlyOverdueTruncated: currentlyOverdueRows.length >= COMMITMENT_ROW_CAP,
    averageOverdueAgeDays,
    repeatedOverdueContacts: repeatedOverdueContactsAll.slice(0, REPEATED_OVERDUE_LIST_CAP),
    repeatedOverdueTruncated: repeatedOverdueContactsAll.length > REPEATED_OVERDUE_LIST_CAP,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Appraisal momentum
// ---------------------------------------------------------------------------

export interface AppraisalRow {
  id: number;
  partyId: number | null;
  propertyId: number;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  followUpAt: Date | null;
  outcome: string | null;
}

const APPRAISAL_TERMINAL_STATUSES = ["WON", "LOST", "DEFERRED", "ARCHIVED"] as const;

const APPRAISAL_SELECT_COLUMNS = {
  id: appraisals.id,
  partyId: appraisals.partyId,
  propertyId: appraisals.propertyId,
  status: appraisals.status,
  createdAt: appraisals.createdAt,
  updatedAt: appraisals.updatedAt,
  followUpAt: appraisals.followUpAt,
  outcome: appraisals.outcome,
} as const;

// appraisals carries no brokerageId column of its own — tenant scoping is
// via an inner join to properties.brokerageId, exactly mirroring
// growToday.ts's own appraisal query.
export async function fetchAppraisalsCreatedInPeriod(
  brokerageId: number,
  period: ResolvedPeriod,
  restrictToPropertyIds: number[] | null = null,
): Promise<AppraisalRow[]> {
  return db
    .select(APPRAISAL_SELECT_COLUMNS)
    .from(appraisals)
    .innerJoin(properties, eq(appraisals.propertyId, properties.id))
    .where(and(
      eq(properties.brokerageId, brokerageId),
      gte(appraisals.createdAt, period.start),
      lt(appraisals.createdAt, period.end),
      visibleRequiredPropertySql(appraisals.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(appraisals.createdAt))
    .limit(APPRAISAL_ROW_CAP);
}

// "Stale" is deliberately NOT period-bound, for the same reason overdue
// commitments aren't: an appraisal that has sat untouched since before the
// requested period is still stale right now. Terminal-status appraisals
// (WON/LOST/DEFERRED/ARCHIVED) are excluded in the query itself (not
// filtered afterwards) so a long-closed appraisal — which by definition
// will never be updated again — can never crowd a genuinely stale, still-
// open appraisal out of the capped result.
export async function fetchStaleAppraisals(
  brokerageId: number,
  now: Date,
  restrictToPropertyIds: number[] | null = null,
): Promise<AppraisalRow[]> {
  const staleThreshold = new Date(now.getTime() - STALE_APPRAISAL_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select(APPRAISAL_SELECT_COLUMNS)
    .from(appraisals)
    .innerJoin(properties, eq(appraisals.propertyId, properties.id))
    .where(and(
      eq(properties.brokerageId, brokerageId),
      lt(appraisals.updatedAt, staleThreshold),
      notInArray(appraisals.status, [...APPRAISAL_TERMINAL_STATUSES]),
      visibleRequiredPropertySql(appraisals.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(appraisals.updatedAt))
    .limit(APPRAISAL_ROW_CAP);
}

export interface AppraisalMomentumMetric {
  period: PeriodView;
  sampleSize: number;
  truncated: boolean;
  created: number;
  byStatus: Record<string, number>;
  wonCount: number;
  lostCount: number;
  followUpDueCount: number;
  staleCount: number;
  staleTruncated: boolean;
  limitations: string[];
}

// Definition: created = appraisals whose createdAt falls in the period.
// byStatus/wonCount/lostCount describe the CURRENT status/outcome of those
// same appraisals (not a history of status changes — this schema does not
// record appraisal status transitions over time, only the current row).
// followUpDueCount = of those, status "FOLLOW_UP" with followUpAt already
// due. staleCount/staleTruncated come from the separate "as of now" stale
// fetch, independent of the period.
export function computeAppraisalMomentum(
  createdInPeriodRows: AppraisalRow[],
  staleRows: AppraisalRow[],
  period: ResolvedPeriod,
  now: Date,
): AppraisalMomentumMetric {
  const byStatus: Record<string, number> = {};
  let wonCount = 0;
  let lostCount = 0;
  let followUpDueCount = 0;
  for (const row of createdInPeriodRows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.outcome === "WON") wonCount++;
    if (row.outcome === "LOST") lostCount++;
    if (row.status === "FOLLOW_UP" && row.followUpAt !== null && row.followUpAt.getTime() <= now.getTime()) {
      followUpDueCount++;
    }
  }

  const limitations: string[] = [
    "This reports the current status of appraisals created in this period, not a history of how each appraisal's status has changed over time — that history isn't recorded in this build.",
  ];
  if (createdInPeriodRows.length >= APPRAISAL_ROW_CAP) {
    limitations.push(`At least ${APPRAISAL_ROW_CAP} appraisals were created in this period; figures are based on the first ${APPRAISAL_ROW_CAP} in date order.`);
  }
  if (createdInPeriodRows.length === 0) {
    limitations.push("No appraisals were created in this period.");
  }

  return {
    period: toPeriodView(period),
    sampleSize: createdInPeriodRows.length,
    truncated: createdInPeriodRows.length >= APPRAISAL_ROW_CAP,
    created: createdInPeriodRows.length,
    byStatus,
    wonCount,
    lostCount,
    followUpDueCount,
    staleCount: staleRows.length,
    staleTruncated: staleRows.length >= APPRAISAL_ROW_CAP,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Opportunity pipeline health
// ---------------------------------------------------------------------------

export interface OpportunityRow {
  id: number;
  partyId: number;
  stage: string;
  nextActionDueAt: Date | null;
  lastMeaningfulContactAt: Date | null;
  createdAt: Date;
}

const OPPORTUNITY_SELECT_COLUMNS = {
  id: growOpportunities.id,
  partyId: growOpportunities.partyId,
  stage: growOpportunities.stage,
  nextActionDueAt: growOpportunities.nextActionDueAt,
  lastMeaningfulContactAt: growOpportunities.lastMeaningfulContactAt,
  createdAt: growOpportunities.createdAt,
} as const;

export async function fetchOpenOpportunities(
  brokerageId: number,
  restrictToPropertyIds: number[] | null = null,
): Promise<OpportunityRow[]> {
  return db
    .select(OPPORTUNITY_SELECT_COLUMNS)
    .from(growOpportunities)
    .where(and(
      eq(growOpportunities.brokerageId, brokerageId),
      eq(growOpportunities.status, "Open"),
      visibleLinkedPropertySql(growOpportunities.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(growOpportunities.createdAt))
    .limit(OPPORTUNITY_ROW_CAP);
}

export async function fetchOpportunitiesCreatedInPeriod(
  brokerageId: number,
  period: ResolvedPeriod,
  restrictToPropertyIds: number[] | null = null,
): Promise<OpportunityRow[]> {
  return db
    .select(OPPORTUNITY_SELECT_COLUMNS)
    .from(growOpportunities)
    .where(and(
      eq(growOpportunities.brokerageId, brokerageId),
      gte(growOpportunities.createdAt, period.start),
      lt(growOpportunities.createdAt, period.end),
      visibleLinkedPropertySql(growOpportunities.propertyId, restrictToPropertyIds),
    ))
    .orderBy(asc(growOpportunities.createdAt))
    .limit(OPPORTUNITY_ROW_CAP);
}

// growOpportunitySignals.promotedOpportunityId is set only by an explicit
// agent "promote" action (packages/db/src/schema/propertyIntelligence.ts's
// own header comment) — never by the signal engine itself, so this list is
// never larger than the number of times an agent has actually promoted a
// signal into an opportunity.
export async function fetchPromotedSignalOpportunityIds(
  brokerageId: number,
  restrictToPropertyIds: number[] | null = null,
): Promise<number[]> {
  const rows = await db
    .select({ promotedOpportunityId: growOpportunitySignals.promotedOpportunityId })
    .from(growOpportunitySignals)
    .where(and(
      eq(growOpportunitySignals.brokerageId, brokerageId),
      isNotNull(growOpportunitySignals.promotedOpportunityId),
      visibleLinkedPropertySql(growOpportunitySignals.propertyId, restrictToPropertyIds),
    ))
    .limit(SIGNAL_ROW_CAP);
  const ids: number[] = [];
  for (const row of rows) {
    if (row.promotedOpportunityId !== null) ids.push(row.promotedOpportunityId);
  }
  return ids;
}

export interface OpportunityPipelineHealthMetric {
  period: PeriodView;
  sampleSize: number;
  truncated: boolean;
  openCount: number;
  byStage: Record<string, number>;
  newInPeriod: number;
  newFromSignalsInPeriod: number;
  averageAgeDays: number | null;
  stalled: Array<{ opportunityId: number; partyId: number; stage: string; daysSinceContact: number }>;
  stalledTruncated: boolean;
  limitations: string[];
}

// Definition: openCount/byStage/averageAgeDays/stalled all describe the
// CURRENT open pipeline (status "Open"), not a period-bound slice — an open
// opportunity from before the period is still open today. newInPeriod /
// newFromSignalsInPeriod are the only period-bound figures here (creation
// date falling in the requested period). stalled = open opportunities whose
// last meaningful contact (or, if none recorded, creation date) is
// STALL_THRESHOLD_DAYS or more in the past.
export function computeOpportunityPipelineHealth(
  openRows: OpportunityRow[],
  createdInPeriodRows: OpportunityRow[],
  promotedOpportunityIds: number[],
  period: ResolvedPeriod,
  now: Date,
): OpportunityPipelineHealthMetric {
  const byStage: Record<string, number> = {};
  for (const row of openRows) {
    byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
  }

  const promotedSet = new Set(promotedOpportunityIds);
  const newFromSignalsInPeriod = createdInPeriodRows.filter((row) => promotedSet.has(row.id)).length;

  const ages = openRows.map((row) => daysBetween(now, row.createdAt));
  const averageAgeDays = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : null;

  const stalledCandidates = openRows
    .map((row) => {
      const referenceDate = row.lastMeaningfulContactAt ?? row.createdAt;
      return { opportunityId: row.id, partyId: row.partyId, stage: row.stage, daysSinceContact: daysBetween(now, referenceDate) };
    })
    .filter((entry) => entry.daysSinceContact >= STALL_THRESHOLD_DAYS)
    .sort((a, b) => b.daysSinceContact - a.daysSinceContact);

  const limitations: string[] = [
    "Stage-to-stage movement history isn't recorded in this build — this reports the current stage distribution and age of open opportunities, not historical transitions between stages.",
  ];
  if (openRows.length >= OPPORTUNITY_ROW_CAP) {
    limitations.push(`At least ${OPPORTUNITY_ROW_CAP} open opportunities exist; pipeline figures are based on the first ${OPPORTUNITY_ROW_CAP} by creation date.`);
  }
  if (openRows.length === 0) {
    limitations.push("There are no open opportunities to report on.");
  }

  return {
    period: toPeriodView(period),
    sampleSize: openRows.length,
    truncated: openRows.length >= OPPORTUNITY_ROW_CAP,
    openCount: openRows.length,
    byStage,
    newInPeriod: createdInPeriodRows.length,
    newFromSignalsInPeriod,
    averageAgeDays,
    stalled: stalledCandidates.slice(0, STALLED_LIST_CAP),
    stalledTruncated: stalledCandidates.length > STALLED_LIST_CAP,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Relationship engagement
// ---------------------------------------------------------------------------

export interface RelationshipRow {
  id: number;
  partyId: number;
  relationshipType: string;
  isPrimary: boolean;
}

export async function fetchActiveRelationships(
  brokerageId: number,
  restrictToPropertyIds: number[] | null = null,
): Promise<RelationshipRow[]> {
  return db
    .select({ id: growRelationships.id, partyId: growRelationships.partyId, relationshipType: growRelationships.relationshipType, isPrimary: growRelationships.isPrimary })
    .from(growRelationships)
    .where(and(
      eq(growRelationships.brokerageId, brokerageId),
      eq(growRelationships.status, "Active"),
      visibleLinkedPropertySql(growRelationships.propertyId, restrictToPropertyIds),
    ))
    // id tiebreak for the same reason fetchRecentActivityByParty below needs
    // one: validFrom is routinely identical across rows created by one import,
    // and a partial order is not a deterministic one once the cap bites.
    .orderBy(asc(growRelationships.validFrom), asc(growRelationships.id))
    .limit(RELATIONSHIP_ROW_CAP);
}

// Deliberately not period-bound (like growToday.ts's own "cold contact"
// rule) — "recently engaged" always means "relative to right now", so a
// coaching answer about a 7-day activity period can still correctly say
// whether a contact has been engaged with recently even if that contact's
// last activity fell just outside the requested period.
//
// Ordered before the cap, like every other fetch in this file. Without an
// orderBy, Postgres may return ANY ACTIVITY_ROW_CAP of the matching rows and
// a different set on the next run, which made "which contacts count as
// recently engaged" non-deterministic above the cap and
// noRecentActivityContacts over-report. Most recent first is the meaningful
// order for a recency question: if the set must be truncated, the rows kept
// are the ones that most strongly establish recent engagement. id is the
// tiebreak so activities sharing an occurredAt (bulk imports do this) still
// produce a total order, not just a stable-looking one.
export async function fetchRecentActivityByParty(
  brokerageId: number,
  since: Date,
  restrictToPropertyIds: number[] | null = null,
): Promise<Array<{ partyId: number | null; occurredAt: Date }>> {
  return db
    .select({ partyId: growActivities.partyId, occurredAt: growActivities.occurredAt })
    .from(growActivities)
    .where(and(
      eq(growActivities.brokerageId, brokerageId),
      gte(growActivities.occurredAt, since),
      visibleLinkedPropertySql(growActivities.propertyId, restrictToPropertyIds),
    ))
    .orderBy(desc(growActivities.occurredAt), asc(growActivities.id))
    .limit(ACTIVITY_ROW_CAP);
}

export interface RelationshipEngagementMetric {
  sampleSize: number;
  truncated: boolean;
  totalActiveRelationships: number;
  distinctContacts: number;
  byType: Record<string, number>;
  recentlyEngagedContacts: number;
  noRecentActivityContacts: number;
  noRecentActivityList: Array<{ partyId: number; relationshipType: string }>;
  noRecentActivityTruncated: boolean;
  /**
   * True when the ACTIVITY rows this split was computed from hit
   * ACTIVITY_ROW_CAP. Distinct from `truncated`, which is about the
   * RELATIONSHIP rows: activity truncation biases the split one specific way
   * (some genuinely-engaged contacts fall outside the kept rows, so
   * recentlyEngagedContacts under-reports and noRecentActivityContacts
   * over-reports), and a reader needs to be told which of the two happened.
   */
  activityTruncated: boolean;
  limitations: string[];
}

// Definition: distinctContacts = distinct parties holding at least one
// Active relationship (a party with several relationship rows counts once,
// preferring its primary relationship's type for display). recentlyEngaged/
// noRecentActivity split those contacts by whether any growActivities row
// for that party fell within the last RECENT_ENGAGEMENT_THRESHOLD_DAYS days.
export function computeRelationshipEngagement(
  relationshipRows: RelationshipRow[],
  recentActivityRows: Array<{ partyId: number | null; occurredAt: Date }>,
): RelationshipEngagementMetric {
  const byType: Record<string, number> = {};
  const bestRelationshipByParty = new Map<number, RelationshipRow>();
  for (const row of relationshipRows) {
    byType[row.relationshipType] = (byType[row.relationshipType] ?? 0) + 1;
    const existing = bestRelationshipByParty.get(row.partyId);
    if (existing === undefined || (row.isPrimary && !existing.isPrimary)) {
      bestRelationshipByParty.set(row.partyId, row);
    }
  }

  const recentPartyIds = new Set<number>();
  for (const activity of recentActivityRows) {
    if (activity.partyId !== null) recentPartyIds.add(activity.partyId);
  }

  let recentlyEngagedContacts = 0;
  const noRecentActivityList: Array<{ partyId: number; relationshipType: string }> = [];
  for (const [partyId, row] of bestRelationshipByParty) {
    if (recentPartyIds.has(partyId)) {
      recentlyEngagedContacts++;
    } else {
      noRecentActivityList.push({ partyId, relationshipType: row.relationshipType });
    }
  }

  const limitations: string[] = [];
  if (relationshipRows.length >= RELATIONSHIP_ROW_CAP) {
    limitations.push(`At least ${RELATIONSHIP_ROW_CAP} active relationships exist; engagement figures are based on the first ${RELATIONSHIP_ROW_CAP} recorded.`);
  }
  // Activity-row truncation is disclosed the same way relationship-row
  // truncation above is, and separately from it: it is a different cap on a
  // different input with a different, directional effect on the numbers.
  const activityTruncated = recentActivityRows.length >= ACTIVITY_ROW_CAP;
  if (activityTruncated) {
    limitations.push(
      `At least ${ACTIVITY_ROW_CAP} activity records fall in the recent-engagement window; the engaged/not-engaged split is based on the ${ACTIVITY_ROW_CAP} most recent activity rows, so the number of contacts with no recent activity may be overstated.`,
    );
  }

  return {
    sampleSize: relationshipRows.length,
    truncated: relationshipRows.length >= RELATIONSHIP_ROW_CAP,
    totalActiveRelationships: relationshipRows.length,
    distinctContacts: bestRelationshipByParty.size,
    byType,
    recentlyEngagedContacts,
    noRecentActivityContacts: noRecentActivityList.length,
    noRecentActivityList: noRecentActivityList.slice(0, NO_RECENT_ACTIVITY_LIST_CAP),
    noRecentActivityTruncated: noRecentActivityList.length > NO_RECENT_ACTIVITY_LIST_CAP,
    activityTruncated,
    limitations,
  };
}

// ---------------------------------------------------------------------------
// Grow Today patterns — composed from the EXISTING Stage B GrowContext
// (context/growContext.ts / lib/growToday.ts) rather than a new query. Grow
// Today is a live "what needs attention right now" view with no persistence
// of its own (see growToday.ts's header comment) — there is no history of
// items resolved over time to report on, so this deliberately only
// describes the CURRENT snapshot and says so, rather than inventing a
// resolved/unresolved trend the schema cannot support.
// ---------------------------------------------------------------------------

export interface GrowTodayPatternsMetric {
  generatedAt: string;
  hasAnyGrowData: boolean;
  totalItems: number;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  topReasons: string[];
  limitations: string[];
}

export function computeGrowTodayPatterns(grow: GrowContext | null): GrowTodayPatternsMetric {
  if (grow === null) {
    return {
      generatedAt: new Date(0).toISOString(),
      hasAnyGrowData: false,
      totalItems: 0,
      byPriority: {},
      byType: {},
      topReasons: [],
      limitations: ["No Grow Today data is available for this brokerage yet."],
    };
  }

  const byPriority: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const item of grow.todayItems) {
    byPriority[item.priority] = (byPriority[item.priority] ?? 0) + 1;
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }

  return {
    generatedAt: grow.generatedAt,
    hasAnyGrowData: grow.hasAnyGrowData,
    totalItems: grow.todayItems.length,
    byPriority,
    byType,
    topReasons: grow.todayItems.slice(0, 5).map((item) => item.reason),
    limitations: [
      "Grow Today is a live snapshot, not a historical log — this reflects what needs attention right now, not a count of items resolved over time.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------

export type ComparisonDirection = "increased" | "decreased" | "stable" | "insufficient_data";

export interface MetricDelta {
  metric: string;
  label: string;
  current: number | null;
  previous: number | null;
  absoluteChange: number | null;
  percentChange: number | null;
  direction: ComparisonDirection;
}

// Neutral, non-causal comparison of one figure between two periods. Never
// shows a percent change when the previous value was zero (a "+infinite%"
// figure would be misleading, not informative), and reports
// "insufficient_data" rather than a spurious direction when either value is
// missing or the combined sample size is below MIN_SAMPLE_SIZE_FOR_TREND.
function compareValue(metric: string, label: string, current: number | null, previous: number | null, sampleSizeOk: boolean): MetricDelta {
  if (current === null || previous === null || !sampleSizeOk) {
    return { metric, label, current, previous, absoluteChange: null, percentChange: null, direction: "insufficient_data" };
  }
  const absoluteChange = current - previous;
  const percentChange = previous !== 0 ? (absoluteChange / previous) * 100 : null;
  const direction: ComparisonDirection = absoluteChange > 0 ? "increased" : absoluteChange < 0 ? "decreased" : "stable";
  return { metric, label, current, previous, absoluteChange, percentChange, direction };
}

export interface PeriodComparisonMetric {
  currentPeriod: PeriodView;
  previousPeriod: PeriodView;
  deltas: MetricDelta[];
  limitations: string[];
}

export interface ComparableSnapshot {
  period: ResolvedPeriod;
  activity: ActivityConsistencyMetric;
  commitments: CommitmentPerformanceMetric;
  appraisals: AppraisalMomentumMetric;
  opportunities: OpportunityPipelineHealthMetric;
}

export function computePeriodComparison(current: ComparableSnapshot, previous: ComparableSnapshot): PeriodComparisonMetric {
  const commitmentSampleOk = current.commitments.totalDue >= MIN_SAMPLE_SIZE_FOR_TREND && previous.commitments.totalDue >= MIN_SAMPLE_SIZE_FOR_TREND;

  const deltas: MetricDelta[] = [
    compareValue("totalActivities", "Recorded activity", current.activity.totalActivities, previous.activity.totalActivities, true),
    compareValue("activeDays", "Active prospecting days", current.activity.activeDays, previous.activity.activeDays, true),
    compareValue(
      "commitmentCompletionRatePercent",
      "Commitment completion rate",
      current.commitments.completionRate !== null ? current.commitments.completionRate * 100 : null,
      previous.commitments.completionRate !== null ? previous.commitments.completionRate * 100 : null,
      commitmentSampleOk,
    ),
    compareValue("appraisalsCreated", "Appraisals created", current.appraisals.created, previous.appraisals.created, true),
    compareValue("newOpportunities", "New opportunities", current.opportunities.newInPeriod, previous.opportunities.newInPeriod, true),
  ];

  const limitations: string[] = [
    "Percentage change is not shown when the earlier period's value was zero, since that comparison would be misleading.",
  ];
  if (!current.period.isComplete) {
    limitations.push("The current period is still in progress, so this comparison may understate its final figures.");
  }
  if (!commitmentSampleOk) {
    limitations.push("There is not yet enough commitment data in one or both periods to compare completion rates reliably.");
  }

  return {
    currentPeriod: toPeriodView(current.period),
    previousPeriod: toPeriodView(previous.period),
    deltas,
    limitations,
  };
}

// Re-exported so callers only need to import from this one module for the
// full coaching-metrics surface, without also importing period.ts directly.
export { resolvePreviousComparablePeriod };
