
// Agent Engine 2.0 -- Pit Crew Command Centre, read model.
//
// Sources work items from listBrokerageExceptions (Exception & Risk Engine).
// getCommandCentre is on staging. This workspace still reads exceptions
// directly and does not import lib/commandCentre or lib/grow. Hand-back
// and escalate stay on handedBack and escalated; they are not folded into
// ActionItem.
//
// The overlay (pit_crew_assignments) is the workspace bucket. While
// PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED is not the literal "true", this
// read does not query pit_crew_responsibility_events. When the flag is on,
// handedBack and escalated join the open event for reason, recipient,
// next action, severity, and expected response.

import { eq, and, inArray } from "drizzle-orm";
import { db, pitCrewAssignments, pitCrewResponsibilityEvents, users, type PitCrewResponsibilityEvent } from "@aee/db";
import { listBrokerageExceptions } from "../exceptions/queries.js";
import { isPitCrewResponsibilityActionsEnabled } from "./responsibility.js";
import {
  type PcWorkItem,
  type PcWorkspace,
  type PcTeamMember,
  type PcResponsibilityWorkItem,
  type PcOpenResponsibility,
  type PitCrewItemStatus,
  isPitCrewRelevantOwnerType,
  comparePcWorkItems,
  LAUNCH_COORDINATION_CATEGORIES,
  TRANSACTION_COORDINATION_CATEGORIES,
} from "./types.js";

// Open statuses only -- the same list the Command Centre uses for its own
// "live attention" exception query (recently-resolved items are handled
// separately, by Completed Today, which reads Pit Crew's own completedAt
// rather than the exception's resolvedAt -- Pit Crew's "done" is about its
// own involvement, not whether the underlying exception auto-resolved).
const OPEN_EXCEPTION_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL", "REOPENED"];

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function isActiveWorkspaceStatus(status: PitCrewItemStatus): boolean {
  return status !== "DONE" && status !== "HANDED_BACK" && status !== "ESCALATED";
}

async function loadOpenResponsibilityBySourceRecordId(
  brokerageId: number,
  overlayRows: Array<{ id: number; sourceRecordId: string }>,
): Promise<Map<string, PitCrewResponsibilityEvent>> {
  const bySource = new Map<string, PitCrewResponsibilityEvent>();
  if (!isPitCrewResponsibilityActionsEnabled() || overlayRows.length === 0) return bySource;
  const events = await db
    .select()
    .from(pitCrewResponsibilityEvents)
    .where(
      and(
        eq(pitCrewResponsibilityEvents.brokerageId, brokerageId),
        inArray(
          pitCrewResponsibilityEvents.assignmentId,
          overlayRows.map((row) => row.id),
        ),
        inArray(pitCrewResponsibilityEvents.status, ["OPEN", "ACKNOWLEDGED"]),
      ),
    );
  const byAssignment = new Map(events.map((event) => [event.assignmentId, event]));
  for (const row of overlayRows) {
    const event = byAssignment.get(row.id);
    if (event) bySource.set(row.sourceRecordId, event);
  }
  return bySource;
}

function escalationSeverity(value: string | null): PcOpenResponsibility["severity"] {
  if (value === "ATTENTION" || value === "AT_RISK" || value === "CRITICAL") return value;
  return null;
}

function toResponsibilityWorkItem(
  item: PcWorkItem,
  event: PitCrewResponsibilityEvent | undefined,
  kind: "HAND_BACK" | "ESCALATION",
): PcResponsibilityWorkItem | null {
  if (!event || event.kind !== kind) return null;
  if (event.status !== "OPEN" && event.status !== "ACKNOWLEDGED") return null;
  return {
    ...item,
    responsibility: {
      eventId: event.id,
      kind,
      reasonCategory: event.reasonCategory,
      severity: escalationSeverity(event.severity),
      note: event.note,
      closingNote: event.closingNote,
      nextAction: event.nextAction,
      originatingUserId: event.originatingUserId,
      recipientUserId: event.recipientUserId,
      recipientRole: event.recipientRole,
      expectedResponseAt: event.expectedResponseAt ? event.expectedResponseAt.toISOString() : null,
      eventStatus: event.status,
    },
  };
}

