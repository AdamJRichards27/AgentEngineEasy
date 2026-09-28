
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

import { and, asc, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { campaignItems, db, pitCrewAssignments, properties, riskExceptions, users, type PitCrewAssignment } from "@aee/db";
import { incrementCounter } from "@aee/events";
import { logAudit } from "../audit.js";
import { isPitCrewLaunchItemSourceEnabled } from "./launchItemSource.js";
import {
  isValidPitCrewTransition,
  PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE,
  PIT_CREW_WORK_SOURCE_TYPES,
  type PitCrewItemStatus,
} from "./types.js";
import { dispatchOperationalAlert } from "../operationalAlerts.js";

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

// AE Step 2 closure — Part B dispatched TENANT_SECURITY_SIGNAL from this
// constructor. R-F10 leaves that alert here. The counter is not incremented
// here: a genuine not-found and a cross-tenant id both throw this class
// (identical 404). The miss-only existence lookups below count only the
// latter, once, with boundary "pit_crew". See
// docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
export class PitCrewPropertyMismatchError extends Error {
  constructor(message = "Property not found in this brokerage.") {
    super(message);
    this.name = "PitCrewPropertyMismatchError";
    void dispatchOperationalAlert({
      type: "TENANT_SECURITY_SIGNAL",
      summary: "Tenant-scoped Pit Crew property access was rejected",
      dedupKey: "tenant-security:pit-crew-property",
      details: { boundary: "pit_crew", recordType: "property" },
    });
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
    void dispatchOperationalAlert({
      type: "TENANT_SECURITY_SIGNAL",
      summary: "Tenant-scoped Pit Crew assignee access was rejected",
      dedupKey: "tenant-security:pit-crew-assignee",
      details: { boundary: "pit_crew", recordType: "assignee" },
    });
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

// Ops sweeps have no signed-in user. Audit still records who moved the row:
// a null user id plus a stable ops email, never a fabricated user id.
interface AuditActor {
  actorUserId: number | null;
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

// R-F10 — the pit_crew boundary of tenant_isolation_rejection_total.
// Scoped loads cannot tell a missing id from one in another brokerage.
// On a miss only, one existence lookup (never on the success path) checks
// whether the record belongs to another brokerage and, if so, increments
// once. The lookup selects no brokerage id and no other tenant's columns.
// Callers still throw the same mismatch error either way. A missing row
// does not increment, and the other brokerage's id is not logged or returned.
function notePitCrewRejection(found: { id: number | string } | undefined): void {
  if (found) incrementCounter("tenant_isolation_rejection_total", { boundary: "pit_crew" });
}

export async function notePitCrewPropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)))
    .limit(1);
  notePitCrewRejection(elsewhere);
}

async function notePitCrewWorkItemIsolationRejection(sourceRecordId: string, brokerageId: number): Promise<void> {
  if (!UUID_SHAPE.test(sourceRecordId)) return;
  const [elsewhere] = await db
    .select({ id: riskExceptions.id })
    .from(riskExceptions)
    .where(and(eq(riskExceptions.id, sourceRecordId), ne(riskExceptions.brokerageId, brokerageId)))
    .limit(1);
  notePitCrewRejection(elsewhere);
}

async function notePitCrewAssigneeIsolationRejection(userId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) return;
  const [elsewhere] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), ne(users.brokerageId, brokerageId)))
    .limit(1);
  notePitCrewRejection(elsewhere);
}

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
// touched. PIT_CREW_WORK_SOURCE_TYPES (types.ts) is the R-F21 allow-list.
// Anything outside it throws the same
// PitCrewPropertyMismatchError a missing exception throws ("Work item not
// found in this brokerage.") and does not increment
// tenant_isolation_rejection_total: there is no other-brokerage lookup for
// an unknown type. The EXCEPTION branch below is unchanged. A second
// member of PIT_CREW_WORK_SOURCE_TYPES, if one is ever added, needs its
// own branch here rather than falling through unchecked.
//
// R-F22: LAUNCH_ITEM is not a member of that list. It is accepted only
// when PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED is the literal "true", and then
// only when campaign_items has that UUID on this brokerage and this
// property. The miss uses the same 404 as a missing exception. Any other
// flag value throws that 404 and does not query campaign_items. Every
// other non-EXCEPTION source type is still rejected with that 404 and
// does not increment tenant_isolation_rejection_total.
function isKnownPitCrewWorkSourceType(sourceType: string): boolean {
  return (PIT_CREW_WORK_SOURCE_TYPES as readonly string[]).includes(sourceType);
}

async function notePitCrewLaunchItemIsolationRejection(sourceRecordId: string, brokerageId: number): Promise<void> {
  if (!UUID_SHAPE.test(sourceRecordId)) return;
  const [elsewhere] = await db
    .select({ id: campaignItems.id })
    .from(campaignItems)
    .where(and(eq(campaignItems.id, sourceRecordId), ne(campaignItems.brokerageId, brokerageId)))
    .limit(1);
  notePitCrewRejection(elsewhere);
}

