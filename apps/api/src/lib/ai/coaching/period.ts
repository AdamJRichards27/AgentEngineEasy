// AE GROW Priority 6 Stage C — Business Coach: bounded, deterministic period
// resolution shared by every coaching metric (lib/ai/coaching/metrics.ts).
//
// Deliberately its own tiny, pure, dependency-free module: no database
// access here at all, so every branch is independently unit-testable with a
// fixed `now` (see __tests__/period.test.ts) and the metrics service never
// has to re-derive period boundaries itself.
//
// Timezone note: this codebase's own Grow-specific date logic
// (lib/growToday.ts's startOfTodayUtc/endOfTodayUtc) is plain UTC-calendar
// based, with no per-brokerage/per-user timezone column anywhere in the
// schema (confirmed: neither `users` nor `brokerages` carries a timezone
// field). A separate RUN-side utility (lib/commandCentre/timezone.ts) papers
// over that gap with a hardcoded `Australia/Brisbane` fallback for its own,
// unrelated Pit Crew feature - reusing that here would import a RUN-only
// concept into a deliberately Grow-only feature for no real benefit, since
// it is not actually reading a real per-tenant timezone either. This module
// therefore follows Grow's own, already-established convention (plain UTC
// calendar boundaries) rather than inventing a third one - every period
// label below says so explicitly is UTC-based so nothing here overstates
// precision the codebase doesn't have yet.

export type CoachingPeriodKey = "last7days" | "last30days" | "currentMonth" | "previousPeriod" | "custom";

export interface ResolvedPeriod {
  key: CoachingPeriodKey;
  label: string;
  start: Date;
  end: Date;
  // false for a period that is still "in progress" as of `now` (e.g. the
  // current calendar month) - callers must not present a rate/trend computed
  // from an incomplete period as if it were a finished result without saying so.
  isComplete: boolean;
  durationDays: number;
}

export interface PeriodView {
  key: CoachingPeriodKey;
  label: string;
  start: string;
  end: string;
  isComplete: boolean;
  durationDays: number;
  timeBasis: string;
}

export function toPeriodView(period: ResolvedPeriod): PeriodView {
  return {
    key: period.key,
    label: period.label,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    isComplete: period.isComplete,
    durationDays: period.durationDays,
    timeBasis: "UTC calendar time - this build has no per-brokerage timezone configured",
  };
}

export const CUSTOM_PERIOD_MAX_DAYS = 90;
export const CUSTOM_PERIOD_MAX_LOOKBACK_DAYS = 730;

export class InvalidPeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPeriodError";
  }
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

export interface ResolvePeriodInput {
  period: CoachingPeriodKey;
  // Custom period only - a strictly validated bounded date range (ISO date
  // or date-time strings). Ignored for every other period key.
  startDate?: string | null;
  endDate?: string | null;
  // Injectable so every branch is deterministic and testable without
  // depending on the real wall clock.
  now?: Date;
}

// Throws InvalidPeriodError for anything a client could send that would
// otherwise silently produce a nonsensical or unbounded query - never
// clamps/guesses a "close enough" range instead.
export function resolvePeriod(input: ResolvePeriodInput): ResolvedPeriod {
  const now = input.now ?? new Date();
  const todayStart = startOfUtcDay(now);

  if (input.period === "last7days") {
    const start = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { key: "last7days", label: "Last 7 days", start, end: now, isComplete: true, durationDays: 7 };
  }
  if (input.period === "last30days") {
    const start = new Date(todayStart.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { key: "last30days", label: "Last 30 days", start, end: now, isComplete: true, durationDays: 30 };
  }
  if (input.period === "currentMonth") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const durationDays = Math.max(1, daysBetween(now, start));
    return { key: "currentMonth", label: "This month so far", start, end: now, isComplete: false, durationDays };
  }
  if (input.period === "previousPeriod") {
    // The previous FULL calendar month, deliberately - a self-contained,
    // always-complete period rather than "whatever came immediately before
    // some other arbitrary period" (that shape-aware comparison is
    // resolvePreviousComparablePeriod below, used by compare_performance_periods).
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0));
    const durationDays = daysBetween(currentMonthStart, prevMonthStart);
    return {
      key: "previousPeriod",
      label: "Previous calendar month",
      start: prevMonthStart,
      end: currentMonthStart,
      isComplete: true,
      durationDays,
    };
  }

  // custom
  if (typeof input.startDate !== "string" || input.startDate.length === 0 || typeof input.endDate !== "string" || input.endDate.length === 0) {
    throw new InvalidPeriodError("A custom period requires both startDate and endDate.");
  }
  const start = new Date(input.startDate);
  const end = new Date(input.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new InvalidPeriodError("startDate and endDate must be valid dates.");
  }
  if (start.getTime() >= end.getTime()) {
    throw new InvalidPeriodError("startDate must be before endDate.");
  }
  if (end.getTime() > now.getTime()) {
    throw new InvalidPeriodError("endDate cannot be in the future.");
  }
  const durationDays = daysBetween(end, start);
  if (durationDays > CUSTOM_PERIOD_MAX_DAYS) {
    throw new InvalidPeriodError(`A custom period cannot exceed ${CUSTOM_PERIOD_MAX_DAYS} days.`);
  }
  if (daysBetween(now, start) > CUSTOM_PERIOD_MAX_LOOKBACK_DAYS) {
    throw new InvalidPeriodError(`A custom period cannot start more than ${CUSTOM_PERIOD_MAX_LOOKBACK_DAYS} days ago.`);
  }
  return {
    key: "custom",
    label: `${input.startDate} to ${input.endDate}`,
    start,
    end,
    isComplete: true,
    durationDays,
  };
}

// The period immediately before `period`, of the exact same duration - "like
// with like" for a numeric comparison. Always complete (it necessarily ends
// at or before `period.start`, which is itself at or before `now`).
export function resolvePreviousComparablePeriod(period: ResolvedPeriod): ResolvedPeriod {
  const durationMs = period.end.getTime() - period.start.getTime();
  const start = new Date(period.start.getTime() - durationMs);
  const end = period.start;
  return {
    key: "custom",
    label: `${period.durationDays} days before "${period.label}"`,
    start,
    end,
    isComplete: true,
    durationDays: period.durationDays,
  };
}

// compare_performance_periods' own period-pair resolution: for a calendar
// period (currentMonth) the natural comparison is the previous FULL calendar
// month (not a same-length trailing window, which would either clip or
// overrun a month boundary); for every trailing-window or custom period, an
// equal-length immediately-preceding window is the correct "like with like"
// comparison.
export function resolveComparisonPeriods(periodKey: CoachingPeriodKey, now: Date = new Date()): { a: ResolvedPeriod; b: ResolvedPeriod } {
  const a = resolvePeriod({ period: periodKey, now });
  if (periodKey === "currentMonth") {
    const b = resolvePeriod({ period: "previousPeriod", now });
    return { a, b };
  }
  const b = resolvePreviousComparablePeriod(a);
  return { a, b };
}
