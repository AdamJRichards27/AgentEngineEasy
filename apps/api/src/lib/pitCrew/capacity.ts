// Pit Crew D4 capacity WARNINGS (Owner t165u): "Use 12 active assignments as
// a proposed configurable pilot warning threshold, not an automatic suspension
// rule." Read-only and warning-only: nothing here blocks, suspends or changes
// a claim, assign or handoff. No migration: the threshold is deployment
// configuration (PIT_CREW_CAPACITY_WARNING_THRESHOLD), default 12. A
// per-brokerage settings table is migration M7 and separately gated.
//
// Open details (PITCREW-D1-D4-MATRIX-t165u.md) are explicit named defaults:
// - D4.5 active statuses: CLAIMED / IN_PROGRESS / WAITING_ON, the same set the
//   existing Section 15 team view already counts (getPitCrewTeam);
// - D4.6 at vs above: warn at or above the threshold (>=);
// - D4.4 scope: per member only.
import { logger } from "@aee/events";
import { getPitCrewTeam } from "./queries.js";

export const PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD = 12;
export const PIT_CREW_CAPACITY_THRESHOLD_ENV = "PIT_CREW_CAPACITY_WARNING_THRESHOLD";
export const PIT_CREW_CAPACITY_ACTIVE_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;
const MAX_THRESHOLD = 200;

export function resolveCapacityWarningThreshold(env: NodeJS.ProcessEnv = process.env): { threshold: number; source: "default" | "config" } {
  const raw = env[PIT_CREW_CAPACITY_THRESHOLD_ENV];
  if (raw === undefined || raw.trim() === "") return { threshold: PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD, source: "default" };
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_THRESHOLD) {
    logger.warn("pit_crew_capacity_threshold_invalid", { configured: raw.slice(0, 20), fallback: PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD });
    return { threshold: PIT_CREW_CAPACITY_DEFAULT_WARNING_THRESHOLD, source: "default" };
  }
  return { threshold: value, source: "config" };
}

export function isAtOrAboveCapacityWarning(activeCount: number, threshold: number): boolean {
  return activeCount >= threshold;
}

export interface PitCrewCapacityView {
  mode: "WARNING_ONLY";
  blocking: false;
  threshold: number;
  thresholdSource: "default" | "config";
  activeStatuses: readonly string[];
  members: Array<{ userId: number; firstName: string | null; lastName: string | null; activeAssignments: number; warning: boolean }>;
  membersWithWarning: number;
}

export async function getPitCrewCapacity(brokerageId: number, env: NodeJS.ProcessEnv = process.env): Promise<PitCrewCapacityView> {
  const { threshold, source } = resolveCapacityWarningThreshold(env);
  const team = await getPitCrewTeam(brokerageId);
  const members = team.map((m) => ({
    userId: m.userId,
    firstName: m.firstName,
    lastName: m.lastName,
    activeAssignments: m.activeItemCount,
    warning: isAtOrAboveCapacityWarning(m.activeItemCount, threshold),
  }));
  return {
    mode: "WARNING_ONLY",
    blocking: false,
    threshold,
    thresholdSource: source,
    activeStatuses: PIT_CREW_CAPACITY_ACTIVE_STATUSES,
    members,
    membersWithWarning: members.filter((m) => m.warning).length,
  };
}
