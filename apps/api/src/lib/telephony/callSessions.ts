import { checkCallUsage, resolveCallUsageLimits } from "./callUsage.js";
import { and, eq, isNull } from "drizzle-orm";
import { noteGrowCallSessionIsolationRejection, noteGrowPartyIsolationRejection } from "../grow/isolationRejection.js";
import { logger } from "@aee/events";
import {
  db,
  auditLogs,
  growCallSessions,
  growActivities,
  parties,
  type GrowCallSession,
  type GrowCallSessionStatus,
  type UserRole,
} from "@aee/db";
import { logAudit, type AuditLogInput } from "../audit.js";
import { BROKERAGE_ADMIN_ROLES } from "../../middlewares/auth.js";
import {
  evaluateOutboundCallEligibilityInTransaction,
} from "./eligibility.js";
import {
  type ConsentTransaction,
  withConsentBrokerageLock,
  writeAuditInTransaction,
} from "../consentControlsPersistence.js";
import { normalizePhoneNumber, PhoneNumberValidationError, type PhoneCountry } from "./phoneNumber.js";
import {
  assertValidCallSessionTransition,
  assertValidRecordingTransition,
  TERMINAL_CALL_SESSION_STATUSES,
} from "./stateMachine.js";
import { resolveRecordingPermission } from "./consent.js";
import { SandboxTelephonyProvider } from "./sandboxProvider.js";
import type { TelephonyProvider } from "./provider.js";
import { CallConsentEligibilityError, evaluateOutboundCallEligibility } from "./eligibility.js";
import { evaluateRecordingGates, recordingEvidenceSummary } from "./recordingGates.js";

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
const sandboxTelephonyProvider = new SandboxTelephonyProvider();

// The module owns one adapter. Production constructs only the sandbox.
// A test may substitute another in-process adapter; that seam is refused
// outside NODE_ENV=test and does not read or set LIVE_*_APPROVED.
let telephonyProvider: TelephonyProvider = sandboxTelephonyProvider;

export function setTelephonyProviderForTests(provider: TelephonyProvider | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Telephony provider override is test-only.");
  }
  telephonyProvider = provider ?? sandboxTelephonyProvider;
}

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

export class GrowCallSessionAuthorizationError extends Error {
  constructor() {
    super("You are not authorised to access or mutate this call session.");
    this.name = "GrowCallSessionAuthorizationError";
  }
}

function isPrivilegedSessionRole(role: string): role is UserRole {
  return BROKERAGE_ADMIN_ROLES.includes(role as UserRole);
}

export function assertCallSessionActorAuthorized(session: GrowCallSession, userId: number, role: string): void {
  if (session.initiatedByUserId !== userId && !isPrivilegedSessionRole(role)) {
    throw new GrowCallSessionAuthorizationError();
  }
}

async function loadSessionForBrokerage(brokerageId: number, callSessionId: number): Promise<GrowCallSession> {
  const [session] = await db
    .select()
    .from(growCallSessions)
    .where(and(eq(growCallSessions.id, callSessionId), eq(growCallSessions.brokerageId, brokerageId)))
    .limit(1);
  if (!session) {
    await noteGrowCallSessionIsolationRejection(callSessionId, brokerageId);
    throw new GrowCallSessionNotFoundError();
  }
  return session;
}

function normalizePartyDestination(mobile: string | null, assumedCountry?: PhoneCountry): string {
  if (!mobile || mobile.trim().length === 0) {
    throw new GrowCallSessionValidationError("Contact has no phone number.");
  }
  try {
    return normalizePhoneNumber(mobile, { assumedCountry }).e164;
  } catch (err) {
    if (err instanceof PhoneNumberValidationError) {
      throw new GrowCallSessionValidationError(`Contact phone number is not callable: ${err.message}`);
    }
    throw err;
  }
}

