
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
//
// listResponsibilityItemsForRecipient is the recipient inbox. It refuses
// before reading that table unless the responsibility flag is the literal
// "true". While PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is not the literal
// "true", that read keeps the exception inner join and does not query
// campaign_items. While it is, a LAUNCH_ITEM row left-joins campaign_items
// on the item id, the caller's brokerage id, and
// campaign_items.property_id = the event's property_id. A campaign item on
// a different property is excluded, the same way a missing exception is
// excluded, and its title is not returned. A COMPLETE campaign item is
// excluded the same way. BLOCKED and the other non-complete statuses stay.
// The flag-on exception join requires risk_exceptions.property_id to match
// the event as well. The flag-off inbox does not. cost_cents and
// vendor_name are not selected. LAUNCH_ITEM hand-back, escalate,
// acknowledge, resolve, return, and reclaim run only when both flags are
// the literal "true". The flag-off inbox function is unchanged.
//
// Open campaign items are included only when
// PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is the literal "true". While it is
// not, this read does not query campaign_items. Relevance matches
// exceptions: responsible owner PIT_CREW or UNASSIGNED_QUEUE, or an
// overlay the workspace already treats as touched (version > 0). There is
// no due-date horizon. Pit Crew actions do not write campaign_items.

import { eq, and, asc, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { campaignItems, db, pitCrewAssignments, pitCrewResponsibilityEvents, properties, riskExceptions, users, type PitCrewResponsibilityEvent } from "@aee/db";
import { BROKERAGE_ADMIN_ROLES } from "../../middlewares/auth.js";
import { listBrokerageExceptions, listedExceptionTitle } from "../exceptions/queries.js";
import { isPitCrewLaunchItemSourceEnabled } from "./launchItemSource.js";
import { explicitResponsibilityRecipientRole, isPitCrewResponsibilityActionsEnabled, PitCrewResponsibilityDisabledError } from "./responsibility.js";
import {
  type PcWorkItem,
  type PcWorkspace,
  type PcTeamMember,
  type PcResponsibilityWorkItem,
  type PcOpenResponsibility,
  type PitCrewItemStatus,
  type ResponsibilityInbox,
  type ResponsibilityInboxItem,
  isPitCrewRelevantOwnerType,
  comparePcWorkItems,
  LAUNCH_COORDINATION_CATEGORIES,
  PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE,
  TRANSACTION_COORDINATION_CATEGORIES,
} from "./types.js";

// Open statuses only -- the same list the Command Centre uses for its own
// "live attention" exception query (recently-resolved items are handled
// separately, by Completed Today, which reads Pit Crew's own completedAt
// rather than the exception's resolvedAt -- Pit Crew's "done" is about its
// own involvement, not whether the underlying exception auto-resolved).
const OPEN_EXCEPTION_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL", "REOPENED"];

// Two aliases so a responsibility read can name the operator and the
// recipient without joining users twice under the same name. Both joins
// require users.brokerage_id to equal the session brokerage.
const responsibilityRecipientUser = alias(users, "pc_responsibility_recipient_user");
const responsibilityOperatorUser = alias(users, "pc_responsibility_operator_user");

/**
 * Ceiling for GET /pit-crew/responsibility-recipients. Applied after
 * displayName order, so a brokerage with more matching users than this
 * returns the first 500 names. This is a picker ceiling, not a page token.
 */
export const RESPONSIBILITY_RECIPIENT_LIST_CAP = 500;

export interface ResponsibilityRecipientOption {
  userId: number;
  displayName: string;
  role: "Agent" | "Brokerage Administrator";
}

/**
 * "First Last" when either name is non-empty. Otherwise the email local
 * part. Otherwise "User <id>". Email itself is never returned to the client.
 */
export function responsibilityUserDisplayName(user: { id: number; firstName: string; lastName: string; email: string }): string {
  const name = [user.firstName.trim(), user.lastName.trim()].filter((part) => part.length > 0).join(" ");
  if (name.length > 0) return name;
  const local = user.email.split("@")[0]?.trim() ?? "";
  if (local.length > 0) return local;
  return `User ${user.id}`;
}

export function capOrderedResponsibilityRecipients<T extends { userId: number; displayName: string }>(
  recipients: readonly T[],
  cap = RESPONSIBILITY_RECIPIENT_LIST_CAP,
): T[] {
  return [...recipients]
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }) || a.userId - b.userId)
    .slice(0, cap);
}

