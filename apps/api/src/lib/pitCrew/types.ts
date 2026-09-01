
// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), shared types.
//
// The Agent Daily Command Centre (Priority 6, PR #14) is not yet merged
// into staging -- per this build's Section 22 that is non-blocking, and the
// instruction is to "prepare a tested read interface without building or
// duplicating that entire feature." So rather than depending on its
// unmerged ActionItem model, this module sources work items directly from
// the Exception & Risk Engine (Priority 4, merged, and explicitly
// documented as "authoritative" -- see exceptions/queries.ts's own
// listBrokerageExceptions), which already covers every category Pit Crew
// needs (AML/CTF, appraisal agreement, contract conditions, launch/
// campaign, listing, offers, settlement closure, workflow operational) and
// already redacts financial exceptions from non-entitled viewers, which
// Pit Crew always is. PcWorkItem's field names deliberately mirror the
// Command Centre's ActionItem shape (sourceType/sourceRecordId/deepLink/
// severity/etc.) so that once PR #14 merges, queries.ts here can be
// repointed at getCommandCentre() with minimal changes instead of a
// rewrite -- see the note at the top of queries.ts.

export const PIT_CREW_WORK_SOURCE_TYPES = ["EXCEPTION"] as const;
export type PitCrewWorkSourceType = (typeof PIT_CREW_WORK_SOURCE_TYPES)[number];

// Section 9: the Pit Crew work-item status vocabulary. UNCLAIMED is the
// implicit state of any source item with no pit_crew_assignments row.
export const PIT_CREW_ITEM_STATUSES = [
  "UNCLAIMED",
  "CLAIMED",
  "IN_PROGRESS",
  "WAITING_ON",
  "DONE",
] as const;
export type PitCrewItemStatus = (typeof PIT_CREW_ITEM_STATUSES)[number];

// Validated transitions (Section 9: "PC work-item status enum with
// validated transitions"). Keys are the FROM status; values are the
// allowed TO statuses. Two entry points assign an item into CLAIMED without
// it ever having been UNCLAIMED-with-a-row: claim() and assign() both call
// this from the synthetic "UNCLAIMED" state.
export const PIT_CREW_STATUS_TRANSITIONS: Record<PitCrewItemStatus, PitCrewItemStatus[]> = {
  UNCLAIMED: ["CLAIMED"],
  CLAIMED: ["IN_PROGRESS", "WAITING_ON", "DONE", "UNCLAIMED"],
  IN_PROGRESS: ["WAITING_ON", "DONE", "UNCLAIMED"],
  WAITING_ON: ["IN_PROGRESS", "DONE", "UNCLAIMED"],
  DONE: [],
};

export function isValidPitCrewTransition(from: PitCrewItemStatus, to: PitCrewItemStatus): boolean {
  return PIT_CREW_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// One risk exception, re-presented as a Pit Crew work item: the exception's
// own fields (authoritative, read-only from here) plus the Pit Crew overlay
// (assignment/status/waiting-on/handoff -- writable via assignment.ts).
export interface PcWorkItem {
  sourceType: PitCrewWorkSourceType;
  sourceRecordId: string;
  propertyId: number;
  propertyAddress: string | null;
  brokerageId: number;
  title: string;
  description: string;
  category: string;
  severity: "INFORMATION" | "ATTENTION" | "AT_RISK" | "CRITICAL";
  exceptionStatus: string;
  ownerType: string;
  ownerUserId: number | null;
  ownerName: string | null;
  dueAt: string | null;
  overdue: boolean;
  recommendedAction: string;
  deepLink: string;
  detectedAt: string;

  pcStatus: PitCrewItemStatus;
  assignedToUserId: number | null;
  assignedToName: string | null;
  claimedAt: string | null;
  waitingOnParty: string | null;
  waitingOnNote: string | null;
  waitingOnSince: string | null;
  waitingOnExpectedAt: string | null;
  handoffFromUserId: number | null;
  handoffToUserId: number | null;
  handoffNote: string | null;
  handoffAt: string | null;
  completedAt: string | null;
  version: number;
}

// Section 27: the 8 primary views, rendered as sections of one screen.
export interface PcWorkspaceSummary {
  unassignedCount: number;
  myWorkCount: number;
  teamWorkCount: number;
  waitingOnCount: number;
  overdueCount: number;
  completedTodayCount: number;
}

export interface PcTeamMember {
  userId: number;
  firstName: string;
  lastName: string;
  activeItemCount: number; // capacity signal only -- never a performance metric (Section 15)
}

export interface PcWorkspace {
  generatedAt: string;
  summary: PcWorkspaceSummary;
  myWork: PcWorkItem[];
  unassignedWork: PcWorkItem[];
  teamWork: PcWorkItem[];
  launchCoordination: PcWorkItem[];
  transactionCoordination: PcWorkItem[];
  waitingOn: PcWorkItem[];
  completedToday: PcWorkItem[];
  team: PcTeamMember[];
}

// Section 10-11: dedup/prioritisation mirrors the Command Centre's own
// philosophy (severity first, then due date) rather than inventing a new
// ranking scheme.
export function comparePcWorkItems(a: PcWorkItem, b: PcWorkItem): number {
  const rank: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, ATTENTION: 2, INFORMATION: 3 };
  const ra = rank[a.severity] ?? 4;
  const rb = rank[b.severity] ?? 4;
  if (ra !== rb) return ra - rb;
  const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const db_ = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  return da - db_;
}

// Section 6 (PC service boundary) + Section 10: an item counts as "Pit
// Crew's to see" when the Risk Engine already says so (ownerType PIT_CREW
// or UNASSIGNED_QUEUE) or when Pit Crew has already touched it (a
// pit_crew_assignments row exists, regardless of what the exception's own
// ownerType says -- e.g. an agent-owned exception Pit Crew was asked to
// help chase down).
export function isPitCrewRelevantOwnerType(ownerType: string): boolean {
  return ownerType === "PIT_CREW" || ownerType === "UNASSIGNED_QUEUE";
}

export const LAUNCH_COORDINATION_CATEGORIES = ["LAUNCH_CAMPAIGN"];
export const TRANSACTION_COORDINATION_CATEGORIES = ["OFFERS", "CONTRACT_CONDITIONS", "SETTLEMENT_CLOSURE"];
