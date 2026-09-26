// R-F5 pure rules: tier boundaries, hours math, priority exceptions, dedupe
// fingerprint, per-brokerage config resolution, and the operating window.
// dueAt is not the overdue threshold.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWaitingOnCandidate,
  classifyWaitingOnTier,
  compareWaitingOnDetections,
  hoursPastWaitingOnExpectedAt,
  isMaterialWaitingOnDetectionChange,
  isOnOrBeforeNextBusinessDay,
  isWaitingOnSweepDue,
  isWithinOperatingWindow,
  nextBusinessDayEndExclusive,
  resolvePitCrewWaitingOnSweepSettings,
  waitingOnDetectionFingerprint,
  waitingOnPriorityReasons,
  PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS,
  type ClassifiedWaitingOnItem,
} from "../waitingOnDetection.js";

const HOUR = 3_600_000;
const THRESHOLDS = { attentionThresholdHours: 2, elevatedThresholdHours: 4 };
const TIME_ZONE = "Australia/Brisbane";
/** Wednesday 10:00 Australia/Brisbane. */
const WEDNESDAY_1000 = new Date("2026-09-23T00:00:00.000Z");

function classified(partial: Partial<ClassifiedWaitingOnItem> & Pick<ClassifiedWaitingOnItem, "sourceRecordId">): ClassifiedWaitingOnItem {
  return {
    brokerageId: 1,
    assignmentId: 1,
    sourceType: "EXCEPTION",
    propertyId: 1,
    status: "WAITING_ON",
    assignedToUserId: 7,
    waitingOnExpectedAt: "2026-09-23T00:00:00.000Z",
    waitingOnSince: null,
    hoursOverdue: 1,
    tier: "visible",
    priorityException: false,
    priorityReasons: [],
    fingerprint: "fp",
    ...partial,
  };
}

test("hours past waitingOnExpectedAt are exact and zero at equality", () => {
  const expected = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(hoursPastWaitingOnExpectedAt(expected, expected), 0);
  assert.equal(hoursPastWaitingOnExpectedAt(expected, new Date(expected.getTime() + HOUR)), 1);
  assert.equal(hoursPastWaitingOnExpectedAt(expected, new Date(expected.getTime() + 90 * 60 * 1000)), 1.5);
  assert.equal(hoursPastWaitingOnExpectedAt(expected, new Date(expected.getTime() - HOUR)), -1);
  assert.equal(hoursPastWaitingOnExpectedAt(expected, new Date(expected.getTime() + 1)), 1 / HOUR);
});

test("tier boundaries are [0, 2) visible, [2, 4) attention, [4, ∞) elevated", () => {
  const expected = new Date("2026-01-01T00:00:00.000Z");
  const at = (ms: number) => classifyWaitingOnTier(hoursPastWaitingOnExpectedAt(expected, new Date(expected.getTime() + ms)), THRESHOLDS);
  assert.equal(at(0), null);
  assert.equal(at(1), "visible");
  assert.equal(at(2 * HOUR - 1), "visible");
  assert.equal(at(2 * HOUR), "pit_crew_attention");
  assert.equal(at(4 * HOUR - 1), "pit_crew_attention");
  assert.equal(at(4 * HOUR), "elevated_attention");
  assert.equal(at(10 * HOUR), "elevated_attention");
});

test("a brokerage can move the tier boundaries", () => {
  const tight = { attentionThresholdHours: 1, elevatedThresholdHours: 3 };
  assert.equal(classifyWaitingOnTier(1.5, tight), "pit_crew_attention");
  assert.equal(classifyWaitingOnTier(1.5, THRESHOLDS), "visible");
  assert.equal(classifyWaitingOnTier(3, tight), "elevated_attention");
  assert.equal(classifyWaitingOnTier(3, THRESHOLDS), "pit_crew_attention");
});

