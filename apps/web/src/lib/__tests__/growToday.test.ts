import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityLabel, priorityPillClass, formatWhen } from "../growToday";

// AE GROW Priority 1 — Daily Command Centre: pure-logic tests for the frontend display helpers.
// No React, no network — matches the convention lib/__tests__/productNav.test.ts already
// established for pure Grow-related logic on the web app.

test("priorityLabel maps every priority to a human-readable label", () => {
  assert.equal(priorityLabel("DoNow"), "Do Now");
  assert.equal(priorityLabel("DoToday"), "Do Today");
  assert.equal(priorityLabel("KeepWarm"), "Keep Warm");
});

test("priorityPillClass never conveys urgency by colour alone -- DoNow/DoToday get a distinct tone, KeepWarm stays neutral", () => {
  assert.equal(priorityPillClass("DoNow"), "pill pill-danger");
  assert.equal(priorityPillClass("DoToday"), "pill pill-warning");
  assert.equal(priorityPillClass("KeepWarm"), "pill");
});

test("formatWhen returns null for a null input and a readable date string otherwise", () => {
  assert.equal(formatWhen(null), null);
  const formatted = formatWhen("2026-09-08T00:00:00.000Z");
  assert.ok(formatted !== null && formatted.length > 0);
  assert.ok(formatted !== null && formatted.includes("2026"));
});
