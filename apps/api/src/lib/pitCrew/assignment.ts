
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
import { db, pitCrewAssignments, properties, riskExceptions, users, type PitCrewAssignment } from "@aee/db";
import { incrementCounter } from "@aee/events";
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

// AE Step 2 closure — Part B: incrementing tenant_isolation_rejection_total
// at the shared constructor these two error classes' throw sites all use
// (rather than at each individual call site) — see
// docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
export class PitCrewPropertyMismatchError extends Error {
  constructor(message = "Property not found in this brokerage.") {
    super(message);
    this.name = "PitCrewPropertyMismatchError";
    incrementCounter("tenant_isolation_rejection_total", { boundary: "pit_crew" });
  }
}

// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), STEP 2 security
// hardening: a client-supplied assigneeUserId (assignWorkItem) that
// doesn't belong to the caller's own brokerage. Same "not found" posture
// as PitCrewPropertyMismatchError -- a userId from another brokerage
// reads identically to one that doesn't exist.
export class PitCrewAssigneeMismatchError extends Error {
  constructor(message = "Assignee not found in this brokerage.") {
    super(message);
    this.name = "PitCrewAssigneeMismatchError";
    incrementCounter("tenant_isolation_rejection_total", { boundary: "pit_crew" });
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

// Loose UUID-shape guard, used only to short-circuit
// assertSourceRecordOnPropertyInBrokerage below before it ever reaches the
// database. risk_exceptions.id is a native Postgres uuid column, so
// handing a non-UUID-shaped string to `eq(riskExceptions.id, ...)` doesn't
// just fail to match a row -- it makes the driver throw an "invalid input
// syntax for type uuid" error, which would surface as an unhandled 500
// instead of the same PitCrewPropertyMismatchError every other kind of
// mismatch produces here. Checking the shape first keeps a malformed
// sourceRecordId behaving exactly like a well-formed one that simply isn't
// found -- never a different, more revealing failure mode.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), STEP 2 security
// hardening (cross-tenant IDOR fix). ref.propertyId is already checked
// against ref.brokerageId by loadOrCreateOverlay below, but
// ref.sourceRecordId is ALSO client-supplied -- it comes straight off the
// URL (see routes/pitCrew.ts's itemParamsSchema) -- and was never checked
// against either of them. Without this, a caller in brokerage A could
// supply one of ITS OWN valid propertyIds alongside ANY exception UUID,
// including one it guessed or enumerated that actually belongs to
// brokerage B, and loadOrCreateOverlay would happily create/load a
// pit_crew_assignments overlay row keyed only on (sourceType,
// sourceRecordId) -- stamped with brokerage A's own brokerageId/
// propertyId, never brokerage B's. Because queries.ts's
// getPitCrewWorkspace later joins that overlay back onto the CALLER's own
// real exceptions by sourceRecordId alone (no brokerageId filter on the
// overlay side), a forged row like that lands directly on brokerage B's
// own workspace the next time B loads it, the moment B's real exception id
// happens to be the UUID A guessed. This closes that gap by requiring
// sourceRecordId to name a real exception that belongs to BOTH
// ref.propertyId AND ref.brokerageId before any overlay row is ever
// touched. PIT_CREW_WORK_SOURCE_TYPES (types.ts) currently has exactly one
// member, "EXCEPTION" -- this check is scoped to that; a second source
// type, if one is ever added, needs its own branch here rather than
// silently falling through unchecked.
async function assertSourceRecordOnPropertyInBrokerage(ref: WorkItemRef): Promise<void> {
  if (ref.sourceType !== "EXCEPTION") return;
  if (!UUID_SHAPE.test(ref.sourceRecordId)) {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
  const [exception] = await db
    .select({ id: riskExceptions.id })
    .from(riskExceptions)
    .where(
      and(
        eq(riskExceptions.id, ref.sourceRecordId),
        eq(riskExceptions.brokerageId, ref.brokerageId),
        eq(riskExceptions.propertyId, ref.propertyId),
      ),
    )
    .limit(1);
  if (!exception) {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
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

  // See assertSourceRecordOnPropertyInBrokerage's own doc comment above --
  // this is the second half of the tenant-isolation check this function
  // needs before it ever touches pit_crew_assignments: the property check
  // above proves ref.propertyId is really brokerage A's, but says nothing
  // about whether ref.sourceRecordId is too.
  await assertSourceRecordOnPropertyInBrokerage(ref);

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

// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), STEP 2 security
// hardening. input.assigneeUserId (assignWorkItem, below) is client-
// supplied and was never checked against input.brokerageId before being
// written to pit_crew_assignments.assignedToUserId -- a caller could name
// a userId belonging to a different brokerage entirely (or one that
// doesn't exist) and have it recorded as the claimant. Same lookup shape
// as the payment-method ownership checks in routes/payments.ts: the
// candidate id and the caller's own brokerageId are checked together in
// one query, never as two separate facts assembled after the fact.
async function assertUserInBrokerage(userId: number, brokerageId: number): Promise<void> {
  const [assignee] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.brokerageId, brokerageId)))
    .limit(1);
  if (!assignee) {
    throw new PitCrewAssigneeMismatchError();
  }
}

// A team lead (or another Pit Crew member) assigning an unclaimed item to a
// specific person, distinct from that person claiming it themselves --
// same CLAIMED destination, different actor recorded as the claimant.
export async function assignWorkItem(
  input: MutationInput & { assigneeUserId: number },
): Promise<PitCrewAssignment> {
  await assertUserInBrokerage(input.assigneeUserId, input.brokerageId);
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
