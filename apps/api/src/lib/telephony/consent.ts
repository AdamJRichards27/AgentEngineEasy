import { and, eq, isNull, or, gt } from "drizzle-orm";
import {
  db,
  growCallRecordingConsents,
  growCallSessions,
  parties,
  type GrowCallRecordingConsent,
  type GrowCallRecordingConsentScope,
  type GrowCallRecordingConsentSource,
} from "@aee/db";
import { logAudit } from "../audit.js";
import {
  type ConsentTransaction,
  withConsentBrokerageLock,
  writeAuditInTransaction,
} from "../consentControlsPersistence.js";
import { TERMINAL_CALL_SESSION_STATUSES } from "./stateMachine.js";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §8-9 — the recording-consent service. This module deliberately does NOT
// decide what legally valid consent looks like for AU or NZ (§20, §18 of
// the discovery) — it only records what was captured and resolves,
// fail-closed, whether a call session may currently be marked
// recordingPermitted = true. "No ambiguous or missing consent may fall
// through to allowed" (§9) is enforced by resolveRecordingPermission()
// below being the legacy-consent input to the F2 five-gate evaluator —
// routes/growCalls.ts never sets recordingPermitted directly from client
// input.  F2 only enables it after in-call disclosure/confirmation and all
// five independently evaluated gates pass.
//
// Deliberately does NOT reuse apps/api/src/lib/communications/consent.ts —
// that module is EMAIL/SMS marketing/transactional consent, and the
// governing authorisation is explicit that marketing consent must never be
// equated with recording consent (§8).

export class GrowCallConsentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowCallConsentValidationError";
  }
}

/** Distinct from GrowCallConsentValidationError so routes can map this to 404 rather than 400/409. */
export class GrowCallConsentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowCallConsentNotFoundError";
  }
}

export interface CaptureRecordingConsentInput {
  brokerageId: number;
  partyId: number;
  scope: GrowCallRecordingConsentScope;
  source: GrowCallRecordingConsentSource;
  capturedByUserId: number;
  jurisdiction?: string | null;
  consentVersion?: string | null;
  expiresAt?: Date | null;
  evidenceMetadata?: Record<string, unknown> | null;
  /**
   * Optional association with the call session this consent was captured
   * for (§8's "call-session association" requirement). Deliberately
   * modelled as the SESSION pointing at the consent
   * (grow_call_sessions.recordingConsentId), not the other way around —
   * see schema/telephony.ts's own header comment for why this avoids a
   * circular foreign key between the two tables while still fully
   * recording the association: a STANDING consent may cover many call
   * sessions, so a single callSessionId column on the consent row would
   * not even correctly model that case.
   */
  callSessionId?: number | null;
}

/** Re-resolves partyId against the ACTING request's own brokerageId — never trusts a client-supplied id. */
async function assertPartyInBrokerage(brokerageId: number, partyId: number, tx: ConsentTransaction | typeof db = db): Promise<void> {
  const [party] = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)))
    .limit(1);
  if (!party) {
    throw new GrowCallConsentNotFoundError("Contact not found in this brokerage.");
  }
}

export async function captureRecordingConsent(input: CaptureRecordingConsentInput): Promise<GrowCallRecordingConsent> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    await assertPartyInBrokerage(input.brokerageId, input.partyId, tx);

    let session: typeof growCallSessions.$inferSelect | undefined;
    if (input.callSessionId !== null && input.callSessionId !== undefined) {
      const [row] = await tx
        .select()
        .from(growCallSessions)
        .where(
          and(
            eq(growCallSessions.id, input.callSessionId),
            eq(growCallSessions.brokerageId, input.brokerageId),
            eq(growCallSessions.partyId, input.partyId),
          ),
        )
        .limit(1);
      if (!row) {
        throw new GrowCallConsentNotFoundError("Call session not found for this contact in this brokerage.");
      }
      session = row;
    }

    const [consent] = await tx
      .insert(growCallRecordingConsents)
      .values({
        brokerageId: input.brokerageId,
        partyId: input.partyId,
        scope: input.scope,
        status: "ACTIVE",
        source: input.source,
        jurisdiction: input.jurisdiction ?? null,
        consentVersion: input.consentVersion ?? null,
        capturedByUserId: input.capturedByUserId,
        expiresAt: input.expiresAt ?? null,
        evidenceMetadata: input.evidenceMetadata ?? null,
      })
      .returning();

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.capturedByUserId,
        action: "grow_call_recording_consent_captured",
        recordType: "grow_call_recording_consent",
        recordId: String(consent.id),
        updatedValue: JSON.stringify({ scope: consent.scope, source: consent.source, partyId: consent.partyId }),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );

    if (session) {
      await recomputeSessionRecordingPermission(session.id, consent.id, tx);
    }

    return consent;
  });
}

