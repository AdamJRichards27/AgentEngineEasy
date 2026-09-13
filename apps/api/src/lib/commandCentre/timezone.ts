// Agent-local time for "today" / "overdue" / "coming up" (Build Instructions
// Section 12). Neither `users` nor `brokerages` carries a stored time zone
// today (verified directly in packages/db/src/schema/users.ts before this
// build) -- there is no "user's stored time zone" or "brokerage time zone"
// to read yet, so every caller resolves to the documented fallback below.
// This is the "1/2/3, document the fallback" path the spec requires, not an
// oversight: when a time zone column is added to users/brokerages, only
// resolveTimeZone() needs to change.
//
// AT Realty's seed data is Queensland (no DST); Australia/Brisbane is the
// fallback both because it matches that data and because it is the example
// used in the spec's own illustrative API response.
//
// AE GROW Priority 6 Stage C timezone remediation reuse note: Stage C's own
// coaching-specific timezone resolution (lib/ai/coaching/timezone.ts) reuses
// DEFAULT_TIME_ZONE, startOfLocalDay, localDateKey, and isSameLocalDay from
// THIS module rather than duplicating the guess-then-correct DST-safe
// technique a second time - zonedParts/offsetMs below are exported (they
// were previously module-private) specifically so coaching/timezone.ts can
// build its own local-MONTH boundary helpers (startOfLocalMonth /
// startOfPreviousLocalMonth, which this module has no use for itself) on
// top of the exact same primitives, rather than a second, subtly different
// implementation of the same DST-correct arithmetic.
export const DEFAULT_TIME_ZONE = "Australia/Brisbane";

export interface TimeZoneResolution {
  timeZone: string;
  source: "user" | "brokerage" | "fallback";
}

export function resolveTimeZone(_user: { id: number; brokerageId: number }): TimeZoneResolution {
  return { timeZone: DEFAULT_TIME_ZONE, source: "fallback" };
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// How far the zone's local clock is ahead of UTC, in ms, at this instant.
// Recomputed per-call rather than cached, so DST transitions resolve
// correctly for the specific instant being asked about.
export function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

/** The UTC instant that is local midnight, in `timeZone`, on the calendar
 * day that `instant` falls on in that zone. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  const utcGuess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  const guessDate = new Date(utcGuess);
  return new Date(utcGuess - offsetMs(guessDate, timeZone));
}

/** Exclusive upper bound: local midnight of the following day. */
export function startOfNextLocalDay(instant: Date, timeZone: string): Date {
  const start = startOfLocalDay(instant, timeZone);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}

/** yyyy-mm-dd for the calendar day `instant` falls on in `timeZone` -- used
 * to compare "is this the same local day" without re-deriving boundaries. */
export function localDateKey(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  return localDateKey(a, timeZone) === localDateKey(b, timeZone);
}

export function isToday(dueAt: Date | null, now: Date, timeZone: string): boolean {
  if (!dueAt) return false;
  return isSameLocalDay(dueAt, now, timeZone);
}

export function isOverdueLocal(dueAt: Date | null, now: Date, timeZone: string): boolean {
  if (!dueAt) return false;
  return dueAt.getTime() < startOfLocalDay(now, timeZone).getTime();
}

/** True when `dueAt` falls on or before the local end of the `days`-day
 * horizon starting today (inclusive of today, per Build Instructions
 * Section 6E's "next seven days" default), and is not already overdue. */
export function isWithinHorizon(dueAt: Date | null, now: Date, timeZone: string, days: number): boolean {
  if (!dueAt) return false;
  if (isOverdueLocal(dueAt, now, timeZone)) return false;
  const horizonEnd = new Date(startOfLocalDay(now, timeZone).getTime() + days * 24 * 60 * 60 * 1000);
  return dueAt.getTime() < horizonEnd.getTime();
}