async function assertDestinationMatchesParty(
  tx: ConsentTransaction,
  session: Pick<GrowCallSession, "brokerageId" | "partyId" | "destinationNormalized" | "destinationCountry" | "id">,
  actorUserId: number,
  auditRecordId: string,
): Promise<boolean> {
  const [party] = await tx
    .select({ mobile: parties.mobile })
    .from(parties)
    .where(and(eq(parties.id, session.partyId), eq(parties.brokerageId, session.brokerageId)))
    .limit(1);
  if (!party) {
    await noteGrowPartyIsolationRejection(session.partyId, session.brokerageId);
    throw new GrowCallSessionValidationError("Contact not found in this brokerage.");
  }
  const partyDestination = normalizePartyDestination(party.mobile, session.destinationCountry as PhoneCountry);
  if (partyDestination !== session.destinationNormalized) {
    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: actorUserId,
        action: "grow_call_destination_binding_denied",
        recordType: "grow_call_session",
        recordId: auditRecordId,
        updatedValue: JSON.stringify({
          expectedPartyDestination: partyDestination,
          boundDestination: session.destinationNormalized,
          partyId: session.partyId,
        }),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return false;
  }
  return true;
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
    await noteGrowPartyIsolationRejection(input.partyId, input.brokerageId);
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
  const partyDestination = normalizePartyDestination(party.mobile, input.assumedCountry ?? normalized.country);
  if (partyDestination !== normalized.e164) {
    await logAudit({
      brokerageId: input.brokerageId,
      userId: input.initiatedByUserId,
      action: "grow_call_destination_binding_denied",
      recordType: "party",
      recordId: String(input.partyId),
      updatedValue: JSON.stringify({ partyDestination, requestedDestination: normalized.e164 }),
    });
    throw new GrowCallSessionValidationError("The destination must match the contact phone number.");
  }

  const recordingRequested = input.recordingRequested ?? false;
  let recording: Awaited<ReturnType<typeof resolveRecordingPermission>> = {
    permitted: false,
    recordingStatus: recordingRequested ? "DENIED" : "NOT_REQUESTED",
    recordingConsentId: null,
    recordingConsentJurisdiction: null,
  };
  let recordingResolutionError: string | null = null;
  try {
    recording = await resolveRecordingPermission({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      recordingRequested,
      expectedJurisdiction: normalized.country,
    });
  } catch (err) {
    // Recording is deliberately non-blocking for the base call.  Preserve a
    // fail-closed state and record the error against the session after the
    // call row exists; never silently turn a resolver failure into a grant.
    recordingResolutionError = err instanceof Error ? err.message : "Recording consent lookup failed.";
  }

  // F2 foundation hardening: the call itself cannot be created until the
  // audited, canonical PHONE_CALL decision is eligible.  Recording remains a
  // separate, non-blocking axis below.
  try {
    await evaluateOutboundCallEligibility({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      decidedByUserId: input.initiatedByUserId,
      jurisdiction: normalized.country,
    });
  } catch (err) {
    if (err instanceof CallConsentEligibilityError) {
      throw new GrowCallSessionValidationError(`Call consent is not eligible: ${err.reasonCode}.`);
    }
    throw err;
  }

  // t222u: configurable calling usage limits (lib/telephony/callUsage.ts). Default unlimited: with no
  // AE_CALL_USAGE_LIMITS configured these checks always allow and add no queries. A reached call or
  // minute limit refuses the new call; a reached recording limit leaves the call unrecorded (recording
  // is a separate, non-blocking axis, exactly like a consent miss).
  const usageLimits = resolveCallUsageLimits();
  for (const metric of ["calls", "minutes"] as const) {
    const decision = await checkCallUsage(input.brokerageId, metric, usageLimits);
    if (!decision.allowed) {
      throw new GrowCallSessionValidationError(`Calling usage limit reached for this period (${metric}: ${decision.used}/${decision.limit}).`);
    }
  }
  if (recordingRequested && recording.permitted && !(await checkCallUsage(input.brokerageId, "recordings", usageLimits)).allowed) {
    recording = { ...recording, permitted: false };
  }

  const [draft] = await db
    .insert(growCallSessions)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      initiatedByUserId: input.initiatedByUserId,
      destinationRaw: normalized.raw,
      destinationNormalized: normalized.e164,
      destinationCountry: normalized.country,
      provider: telephonyProvider.name,
      status: "DRAFT",
      recordingRequested,
      // Recording cannot be enabled before an in-call disclosure and
      // confirmation.  A legacy consent may only determine whether
      // disclosure is still required; it never grants a pre-call recording.
      recordingPermitted: false,
      recordingConsentId: recording.recordingConsentId,
      recordingStatus: recordingRequested
        ? recording.permitted
          ? "DISCLOSURE_REQUIRED"
          : "UNRECORDED"
        : "NOT_REQUESTED",
    })
    .returning();

  assertValidCallSessionTransition("DRAFT", "READY");
  const [ready] = await db
    .update(growCallSessions)
    .set({ status: "READY", updatedAt: new Date() })
    .where(and(eq(growCallSessions.id, draft.id), eq(growCallSessions.status, "DRAFT")))
    .returning();
  if (!ready) throw new GrowCallSessionValidationError("Call session could not be prepared because it changed concurrently.");

  await logAudit({
    brokerageId: ready.brokerageId,
    userId: input.initiatedByUserId,
    action: "grow_call_session_created",
    recordType: "grow_call_session",
    recordId: String(ready.id),
    updatedValue: JSON.stringify({
      partyId: ready.partyId,
      destinationRaw: ready.destinationRaw,
      destinationNormalized: ready.destinationNormalized,
      destinationCountry: ready.destinationCountry,
      recordingStatus: ready.recordingStatus,
      destinationBinding: "party.mobile normalized at creation",
    }),
  });

  if (recordingRequested && !recording.permitted) {
    await logAudit({
      brokerageId: ready.brokerageId,
      userId: input.initiatedByUserId,
      action: "grow_call_recording_permission_denied",
      recordType: "grow_call_session",
      recordId: String(ready.id),
      updatedValue: recordingResolutionError ? `DENIED: ${recordingResolutionError}` : "DENIED",
    });
  }

  return ready;
}

