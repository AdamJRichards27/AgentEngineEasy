// AE GROW Priority 6 Stage C — pure unit tests for coaching/period.ts.
//
// AE GROW Priority 6 Stage C TIMEZONE REMEDIATION: every period-resolution
// branch below is now exercised with an explicit `timeZone` (in addition to
// the already-injected `now`) - no real wall clock, no database, matching
// this module's own "independently unit-testable" design, extended to
// cover the local-calendar-day/month math this remediation added. The
// primary suite below uses Australia/Brisbane (a fixed +10:00 offset, no
// DST, so its boundaries are the easiest to hand-verify); the "required
// timezone test matrix" section further down repeats currentMonth/
// previousPeriod resolution across every zone and DST state the Project
// Owner's authorisation requires (Sydney standard and DST, Adelaide's
// half-hour offset in both states, Perth, Auckland standard and DST), plus
// a currentMonth resolution that spans an actual DST transition. Deeper
// primitive-level edge cases (an invalid timezone string, a UTC calendar
// date disagreeing with the local one, the exact DST transition instant,
// and a plain month/year boundary) are covered directly against
// coaching/timezone.ts's own primitives in __tests__/timezone.test.ts
// instead of being re-derived here a second time.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CUSTOM_PERIOD_MAX_DAYS,
  CUSTOM_PERIOD_MAX_LOOKBACK_DAYS,
  InvalidPeriodError,
  resolveComparisonPeriods,
  resolvePeriod,
  resolvePreviousComparablePeriod,
  toPeriodView,
} from "../period.js";
import { DEFAULT_TIME_ZONE } from "../timezone.js";

const NOW = new Date("2026-03-15T00:00:00.000Z");
const BRISBANE = "Australia/Brisbane";

// ---------------------------------------------------------------------------
// Primary suite - Australia/Brisbane (fixed +10:00, no DST)
// ---------------------------------------------------------------------------

test("resolvePeriod last7days: 7 LOCAL calendar dates (today plus the previous 6), end is now, complete, durationDays 7", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  assert.equal(period.key, "last7days");
  // Local midnight today (15 March, Brisbane) is 2026-03-14T14:00:00.000Z;
  // 6 local days earlier is 2026-03-08T14:00:00.000Z - together with the
  // (partial) 15th itself, that is exactly 7 local calendar dates, fixing
  // the previously-undisclosed off-by-one this remediation found (the old
  // UTC formula spanned 8 dates for any `now` not at exact local midnight).
  assert.equal(period.start.toISOString(), "2026-03-08T14:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 7);
  assert.equal(period.timeZone, BRISBANE);
  assert.equal(period.timeZoneSource, "fallback");
});

test("resolvePeriod last30days: 30 LOCAL calendar dates (today plus the previous 29)", () => {
  const period = resolvePeriod({ period: "last30days", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  assert.equal(period.key, "last30days");
  assert.equal(period.start.toISOString(), "2026-02-13T14:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 30);
});

test("resolvePeriod currentMonth: starts on the 1st of the current LOCAL month, is NOT complete, durationDays reflects local days elapsed so far", () => {
  const period = resolvePeriod({ period: "currentMonth", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  assert.equal(period.key, "currentMonth");
  // Local midnight 1 March, Brisbane (+10:00) = 2026-02-28T14:00:00.000Z.
  assert.equal(period.start.toISOString(), "2026-02-28T14:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, false, "a still-running calendar month must never be reported as complete");
  assert.equal(period.durationDays, 14);
});

test("resolvePeriod previousPeriod: the previous FULL local calendar month, always complete", () => {
  const period = resolvePeriod({ period: "previousPeriod", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  assert.equal(period.key, "previousPeriod");
  assert.equal(period.start.toISOString(), "2026-01-31T14:00:00.000Z", "local midnight 1 February, Brisbane");
  assert.equal(period.end.toISOString(), "2026-02-28T14:00:00.000Z", "local midnight 1 March, Brisbane - the current month's own start");
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 28, "February 2026 is not a leap year (2026 is not divisible by 4)");
});

test("resolvePeriod: with no timeZone given at all, defaults safely to the application default and source 'fallback' (REQUIRED CASE: missing timezone)", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW });
  assert.equal(period.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(period.timeZoneSource, "fallback");
});

test("resolvePeriod custom: missing startDate/endDate throws InvalidPeriodError", () => {
  assert.throws(() => resolvePeriod({ period: "custom", now: NOW }), InvalidPeriodError);
  assert.throws(() => resolvePeriod({ period: "custom", startDate: "2026-01-01", now: NOW }), InvalidPeriodError);
  assert.throws(() => resolvePeriod({ period: "custom", endDate: "2026-01-10", now: NOW }), InvalidPeriodError);
});

test("resolvePeriod custom: unparseable date strings throw InvalidPeriodError", () => {
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "not-a-date", endDate: "2026-01-10", now: NOW }),
    InvalidPeriodError,
  );
});

test("resolvePeriod custom: startDate at or after endDate throws InvalidPeriodError", () => {
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "2026-01-10", endDate: "2026-01-10", now: NOW }),
    InvalidPeriodError,
  );
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "2026-01-20", endDate: "2026-01-10", now: NOW }),
    InvalidPeriodError,
  );
});