test("dueAt does not make an item overdue when waitingOnExpectedAt is still ahead", () => {
  const now = WEDNESDAY_1000;
  const item = classifyWaitingOnCandidate({
    brokerageId: 1,
    assignmentId: 1,
    sourceType: "EXCEPTION",
    sourceRecordId: "exc",
    propertyId: 1,
    status: "WAITING_ON",
    assignedToUserId: 4,
    waitingOnExpectedAt: new Date(now.getTime() + HOUR),
    waitingOnSince: now,
    now,
    thresholds: THRESHOLDS,
    exceptionCategory: "SETTLEMENT_CLOSURE",
    exceptionDueAt: new Date(now.getTime() - HOUR),
    exceptionEscalatesAt: new Date(now.getTime() - HOUR),
    settlementDate: new Date(now.getTime() - HOUR),
    timeZone: TIME_ZONE,
  });
  assert.equal(item, null);
});

test("equality with waitingOnExpectedAt is not overdue", () => {
  const now = WEDNESDAY_1000;
  const item = classifyWaitingOnCandidate({
    brokerageId: 1,
    assignmentId: 1,
    sourceType: "EXCEPTION",
    sourceRecordId: "exc",
    propertyId: 1,
    status: "WAITING_ON",
    assignedToUserId: null,
    waitingOnExpectedAt: now,
    waitingOnSince: now,
    now,
    thresholds: THRESHOLDS,
    exceptionCategory: null,
    exceptionDueAt: null,
    exceptionEscalatesAt: null,
    settlementDate: null,
    timeZone: TIME_ZONE,
  });
  assert.equal(item, null);
});

test("settlement and AML categories are priority exceptions even when dates are far away", () => {
  const far = new Date("2027-06-01T00:00:00.000Z");
  assert.deepEqual(
    waitingOnPriorityReasons({
      exceptionCategory: "SETTLEMENT_CLOSURE",
      exceptionDueAt: far,
      exceptionEscalatesAt: far,
      settlementDate: far,
      now: WEDNESDAY_1000,
      timeZone: TIME_ZONE,
    }),
    ["settlement_closure_category"],
  );
  assert.deepEqual(
    waitingOnPriorityReasons({
      exceptionCategory: "AML_CTF",
      exceptionDueAt: null,
      exceptionEscalatesAt: null,
      settlementDate: null,
      now: WEDNESDAY_1000,
      timeZone: TIME_ZONE,
    }),
    ["aml_ctf_category"],
  );
  assert.deepEqual(
    waitingOnPriorityReasons({
      exceptionCategory: "WORKFLOW_OPERATIONAL",
      exceptionDueAt: far,
      exceptionEscalatesAt: null,
      settlementDate: null,
      now: WEDNESDAY_1000,
      timeZone: TIME_ZONE,
    }),
    [],
  );
});

test("next-business-day risk uses dueAt, escalatesAt, and an incomplete settlement date", () => {
  const now = WEDNESDAY_1000;
  const end = nextBusinessDayEndExclusive(now, TIME_ZONE);
  assert.equal(end.toISOString(), "2026-09-24T14:00:00.000Z");
  const inside = new Date(end.getTime() - 60 * 1000);
  const outside = new Date(end.getTime());
  assert.equal(isOnOrBeforeNextBusinessDay(inside, now, TIME_ZONE), true);
  assert.equal(isOnOrBeforeNextBusinessDay(outside, now, TIME_ZONE), false);
  assert.equal(isOnOrBeforeNextBusinessDay(null, now, TIME_ZONE), false);
  assert.deepEqual(
    waitingOnPriorityReasons({
      exceptionCategory: "OFFERS",
      exceptionDueAt: inside,
      exceptionEscalatesAt: outside,
      settlementDate: inside,
      now,
      timeZone: TIME_ZONE,
    }),
    ["exception_due_next_business_day", "settlement_date_next_business_day"],
  );
  assert.deepEqual(
    waitingOnPriorityReasons({
      exceptionCategory: "CONTRACT_CONDITIONS",
      exceptionDueAt: null,
      exceptionEscalatesAt: inside,
      settlementDate: null,
      now,
      timeZone: TIME_ZONE,
    }),
    ["exception_escalates_next_business_day"],
  );
});

