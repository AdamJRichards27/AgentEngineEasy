// R-F5: pure classification for the scheduled Pit Crew WAITING_ON sweep.
//
// The scheduled path identifies, classifies, sorts, and surfaces overdue
// WAITING_ON items. It does not contact anyone and it does not change
// assignment, exception, or transaction state. The overdue clock is
// waitingOnExpectedAt. dueAt on the linked exception is a priority signal
// only; it is not the overdue threshold, and the workspace overdue flag
// (queries.ts, dueAt < now) is unchanged.
//
// Local-time arithmetic below matches the application's existing
// zoned-parts / offset technique. This slice does not modify commandCentre.

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS = 1_800_000;
export const PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS = 60_000;
export const PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS = 86_400_000;

/** Timer jitter allowance so a wake that lands a few seconds early still counts as due. */
export const PIT_CREW_WAITING_ON_SWEEP_CADENCE_GRACE_MS = 5_000;

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_START = "08:00";
export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_END = "18:00";
/** ISO weekdays, Monday=1 .. Sunday=7. Default is Monday–Friday. */
export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WEEKDAYS = "1,2,3,4,5";
/**
 * Same documented application fallback used when a brokerage has no time
 * zone of its own (Australia/Brisbane, no daylight-saving shift).
 */
export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_TIME_ZONE = "Australia/Brisbane";

export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ATTENTION_THRESHOLD_HOURS = 2;
export const PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ELEVATED_THRESHOLD_HOURS = 4;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const WAITING_ON_ATTENTION_TIERS = ["visible", "pit_crew_attention", "elevated_attention"] as const;
export type WaitingOnAttentionTier = (typeof WAITING_ON_ATTENTION_TIERS)[number];

export const WAITING_ON_PRIORITY_REASONS = [
  "settlement_closure_category",
  "aml_ctf_category",
  "exception_due_next_business_day",
  "exception_escalates_next_business_day",
  "settlement_date_next_business_day",
] as const;
export type WaitingOnPriorityReason = (typeof WAITING_ON_PRIORITY_REASONS)[number];

/**
 * Settlement/compliance-critical categories already on risk_exceptions.
 * SETTLEMENT_CLOSURE is the settlement signal. AML_CTF is the compliance
 * signal. Other categories are not settlement/compliance-critical by name.
 * dismissible and severity are not used: non-dismissible and CRITICAL
 * findings exist outside those two categories.
 */
export const SETTLEMENT_COMPLIANCE_CATEGORIES = ["SETTLEMENT_CLOSURE", "AML_CTF"] as const;

export interface PitCrewWaitingOnSweepSettingsInput {
  cadenceMs: number;
  windowStart: string;
  windowEnd: string;
  windowWeekdays: string;
  timeZone: string | null;
  attentionThresholdHours: number;
  elevatedThresholdHours: number;
  lastDetectionAt: Date | null;
}

export interface ResolvedPitCrewWaitingOnSweepSettings {
  cadenceMs: number;
  windowStart: string;
  windowEnd: string;
  weekdays: ReadonlySet<number>;
  timeZone: string;
  timeZoneSource: "sweep_settings" | "communication_settings" | "fallback";
  attentionThresholdHours: number;
  elevatedThresholdHours: number;
  lastDetectionAt: Date | null;
}

export interface WaitingOnTierThresholds {
  attentionThresholdHours: number;
  elevatedThresholdHours: number;
}

export interface WaitingOnPriorityInput {
  exceptionCategory: string | null;
  exceptionDueAt: Date | null;
  exceptionEscalatesAt: Date | null;
  /** Earliest settlementDate on an incomplete transaction for the property. */
  settlementDate: Date | null;
  now: Date;
  timeZone: string;
}

export interface ClassifiedWaitingOnItem {
  brokerageId: number;
  assignmentId: number;
  sourceType: string;
  sourceRecordId: string;
  propertyId: number;
  status: string;
  assignedToUserId: number | null;
  waitingOnExpectedAt: string;
  waitingOnSince: string | null;
  hoursOverdue: number;
  tier: WaitingOnAttentionTier;
  priorityException: boolean;
  priorityReasons: WaitingOnPriorityReason[];
  fingerprint: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instant: Date, timeZone: string): ZonedParts {
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
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instant.getTime();
}

