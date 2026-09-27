// R-F15 — Pit Crew hand-back and escalate.
//
// Library and state machine only. Routes are a later slice. Every public
// function refuses while PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED is not the
// literal string "true", and that refusal happens before any read or write
// of pit_crew_responsibility_events.
//
// Each mutation is one db.transaction: the event insert or update, the
// assignment update guarded by expectedVersion, and logAudit with strict
// true bound to that same transaction. A zero-row assignment update throws
// PitCrewConcurrencyError and rolls the event back.

import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  db,
  pitCrewAssignments,
  pitCrewResponsibilityEvents,
  properties,
  users,
  PIT_CREW_ESCALATION_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_SEVERITIES,
  PIT_CREW_HAND_BACK_REASON_CATEGORIES,
  type PitCrewAssignment,
  type PitCrewEscalationReasonCategory,
  type PitCrewEscalationSeverity,
  type PitCrewHandBackReasonCategory,
  type PitCrewResponsibilityEvent,
  type PitCrewResponsibilityRecipientRole,
} from "@aee/db";
import { logAudit, type AuditLogInput } from "../audit.js";
import {
  assertUserInBrokerage,
  loadOrCreateOverlay,
  PitCrewConcurrencyError,
  PitCrewPropertyMismatchError,
  PitCrewTransitionError,
} from "./assignment.js";
import { isValidPitCrewTransition, type PitCrewItemStatus } from "./types.js";

export const PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG = "PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED";

/**
 * Enabled only for the literal string "true". Missing, empty, "TRUE", "1",
 * and "yes" stay off. Default off.
 */
export function isPitCrewResponsibilityActionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] === "true";
}

/** Route slice maps this to 404 { "error": "Not found." }. */
export class PitCrewResponsibilityDisabledError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "PitCrewResponsibilityDisabledError";
  }
}

/** Missing open hand-back or escalation. Route slice maps this to 404. */
export class PitCrewResponsibilityNotFoundError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "PitCrewResponsibilityNotFoundError";
  }
}

/** Caller is not the named recipient and not an active Brokerage Administrator for a role recipient. */
export class PitCrewResponsibilityForbiddenError extends Error {
  constructor(message = "Not allowed to act on this responsibility event.") {
    super(message);
    this.name = "PitCrewResponsibilityForbiddenError";
  }
}

/** Reason, severity, note, next action, or recipient role failed application validation. */
export class PitCrewResponsibilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PitCrewResponsibilityValidationError";
  }
}

export interface ResponsibilityMutationInput {
  brokerageId: number;
  propertyId: number;
  sourceType: string;
  sourceRecordId: string;
  expectedVersion: number;
  actorUserId: number;
  actorEmail?: string;
}

export interface HandBackInput extends ResponsibilityMutationInput {
  reasonCategory: string;
  note?: string | null;
  recipientUserId?: number | null;
  nextAction: string;
}

export interface EscalateInput extends ResponsibilityMutationInput {
  reasonCategory: string;
  severity: string;
  note: string;
  nextAction: string;
  recipientUserId?: number | null;
  expectedResponseAt?: Date | null;
}

export interface AcknowledgeEscalationInput extends ResponsibilityMutationInput {
  note?: string | null;
}

export interface CloseEscalationInput extends ResponsibilityMutationInput {
  note: string;
}

export interface ResolvedResponsibilityRecipient {
  recipientUserId: number | null;
  recipientRole: PitCrewResponsibilityRecipientRole | null;
  /** Null until a later migration adds pit_crew_escalation_routing_rules. */
  routingRuleId: null;
}

export interface ResponsibilityMutationResult {
  assignment: PitCrewAssignment;
  responsibilityEvent: PitCrewResponsibilityEvent;
}

type ResponsibilityTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const WAITING_ON_CLEARED = {
  waitingOnParty: null,
  waitingOnNote: null,
  waitingOnSince: null,
  waitingOnExpectedAt: null,
} as const;

const ACTIVE_FROM = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

function assertResponsibilityActionsEnabled(): void {
  if (!isPitCrewResponsibilityActionsEnabled()) {
    throw new PitCrewResponsibilityDisabledError();
  }
}

function assertExceptionSource(sourceType: string): void {
  if (sourceType !== "EXCEPTION") {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
}

function assertIncluded<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new PitCrewResponsibilityValidationError(`${label} is not an allowed value.`);
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PitCrewResponsibilityValidationError(`${label} is required.`);
  }
  return value.trim();
}

function optionalNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertTransition(from: string, to: PitCrewItemStatus): void {
  if (!isValidPitCrewTransition(from as PitCrewItemStatus, to)) {
    throw new PitCrewTransitionError(`Cannot move a Pit Crew item from ${from} to ${to}.`);
  }
}

function assertStatus(row: PitCrewAssignment, allowed: readonly string[], action: string): void {
  if (!(allowed as readonly string[]).includes(row.status)) {
    throw new PitCrewTransitionError(`Cannot ${action} a Pit Crew item in status ${row.status}.`);
  }
}

function isUniqueViolation(err: unknown): boolean {
  const wrapped = err as { code?: string; cause?: { code?: string } };
  return wrapped.code === "23505" || wrapped.cause?.code === "23505";
}

async function loadBrokerageUser(
  userId: number,
  brokerageId: number,
): Promise<{ id: number; role: string; isActive: boolean } | undefined> {
  const [user] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.brokerageId, brokerageId)))
    .limit(1);
  return user;
}

async function assertActiveRole(userId: number, brokerageId: number, role: "Agent" | "Brokerage Administrator"): Promise<void> {
  const user = await loadBrokerageUser(userId, brokerageId);
  const label = role === "Agent" ? "an active Agent" : "an active Brokerage Administrator";
  if (!user || user.role !== role || !user.isActive) {
    throw new PitCrewResponsibilityValidationError(`Recipient must be ${label} in this brokerage.`);
  }
}

/**
 * Recipient order, unchanged when a later rules table is added inside this
 * function:
 * 1. Explicit recipientUserId, after assertUserInBrokerage. Hand-back
 *    requires an active Agent. Escalation requires an active Brokerage
 *    Administrator.
 * 2. An enabled routing rule for this brokerage and reason. v1 has no
 *    rules table, so this step is absent.
 * 3. Hand-back defaults to properties.agent_id. Escalation defaults to
 *    recipient_role Brokerage Administrator and a null user id.
 * Exactly one of recipientUserId and recipientRole is set. routingRuleId
 * stays null until the later column exists.
 */
export async function resolveResponsibilityRecipient(input: {
  kind: "HAND_BACK" | "ESCALATION";
  brokerageId: number;
  propertyId: number;
  recipientUserId?: number | null;
}): Promise<ResolvedResponsibilityRecipient> {
  assertResponsibilityActionsEnabled();

  if (input.recipientUserId != null) {
    await assertUserInBrokerage(input.recipientUserId, input.brokerageId);
    if (input.kind === "HAND_BACK") {
      await assertActiveRole(input.recipientUserId, input.brokerageId, "Agent");
    } else {
      await assertActiveRole(input.recipientUserId, input.brokerageId, "Brokerage Administrator");
    }
    return { recipientUserId: input.recipientUserId, recipientRole: null, routingRuleId: null };
  }

  if (input.kind === "HAND_BACK") {
    const [property] = await db
      .select({ agentId: properties.agentId })
      .from(properties)
      .where(and(eq(properties.id, input.propertyId), eq(properties.brokerageId, input.brokerageId)))
      .limit(1);
    if (!property) throw new PitCrewPropertyMismatchError();
    await assertUserInBrokerage(property.agentId, input.brokerageId);
    await assertActiveRole(property.agentId, input.brokerageId, "Agent");
    return { recipientUserId: property.agentId, recipientRole: null, routingRuleId: null };
  }

  return { recipientUserId: null, recipientRole: "Brokerage Administrator", routingRuleId: null };
}

async function loadOwnedOverlay(input: ResponsibilityMutationInput): Promise<PitCrewAssignment> {
  const row = await loadOrCreateOverlay({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    sourceType: input.sourceType,
    sourceRecordId: input.sourceRecordId,
  });
  if (
    row.brokerageId !== input.brokerageId ||
    row.propertyId !== input.propertyId ||
    row.sourceType !== input.sourceType ||
    row.sourceRecordId !== input.sourceRecordId
  ) {
    throw new PitCrewPropertyMismatchError("Work item not found in this brokerage.");
  }
  return row;
}

