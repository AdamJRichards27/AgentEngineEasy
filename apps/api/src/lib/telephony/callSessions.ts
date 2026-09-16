import { and, eq } from "drizzle-orm";
import { db, growCallSessions, growActivities, parties, type GrowCallSession, type GrowCallSessionStatus } from "@aee/db";
import { logAudit } from "../audit.js";
import { normalizePhoneNumber, PhoneNumberValidationError, type PhoneCountry } from "./phoneNumber.js";
import { assertValidCallSessionTransition, TERMINAL_CALL_SESSION_STATUSES } from "./stateMachine.js";
import { resolveRecordingPermission } from "./consent.js";
import { SandboxTelephonyProvider } from "./sandboxProvider.js";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// The call-session orchestration service. Every route in
// routes/growCalls.ts and routes/growCallsWebhooks.ts calls into this
// module rather than touching growCallSessions directly, so the state
// machine (stateMachine.ts), the fail-closed recording decision
// (consent.ts), and the audit trail (§16) are always applied consistently
// regardless of which route triggered a change.
//
// F1 never places a real call: the only TelephonyProvider this module
// constructs is SandboxTelephonyProvider (§10, §11 — LIVE_TELEPHONY_APPROVED
// exists as a kill switch for a FUTURE real provider, but no real provider
// adapter is implemented in F1 at all, so there is nothing for that flag to
// unlock yet).
const telephonyProvider = new SandboxTelephonyProvider();

export class GrowCallSessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowCallSessionValidationError";
  }
}

export class GrowCallSessionNotFoundError extends Error {
  constructor() {
    super("Call session not found in this brokerage.");
    this.name = "GrowCallSessionNotFoundError";
  }
}

async function loadSessionForBrokerage(brokerageId: number, callSessionId: number): Promise<GrowCallSession> {
  const [session] = await db
    .select()
    .from(growCallSessions)
    .where(and(eq(growCallSessions.id, callSessionId), eq(growCallSessions.brokerageId, brokerageId)))
    .limit(1);
  if (!session) throw new GrowCallSessionNotFoundError();
  return session;
}

export interface CreateCallSessionInput {
  brokerageId: number;
  partyId: number;
  initiatedByUserId: number;
  /** Defaults to the party's own stored `mobile` (property.ts) when omitted — never mutated either way. */
  destinationRaw?: string | null;
  /** Required whenever the resolved destination is in national ("0"-prefixed) format — see phoneNumber.ts. */
  assumedCountry?: PhoneCountry;
  recordingRequested?: boolean;
}

/**
 * §4-6 — creates a new call session. Fully validates the destination
 * phone number and resolves the fail-closed recording decision BEFORE any
 * row exists (§5: "validate before any call session can be initiated"),
 * then inserts as DRAFT and immediately, explicitly transitions to READY
 * through the same state-machine guard every other transition uses — this
 * two-step insert-then-transition is deliberate so DRAFT -> READY is a
 * real, tested transition (see __tests__), not a status merely assumed at
 * insert time.
 */
export async function createCallSession(input: CreateCallSessionInput): Promise<GrowCallSession> {
  const [party] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.brokerageId, input.brokerageId)))
    .limit(1);
  if (!party) {
    throw new GrowCallSessionValidationError("Contact not found in this brokerage.");
  }

  const rawDestination = input.destinationRaw ?? party.mobile ?? null;
  let normalized;
  try {
    normalized = normalizePhoneNumber(rawDestination, { assumedCountry: input.assumedCountry });
  } catch (err) {
    if (err instanceof PhoneNumberValidationError) {
      throw new GrowCallSessionValidationError(err.message);
    }
    throw err;
  }

  const recordingRequested = input.recordingRequested ?? false;
  const recording = await resolveRecordingPermission({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    recordingRequested,
  });

  const [draft] = await db
    .insert(growCallSessions)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      initiatedByUserId: input.initiatedByUserId,
      destinationRaw: normalized.raw,
      destinationNormalized: normalized.e164,
      destinationCountry: normalized.country,
      provider: "sandbox",
      status: "DRAFT",
      recordingRequested,
      recordingPermitted: recording.permitted,
      recordingConsentId: recording.recordingConsentId,
      recordingStatus: recording.recordingStatus,
    })
    .returning();

  assertValidCallSessionTransition("DRAFT", "READY");
  const [ready] = await db
    .update(growCallSessions)
    .set({ status: "READY", updatedAt: new Date() })
    .where(eq(growCallSessions.id, draft.id))
    .returning();

  await logAudit({
    userId: input.initiatedByUserId,
    action: "grow_call_session_created",
    recordType: "grow_call_session",
    recordId: String(ready.id),
    updatedValue: JSON.stringify({ partyId: ready.partyId, destinationCountry: ready.destinationCountry, recordingStatus: ready.recordingStatus }),
  });

  if (recordingRequested && !recording.permitted) {
    await logAudit({
      userId: input.initiatedByUserId,
      action: "grow_call_recording_permission_denied",
      recordType: "grow_call_session",
      recordId: String(ready.id),
      updatedValue: "DENIED",
    });
  }

  return ready;
}

export interface ConfirmCallSessionInput {
  brokerageId: number;
  callSessionId: number;
  confirmedByUserId: number;
}

