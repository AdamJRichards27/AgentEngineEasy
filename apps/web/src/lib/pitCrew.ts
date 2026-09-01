// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). Hand-mirrors the
// PC types and REST surface declared on the API side (apps/api/src/lib/
// pitCrew/types.ts + routes/pitCrew.ts) the same way lib/riskExceptions.ts
// hand-mirrors the Exception & Risk Engine -- there is no shared package
// between apps/web and apps/api, so these shapes are kept in sync by hand.
import { apiFetch } from "./api";

export type PitCrewItemStatus = "UNCLAIMED" | "CLAIMED" | "IN_PROGRESS" | "WAITING_ON" | "DONE";

export interface PcWorkItem {
  sourceType: string;
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
  activeItemCount: number;
}

// Section 27: the 8 primary views, rendered as sections of one screen --
// matches apps/api/src/lib/pitCrew/types.ts's PcWorkspace exactly.
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

export function fetchPitCrewWorkspace(): Promise<PcWorkspace> {
  return apiFetch<PcWorkspace>("/pit-crew/workspace");
}

export function fetchPitCrewTeam(): Promise<PcTeamMember[]> {
  return apiFetch<PcTeamMember[]>("/pit-crew/team");
}

export interface PcMutationBase {
  sourceType: string;
  sourceRecordId: string;
  propertyId: number;
  expectedVersion: number;
}

function pcPost<T = PcWorkItem>(sourceType: string, sourceRecordId: string, action: string, body: Record<string, unknown>): Promise<T> {
  return apiFetch<T>(`/pit-crew/items/${sourceType}/${sourceRecordId}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function claimPcItem(args: PcMutationBase): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost(sourceType, sourceRecordId, "claim", { propertyId, expectedVersion });
}

export function assignPcItem(args: PcMutationBase & { assigneeUserId: number }): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, assigneeUserId } = args;
  return pcPost(sourceType, sourceRecordId, "assign", { propertyId, expectedVersion, assigneeUserId });
}

export function startPcItem(args: PcMutationBase): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost(sourceType, sourceRecordId, "start", { propertyId, expectedVersion });
}

export function setPcWaitingOn(
  args: PcMutationBase & { waitingOnParty: string; waitingOnNote?: string; waitingOnExpectedAt?: string },
): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, waitingOnParty, waitingOnNote, waitingOnExpectedAt } = args;
  return pcPost(sourceType, sourceRecordId, "waiting-on", {
    propertyId,
    expectedVersion,
    waitingOnParty,
    waitingOnNote: waitingOnNote || undefined,
    waitingOnExpectedAt: waitingOnExpectedAt || undefined,
  });
}

export function returnPcItem(args: PcMutationBase): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost(sourceType, sourceRecordId, "return", { propertyId, expectedVersion });
}

export function completePcItem(args: PcMutationBase): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost(sourceType, sourceRecordId, "complete", { propertyId, expectedVersion });
}

export function releasePcItem(args: PcMutationBase): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost(sourceType, sourceRecordId, "release", { propertyId, expectedVersion });
}

export function handoffPcItem(args: PcMutationBase & { toUserId: number; note?: string }): Promise<PcWorkItem> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, toUserId, note } = args;
  return pcPost(sourceType, sourceRecordId, "handoff", { propertyId, expectedVersion, toUserId, note: note || undefined });
}

export function addPcNote(args: { sourceType: string; sourceRecordId: string; propertyId: number; note: string }): Promise<unknown> {
  const { sourceType, sourceRecordId, propertyId, note } = args;
  return pcPost(sourceType, sourceRecordId, "note", { propertyId, note });
}

// Section 10-11: same severity-first, due-date-second ordering as the API's
// own comparePcWorkItems (lib/pitCrew/types.ts) -- kept here too so any
// client-side re-sort (e.g. after an optimistic list update) can't drift
// from the server's ranking.
export function comparePcWorkItems(a: PcWorkItem, b: PcWorkItem): number {
  const rank: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, ATTENTION: 2, INFORMATION: 3 };
  const ra = rank[a.severity] ?? 4;
  const rb = rank[b.severity] ?? 4;
  if (ra !== rb) return ra - rb;
  const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const db_ = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  return da - db_;
}

const PC_STATUS_LABELS: Record<PitCrewItemStatus, string> = {
  UNCLAIMED: "Unclaimed",
  CLAIMED: "Claimed",
  IN_PROGRESS: "In Progress",
  WAITING_ON: "Waiting On",
  DONE: "Done",
};

export function pcStatusLabel(status: string): string {
  return PC_STATUS_LABELS[status as PitCrewItemStatus] ?? status;
}

export function pcStatusPillClass(status: string): string {
  switch (status) {
    case "DONE":
      return "pill pill-success";
    case "WAITING_ON":
      return "pill pill-warning";
    case "UNCLAIMED":
      return "pill pill-danger";
    default:
      return "pill";
  }
}

export function pcTeamMemberName(member: PcTeamMember): string {
  return `${member.firstName} ${member.lastName}`;
}
