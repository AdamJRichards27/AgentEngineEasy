// AE GROW Priority 6 Stage C timezone remediation — pure unit tests for
// coaching/timezone.ts's own primitives: isValidIanaTimeZone,
// startOfLocalMonth, startOfPreviousLocalMonth, and (via re-export) the
// DST-safe localDateKey this remediation relies on throughout. Every test
// here is pure (no database, no wall clock) - the DB-touching half of this
// module (resolveCoachingTimeZone) is instead covered at the integration
// level in __tests__/coachOrchestrator.test.ts (a brokerage-configured
// timezone, an invalid stored timezone falling back gracefully, and
// cross-tenant timezone isolation) and at the HTTP level in
// routes/__tests__/growAskAeCoach.test.ts (a client-supplied timeZone field
// has no effect), exactly mirroring this codebase's own established split
// between fetchX (DB, integration-tested) and computeX (pure, unit-tested).
//
// This file is also where most of the Project Owner's required "timezone
// test matrix" edge cases live: invalid timezone, month boundary, year
// boundary, DST transition, and a UTC calendar date disagreeing with the
// agent's local calendar date. coaching/__tests__/period.test.ts covers the
// PRODUCT-facing period-resolution behaviour (last7days/last30days/
// currentMonth/previousPeriod) across the full Brisbane/Sydney/Adelaide/
// Perth/Auckland zone list the authorisation requires; this file proves the
// lower-level date arithmetic those period computations are built on is
// itself correct, independent of period.ts's own wiring.
//
// AU/NZ 2026 DST reference dates used below (derived from the standard,
// long-stable AU "first Sunday October -> first Sunday April" and NZ "last
// Sunday September -> first Sunday April" rules, cross-checked against
// 2026's actual calendar - 1 January 2026 is a Thursday):
//   - AU (Sydney/Adelaide) DST starts Sunday 4 October 2026, ends Sunday 5
//     April 2026.
//   - NZ (Auckland) DST starts Sunday 27 September 2026, ends Sunday 5
//     April 2026.
// Every fixed offset below (Brisbane +10 always; Sydney +10 std / +11 DST;
// Adelaide +9:30 std / +10:30 DST; Perth +8 always; Auckland +12 std / +13
// DST) is the standard, long-unchanged AU/NZ zone definition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidIanaTimeZone, localDateKey, startOfLocalMonth, startOfPreviousLocalMonth } from "../timezone.js";

// ---------------------------------------------------------------------------
// isValidIanaTimeZone — REQUIRED TEST: "invalid timezone"
// ---------------------------------------------------------------------------

test("isValidIanaTimeZone: true for every AU/NZ zone this remediation's test matrix requires, plus UTC", () => {
  for (const zone of ["Australia/Brisbane", "Australia/Sydney", "Australia/Adelaide", "Australia/Perth", "Pacific/Auckland", "UTC"]) {
    assert.equal(isValidIanaTimeZone(zone), true, `${zone} must be recognised as a valid IANA timezone`);
  }
});

test("isValidIanaTimeZone: false for clearly-invalid strings, never throwing", () => {
  for (const bad of ["Not/ARealZone", "Mars/OlympusMons", "", "   ", "12345", "Australia/Brisbane; DROP TABLE users;"]) {
    assert.equal(isValidIanaTimeZone(bad), false, `"${bad}" must not be treated as a valid timezone`);
  }
});

// ---------------------------------------------------------------------------
// localDateKey — REQUIRED TESTS: "UTC date differing from agent's local
// date" and "DST transition"
// ---------------------------------------------------------------------------

test("localDateKey: the local calendar date can be a full day ahead of the UTC calendar date (Auckland, standard time)", () => {
  // 20:00 UTC on 14 July 2026 is already 08:00 on 15 July in Auckland
  // (NZST, UTC+12, mid-winter - well outside the NZ DST window) - a plain
  // UTC date slice would have said "14", one day behind the agent's own
  // local date.
  const instant = new Date("2026-07-14T20:00:00.000Z");
  assert.equal(localDateKey(instant, "Pacific/Auckland"), "2026-07-15");
  assert.notEqual(instant.toISOString().slice(0, 10), "2026-07-15", "the UTC calendar date for this same instant is still the 14th, one day behind");
});

test("localDateKey: the local calendar date is stable across the exact Australian DST spring-forward instant (Sydney, 2am -> 3am on Sunday 4 October 2026)", () => {
  // The transition instant itself is 2026-10-03T16:00:00.000Z (02:00 AEST
  // == 03:00 AEDT, the same UTC instant under both offsets). Two instants
  // two minutes apart straddling it must both resolve to the SAME local
  // calendar date (4 October) despite the one-hour clock jump between them
  // - exactly the property a naive fixed-offset implementation could get
  // wrong right at the boundary.
  const justBefore = new Date("2026-10-03T15:59:00.000Z"); // 01:59 AEST, 4 Oct
  const justAfter = new Date("2026-10-03T16:01:00.000Z"); // 03:01 AEDT, 4 Oct
  assert.equal(localDateKey(justBefore, "Australia/Sydney"), "2026-10-04");
  assert.equal(localDateKey(justAfter, "Australia/Sydney"), "2026-10-04");
});

// ---------------------------------------------------------------------------
// startOfLocalMonth / startOfPreviousLocalMonth — REQUIRED TESTS: "month
// boundary", "year boundary", plus direct per-zone coverage (Brisbane,
// Sydney standard/DST, Adelaide standard/DST, Perth, Auckland standard/DST)
// ---------------------------------------------------------------------------