interface JoinedUserName {
  id: number | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
}

function displayNameForJoinedUser(userId: number | null, joined: JoinedUserName): string | null {
  if (userId == null) return null;
  if (joined.id == null) return `User ${userId}`;
  return responsibilityUserDisplayName({
    id: joined.id,
    firstName: joined.firstName ?? "",
    lastName: joined.lastName ?? "",
    email: joined.email ?? "",
  });
}

interface LoadedOpenResponsibility {
  event: PitCrewResponsibilityEvent;
  operatorDisplayName: string;
  recipientDisplayName: string | null;
}

function isSameUtcDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function isActiveWorkspaceStatus(status: PitCrewItemStatus): boolean {
  return status !== "DONE" && status !== "HANDED_BACK" && status !== "ESCALATED";
}

interface OpenResponsibilityOverlayRef {
  id: number;
  sourceType: string;
  sourceRecordId: string;
}

// Source type and id, so an exception event and a launch-item event cannot
// attach to each other when both sets share this map.
function openResponsibilityKey(sourceType: string, sourceRecordId: string): string {
  return `${sourceType}\u0000${sourceRecordId}`;
}

async function loadOpenResponsibilityBySourceRecordId(
  brokerageId: number,
  overlayRows: OpenResponsibilityOverlayRef[],
): Promise<Map<string, LoadedOpenResponsibility>> {
  const bySource = new Map<string, LoadedOpenResponsibility>();
  if (!isPitCrewResponsibilityActionsEnabled() || overlayRows.length === 0) return bySource;
  const events = await db
    .select({
      event: pitCrewResponsibilityEvents,
      recipientId: responsibilityRecipientUser.id,
      recipientFirstName: responsibilityRecipientUser.firstName,
      recipientLastName: responsibilityRecipientUser.lastName,
      recipientEmail: responsibilityRecipientUser.email,
      operatorId: responsibilityOperatorUser.id,
      operatorFirstName: responsibilityOperatorUser.firstName,
      operatorLastName: responsibilityOperatorUser.lastName,
      operatorEmail: responsibilityOperatorUser.email,
    })
    .from(pitCrewResponsibilityEvents)
    .leftJoin(
      responsibilityRecipientUser,
      and(eq(responsibilityRecipientUser.id, pitCrewResponsibilityEvents.recipientUserId), eq(responsibilityRecipientUser.brokerageId, brokerageId)),
    )
    .leftJoin(
      responsibilityOperatorUser,
      and(eq(responsibilityOperatorUser.id, pitCrewResponsibilityEvents.originatingUserId), eq(responsibilityOperatorUser.brokerageId, brokerageId)),
    )
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
  const byAssignment = new Map(events.map((row) => [row.event.assignmentId, row]));
  for (const row of overlayRows) {
    const loaded = byAssignment.get(row.id);
    if (!loaded) continue;
    bySource.set(openResponsibilityKey(row.sourceType, row.sourceRecordId), {
      event: loaded.event,
      operatorDisplayName:
        displayNameForJoinedUser(loaded.event.originatingUserId, {
          id: loaded.operatorId,
          firstName: loaded.operatorFirstName,
          lastName: loaded.operatorLastName,
          email: loaded.operatorEmail,
        }) ?? `User ${loaded.event.originatingUserId}`,
      recipientDisplayName: displayNameForJoinedUser(loaded.event.recipientUserId, {
        id: loaded.recipientId,
        firstName: loaded.recipientFirstName,
        lastName: loaded.recipientLastName,
        email: loaded.recipientEmail,
      }),
    });
  }
  return bySource;
}