test("resolvePeriod custom: endDate after now throws InvalidPeriodError", () => {
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "2026-01-01", endDate: "2026-04-01", now: NOW }),
    InvalidPeriodError,
  );
});

test("resolvePeriod custom: endDate exactly equal to now is accepted (the future check is strictly-greater-than)", () => {
  const period = resolvePeriod({ period: "custom", startDate: "2026-01-01", endDate: NOW.toISOString(), now: NOW });
  assert.equal(period.end.toISOString(), NOW.toISOString());
});

test(`resolvePeriod custom: a range longer than CUSTOM_PERIOD_MAX_DAYS (${CUSTOM_PERIOD_MAX_DAYS}) throws InvalidPeriodError`, () => {
  assert.equal(CUSTOM_PERIOD_MAX_DAYS, 90);
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "2025-01-01", endDate: "2025-06-01", now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidPeriodError);
      assert.match((err as Error).message, /cannot exceed 90 days/);
      return true;
    },
  );
});

test(`resolvePeriod custom: a start date more than CUSTOM_PERIOD_MAX_LOOKBACK_DAYS (${CUSTOM_PERIOD_MAX_LOOKBACK_DAYS}) before now throws InvalidPeriodError, even for a short-duration range`, () => {
  assert.equal(CUSTOM_PERIOD_MAX_LOOKBACK_DAYS, 730);
  // 2024-01-01 to 2026-03-15 is 804 days (2024 is a leap year: 366 + 365 + 73)
  // — well past the lookback cap — while the range itself is only 9 days,
  // isolating the lookback check from the max-duration check above.
  assert.throws(
    () => resolvePeriod({ period: "custom", startDate: "2024-01-01", endDate: "2024-01-10", now: NOW }),
    (err: unknown) => {
      assert.ok(err instanceof InvalidPeriodError);
      assert.match((err as Error).message, /cannot start more than 730 days ago/);
      return true;
    },
  );
});

test("resolvePeriod custom: a valid bounded range resolves with the exact dates given and a human-readable label, and still carries the given timeZone/timeZoneSource even though it is not used for calendar math", () => {
  const period = resolvePeriod({ period: "custom", startDate: "2026-01-01", endDate: "2026-01-10", now: NOW, timeZone: "Australia/Sydney", timeZoneSource: "brokerage" });
  assert.equal(period.key, "custom");
  assert.equal(period.start.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-01-10T00:00:00.000Z");
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 9);
  assert.equal(period.label, "2026-01-01 to 2026-01-10");
  assert.equal(period.timeZone, "Australia/Sydney");
  assert.equal(period.timeZoneSource, "brokerage");
});

test("resolvePreviousComparablePeriod: returns the immediately preceding period of the exact same duration, always complete, key 'custom', carrying forward the same timezone", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  const previous = resolvePreviousComparablePeriod(period);
  assert.equal(previous.key, "custom");
  assert.equal(previous.start.toISOString(), "2026-03-02T04:00:00.000Z");
  assert.equal(previous.end.toISOString(), "2026-03-08T14:00:00.000Z", "ends exactly where the current period starts, with no gap or overlap");
  assert.equal(previous.isComplete, true);
  assert.equal(previous.durationDays, 7);
  assert.equal(previous.timeZone, BRISBANE);
  assert.equal(previous.timeZoneSource, "fallback");
});

test("resolveComparisonPeriods: for currentMonth, the comparison is against the previous FULL local calendar month (not a same-length trailing window)", () => {
  const { a, b } = resolveComparisonPeriods("currentMonth", NOW, BRISBANE, "fallback");
  assert.equal(a.key, "currentMonth");
  assert.equal(b.key, "previousPeriod");
  assert.equal(b.start.toISOString(), "2026-01-31T14:00:00.000Z");
  assert.equal(b.end.toISOString(), "2026-02-28T14:00:00.000Z");
});

test("resolveComparisonPeriods: for every other period key, the comparison is an equal-length immediately-preceding window carrying the same timezone", () => {
  const { a, b } = resolveComparisonPeriods("last7days", NOW, BRISBANE, "fallback");
  assert.equal(a.key, "last7days");
  assert.equal(b.key, "custom");
  assert.equal(b.durationDays, a.durationDays);
  assert.equal(b.end.toISOString(), a.start.toISOString(), "the comparison window must end exactly where the current period starts, with no gap or overlap");
  assert.equal(b.timeZone, a.timeZone);
  assert.equal(b.timeZoneSource, a.timeZoneSource);
});

test("resolveComparisonPeriods: defaults to the application timezone when none is given, exactly like resolvePeriod itself", () => {
  const { a } = resolveComparisonPeriods("last7days", NOW);
  assert.equal(a.timeZone, DEFAULT_TIME_ZONE);
  assert.equal(a.timeZoneSource, "fallback");
});

