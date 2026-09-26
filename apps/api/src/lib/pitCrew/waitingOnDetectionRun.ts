// R-F5 scheduled detection. Reads overdue WAITING_ON rows, classifies them,
// and (when recording) writes a sighting fingerprint so an unchanged item
// is not alerted again. Assignment, exception, and transaction rows are
// not updated. Nothing here sends mail, SMS, or an operational webhook.

import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { logger } from "@aee/events";
import {
  db,
  pitCrewAssignments,
  pitCrewWaitingOnSweepSightings,
  riskExceptions,
  transactions,
} from "@aee/db";
import {
  classifyWaitingOnCandidate,
  compareWaitingOnDetections,
  isMaterialWaitingOnDetectionChange,
  isWithinOperatingWindow,
  type ClassifiedWaitingOnItem,
  type ResolvedPitCrewWaitingOnSweepSettings,
} from "./waitingOnDetection.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OverdueWaitingOnCandidate {
  brokerageId: number;
  assignmentId: number;
  sourceType: string;
  sourceRecordId: string;
  propertyId: number;
  status: string;
  assignedToUserId: number | null;
  waitingOnExpectedAt: Date | null;
  waitingOnSince: Date | null;
  exceptionCategory: string | null;
  exceptionDueAt: Date | null;
  exceptionEscalatesAt: Date | null;
  settlementDate: Date | null;
}

export interface WaitingOnDetectionList {
  generatedAt: string;
  brokerageId: number;
  withinOperatingWindow: boolean;
  attentionThresholdHours: number;
  elevatedThresholdHours: number;
  timeZone: string;
  items: ClassifiedWaitingOnItem[];
}

export interface WaitingOnDetectionRecordResult {
  scanned: number;
  surfaced: number;
  deduped: number;
  items: ClassifiedWaitingOnItem[];
}

function earliestDate(dates: Date[]): Date | null {
  if (dates.length === 0) return null;
  return dates.reduce((soonest, candidate) => (candidate.getTime() < soonest.getTime() ? candidate : soonest));
}

/** Read-only. Overdue means WAITING_ON and waitingOnExpectedAt strictly before now. */
export async function loadOverdueWaitingOnCandidates(brokerageId: number, now: Date): Promise<OverdueWaitingOnCandidate[]> {
  const assignments = await db
    .select()
    .from(pitCrewAssignments)
    .where(
      and(
        eq(pitCrewAssignments.brokerageId, brokerageId),
        eq(pitCrewAssignments.status, "WAITING_ON"),
        isNotNull(pitCrewAssignments.waitingOnExpectedAt),
        lt(pitCrewAssignments.waitingOnExpectedAt, now),
      ),
    );
  if (assignments.length === 0) return [];

  const exceptionIds = assignments
    .filter((row) => row.sourceType === "EXCEPTION" && UUID_RE.test(row.sourceRecordId))
    .map((row) => row.sourceRecordId);
  const exceptionRows = exceptionIds.length
    ? await db
        .select({
          id: riskExceptions.id,
          category: riskExceptions.category,
          dueAt: riskExceptions.dueAt,
          escalatesAt: riskExceptions.escalatesAt,
        })
        .from(riskExceptions)
        .where(and(eq(riskExceptions.brokerageId, brokerageId), inArray(riskExceptions.id, exceptionIds)))
    : [];
  const exceptionById = new Map(exceptionRows.map((row) => [row.id, row]));

  const propertyIds = [...new Set(assignments.map((row) => row.propertyId))];
  const settlementRows = await db
    .select({
      propertyId: transactions.propertyId,
      settlementDate: transactions.settlementDate,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.propertyId, propertyIds),
        isNull(transactions.settlementCompletedAt),
        isNotNull(transactions.settlementDate),
      ),
    );
  const settlementByProperty = new Map<number, Date[]>();
  for (const row of settlementRows) {
    if (row.settlementDate == null) continue;
    const list = settlementByProperty.get(row.propertyId) ?? [];
    list.push(row.settlementDate);
    settlementByProperty.set(row.propertyId, list);
  }

  return assignments.map((row) => {
    const exception = row.sourceType === "EXCEPTION" ? exceptionById.get(row.sourceRecordId) : undefined;
    return {
      brokerageId: row.brokerageId,
      assignmentId: row.id,
      sourceType: row.sourceType,
      sourceRecordId: row.sourceRecordId,
      propertyId: row.propertyId,
      status: row.status,
      assignedToUserId: row.assignedToUserId,
      waitingOnExpectedAt: row.waitingOnExpectedAt,
      waitingOnSince: row.waitingOnSince,
      exceptionCategory: exception?.category ?? null,
      exceptionDueAt: exception?.dueAt ?? null,
      exceptionEscalatesAt: exception?.escalatesAt ?? null,
      settlementDate: earliestDate(settlementByProperty.get(row.propertyId) ?? []),
    };
  });
}