export interface ConfirmCallSessionInput {
  brokerageId: number;
  callSessionId: number;
  confirmedByUserId: number;
  confirmedByUserRole: string;
}

/** §13 — explicit user confirmation before the sandbox call begins. */
export async function confirmCallSession(input: ConfirmCallSessionInput): Promise<GrowCallSession> {
  const result = await withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [session] = await tx
      .select()
      .from(growCallSessions)
      .where(and(eq(growCallSessions.id, input.callSessionId), eq(growCallSessions.brokerageId, input.brokerageId)))
      .limit(1);
    if (!session) {
      await noteGrowCallSessionIsolationRejection(input.callSessionId, input.brokerageId);
      throw new GrowCallSessionNotFoundError();
    }
    assertCallSessionActorAuthorized(session, input.confirmedByUserId, input.confirmedByUserRole);
    const destinationBound = await assertDestinationMatchesParty(tx, session, input.confirmedByUserId, String(session.id));
    if (!destinationBound) return { session, deniedReason: null, bindingDenied: true, dialled: null };
    assertValidCallSessionTransition(session.status, "DIAL_REQUESTED");

    // The authoritative decision and READY -> DIAL_REQUESTED claim happen
    // under the same brokerage advisory lock and transaction as consent
    // withdrawal. A BLOCKED decision is returned, not thrown, so its
    // immutable denial evidence commits before the HTTP error is mapped.
    const recorded = await evaluateOutboundCallEligibilityInTransaction(tx, {
      brokerageId: session.brokerageId,
      partyId: session.partyId,
      decidedByUserId: input.confirmedByUserId,
      jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
    });
    if (recorded.evaluation.decision !== "ELIGIBLE") {
      return { session, deniedReason: recorded.evaluation.reasonCode, bindingDenied: false, dialled: null };
    }

    const now = new Date();
    const [claimed] = await tx
      .update(growCallSessions)
      .set({ status: "DIAL_REQUESTED", confirmedAt: now, startedAt: now, updatedAt: now })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, "READY")))
      .returning();
    if (!claimed) {
      throw new GrowCallSessionValidationError("Call session changed concurrently; confirmation was not applied.");
    }

    // Hold the same transaction-scoped lock through the adapter claim so a
    // concurrent cancel/webhook cannot observe DIAL_REQUESTED and race this
    // single outbound request.
    const dialResult = await telephonyProvider.dial({
      callSessionId: claimed.id,
      brokerageId: claimed.brokerageId,
      destinationE164: claimed.destinationNormalized,
    });
    const [dialled] = await tx
      .update(growCallSessions)
      .set({ providerCallId: dialResult.providerCallId, updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, claimed.id), eq(growCallSessions.status, "DIAL_REQUESTED"), isNull(growCallSessions.providerCallId)))
      .returning();
    if (!dialled) throw new GrowCallSessionValidationError("Call session lost its dial claim before the provider request completed.");

    await logAudit(
      {
        brokerageId: claimed.brokerageId,
        userId: input.confirmedByUserId,
        action: "grow_call_confirmed",
        recordType: "grow_call_session",
        recordId: String(claimed.id),
        updatedValue: JSON.stringify({ destinationNormalized: claimed.destinationNormalized, destinationBinding: "party.mobile verified at confirm" }),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    await logAudit(
      {
        brokerageId: claimed.brokerageId,
        userId: input.confirmedByUserId,
        action: "grow_call_started",
        recordType: "grow_call_session",
        recordId: String(claimed.id),
        updatedValue: dialResult.providerCallId,
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return { session: dialled, deniedReason: null, bindingDenied: false, dialled };
  });

  if (result.bindingDenied) {
    throw new GrowCallSessionValidationError("The contact phone number changed; this call must be recreated.");
  }
  if (result.deniedReason) {
    throw new GrowCallSessionValidationError(`Call consent is not eligible: ${result.deniedReason}.`);
  }
  if (!result.dialled) throw new GrowCallSessionValidationError("Call confirmation was not applied.");
  return result.dialled;
}

export interface CancelCallSessionInput {
  brokerageId: number;
  callSessionId: number;
  cancelledByUserId: number;
  cancelledByUserRole: string;
  reason?: string | null;
}

export async function cancelCallSession(input: CancelCallSessionInput): Promise<GrowCallSession> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [session] = await tx
      .select()
      .from(growCallSessions)
      .where(and(eq(growCallSessions.id, input.callSessionId), eq(growCallSessions.brokerageId, input.brokerageId)))
      .limit(1);
    if (!session) {
      await noteGrowCallSessionIsolationRejection(input.callSessionId, input.brokerageId);
      throw new GrowCallSessionNotFoundError();
    }
    assertCallSessionActorAuthorized(session, input.cancelledByUserId, input.cancelledByUserRole);
    if (TERMINAL_CALL_SESSION_STATUSES.includes(session.status)) {
      throw new GrowCallSessionValidationError(`Call session is already ${session.status} and cannot be cancelled.`);
    }
    assertValidCallSessionTransition(session.status, "CANCELLED");

    const [cancelled] = await tx
      .update(growCallSessions)
      .set({ status: "CANCELLED", cancelledReason: input.reason ?? null, endedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, session.status)))
      .returning();
    if (!cancelled) throw new GrowCallSessionValidationError("Call session changed concurrently; cancellation was not applied.");

    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: input.cancelledByUserId,
        action: "grow_call_cancelled",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: input.reason ?? undefined,
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return cancelled;
  });
}