test("toPeriodView: converts Date fields to ISO strings, preserves every other field, and discloses the resolved timezone and its source", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW, timeZone: "Australia/Sydney", timeZoneSource: "brokerage" });
  const view = toPeriodView(period);
  assert.equal(view.key, "last7days");
  assert.equal(view.label, period.label);
  assert.equal(view.start, period.start.toISOString());
  assert.equal(view.end, period.end.toISOString());
  assert.equal(view.isComplete, period.isComplete);
  assert.equal(view.durationDays, period.durationDays);
  assert.equal(view.timeZone, "Australia/Sydney");
  assert.equal(view.timeZoneSource, "brokerage");
  assert.match(view.timeBasis, /Australia\/Sydney/);
  assert.match(view.timeBasis, /brokerage's configured timezone/);
});

test("toPeriodView: an application-default (fallback) period's timeBasis discloses that no brokerage timezone is configured", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW, timeZone: BRISBANE, timeZoneSource: "fallback" });
  const view = toPeriodView(period);
  assert.match(view.timeBasis, /Australia\/Brisbane/);
  assert.match(view.timeBasis, /no brokerage timezone is configured/);
});

// ---------------------------------------------------------------------------
// AE GROW Priority 6 Stage C timezone remediation — required timezone test
// matrix (period-resolution level). See this file's header comment for how
// this section divides responsibility with __tests__/timezone.test.ts.
// ---------------------------------------------------------------------------

test("required matrix — Brisbane (no DST): the same currentMonth resolution logic applies unchanged whether asked in AU summer or AU winter", () => {
  const summer = resolvePeriod({ period: "currentMonth", now: new Date("2026-01-15T00:00:00.000Z"), timeZone: BRISBANE, timeZoneSource: "fallback" });
  const winter = resolvePeriod({ period: "currentMonth", now: new Date("2026-07-15T00:00:00.000Z"), timeZone: BRISBANE, timeZoneSource: "fallback" });
  assert.equal(summer.start.toISOString(), "2025-12-31T14:00:00.000Z");
  assert.equal(winter.start.toISOString(), "2026-06-30T14:00:00.000Z");
});

test("required matrix — Sydney (standard time, AEST +10:00, July)", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Sydney", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2026-06-30T14:00:00.000Z");
});

test("required matrix — Sydney (daylight time, AEDT +11:00, January)", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Sydney", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2025-12-31T13:00:00.000Z");
});

test("required matrix — Sydney, a currentMonth resolution spanning the actual AEST->AEDT DST transition (month starts pre-transition, `now` is post-transition)", () => {
  const now = new Date("2026-10-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Sydney", timeZoneSource: "fallback" });
  // 1 October 2026 is itself still AEST (DST starts Sunday 4 October) - the
  // month's start must use THAT day's own offset, not `now`'s (AEDT).
  assert.equal(period.start.toISOString(), "2026-09-30T14:00:00.000Z");
  assert.equal(period.durationDays, 14);
});

test("required matrix — Adelaide (half-hour offset, ACST +09:30 standard time, July)", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Adelaide", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2026-06-30T14:30:00.000Z");
});

test("required matrix — Adelaide (half-hour offset, ACDT +10:30 daylight time, January)", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Adelaide", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2025-12-31T13:30:00.000Z");
});

test("required matrix — Perth (AWST +08:00, never observes DST)", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Australia/Perth", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2026-06-30T16:00:00.000Z");
});

test("required matrix — Perth: previousPeriod correctly crosses a YEAR boundary (December 2025 -> January 2026)", () => {
  const now = new Date("2026-01-10T00:00:00.000Z");
  const period = resolvePeriod({ period: "previousPeriod", now, timeZone: "Australia/Perth", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2025-11-30T16:00:00.000Z", "local midnight 1 December 2025, Perth");
  assert.equal(period.end.toISOString(), "2025-12-31T16:00:00.000Z", "local midnight 1 January 2026, Perth");
  assert.equal(period.durationDays, 31, "December has 31 days");
});

test("required matrix — Auckland (standard time, NZST +12:00, July)", () => {
  const now = new Date("2026-07-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Pacific/Auckland", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2026-06-30T12:00:00.000Z");
});

test("required matrix — Auckland (daylight time, NZDT +13:00, January)", () => {
  const now = new Date("2026-01-15T00:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Pacific/Auckland", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2025-12-31T11:00:00.000Z");
});

test("required matrix — Auckland: a UTC calendar date that already disagrees with the local calendar month (still 31 January UTC, already 1 February local)", () => {
  const now = new Date("2026-01-31T12:00:00.000Z");
  const period = resolvePeriod({ period: "currentMonth", now, timeZone: "Pacific/Auckland", timeZoneSource: "fallback" });
  assert.equal(period.start.toISOString(), "2026-01-31T11:00:00.000Z", "the local month is already February - its 1st, local midnight, is 2026-01-31T11:00:00.000Z UTC");
  assert.equal(period.durationDays, 1, "only about an hour has elapsed in the new local month, floored up to the minimum of 1 reported day");
});