async function loadOpenEvent(
  assignmentId: number,
  brokerageId: number,
  kind: "HAND_BACK" | "ESCALATION",
): Promise<PitCrewResponsibilityEvent> {
  const [event] = await db
    .select()
    .from(pitCrewResponsibilityEvents)
    .where(
      and(
        eq(pitCrewResponsibilityEvents.assignmentId, assignmentId),
        eq(pitCrewResponsibilityEvents.brokerageId, brokerageId),
        eq(pitCrewResponsibilityEvents.kind, kind),
        inArray(pitCrewResponsibilityEvents.status, ["OPEN", "ACKNOWLEDGED"]),
      ),
    )
    .limit(1);
  if (!event) throw new PitCrewResponsibilityNotFoundError();
  return event;
}

/**
 * Named recipient, or any active Brokerage Administrator when the event
 * is addressed to that role. The originator cannot act unless they are
 * an active Brokerage Administrator, and a Brokerage Administrator who
 * is the originator still has to match the recipient rule.
 */
async function assertEscalationResponder(
  event: PitCrewResponsibilityEvent,
  actorUserId: number,
  brokerageId: number,
): Promise<void> {
  const actor = await loadBrokerageUser(actorUserId, brokerageId);
  if (!actor) throw new PitCrewResponsibilityForbiddenError();
  const isActiveAdministrator = actor.role === "Brokerage Administrator" && actor.isActive;
  if (actorUserId === event.originatingUserId && !isActiveAdministrator) {
    throw new PitCrewResponsibilityForbiddenError();
  }
  if (event.recipientUserId != null && event.recipientUserId === actorUserId) return;
  if (event.recipientRole === "Brokerage Administrator" && isActiveAdministrator) return;
  throw new PitCrewResponsibilityForbiddenError();
}

interface CommitInput {
  row: PitCrewAssignment;
  input: ResponsibilityMutationInput;
  assignmentPatch: Partial<typeof pitCrewAssignments.$inferInsert>;
  auditAction: string;
  previousValue: string;
  updatedValue: string;
  // audit_logs has no metadata column. Close writes the closing note here
  // as JSON so previousValue and updatedValue stay the status pair.
  providerReference?: string;
  event:
    | { mode: "insert"; values: typeof pitCrewResponsibilityEvents.$inferInsert }
    | {
        mode: "update";
        eventId: number;
        fromStatuses: string[];
        values: Partial<typeof pitCrewResponsibilityEvents.$inferInsert>;
      };
}

async function commitResponsibility(commit: CommitInput): Promise<ResponsibilityMutationResult> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const event = await writeEvent(tx, commit, now);
    const [updated] = await tx
      .update(pitCrewAssignments)
      .set({ ...commit.assignmentPatch, version: commit.row.version + 1, updatedAt: now })
      .where(and(eq(pitCrewAssignments.id, commit.row.id), eq(pitCrewAssignments.version, commit.input.expectedVersion)))
      .returning();
    if (!updated) throw new PitCrewConcurrencyError();

    const audit: AuditLogInput = {
      brokerageId: commit.input.brokerageId,
      userId: commit.input.actorUserId,
      userEmail: commit.input.actorEmail,
      action: commit.auditAction,
      recordType: commit.input.sourceType,
      recordId: commit.input.sourceRecordId,
      propertyId: commit.input.propertyId,
      previousValue: commit.previousValue,
      updatedValue: commit.updatedValue,
      providerReference: commit.providerReference,
    };
    await logAudit(audit, {
      strict: true,
      write: async (entry) => {
        await tx.insert(auditLogs).values(entry);
      },
    });
    return { assignment: updated, responsibilityEvent: event };
  });
}

async function writeEvent(tx: ResponsibilityTx, commit: CommitInput, now: Date): Promise<PitCrewResponsibilityEvent> {
  if (commit.event.mode === "insert") {
    try {
      const [inserted] = await tx.insert(pitCrewResponsibilityEvents).values(commit.event.values).returning();
      if (!inserted) throw new Error("Failed to record the Pit Crew responsibility event.");
      return inserted;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new PitCrewTransitionError("This item already has an open responsibility event.");
      }
      throw err;
    }
  }

  const [updated] = await tx
    .update(pitCrewResponsibilityEvents)
    .set({ ...commit.event.values, updatedAt: now })
    .where(
      and(
        eq(pitCrewResponsibilityEvents.id, commit.event.eventId),
        eq(pitCrewResponsibilityEvents.brokerageId, commit.input.brokerageId),
        eq(pitCrewResponsibilityEvents.assignmentId, commit.row.id),
        inArray(pitCrewResponsibilityEvents.status, commit.event.fromStatuses),
      ),
    )
    .returning();
  if (!updated) throw new PitCrewConcurrencyError();
  return updated;
}

