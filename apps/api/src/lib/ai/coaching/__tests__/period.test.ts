// AE GROW Priority 6 Stage C — pure unit tests for coaching/period.ts.
//
// Every branch here is exercised with an injected `now` (2026-03-15T00:00:00.000Z,
// deliberately exact UTC midnight so no half-day rounding ambiguity can creep
// into a hand-computed expected value) — no real wall clock, no database,
// matching this module's own "independently unit-testable" design.
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

const NOW = new Date("2026-03-15T00:00:00.000Z");

test("resolvePeriod last7days: start is 7 UTC calendar days before now, end is now, complete, durationDays 7", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW });
  assert.equal(period.key, "last7days");
  assert.equal(period.start.toISOString(), "2026-03-08T00:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 7);
});

test("resolvePeriod last30days: start is 30 UTC calendar days before now", () => {
  const period = resolvePeriod({ period: "last30days", now: NOW });
  assert.equal(period.key, "last30days");
  assert.equal(period.start.toISOString(), "2026-02-13T00:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 30);
});

test("resolvePeriod currentMonth: starts on the 1st of the current UTC month, is NOT complete, durationDays reflects days elapsed so far", () => {
  const period = resolvePeriod({ period: "currentMonth", now: NOW });
  assert.equal(period.key, "currentMonth");
  assert.equal(period.start.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(period.end.toISOString(), NOW.toISOString());
  assert.equal(period.isComplete, false, "a still-running calendar month must never be reported as complete");
  assert.equal(period.durationDays, 14);
});

test("resolvePeriod previousPeriod: the previous FULL calendar month, always complete", () => {
  const period = resolvePeriod({ period: "previousPeriod", now: NOW });
  assert.equal(period.key, "previousPeriod");
  assert.equal(period.start.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 28, "February 2026 is not a leap year (2026 is not divisible by 4)");
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

test("resolvePeriod custom: a valid bounded range resolves with the exact dates given and a human-readable label", () => {
  const period = resolvePeriod({ period: "custom", startDate: "2026-01-01", endDate: "2026-01-10", now: NOW });
  assert.equal(period.key, "custom");
  assert.equal(period.start.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-01-10T00:00:00.000Z");
  assert.equal(period.isComplete, true);
  assert.equal(period.durationDays, 9);
  assert.equal(period.label, "2026-01-01 to 2026-01-10");
});

test("resolvePreviousComparablePeriod: returns the immediately preceding period of the exact same duration, always complete, key 'custom'", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW });
  const previous = resolvePreviousComparablePeriod(period);
  assert.equal(previous.key, "custom");
  assert.equal(previous.start.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.equal(previous.end.toISOString(), "2026-03-08T00:00:00.000Z");
  assert.equal(previous.isComplete, true);
  assert.equal(previous.durationDays, 7);
});

test("resolveComparisonPeriods: for currentMonth, the comparison is against the previous FULL calendar month (not a same-length trailing window)", () => {
  const { a, b } = resolveComparisonPeriods("currentMonth", NOW);
  assert.equal(a.key, "currentMonth");
  assert.equal(b.key, "previousPeriod");
  assert.equal(b.start.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(b.end.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("resolveComparisonPeriods: for every other period key, the comparison is an equal-length immediately-preceding window", () => {
  const { a, b } = resolveComparisonPeriods("last7days", NOW);
  assert.equal(a.key, "last7days");
  assert.equal(b.key, "custom");
  assert.equal(b.durationDays, a.durationDays);
  assert.equal(b.end.toISOString(), a.start.toISOString(), "the comparison window must end exactly where the current period starts, with no gap or overlap");
});

test("toPeriodView: converts Date fields to ISO strings, preserves every other field, and states the UTC-only time basis", () => {
  const period = resolvePeriod({ period: "last7days", now: NOW });
  const view = toPeriodView(period);
  assert.equal(view.key, "last7days");
  assert.equal(view.label, period.label);
  assert.equal(view.start, period.start.toISOString());
  assert.equal(view.end, period.end.toISOString());
  assert.equal(view.isComplete, period.isComplete);
  assert.equal(view.durationDays, period.durationDays);
  assert.match(view.timeBasis, /UTC/);
  assert.match(view.timeBasis, /no per-brokerage timezone/);
});
