// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). Hand-mirrors the
// PC types and REST surface declared on the API side (apps/api/src/lib/
// pitCrew/types.ts + routes/pitCrew.ts) the same way lib/riskExceptions.ts
// hand-mirrors the Exception & Risk Engine -- there is no shared package
// between apps/web and apps/api, so these shapes are kept in sync by hand.
import { ApiError, apiFetch } from "./api";

export type PitCrewItemStatus =
  | "UNCLAIMED"
  | "CLAIMED"
  | "IN_PROGRESS"
  | "WAITING_ON"
  | "DONE"
  | "HANDED_BACK"
  | "ESCALATED";

// Mirrored from packages/db/src/schema/pitCrew.ts
// (PIT_CREW_HAND_BACK_REASON_CATEGORIES, PIT_CREW_ESCALATION_REASON_CATEGORIES,
// PIT_CREW_ESCALATION_SEVERITIES). apps/web does not import @aee/db, and
// there is no shared package with apps/api — see the file header. The route
// zod enums are those same constants (apps/api/src/routes/pitCrew.ts).
export const PIT_CREW_HAND_BACK_REASON_CATEGORIES = [
  "WORK_COMPLETE",
  "NEXT_ACTION_WITH_AGENT",
  "INFORMATION_RETURNED",
  "NOT_PIT_CREW_WORK",
] as const;
export type PitCrewHandBackReasonCategory = (typeof PIT_CREW_HAND_BACK_REASON_CATEGORIES)[number];

export const PIT_CREW_ESCALATION_REASON_CATEGORIES = [
  "BLOCKED_DEPENDENCY",
  "OVERDUE_THIRD_PARTY",
  "SETTLEMENT_OR_COMPLIANCE_RISK",
  "MISSING_AUTHORITY",
  "MISSING_INFORMATION",
  "OTHER_MATERIAL_EXCEPTION",
] as const;
export type PitCrewEscalationReasonCategory = (typeof PIT_CREW_ESCALATION_REASON_CATEGORIES)[number];

export const PIT_CREW_ESCALATION_SEVERITIES = ["ATTENTION", "AT_RISK", "CRITICAL"] as const;
export type PitCrewEscalationSeverity = (typeof PIT_CREW_ESCALATION_SEVERITIES)[number];

export const PIT_CREW_HAND_BACK_REASON_LABELS: Record<PitCrewHandBackReasonCategory, string> = {
  WORK_COMPLETE: "Work complete",
  NEXT_ACTION_WITH_AGENT: "Next action with the agent",
  INFORMATION_RETURNED: "Information returned",
  NOT_PIT_CREW_WORK: "Not Pit Crew work",
};

export const PIT_CREW_ESCALATION_REASON_LABELS: Record<PitCrewEscalationReasonCategory, string> = {
  BLOCKED_DEPENDENCY: "Blocked dependency",
  OVERDUE_THIRD_PARTY: "Overdue third party",
  SETTLEMENT_OR_COMPLIANCE_RISK: "Settlement or compliance risk",
  MISSING_AUTHORITY: "Missing authority",
  MISSING_INFORMATION: "Missing information",
  OTHER_MATERIAL_EXCEPTION: "Other material exception",
};

export function pitCrewReasonLabel(reason: string): string {
  return (
    PIT_CREW_HAND_BACK_REASON_LABELS[reason as PitCrewHandBackReasonCategory] ??
    PIT_CREW_ESCALATION_REASON_LABELS[reason as PitCrewEscalationReasonCategory] ??
    reason
  );
}

// Hand-back and escalate are valid only from these statuses (design state
// machine). Complete, release, and PC-to-PC handoff use the same set.
const PIT_CREW_ACTIVE_ACTION_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

export function isPitCrewActiveActionStatus(status: string): boolean {
  return (PIT_CREW_ACTIVE_ACTION_STATUSES as readonly string[]).includes(status);
}

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
  // Present on the workspace from the library slice onward. Empty when the
  // responsibility flag is off, and also empty when it is on and nothing
  // is in that bucket — so the arrays themselves are not a feature signal.
  handedBack: PcResponsibilityWorkItem[];
  escalated: PcResponsibilityWorkItem[];
  team: PcTeamMember[];
}