test("startOfLocalMonth: Australia/Brisbane never observes DST - the same +10:00 offset applies in both AU summer (January) and AU winter (July)", () => {
  const summer = startOfLocalMonth(new Date("2026-01-15T00:00:00.000Z"), "Australia/Brisbane");
  const winter = startOfLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Australia/Brisbane");
  assert.equal(summer.toISOString(), "2025-12-31T14:00:00.000Z");
  assert.equal(winter.toISOString(), "2026-06-30T14:00:00.000Z");
});

test("startOfLocalMonth: Australia/Sydney, standard time (AEST, +10:00) in July", () => {
  const start = startOfLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Australia/Sydney");
  assert.equal(start.toISOString(), "2026-06-30T14:00:00.000Z");
});

test("startOfLocalMonth: Australia/Sydney, daylight time (AEDT, +11:00) in January", () => {
  const start = startOfLocalMonth(new Date("2026-01-15T00:00:00.000Z"), "Australia/Sydney");
  assert.equal(start.toISOString(), "2025-12-31T13:00:00.000Z");
});

test("startOfLocalMonth: a month that STARTS before the AEDT transition still resolves its 1st correctly at the pre-transition AEST offset (Sydney, October 2026)", () => {
  // 1 October 2026 is itself still AEST (+10:00) - DST does not start until
  // Sunday 4 October. A naive implementation that applied `now`'s CURRENT
  // offset (AEDT, +11:00, since `now` here is the 15th, after the
  // transition) to the 1st of the month would wrongly compute
  // 2026-09-30T13:00:00.000Z instead.
  const start = startOfLocalMonth(new Date("2026-10-15T00:00:00.000Z"), "Australia/Sydney");
  assert.equal(start.toISOString(), "2026-09-30T14:00:00.000Z");
  assert.notEqual(start.toISOString(), "2026-09-30T13:00:00.000Z", "must not use the wrong (post-transition) offset for a pre-transition date");
});

test("startOfLocalMonth: Australia/Adelaide, standard time (ACST, +09:30) in July", () => {
  const start = startOfLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Australia/Adelaide");
  assert.equal(start.toISOString(), "2026-06-30T14:30:00.000Z");
});

test("startOfLocalMonth: Australia/Adelaide, daylight time (ACDT, +10:30) in January - the half-hour offset applies in both branches", () => {
  const start = startOfLocalMonth(new Date("2026-01-15T00:00:00.000Z"), "Australia/Adelaide");
  assert.equal(start.toISOString(), "2025-12-31T13:30:00.000Z");
});

test("startOfLocalMonth: Australia/Perth never observes DST (AWST, +08:00) year-round", () => {
  const start = startOfLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Australia/Perth");
  assert.equal(start.toISOString(), "2026-06-30T16:00:00.000Z");
});

test("startOfLocalMonth: Pacific/Auckland, standard time (NZST, +12:00) in July", () => {
  const start = startOfLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Pacific/Auckland");
  assert.equal(start.toISOString(), "2026-06-30T12:00:00.000Z");
});

test("startOfLocalMonth: Pacific/Auckland, daylight time (NZDT, +13:00) in January", () => {
  const start = startOfLocalMonth(new Date("2026-01-15T00:00:00.000Z"), "Pacific/Auckland");
  assert.equal(start.toISOString(), "2025-12-31T11:00:00.000Z");
});

test('startOfLocalMonth: REQUIRED "month boundary" case - a UTC instant that is still 31 January but is already 1 February in the agent\'s local zone (Auckland, NZDT)', () => {
  // 2026-01-31T12:00:00.000Z is 01:00 on 1 February in Auckland (NZDT,
  // +13:00, in effect since 27 September 2025) - the local CALENDAR MONTH
  // is already February even though the UTC calendar date is still 31
  // January. A UTC-based implementation would incorrectly resolve this
  // month's start as 1 January instead of 1 February.
  const now = new Date("2026-01-31T12:00:00.000Z");
  const start = startOfLocalMonth(now, "Pacific/Auckland");
  assert.equal(start.toISOString(), "2026-01-31T11:00:00.000Z", "the local month is February; its 1st (local midnight) is 2026-01-31T11:00:00.000Z UTC");
  assert.equal(localDateKey(now, "Pacific/Auckland"), "2026-02-01", "confirms `now` itself is already 1 February local time");
});

test('startOfPreviousLocalMonth: REQUIRED "month boundary" case, no year change (Auckland, standard time)', () => {
  const start = startOfPreviousLocalMonth(new Date("2026-07-15T00:00:00.000Z"), "Pacific/Auckland");
  assert.equal(start.toISOString(), "2026-05-31T12:00:00.000Z", "the previous local month (June) starts at local midnight 1 June, i.e. 2026-05-31T12:00:00.000Z UTC");
});

test('startOfPreviousLocalMonth: REQUIRED "year boundary" case - crossing December 2025 into January 2026 (Perth, no DST, isolating the year rollover from any DST effect)', () => {
  const start = startOfPreviousLocalMonth(new Date("2026-01-10T00:00:00.000Z"), "Australia/Perth");
  assert.equal(start.toISOString(), "2025-11-30T16:00:00.000Z", "the previous local month relative to January 2026 is December 2025, starting at local midnight 1 December 2025 (2025-11-30T16:00:00.000Z UTC)");
});
