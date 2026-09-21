// AE GROW Priority 6 Stage C — pure unit tests for coaching/metrics.ts's
// computeX functions. Every test here builds plain, hand-constructed row
// arrays (never the database) and calls the exported pure compute function
// directly — exactly the "independently unit-testable" split the Stage C
// authorisation requires (fetchX/computeX are tested separately; the DB-
// integration side of fetchX is exercised end-to-end by
// __tests__/coachOrchestrator.test.ts instead of re-mocking drizzle here).
//
// AE GROW Priority 6 Stage C TIMEZONE REMEDIATION: makePeriod()'s default
// ResolvedPeriod now carries a real timeZone/timeZoneSource (Australia/
// Brisbane, fallback), and computeActivityConsistency's own "active days"
// fixture below has been adjusted to land its three fixture timestamps on
// the intended LOCAL (Brisbane, +10:00) calendar days rather than the UTC
// ones the original fixture happened to line up with — see that test's own
// updated comment for the exact reasoning. Every other fixture/assertion in
// this file is either unaffected by the switch from UTC to local-calendar
// bucketing (a single-row or empty-row case, or a case that never inspects
// which specific day an activity fell on) or was already timezone-agnostic
// (every other compute function here takes plain already-resolved figures,
// not raw timestamps to bucket).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toPeriodView, type ResolvedPeriod } from "../period.js";
import {
  ACTIVITY_ROW_CAP,
  APPRAISAL_ROW_CAP,
  COMMITMENT_ROW_CAP,
  NO_RECENT_ACTIVITY_LIST_CAP,
  OPPORTUNITY_ROW_CAP,
  RELATIONSHIP_ROW_CAP,
  REPEATED_OVERDUE_LIST_CAP,
  STALLED_LIST_CAP,
  STALL_THRESHOLD_DAYS,
  computeActivityConsistency,
  computeAppraisalMomentum,
  computeCommitmentPerformance,
  computeGrowTodayPatterns,
  computeOpportunityPipelineHealth,
  computePeriodComparison,
  computeRelationshipEngagement,
  type ActivityConsistencyMetric,
  type ActivityRow,
  type AppraisalRow,
  type CommitmentPerformanceMetric,
  type CommitmentRow,
  type ComparableSnapshot,
  type OpportunityRow,
  type RelationshipRow,
} from "../metrics.js";
import type { GrowContext, GrowTodayItemView } from "../../types.js";

const NOW = new Date("2026-03-15T00:00:00.000Z");