async function assertLaunchItemOnPropertyInBrokerage(ref: WorkItemRef): Promise<void> {
  if (!UUID_SHAPE.test(ref.sourceRecordId)) {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
  const [item] = await db
    .select({ id: campaignItems.id })
    .from(campaignItems)
    .where(
      and(
        eq(campaignItems.id, ref.sourceRecordId),
        eq(campaignItems.brokerageId, ref.brokerageId),
        eq(campaignItems.propertyId, ref.propertyId),
      ),
    )
    .limit(1);
  if (!item) {
    await notePitCrewLaunchItemIsolationRejection(ref.sourceRecordId, ref.brokerageId);
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
}

async function assertSourceRecordOnPropertyInBrokerage(ref: WorkItemRef): Promise<void> {
  if (ref.sourceType === PIT_CREW_LAUNCH_ITEM_SOURCE_TYPE) {
    if (!isPitCrewLaunchItemSourceEnabled()) {
      throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
    }
    await assertLaunchItemOnPropertyInBrokerage(ref);
    return;
  }
  if (!isKnownPitCrewWorkSourceType(ref.sourceType)) {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
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
    await notePitCrewWorkItemIsolationRejection(ref.sourceRecordId, ref.brokerageId);
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
}

// version 0 is the sentinel PcWorkItem uses for "no overlay row exists yet"
// (see queries.ts) -- loadOrCreateOverlay makes that real: it creates the
// UNCLAIMED row (version 1) the first time anyone touches an item, and the
// caller's expectedVersion is checked against the row that actually comes
// back, so a client that believed the item was untouched (expectedVersion
// 0) correctly loses the race if someone beat it to the first touch too.
// Exported for the responsibility actions, which must reuse this brokerage
// and source-record check instead of writing a second overlay loader.
export async function loadOrCreateOverlay(ref: WorkItemRef): Promise<PitCrewAssignment> {
  // Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). ref.brokerageId is
  // trustworthy (the route layer sets it from the caller's own session), but
  // ref.propertyId is client-supplied. Without this lookup a Pit Crew member in
  // brokerage A could create/claim a pit_crew_assignments overlay row against a
  // property belonging to brokerage B simply by passing its id in the request
  // body. This mirrors the same tenant-isolation guard used elsewhere in the
  // codebase (see propertyNotes.ts, aml.ts, appraisals.ts, transactionConditions.ts).
  // R-F10 — scoped to this brokerage and selecting only the id. A miss
  // cannot tell "no such property" from another brokerage; the existence
  // lookup does, without reading the other brokerage's id.
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, ref.propertyId), eq(properties.brokerageId, ref.brokerageId)))
    .limit(1);
  if (!property) {
    await notePitCrewPropertyIsolationRejection(ref.propertyId, ref.brokerageId);
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
  actor: AuditActor,
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
// Exported for resolveResponsibilityRecipient. A miss throws
// PitCrewAssigneeMismatchError and increments the pit_crew isolation
// counter once. Callers add their own role check after this returns.
export async function assertUserInBrokerage(userId: number, brokerageId: number): Promise<void> {
  const [assignee] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.brokerageId, brokerageId)))
    .limit(1);
  if (!assignee) {
    await notePitCrewAssigneeIsolationRejection(userId, brokerageId);
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
// this item should be surfaced again if nobody actively returns it first.
// The human sweep (POST /pit-crew/ops/waiting-on/sweep) still calls
// sweepOverdueWaitingOn(), which returns WAITING_ON rows whose expected-at
// is earlier than now through the same transition as returnFromWaitingOn
// (IN_PROGRESS, waiting-on fields cleared, version bumped, audit row). A
// null expected-at is never auto-returned. The scheduled sweep does not
// call this function: it only detects and prioritises (R-F5).
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

const WAITING_ON_CLEARED = {
  waitingOnParty: null,
  waitingOnNote: null,
  waitingOnSince: null,
  waitingOnExpectedAt: null,
} as const;

async function returnWaitingOnRow(
  row: PitCrewAssignment,
  expectedVersion: number,
  actor: AuditActor,
): Promise<PitCrewAssignment> {
  return applyTransition(
    row,
    expectedVersion,
    "IN_PROGRESS",
    { ...WAITING_ON_CLEARED },
    "PC_WAITING_ON_RETURNED",
    {
      brokerageId: row.brokerageId,
      propertyId: row.propertyId,
      sourceType: row.sourceType,
      sourceRecordId: row.sourceRecordId,
    },
    actor,
  );
}

export async function returnFromWaitingOn(input: MutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay(input);
  return returnWaitingOnRow(row, input.expectedVersion, input);
}

// Stable audit identity for the ops sweep. userId stays null so the row is
// not attributed to a real Pit Crew member.
export const PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL = "ops:pit-crew-waiting-on-sweep";

const PIT_CREW_WAITING_ON_SWEEP_ACTOR: AuditActor = {
  actorUserId: null,
  actorEmail: PIT_CREW_WAITING_ON_SWEEP_ACTOR_EMAIL,
};

export interface WaitingOnSweepOptions {
  /** Clock override so tests can pin "now" without sleeping. Defaults to the current time. */
  now?: Date;
  /** When set, only this brokerage is scanned. Omitted means every brokerage. */
  brokerageId?: number;
  /**
   * Who the audit row names. When omitted, the ops identity above is used
   * so a future scheduler tick stays attributable without a signed-in user.
   * A human-triggered call passes the caller; that replaces the ops
   * identity for the rows this invocation returns.
   */
  actor?: AuditActor;
  /**
   * Invoked after a row is selected and before its return is applied.
   * Tests use this to move the row first and prove a version conflict
   * skips that row without aborting the rest of the sweep.
   */
  beforeReturn?: (row: PitCrewAssignment) => Promise<void>;
}

export interface WaitingOnSweepResult {
  /** Detector hits: WAITING_ON with a non-null expected-at strictly before now. */
  scanned: number;
  /** Rows moved WAITING_ON → IN_PROGRESS with waiting-on fields cleared. */
  returned: number;
  /** Rows left alone because a concurrent writer moved them first. */
  skipped: number;
  returnedSourceRecordIds: string[];
}

// A null expected-at is not overdue. Equality with now is not overdue either:
// the item is returned only once expected-at is strictly earlier than now.
export function isWaitingOnExpectedAtOverdue(
  status: string,
  waitingOnExpectedAt: Date | null,
  now: Date,
): boolean {
  return status === "WAITING_ON" && waitingOnExpectedAt != null && waitingOnExpectedAt.getTime() < now.getTime();
}

function overdueWaitingOnFilters(now: Date, brokerageId?: number) {
  const filters = [
    eq(pitCrewAssignments.status, "WAITING_ON"),
    isNotNull(pitCrewAssignments.waitingOnExpectedAt),
    lt(pitCrewAssignments.waitingOnExpectedAt, now),
  ];
  if (brokerageId != null) filters.push(eq(pitCrewAssignments.brokerageId, brokerageId));
  return filters;
}

async function findOverdueWaitingOnAssignments(now: Date, brokerageId?: number): Promise<PitCrewAssignment[]> {
  return db
    .select()
    .from(pitCrewAssignments)
    .where(and(...overdueWaitingOnFilters(now, brokerageId)));
}

// Read-only. Distinct brokerages that have at least one overdue WAITING_ON
// row, ascending by brokerage id, using the same filters as the sweep.
// `limit + 1` is fetched so the caller can tell a full page from a truncated one.
export async function findBrokerageIdsWithOverdueWaitingOn(
  now: Date,
  options: { limit: number; brokerageIds?: readonly number[] },
): Promise<{ brokerageIds: number[]; truncated: boolean }> {
  if (options.brokerageIds != null && options.brokerageIds.length === 0) {
    return { brokerageIds: [], truncated: false };
  }
  const overdue = and(...overdueWaitingOnFilters(now));
  const where =
    options.brokerageIds != null
      ? and(overdue, inArray(pitCrewAssignments.brokerageId, [...options.brokerageIds]))
      : overdue;
  const rows = await db
    .select({ brokerageId: pitCrewAssignments.brokerageId })
    .from(pitCrewAssignments)
    .where(where)
    .groupBy(pitCrewAssignments.brokerageId)
    .orderBy(asc(pitCrewAssignments.brokerageId))
    .limit(options.limit + 1);
  const truncated = rows.length > options.limit;
  return {
    brokerageIds: rows.slice(0, options.limit).map((row) => row.brokerageId),
    truncated,
  };
}

// Ops entry for the waiting-on expected-at sweep. Safe to call again: a row
// already returned is IN_PROGRESS and is not selected. A version mismatch
// (someone else returned or handed off the item between the read and the
// write) skips that row and continues. With no actor, the audit row uses
// the ops email above. A human-triggered caller passes actor so the
// timeline names that person instead of the ops identity.
export async function sweepOverdueWaitingOn(options: WaitingOnSweepOptions = {}): Promise<WaitingOnSweepResult> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? PIT_CREW_WAITING_ON_SWEEP_ACTOR;
  const rows = await findOverdueWaitingOnAssignments(now, options.brokerageId);
  let returned = 0;
  let skipped = 0;
  const returnedSourceRecordIds: string[] = [];

  for (const row of rows) {
    if (!isWaitingOnExpectedAtOverdue(row.status, row.waitingOnExpectedAt, now)) {
      skipped += 1;
      continue;
    }
    if (options.beforeReturn) await options.beforeReturn(row);
    try {
      await returnWaitingOnRow(row, row.version, actor);
      returned += 1;
      returnedSourceRecordIds.push(row.sourceRecordId);
    } catch (err) {
      if (err instanceof PitCrewConcurrencyError || err instanceof PitCrewTransitionError) {
        skipped += 1;
        continue;
      }
      throw err;
    }
  }

  return { scanned: rows.length, returned, skipped, returnedSourceRecordIds };
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
  await assertUserInBrokerage(input.toUserId, input.brokerageId);
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
