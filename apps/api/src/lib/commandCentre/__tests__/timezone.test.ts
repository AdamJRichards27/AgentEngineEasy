import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIME_ZONE,
  resolveStoredTimeZone,
  startOfLocalDay,
  startOfNextLocalDay,
  localDateKey,
  isSameLocalDay,
  isToday,
  isOverdueLocal,
  isWithinHorizon,
} from "../timezone.js";

describe("resolveStoredTimeZone", () => {
  test("null falls back to Australia/Brisbane", () => {
    const resolution = resolveStoredTimeZone(null);
    assert.equal(resolution.timeZone, "Australia/Brisbane");
    assert.equal(resolution.timeZone, DEFAULT_TIME_ZONE);
    assert.equal(resolution.source, "fallback");
  });

  test("a valid IANA zone is used, with source brokerage", () => {
    const resolution = resolveStoredTimeZone("Pacific/Auckland");
    assert.equal(resolution.timeZone, "Pacific/Auckland");
    assert.equal(resolution.source, "brokerage");
  });

  test("an invalid or blank stored value falls back", () => {
    for (const stored of ["Not/ARealZone", "", "   "]) {
      const resolution = resolveStoredTimeZone(stored);
      assert.equal(resolution.timeZone, DEFAULT_TIME_ZONE);
      assert.equal(resolution.source, "fallback");
    }
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

  test("Australia/Sydney spring-forward (2026-10-04 02:00 -> 03:00) keeps the local day and does not treat the next morning as today", () => {
    const tz = "Australia/Sydney";
    // 03:30 AEDT on 4 October, just after the clocks jump.
    const now = new Date("2026-10-03T16:30:00.000Z");
    assert.equal(localDateKey(now, tz), "2026-10-04");
    // Local midnight that morning was still AEST (UTC+10).
    assert.equal(startOfLocalDay(now, tz).toISOString(), "2026-10-03T14:00:00.000Z");
    const justAfterLocalMidnight = new Date("2026-10-03T14:01:00.000Z");
    const justBeforeLocalMidnight = new Date("2026-10-03T13:59:00.000Z");
    assert.equal(isToday(justAfterLocalMidnight, now, tz), true);
    assert.equal(isOverdueLocal(justAfterLocalMidnight, now, tz), false);
    assert.equal(isOverdueLocal(justBeforeLocalMidnight, now, tz), true);
    // 00:30 on 5 October (AEDT, UTC+11). A fixed +24h from local midnight
    // would still call this "today"; the local calendar day does not.
    const firstHalfHourOfNextLocalDay = new Date("2026-10-04T13:30:00.000Z");
    assert.equal(localDateKey(firstHalfHourOfNextLocalDay, tz), "2026-10-05");
    assert.equal(isToday(firstHalfHourOfNextLocalDay, now, tz), false);
    assert.equal(isOverdueLocal(firstHalfHourOfNextLocalDay, now, tz), false);
  });

  test("Australia/Sydney fall-back (2026-04-05) still counts the 25th hour as today", () => {
    const tz = "Australia/Sydney";
    // 02:30 AEST on 5 April, after clocks have gone back from 03:00 AEDT.
    const now = new Date("2026-04-04T16:30:00.000Z");
    assert.equal(localDateKey(now, tz), "2026-04-05");
    // Midnight that morning was still AEDT (UTC+11).
    assert.equal(startOfLocalDay(now, tz).toISOString(), "2026-04-04T13:00:00.000Z");
    // 23:30 AEST the same calendar day. A fixed +24h from midnight lands an
    // hour earlier (23:00) and would drop this instant.
    const lateOnTheLongDay = new Date("2026-04-05T13:30:00.000Z");
    assert.equal(localDateKey(lateOnTheLongDay, tz), "2026-04-05");
    assert.equal(isToday(lateOnTheLongDay, now, tz), true);
    assert.equal(isOverdueLocal(lateOnTheLongDay, now, tz), false);
    const justBeforeLocalMidnight = new Date("2026-04-04T12:59:00.000Z");
    assert.equal(isOverdueLocal(justBeforeLocalMidnight, now, tz), true);
  });
});