test("Friday and Saturday both take Monday as the next business day", () => {
  const friday = new Date("2026-09-25T00:00:00.000Z");
  const saturday = new Date("2026-09-26T00:00:00.000Z");
  assert.equal(nextBusinessDayEndExclusive(friday, TIME_ZONE).toISOString(), "2026-09-28T14:00:00.000Z");
  assert.equal(nextBusinessDayEndExclusive(saturday, TIME_ZONE).toISOString(), "2026-09-28T14:00:00.000Z");
});

test("material change is tier, priority, expected-at, status, owner, or waiting-on episode", () => {
  const expected = new Date("2026-09-23T00:00:00.000Z");
  const since = new Date("2026-09-22T00:00:00.000Z");
  const base = waitingOnDetectionFingerprint({
    tier: "visible",
    priorityException: false,
    waitingOnExpectedAt: expected,
    status: "WAITING_ON",
    assignedToUserId: 4,
    waitingOnSince: since,
  });
  assert.equal(isMaterialWaitingOnDetectionChange(base, base), false);
  assert.equal(isMaterialWaitingOnDetectionChange(null, base), true);
  const changed = [
    waitingOnDetectionFingerprint({ ...{ tier: "pit_crew_attention" as const, priorityException: false, waitingOnExpectedAt: expected, status: "WAITING_ON", assignedToUserId: 4, waitingOnSince: since } }),
    waitingOnDetectionFingerprint({ tier: "visible", priorityException: true, waitingOnExpectedAt: expected, status: "WAITING_ON", assignedToUserId: 4, waitingOnSince: since }),
    waitingOnDetectionFingerprint({ tier: "visible", priorityException: false, waitingOnExpectedAt: new Date(expected.getTime() + 1), status: "WAITING_ON", assignedToUserId: 4, waitingOnSince: since }),
    waitingOnDetectionFingerprint({ tier: "visible", priorityException: false, waitingOnExpectedAt: expected, status: "IN_PROGRESS", assignedToUserId: 4, waitingOnSince: since }),
    waitingOnDetectionFingerprint({ tier: "visible", priorityException: false, waitingOnExpectedAt: expected, status: "WAITING_ON", assignedToUserId: 9, waitingOnSince: since }),
    waitingOnDetectionFingerprint({ tier: "visible", priorityException: false, waitingOnExpectedAt: expected, status: "WAITING_ON", assignedToUserId: 4, waitingOnSince: new Date(since.getTime() + 1) }),
  ];
  for (const next of changed) assert.equal(isMaterialWaitingOnDetectionChange(base, next), true);
});

test("priority exceptions sort ahead of a higher hour tier, then most overdue", () => {
  const priorityVisible = classified({
    sourceRecordId: "priority-visible",
    tier: "visible",
    priorityException: true,
    waitingOnExpectedAt: "2026-09-23T02:00:00.000Z",
  });
  const elevated = classified({
    sourceRecordId: "elevated",
    tier: "elevated_attention",
    waitingOnExpectedAt: "2026-09-22T00:00:00.000Z",
  });
  const attentionSooner = classified({
    sourceRecordId: "b-attention",
    tier: "pit_crew_attention",
    waitingOnExpectedAt: "2026-09-23T01:00:00.000Z",
  });
  const attentionLater = classified({
    sourceRecordId: "a-attention",
    tier: "pit_crew_attention",
    waitingOnExpectedAt: "2026-09-23T03:00:00.000Z",
  });
  const sorted = [elevated, attentionLater, priorityVisible, attentionSooner].sort(compareWaitingOnDetections);
  assert.deepEqual(sorted.map((item) => item.sourceRecordId), [
    "priority-visible",
    "elevated",
    "b-attention",
    "a-attention",
  ]);
});

