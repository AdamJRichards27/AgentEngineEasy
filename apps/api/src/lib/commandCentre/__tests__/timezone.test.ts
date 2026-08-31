import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIME_ZONE,
  resolveTimeZone,
  startOfLocalDay,
  startOfNextLocalDay,
  localDateKey,
  isSameLocalDay,
  isToday,
  isOverdueLocal,
  isWithinHorizon,
} from "../timezone.js";

describe("resolveTimeZone", () => {
  test("falls back to Australia/Brisbane for any actor, since no per-user timezone field exists yet", () => {
    const a = resolveTimeZone({ id: 1, brokerageId: 1 });
    const b = resolveTimeZone({ id: 999, brokerageId: 42 });
    assert.equal(a.timeZone, "Australia/Brisbane");
    assert.equal(a.timeZone, DEFAULT_TIME_ZONE);
    assert.equal(a.source, "fallback");
    assert.equal(b.timeZone, "Australia/Brisbane");
    assert.equal(b.source, "fallback");
  });
});

describe("startOfLocalDay / startOfNextLocalDay / localDateKey (Australia/Brisbane, fixed UTC+10, no DST)", () => {
  const tz = "Australia/Brisbane";

  test("a UTC instant just after Brisbane midnight resolves to that Brisbane calendar day", () => {
    // 2026-08-31T14:30:00Z is 2026-09-01T00:30:00+10:00 in Brisbane.
    const instant = new Date("2026-08-31T14:30:00.000Z");
    assert.equal(localDateKey(instant, tz), "2026-09-01");
  });

  test("startOfLocalDay returns the UTC instant of local midnight", () => {
    const instant = new Date("2026-08-31T14:30:00.000Z");
    const start = startOfLocalDay(instant, tz);
    // Brisbane midnight on 2026-09-01 is 2026-08-31T14:00:00Z (UTC+10, no DST).
    assert.equal(start.toISOString(), "2026-08-31T14:00:00.000Z");
  });

  test("startOfNextLocalDay is exactly 24 hours after startOfLocalDay", () => {
    const instant = new Date("2026-08-31T14:30:00.000Z");
    const start = startOfLocalDay(instant, tz);
    const next = startOfNextLocalDay(instant, tz);
    assert.equal(next.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  });

  test("localDateKey is stable across the same Brisbane calendar day even though the UTC day differs", () => {
    const earlyUtc = new Date("2026-08-31T15:00:00.000Z"); // 2026-09-01T01:00 Brisbane
    const lateUtc = new Date("2026-09-01T13:59:59.000Z"); // 2026-09-01T23:59:59 Brisbane
    assert.equal(localDateKey(earlyUtc, tz), "2026-09-01");
    assert.equal(localDateKey(lateUtc, tz), "2026-09-01");
  });
});

describe("isSameLocalDay / isToday", () => {
  const tz = "Australia/Brisbane";
  const now = new Date("2026-08-31T14:30:00.000Z"); // 2026-09-01T00:30 Brisbane

  test("isSameLocalDay is true for two instants on the same Brisbane day, false across the boundary", () => {
    const sameDayLater = new Date("2026-08-31T20:00:00.000Z"); // 2026-09-01T06:00 Brisbane
    const previousDay = new Date("2026-08-31T13:00:00.000Z"); // 2026-08-31T23:00 Brisbane
    assert.equal(isSameLocalDay(now, sameDayLater, tz), true);
    assert.equal(isSameLocalDay(now, previousDay, tz), false);
  });

  test("isToday is false for a null due date and true only for today's Brisbane calendar day", () => {
    assert.equal(isToday(null, now, tz), false);
    assert.equal(isToday(now, now, tz), true);
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    assert.equal(isToday(yesterday, now, tz), false);
  });
});

describe("isOverdueLocal", () => {
  const tz = "Australia/Brisbane";
  const now = new Date("2026-08-31T14:30:00.000Z"); // 2026-09-01T00:30 Brisbane

  test("null due date is never overdue", () => {
    assert.equal(isOverdueLocal(null, now, tz), false);
  });

  test("a due date before the start of today (Brisbane) is overdue", () => {
    const startOfToday = startOfLocalDay(now, tz);
    const oneMsBeforeToday = new Date(startOfToday.getTime() - 1);
    assert.equal(isOverdueLocal(oneMsBeforeToday, now, tz), true);
  });

  test("a due date at or after the start of today (Brisbane) is not overdue, even if earlier than now", () => {
    const startOfToday = startOfLocalDay(now, tz);
    assert.equal(isOverdueLocal(startOfToday, now, tz), false);
    assert.equal(isOverdueLocal(now, now, tz), false);
  });
});

describe("isWithinHorizon", () => {
  const tz = "Australia/Brisbane";
  const now = new Date("2026-08-31T14:30:00.000Z"); // 2026-09-01T00:30 Brisbane
  const days = 7;

  test("null due date is never within horizon", () => {
    assert.equal(isWithinHorizon(null, now, tz, days), false);
  });

  test("an already-overdue due date is not within horizon, even though it is chronologically earlier", () => {
    const startOfToday = startOfLocalDay(now, tz);
    const overdue = new Date(startOfToday.getTime() - 1);
    assert.equal(isWithinHorizon(overdue, now, tz, days), false);
  });

  test("due dates from today through one millisecond before the end of the horizon are included", () => {
    const startOfToday = startOfLocalDay(now, tz);
    const horizonEnd = new Date(startOfToday.getTime() + days * 24 * 60 * 60 * 1000);
    assert.equal(isWithinHorizon(startOfToday, now, tz, days), true);
    assert.equal(isWithinHorizon(new Date(horizonEnd.getTime() - 1), now, tz, days), true);
  });

  test("the horizon's exclusive upper bound and anything beyond it are excluded", () => {
    const startOfToday = startOfLocalDay(now, tz);
    const horizonEnd = new Date(startOfToday.getTime() + days * 24 * 60 * 60 * 1000);
    assert.equal(isWithinHorizon(horizonEnd, now, tz, days), false);
    assert.equal(isWithinHorizon(new Date(horizonEnd.getTime() + 24 * 60 * 60 * 1000), now, tz, days), false);
  });
});

describe("DST correctness (Build Instructions: the fallback must still work correctly for a zone that observes DST)", () => {
  test("startOfLocalDay's UTC offset for Australia/Sydney differs between AEST (winter) and AEDT (summer)", () => {
    const tz = "Australia/Sydney";
    // Non-DST period (AEST, UTC+10): mid-July.
    const winterMidnight = startOfLocalDay(new Date("2026-07-15T04:00:00.000Z"), tz);
    // DST period (AEDT, UTC+11): mid-January.
    const summerMidnight = startOfLocalDay(new Date("2026-01-15T04:00:00.000Z"), tz);
    assert.equal(winterMidnight.getUTCHours(), 14); // local midnight = 14:00 UTC the prior day at UTC+10
    assert.equal(summerMidnight.getUTCHours(), 13); // local midnight = 13:00 UTC the prior day at UTC+11
  });
});