/** §13 — explicit user confirmation before the sandbox call begins. */
export async function confirmCallSession(input: ConfirmCallSessionInput): Promise<GrowCallSession> {
  const session = await loadSessionForBrokerage(input.brokerageId, input.callSessionId);
  assertValidCallSessionTransition(session.status, "DIAL_REQUESTED");

  const now = new Date();
  await db
    .update(growCallSessions)
    .set({ status: "DIAL_REQUESTED", confirmedAt: now, startedAt: now, updatedAt: now })
    .where(eq(growCallSessions.id, session.id));

  await logAudit({
    userId: input.confirmedByUserId,
    action: "grow_call_confirmed",
    recordType: "grow_call_session",
    recordId: String(session.id),
  });

  const dialResult = await telephonyProvider.dial({
    callSessionId: session.id,
    brokerageId: session.brokerageId,
    destinationE164: session.destinationNormalized,
  });

  const [dialled] = await db
    .update(growCallSessions)
    .set({ providerCallId: dialResult.providerCallId, updatedAt: new Date() })
    .where(eq(growCallSessions.id, session.id))
    .returning();

  await logAudit({
    userId: input.confirmedByUserId,
    action: "grow_call_started",
    recordType: "grow_call_session",
    recordId: String(session.id),
    updatedValue: dialResult.providerCallId,
  });

  return dialled;
}

export interface CancelCallSessionInput {
  brokerageId: number;
  callSessionId: number;
  cancelledByUserId: number;
  reason?: string | null;
}

export async function cancelCallSession(input: CancelCallSessionInput): Promise<GrowCallSession> {
  const session = await loadSessionForBrokerage(input.brokerageId, input.callSessionId);
  if (TERMINAL_CALL_SESSION_STATUSES.includes(session.status)) {
    throw new GrowCallSessionValidationError(`Call session is already ${session.status} and cannot be cancelled.`);
  }
  assertValidCallSessionTransition(session.status, "CANCELLED");

  const [cancelled] = await db
    .update(growCallSessions)
    .set({ status: "CANCELLED", cancelledReason: input.reason ?? null, endedAt: new Date(), updatedAt: new Date() })
    .where(eq(growCallSessions.id, session.id))
    .returning();

  await logAudit({
    userId: input.cancelledByUserId,
    action: "grow_call_cancelled",
    recordType: "grow_call_session",
    recordId: String(session.id),
    updatedValue: input.reason ?? undefined,
  });

  return cancelled;
}

export async function getCallSessionForBrokerage(brokerageId: number, callSessionId: number): Promise<GrowCallSession> {
  return loadSessionForBrokerage(brokerageId, callSessionId);
}

/**
 * §15 — applies one sandbox lifecycle event, found by the webhook route's
 * own idempotent processInboundTelephonyWebhook() (webhooks.ts). The
 * target status is derived from the event type via the same state-machine
 * guard every other transition uses, so an out-of-order/duplicate/replayed
 * event that would produce an invalid transition is rejected rather than
 * silently applied.
 */
export type SandboxLifecycleEvent = "RINGING" | "CONNECTED" | "COMPLETED" | "FAILED";

const SANDBOX_EVENT_TARGET_STATUS: Record<SandboxLifecycleEvent, GrowCallSessionStatus> = {
  RINGING: "RINGING",
  CONNECTED: "CONNECTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

export async function applySandboxLifecycleEvent(callSessionId: number, event: SandboxLifecycleEvent): Promise<GrowCallSession> {
  const [session] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, callSessionId)).limit(1);
  if (!session) throw new GrowCallSessionNotFoundError();

  const targetStatus = SANDBOX_EVENT_TARGET_STATUS[event];
  assertValidCallSessionTransition(session.status, targetStatus);

  const now = new Date();
  const patch: Partial<typeof growCallSessions.$inferInsert> = { status: targetStatus, updatedAt: now };
  if (targetStatus === "CONNECTED") {
    patch.answeredAt = now;
  }
  if (targetStatus === "COMPLETED" || targetStatus === "FAILED") {
    patch.endedAt = now;
    const startedAt = session.startedAt ? new Date(session.startedAt) : now;
    patch.durationSeconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
  }

  const [updated] = await db.update(growCallSessions).set(patch).where(eq(growCallSessions.id, session.id)).returning();

  await logAudit({
    action: targetStatus === "CONNECTED" ? "grow_call_connected" : targetStatus === "COMPLETED" ? "grow_call_completed" : "grow_call_failed",
    recordType: "grow_call_session",
    recordId: String(session.id),
    updatedValue: targetStatus,
  });

  // §14 — Relationship Timeline integration. A plain growActivities row
  // (activityType "call", already a valid GROW_ACTIVITY_TYPES member — see
  // packages/db/src/schema/grow.ts) is automatically surfaced by the
  // existing getRelationshipTimeline() aggregation with NO changes to
  // relationshipTimeline.ts required. Deliberately the ONLY side effect of
  // completion — no note/commitment/opportunity/follow-up is ever created
  // automatically (§19).
  if (targetStatus === "COMPLETED") {
    await db.insert(growActivities).values({
      brokerageId: updated.brokerageId,
      partyId: updated.partyId,
      activityType: "call",
      occurredAt: updated.startedAt ?? now,
      summary: `Sandbox call completed — ${updated.durationSeconds ?? 0}s`,
      details: {
        sandbox: true,
        callSessionId: updated.id,
        durationSeconds: updated.durationSeconds,
        recordingStatus: updated.recordingStatus,
      },
      responsibleUserId: updated.initiatedByUserId,
      source: "grow_calls",
      sourceId: String(updated.id),
    });
  }

  return updated;
}
