import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * R-F22 import lock, extended to responsibility.ts. Pit Crew assignment,
 * workspace reads, and responsibility actions must not name the source
 * writers. A static scan, same idea as the F4 forbidden-call list: the
 * modules under test are named, and a hit fails the suite.
 */
export const PIT_CREW_FORBIDDEN_SOURCE_WRITERS = [
  "updateCampaignItemStatus",
  "assignResponsibility",
  "recordVendorAndCost",
  "attachCampaignItemEvidence",
  "completeAutomationTask",
  "resolveCondition",
  "maybeRecordUnconditional",
  "acceptOffer",
  "completeSettlement",
  "confirmLaunchLive",
  "decideVendorApproval",
] as const;

const MODULES = [
  "../../../lib/pitCrew/assignment.ts",
  "../../../lib/pitCrew/queries.ts",
  "../../../lib/pitCrew/responsibility.ts",
] as const;

export function assertPitCrewModulesDoNotReferenceSourceWriters(): void {
  for (const relative of MODULES) {
    const source = readFileSync(new URL(relative, import.meta.url), "utf8");
    for (const name of PIT_CREW_FORBIDDEN_SOURCE_WRITERS) {
      assert.equal(source.includes(name), false, `${relative} references ${name}`);
    }
  }
}