export async function getCallSessionForBrokerage(
  brokerageId: number,
  callSessionId: number,
  actor?: { id: number; role: string },
): Promise<GrowCallSession> {
  const session = await loadSessionForBrokerage(brokerageId, callSessionId);
  if (actor) assertCallSessionActorAuthorized(session, actor.id, actor.role);
  return session;
}

/**
 * §15 — applies one sandbox lifecycle event, found by the webhook route's
 * own idempotent processInboundTelephonyWebhook() (webhooks.ts). The
 * target status is derived from the event type via the same state-machine
 * guard every other transition uses, so an out-of-order event that would
 * produce an invalid transition is rejected rather than silently applied.
 * Repeated delivery of the already-applied terminal target is idempotent.
 */
export type SandboxLifecycleEvent = "RINGING" | "CONNECTED" | "COMPLETED" | "FAILED";

const SANDBOX_EVENT_TARGET_STATUS: Record<SandboxLifecycleEvent, GrowCallSessionStatus> = {
  RINGING: "RINGING",
  CONNECTED: "CONNECTED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
};

export interface ApplySandboxLifecycleEventOptions {
  /**
   * Receipt coordination runs inside the base lifecycle transaction, after
   * acquiring the brokerage lock. claim must lock the receipt and return false
   * for an already committed delivery; complete commits the receipt alongside
   * the successful transition, core audit and activity. Denial evidence still
   * commits without completing the receipt. Recording closure stays outside.
   */
  receipt?: {
    claim: (tx: ConsentTransaction) => Promise<boolean>;
    complete: (tx: ConsentTransaction) => Promise<void>;
  };
  /**
   * Fault-injection seam for the recording-only audit. Production callers
   * leave this unset. A recording audit failure must never roll back the
   * already-committed terminal call lifecycle.
   */
  recordingClosureAuditWriter?: (input: AuditLogInput) => Promise<void>;
}

