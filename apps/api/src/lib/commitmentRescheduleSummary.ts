import { DEFAULT_TIME_ZONE, isValidIanaTimeZone, resolveTimeZone, zonedParts } from "./commandCentre/timezone.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// The sentence written before this fix. toISOString() is always UTC, so a
// Brisbane morning read as the previous evening. Details and the audit row
// still store the instants; only this displayed sentence is rewritten.
const RAW_RESCHEDULE_SUMMARY =
  /^Commitment rescheduled from (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) to (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/;

/**
 * A due instant as a brokerage-local date and time, in the same en-AU shape
 * other dates use ("5 Oct 2026") plus the time of day, because a reschedule
 * can move the clock without changing the calendar day.
 *
 * Built from the zoned calendar parts rather than Intl's formatted string so
 * the words do not pick up a locale's narrow no-break space.
 */
export function formatCommitmentDue(instant: Date, timeZone: string): string {
  const zone = isValidIanaTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = zonedParts(instant, zone);
  const month = MONTHS[parts.month - 1] ?? "";
  const hour24 = parts.hour % 24;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const ampm = hour24 < 12 ? "am" : "pm";
  const minute = String(parts.minute).padStart(2, "0");
  return `${parts.day} ${month} ${parts.year}, ${hour12}:${minute} ${ampm}`;
}

export function commitmentRescheduleSummary(previousDueAt: Date, newDueAt: Date, timeZone: string): string {
  return `Commitment rescheduled from ${formatCommitmentDue(previousDueAt, timeZone)} to ${formatCommitmentDue(newDueAt, timeZone)}`;
}

export function isRawRescheduleSummary(summary: string): boolean {
  return RAW_RESCHEDULE_SUMMARY.test(summary.trim());
}

/** Rewrites a stored UTC sentence. Any other summary is returned unchanged. */
export function presentActivitySummary(summary: string, timeZone: string): string {
  const match = RAW_RESCHEDULE_SUMMARY.exec(summary.trim());
  if (!match) return summary;
  const previous = new Date(match[1]!);
  const next = new Date(match[2]!);
  if (Number.isNaN(previous.getTime()) || Number.isNaN(next.getTime())) return summary;
  return commitmentRescheduleSummary(previous, next, timeZone);
}

/**
 * Presents activity summaries for an API response. Rows already written in
 * the brokerage zone are left alone, and the timezone is looked up only when
 * a row still holds the old UTC sentence — no backfill of those rows.
 */
export async function presentStoredActivitySummaries<T extends { summary: string }>(
  rows: T[],
  brokerageId: number,
): Promise<T[]> {
  if (!rows.some((row) => isRawRescheduleSummary(row.summary))) return rows;
  const { timeZone } = await resolveTimeZone({ brokerageId });
  return rows.map((row) =>
    isRawRescheduleSummary(row.summary) ? { ...row, summary: presentActivitySummary(row.summary, timeZone) } : row,
  );
}
