import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * R-F22 import lock. Pit Crew assignment and workspace reads must not name
 * the source writers. A static scan, same idea as the F4 forbidden-call
 * list: the modules under test are named, and a hit fails the suite.
 */
export const PIT_CREW_FORBIDDEN_SOURCE_WRITERS = [
  "updateCampaignItemStatus",
  "completeAutomationTask",
  "resolveCondition",
  "maybeRecordUnconditional",
  "acceptOffer",
  "completeSettlement",
  "confirmLaunchLive",
  "decideVendorApproval",
] as const;

const MODULES = ["../../../lib/pitCrew/assignment.ts", "../../../lib/pitCrew/queries.ts"] as const;

export function assertPitCrewModulesDoNotReferenceSourceWriters(): void {
  for (const relative of MODULES) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    for (const name of PIT_CREW_FORBIDDEN_SOURCE_WRITERS) {
      assert.equal(source.includes(name), false, `${relative} references ${name}`);
    }
  }
}