function startOfLocalDay(instant: Date, timeZone: string): Date {
  const p = zonedParts(instant, timeZone);
  const utcGuess = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  return new Date(utcGuess - offsetMs(new Date(utcGuess), timeZone));
}

/** ISO weekday for a Gregorian calendar date. Monday=1 .. Sunday=7. */
function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

function parseHhMm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function parseWeekdays(value: string): Set<number> | null {
  const days = new Set<number>();
  for (const token of value.split(",")) {
    const trimmed = token.trim();
    if (!/^[1-7]$/.test(trimmed)) continue;
    days.add(Number(trimmed));
  }
  return days.size > 0 ? days : null;
}

export function isValidTimeZone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function clampCadenceMs(value: number): number {
  if (!Number.isFinite(value)) return PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS;
  const parsed = Math.trunc(value);
  if (parsed < PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS) return PIT_CREW_WAITING_ON_SWEEP_MIN_CADENCE_MS;
  if (parsed > PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS) return PIT_CREW_WAITING_ON_SWEEP_MAX_CADENCE_MS;
  return parsed;
}

function resolveThresholds(attention: number, elevated: number): WaitingOnTierThresholds {
  if (!Number.isFinite(attention) || !Number.isFinite(elevated) || attention <= 0 || elevated <= attention) {
    return {
      attentionThresholdHours: PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ATTENTION_THRESHOLD_HOURS,
      elevatedThresholdHours: PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ELEVATED_THRESHOLD_HOURS,
    };
  }
  return { attentionThresholdHours: attention, elevatedThresholdHours: elevated };
}

function resolveTimeZone(
  configured: string | null | undefined,
  communicationTimeZone: string | null | undefined,
): { timeZone: string; timeZoneSource: ResolvedPitCrewWaitingOnSweepSettings["timeZoneSource"] } {
  const own = configured?.trim() ?? "";
  if (own && isValidTimeZone(own)) return { timeZone: own, timeZoneSource: "sweep_settings" };
  const comms = communicationTimeZone?.trim() ?? "";
  if (comms && isValidTimeZone(comms)) return { timeZone: comms, timeZoneSource: "communication_settings" };
  return { timeZone: PIT_CREW_WAITING_ON_SWEEP_DEFAULT_TIME_ZONE, timeZoneSource: "fallback" };
}

/**
 * Defaults when `row` is null. Invalid stored cadence, thresholds, window,
 * or weekdays fall back to the defaults rather than disabling the sweep or
 * throwing. An invalid time zone falls through to communication settings,
 * then Australia/Brisbane.
 */
export function resolvePitCrewWaitingOnSweepSettings(
  row: PitCrewWaitingOnSweepSettingsInput | null,
  communicationTimeZone: string | null,
): ResolvedPitCrewWaitingOnSweepSettings {
  const zone = resolveTimeZone(row?.timeZone, communicationTimeZone);
  const thresholds = resolveThresholds(
    row?.attentionThresholdHours ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ATTENTION_THRESHOLD_HOURS,
    row?.elevatedThresholdHours ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_ELEVATED_THRESHOLD_HOURS,
  );
  const rawStart = row?.windowStart ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_START;
  const rawEnd = row?.windowEnd ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_END;
  const rawWeekdays = row?.windowWeekdays ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WEEKDAYS;
  const startMinutes = parseHhMm(rawStart);
  const endMinutes = parseHhMm(rawEnd);
  const weekdays = parseWeekdays(rawWeekdays);
  const windowValid = startMinutes != null && endMinutes != null && startMinutes !== endMinutes && weekdays != null;
  return {
    cadenceMs: clampCadenceMs(row?.cadenceMs ?? PIT_CREW_WAITING_ON_SWEEP_DEFAULT_CADENCE_MS),
    windowStart: windowValid ? rawStart.trim() : PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_START,
    windowEnd: windowValid ? rawEnd.trim() : PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WINDOW_END,
    weekdays: windowValid ? weekdays! : parseWeekdays(PIT_CREW_WAITING_ON_SWEEP_DEFAULT_WEEKDAYS)!,
    timeZone: zone.timeZone,
    timeZoneSource: zone.timeZoneSource,
    attentionThresholdHours: thresholds.attentionThresholdHours,
    elevatedThresholdHours: thresholds.elevatedThresholdHours,
    lastDetectionAt: row?.lastDetectionAt ?? null,
  };
}