interface TerminalRecordingClosure {
  previousRecordingStatus: string;
  terminalStatus: GrowCallSessionStatus;
}

async function settleTerminalRecording(
  closure: TerminalRecordingClosure,
  callSessionId: number,
  brokerageId: number,
  auditWriter?: (input: AuditLogInput) => Promise<void>,
): Promise<void> {
  // Recording closure is deliberately a separate transaction from the base
  // lifecycle transition. It is retryable bookkeeping and cannot roll back
  // the already-committed terminal status, core audit, or activity.
  try {
    await withConsentBrokerageLock(brokerageId, async (tx) => {
      const [session] = await tx
        .select()
        .from(growCallSessions)
        .where(and(eq(growCallSessions.id, callSessionId), eq(growCallSessions.brokerageId, brokerageId)))
        .limit(1);
      if (!session || !TERMINAL_CALL_SESSION_STATUSES.includes(session.status)) return;

      if (session.recordingStatus !== "UNRECORDED") {
        assertValidRecordingTransition(session.recordingStatus, "UNRECORDED");
        const [settled] = await tx
          .update(growCallSessions)
          .set({ recordingStatus: "UNRECORDED", recordingPermitted: false, updatedAt: new Date() })
          .where(
            and(
              eq(growCallSessions.id, session.id),
              eq(growCallSessions.status, closure.terminalStatus),
              eq(growCallSessions.recordingStatus, closure.previousRecordingStatus),
            ),
          )
          .returning();
        // A concurrent retry may have completed state settlement already.
        if (!settled) return;
      } else if (session.recordingPermitted) {
        // Defensive cleanup for rows settled by an older attempt.
        await tx
          .update(growCallSessions)
          .set({ recordingPermitted: false, updatedAt: new Date() })
          .where(
            and(
              eq(growCallSessions.id, session.id),
              eq(growCallSessions.status, closure.terminalStatus),
              eq(growCallSessions.recordingStatus, "UNRECORDED"),
            ),
          );
      }
    });
  } catch (error) {
    // The base call is already committed. A later terminal delivery can retry
    // this closure, so recording-only failures never fail the call webhook.
    logger.error("grow_call_recording_closure_state_failed", { brokerageId, callSessionId, error });
    return;
  }

  // Audit is independent from the state settlement. If the recording audit
  // sink is unavailable, the session remains UNRECORDED/false and a later
  // terminal delivery can retry the missing audit row.
  try {
    await withConsentBrokerageLock(brokerageId, async (tx) => {
      const [session] = await tx
        .select()
        .from(growCallSessions)
        .where(and(eq(growCallSessions.id, callSessionId), eq(growCallSessions.brokerageId, brokerageId)))
        .limit(1);
      if (!session || session.status !== closure.terminalStatus || session.recordingStatus !== "UNRECORDED") return;

      const [existingAudit] = await tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "grow_call_recording_unrecorded"),
            eq(auditLogs.recordType, "grow_call_session"),
            eq(auditLogs.recordId, String(session.id)),
          ),
        )
        .limit(1);
      if (existingAudit) return;

      const auditInput: AuditLogInput = {
        brokerageId: session.brokerageId,
        recordType: "grow_call_session",
        recordId: String(session.id),
        action: "grow_call_recording_unrecorded",
        updatedValue: "IN_CALL_DISCLOSURE_OR_CONFIRMATION_MISSING",
      };
      if (auditWriter) {
        await auditWriter(auditInput);
      } else {
        await logAudit(auditInput, {
          strict: true,
          write: (input) => writeAuditInTransaction(tx, input),
        });
      }
    });
  } catch (error) {
    // No audit row was committed on failure; a later terminal delivery retries
    // it without changing the already-settled call state.
    logger.error("grow_call_recording_closure_audit_failed", { brokerageId, callSessionId, error, retryable: true });
  }
}