export async function getPitCrewWorkspace(brokerageId: number, actorUserId: number): Promise<PcWorkspace> {
  const now = new Date();

  // Pit Crew never has financial entitlement (Sections 24-25) -- reusing
  // the Risk Engine's own redaction (canViewFinancials: false) rather than
  // re-implementing a second financial exclusion check.
  const exceptionPage = await listBrokerageExceptions(brokerageId, false, null, {
    status: OPEN_EXCEPTION_STATUSES,
    limit: 500,
    offset: 0,
  });

  const sourceRecordIds = exceptionPage.exceptions.map((exc) => exc.id);
  const overlayRows = sourceRecordIds.length
    ? await db
        .select()
        .from(pitCrewAssignments)
        .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), inArray(pitCrewAssignments.sourceRecordId, sourceRecordIds)))
    : [];
  const overlayByRecordId = new Map(overlayRows.map((row) => [row.sourceRecordId, row]));
  const openResponsibilityBySourceId = await loadOpenResponsibilityBySourceRecordId(brokerageId, overlayRows);

  const assignedUserIds = [...new Set(overlayRows.map((row) => row.assignedToUserId).filter((id): id is number => id != null))];
  const assignedUsers = assignedUserIds.length
    ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(inArray(users.id, assignedUserIds))
    : [];
  const nameByUserId = new Map(assignedUsers.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

  const items: PcWorkItem[] = exceptionPage.exceptions.map((exc) => {
    const overlay = overlayByRecordId.get(exc.id);
    const pcStatus: PitCrewItemStatus = (overlay?.status as PitCrewItemStatus | undefined) ?? "UNCLAIMED";
    const dueAt = exc.dueAt ? new Date(exc.dueAt) : null;
    return {
      sourceType: "EXCEPTION",
      sourceRecordId: exc.id,
      propertyId: exc.propertyId,
      propertyAddress: exc.propertyAddress,
      brokerageId: exc.brokerageId,
      title: exc.title,
      description: exc.problemDescription,
      category: exc.category,
      severity: exc.severity as PcWorkItem["severity"],
      exceptionStatus: exc.status,
      ownerType: exc.ownerType,
      ownerUserId: exc.ownerUserId,
      ownerName: exc.ownerName,
      dueAt: dueAt ? dueAt.toISOString() : null,
      overdue: dueAt ? dueAt.getTime() < now.getTime() : false,
      recommendedAction: exc.recommendedAction,
      deepLink: `/properties/${exc.propertyId}`,
      detectedAt: new Date(exc.detectedAt).toISOString(),

      pcStatus,
      assignedToUserId: overlay?.assignedToUserId ?? null,
      assignedToName: overlay?.assignedToUserId != null ? (nameByUserId.get(overlay.assignedToUserId) ?? null) : null,
      claimedAt: overlay?.claimedAt ? overlay.claimedAt.toISOString() : null,
      waitingOnParty: overlay?.waitingOnParty ?? null,
      waitingOnNote: overlay?.waitingOnNote ?? null,
      waitingOnSince: overlay?.waitingOnSince ? overlay.waitingOnSince.toISOString() : null,
      waitingOnExpectedAt: overlay?.waitingOnExpectedAt ? overlay.waitingOnExpectedAt.toISOString() : null,
      handoffFromUserId: overlay?.handoffFromUserId ?? null,
      handoffToUserId: overlay?.handoffToUserId ?? null,
      handoffNote: overlay?.handoffNote ?? null,
      handoffAt: overlay?.handoffAt ? overlay.handoffAt.toISOString() : null,
      completedAt: overlay?.completedAt ? overlay.completedAt.toISOString() : null,
      // 0 means no overlay row exists yet. loadOrCreateOverlay inserts the
      // first row at version 0, not the schema default of 1, so a client
      // that observed no row can pass expectedVersion 0.
      version: overlay?.version ?? 0,
    };
  });

  // Section 6/10: an item is Pit Crew's to see when the Risk Engine already
  // says so (ownerType PIT_CREW or UNASSIGNED_QUEUE) or when Pit Crew has
  // already touched it (an overlay row exists, whatever the exception's
  // own ownerType says -- e.g. an agent-owned exception Pit Crew was asked
  // to help chase down).
  const pcRelevant = items.filter((item) => isPitCrewRelevantOwnerType(item.ownerType) || item.version > 0);

  const unassignedWork = pcRelevant.filter((item) => item.pcStatus === "UNCLAIMED").sort(comparePcWorkItems);
  const myWork = pcRelevant
    .filter((item) => item.assignedToUserId === actorUserId && isActiveWorkspaceStatus(item.pcStatus))
    .sort(comparePcWorkItems);
  const teamWork = pcRelevant.filter((item) => isActiveWorkspaceStatus(item.pcStatus)).sort(comparePcWorkItems);
  const waitingOn = pcRelevant.filter((item) => item.pcStatus === "WAITING_ON").sort(comparePcWorkItems);
  const completedToday = pcRelevant
    .filter((item) => item.pcStatus === "DONE" && item.completedAt && isSameUtcDay(new Date(item.completedAt), now))
    .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());
  const launchCoordination = pcRelevant
    .filter((item) => LAUNCH_COORDINATION_CATEGORIES.includes(item.category) && isActiveWorkspaceStatus(item.pcStatus))
    .sort(comparePcWorkItems);
  const transactionCoordination = pcRelevant
    .filter((item) => TRANSACTION_COORDINATION_CATEGORIES.includes(item.category) && isActiveWorkspaceStatus(item.pcStatus))
    .sort(comparePcWorkItems);
  const overdueCount = pcRelevant.filter((item) => item.overdue && isActiveWorkspaceStatus(item.pcStatus)).length;
  const handedBack = pcRelevant
    .filter((item) => item.pcStatus === "HANDED_BACK")
    .map((item) => toResponsibilityWorkItem(item, openResponsibilityBySourceId.get(item.sourceRecordId), "HAND_BACK"))
    .filter((item): item is PcResponsibilityWorkItem => item != null)
    .sort(comparePcWorkItems);
  const escalated = pcRelevant
    .filter((item) => item.pcStatus === "ESCALATED")
    .map((item) => toResponsibilityWorkItem(item, openResponsibilityBySourceId.get(item.sourceRecordId), "ESCALATION"))
    .filter((item): item is PcResponsibilityWorkItem => item != null)
    .sort(comparePcWorkItems);

  const team = await getPitCrewTeam(brokerageId);

  return {
    generatedAt: now.toISOString(),
    summary: {
      unassignedCount: unassignedWork.length,
      myWorkCount: myWork.length,
      teamWorkCount: teamWork.length,
      waitingOnCount: waitingOn.length,
      overdueCount,
      completedTodayCount: completedToday.length,
    },
    myWork,
    unassignedWork,
    teamWork,
    launchCoordination,
    transactionCoordination,
    waitingOn,
    completedToday,
    handedBack,
    escalated,
    team,
  };
}