function escalationSeverity(value: string | null): PcOpenResponsibility["severity"] {
  if (value === "ATTENTION" || value === "AT_RISK" || value === "CRITICAL") return value;
  return null;
}

// Same boolean as routes/exceptions.ts canViewFinancials: only Brokerage
// Administrator is in BROKERAGE_ADMIN_ROLES. Agent and Pit Crew are not.
function callerCanViewFinancials(role: string): boolean {
  return (BROKERAGE_ADMIN_ROLES as readonly string[]).includes(role);
}

function toResponsibilityWorkItem(
  item: PcWorkItem,
  loaded: LoadedOpenResponsibility | undefined,
  kind: "HAND_BACK" | "ESCALATION",
): PcResponsibilityWorkItem | null {
  if (!loaded || loaded.event.kind !== kind) return null;
  const event = loaded.event;
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
      operatorDisplayName: loaded.operatorDisplayName,
      recipientUserId: event.recipientUserId,
      recipientDisplayName: loaded.recipientDisplayName,
      recipientRole: event.recipientRole,
      expectedResponseAt: event.expectedResponseAt ? event.expectedResponseAt.toISOString() : null,
      eventStatus: event.status,
    },
  };
}

const launchItemOwner = alias(users, "pc_launch_item_owner");

// Only called when the launch-item flag is the literal "true". Open means
// the campaign item is not COMPLETE. COMPLETE rows stay out even if an
// overlay exists: Pit Crew done is the overlay, and a finished campaign
// item is not an open work item. cost_cents and vendor_name are not selected.
async function loadLaunchItemWorkItems(
  brokerageId: number,
  now: Date,
): Promise<{ items: PcWorkItem[]; overlays: OpenResponsibilityOverlayRef[] }> {
  const rows = await db
    .select({
      id: campaignItems.id,
      propertyId: campaignItems.propertyId,
      brokerageId: campaignItems.brokerageId,
      title: campaignItems.title,
      description: campaignItems.description,
      status: campaignItems.status,
      responsibleOwnerType: campaignItems.responsibleOwnerType,
      responsibleUserId: campaignItems.responsibleUserId,
      dueAt: campaignItems.dueAt,
      createdAt: campaignItems.createdAt,
      propertyAddress: properties.formattedAddress,
      ownerId: launchItemOwner.id,
      ownerFirstName: launchItemOwner.firstName,
      ownerLastName: launchItemOwner.lastName,
    })
    .from(campaignItems)
    .innerJoin(properties, and(eq(properties.id, campaignItems.propertyId), eq(properties.brokerageId, brokerageId)))
    .leftJoin(
      launchItemOwner,
      and(eq(launchItemOwner.id, campaignItems.responsibleUserId), eq(launchItemOwner.brokerageId, brokerageId)),
    )
    .where(and(eq(campaignItems.brokerageId, brokerageId), ne(campaignItems.status, "COMPLETE")));
  if (rows.length === 0) return { items: [], overlays: [] };

  const overlayRows = await db
    .select()
    .from(pitCrewAssignments)
    .where(
      and(
        eq(pitCrewAssignments.sourceType, PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE),
        inArray(
          pitCrewAssignments.sourceRecordId,
          rows.map((row) => row.id),
        ),
      ),
    );
  const overlayByRecordId = new Map(overlayRows.map((row) => [row.sourceRecordId, row]));
  const assignedUserIds = [...new Set(overlayRows.map((row) => row.assignedToUserId).filter((id): id is number => id != null))];
  const assignedUsers = assignedUserIds.length
    ? await db
        .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users)
        .where(and(inArray(users.id, assignedUserIds), eq(users.brokerageId, brokerageId)))
    : [];
  const nameByUserId = new Map(assignedUsers.map((user) => [user.id, `${user.firstName} ${user.lastName}`.trim()]));

  const items: PcWorkItem[] = rows.map((row) => {
    const overlay = overlayByRecordId.get(row.id);
    const pcStatus: PitCrewItemStatus = (overlay?.status as PitCrewItemStatus | undefined) ?? "UNCLAIMED";
    const dueAt = row.dueAt ? new Date(row.dueAt) : null;
    const ownerName =
      row.ownerId != null ? `${row.ownerFirstName ?? ""} ${row.ownerLastName ?? ""}`.trim() : "";
    return {
      sourceType: PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE,
      sourceRecordId: row.id,
      propertyId: row.propertyId,
      propertyAddress: row.propertyAddress,
      brokerageId: row.brokerageId,
      title: row.title,
      description: row.description ?? "",
      category: "LAUNCH_CAMPAIGN",
      severity: "INFORMATION",
      exceptionStatus: row.status,
      ownerType: row.responsibleOwnerType,
      ownerUserId: row.responsibleUserId,
      ownerName: ownerName.length > 0 ? ownerName : null,
      dueAt: dueAt ? dueAt.toISOString() : null,
      overdue: dueAt ? dueAt.getTime() < now.getTime() : false,
      recommendedAction: "",
      deepLink: `/properties/${row.propertyId}`,
      detectedAt: new Date(row.createdAt).toISOString(),
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
      version: overlay?.version ?? 0,
    };
  });
  return {
    items,
    overlays: overlayRows.map((row) => ({
      id: row.id,
      sourceType: row.sourceType,
      sourceRecordId: row.sourceRecordId,
    })),
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

  // Flag off must not call the loader. That call is the only campaign_items read.
  const launchLoaded = isPitCrewLaunchItemSourceEnabled()
    ? await loadLaunchItemWorkItems(brokerageId, now)
    : { items: [] as PcWorkItem[], overlays: [] as OpenResponsibilityOverlayRef[] };
  if (launchLoaded.overlays.length > 0) {
    const launchOpen = await loadOpenResponsibilityBySourceRecordId(brokerageId, launchLoaded.overlays);
    for (const [key, loaded] of launchOpen) openResponsibilityBySourceId.set(key, loaded);
  }
  const launchItems = launchLoaded.items;
  const workspaceItems = items.concat(launchItems);

  // Section 6/10: an item is Pit Crew's to see when the owner is already
  // PIT_CREW or UNASSIGNED_QUEUE, or when Pit Crew has already touched it
  // (version > 0, whatever the source owner says). Launch items use the
  // same rule. A due date outside today does not hide a launch item.
  const pcRelevant = workspaceItems.filter((item) => isPitCrewRelevantOwnerType(item.ownerType) || item.version > 0);

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
    .map((item) => toResponsibilityWorkItem(item, openResponsibilityBySourceId.get(openResponsibilityKey(item.sourceType, item.sourceRecordId)), "HAND_BACK"))
    .filter((item): item is PcResponsibilityWorkItem => item != null)
    .sort(comparePcWorkItems);
  const escalated = pcRelevant
    .filter((item) => item.pcStatus === "ESCALATED")
    .map((item) => toResponsibilityWorkItem(item, openResponsibilityBySourceId.get(openResponsibilityKey(item.sourceType, item.sourceRecordId)), "ESCALATION"))
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

interface ResponsibilityInboxRowIdentity {
  sourceType: "EXCEPTION" | typeof PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE;
  sourceRecordId: string;
  propertyAddress: string;
  title: string | null;
  assignmentStatus: string;
  version: number;
  event: PitCrewResponsibilityEvent;
  recipientId: number | null;
  recipientFirstName: string | null;
  recipientLastName: string | null;
  recipientEmail: string | null;
  operatorId: number | null;
  operatorFirstName: string | null;
  operatorLastName: string | null;
  operatorEmail: string | null;
}

function responsibilityInboxItem(row: ResponsibilityInboxRowIdentity): ResponsibilityInboxItem {
  return {
    sourceType: row.sourceType,
    sourceRecordId: row.sourceRecordId,
    propertyId: row.event.propertyId,
    propertyAddress: row.propertyAddress,
    title: row.title,
    nextAction: row.event.nextAction,
    kind: row.event.kind === "ESCALATION" ? "ESCALATION" : "HAND_BACK",
    reasonCategory: row.event.reasonCategory,
    severity: escalationSeverity(row.event.severity),
    note: row.event.note,
    originatingUserId: row.event.originatingUserId,
    operatorDisplayName:
      displayNameForJoinedUser(row.event.originatingUserId, {
        id: row.operatorId,
        firstName: row.operatorFirstName,
        lastName: row.operatorLastName,
        email: row.operatorEmail,
      }) ?? `User ${row.event.originatingUserId}`,
    recipientUserId: row.event.recipientUserId,
    recipientDisplayName: displayNameForJoinedUser(row.event.recipientUserId, {
      id: row.recipientId,
      firstName: row.recipientFirstName,
      lastName: row.recipientLastName,
      email: row.recipientEmail,
    }),
    recipientRole: row.event.recipientRole,
    expectedResponseAt: row.event.expectedResponseAt ? row.event.expectedResponseAt.toISOString() : null,
    eventStatus: row.event.status === "ACKNOWLEDGED" ? "ACKNOWLEDGED" : "OPEN",
    assignmentStatus: row.assignmentStatus as PitCrewItemStatus,
    version: row.version,
    deepLink: `/properties/${row.event.propertyId}`,
    createdAt: row.event.createdAt.toISOString(),
  };
}

/**
 * Open responsibility events for this caller in this brokerage.
 * Status is OPEN or ACKNOWLEDGED. A row matches when recipient_user_id is
 * the caller or recipient_role equals the caller's role. Brokerage id comes
 * from the caller; this function does not accept another user's id.
 *
 * Order is deterministic: expectedResponseAt ascending with nulls last,
 * then createdAt ascending, then id ascending.
 *
 * The exception title is listedExceptionTitle. Agent and Pit Crew therefore
 * get null for a row listBrokerageExceptions would omit. A Brokerage
 * Administrator gets the raw title. note and nextAction are the text on
 * the event. This read does not join financial tables.
 *
 * A LAUNCH_ITEM row is included only when
 * PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is the literal "true". Its title is
 * campaign_items.title. That branch selects the campaign item id, title,
 * property id, brokerage id, and status, and does not select cost_cents or
 * vendor_name. The campaign_items join also requires
 * campaign_items.property_id to equal the event's property_id, and
 * campaign_items.status to be anything other than COMPLETE. A row whose
 * campaign item is on a different property, or is COMPLETE, is excluded
 * from the inbox, the same way a missing exception is excluded, so the
 * campaign item title is not returned. BLOCKED stays. The flag-on exception
 * join requires the same property match. The flag-off function does not.
 * While the launch-item flag is not the literal "true", this function does
 * not query campaign_items.
 */
export async function listResponsibilityItemsForRecipient(
  brokerageId: number,
  userId: number,
  role: string,
): Promise<ResponsibilityInbox> {
  if (!isPitCrewResponsibilityActionsEnabled()) {
    throw new PitCrewResponsibilityDisabledError();
  }
  if (!isPitCrewLaunchItemSourceEnabled()) {
    return listExceptionResponsibilityInbox(brokerageId, userId, role);
  }
  return listResponsibilityInboxIncludingLaunchItems(brokerageId, userId, role);
}

// Flag-off inbox. The exception inner join and the selected columns stay
// as they were before LAUNCH_ITEM. This function does not mention
// campaign_items.
async function listExceptionResponsibilityInbox(
  brokerageId: number,
  userId: number,
  role: string,
): Promise<ResponsibilityInbox> {
  const generatedAt = new Date().toISOString();
  const canViewFinancials = callerCanViewFinancials(role);
  const rows = await db
    .select({
      event: pitCrewResponsibilityEvents,
      sourceRecordId: pitCrewAssignments.sourceRecordId,
      assignmentStatus: pitCrewAssignments.status,
      version: pitCrewAssignments.version,
      title: riskExceptions.title,
      requiresFinancialEntitlement: riskExceptions.requiresFinancialEntitlement,
      propertyAddress: properties.formattedAddress,
      recipientId: responsibilityRecipientUser.id,
      recipientFirstName: responsibilityRecipientUser.firstName,
      recipientLastName: responsibilityRecipientUser.lastName,
      recipientEmail: responsibilityRecipientUser.email,
      operatorId: responsibilityOperatorUser.id,
      operatorFirstName: responsibilityOperatorUser.firstName,
      operatorLastName: responsibilityOperatorUser.lastName,
      operatorEmail: responsibilityOperatorUser.email,
    })
    .from(pitCrewResponsibilityEvents)
    .innerJoin(pitCrewAssignments, eq(pitCrewResponsibilityEvents.assignmentId, pitCrewAssignments.id))
    .innerJoin(
      riskExceptions,
      and(
        eq(pitCrewAssignments.sourceType, "EXCEPTION"),
        sql`${pitCrewAssignments.sourceRecordId} = ${riskExceptions.id}::text`,
        eq(riskExceptions.brokerageId, brokerageId),
      ),
    )
    .innerJoin(
      properties,
      and(eq(properties.id, pitCrewResponsibilityEvents.propertyId), eq(properties.brokerageId, brokerageId)),
    )
    .leftJoin(
      responsibilityRecipientUser,
      and(eq(responsibilityRecipientUser.id, pitCrewResponsibilityEvents.recipientUserId), eq(responsibilityRecipientUser.brokerageId, brokerageId)),
    )
    .leftJoin(
      responsibilityOperatorUser,
      and(eq(responsibilityOperatorUser.id, pitCrewResponsibilityEvents.originatingUserId), eq(responsibilityOperatorUser.brokerageId, brokerageId)),
    )
    .where(
      and(
        eq(pitCrewResponsibilityEvents.brokerageId, brokerageId),
        eq(pitCrewAssignments.brokerageId, brokerageId),
        inArray(pitCrewResponsibilityEvents.status, ["OPEN", "ACKNOWLEDGED"]),
        or(eq(pitCrewResponsibilityEvents.recipientUserId, userId), eq(pitCrewResponsibilityEvents.recipientRole, role)),
      ),
    )
    .orderBy(
      sql`${pitCrewResponsibilityEvents.expectedResponseAt} asc nulls last`,
      asc(pitCrewResponsibilityEvents.createdAt),
      asc(pitCrewResponsibilityEvents.id),
    );

  const items = rows.map((row) =>
    responsibilityInboxItem({
      sourceType: "EXCEPTION",
      sourceRecordId: row.sourceRecordId,
      propertyAddress: row.propertyAddress,
      title: listedExceptionTitle(
        { title: row.title, requiresFinancialEntitlement: row.requiresFinancialEntitlement },
        canViewFinancials,
      ),
      assignmentStatus: row.assignmentStatus,
      version: row.version,
      event: row.event,
      recipientId: row.recipientId,
      recipientFirstName: row.recipientFirstName,
      recipientLastName: row.recipientLastName,
      recipientEmail: row.recipientEmail,
      operatorId: row.operatorId,
      operatorFirstName: row.operatorFirstName,
      operatorLastName: row.operatorLastName,
      operatorEmail: row.operatorEmail,
    }),
  );

  return { generatedAt, items };
}

// Flag-on inbox. Exception rows still use listedExceptionTitle. A
// LAUNCH_ITEM row survives only when campaign_items matches the assignment
// id, the caller's brokerage, and the event's property, and its status is
// not COMPLETE. A campaign item on a different property than the event, or
// a COMPLETE campaign item, is excluded, the same way a missing exception
// is excluded: the left join does not match, and the row is dropped.
// BLOCKED and the other non-complete statuses stay. The exception left join
// in this function also requires risk_exceptions.property_id to equal the
// event's property_id. The flag-off function does not add that condition.
// cost_cents and vendor_name are not selected.
async function listResponsibilityInboxIncludingLaunchItems(
  brokerageId: number,
  userId: number,
  role: string,
): Promise<ResponsibilityInbox> {
  const generatedAt = new Date().toISOString();
  const canViewFinancials = callerCanViewFinancials(role);
  const rows = await db
    .select({
      event: pitCrewResponsibilityEvents,
      assignmentSourceType: pitCrewAssignments.sourceType,
      sourceRecordId: pitCrewAssignments.sourceRecordId,
      assignmentStatus: pitCrewAssignments.status,
      version: pitCrewAssignments.version,
      exceptionTitle: riskExceptions.title,
      requiresFinancialEntitlement: riskExceptions.requiresFinancialEntitlement,
      campaignItemId: campaignItems.id,
      campaignTitle: campaignItems.title,
      campaignPropertyId: campaignItems.propertyId,
      campaignBrokerageId: campaignItems.brokerageId,
      campaignStatus: campaignItems.status,
      propertyAddress: properties.formattedAddress,
      recipientId: responsibilityRecipientUser.id,
      recipientFirstName: responsibilityRecipientUser.firstName,
      recipientLastName: responsibilityRecipientUser.lastName,
      recipientEmail: responsibilityRecipientUser.email,
      operatorId: responsibilityOperatorUser.id,
      operatorFirstName: responsibilityOperatorUser.firstName,
      operatorLastName: responsibilityOperatorUser.lastName,
      operatorEmail: responsibilityOperatorUser.email,
    })
    .from(pitCrewResponsibilityEvents)
    .innerJoin(pitCrewAssignments, eq(pitCrewResponsibilityEvents.assignmentId, pitCrewAssignments.id))
    .leftJoin(
      riskExceptions,
      and(
        eq(pitCrewAssignments.sourceType, "EXCEPTION"),
        sql`${pitCrewAssignments.sourceRecordId} = ${riskExceptions.id}::text`,
        eq(riskExceptions.brokerageId, brokerageId),
        eq(riskExceptions.propertyId, pitCrewResponsibilityEvents.propertyId),
      ),
    )
    .leftJoin(
      campaignItems,
      and(
        eq(pitCrewAssignments.sourceType, PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE),
        sql`${pitCrewAssignments.sourceRecordId} = ${campaignItems.id}::text`,
        eq(campaignItems.brokerageId, brokerageId),
        eq(campaignItems.propertyId, pitCrewResponsibilityEvents.propertyId),
        ne(campaignItems.status, "COMPLETE"),
      ),
    )
    .innerJoin(
      properties,
      and(eq(properties.id, pitCrewResponsibilityEvents.propertyId), eq(properties.brokerageId, brokerageId)),
    )
    .leftJoin(
      responsibilityRecipientUser,
      and(eq(responsibilityRecipientUser.id, pitCrewResponsibilityEvents.recipientUserId), eq(responsibilityRecipientUser.brokerageId, brokerageId)),
    )
    .leftJoin(
      responsibilityOperatorUser,
      and(eq(responsibilityOperatorUser.id, pitCrewResponsibilityEvents.originatingUserId), eq(responsibilityOperatorUser.brokerageId, brokerageId)),
    )
    .where(
      and(
        eq(pitCrewResponsibilityEvents.brokerageId, brokerageId),
        eq(pitCrewAssignments.brokerageId, brokerageId),
        inArray(pitCrewResponsibilityEvents.status, ["OPEN", "ACKNOWLEDGED"]),
        or(eq(pitCrewResponsibilityEvents.recipientUserId, userId), eq(pitCrewResponsibilityEvents.recipientRole, role)),
        or(
          and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), isNotNull(riskExceptions.id)),
          and(
            eq(pitCrewAssignments.sourceType, PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE),
            isNotNull(campaignItems.id),
            eq(campaignItems.brokerageId, brokerageId),
            eq(campaignItems.propertyId, pitCrewResponsibilityEvents.propertyId),
            ne(campaignItems.status, "COMPLETE"),
          ),
        ),
      ),
    )
    .orderBy(
      sql`${pitCrewResponsibilityEvents.expectedResponseAt} asc nulls last`,
      asc(pitCrewResponsibilityEvents.createdAt),
      asc(pitCrewResponsibilityEvents.id),
    );

  const items = rows.flatMap((row) => {
    const launchItem = row.assignmentSourceType === PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE;
    if (launchItem) {
      // Excluded when the campaign item is missing, another brokerage, a
      // different property than the event, or COMPLETE. Same outcome as a
      // missing exception. BLOCKED stays.
      if (
        row.campaignItemId == null ||
        row.campaignBrokerageId !== brokerageId ||
        row.campaignPropertyId !== row.event.propertyId ||
        row.campaignStatus === "COMPLETE"
      ) {
        return [];
      }
      return [
        responsibilityInboxItem({
          sourceType: PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE,
          sourceRecordId: row.sourceRecordId,
          propertyAddress: row.propertyAddress,
          title: row.campaignTitle,
          assignmentStatus: row.assignmentStatus,
          version: row.version,
          event: row.event,
          recipientId: row.recipientId,
          recipientFirstName: row.recipientFirstName,
          recipientLastName: row.recipientLastName,
          recipientEmail: row.recipientEmail,
          operatorId: row.operatorId,
          operatorFirstName: row.operatorFirstName,
          operatorLastName: row.operatorLastName,
          operatorEmail: row.operatorEmail,
        }),
      ];
    }
    if (row.exceptionTitle == null || row.requiresFinancialEntitlement == null) return [];
    return [
      responsibilityInboxItem({
        sourceType: "EXCEPTION",
        sourceRecordId: row.sourceRecordId,
        propertyAddress: row.propertyAddress,
        title: listedExceptionTitle(
          { title: row.exceptionTitle, requiresFinancialEntitlement: row.requiresFinancialEntitlement },
          canViewFinancials,
        ),
        assignmentStatus: row.assignmentStatus,
        version: row.version,
        event: row.event,
        recipientId: row.recipientId,
        recipientFirstName: row.recipientFirstName,
        recipientLastName: row.recipientLastName,
        recipientEmail: row.recipientEmail,
        operatorId: row.operatorId,
        operatorFirstName: row.operatorFirstName,
        operatorLastName: row.operatorLastName,
        operatorEmail: row.operatorEmail,
      }),
    ];
  });

  return { generatedAt, items };
}

