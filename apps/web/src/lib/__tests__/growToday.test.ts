import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWhen, growTodayBucketPresentation, priorityLabel, priorityPillClass } from "../growToday";

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

test("growTodayBucketPresentation emphasizes non-empty urgent buckets and keeps zero buckets quiet", () => {
  assert.deepEqual(growTodayBucketPresentation("DoNow", 2), {
    label: "Do Now",
    count: 2,
    tone: "urgent",
    isEmpty: false,
    description: "Highest-priority actions that need attention now.",
    emptyText: "No actions need immediate attention.",
  });
  assert.deepEqual(growTodayBucketPresentation("DoToday", 0), {
    label: "Do Today",
    count: 0,
    tone: "quiet",
    isEmpty: true,
    description: "Actions to complete today.",
    emptyText: "No actions are due today.",
  });
  assert.equal(growTodayBucketPresentation("KeepWarm", 1).tone, "standard");
});

test("formatWhen returns null for a null input and a readable date string otherwise", () => {
  assert.equal(formatWhen(null), null);
  const formatted = formatWhen("2026-09-08T00:00:00.000Z");
  assert.ok(formatted !== null && formatted.length > 0);
  assert.ok(formatted !== null && formatted.includes("2026"));
});
