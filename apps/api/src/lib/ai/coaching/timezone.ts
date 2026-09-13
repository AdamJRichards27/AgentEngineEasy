// AE GROW Priority 6 Stage C timezone remediation — Business Coach
// timezone resolution.
//
// Governing decision (Project Owner "REMEDIATION REQUIRED — STAGE C
// TIMEZONE AND FINAL-HEAD VERIFICATION" instruction): coaching periods must
// be calculated in the agent's correct LOCAL calendar timezone, never a
// bare UTC calendar day, because a UTC-only "today"/"this month" can be
// wrong for an agent in Brisbane, Sydney, Adelaide, Perth, or Auckland at
// exactly the times of day this matters most (near midnight UTC, which
// falls mid-morning to mid-afternoon across every AU/NZ zone).
//
// Precedence, per the Project Owner's explicit instruction (highest first):
//   1. Explicit authenticated-user timezone, if this build supported one —
//      it does not: `users` carries no timezone column anywhere in the
//      schema (packages/db/src/schema/users.ts), confirmed before this
//      remediation and unchanged by it (adding one is a schema migration
//      the Project Owner's scope boundary explicitly forbids without
//      separate approval).
//   2. Explicit brokerage timezone — `communication_settings.time_zone`
//      (packages/db/src/schema/communications.ts) IS a real, existing,
//      nullable per-brokerage IANA-timezone column already established by
//      the Communications Hub (Priority 8) and already reused as a
//      fallback source by that hub's own quiet-hours logic
//      (lib/communications/quietHours.ts's resolveCommunicationTimeZone).
//      Stage C reuses the SAME column and the SAME precedent rather than
//      inventing a second per-brokerage timezone concept or a new schema
//      field — there is currently no UI that writes to it, so in practice
//      every brokerage today falls through to tier 3 until one configures
//      it, exactly as quiet hours already does.
//   3. Existing canonical application default — DEFAULT_TIME_ZONE
//      ("Australia/Brisbane", lib/commandCentre/timezone.ts), the one
//      documented, already cross-feature-reused (Command Centre AND
//      Communications Hub) default this codebase has. Reusing it a third
//      time here is the same "don't invent a second concept" discipline
//      already applied to tier 2 above.
//   4. Fail closed / disclose — never reached in this build, since tier 3
//      is always satisfiable. Documented here rather than silently
//      omitted: if a future change ever removed DEFAULT_TIME_ZONE without
//      replacing it, resolveCoachingTimeZone must be revisited rather than
//      inferring a timezone from browser locale, IP address, state
//      abbreviation, or server timezone — none of which this function (or
//      anything it calls) ever does.
//
// This module is deliberately READ-ONLY: resolveCoachingTimeZone below
// performs a plain `db.select()` against communication_settings and never
// calls lib/communications/settings.ts's getOrCreateCommunicationSettings()
// (which has a write side effect — it inserts a settings row on first
// read). Coaching must never create or modify a database record as a
// side effect of answering a read-only question (Stage C's own Level 0
// ceiling), so a brokerage with no settings row yet simply falls through
// to tier 3 above without ever causing one to be created.
//
// A client can never influence this resolution: routes/ai.ts's askSchema
// (a plain, non-.strict() Zod object) has no `timeZone` field, so Zod
// silently drops any such field a client sends before askCopilot() is ever
// called — confirmed by reading that schema directly, and the route
// handler only ever reads specific named fields off the parsed result, not
// a spread of the whole body. This module adds no further defence against
// a client-supplied timezone because there is no code path by which one
// could reach it at all; routes/__tests__/growAskAeCoach.test.ts adds a
// regression test that sending one in the request body has no effect, as a
// permanent guard against that changing silently in the future.
import { eq } from "drizzle-orm";
import { db, communicationSettings } from "@aee/db";
import { DEFAULT_TIME_ZONE, isSameLocalDay, localDateKey, startOfLocalDay, zonedParts, offsetMs } from "../../commandCentre/timezone.js";

export { DEFAULT_TIME_ZONE, isSameLocalDay, localDateKey, startOfLocalDay };

export type CoachingTimeZoneSource = "brokerage" | "fallback";

export interface CoachingTimeZoneResolution {
  timeZone: string;
  source: CoachingTimeZoneSource;
}

// A defensive type-guard, not a format check — Intl.DateTimeFormat is the
// authoritative source of which strings are valid IANA identifiers on this
// runtime, so this deliberately does not try to maintain its own allow-list
// of AU/NZ zone names. Used both to validate a stored brokerage timezone
// before trusting it (resolveCoachingTimeZone below) and directly unit
// tested against every zone this remediation's own test matrix requires
// (see __tests__/timezone.test.ts).
export function isValidIanaTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions();
    return typeof resolved.timeZone === "string" && resolved.timeZone.length > 0;
  } catch {
    return false;
  }
}

// Read-only: a plain, brokerageId-scoped SELECT of one column, never an
// insert/update (see this file's header comment). Never throws on a
// missing row, a null column, or an invalid stored value — every one of
// those falls through to the documented tier-3 application default rather
// than surfacing a raw database or Intl error to the caller.
export async function resolveCoachingTimeZone(brokerageId: number): Promise<CoachingTimeZoneResolution> {
  const rows = await db
    .select({ timeZone: communicationSettings.timeZone })
    .from(communicationSettings)
    .where(eq(communicationSettings.brokerageId, brokerageId))
    .limit(1);
  const candidate = rows[0]?.timeZone ?? null;
  if (candidate !== null && isValidIanaTimeZone(candidate)) {
    return { timeZone: candidate, source: "brokerage" };
  }
  return { timeZone: DEFAULT_TIME_ZONE, source: "fallback" };
}

// The UTC instant that is local midnight, in `timeZone`, on the 1st of the
// calendar month that starts at 0-based month index `monthIndex` of
// `year` — `monthIndex` is intentionally allowed outside 0-11 (e.g. -1 or
// 12) because Date.UTC's own well-defined month-rollover behaviour (an
// index of -1 resolves to December of `year - 1`) is exactly what
// startOfPreviousLocalMonth below needs to cross a December/January
// boundary correctly, with no separate year-rollover branch of its own.
function localMonthStartFromMonthIndex(year: number, monthIndex: number, timeZone: string): Date {
  const utcGuess = Date.UTC(year, monthIndex, 1, 0, 0, 0);
  const guessDate = new Date(utcGuess);
  return new Date(utcGuess - offsetMs(guessDate, timeZone));
}

/** The UTC instant that is local midnight, in `timeZone`, on the 1st of the
 * calendar month that `instant` falls in, in that zone. */
export function startOfLocalMonth(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  return localMonthStartFromMonthIndex(p.year, p.month - 1, timeZone);
}

/** The UTC instant that is local midnight, in `timeZone`, on the 1st of the
 * calendar month immediately before the one `instant` falls in, in that
 * zone — correctly crosses a December/January (and so a year) boundary via
 * Date.UTC's own month-rollover, not a hand-written special case. */
export function startOfPreviousLocalMonth(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  return localMonthStartFromMonthIndex(p.year, p.month - 2, timeZone);
}