test("the default operating window is Mon–Fri 08:00 inclusive to 18:00 exclusive in the brokerage zone", () => {
  const settings = resolvePitCrewWaitingOnSweepSettings(null, null);
  assert.equal(settings.timeZone, "Australia/Brisbane");
  assert.equal(settings.timeZoneSource, "fallback");
  assert.equal(settings.cadenceMs, PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS);
  assert.equal(settings.attentionThresholdHours, 2);
  assert.equal(settings.elevatedThresholdHours, 4);
  assert.equal(isWithinOperatingWindow(new Date("2026-09-22T21:59:00.000Z"), settings), false);
  assert.equal(isWithinOperatingWindow(new Date("2026-09-22T22:00:00.000Z"), settings), true);
  assert.equal(isWithinOperatingWindow(WEDNESDAY_1000, settings), true);
  assert.equal(isWithinOperatingWindow(new Date("2026-09-23T07:59:00.000Z"), settings), true);
  assert.equal(isWithinOperatingWindow(new Date("2026-09-23T08:00:00.000Z"), settings), false);
  assert.equal(isWithinOperatingWindow(new Date("2026-09-26T00:00:00.000Z"), settings), false);
});

test("settings resolve per brokerage and fall back when stored values are unusable", () => {
  const row = {
    cadenceMs: 1_200_000,
    windowStart: "09:00",
    windowEnd: "17:00",
    windowWeekdays: "1,2,3",
    timeZone: "Australia/Perth",
    attentionThresholdHours: 1,
    elevatedThresholdHours: 6,
    lastDetectionAt: null,
  };
  const resolved = resolvePitCrewWaitingOnSweepSettings(row, "Australia/Sydney");
  assert.equal(resolved.cadenceMs, 1_200_000);
  assert.equal(resolved.windowStart, "09:00");
  assert.equal(resolved.windowEnd, "17:00");
  assert.equal(resolved.timeZone, "Australia/Perth");
  assert.equal(resolved.timeZoneSource, "sweep_settings");
  assert.equal(resolved.attentionThresholdHours, 1);
  assert.equal(resolved.elevatedThresholdHours, 6);
  assert.equal([...resolved.weekdays].sort().join(","), "1,2,3");

  const fromComms = resolvePitCrewWaitingOnSweepSettings(null, "Australia/Sydney");
  assert.equal(fromComms.timeZone, "Australia/Sydney");
  assert.equal(fromComms.timeZoneSource, "communication_settings");

  const broken = resolvePitCrewWaitingOnSweepSettings(
    {
      cadenceMs: 10,
      windowStart: "same",
      windowEnd: "same",
      windowWeekdays: "nope",
      timeZone: "Not/AZone",
      attentionThresholdHours: 5,
      elevatedThresholdHours: 5,
      lastDetectionAt: WEDNESDAY_1000,
    },
    "Also/Not",
  );
  assert.equal(broken.cadenceMs, 60_000);
  assert.equal(broken.windowStart, "08:00");
  assert.equal(broken.windowEnd, "18:00");
  assert.equal(broken.attentionThresholdHours, 2);
  assert.equal(broken.elevatedThresholdHours, 4);
  assert.equal(broken.timeZone, "Australia/Brisbane");
  assert.equal(broken.timeZoneSource, "fallback");
  assert.equal(broken.lastDetectionAt?.toISOString(), WEDNESDAY_1000.toISOString());
});

test("cadence gates a brokerage until the interval has elapsed", () => {
  const cadence = 1_800_000;
  assert.equal(isWaitingOnSweepDue(null, WEDNESDAY_1000, cadence), true);
  assert.equal(isWaitingOnSweepDue(WEDNESDAY_1000, new Date(WEDNESDAY_1000.getTime() + 60_000), cadence), false);
  assert.equal(isWaitingOnSweepDue(WEDNESDAY_1000, new Date(WEDNESDAY_1000.getTime() + cadence), cadence), true);
});