export type ResponsibilityRecipientListKind = "HAND_BACK" | "ESCALATE";

/**
 * Active users in this brokerage who can be named on a hand-back or an
 * escalation. HAND_BACK is an Agent. ESCALATE is a Brokerage Administrator.
 * The role is explicitResponsibilityRecipientRole, the same helper
 * resolveResponsibilityRecipient uses for an explicit recipientUserId.
 *
 * displayName is responsibilityUserDisplayName. The response has userId,
 * displayName, and role only: no email, phone, or other personal fields.
 * Order is displayName (case-insensitive), then userId. The list is capped
 * at RESPONSIBILITY_RECIPIENT_LIST_CAP (500) after that order.
 *
 * Refuses before reading users when the responsibility flag is not the
 * literal "true".
 */
export async function listResponsibilityRecipients(
  brokerageId: number,
  kind: ResponsibilityRecipientListKind,
): Promise<{ recipients: ResponsibilityRecipientOption[] }> {
  if (!isPitCrewResponsibilityActionsEnabled()) {
    throw new PitCrewResponsibilityDisabledError();
  }
  const role = explicitResponsibilityRecipientRole(kind === "HAND_BACK" ? "HAND_BACK" : "ESCALATION");
  const rows = await db
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
    })
    .from(users)
    .where(and(eq(users.brokerageId, brokerageId), eq(users.isActive, true), eq(users.role, role)));
  const recipients = capOrderedResponsibilityRecipients(
    rows.map((row) => ({
      userId: row.id,
      displayName: responsibilityUserDisplayName(row),
      role,
    })),
  );
  return { recipients };
}
