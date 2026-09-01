// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Quiet hours / scheduling (Section 22): configurable, timezone-aware, no
// hardcoded AU timezone. When a brokerage has not configured its own
// timeZone, this falls back to the same DEFAULT_TIME_ZONE the Command
// Centre already uses (lib/commandCentre/timezone.ts) rather than
// inventing a second, differently-defaulted fallback — see that module's
// own comment on why Australia/Brisbane is a documented fallback, not an
// unconditional assumption. Quiet hours themselves are entirely opt-in:
// a brokerage with no quietHoursStart/End configured is never restricted.

import { DEFAULT_TIME_ZONE } from "../commandCentre/timezone.js";
import type { CommunicationSettings } from "@aee/db";

interface HourMinute {
  hour: number;
  minute: number;
}

function parseHhMm(value: string): HourMinute | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function localHourMinute(instant: Date, timeZone: string): HourMinute {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(instant)) map[part.type] = part.value;
  return { hour: Number(map.hour), minute: Number(map.minute) };
}

function toMinutes(hm: HourMinute): number {
  return hm.hour * 60 + hm.minute;
}

export function resolveCommunicationTimeZone(settings: Pick<CommunicationSettings, "timeZone">): string {
  return settings.timeZone && settings.timeZone.trim().length > 0 ? settings.timeZone : DEFAULT_TIME_ZONE;
}

/**
 * True when `instant` falls inside the brokerage's configured quiet-hours
 * window (which may wrap midnight, e.g. 20:00 -> 08:00). Undefined/blank
 * start or end means quiet hours are not configured — never restricted.
 */
export function isWithinQuietHours(instant: Date, settings: Pick<CommunicationSettings, "timeZone" | "quietHoursStart" | "quietHoursEnd">): boolean {
  if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;
  const start = parseHhMm(settings.quietHoursStart);
  const end = parseHhMm(settings.quietHoursEnd);
  if (!start || !end) return false;

  const timeZone = resolveCommunicationTimeZone(settings);
  const nowMinutes = toMinutes(localHourMinute(instant, timeZone));
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  if (startMinutes === endMinutes) return false; // a zero-width window is treated as "not configured"
  if (startMinutes < endMinutes) {
    // Same-day window, e.g. 08:00 -> 20:00 is NOT quiet — quiet is outside it.
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  // Wraps midnight, e.g. 20:00 -> 08:00.
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

/**
 * The next instant at/after `from` that falls OUTSIDE quiet hours — used to
 * auto-schedule a SMS/EMAIL send that would otherwise land during quiet
 * hours (Section 22). Scans forward in minute steps up to 24h, which is
 * always sufficient since a quiet window is at most 24h wide.
 */
export function nextAllowedSendTime(from: Date, settings: Pick<CommunicationSettings, "timeZone" | "quietHoursStart" | "quietHoursEnd">): Date {
  if (!isWithinQuietHours(from, settings)) return from;
  const end = parseHhMm(settings.quietHoursEnd!);
  if (!end) return from;
  const timeZone = resolveCommunicationTimeZone(settings);

  // Step forward minute-by-minute (bounded to 24h) rather than doing
  // timezone-offset arithmetic by hand — DST-transition-safe by
  // construction, at the cost of a bounded loop instead of a closed-form
  // calculation, which is fine for a value computed once per queued send.
  let candidate = new Date(from.getTime());
  for (let i = 0; i < 24 * 60; i++) {
    candidate = new Date(candidate.getTime() + 60_000);
    if (!isWithinQuietHours(candidate, settings)) return candidate;
  }
  return candidate;
}