export async function handBackWorkItem(input: HandBackInput): Promise<ResponsibilityMutationResult> {
  assertResponsibilityActionsEnabled();
  assertExceptionSource(input.sourceType);
  const reasonCategory: PitCrewHandBackReasonCategory = assertIncluded(
    input.reasonCategory,
    PIT_CREW_HAND_BACK_REASON_CATEGORIES,
    "reasonCategory",
  );
  const nextAction = requireText(input.nextAction, "nextAction");
  const note = optionalNote(input.note);

  const row = await loadOwnedOverlay(input);
  const recipient = await resolveResponsibilityRecipient({
    kind: "HAND_BACK",
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    recipientUserId: input.recipientUserId,
  });
  assertStatus(row, ACTIVE_FROM, "hand back");
  assertTransition(row.status, "HANDED_BACK");
  if (recipient.recipientUserId == null) {
    throw new PitCrewResponsibilityValidationError("Recipient must be an active Agent in this brokerage.");
  }

  return commitResponsibility({
    row,
    input,
    assignmentPatch: {
      status: "HANDED_BACK",
      assignedToUserId: null,
      claimedAt: null,
      ...WAITING_ON_CLEARED,
    },
    auditAction: "PC_HANDED_BACK",
    previousValue: row.status,
    updatedValue: "HANDED_BACK",
    event: {
      mode: "insert",
      values: {
        brokerageId: row.brokerageId,
        assignmentId: row.id,
        propertyId: row.propertyId,
        kind: "HAND_BACK",
        reasonCategory,
        severity: null,
        note,
        nextAction,
        originatingUserId: input.actorUserId,
        recipientUserId: recipient.recipientUserId,
        recipientRole: null,
        resultingResponsibility: "AGENT",
        expectedResponseAt: null,
        status: "OPEN",
      },
    },
  });
}

function requireExpectedResponseAt(severity: PitCrewEscalationSeverity, value: Date | null | undefined): Date | null {
  const required = severity === "AT_RISK" || severity === "CRITICAL";
  if (value == null) {
    if (required) {
      throw new PitCrewResponsibilityValidationError("expectedResponseAt is required when severity is AT_RISK or CRITICAL.");
    }
    return null;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new PitCrewResponsibilityValidationError("expectedResponseAt must be a valid date.");
  }
  return value;
}

export async function escalateWorkItem(input: EscalateInput): Promise<ResponsibilityMutationResult> {
  assertResponsibilityActionsEnabled();
  assertExceptionSource(input.sourceType);
  const reasonCategory: PitCrewEscalationReasonCategory = assertIncluded(
    input.reasonCategory,
    PIT_CREW_ESCALATION_REASON_CATEGORIES,
    "reasonCategory",
  );
  const severity: PitCrewEscalationSeverity = assertIncluded(input.severity, PIT_CREW_ESCALATION_SEVERITIES, "severity");
  const note = requireText(input.note, "note");
  const nextAction = requireText(input.nextAction, "nextAction");
  const expectedResponseAt = requireExpectedResponseAt(severity, input.expectedResponseAt);

  const row = await loadOwnedOverlay(input);
  const recipient = await resolveResponsibilityRecipient({
    kind: "ESCALATION",
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    recipientUserId: input.recipientUserId,
  });
  assertStatus(row, ACTIVE_FROM, "escalate");
  assertTransition(row.status, "ESCALATED");

  return commitResponsibility({
    row,
    input,
    assignmentPatch: {
      status: "ESCALATED",
      assignedToUserId: input.actorUserId,
      ...WAITING_ON_CLEARED,
    },
    auditAction: "PC_ESCALATED",
    previousValue: row.status,
    updatedValue: "ESCALATED",
    event: {
      mode: "insert",
      values: {
        brokerageId: row.brokerageId,
        assignmentId: row.id,
        propertyId: row.propertyId,
        kind: "ESCALATION",
        reasonCategory,
        severity,
        note,
        nextAction,
        originatingUserId: input.actorUserId,
        recipientUserId: recipient.recipientUserId,
        recipientRole: recipient.recipientRole,
        resultingResponsibility: "BROKERAGE_ADMINISTRATOR",
        expectedResponseAt,
        status: "OPEN",
      },
    },
  });
}