export async function applySandboxLifecycleEvent(
  callSessionId: number,
  event: SandboxLifecycleEvent,
  options: ApplySandboxLifecycleEventOptions = {},
): Promise<GrowCallSession> {
  const [initial] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, callSessionId)).limit(1);
  if (!initial) throw new GrowCallSessionNotFoundError();
  const targetStatus = SANDBOX_EVENT_TARGET_STATUS[event];
  const result = await withConsentBrokerageLock(initial.brokerageId, async (tx) => {
    const shouldApply = options.receipt ? await options.receipt.claim(tx) : true;
    const [session] = await tx.select().from(growCallSessions).where(eq(growCallSessions.id, callSessionId)).limit(1);
    if (!session) throw new GrowCallSessionNotFoundError();

    // Include UNRECORDED rows so a later terminal delivery can retry an audit
    // that failed after the independent state settlement committed.
    const recordingClosure =
      (targetStatus === "COMPLETED" || targetStatus === "FAILED") && session.recordingRequested && session.recordingStatus !== "DECLINED"
        ? { previousRecordingStatus: session.recordingStatus, terminalStatus: targetStatus }
        : null;

    // A committed receipt is authoritative even if a later event has advanced
    // the session. Never repeat eligibility decisions or nonterminal audits.
    if (!shouldApply) {
      return { updated: session, deniedReason: null, recordingClosure: session.status === targetStatus ? recordingClosure : null };
    }

    // A fresh provider event id can repeat an already-applied terminal event.
    // Accept the same terminal target idempotently while allowing recording
    // closure/audit retry below.
    if (session.status === targetStatus && (targetStatus === "COMPLETED" || targetStatus === "FAILED")) {
      const [safeTerminal] = await tx
        .update(growCallSessions)
        .set({ recordingPermitted: false, updatedAt: new Date() })
        .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, targetStatus)))
        .returning();
      await options.receipt?.complete(tx);
      return { updated: safeTerminal ?? session, deniedReason: null, recordingClosure };
    }

    if (targetStatus === "CONNECTED") {
      const recorded = await evaluateOutboundCallEligibilityInTransaction(tx, {
        brokerageId: session.brokerageId,
        partyId: session.partyId,
        decidedByUserId: session.initiatedByUserId,
        jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
      });
      if (recorded.evaluation.decision !== "ELIGIBLE") {
        await logAudit(
          {
            brokerageId: session.brokerageId,
            userId: session.initiatedByUserId,
            action: "grow_call_connected_consent_denied",
            recordType: "grow_call_session",
            recordId: String(session.id),
            updatedValue: recorded.evaluation.reasonCode,
          },
          { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
        );
        return { updated: null, deniedReason: recorded.evaluation.reasonCode, recordingClosure: null };
      }
    }
    assertValidCallSessionTransition(session.status, targetStatus);

    const now = new Date();
    const patch: Partial<typeof growCallSessions.$inferInsert> = { status: targetStatus, updatedAt: now };
    if (targetStatus === "CONNECTED") patch.answeredAt = now;
    if (targetStatus === "COMPLETED" || targetStatus === "FAILED") {
      patch.endedAt = now;
      const startedAt = session.startedAt ? new Date(session.startedAt) : now;
      patch.durationSeconds = Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000));
      // The live permission bit is cleared in the base terminal CAS. The
      // recordingStatus transition is independent and follows after commit.
      patch.recordingPermitted = false;
    }

    const [updated] = await tx
      .update(growCallSessions)
      .set(patch)
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, session.status)))
      .returning();
    if (!updated) throw new GrowCallSessionValidationError("Call lifecycle changed concurrently; webhook was not applied.");

    await logAudit(
      {
        brokerageId: updated.brokerageId,
        action: targetStatus === "CONNECTED" ? "grow_call_connected" : targetStatus === "COMPLETED" ? "grow_call_completed" : "grow_call_failed",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: targetStatus,
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );

    // §14 — one relationship activity is inserted in the same locked
    // transaction as the terminal CAS, so concurrent completion events cannot
    // reopen the session or duplicate its timeline side effect.
    if (targetStatus === "COMPLETED") {
      await tx.insert(growActivities).values({
        brokerageId: updated.brokerageId,
        partyId: updated.partyId,
        activityType: "call",
        occurredAt: updated.startedAt ?? now,
        summary: `Sandbox call completed — ${updated.durationSeconds ?? 0}s`,
        details: {
          sandbox: true,
          callSessionId: updated.id,
          durationSeconds: updated.durationSeconds,
          // Reflect the independently-settled terminal recording outcome in
          // the activity snapshot even before the closure transaction runs.
          recordingStatus: recordingClosure ? "UNRECORDED" : updated.recordingStatus,
        },
        responsibleUserId: updated.initiatedByUserId,
        source: "grow_calls",
        sourceId: String(updated.id),
      });
    }
    await options.receipt?.complete(tx);
    return { updated, deniedReason: null, recordingClosure };
  });
  if (result.deniedReason) {
    throw new GrowCallSessionValidationError(`Call consent is not eligible: ${result.deniedReason}.`);
  }
  if (!result.updated) throw new GrowCallSessionValidationError("Call lifecycle was not applied.");
  if (result.recordingClosure) {
    await settleTerminalRecording(result.recordingClosure, result.updated.id, result.updated.brokerageId, options.recordingClosureAuditWriter);
    const [settled] = await db.select().from(growCallSessions).where(eq(growCallSessions.id, result.updated.id)).limit(1);
    return settled ?? result.updated;
  }
  return result.updated;
}