// Section 15: workload/capacity indicators, explicitly NOT performance
// surveillance -- this returns only a live count of currently-active
// (claimed/in-progress/waiting-on) items per person, never completion
// counts, speed, or any historical/comparative metric.
export async function getPitCrewTeam(brokerageId: number): Promise<PcTeamMember[]> {
  const members = await db
    .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(and(eq(users.brokerageId, brokerageId), eq(users.role, "Pit Crew"), eq(users.isActive, true)));
  if (members.length === 0) return [];

  const memberIds = members.map((m) => m.id);
  const activeRows = await db
    .select({ assignedToUserId: pitCrewAssignments.assignedToUserId })
    .from(pitCrewAssignments)
    .where(
      and(
        inArray(pitCrewAssignments.assignedToUserId, memberIds),
        inArray(pitCrewAssignments.status, ["CLAIMED", "IN_PROGRESS", "WAITING_ON"]),
      ),
    );
  const countByUserId = new Map<number, number>();
  for (const row of activeRows) {
    if (row.assignedToUserId == null) continue;
    countByUserId.set(row.assignedToUserId, (countByUserId.get(row.assignedToUserId) ?? 0) + 1);
  }

  return members.map((m) => ({
    userId: m.id,
    firstName: m.firstName,
    lastName: m.lastName,
    activeItemCount: countByUserId.get(m.id) ?? 0,
  }));
}