// Open event joined onto a handed-back or escalated workspace item.
// Matches apps/api/src/lib/pitCrew/types.ts PcOpenResponsibility.
export interface PcOpenResponsibility {
  eventId: number;
  kind: "HAND_BACK" | "ESCALATION";
  reasonCategory: string;
  severity: PitCrewEscalationSeverity | null;
  note: string | null;
  closingNote: string | null;
  nextAction: string;
  originatingUserId: number;
  operatorDisplayName: string | null;
  recipientUserId: number | null;
  recipientDisplayName: string | null;
  recipientRole: string | null;
  expectedResponseAt: string | null;
  eventStatus: "OPEN" | "ACKNOWLEDGED";
}

export interface PcResponsibilityWorkItem extends PcWorkItem {
  responsibility: PcOpenResponsibility;
}

export interface PcResponsibilityActor {
  id: number;
  role: string;
}

export function canRespondToEscalation(item: PcResponsibilityWorkItem, actor: PcResponsibilityActor): boolean {
  const event = item.responsibility;
  if (event.kind !== "ESCALATION") return false;
  const isAdmin = actor.role === "Brokerage Administrator";
  // The originator cannot acknowledge, resolve, or return unless they are
  // also a Brokerage Administrator. An administrator still has to match
  // the recipient (named user, or the Brokerage Administrator role).
  if (actor.id === event.originatingUserId && !isAdmin) return false;
  if (event.recipientUserId != null && event.recipientUserId === actor.id) return true;
  if (event.recipientRole === "Brokerage Administrator" && isAdmin) return true;
  return false;
}

export function canAcknowledgeEscalation(item: PcResponsibilityWorkItem, actor: PcResponsibilityActor): boolean {
  return item.pcStatus === "ESCALATED" && item.responsibility.eventStatus === "OPEN" && canRespondToEscalation(item, actor);
}

export function canResolveOrReturnEscalation(item: PcResponsibilityWorkItem, actor: PcResponsibilityActor): boolean {
  const eventStatus = item.responsibility.eventStatus;
  return (
    item.pcStatus === "ESCALATED" &&
    (eventStatus === "OPEN" || eventStatus === "ACKNOWLEDGED") &&
    canRespondToEscalation(item, actor)
  );
}

export function fetchPitCrewWorkspace(): Promise<PcWorkspace> {
  return apiFetch<PcWorkspace>("/pit-crew/workspace");
}

export function fetchPitCrewTeam(): Promise<PcTeamMember[]> {
  return apiFetch<PcTeamMember[]>("/pit-crew/team");
}

// HAND_BACK lists active Agents. ESCALATE lists active Brokerage
// Administrators. Same split as resolveResponsibilityRecipient.
export type PcResponsibilityRecipientKind = "HAND_BACK" | "ESCALATE";

export interface PcResponsibilityRecipient {
  userId: number;
  displayName: string;
  role: string;
}

export interface PcResponsibilityRecipientList {
  recipients: PcResponsibilityRecipient[];
}

export function fetchResponsibilityRecipients(kind: PcResponsibilityRecipientKind): Promise<PcResponsibilityRecipientList> {
  return apiFetch<PcResponsibilityRecipientList>(`/pit-crew/responsibility-recipients?kind=${encodeURIComponent(kind)}`);
}

// Shown on the hand-back and escalate forms when the recipient list cannot
// be loaded. The form can still be submitted with the default recipient.
export const PIT_CREW_RECIPIENTS_UNAVAILABLE_MESSAGE = "Recipients couldn't be loaded. You can still submit with the default recipient.";

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

// Assignment row plus the responsibility event, the success body of the six
// R-F16 routes (routes/pitCrew.ts sendResponsibilityMutation). Dates are ISO
// strings because the route JSON-encodes the Drizzle row. closingNote is the
// resolve/return note; it stays null on hand-back, escalate, and acknowledge.
export interface PcResponsibilityEvent {
  id: number;
  brokerageId: number;
  assignmentId: number;
  propertyId: number;
  kind: "HAND_BACK" | "ESCALATION";
  reasonCategory: string;
  severity: PitCrewEscalationSeverity | null;
  note: string | null;
  closingNote: string | null;
  nextAction: string;
  originatingUserId: number;
  recipientUserId: number | null;
  recipientRole: string | null;
  resultingResponsibility: "AGENT" | "BROKERAGE_ADMINISTRATOR";
  expectedResponseAt: string | null;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "RETURNED" | "SUPERSEDED";
  acknowledgedAt: string | null;
  acknowledgedByUserId: number | null;
  closedAt: string | null;
  closedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PcAssignmentMutationRow {
  id: number;
  brokerageId: number;
  sourceType: string;
  sourceRecordId: string;
  propertyId: number;
  status: string;
  assignedToUserId: number | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface PcResponsibilityMutationResult extends PcAssignmentMutationRow {
  responsibilityEvent: PcResponsibilityEvent;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function handBackPcItem(
  args: PcMutationBase & {
    reasonCategory: PitCrewHandBackReasonCategory;
    nextAction: string;
    note?: string;
    recipientUserId?: number;
  },
): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, reasonCategory, nextAction, note, recipientUserId } = args;
  const body: Record<string, unknown> = {
    propertyId,
    expectedVersion,
    reasonCategory,
    nextAction: nextAction.trim(),
  };
  const trimmedNote = trimmedOrUndefined(note);
  if (trimmedNote) body.note = trimmedNote;
  if (recipientUserId != null) body.recipientUserId = recipientUserId;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "hand-back", body);
}