export async function recordInCallRecordingDisclosure(input: {
  brokerageId: number;
  callSessionId: number;
  disclosedByUserId: number;
  disclosedByUserRole: string;
}): Promise<GrowCallSession> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [session] = await tx
      .select()
      .from(growCallSessions)
      .where(and(eq(growCallSessions.id, input.callSessionId), eq(growCallSessions.brokerageId, input.brokerageId)))
      .limit(1);
    if (!session) {
      await noteGrowCallSessionIsolationRejection(input.callSessionId, input.brokerageId);
      throw new GrowCallSessionNotFoundError();
    }
    assertCallSessionActorAuthorized(session, input.disclosedByUserId, input.disclosedByUserRole);
    if (session.status !== "CONNECTED") {
      throw new GrowCallSessionValidationError("Recording disclosure is only valid while the call is connected.");
    }
    if (!session.recordingRequested) {
      throw new GrowCallSessionValidationError("Recording was not requested for this call session.");
    }
    if (session.recordingStatus !== "DISCLOSURE_REQUIRED" && session.recordingStatus !== "UNRECORDED") {
      throw new GrowCallSessionValidationError(`Recording disclosure is not valid from ${session.recordingStatus}.`);
    }
    assertValidRecordingTransition(session.recordingStatus, "DISCLOSED");
    const [updated] = await tx
      .update(growCallSessions)
      .set({ recordingStatus: "DISCLOSED", recordingPermitted: false, updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, "CONNECTED"), eq(growCallSessions.recordingStatus, session.recordingStatus)))
      .returning();
    if (!updated) throw new GrowCallSessionValidationError("Recording disclosure changed concurrently; retry the attestation.");
    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: input.disclosedByUserId,
        action: "grow_call_recording_disclosed_in_call",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: "DISCLOSED",
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return updated;
  });
}