export interface WithdrawRecordingConsentInput {
  brokerageId: number;
  consentId: number;
  withdrawnByUserId: number;
  withdrawalReason?: string | null;
}

export async function withdrawRecordingConsent(input: WithdrawRecordingConsentInput): Promise<GrowCallRecordingConsent> {
  return withConsentBrokerageLock(input.brokerageId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(growCallRecordingConsents)
      .where(and(eq(growCallRecordingConsents.id, input.consentId), eq(growCallRecordingConsents.brokerageId, input.brokerageId)))
      .limit(1);
    if (!existing) {
      throw new GrowCallConsentNotFoundError("Recording consent not found in this brokerage.");
    }
    if (existing.status === "WITHDRAWN") {
      throw new GrowCallConsentValidationError("This consent has already been withdrawn.");
    }

    const [updated] = await tx
      .update(growCallRecordingConsents)
      .set({
        status: "WITHDRAWN",
        withdrawnAt: new Date(),
        withdrawnByUserId: input.withdrawnByUserId,
        withdrawalReason: input.withdrawalReason ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(growCallRecordingConsents.id, existing.id), eq(growCallRecordingConsents.status, existing.status)))
      .returning();
    if (!updated) {
      throw new GrowCallConsentValidationError("This consent changed concurrently; retry the withdrawal.");
    }

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.withdrawnByUserId,
        action: "grow_call_recording_consent_withdrawn",
        recordType: "grow_call_recording_consent",
        recordId: String(updated.id),
        previousValue: existing.status,
        updatedValue: "WITHDRAWN",
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );

    // Any call session currently pointing at this consent must be
    // re-resolved — a withdrawal happening mid-call must fail closed
    // immediately, never leave a stale recordingPermitted = true in place.
    const affectedSessions = await tx
      .select({ id: growCallSessions.id })
      .from(growCallSessions)
      .where(and(eq(growCallSessions.brokerageId, input.brokerageId), eq(growCallSessions.recordingConsentId, existing.id)));
    for (const affected of affectedSessions) {
      await recomputeSessionRecordingPermission(affected.id, existing.id, tx);
    }

    return updated;
  });
}

function consentIsCurrentlyActive(consent: GrowCallRecordingConsent, now: Date): boolean {
  if (consent.status !== "ACTIVE") return false;
  if (consent.expiresAt && new Date(consent.expiresAt) < now) return false;
  return true;
}

/**
 * §9 — the single fail-closed decision point. Returns permitted = false
 * for every case except an explicit, currently-active, non-expired,
 * non-withdrawn consent: a STANDING consent for this party, OR the
 * specific consent already associated with this call session (set via
 * captureRecordingConsent's callSessionId option).
 */