export async function acknowledgeEscalation(input: AcknowledgeEscalationInput): Promise<ResponsibilityMutationResult> {
  assertResponsibilityActionsEnabled();
  assertExceptionSource(input.sourceType);
  const row = await loadOwnedOverlay(input);
  assertStatus(row, ["ESCALATED"], "acknowledge");
  const event = await loadOpenEvent(row.id, input.brokerageId, "ESCALATION");
  if (event.status !== "OPEN") {
    throw new PitCrewTransitionError(`Cannot acknowledge an escalation in status ${event.status}.`);
  }
  await assertEscalationResponder(event, input.actorUserId, input.brokerageId);
  const now = new Date();

  return commitResponsibility({
    row,
    input,
    assignmentPatch: {},
    auditAction: "PC_ESCALATION_ACKNOWLEDGED",
    previousValue: "OPEN",
    updatedValue: "ACKNOWLEDGED",
    event: {
      mode: "update",
      eventId: event.id,
      fromStatuses: ["OPEN"],
      values: {
        status: "ACKNOWLEDGED",
        acknowledgedAt: now,
        acknowledgedByUserId: input.actorUserId,
      },
    },
  });
}

async function closeEscalation(
  input: CloseEscalationInput,
  eventStatus: "RESOLVED" | "RETURNED",
  auditAction: "PC_ESCALATION_RESOLVED" | "PC_ESCALATION_RETURNED",
  action: string,
): Promise<ResponsibilityMutationResult> {
  assertResponsibilityActionsEnabled();
  assertExceptionSource(input.sourceType);
  const closingNote = requireText(input.note, "note");
  const row = await loadOwnedOverlay(input);
  assertStatus(row, ["ESCALATED"], action);
  assertTransition("ESCALATED", "IN_PROGRESS");
  const event = await loadOpenEvent(row.id, input.brokerageId, "ESCALATION");
  await assertEscalationResponder(event, input.actorUserId, input.brokerageId);
  const now = new Date();

  return commitResponsibility({
    row,
    input,
    assignmentPatch: {
      status: "IN_PROGRESS",
      ...WAITING_ON_CLEARED,
    },
    auditAction,
    previousValue: "ESCALATED",
    updatedValue: "IN_PROGRESS",
    providerReference: JSON.stringify({ closingNote }),
    event: {
      mode: "update",
      eventId: event.id,
      fromStatuses: ["OPEN", "ACKNOWLEDGED"],
      values: {
        status: eventStatus,
        closingNote,
        closedAt: now,
        closedByUserId: input.actorUserId,
      },
    },
  });
}

export async function resolveEscalation(input: CloseEscalationInput): Promise<ResponsibilityMutationResult> {
  return closeEscalation(input, "RESOLVED", "PC_ESCALATION_RESOLVED", "resolve");
}

export async function returnEscalation(input: CloseEscalationInput): Promise<ResponsibilityMutationResult> {
  return closeEscalation(input, "RETURNED", "PC_ESCALATION_RETURNED", "return");
}

export async function reclaimHandedBack(input: ResponsibilityMutationInput): Promise<ResponsibilityMutationResult> {
  assertResponsibilityActionsEnabled();
  assertExceptionSource(input.sourceType);
  const row = await loadOwnedOverlay(input);
  assertStatus(row, ["HANDED_BACK"], "reclaim");
  assertTransition(row.status, "CLAIMED");
  const event = await loadOpenEvent(row.id, input.brokerageId, "HAND_BACK");
  if (event.status !== "OPEN") {
    throw new PitCrewTransitionError(`Cannot reclaim a hand-back in status ${event.status}.`);
  }
  const now = new Date();

  return commitResponsibility({
    row,
    input,
    assignmentPatch: {
      status: "CLAIMED",
      assignedToUserId: input.actorUserId,
      claimedAt: now,
    },
    auditAction: "PC_RECLAIMED",
    previousValue: "HANDED_BACK",
    updatedValue: "CLAIMED",
    event: {
      mode: "update",
      eventId: event.id,
      fromStatuses: ["OPEN"],
      values: {
        status: "SUPERSEDED",
        closedAt: now,
        closedByUserId: input.actorUserId,
      },
    },
  });
}