export async function confirmInCallRecording(input: {
  brokerageId: number;
  callSessionId: number;
  confirmedByUserId: number;
  actorRole: string;
}): Promise<GrowCallSession> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [session] = await tx
      .select()
      .from(growCallSessions)
      .where(and(eq(growCallSessions.id, input.callSessionId), eq(growCallSessions.brokerageId, input.brokerageId)))
      .limit(1);
    if (!session) {
      await noteGrowCallSessionIsolationRejection(input.callSessionId, input.brokerageId);
      throw new GrowCallSessionNotFoundError();
    }
    assertCallSessionActorAuthorized(session, input.confirmedByUserId, input.actorRole);
    if (session.status !== "CONNECTED") {
      throw new GrowCallSessionValidationError("Recording confirmation is only valid while the call is connected.");
    }
    if (!session.recordingRequested) {
      throw new GrowCallSessionValidationError("Recording was not requested for this call session.");
    }
    if (session.recordingStatus !== "DISCLOSED") {
      throw new GrowCallSessionValidationError("In-call recording disclosure must be captured before confirmation.");
    }
    assertValidRecordingTransition(session.recordingStatus, "CONFIRMED");

    const [confirmed] = await tx
      .update(growCallSessions)
      .set({ recordingStatus: "CONFIRMED", recordingPermitted: false, updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, "CONNECTED"), eq(growCallSessions.recordingStatus, "DISCLOSED")))
      .returning();
    if (!confirmed) throw new GrowCallSessionValidationError("Recording confirmation changed concurrently; retry the attestation.");
    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: input.confirmedByUserId,
        action: "grow_call_recording_confirmation_received",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: "CONFIRMED",
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );

    const gates = await evaluateRecordingGates({
      session: confirmed,
      actor: { id: input.confirmedByUserId, role: input.actorRole, brokerageId: session.brokerageId },
      providerName: telephonyProvider.name,
      providerCapabilities: telephonyProvider.capabilities,
      tx,
    });
    const nextStatus = gates.permitted ? "PERMITTED_NOT_CAPTURED" : "UNRECORDED";
    assertValidRecordingTransition("CONFIRMED", nextStatus);
    const [updated] = await tx
      .update(growCallSessions)
      .set({ recordingStatus: nextStatus, recordingPermitted: gates.permitted, updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, "CONNECTED"), eq(growCallSessions.recordingStatus, "CONFIRMED")))
      .returning();
    if (!updated) throw new GrowCallSessionValidationError("Recording permission changed concurrently; retry the attestation.");
    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: input.confirmedByUserId,
        action: gates.permitted ? "grow_call_recording_enabled" : "grow_call_recording_unrecorded",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: recordingEvidenceSummary(gates),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return updated;
  });
}

export async function declineInCallRecording(input: {
  brokerageId: number;
  callSessionId: number;
  declinedByUserId: number;
  declinedByUserRole: string;
}): Promise<GrowCallSession> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [session] = await tx
      .select()
      .from(growCallSessions)
      .where(and(eq(growCallSessions.id, input.callSessionId), eq(growCallSessions.brokerageId, input.brokerageId)))
      .limit(1);
    if (!session) {
      await noteGrowCallSessionIsolationRejection(input.callSessionId, input.brokerageId);
      throw new GrowCallSessionNotFoundError();
    }
    assertCallSessionActorAuthorized(session, input.declinedByUserId, input.declinedByUserRole);
    if (session.status !== "CONNECTED") {
      throw new GrowCallSessionValidationError("Recording response is only valid while the call is connected.");
    }
    if (!session.recordingRequested) {
      throw new GrowCallSessionValidationError("Recording was not requested for this call session.");
    }
    if (session.recordingStatus === "PERMITTED_NOT_CAPTURED" || session.recordingStatus === "DECLINED") {
      throw new GrowCallSessionValidationError(`Recording response is not valid from ${session.recordingStatus}.`);
    }
    assertValidRecordingTransition(session.recordingStatus, "DECLINED");
    const [updated] = await tx
      .update(growCallSessions)
      .set({ recordingStatus: "DECLINED", recordingPermitted: false, updatedAt: new Date() })
      .where(and(eq(growCallSessions.id, session.id), eq(growCallSessions.status, "CONNECTED"), eq(growCallSessions.recordingStatus, session.recordingStatus)))
      .returning();
    if (!updated) throw new GrowCallSessionValidationError("Recording response changed concurrently; retry the attestation.");
    await logAudit(
      {
        brokerageId: session.brokerageId,
        userId: input.declinedByUserId,
        action: "grow_call_recording_declined_in_call",
        recordType: "grow_call_session",
        recordId: String(session.id),
        updatedValue: "DECLINED",
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return updated;
  });
}
