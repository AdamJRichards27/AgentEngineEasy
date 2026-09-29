// R-F22 — Pit Crew assignment and workspace modules do not import or name
// the source writers. Flag default stays off; this file does not set it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG, isPitCrewLaunchItemSourceEnabled } from "../../lib/pitCrew/launchItemSource.js";
import { assertPitCrewModulesDoNotReferenceSourceWriters } from "./support/pitCrewForbiddenSourceWriters.js";

test("Pit Crew assignment, workspace, and responsibility modules do not reference source writers", () => {
  assertPitCrewModulesDoNotReferenceSourceWriters();
});

test("responsibility.ts does not name campaign_items", () => {
  const source = readFileSync(new URL("../../lib/pitCrew/responsibility.ts", import.meta.url), "utf8");
  assert.equal(source.includes("campaign_items"), false);
  assert.equal(source.includes("campaignItems"), false);
});

test("PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is on only for the literal string true", () => {
  const flag = PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG;
  assert.equal(isPitCrewLaunchItemSourceEnabled({}), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "" }), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "false" }), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "TRUE" }), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "1" }), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "yes" }), false);
  assert.equal(isPitCrewLaunchItemSourceEnabled({ [flag]: "true" }), true);
});