function makePeriod(overrides: Partial<ResolvedPeriod> = {}): ResolvedPeriod {
  return {
    key: "last7days",
    label: "Last 7 days",
    start: new Date("2026-03-08T00:00:00.000Z"),
    end: NOW,
    isComplete: true,
    durationDays: 7,
    timeZone: "Australia/Brisbane",
    timeZoneSource: "fallback",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeActivityConsistency
// ---------------------------------------------------------------------------

function makeActivityRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return { id: 1, partyId: 1, activityType: "Call", occurredAt: new Date("2026-03-09T09:00:00.000Z"), ...overrides };
}

test("computeActivityConsistency: counts by type, active LOCAL calendar days, active-day rate, and the longest gap between active days", () => {
  const period = makePeriod();
  const rows: ActivityRow[] = [
    // Local midnight 9 March in Brisbane (+10:00) is 2026-03-08T14:00:00Z,
    // and local midnight 10 March is 2026-03-09T14:00:00Z - both of the
    // first two rows below fall inside that window, so both are on the
    // SAME local calendar day (9 March) despite being 6 UTC hours apart.
    makeActivityRow({ id: 1, activityType: "Call", occurredAt: new Date("2026-03-08T23:00:00.000Z") }), // 09:00 local, 9 March
    makeActivityRow({ id: 2, activityType: "Email", occurredAt: new Date("2026-03-09T05:00:00.000Z") }), // 15:00 local, 9 March
    makeActivityRow({ id: 3, activityType: "Call", occurredAt: new Date("2026-03-10T23:00:00.000Z") }), // 09:00 local, 11 March
  ];
  const metric = computeActivityConsistency(rows, period);
  assert.equal(metric.totalActivities, 3);
  assert.deepEqual(metric.activitiesByType, { Call: 2, Email: 1 });
  assert.equal(metric.activeDays, 2, "two distinct LOCAL calendar days, regardless of same-day multiple activities");
  assert.equal(metric.totalDaysInPeriod, 7);
  assert.equal(metric.activeDayRate, 2 / 7);
  assert.equal(metric.longestGapDays, 2);
  assert.equal(metric.truncated, false);
  assert.deepEqual(metric.limitations, []);
});

test("computeActivityConsistency: two activities sharing the same UTC calendar date can fall on two DIFFERENT local calendar dates, and must be counted as two distinct active days", () => {
  // Both instants below share the UTC date "2026-03-09" (a bare
  // `.toISOString().slice(0, 10)` slice — the pre-remediation logic — would
  // have bucketed both under 9 March). In Australia/Brisbane (+10:00) the
  // first is 23:00 on 9 March local, but the second is already 01:00 on 10
  // March local - exactly the class of mismatch this remediation exists to
  // fix.
  const period = makePeriod();
  const rows: ActivityRow[] = [
    makeActivityRow({ id: 1, occurredAt: new Date("2026-03-09T13:00:00.000Z") }), // 23:00 local, 9 March
    makeActivityRow({ id: 2, occurredAt: new Date("2026-03-09T15:00:00.000Z") }), // 01:00 local, 10 March
  ];
  const metric = computeActivityConsistency(rows, period);
  assert.equal(metric.activeDays, 2, "the correct local-calendar bucketing must recognise these as two distinct days, not one");
});

test("computeActivityConsistency: fewer than two active days -> longestGapDays is null, not zero (a single point cannot describe a gap)", () => {
  const period = makePeriod();
  const metric = computeActivityConsistency([makeActivityRow()], period);
  assert.equal(metric.activeDays, 1);
  assert.equal(metric.longestGapDays, null);
});

test("computeActivityConsistency: zero rows -> zero totals, null gap, no division-by-zero on the rate", () => {
  const period = makePeriod();
  const metric = computeActivityConsistency([], period);
  assert.equal(metric.totalActivities, 0);
  assert.equal(metric.activeDays, 0);
  assert.equal(metric.activeDayRate, 0);
  assert.equal(metric.longestGapDays, null);
});

test("computeActivityConsistency: an incomplete (still-running) period adds a disclosed limitation", () => {
  const period = makePeriod({ isComplete: false });
  const metric = computeActivityConsistency([], period);
  assert.ok(metric.limitations.some((l) => l.includes("still in progress")));
});

test(`computeActivityConsistency: reaching ACTIVITY_ROW_CAP (${ACTIVITY_ROW_CAP}) rows is reported as truncated with a disclosed limitation`, () => {
  const period = makePeriod();
  const rows: ActivityRow[] = Array.from({ length: ACTIVITY_ROW_CAP }, (_, i) =>
    makeActivityRow({ id: i, occurredAt: new Date(period.start.getTime() + i * 1000) }),
  );
  const metric = computeActivityConsistency(rows, period);
  assert.equal(metric.truncated, true);
  assert.ok(metric.limitations.some((l) => l.includes(String(ACTIVITY_ROW_CAP))));
});

// ---------------------------------------------------------------------------
// computeCommitmentPerformance
// ---------------------------------------------------------------------------

function makeCommitmentRow(overrides: Partial<CommitmentRow> = {}): CommitmentRow {
  return { id: 1, partyId: 1, dueAt: new Date("2026-03-10T00:00:00.000Z"), status: "Open", completedAt: null, ...overrides };
}

test("computeCommitmentPerformance: completion rate, currently-overdue count/age, and repeated-overdue contacts", () => {
  const period = makePeriod();
  const dueInPeriod: CommitmentRow[] = [
    makeCommitmentRow({ id: 1, status: "Completed" }),
    makeCommitmentRow({ id: 2, status: "Completed" }),
    makeCommitmentRow({ id: 3, status: "Completed" }),
    makeCommitmentRow({ id: 4, status: "Open" }),
  ];
  const currentlyOverdue: CommitmentRow[] = [
    makeCommitmentRow({ id: 5, partyId: 5, dueAt: new Date("2026-03-10T00:00:00.000Z") }), // 5 days
    makeCommitmentRow({ id: 6, partyId: 5, dueAt: new Date("2026-03-05T00:00:00.000Z") }), // 10 days
    makeCommitmentRow({ id: 7, partyId: 6, dueAt: new Date("2026-03-12T00:00:00.000Z") }), // 3 days
  ];
  const metric = computeCommitmentPerformance(dueInPeriod, currentlyOverdue, period, NOW);
  assert.equal(metric.totalDue, 4);
  assert.equal(metric.completed, 3);
  assert.equal(metric.completionRate, 0.75);
  assert.equal(metric.currentlyOverdueCount, 3);
  assert.equal(metric.averageOverdueAgeDays, 6, "(5 + 10 + 3) / 3 = 6");
  assert.deepEqual(metric.repeatedOverdueContacts, [{ partyId: 5, overdueCount: 2 }], "party 6 has only one overdue commitment and must not appear");
  assert.equal(metric.repeatedOverdueTruncated, false);
  assert.deepEqual(metric.limitations, []);
});

test("computeCommitmentPerformance: zero commitments due in the period -> null completion rate, not zero, with a disclosed limitation", () => {
  const period = makePeriod();
  const metric = computeCommitmentPerformance([], [], period, NOW);
  assert.equal(metric.totalDue, 0);
  assert.equal(metric.completionRate, null);
  assert.equal(metric.averageOverdueAgeDays, null);
  assert.ok(metric.limitations.some((l) => l.includes("cannot be calculated")));
});

test(`computeCommitmentPerformance: more than REPEATED_OVERDUE_LIST_CAP (${REPEATED_OVERDUE_LIST_CAP}) repeat-overdue contacts is capped and flagged truncated`, () => {
  const period = makePeriod();
  const overdue: CommitmentRow[] = [];
  for (let party = 1; party <= 11; party++) {
    overdue.push(makeCommitmentRow({ id: party * 10 + 1, partyId: party }));
    overdue.push(makeCommitmentRow({ id: party * 10 + 2, partyId: party }));
  }
  const metric = computeCommitmentPerformance([], overdue, period, NOW);
  assert.equal(metric.repeatedOverdueContacts.length, REPEATED_OVERDUE_LIST_CAP);
  assert.equal(metric.repeatedOverdueTruncated, true);
});

test(`computeCommitmentPerformance: reaching COMMITMENT_ROW_CAP (${COMMITMENT_ROW_CAP}) commitments due is reported as truncated`, () => {
  const period = makePeriod();
  const rows: CommitmentRow[] = Array.from({ length: COMMITMENT_ROW_CAP }, (_, i) => makeCommitmentRow({ id: i }));
  const metric = computeCommitmentPerformance(rows, [], period, NOW);
  assert.equal(metric.truncated, true);
});

test("computeCommitmentPerformance: an incomplete period adds a disclosed limitation", () => {
  const period = makePeriod({ isComplete: false });
  const metric = computeCommitmentPerformance([makeCommitmentRow({ status: "Completed" })], [], period, NOW);
  assert.ok(metric.limitations.some((l) => l.includes("still in progress")));
});

// ---------------------------------------------------------------------------
// computeAppraisalMomentum
// ---------------------------------------------------------------------------

function makeAppraisalRow(overrides: Partial<AppraisalRow> = {}): AppraisalRow {
  return {
    id: 1,
    partyId: 1,
    propertyId: 1,
    status: "DRAFT",
    createdAt: new Date("2026-03-09T00:00:00.000Z"),
    updatedAt: new Date("2026-03-09T00:00:00.000Z"),
    followUpAt: null,
    outcome: null,
    ...overrides,
  };
}

test("computeAppraisalMomentum: status distribution, won/lost counts (from outcome), and due follow-ups", () => {
  const period = makePeriod();
  const created: AppraisalRow[] = [
    makeAppraisalRow({ id: 1, status: "DRAFT" }),
    makeAppraisalRow({ id: 2, status: "WON", outcome: "WON" }),
    makeAppraisalRow({ id: 3, status: "FOLLOW_UP", followUpAt: new Date("2026-03-14T00:00:00.000Z") }),
  ];
  const metric = computeAppraisalMomentum(created, [makeAppraisalRow(), makeAppraisalRow()], period, NOW);
  assert.equal(metric.created, 3);
  assert.deepEqual(metric.byStatus, { DRAFT: 1, WON: 1, FOLLOW_UP: 1 });
  assert.equal(metric.wonCount, 1);
  assert.equal(metric.lostCount, 0);
  assert.equal(metric.followUpDueCount, 1);
  assert.equal(metric.staleCount, 2);
  assert.ok(metric.limitations[0].includes("not a history of how each appraisal's status has changed"), "the status-history caveat is always present, first");
  assert.equal(metric.limitations.length, 1);
});

test("computeAppraisalMomentum: a future follow-up date is not yet counted as due", () => {
  const period = makePeriod();
  const created: AppraisalRow[] = [makeAppraisalRow({ status: "FOLLOW_UP", followUpAt: new Date("2026-03-20T00:00:00.000Z") })];
  const metric = computeAppraisalMomentum(created, [], period, NOW);
  assert.equal(metric.followUpDueCount, 0);
});

test("computeAppraisalMomentum: no appraisals created in the period adds a disclosed limitation", () => {
  const period = makePeriod();
  const metric = computeAppraisalMomentum([], [], period, NOW);
  assert.equal(metric.created, 0);
  assert.equal(metric.limitations.length, 2);
  assert.ok(metric.limitations.some((l) => l.includes("No appraisals were created")));
});

test(`computeAppraisalMomentum: reaching APPRAISAL_ROW_CAP (${APPRAISAL_ROW_CAP}) created appraisals is reported as truncated`, () => {
  const period = makePeriod();
  const created: AppraisalRow[] = Array.from({ length: APPRAISAL_ROW_CAP }, (_, i) => makeAppraisalRow({ id: i }));
  const metric = computeAppraisalMomentum(created, [], period, NOW);
  assert.equal(metric.truncated, true);
});

// ---------------------------------------------------------------------------
// computeOpportunityPipelineHealth
// ---------------------------------------------------------------------------

function makeOpportunityRow(overrides: Partial<OpportunityRow> = {}): OpportunityRow {
  return {
    id: 1,
    partyId: 1,
    stage: "New",
    nextActionDueAt: null,
    lastMeaningfulContactAt: null,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("computeOpportunityPipelineHealth: stage distribution, average age, and stalled detection by last-contact (falling back to createdAt)", () => {
  const period = makePeriod();
  const open: OpportunityRow[] = [
    makeOpportunityRow({ id: 1, partyId: 1, stage: "New", createdAt: new Date("2026-02-01T00:00:00.000Z"), lastMeaningfulContactAt: null }), // 42 days since creation, no contact -> stalled
    makeOpportunityRow({ id: 2, partyId: 2, stage: "Contacted", createdAt: new Date("2026-03-10T00:00:00.000Z"), lastMeaningfulContactAt: new Date("2026-03-13T00:00:00.000Z") }), // 2 days since contact -> not stalled
    makeOpportunityRow({ id: 3, partyId: 3, stage: "New", createdAt: new Date("2026-01-01T00:00:00.000Z"), lastMeaningfulContactAt: new Date("2026-02-01T00:00:00.000Z") }), // 42 days since contact -> stalled
  ];
  const created: OpportunityRow[] = [makeOpportunityRow({ id: 10 }), makeOpportunityRow({ id: 11 })];
  const metric = computeOpportunityPipelineHealth(open, created, [11], period, NOW);
  assert.equal(metric.openCount, 3);
  assert.deepEqual(metric.byStage, { New: 2, Contacted: 1 });
  assert.equal(metric.newInPeriod, 2);
  assert.equal(metric.newFromSignalsInPeriod, 1, "only opportunity id 11 was promoted from a signal");
  assert.equal(metric.averageAgeDays, (42 + 5 + 73) / 3);
  assert.equal(metric.stalled.length, 2);
  assert.ok(metric.stalled.every((s) => s.daysSinceContact >= STALL_THRESHOLD_DAYS));
  assert.equal(metric.stalledTruncated, false);
});

test("computeOpportunityPipelineHealth: no open opportunities -> zero counts, null average age, disclosed limitation", () => {
  const period = makePeriod();
  const metric = computeOpportunityPipelineHealth([], [], [], period, NOW);
  assert.equal(metric.openCount, 0);
  assert.equal(metric.averageAgeDays, null);
  assert.deepEqual(metric.byStage, {});
  assert.ok(metric.limitations.some((l) => l.includes("no open opportunities")));
});

test(`computeOpportunityPipelineHealth: more than STALLED_LIST_CAP (${STALLED_LIST_CAP}) stalled opportunities is capped and flagged truncated`, () => {
  const period = makePeriod();
  const open: OpportunityRow[] = Array.from({ length: 11 }, (_, i) =>
    makeOpportunityRow({ id: i, partyId: i, createdAt: new Date("2026-01-01T00:00:00.000Z") }),
  );
  const metric = computeOpportunityPipelineHealth(open, [], [], period, NOW);
  assert.equal(metric.stalled.length, STALLED_LIST_CAP);
  assert.equal(metric.stalledTruncated, true);
});

test(`computeOpportunityPipelineHealth: reaching OPPORTUNITY_ROW_CAP (${OPPORTUNITY_ROW_CAP}) open opportunities is reported as truncated`, () => {
  const period = makePeriod();
  const open: OpportunityRow[] = Array.from({ length: OPPORTUNITY_ROW_CAP }, (_, i) => makeOpportunityRow({ id: i }));
  const metric = computeOpportunityPipelineHealth(open, [], [], period, NOW);
  assert.equal(metric.truncated, true);
});

// ---------------------------------------------------------------------------
// computeRelationshipEngagement
// ---------------------------------------------------------------------------

function makeRelationshipRow(overrides: Partial<RelationshipRow> = {}): RelationshipRow {
  return { id: 1, partyId: 1, relationshipType: "Owner", isPrimary: false, ...overrides };
}

test("computeRelationshipEngagement: distinct contacts (preferring the primary relationship), and the recently-engaged/no-recent-activity split", () => {
  const relationships: RelationshipRow[] = [
    makeRelationshipRow({ id: 1, partyId: 1, relationshipType: "Tenant", isPrimary: false }),
    makeRelationshipRow({ id: 2, partyId: 1, relationshipType: "Owner", isPrimary: true }),
    makeRelationshipRow({ id: 3, partyId: 2, relationshipType: "Owner", isPrimary: false }),
  ];
  const recentActivity = [
    { partyId: 1, occurredAt: new Date("2026-03-14T00:00:00.000Z") },
    { partyId: null, occurredAt: new Date("2026-03-14T00:00:00.000Z") },
  ];
  const metric = computeRelationshipEngagement(relationships, recentActivity);
  assert.equal(metric.totalActiveRelationships, 3);
  assert.deepEqual(metric.byType, { Tenant: 1, Owner: 2 });
  assert.equal(metric.distinctContacts, 2);
  assert.equal(metric.recentlyEngagedContacts, 1);
  assert.equal(metric.noRecentActivityContacts, 1);
  assert.deepEqual(metric.noRecentActivityList, [{ partyId: 2, relationshipType: "Owner" }]);
});

test(`computeRelationshipEngagement: more than NO_RECENT_ACTIVITY_LIST_CAP (${NO_RECENT_ACTIVITY_LIST_CAP}) inactive contacts is capped and flagged truncated`, () => {
  const relationships: RelationshipRow[] = Array.from({ length: 11 }, (_, i) => makeRelationshipRow({ id: i, partyId: i }));
  const metric = computeRelationshipEngagement(relationships, []);
  assert.equal(metric.noRecentActivityList.length, NO_RECENT_ACTIVITY_LIST_CAP);
  assert.equal(metric.noRecentActivityTruncated, true);
});

test(`computeRelationshipEngagement: reaching RELATIONSHIP_ROW_CAP (${RELATIONSHIP_ROW_CAP}) rows is reported as truncated`, () => {
  const relationships: RelationshipRow[] = Array.from({ length: RELATIONSHIP_ROW_CAP }, (_, i) => makeRelationshipRow({ id: i, partyId: i }));
  const metric = computeRelationshipEngagement(relationships, []);
  assert.equal(metric.truncated, true);
  assert.equal(metric.activityTruncated, false, "relationship-row and activity-row truncation are reported independently");
});

// AE GROW W2-C (C-9). computeRelationshipEngagement disclosed only
// RELATIONSHIP-row truncation, while silently accepting an activity-row list
// its caller had already capped at ACTIVITY_ROW_CAP — so above that cap it
// reported an under-count of engaged contacts as if it were complete.
test(`computeRelationshipEngagement: reaching ACTIVITY_ROW_CAP (${ACTIVITY_ROW_CAP}) activity rows is disclosed as its own limitation`, () => {
  const relationships: RelationshipRow[] = [makeRelationshipRow({ id: 1, partyId: 1, isPrimary: true })];
  const recentActivity = Array.from({ length: ACTIVITY_ROW_CAP }, (_, i) => ({
    partyId: 1,
    occurredAt: new Date(new Date("2026-03-14T00:00:00.000Z").getTime() + i * 1000),
  }));
  const metric = computeRelationshipEngagement(relationships, recentActivity);
  assert.equal(metric.activityTruncated, true);
  assert.equal(metric.truncated, false, "a single relationship row is nowhere near RELATIONSHIP_ROW_CAP");
  const disclosure = metric.limitations.find((l) => l.includes("activity record"));
  assert.ok(disclosure !== undefined, `activity-row truncation must appear in limitations; got ${JSON.stringify(metric.limitations)}`);
  assert.ok(disclosure.includes(String(ACTIVITY_ROW_CAP)));
});

// ---------------------------------------------------------------------------
// computeGrowTodayPatterns
// ---------------------------------------------------------------------------

function makeGrowTodayItem(overrides: Partial<GrowTodayItemView> = {}): GrowTodayItemView {
  return {
    id: "opportunity:1",
    type: "opportunity_no_action_set",
    priority: "KeepWarm",
    partyId: 1,
    contactName: "Fixture Contact",
    propertyId: null,
    propertyLabel: null,
    opportunityId: 1,
    appraisalId: null,
    reason: "Fixture reason.",
    recommendedAction: "Fixture recommended action.",
    dueAt: null,
    lastActivityAt: null,
    ...overrides,
  };
}

function makeGrowContext(overrides: Partial<GrowContext> = {}): GrowContext {
  return {
    generatedAt: "2026-03-15T00:00:00.000Z",
    hasAnyGrowData: true,
    counts: { priorityActions: 0, followUpsDue: 0, openOpportunities: 0, contactsNeedingAttention: 0 },
    relationshipBreakdown: [],
    todayItems: [],
    focusedItem: null,
    dueFollowUps: [],
    appraisalFollowUps: [],
    activeSignals: [],
    opportunityPipeline: [],
    recentActivity: [],
    ...overrides,
  };
}

test("computeGrowTodayPatterns: null Grow context -> no data, honestly disclosed, never a fabricated snapshot", () => {
  const metric = computeGrowTodayPatterns(null);
  assert.equal(metric.hasAnyGrowData, false);
  assert.equal(metric.totalItems, 0);
  assert.equal(metric.generatedAt, new Date(0).toISOString());
  assert.ok(metric.limitations.some((l) => l.includes("No Grow Today data")));
});

test("computeGrowTodayPatterns: groups the current Grow Today list by priority and type, and reports up to 5 top reasons", () => {
  const items = [
    makeGrowTodayItem({ priority: "CallNow", type: "commitment_due", reason: "Reason 1" }),
    makeGrowTodayItem({ priority: "CallNow", type: "commitment_due", reason: "Reason 2" }),
    makeGrowTodayItem({ priority: "KeepWarm", type: "appraisal_follow_up", reason: "Reason 3" }),
  ];
  const grow = makeGrowContext({ todayItems: items });
  const metric = computeGrowTodayPatterns(grow);
  assert.equal(metric.hasAnyGrowData, true);
  assert.equal(metric.totalItems, 3);
  assert.deepEqual(metric.byPriority, { CallNow: 2, KeepWarm: 1 });
  assert.deepEqual(metric.byType, { commitment_due: 2, appraisal_follow_up: 1 });
  assert.deepEqual(metric.topReasons, ["Reason 1", "Reason 2", "Reason 3"]);
  assert.ok(metric.limitations.some((l) => l.includes("live snapshot")));
});

// ---------------------------------------------------------------------------
// computePeriodComparison
// ---------------------------------------------------------------------------

function makeActivityMetric(overrides: Partial<ActivityConsistencyMetric> = {}): ActivityConsistencyMetric {
  return {
    period: toPeriodView(makePeriod()),
    sampleSize: 0,
    truncated: false,
    totalActivities: 0,
    activitiesByType: {},
    activeDays: 0,
    totalDaysInPeriod: 7,
    activeDayRate: 0,
    longestGapDays: null,
    limitations: [],
    ...overrides,
  };
}

function makeCommitmentMetric(overrides: Partial<CommitmentPerformanceMetric> = {}): CommitmentPerformanceMetric {
  return {
    period: makeActivityMetric().period,
    sampleSize: 0,
    truncated: false,
    totalDue: 0,
    completed: 0,
    completionRate: null,
    currentlyOverdueCount: 0,
    currentlyOverdueTruncated: false,
    averageOverdueAgeDays: null,
    repeatedOverdueContacts: [],
    repeatedOverdueTruncated: false,
    limitations: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: {
  isComplete?: boolean;
  totalActivities: number;
  activeDays: number;
  totalDue: number;
  completionRate: number | null;
  created: number;
  newInPeriod: number;
}): ComparableSnapshot {
  const period = makePeriod({ isComplete: overrides.isComplete ?? true });
  return {
    period,
    activity: makeActivityMetric({ totalActivities: overrides.totalActivities, activeDays: overrides.activeDays }),
    commitments: makeCommitmentMetric({ totalDue: overrides.totalDue, completionRate: overrides.completionRate }),
    appraisals: { period: makeActivityMetric().period, sampleSize: 0, truncated: false, created: overrides.created, byStatus: {}, wonCount: 0, lostCount: 0, followUpDueCount: 0, staleCount: 0, staleTruncated: false, limitations: [] },
    opportunities: { period: makeActivityMetric().period, sampleSize: 0, truncated: false, openCount: 0, byStage: {}, newInPeriod: overrides.newInPeriod, newFromSignalsInPeriod: 0, averageAgeDays: null, stalled: [], stalledTruncated: false, limitations: [] },
  };
}

test("computePeriodComparison: reports increased direction and percent change for every improved figure", () => {
  const current = makeSnapshot({ totalActivities: 20, activeDays: 5, totalDue: 10, completionRate: 0.8, created: 4, newInPeriod: 3 });
  const previous = makeSnapshot({ totalActivities: 10, activeDays: 3, totalDue: 8, completionRate: 0.5, created: 2, newInPeriod: 1 });
  const comparison = computePeriodComparison(current, previous);

  const byMetric = new Map(comparison.deltas.map((d) => [d.metric, d]));
  assert.equal(byMetric.get("totalActivities")?.direction, "increased");
  assert.equal(byMetric.get("totalActivities")?.absoluteChange, 10);
  assert.equal(byMetric.get("totalActivities")?.percentChange, 100);
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.direction, "increased");
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.current, 80);
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.previous, 50);
  assert.equal(byMetric.get("newOpportunities")?.percentChange, 200);
  assert.equal(comparison.limitations.length, 1, "no incompleteness/insufficient-sample caveat should fire in a clean, complete, well-sampled comparison");
});

test("computePeriodComparison: never shows a percent change when the previous value was zero, even though a direction is still reported", () => {
  const current = makeSnapshot({ totalActivities: 5, activeDays: 2, totalDue: 5, completionRate: 0.6, created: 0, newInPeriod: 0 });
  const previous = makeSnapshot({ totalActivities: 5, activeDays: 2, totalDue: 5, completionRate: 0, created: 0, newInPeriod: 0 });
  const comparison = computePeriodComparison(current, previous);
  const byMetric = new Map(comparison.deltas.map((d) => [d.metric, d]));
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.percentChange, null);
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.direction, "increased");
  assert.equal(byMetric.get("totalActivities")?.direction, "stable");
});

test("computePeriodComparison: reports insufficient_data for the commitment completion rate when either period's sample is below MIN_SAMPLE_SIZE_FOR_TREND, and discloses it, without failing the rest of the comparison", () => {
  const current = makeSnapshot({ isComplete: false, totalActivities: 5, activeDays: 2, totalDue: 5, completionRate: 0.6, created: 1, newInPeriod: 1 });
  const previous = makeSnapshot({ totalActivities: 3, activeDays: 1, totalDue: 2, completionRate: 0, created: 0, newInPeriod: 0 });
  const comparison = computePeriodComparison(current, previous);
  const byMetric = new Map(comparison.deltas.map((d) => [d.metric, d]));
  assert.equal(byMetric.get("commitmentCompletionRatePercent")?.direction, "insufficient_data");
  assert.equal(byMetric.get("totalActivities")?.direction, "increased", "an insufficient sample on ONE metric must not suppress every other metric's comparison");
  assert.ok(comparison.limitations.some((l) => l.includes("still in progress")));
  assert.ok(comparison.limitations.some((l) => l.includes("not yet enough commitment data")));
});
