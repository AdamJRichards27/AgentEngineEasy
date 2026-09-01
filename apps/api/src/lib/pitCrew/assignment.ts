
// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), write model.
//
// Every mutation here follows the same shape: read-or-create the overlay
// row, validate the requested status transition (Section 9), then update
// with an optimistic-concurrency WHERE clause keyed on the version the
// caller says it last saw (Section 12: "safe concurrent assignment/
// claiming"). A zero-row update means someone else moved the item first --
// the caller gets PitCrewConcurrencyError and should refetch. Every
// successful mutation is written to the existing audit log (lib/audit.ts),
// which already feeds the Property Timeline, rather than a second history
// table -- see the comment at the top of packages/db/src/schema/pitCrew.ts.

import { eq, and } from "drizzle-orm";
import { db, pitCrewAssignments, properties, type PitCrewAssignment } from "@aee/db";
import { logAudit } from "../audit.js";
import { isValidPitCrewTransition, type PitCrewItemStatus } from "./types.js";

export class PitCrewTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PitCrewTransitionError";
  }
}

export class PitCrewConcurrencyError extends Error {
  constructor(message = "This item was changed by someone else. Refresh and try again.") {
    super(message);
    this.name = "PitCrewConcurrencyError";
  }
}

export class PitCrewPropertyMismatchError extends Error {
  constructor(message = "Property not found in this brokerage.") {
    super(message);
    this.name = "PitCrewPropertyMismatchError";
  }
}

interface WorkItemRef {
  brokerageId: number;
  propertyId: number;
  sourceType: string;
  sourceRecordId: string;
}

interface Actor {
  actorUserId: number;
  actorEmail?: string;
}

// version 0 is the sentinel PcWorkItem uses for "no overlay row exists yet"
// (see queries.ts) -- loadOrCreateOverlay makes that real: it creates the
// UNCLAIMED row (version 1) the first time anyone touches an item, and the
// caller's expectedVersion is checked against the row that actually comes
// back, so a client that believed the item was untouched (expectedVersion
// 0) correctly loses the race if someone beat it to the first touch too.
async function loadOrCreateOverlay(ref: WorkItemRef): Promise<PitCrewAssignment> {
  // Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). ref.brokerageId is
  // trustworthy (the route layer sets it from the caller's own session), but
  // ref.propertyId is client-supplied. Without this lookup a Pit Crew member in
  // brokerage A could create/claim a pit_crew_assignments overlay row against a
  // property belonging to brokerage B simply by passing its id in the request
  // body. This mirrors the same tenant-isolation guard used elsewhere in the
  // codebase (see propertyNotes.ts, aml.ts, appraisals.ts, transactionConditions.ts).
  const [property] = await db
    .select({ id: properties.id, brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, ref.propertyId))
    .limit(1);
  if (!property || property.brokerageId !== ref.brokerageId) {
    throw new PitCrewPropertyMismatchError();
  }

  const [existing] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, ref.sourceType), eq(pitCrewAssignments.sourceRecordId, ref.sourceRecordId)))
    .limit(1);
  if (existing) return existing;

  const [inserted] = await db
    .insert(pitCrewAssignments)
    .values({
      brokerageId: ref.brokerageId,
      propertyId: ref.propertyId,
      sourceType: ref.sourceType,
      sourceRecordId: ref.sourceRecordId,
      status: "UNCLAIMED",
      // Deliberately 0, not the schema column's default of 1. PcWorkItem's
      // sentinel for "no overlay row exists yet" (queries.ts) is version 0,
      // and every mutation function forwards the CALLER's expectedVersion
      // (not row.version) into applyTransition's WHERE clause below. If a
      // freshly-created row started at 1, the very first legitimate claim
      // on any never-before-touched item -- sent with expectedVersion: 0,
      // because that is what the client actually observed -- would always
      // lose the optimistic-lock check, even with no real concurrent writer.
      // Starting at 0 keeps "row didn't exist yet" and "row's version is 0"
      // the same fact, so the very first transition (0 -> 1) behaves like
      // every later one instead of being a permanent special-case failure.
      version: 0,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  // Someone else's insert won the race between our SELECT and our INSERT.
  const [raceWinner] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, ref.sourceType), eq(pitCrewAssignments.sourceRecordId, ref.sourceRecordId)))
    .limit(1);
  if (!raceWinner) throw new Error("Failed to create or load the Pit Crew assignment row.");
  return raceWinner;
}

