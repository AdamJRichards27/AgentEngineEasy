// Agent Engine 2.0 — Communications Hub (Priority 8).
// Pure-function tests for quiet-hours evaluation and scheduling (Section
// 22) — no DB, no server. Uses timeZone "UTC" throughout so instants can be
// constructed directly with Date.UTC() without any offset arithmetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isWithinQuietHours, nextAllowedSendTime, resolveCommunicationTimeZone } from "../quietHours.js";

function utc(hour: number, minute = 0, day = 15): Date {
  return new Date(Date.UTC(2026, 0, day, hour, minute, 0));
}

test("resolveCommunicationTimeZone falls back to the documented default when unset", () => {
  assert.equal(resolveCommunicationTimeZone({ timeZone: null }), "Australia/Brisbane");
  assert.equal(resolveCommunicationTimeZone({ timeZone: "" }), "Australia/Brisbane");
  assert.equal(resolveCommunicationTimeZone({ timeZone: "Australia/Perth" }), "Australia/Perth");
});

test("no quietHoursStart/End configured means never restricted", () => {
  const settings = { timeZone: "UTC", quietHoursStart: null, quietHoursEnd: null };
  assert.equal(isWithinQuietHours(utc(2), settings), false);
  assert.equal(isWithinQuietHours(utc(23), settings), false);
});

test("a zero-width window (start === end) is treated as not configured", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "09:00", quietHoursEnd: "09:00" };
  assert.equal(isWithinQuietHours(utc(9), settings), false);
  assert.equal(isWithinQuietHours(utc(15), settings), false);
});

test("a same-day window (08:00 -> 20:00) is quiet only inside that range", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "08:00", quietHoursEnd: "20:00" };
  assert.equal(isWithinQuietHours(utc(7, 59), settings), false);
  assert.equal(isWithinQuietHours(utc(8, 0), settings), true);
  assert.equal(isWithinQuietHours(utc(12, 0), settings), true);
  assert.equal(isWithinQuietHours(utc(19, 59), settings), true);
  assert.equal(isWithinQuietHours(utc(20, 0), settings), false);
});

test("a midnight-wrapping window (20:00 -> 08:00) is quiet across the boundary", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "20:00", quietHoursEnd: "08:00" };
  assert.equal(isWithinQuietHours(utc(19, 59), settings), false);
  assert.equal(isWithinQuietHours(utc(20, 0), settings), true);
  assert.equal(isWithinQuietHours(utc(23, 30), settings), true);
  assert.equal(isWithinQuietHours(utc(0, 0), settings), true);
  assert.equal(isWithinQuietHours(utc(7, 59), settings), true);
  assert.equal(isWithinQuietHours(utc(8, 0), settings), false);
});

test("nextAllowedSendTime returns the same instant unchanged when it's already outside quiet hours", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "20:00", quietHoursEnd: "08:00" };
  const from = utc(12, 0);
  const result = nextAllowedSendTime(from, settings);
  assert.equal(result.getTime(), from.getTime());
});

test("nextAllowedSendTime pushes a quiet-hours instant forward to the first minute the window ends", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "20:00", quietHoursEnd: "08:00" };
  const from = utc(22, 0, 15); // well inside the wrapping window
  const result = nextAllowedSendTime(from, settings);
  assert.equal(isWithinQuietHours(result, settings), false);
  assert.equal(result.getUTCHours(), 8);
  assert.equal(result.getUTCMinutes(), 0);
  assert.equal(result.getUTCDate(), 16); // rolled into the next day
});

test("nextAllowedSendTime on a same-day window pushes forward to the window's own end, same day", () => {
  const settings = { timeZone: "UTC", quietHoursStart: "08:00", quietHoursEnd: "20:00" };
  const from = utc(10, 0, 15);
  const result = nextAllowedSendTime(from, settings);
  assert.equal(isWithinQuietHours(result, settings), false);
  assert.equal(result.getUTCHours(), 20);
  assert.equal(result.getUTCMinutes(), 0);
  assert.equal(result.getUTCDate(), 15);
});
