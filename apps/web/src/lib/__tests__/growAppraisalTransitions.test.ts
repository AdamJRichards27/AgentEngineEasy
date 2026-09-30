// G-UAT-6 — the web status map is a hand-mirror of ALLOWED_STATUS_TRANSITIONS
// in apps/api/src/lib/growAppraisals.ts. This fails if they drift. The buttons
// are the shortest path intersected with that map, not every allowed transition.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  APPRAISAL_STATUS_TRANSITIONS,
  appraisalNextSteps,
  appraisalOutcomeOptions,
} from "../growAppraisals.ts";

function readApiTransitions(): Record<string, string[]> {
  const source = readFileSync(new URL("../../../../api/src/lib/growAppraisals.ts", import.meta.url), "utf8");
  const match = source.match(/const ALLOWED_STATUS_TRANSITIONS: Record<string, string\[\]> = \{([\s\S]*?)\n\};/);
  assert.ok(match, "ALLOWED_STATUS_TRANSITIONS block missing from the API");
  const map: Record<string, string[]> = {};
  for (const line of match[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = trimmed.match(/^([A-Z_]+):\s*\[(.*)\],?$/);
    assert.ok(row, `unparsed transition line: ${trimmed}`);
    map[row[1]] = [...row[2].matchAll(/"([A-Z_]+)"/g)].map((item) => item[1]);
  }
  assert.ok(Object.keys(map).length >= 12, "the API transition map was only partly parsed");
  return map;
}

test("the web appraisal transition mirror matches the API map", () => {
  assert.deepEqual(APPRAISAL_STATUS_TRANSITIONS, readApiTransitions());
});

test("next steps are only the shortest path the API map still allows", () => {
  assert.deepEqual(appraisalNextSteps("DRAFT"), ["APPOINTMENT_SCHEDULED"]);
  assert.deepEqual(appraisalNextSteps("APPOINTMENT_SCHEDULED"), ["PRESENTED", "FOLLOW_UP"]);
  assert.deepEqual(appraisalNextSteps("PREPARING"), []);
  assert.deepEqual(appraisalNextSteps("READY"), []);
  assert.deepEqual(appraisalNextSteps("SENT"), []);
  assert.deepEqual(appraisalNextSteps("VIEWED"), []);
  assert.deepEqual(appraisalNextSteps("PRESENTED"), []);
  assert.deepEqual(appraisalNextSteps("FOLLOW_UP"), []);
  assert.deepEqual(appraisalNextSteps("WON"), []);
  assert.deepEqual(appraisalNextSteps("LOST"), []);
  assert.deepEqual(appraisalNextSteps("DEFERRED"), []);
});

test("record outcome is offered only from PRESENTED and FOLLOW_UP", () => {
  assert.deepEqual(appraisalOutcomeOptions("PRESENTED"), ["WON", "LOST", "DEFERRED"]);
  assert.deepEqual(appraisalOutcomeOptions("FOLLOW_UP"), ["WON", "LOST", "DEFERRED"]);
  for (const status of ["DRAFT", "PREPARING", "READY", "SENT", "VIEWED", "APPOINTMENT_SCHEDULED", "WON", "LOST", "DEFERRED", "ARCHIVED"]) {
    assert.deepEqual(appraisalOutcomeOptions(status), [], status);
  }
});