async function applyTransition(
  row: PitCrewAssignment,
  expectedVersion: number,
  to: PitCrewItemStatus,
  patch: Partial<typeof pitCrewAssignments.$inferInsert>,
  action: string,
  ref: WorkItemRef,
  actor: Actor,
): Promise<PitCrewAssignment> {
  const from = row.status as PitCrewItemStatus;
  if (!isValidPitCrewTransition(from, to)) {
    throw new PitCrewTransitionError(`Cannot move a Pit Crew item from ${from} to ${to}.`);
  }
  const [updated] = await db
    .update(pitCrewAssignments)
    .set({ ...patch, status: to, version: row.version + 1, updatedAt: new Date() })
    .where(and(eq(pitCrewAssignments.id, row.id), eq(pitCrewAssignments.version, expectedVersion)))
    .returning();
  if (!updated) throw new PitCrewConcurrencyError();

  await logAudit({
    userId: actor.actorUserId,
    userEmail: actor.actorEmail,
    action,
    recordType: ref.sourceType,
    recordId: ref.sourceRecordId,
    propertyId: ref.propertyId,
    previousValue: from,
    updatedValue: to,
  });
  return updated;
}

export interface MutationInput extends WorkItemRef, Actor {
  expectedVersion: number;
}

export async function claimWorkItem(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(
    row,
    input.expectedVersion,
    "CLAIMED",
    { assignedToUserId: input.actorUserId, claimedAt: new Date() },
    "PC_CLAIMED",
    input,
    input,
  );
}

// A team lead (or another Pit Crew member) assigning an unclaimed item to a
// specific person, distinct from that person claiming it themselves --
// same CLAIMED destination, different actor recorded as the claimant.
export async function assignWorkItem(
  input: MutationInput & { assigneeUserId: number },
): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(
    row,
    input.expectedVersion,
    "CLAIMED",
    { assignedToUserId: input.assigneeUserId, claimedAt: new Date() },
    "PC_ASSIGNED",
    input,
    input,
  );
}

export async function startProgress(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(row, input.expectedVersion, "IN_PROGRESS", {}, "PC_STATUS_CHANGED", input, input);
}

// Section 14: active Waiting-On management. waitingOnExpectedAt is when
// this item should be surfaced again if nobody actively returns it first --
// the frontend/ops job that auto-returns overdue waiting-on items reads
// this field rather than inventing a second expiry mechanism.
export async function setWaitingOn(
  input: MutationInput & { waitingOnParty: string; waitingOnNote?: string; waitingOnExpectedAt?: Date },
): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(
    row,
    input.expectedVersion,
    "WAITING_ON",
    {
      waitingOnParty: input.waitingOnParty,
      waitingOnNote: input.waitingOnNote ?? null,
      waitingOnSince: new Date(),
      waitingOnExpectedAt: input.waitingOnExpectedAt ?? null,
    },
    "PC_WAITING_ON_SET",
    input,
    input,
  );
}

export async function returnFromWaitingOn(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(
    row,
    input.expectedVersion,
    "IN_PROGRESS",
    { waitingOnParty: null, waitingOnNote: null, waitingOnSince: null, waitingOnExpectedAt: null },
    "PC_WAITING_ON_RETURNED",
    input,
    input,
  );
}

export async function completeWorkItem(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(row, input.expectedVersion, "DONE", { completedAt: new Date() }, "PC_COMPLETED", input, input);
}

export async function releaseWorkItem(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return applyTransition(
    row,
    input.expectedVersion,
    "UNCLAIMED",
    { assignedToUserId: null, claimedAt: null, waitingOnParty: null, waitingOnNote: null, waitingOnSince: null, waitingOnExpectedAt: null },
    "PC_RELEASED",
    input,
    input,
  );
}

// Section 13: PC-to-PC handoff. Keeps the item CLAIMED (work continues, now
// under a new owner) rather than round-tripping through UNCLAIMED, so it
// never briefly appears in Unassigned Work mid-handoff.
export async function handoffWorkItem(
  input: MutationInput & { toUserId: number; note?: string },
): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  const from = row.status as PitCrewItemStatus;
  if (from !== "CLAIMED" && from !== "IN_PROGRESS" && from !== "WAITING_ON") {
    throw new PitCrewTransitionError(`Cannot hand off a Pit Crew item in status ${from}.`);
  }
  const [updated] = await db
    .update(pitCrewAssignments)
    .set({
      assignedToUserId: input.toUserId,
      handoffFromUserId: row.assignedToUserId,
      handoffToUserId: input.toUserId,
      handoffNote: input.note ?? null,
      handoffAt: new Date(),
      version: row.version + 1,
      updatedAt: new Date(),
    })
    .where(and(eq(pitCrewAssignments.id, row.id), eq(pitCrewAssignments.version, input.expectedVersion)))
    .returning();
  if (!updated) throw new PitCrewConcurrencyError();

  await logAudit({
    userId: input.actorUserId,
    userEmail: input.actorEmail,
    action: "PC_HANDOFF",
    recordType: input.sourceType,
    recordId: input.sourceRecordId,
    propertyId: input.propertyId,
    previousValue: row.assignedToUserId != null ? String(row.assignedToUserId) : undefined,
    updatedValue: String(input.toUserId),
  });
  return updated;
}