/**
 * True when `now` is inside the brokerage window. Start is inclusive, end
 * is exclusive. A window that passes midnight (start > end) is supported.
 */
export function isWithinOperatingWindow(now: Date, settings: ResolvedPitCrewWaitingOnSweepSettings): boolean {
  const parts = zonedParts(now, settings.timeZone);
  const weekday = isoWeekday(parts.year, parts.month, parts.day);
  if (!settings.weekdays.has(weekday)) return false;
  const start = parseHhMm(settings.windowStart);
  const end = parseHhMm(settings.windowEnd);
  if (start == null || end == null || start === end) return false;
  const minutes = parts.hour * 60 + parts.minute;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

/** Due when this brokerage has never been detected, or the cadence (minus grace) has elapsed. */
export function isWaitingOnSweepDue(lastDetectionAt: Date | null, now: Date, cadenceMs: number): boolean {
  if (lastDetectionAt == null) return true;
  return now.getTime() - lastDetectionAt.getTime() >= cadenceMs - PIT_CREW_WAITING_ON_SWEEP_CADENCE_GRACE_MS;
}

/**
 * Exclusive end of the next business day: local midnight at the start of
 * the calendar day after the next Mon–Fri. "Next" means the following
 * weekday after today's local date, so Friday's next business day is
 * Monday and Saturday's is Monday. No holiday calendar exists on the
 * brokerage or transaction model, so public holidays are not excluded.
 */
export function nextBusinessDayEndExclusive(now: Date, timeZone: string): Date {
  let cursor = new Date(startOfLocalDay(now, timeZone).getTime() + MS_PER_DAY);
  for (let step = 0; step < 7; step += 1) {
    const parts = zonedParts(cursor, timeZone);
    if (isoWeekday(parts.year, parts.month, parts.day) <= 5) {
      return new Date(startOfLocalDay(cursor, timeZone).getTime() + MS_PER_DAY);
    }
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }
  return new Date(cursor.getTime() + MS_PER_DAY);
}

/** True when `instant` is strictly before the end of the next business day. */
export function isOnOrBeforeNextBusinessDay(instant: Date | null, now: Date, timeZone: string): boolean {
  if (instant == null) return false;
  return instant.getTime() < nextBusinessDayEndExclusive(now, timeZone).getTime();
}

/** Hours after waitingOnExpectedAt. Negative when the expected time is still ahead. Zero at equality. */
export function hoursPastWaitingOnExpectedAt(waitingOnExpectedAt: Date, now: Date): number {
  return (now.getTime() - waitingOnExpectedAt.getTime()) / MS_PER_HOUR;
}

/**
 * Tier from hours overdue. Not overdue (hours <= 0) returns null.
 * [0, attention) visible, [attention, elevated) pit crew attention,
 * [elevated, ∞) elevated attention. Defaults: attention=2, elevated=4.
 */
export function classifyWaitingOnTier(hoursOverdue: number, thresholds: WaitingOnTierThresholds): WaitingOnAttentionTier | null {
  if (!(hoursOverdue > 0)) return null;
  if (hoursOverdue < thresholds.attentionThresholdHours) return "visible";
  if (hoursOverdue < thresholds.elevatedThresholdHours) return "pit_crew_attention";
  return "elevated_attention";
}

export function waitingOnPriorityReasons(input: WaitingOnPriorityInput): WaitingOnPriorityReason[] {
  const reasons: WaitingOnPriorityReason[] = [];
  if (input.exceptionCategory === "SETTLEMENT_CLOSURE") reasons.push("settlement_closure_category");
  if (input.exceptionCategory === "AML_CTF") reasons.push("aml_ctf_category");
  if (isOnOrBeforeNextBusinessDay(input.exceptionDueAt, input.now, input.timeZone)) {
    reasons.push("exception_due_next_business_day");
  }
  if (isOnOrBeforeNextBusinessDay(input.exceptionEscalatesAt, input.now, input.timeZone)) {
    reasons.push("exception_escalates_next_business_day");
  }
  if (isOnOrBeforeNextBusinessDay(input.settlementDate, input.now, input.timeZone)) {
    reasons.push("settlement_date_next_business_day");
  }
  return reasons;
}

/**
 * Material-change fingerprint. A repeat alert is suppressed while every
 * component is unchanged:
 * - attention tier
 * - priority-exception flag (settlement/compliance-critical or next-business-day risk)
 * - waitingOnExpectedAt
 * - status
 * - owner (assignedToUserId)
 * - waitingOnSince (the current WAITING_ON episode; a re-park is a new episode)
 *
 * Hours advancing inside the same tier, and edits to waitingOnParty or
 * waitingOnNote, are not material.
 */
export function waitingOnDetectionFingerprint(input: {
  tier: WaitingOnAttentionTier;
  priorityException: boolean;
  waitingOnExpectedAt: Date;
  status: string;
  assignedToUserId: number | null;
  waitingOnSince: Date | null;
}): string {
  return [
    input.tier,
    input.priorityException ? "1" : "0",
    input.waitingOnExpectedAt.toISOString(),
    input.status,
    input.assignedToUserId == null ? "" : String(input.assignedToUserId),
    input.waitingOnSince ? input.waitingOnSince.toISOString() : "",
  ].join("|");
}

export function isMaterialWaitingOnDetectionChange(previousFingerprint: string | null, nextFingerprint: string): boolean {
  return previousFingerprint !== nextFingerprint;
}

const TIER_RANK: Record<WaitingOnAttentionTier, number> = {
  elevated_attention: 0,
  pit_crew_attention: 1,
  visible: 2,
};

/** Priority exceptions first, then elevated before attention before visible, then most overdue, then source id. */
export function compareWaitingOnDetections(a: ClassifiedWaitingOnItem, b: ClassifiedWaitingOnItem): number {
  if (a.priorityException !== b.priorityException) return a.priorityException ? -1 : 1;
  const tierDelta = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  if (tierDelta !== 0) return tierDelta;
  const expectedDelta = a.waitingOnExpectedAt.localeCompare(b.waitingOnExpectedAt);
  if (expectedDelta !== 0) return expectedDelta;
  return a.sourceRecordId.localeCompare(b.sourceRecordId);
}

export interface ClassifyWaitingOnCandidateInput {
  brokerageId: number;
  assignmentId: number;
  sourceType: string;
  sourceRecordId: string;
  propertyId: number;
  status: string;
  assignedToUserId: number | null;
  waitingOnExpectedAt: Date | null;
  waitingOnSince: Date | null;
  now: Date;
  thresholds: WaitingOnTierThresholds;
  exceptionCategory: string | null;
  exceptionDueAt: Date | null;
  exceptionEscalatesAt: Date | null;
  settlementDate: Date | null;
  timeZone: string;
}

/** Null when the row is not an overdue WAITING_ON item. dueAt alone never makes it overdue. */
export function classifyWaitingOnCandidate(input: ClassifyWaitingOnCandidateInput): ClassifiedWaitingOnItem | null {
  if (input.status !== "WAITING_ON" || input.waitingOnExpectedAt == null) return null;
  if (!(input.waitingOnExpectedAt.getTime() < input.now.getTime())) return null;
  const hoursOverdue = hoursPastWaitingOnExpectedAt(input.waitingOnExpectedAt, input.now);
  const tier = classifyWaitingOnTier(hoursOverdue, input.thresholds);
  if (tier == null) return null;
  const priorityReasons = waitingOnPriorityReasons({
    exceptionCategory: input.exceptionCategory,
    exceptionDueAt: input.exceptionDueAt,
    exceptionEscalatesAt: input.exceptionEscalatesAt,
    settlementDate: input.settlementDate,
    now: input.now,
    timeZone: input.timeZone,
  });
  const priorityException = priorityReasons.length > 0;
  return {
    brokerageId: input.brokerageId,
    assignmentId: input.assignmentId,
    sourceType: input.sourceType,
    sourceRecordId: input.sourceRecordId,
    propertyId: input.propertyId,
    status: input.status,
    assignedToUserId: input.assignedToUserId,
    waitingOnExpectedAt: input.waitingOnExpectedAt.toISOString(),
    waitingOnSince: input.waitingOnSince ? input.waitingOnSince.toISOString() : null,
    hoursOverdue,
    tier,
    priorityException,
    priorityReasons,
    fingerprint: waitingOnDetectionFingerprint({
      tier,
      priorityException,
      waitingOnExpectedAt: input.waitingOnExpectedAt,
      status: input.status,
      assignedToUserId: input.assignedToUserId,
      waitingOnSince: input.waitingOnSince,
    }),
  };
}
