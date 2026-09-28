
// Agent Engine 2.0 -- Pit Crew Command Centre, shared types.
//
// PcWorkItem's field names mirror the Command Centre ActionItem shape
// (sourceType, sourceRecordId, deepLink, severity). getCommandCentre is on
// staging; this module still does not import lib/commandCentre. The
// workspace reads open exceptions directly (queries.ts) so financial
// exceptions stay on the Risk Engine's non-entitled view. Hand-back and
// escalate lists stay on PcWorkspace and are not folded into ActionItem.

// R-F21 allow-list. LAUNCH_ITEM is intentionally absent. The tenant check
// accepts it only while PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is the literal
// "true". Putting it in this list would let the flag-off path treat it as known.
export const PIT_CREW_WORK_SOURCE_TYPES = ["EXCEPTION"] as const;
export type PitCrewWorkSourceType = (typeof PIT_CREW_WORK_SOURCE_TYPES)[number];

export const PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE = "LAUNCH_ITEM" as const;
export type PcWorkspaceSourceType = PitCrewWorkSourceType | typeof PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE;

// Pit Crew overlay status vocabulary. UNCLAIMED is the implicit state of
// any source item with no pit_crew_assignments row. HANDED_BACK and
// ESCALATED leave the active workspace buckets. The event payload lives
// on pit_crew_responsibility_events, not on the assignment row.
export const PIT_CREW_ITEM_STATUSES = [
  "UNCLAIMED",
  "CLAIMED",
  "IN_PROGRESS",
  "WAITING_ON",
  "DONE",
  "HANDED_BACK",
  "ESCALATED",
] as const;
export type PitCrewItemStatus = (typeof PIT_CREW_ITEM_STATUSES)[number];

// Validated transitions. Existing edges stay. R-F15 adds only:
// CLAIMED | IN_PROGRESS | WAITING_ON -> HANDED_BACK | ESCALATED,
// HANDED_BACK -> CLAIMED (reclaim), and ESCALATED -> IN_PROGRESS
// (resolve or return). Acknowledge leaves the assignment on ESCALATED,
// so it is not an edge here. DONE stays terminal. UNCLAIMED still only
// reaches CLAIMED, via claim or assign.
export const PIT_CREW_STATUS_TRANSITIONS: Record<PitCrewItemStatus, PitCrewItemStatus[]> = {
  UNCLAIMED: ["CLAIMED"],
  CLAIMED: ["IN_PROGRESS", "WAITING_ON", "DONE", "UNCLAIMED", "HANDED_BACK", "ESCALATED"],
  IN_PROGRESS: ["WAITING_ON", "DONE", "UNCLAIMED", "HANDED_BACK", "ESCALATED"],
  WAITING_ON: ["IN_PROGRESS", "DONE", "UNCLAIMED", "HANDED_BACK", "ESCALATED"],
  DONE: [],
  HANDED_BACK: ["CLAIMED"],
  ESCALATED: ["IN_PROGRESS"],
};

export function isValidPitCrewTransition(from: PitCrewItemStatus, to: PitCrewItemStatus): boolean {
  return PIT_CREW_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

// One risk exception, re-presented as a Pit Crew work item: the exception's
// own fields (authoritative, read-only from here) plus the Pit Crew overlay
// (assignment/status/waiting-on/handoff -- writable via assignment.ts).
export interface PcWorkItem {
  sourceType: PcWorkspaceSourceType;
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

// Open responsibility event joined onto a workspace item. Present only on
// handedBack and escalated. The active buckets do not carry this payload.
export interface PcOpenResponsibility {
  eventId: number;
  kind: "HAND_BACK" | "ESCALATION";
  reasonCategory: string;
  severity: "ATTENTION" | "AT_RISK" | "CRITICAL" | null;
  note: string | null;
  closingNote: string | null;
  nextAction: string;
  originatingUserId: number;
  // Brokerage-scoped name for originatingUserId. "User <id>" when that user
  // is not in this brokerage. Email is not included.
  operatorDisplayName: string;
  recipientUserId: number | null;
  // Null when the recipient is a role. Otherwise the brokerage-scoped name,
  // or "User <id>" when the user row is outside this brokerage.
  recipientDisplayName: string | null;
  recipientRole: string | null;
  expectedResponseAt: string | null;
  eventStatus: "OPEN" | "ACKNOWLEDGED";
}

export interface PcResponsibilityWorkItem extends PcWorkItem {
  responsibility: PcOpenResponsibility;
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
  // Left the active lists. Empty when the responsibility flag is off,
  // because that path does not read pit_crew_responsibility_events.
  handedBack: PcResponsibilityWorkItem[];
  escalated: PcResponsibilityWorkItem[];
  team: PcTeamMember[];
}

// Recipient inbox row. Not an ActionItem. title is null when
// listBrokerageExceptions would omit the exception (listedExceptionTitle).
// That read has no substitute title. closingNote is omitted: inbox rows
// are OPEN or ACKNOWLEDGED, and the closing note is null on those statuses.
export interface ResponsibilityInboxItem {
  sourceType: PitCrewWorkSourceType;
  sourceRecordId: string;
  propertyId: number;
  propertyAddress: string;
  title: string | null;
  nextAction: string;
  kind: "HAND_BACK" | "ESCALATION";
  reasonCategory: string;
  severity: "ATTENTION" | "AT_RISK" | "CRITICAL" | null;
  note: string | null;
  originatingUserId: number;
  operatorDisplayName: string;
  recipientUserId: number | null;
  recipientDisplayName: string | null;
  recipientRole: string | null;
  expectedResponseAt: string | null;
  eventStatus: "OPEN" | "ACKNOWLEDGED";
  assignmentStatus: PitCrewItemStatus;
  version: number;
  deepLink: string;
  createdAt: string;
}

export interface ResponsibilityInbox {
  generatedAt: string;
  items: ResponsibilityInboxItem[];
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
