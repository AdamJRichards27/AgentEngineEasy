// AE GROW Priority 6 Stage C — Business Coach: bounded, deterministic period
// resolution shared by every coaching metric (lib/ai/coaching/metrics.ts).
//
// Deliberately its own tiny, pure, dependency-free module: no database
// access here at all, so every branch is independently unit-testable with a
// fixed `now` AND a fixed `timeZone` (see __tests__/period.test.ts) and the
// metrics service never has to re-derive period boundaries itself.
//
// AE GROW Priority 6 Stage C TIMEZONE REMEDIATION (Project Owner
// "REMEDIATION REQUIRED — STAGE C TIMEZONE AND FINAL-HEAD VERIFICATION"):
// this module previously resolved every period against plain UTC calendar
// boundaries, following this codebase's own pre-existing Grow-specific
// convention (lib/growToday.ts's startOfTodayUtc/endOfTodayUtc) on the
// stated basis that neither `users` nor `brokerages` carried a timezone
// field. That reasoning is now corrected: `communication_settings.time_zone`
// (packages/db/src/schema/communications.ts) IS a real, established,
// per-brokerage IANA-timezone column, already reused as a fallback source
// by the Communications Hub's own quiet-hours logic
// (lib/communications/quietHours.ts) — Stage C now resolves and threads
// through the SAME canonical timezone (see coaching/timezone.ts's own
// header comment for the full precedence chain and why this does not
// require a new schema field), rather than a bare UTC calendar day that can
// silently disagree with an agent's actual local date in Brisbane, Sydney,
// Adelaide, Perth, or Auckland.
//
// A previously-undisclosed defect found and fixed during this remediation:
// last7days/last30days originally computed `start = todayStart - N*24h`
// with `end = now`, which actually spans N+1 calendar dates (today, plus a
// full N days before it), not N, for any `now` that is not exactly local
// midnight — masked before this remediation by every existing test fixture
// using an exact-UTC-midnight `now`. The corrected formula below
// (`start = localTodayStart - (N-1)*24h`) spans exactly N local calendar
// dates (today, inclusive, plus the previous N-1) — "the current local
// date plus the previous N-1 local dates" — the definition most consistent
// with this UI's own existing "Last 7 days"/"Last 30 days" labels (a
// trailing window ending now, not N complete prior days excluding today),
// now stated explicitly here rather than left implicit.
import {
  DEFAULT_TIME_ZONE,
  startOfLocalMonth,
  startOfPreviousLocalMonth,
  startOfLocalDay,
  type CoachingTimeZoneSource,
} from "./timezone.js";

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
  // AE GROW Priority 6 Stage C timezone remediation additions - the IANA
  // timezone this period's calendar boundaries were actually resolved
  // against (see coaching/timezone.ts's resolveCoachingTimeZone), and
  // whether it came from an explicit brokerage setting or the application
  // default. Every period, including "custom" (whose start/end are given
  // as explicit instants, not derived from a local calendar day), still
  // carries these so a coaching response can always disclose which
  // timezone was used, per the Project Owner's UI disclosure requirement.
  timeZone: string;
  timeZoneSource: CoachingTimeZoneSource;
}

export interface PeriodView {
  key: CoachingPeriodKey;
  label: string;
  start: string;
  end: string;
  isComplete: boolean;
  durationDays: number;
  timeZone: string;
  timeZoneSource: CoachingTimeZoneSource;
  // A short, human-readable disclosure sentence - shown as a tooltip in the
  // UI (AskAgentEngine.tsx's period pill `title`) alongside the plain
  // "label · timeZone" the pill itself always shows.
  timeBasis: string;
}

function describeTimeBasis(timeZone: string, timeZoneSource: CoachingTimeZoneSource): string {
  return timeZoneSource === "brokerage"
    ? `Local calendar time in ${timeZone}, your brokerage's configured timezone.`
    : `Local calendar time in ${timeZone}, this application's default timezone (no brokerage timezone is configured yet).`;
}

