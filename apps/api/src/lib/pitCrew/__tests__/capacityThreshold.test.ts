// Pit Crew D4 (Owner t165u): 12 is a configurable WARNING threshold.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAtOrAboveCapacityWarning, resolveCapacityWarningThreshold, PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD } from "../capacity.js";

test("default threshold is 12 when not configured", () => {
  assert.equal(PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD, 12);
  assert.deepEqual(resolveCapacityWarningThreshold({}), { threshold: 12, source: "default" });
  assert.deepEqual(resolveCapacityWarningThreshold({ PIT_CREW_CAPACITY_WARNING_THRESHOLD: "  " }), { threshold: 12, source: "default" });
});

test("configured threshold is honoured; invalid values fall back to 12", () => {
  assert.deepEqual(resolveCapacityWarningThreshold({ PIT_CREW_CAPACITY_WARNING_THRESHOLD: "8" }), { threshold: 8, source: "config" });
  for (const bad of ["0", "-3", "1.5", "abc", "201", "12abc"]) {
    assert.deepEqual(resolveCapacityWarningThreshold({ PIT_CREW_CAPACITY_WARNING_THRESHOLD: bad }), { threshold: 12, source: "default" }, bad);
  }
});

test("warning at or above the threshold (explicit default for open item D4.6)", () => {
  assert.equal(isAtOrAboveCapacityWarning(11, 12), false);
  assert.equal(isAtOrAboveCapacityWarning(12, 12), true);
  assert.equal(isAtOrAboveCapacityWarning(13, 12), true);
});
