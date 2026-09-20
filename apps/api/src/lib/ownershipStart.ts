import { GROW_OWNERSHIP_START_PRECISIONS, type GrowOwnershipStartPrecision } from "@aee/db";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 2 — OBSERVED OWNERSHIP START,
 * the one place a "when did they actually acquire this" value is interpreted.
 *
 * WHY THIS IS SHARED. Exactly two things in the system are allowed to
 * populate growRelationships.ownershipStartDate — the Grow import pipeline
 * (lib/import/normalise.ts, from a mapped column) and a provider `ownership`
 * observation (lib/propertyIntelligence/observations.ts). If each parsed
 * dates its own way they would disagree, and a tenure signal would mean
 * something different depending on where the number came from. They both
 * call this module instead.
 *
 * THE RULE THIS MODULE ENFORCES: NEVER GUESS.
 *
 * A date is either recognised with certainty or rejected. Rejection costs a
 * missing signal. Guessing costs an agent telling a homeowner they have lived
 * somewhere for eleven years when they moved in last spring — so every
 * ambiguous case below resolves to "no value", and the tenure rule then
 * abstains, which is the correct and honest outcome.
 *
 * WHAT IS AND IS NOT ACCEPTED:
 *   - ISO-8601 dates ("2011-03-14", "2011-03-14T00:00:00Z") — day precision.
 *   - ISO year-month ("2011-03") and "03/2011" — MONTH precision, stored as
 *     the first of that month and NEVER presented as a specific day.
 *   - A bare year ("2011") — YEAR precision, stored as 1 January and
 *     presented as "2011".
 *   - Australian day-first dates ("14/03/2011", "14-03-2011", "14.3.2011") —
 *     day precision. AU/NZ is the only market this product serves (see
 *     normalisePhoneAUNZ's identical reasoning in lib/import/normalise.ts).
 *   - Long-form dates ("14 March 2011", "March 2011").
 *   - AMBIGUOUS US-ORDER DATES ARE REJECTED, NOT RE-READ. "03/14/2011" has a
 *     second component of 14, which cannot be an Australian month, so rather
 *     than silently switching convention (and therefore silently switching
 *     convention for "03/04/2011" too, where nobody can tell) the value is
 *     rejected as unrecognised.
 *   - A date in the FUTURE is rejected: an ownership that has not started yet
 *     cannot produce a tenure, and accepting one would produce a negative
 *     age that every band comparison below would read as "brand new".
 *   - A date before 1800 is rejected as a data error (typically a mis-parsed
 *     serial number or a placeholder).
 *
 * EVERYTHING IS UTC. The columns are timestamps without a zone and the whole
 * system runs TZ=UTC; constructing these in an ambient local zone would shift
 * a recorded date across a day boundary.
 */

export interface ParsedOwnershipStart {
  /** The original text, preserved verbatim for audit. */
  original: string;
  /** Midnight UTC at the recognised precision, or null when nothing was recognised. */
  value: Date | null;
  /** The precision actually supplied. Null whenever `value` is null. */
  precision: GrowOwnershipStartPrecision | null;
  /**
   * Why a non-empty input was rejected. Null when the input was blank (not an
   * error) or was accepted. Surfaced to the importing user as a warning so a
   * whole column of unrecognised dates is visible rather than silently ignored.
   */
  rejectedReason: string | null;
}

const EARLIEST_PLAUSIBLE_YEAR = 1800;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

/** Rejects a calendar-invalid combination (31 February) rather than letting Date roll it forward. */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const d = utcDate(year, month, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function reject(original: string, reason: string): ParsedOwnershipStart {
  return { original, value: null, precision: null, rejectedReason: reason };
}

function accept(original: string, value: Date, precision: GrowOwnershipStartPrecision, now: Date): ParsedOwnershipStart {
  if (value.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) {
    return reject(original, `Year ${value.getUTCFullYear()} is before ${EARLIEST_PLAUSIBLE_YEAR} and looks like a data error rather than an ownership date.`);
  }
  if (value.getTime() > now.getTime()) {
    return reject(original, "This date is in the future, so it cannot be the start of an ownership that already exists.");
  }
  return { original, value, precision, rejectedReason: null };
}

/**
 * Parses one raw "date acquired" value. `now` is injectable purely so tests
 * can pin the future-date boundary; production always passes the real clock.
 */
export function parseOwnershipStartDate(raw: string | null | undefined, now: Date = new Date()): ParsedOwnershipStart {
  const original = (raw ?? "").toString().trim();
  if (!original) return { original, value: null, precision: null, rejectedReason: null };

  const text = original.replace(/\s+/g, " ").trim();

  // ISO-8601 full date, with or without a time component. The most common
  // shape a provider sends.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealCalendarDate(year, month, day)) return reject(original, "That is not a real calendar date.");
    return accept(original, utcDate(year, month, day), "day", now);
  }

  // ISO year-month.
  const isoMonth = text.match(/^(\d{4})-(\d{1,2})$/);
  if (isoMonth) {
    const [year, month] = [Number(isoMonth[1]), Number(isoMonth[2])];
    if (month < 1 || month > 12) return reject(original, "Month must be between 1 and 12.");
    return accept(original, utcDate(year, month, 1), "month", now);
  }

  // Bare year.
  const bareYear = text.match(/^(\d{4})$/);
  if (bareYear) {
    return accept(original, utcDate(Number(bareYear[1]), 1, 1), "year", now);
  }

  // MM/YYYY — month precision. Only two components, so there is no day to be
  // ambiguous about.
  const monthYear = text.match(/^(\d{1,2})[/\-.](\d{4})$/);
  if (monthYear) {
    const [month, year] = [Number(monthYear[1]), Number(monthYear[2])];
    if (month < 1 || month > 12) {
      return reject(original, `"${monthYear[1]}" is not a month. AE reads a two-part date as month/year.`);
    }
    return accept(original, utcDate(year, month, 1), "month", now);
  }

  // DD/MM/YYYY — Australian day-first order. A second component above 12
  // means the value is in US order, which is REJECTED rather than re-read:
  // silently switching convention here would silently switch it for
  // "03/04/2011" too, where nothing distinguishes the two readings.
  const dayFirst = text.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (dayFirst) {
    const day = Number(dayFirst[1]);
    const month = Number(dayFirst[2]);
    const yearRaw = dayFirst[3];
    if (yearRaw.length !== 4) {
      return reject(original, "Two-digit years are ambiguous (is 15 1915 or 2015?), so AE needs a four-digit year.");
    }
    const year = Number(yearRaw);
    if (month > 12) {
      return reject(
        original,
        `AE reads dates in Australian day/month/year order, and "${month}" is not a month. If this is month/day/year, please reformat the column.`,
      );
    }
    if (!isRealCalendarDate(year, month, day)) return reject(original, "That is not a real calendar date.");
    return accept(original, utcDate(year, month, day), "day", now);
  }

  // "14 March 2011" / "14 Mar 2011".
  const longDay = text.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
  if (longDay) {
    const month = MONTH_NAMES[longDay[2].toLowerCase()];
    if (month === undefined) return reject(original, `"${longDay[2]}" is not a month name AE recognises.`);
    const [day, year] = [Number(longDay[1]), Number(longDay[3])];
    if (!isRealCalendarDate(year, month, day)) return reject(original, "That is not a real calendar date.");
    return accept(original, utcDate(year, month, day), "day", now);
  }

  // "March 2011".
  const longMonth = text.match(/^([A-Za-z]+),?\s+(\d{4})$/);
  if (longMonth) {
    const month = MONTH_NAMES[longMonth[1].toLowerCase()];
    if (month === undefined) return reject(original, `"${longMonth[1]}" is not a month name AE recognises.`);
    return accept(original, utcDate(Number(longMonth[2]), month, 1), "month", now);
  }

  return reject(original, "AE did not recognise this as a date. Accepted formats include 2011, 03/2011, 14/03/2011 and 2011-03-14.");
}

/** Narrowing guard for a precision value read back out of the database. */
export function isOwnershipStartPrecision(value: unknown): value is GrowOwnershipStartPrecision {
  return typeof value === "string" && (GROW_OWNERSHIP_START_PRECISIONS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------------
 * Provider `ownership` observation payloads.
 * -----------------------------------------------------------------*/

/**
 * The payload keys a provider `ownership` observation may use to state when
 * the CURRENT owner acquired the property.
 *
 * DELIBERATELY NARROW. Keys that describe the property's sale history
 * ("lastSaleDate", "saleDate", "previousSalePrice"...) are NOT in this list,
 * even though they are common and would produce far more matches. "This
 * property last changed hands in 2011" is a fact about the PROPERTY; treating
 * it as "the contact AE currently has recorded as the owner acquired it in
 * 2011" is an inference, and a wrong one exactly when it matters most — when
 * the property has changed hands and AE's owner record is out of date. Only
 * keys that explicitly describe the start of an ownership are read.
 */
export const PROVIDER_OWNERSHIP_START_KEYS = [
  "ownershipStartDate",
  "ownership_start_date",
  "ownershipStart",
  "ownership_start",
  "acquisitionDate",
  "acquisition_date",
  "acquiredDate",
  "acquired_date",
  "purchaseDate",
  "purchase_date",
  "settlementDate",
  "settlement_date",
  "ownedSince",
  "owned_since",
] as const;

export interface ProviderOwnershipStart {
  value: Date;
  precision: GrowOwnershipStartPrecision;
  /** The payload key the value was read from, recorded in evidence so the provenance is traceable. */
  payloadKey: string;
  raw: string;
}

/**
 * Extracts an ownership start date from a provider `ownership` payload, or
 * null when the payload does not explicitly carry one. Checks
 * PROVIDER_OWNERSHIP_START_KEYS in order and takes the first that parses, so
 * the result is deterministic for a given payload.
 */
export function extractProviderOwnershipStart(payload: unknown, now: Date = new Date()): ProviderOwnershipStart | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of PROVIDER_OWNERSHIP_START_KEYS) {
    const raw = record[key];
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const parsed = parseOwnershipStartDate(String(raw), now);
    if (parsed.value && parsed.precision) {
      return { value: parsed.value, precision: parsed.precision, payloadKey: key, raw: parsed.original };
    }
  }
  return null;
}