export function toPeriodView(period: ResolvedPeriod): PeriodView {
  return {
    key: period.key,
    label: period.label,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    isComplete: period.isComplete,
    durationDays: period.durationDays,
    timeZone: period.timeZone,
    timeZoneSource: period.timeZoneSource,
    timeBasis: describeTimeBasis(period.timeZone, period.timeZoneSource),
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

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResolvePeriodInput {
  period: CoachingPeriodKey;
  // Custom period only - a strictly validated bounded date range (ISO date
  // or date-time strings). Ignored for every other period key. Interpreted
  // as literal instants exactly as given (unchanged by this remediation -
  // a custom range is an explicit, already-unambiguous instant pair, not a
  // local-calendar-day expression), consistent with its own label already
  // stating the exact dates given.
  startDate?: string | null;
  endDate?: string | null;
  // Injectable so every branch is deterministic and testable without
  // depending on the real wall clock.
  now?: Date;
  // AE GROW Priority 6 Stage C timezone remediation - the IANA timezone to
  // resolve local calendar boundaries (today/this month/etc.) against.
  // Optional with a safe, documented default so this module never throws
  // for a caller that has not yet resolved one; every real request path
  // (context/businessCoachContext.ts) always resolves and passes a real
  // one via coaching/timezone.ts's resolveCoachingTimeZone first.
  timeZone?: string;
  timeZoneSource?: CoachingTimeZoneSource;
}

// Throws InvalidPeriodError for anything a client could send that would
// otherwise silently produce a nonsensical or unbounded query - never
// clamps/guesses a "close enough" range instead.
export function resolvePeriod(input: ResolvePeriodInput): ResolvedPeriod {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const timeZoneSource: CoachingTimeZoneSource = input.timeZoneSource ?? "fallback";

  if (input.period === "last7days" || input.period === "last30days") {
    const days = input.period === "last7days" ? 7 : 30;
    const localTodayStart = startOfLocalDay(now, timeZone);
    // (days - 1): today (partial, up to `now`) plus the previous (days - 1)
    // full local calendar days = exactly `days` local calendar dates total.
    // See this file's header comment for the off-by-one this corrects.
    const start = new Date(localTodayStart.getTime() - (days - 1) * DAY_MS);
    return {
      key: input.period,
      label: input.period === "last7days" ? "Last 7 days" : "Last 30 days",
      start,
      end: now,
      isComplete: true,
      durationDays: days,
      timeZone,
      timeZoneSource,
    };
  }
  if (input.period === "currentMonth") {
    const start = startOfLocalMonth(now, timeZone);
    const durationDays = Math.max(1, daysBetween(now, start));
    return { key: "currentMonth", label: "This month so far", start, end: now, isComplete: false, durationDays, timeZone, timeZoneSource };
  }
  if (input.period === "previousPeriod") {
    // The previous FULL local calendar month, deliberately - a self-contained,
    // always-complete period rather than "whatever came immediately before
    // some other arbitrary period" (that shape-aware comparison is
    // resolvePreviousComparablePeriod below, used by compare_performance_periods).
    const currentMonthStart = startOfLocalMonth(now, timeZone);
    const prevMonthStart = startOfPreviousLocalMonth(now, timeZone);
    const durationDays = daysBetween(currentMonthStart, prevMonthStart);
    return {
      key: "previousPeriod",
      label: "Previous calendar month",
      start: prevMonthStart,
      end: currentMonthStart,
      isComplete: true,
      durationDays,
      timeZone,
      timeZoneSource,
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
    timeZone,
    timeZoneSource,
  };
}

// The period immediately before `period`, of the exact same duration - "like
// with like" for a numeric comparison. Always complete (it necessarily ends
// at or before `period.start`, which is itself at or before `now`). Carries
// forward the SAME timeZone/timeZoneSource as `period` - this is a pure
// duration-shift of an already-resolved period, not a fresh local-calendar
// resolution of its own, so there is nothing to re-resolve.
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
    timeZone: period.timeZone,
    timeZoneSource: period.timeZoneSource,
  };
}

// compare_performance_periods' own period-pair resolution: for a calendar
// period (currentMonth) the natural comparison is the previous FULL calendar
// month (not a same-length trailing window, which would either clip or
// overrun a month boundary); for every trailing-window or custom period, an
// equal-length immediately-preceding window is the correct "like with like"
// comparison. Not on the live runtime path today (businessCoachContext.ts
// calls resolvePreviousComparablePeriod directly for every period key
// instead - see that file's own header comment) but kept fully correct and
// tested since it remains public API. timeZone/timeZoneSource default the
// same way resolvePeriod's own do, for the same reason.
export function resolveComparisonPeriods(
  periodKey: CoachingPeriodKey,
  now: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE,
  timeZoneSource: CoachingTimeZoneSource = "fallback",
): { a: ResolvedPeriod; b: ResolvedPeriod } {
  const a = resolvePeriod({ period: periodKey, now, timeZone, timeZoneSource });
  if (periodKey === "currentMonth") {
    const b = resolvePeriod({ period: "previousPeriod", now, timeZone, timeZoneSource });
    return { a, b };
  }
  const b = resolvePreviousComparablePeriod(a);
  return { a, b };
}
