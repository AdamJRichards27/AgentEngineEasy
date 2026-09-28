// R-F22 — second Pit Crew source, flag only.
//
// Enabled only for the literal string "true", matching
// isPitCrewResponsibilityActionsEnabled. Missing, empty, "TRUE", "1",
// and "yes" stay off. Default off. Callers must not query campaign_items
// while this returns false.

export const PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG = "PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED";

/**
 * Enabled only for the literal string "true". Missing, empty, "TRUE", "1",
 * and "yes" stay off. Default off.
 */
export function isPitCrewLaunchItemSourceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] === "true";
}