export function classifyOverdueWaitingOn(
  candidates: readonly OverdueWaitingOnCandidate[],
  settings: ResolvedPitCrewWaitingOnSweepSettings,
  now: Date,
): ClassifiedWaitingOnItem[] {
  const items: ClassifiedWaitingOnItem[] = [];
  for (const candidate of candidates) {
    const classified = classifyWaitingOnCandidate({
      ...candidate,
      now,
      thresholds: {
        attentionThresholdHours: settings.attentionThresholdHours,
        elevatedThresholdHours: settings.elevatedThresholdHours,
      },
      timeZone: settings.timeZone,
    });
    if (classified) items.push(classified);
  }
  items.sort(compareWaitingOnDetections);
  return items;
}

/** Read API. Does not write sightings, settings, assignments, exceptions, or transactions. */
export async function listOverdueWaitingOnDetections(options: {
  brokerageId: number;
  now?: Date;
  settings: ResolvedPitCrewWaitingOnSweepSettings;
}): Promise<WaitingOnDetectionList> {
  const now = options.now ?? new Date();
  const candidates = await loadOverdueWaitingOnCandidates(options.brokerageId, now);
  return {
    generatedAt: now.toISOString(),
    brokerageId: options.brokerageId,
    withinOperatingWindow: isWithinOperatingWindow(now, options.settings),
    attentionThresholdHours: options.settings.attentionThresholdHours,
    elevatedThresholdHours: options.settings.elevatedThresholdHours,
    timeZone: options.settings.timeZone,
    items: classifyOverdueWaitingOn(candidates, options.settings, now),
  };
}

/**
 * Scheduled surfacing. Writes sighting rows only when the fingerprint
 * changed. Logs one internal line per newly surfaced item. No external send.
 */
export async function recordWaitingOnDetections(options: {
  brokerageId: number;
  now: Date;
  settings: ResolvedPitCrewWaitingOnSweepSettings;
}): Promise<WaitingOnDetectionRecordResult> {
  const candidates = await loadOverdueWaitingOnCandidates(options.brokerageId, options.now);
  const items = classifyOverdueWaitingOn(candidates, options.settings, options.now);
  if (items.length === 0) return { scanned: 0, surfaced: 0, deduped: 0, items };

  const existing = await db
    .select({
      assignmentId: pitCrewWaitingOnSweepSightings.assignmentId,
      fingerprint: pitCrewWaitingOnSweepSightings.fingerprint,
    })
    .from(pitCrewWaitingOnSweepSightings)
    .where(
      inArray(
        pitCrewWaitingOnSweepSightings.assignmentId,
        items.map((item) => item.assignmentId),
      ),
    );
  const previousByAssignment = new Map(existing.map((row) => [row.assignmentId, row.fingerprint]));

  let surfaced = 0;
  let deduped = 0;
  for (const item of items) {
    const previous = previousByAssignment.get(item.assignmentId) ?? null;
    if (!isMaterialWaitingOnDetectionChange(previous, item.fingerprint)) {
      deduped += 1;
      continue;
    }
    await db
      .insert(pitCrewWaitingOnSweepSightings)
      .values({
        brokerageId: item.brokerageId,
        assignmentId: item.assignmentId,
        fingerprint: item.fingerprint,
        tier: item.tier,
        priorityException: item.priorityException,
        surfacedAt: options.now,
        updatedAt: options.now,
      })
      .onConflictDoUpdate({
        target: pitCrewWaitingOnSweepSightings.assignmentId,
        set: {
          brokerageId: item.brokerageId,
          fingerprint: item.fingerprint,
          tier: item.tier,
          priorityException: item.priorityException,
          surfacedAt: options.now,
          updatedAt: options.now,
        },
      });
    surfaced += 1;
    logger.info("pit_crew_waiting_on_detected", {
      brokerageId: item.brokerageId,
      assignmentId: item.assignmentId,
      sourceType: item.sourceType,
      sourceRecordId: item.sourceRecordId,
      propertyId: item.propertyId,
      tier: item.tier,
      priorityException: item.priorityException,
      priorityReasons: item.priorityReasons,
      hoursOverdue: item.hoursOverdue,
      waitingOnExpectedAt: item.waitingOnExpectedAt,
      assignedToUserId: item.assignedToUserId,
    });
  }

  return { scanned: items.length, surfaced, deduped, items };
}