export function escalatePcItem(
  args: PcMutationBase & {
    reasonCategory: PitCrewEscalationReasonCategory;
    severity: PitCrewEscalationSeverity;
    note: string;
    nextAction: string;
    recipientUserId?: number;
    expectedResponseAt?: string;
  },
): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, reasonCategory, severity, note, nextAction, recipientUserId, expectedResponseAt } = args;
  const body: Record<string, unknown> = {
    propertyId,
    expectedVersion,
    reasonCategory,
    severity,
    note: note.trim(),
    nextAction: nextAction.trim(),
  };
  if (recipientUserId != null) body.recipientUserId = recipientUserId;
  const expected = trimmedOrUndefined(expectedResponseAt);
  if (expected) body.expectedResponseAt = expected;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "escalate", body);
}

export function acknowledgePcEscalation(args: PcMutationBase & { note?: string }): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, note } = args;
  const body: Record<string, unknown> = { propertyId, expectedVersion };
  const trimmedNote = trimmedOrUndefined(note);
  if (trimmedNote) body.note = trimmedNote;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "escalation/acknowledge", body);
}

export function resolvePcEscalation(args: PcMutationBase & { note: string }): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, note } = args;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "escalation/resolve", {
    propertyId,
    expectedVersion,
    note: note.trim(),
  });
}

export function returnPcEscalation(args: PcMutationBase & { note: string }): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion, note } = args;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "escalation/return", {
    propertyId,
    expectedVersion,
    note: note.trim(),
  });
}

export function reclaimPcHandBack(args: PcMutationBase): Promise<PcResponsibilityMutationResult> {
  const { sourceType, sourceRecordId, propertyId, expectedVersion } = args;
  return pcPost<PcResponsibilityMutationResult>(sourceType, sourceRecordId, "hand-back/reclaim", {
    propertyId,
    expectedVersion,
  });
}

// Neutral copy for a 404 from one of the six routes. The route uses 404 both
// when the flag is off and when the item is not available, and the generic
// client 404 sentence ("may have been removed") is the wrong one here.
export const PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE = "That action isn't available.";

export function pitCrewResponsibilityActionError(err: unknown, fallback = "Something went wrong. Try again."): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 404) return PIT_CREW_RESPONSIBILITY_UNAVAILABLE_MESSAGE;
  const friendly = err.friendly.trim();
  return friendly.length > 0 ? err.friendly : fallback;
}

// Least-invasive feature signal. GET /pit-crew/responsibility-inbox is
// registered with requireResponsibilityActionsEnabled before auth, and that
// middleware returns 404 { "error": "Not found." } unless
// PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED is the literal "true"
// (apps/api/src/routes/pitCrew.ts). The workspace always includes
// handedBack and escalated (both empty while the flag is off, and also
// empty when the flag is on and those buckets are empty), so those keys
// cannot tell the two states apart. This function does not read or return
// the flag. A 200 means the routes exist for this session. Any other
// failure is rethrown so a blip is not cached as "off".
export async function pitCrewResponsibilityActionsVisible(): Promise<boolean> {
  try {
    await apiFetch<unknown>("/pit-crew/responsibility-inbox");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
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
  HANDED_BACK: "Handed back",
  ESCALATED: "Escalated",
};

export function pcStatusLabel(status: string): string {
  return PC_STATUS_LABELS[status as PitCrewItemStatus] ?? status;
}

export function pcStatusPillClass(status: string): string {
  switch (status) {
    case "DONE":
      return "pill pill-success";
    case "WAITING_ON":
    case "ESCALATED":
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