export async function resolveRecordingPermission(input: {
  brokerageId: number;
  partyId: number;
  recordingRequested: boolean;
  existingRecordingConsentId?: number | null;
  /** F2 requires the legacy consent jurisdiction to match the call. */
  expectedJurisdiction?: string | null;
  tx?: ConsentTransaction;
}): Promise<{
  permitted: boolean;
  recordingStatus: "NOT_REQUESTED" | "DENIED" | "PERMITTED_NOT_CAPTURED";
  recordingConsentId: number | null;
  recordingConsentJurisdiction: string | null;
}> {
  if (!input.recordingRequested) {
    return { permitted: false, recordingStatus: "NOT_REQUESTED", recordingConsentId: null, recordingConsentJurisdiction: null };
  }

  const now = new Date();

  const executor = input.tx ?? db;

  if (input.existingRecordingConsentId) {
    const [consent] = await executor
      .select()
      .from(growCallRecordingConsents)
      .where(
        and(
          eq(growCallRecordingConsents.id, input.existingRecordingConsentId),
          eq(growCallRecordingConsents.brokerageId, input.brokerageId),
          eq(growCallRecordingConsents.partyId, input.partyId),
        ),
      )
      .limit(1);
    if (
      consent &&
      consentIsCurrentlyActive(consent, now) &&
      (!input.expectedJurisdiction || consent.jurisdiction === input.expectedJurisdiction)
    ) {
      return {
        permitted: true,
        recordingStatus: "PERMITTED_NOT_CAPTURED",
        recordingConsentId: consent.id,
        recordingConsentJurisdiction: consent.jurisdiction,
      };
    }
    return {
      permitted: false,
      recordingStatus: "DENIED",
      recordingConsentId: null,
      recordingConsentJurisdiction: consent?.jurisdiction ?? null,
    };
  }

  const standingConsents = await executor
    .select()
    .from(growCallRecordingConsents)
    .where(
      and(
        eq(growCallRecordingConsents.brokerageId, input.brokerageId),
        eq(growCallRecordingConsents.partyId, input.partyId),
        eq(growCallRecordingConsents.scope, "STANDING"),
        eq(growCallRecordingConsents.status, "ACTIVE"),
        or(isNull(growCallRecordingConsents.expiresAt), gt(growCallRecordingConsents.expiresAt, now)),
      ),
    );

  const validStanding = standingConsents.find(
    (c) =>
      consentIsCurrentlyActive(c, now) &&
      (!input.expectedJurisdiction || c.jurisdiction === input.expectedJurisdiction),
  );
  if (validStanding) {
    return {
      permitted: true,
      recordingStatus: "PERMITTED_NOT_CAPTURED",
      recordingConsentId: validStanding.id,
      recordingConsentJurisdiction: validStanding.jurisdiction,
    };
  }

  return { permitted: false, recordingStatus: "DENIED", recordingConsentId: null, recordingConsentJurisdiction: null };
}

async function recomputeSessionRecordingPermission(
  callSessionId: number,
  consentIdJustChanged: number,
  tx?: ConsentTransaction,
): Promise<void> {
  const executor = tx ?? db;
  const [session] = await executor.select().from(growCallSessions).where(eq(growCallSessions.id, callSessionId)).limit(1);
  if (!session) return;
  // Consent evidence may change, but an in-call decline or closed call must
  // retain its recording outcome and original consent association.
  if (session.recordingStatus === "DECLINED" || TERMINAL_CALL_SESSION_STATUSES.includes(session.status)) return;

  const resolved = await resolveRecordingPermission({
    brokerageId: session.brokerageId,
    partyId: session.partyId,
    recordingRequested: session.recordingRequested,
    existingRecordingConsentId: consentIdJustChanged,
    expectedJurisdiction: session.destinationCountry,
    ...(tx ? { tx } : {}),
  });

  const previousPermitted = session.recordingPermitted;
  // F2 deliberately keeps recording disabled until an in-call disclosure and
  // explicit confirmation have completed.  A newly captured consent is only
  // evidence that the legacy F1 consent gate may pass; it is never a
  // pre-call recording grant.
  const nextStatus = !session.recordingRequested
    ? "NOT_REQUESTED"
    : resolved.permitted
      ? session.recordingStatus === "DISCLOSED"
        ? "DISCLOSED"
        : session.recordingStatus === "UNRECORDED" || session.recordingStatus === "DENIED"
          ? "DISCLOSURE_REQUIRED"
          : "UNRECORDED"
      : "UNRECORDED";
  const [updated] = await executor
    .update(growCallSessions)
    .set({
      recordingPermitted: false,
      recordingStatus: nextStatus,
      recordingConsentId: resolved.recordingConsentId,
      updatedAt: new Date(),
    })
    .where(and(eq(growCallSessions.id, callSessionId), eq(growCallSessions.status, session.status)))
    .returning();
  if (!updated) return;

  if (previousPermitted && !resolved.permitted) {
    await logAudit(
      {
        brokerageId: session.brokerageId,
        action: "grow_call_recording_permission_denied",
        recordType: "grow_call_session",
        recordId: String(callSessionId),
        previousValue: "PERMITTED_NOT_CAPTURED",
        updatedValue: resolved.recordingStatus,
      },
      tx ? { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) } : {},
    );
  }
}
