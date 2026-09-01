// Agent Engine 2.0 — Communications Hub (Priority 8).
// Pure-function tests for the SMS cost-control period key and the
// documented planning-estimate constant (Section 21) — no DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { currentPeriodKey, SMS_ESTIMATED_COST_CENTS_PER_MESSAGE } from "../costControl.js";

test("currentPeriodKey formats as YYYY-MM in UTC", () => {
  assert.equal(currentPeriodKey(new Date(Date.UTC(2026, 0, 5))), "2026-01");
  assert.equal(currentPeriodKey(new Date(Date.UTC(2026, 11, 31))), "2026-12");
});

test("currentPeriodKey pads single-digit months", () => {
  assert.equal(currentPeriodKey(new Date(Date.UTC(2026, 2, 1))), "2026-03");
});

test("SMS_ESTIMATED_COST_CENTS_PER_MESSAGE is a positive, small planning estimate, never zero or negative", () => {
  assert.ok(SMS_ESTIMATED_COST_CENTS_PER_MESSAGE > 0);
  assert.ok(SMS_ESTIMATED_COST_CENTS_PER_MESSAGE < 100);
});
