// AE GROW Priority 6 Stage F2 step 1 — persistence boundary for the pure
// consent-control policy in consentControls.ts. No route is required for this
// step. Every lookup is scoped by brokerageId before a row is used, and every
// decision is insert-only evidence.

import { and, desc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  auditLogs,
  growConsentDecisions,
  growConsentPolicyVersions,
  growContactChannelConsents,
  growContactChannelSuppressions,
  growContactDncrStatuses,
  parties,
  users,
  type GrowConsentChannel,
  type GrowConsentPolicyVersion,
  type GrowConsentState,
} from "@aee/db";
import { logAudit, type AuditLogInput } from "./audit.js";
import {
  GROW_CONSENT_CHANNELS,
  GROW_CONSENT_STATES,
  GROW_DNCR_STATUSES,
  GROW_CONSENT_SUPPRESSION_STATES,
  evaluateConsentDecision,
  validateConsentCaptureEvidence,
  type ConsentDecisionResult,
  type ConsentPolicyForEvaluation,
  type ConsentRecordForEvaluation,
  type DncrStatusForEvaluation,
  type EvaluateConsentDecisionInput,
  type SuppressionForEvaluation,
} from "./consentControls.js";

export type ConsentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ConsentExecutor = ConsentTransaction | typeof db;
const CONSENT_ADVISORY_LOCK_NAMESPACE = 2076418031;

export async function writeAuditInTransaction(tx: ConsentTransaction, input: AuditLogInput): Promise<void> {
  await tx.insert(auditLogs).values(input);
}

async function lockConsentBrokerage(tx: ConsentTransaction, brokerageId: number): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${CONSENT_ADVISORY_LOCK_NAMESPACE}, ${brokerageId})`);
}

/**
 * Session lifecycle claims and consent writers must share this exact
 * transaction-scoped brokerage lock.  Callers that already hold the
 * transaction use the `...InTransaction` evaluator below; calling the public
 * evaluator from inside this callback would attempt to acquire the same
 * advisory lock on a second connection and can deadlock.
 */
export async function withConsentBrokerageLock<T>(
  brokerageId: number,
  callback: (tx: ConsentTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockConsentBrokerage(tx, brokerageId);
    return callback(tx);
  });
}

export class ConsentControlsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentControlsNotFoundError";
  }
}

export interface CaptureConsentStateInput {
  brokerageId: number;
  partyId: number;
  channel: GrowConsentChannel;
  state?: GrowConsentState;
  source: string;
  capturedAt?: Date;
  captureMethod: string;
  purpose: string;
  scope: string;
  evidenceReference?: string | null;
  evidence?: unknown;
  jurisdiction?: string | null;
  recordedByUserId: number;
  expiresAt?: Date | null;
  reviewAt?: Date | null;
  withdrawnAt?: Date | null;
  withdrawnByUserId?: number | null;
  withdrawalReason?: string | null;
  inferredReasoning?: string | null;
  relationshipEvidence?: unknown;
  inferredEvidenceReviewedAt?: Date | null;
  inferredEvidenceReviewedByUserId?: number | null;
  notRequiredJustification?: string | null;
  supersedesConsentId?: number | null;
}

async function assertPartyInBrokerage(tx: ConsentExecutor, brokerageId: number, partyId: number): Promise<void> {
  const [party] = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)))
    .limit(1);
  if (!party) throw new ConsentControlsNotFoundError("Contact not found in this brokerage.");
}

async function assertUserInBrokerage(tx: ConsentTransaction, brokerageId: number, userId: number): Promise<void> {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.brokerageId, brokerageId)))
    .limit(1);
  if (!user) throw new ConsentControlsNotFoundError("User not found in this brokerage.");
}

export async function captureConsentState(input: CaptureConsentStateInput) {
  return db.transaction(async (tx) => {
    await lockConsentBrokerage(tx, input.brokerageId);
    await assertPartyInBrokerage(tx, input.brokerageId, input.partyId);
    await assertUserInBrokerage(tx, input.brokerageId, input.recordedByUserId);

    const state = input.state ?? "UNKNOWN";
    if (!GROW_CONSENT_CHANNELS.includes(input.channel)) {
      throw new Error(`Unsupported consent channel: ${input.channel}`);
    }
    if (!GROW_CONSENT_STATES.includes(state)) throw new Error(`Unsupported consent state: ${state}`);
    if (!input.source.trim() || !input.captureMethod.trim() || !input.purpose.trim() || !input.scope.trim()) {
      throw new Error("Consent source, capture method, purpose, and scope are required.");
    }
    validateConsentCaptureEvidence({
      state,
      inferredReasoning: input.inferredReasoning,
      relationshipEvidence: input.relationshipEvidence,
      inferredEvidenceReviewedAt: input.inferredEvidenceReviewedAt,
      inferredEvidenceReviewedByUserId: input.inferredEvidenceReviewedByUserId,
      evidenceReference: input.evidenceReference,
      notRequiredJustification: input.notRequiredJustification,
      withdrawnAt: input.withdrawnAt,
      withdrawnByUserId: input.withdrawnByUserId,
      withdrawalReason: input.withdrawalReason,
    });

    if (input.withdrawnByUserId) await assertUserInBrokerage(tx, input.brokerageId, input.withdrawnByUserId);
    if (input.inferredEvidenceReviewedByUserId) {
      await assertUserInBrokerage(tx, input.brokerageId, input.inferredEvidenceReviewedByUserId);
    }
    if (input.inferredEvidenceReviewedAt && input.inferredEvidenceReviewedAt.getTime() > new Date().getTime()) {
      throw new Error("INFERRED evidence review time cannot be in the future.");
    }

    const [head] = await tx
      .select()
      .from(growContactChannelConsents)
      .where(
        and(
          eq(growContactChannelConsents.brokerageId, input.brokerageId),
          eq(growContactChannelConsents.partyId, input.partyId),
          eq(growContactChannelConsents.channel, input.channel),
          eq(growContactChannelConsents.purpose, input.purpose),
          eq(growContactChannelConsents.scope, input.scope),
        ),
      )
      .orderBy(desc(growContactChannelConsents.id))
      .limit(1);

    if (head?.state === "WITHDRAWN") {
      throw new Error("Consent purpose/scope stream is withdrawn; step 1 does not support re-consent.");
    }
    if (head && input.supersedesConsentId !== head.id) {
      throw new Error("Every append after the first consent must supersede the current purpose/scope head.");
    }
    if (!head && input.supersedesConsentId) {
      throw new ConsentControlsNotFoundError("Superseded consent is not in this brokerage/contact/channel/purpose/scope.");
    }
    if (state === "WITHDRAWN" && !head) {
      throw new Error("WITHDRAWN consent must supersede the current consent for the same purpose and scope.");
    }
    if (input.supersedesConsentId && head) {
      if (head.state === "WITHDRAWN") throw new Error("A withdrawn consent cannot be superseded.");
    }

    const [row] = await tx
      .insert(growContactChannelConsents)
      .values({
        brokerageId: input.brokerageId,
        partyId: input.partyId,
        channel: input.channel,
        state,
        source: input.source,
        // capturedAt is evidence metadata only; canonical ordering is serial
        // append order (id), never caller-provided capture time.
        capturedAt: input.capturedAt ?? new Date(),
        captureMethod: input.captureMethod,
        purpose: input.purpose,
        scope: input.scope,
        evidenceReference: input.evidenceReference ?? null,
        evidence: input.evidence ?? null,
        jurisdiction: input.jurisdiction ?? null,
        recordedByUserId: input.recordedByUserId,
        expiresAt: input.expiresAt ?? null,
        reviewAt: input.reviewAt ?? null,
        withdrawnAt: input.withdrawnAt ?? null,
        withdrawnByUserId: input.withdrawnByUserId ?? null,
        withdrawalReason: input.withdrawalReason ?? null,
        inferredReasoning: input.inferredReasoning ?? null,
        relationshipEvidence: input.relationshipEvidence ?? null,
        inferredEvidenceReviewedAt: input.inferredEvidenceReviewedAt ?? null,
        inferredEvidenceReviewedByUserId: input.inferredEvidenceReviewedByUserId ?? null,
        notRequiredJustification: input.notRequiredJustification ?? null,
        supersedesConsentId: input.supersedesConsentId ?? null,
      })
      .returning();

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.recordedByUserId,
        action: "grow_consent_state_captured",
        recordType: "grow_contact_channel_consent",
        recordId: String(row.id),
        updatedValue: JSON.stringify(row),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return row;
  });
}

export interface RecordConsentPolicyInput {
  brokerageId: number;
  jurisdiction: "AU" | "NZ";
  version: string;
  effectiveAt: Date;
  retiredAt?: Date | null;
  allowInferredConsent?: boolean;
  allowNotRequiredConsent?: boolean;
  dncrRequired: boolean;
  suppressionEnabled?: boolean;
  timeZone?: string | null;
  allowedHoursStart?: string | null;
  allowedHoursEnd?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  policyData?: unknown;
  recordedByUserId: number;
}

export async function recordConsentPolicy(input: RecordConsentPolicyInput): Promise<GrowConsentPolicyVersion> {
  return db.transaction(async (tx) => {
    await lockConsentBrokerage(tx, input.brokerageId);
    await assertUserInBrokerage(tx, input.brokerageId, input.recordedByUserId);
    if (!input.version.trim()) throw new Error("Consent policy version is required.");
    if (input.jurisdiction !== "AU" && input.jurisdiction !== "NZ") {
      throw new Error(`Unsupported consent policy jurisdiction: ${input.jurisdiction}`);
    }
    const [row] = await tx
      .insert(growConsentPolicyVersions)
      .values({
        brokerageId: input.brokerageId,
        jurisdiction: input.jurisdiction,
        version: input.version,
        effectiveAt: input.effectiveAt,
        retiredAt: input.retiredAt ?? null,
        allowInferredConsent: input.allowInferredConsent ?? false,
        allowNotRequiredConsent: input.allowNotRequiredConsent ?? false,
        dncrRequired: input.dncrRequired,
        suppressionEnabled: input.suppressionEnabled ?? true,
        timeZone: input.timeZone ?? null,
        allowedHoursStart: input.allowedHoursStart ?? null,
        allowedHoursEnd: input.allowedHoursEnd ?? null,
        quietHoursStart: input.quietHoursStart ?? null,
        quietHoursEnd: input.quietHoursEnd ?? null,
        policyData: input.policyData ?? {},
        recordedByUserId: input.recordedByUserId,
      })
      .returning();

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.recordedByUserId,
        action: "grow_consent_policy_version_recorded",
        recordType: "grow_consent_policy_version",
        recordId: String(row.id),
        updatedValue: JSON.stringify(row),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return row;
  });
}

export interface RecordDncrStatusInput {
  brokerageId: number;
  partyId: number;
  channel: GrowConsentChannel;
  jurisdiction?: "AU" | "NZ" | null;
  status: "CLEARED" | "LISTED" | "UNKNOWN" | "NOT_CHECKED";
  checkedAt?: Date;
  validUntil?: Date | null;
  reviewAt?: Date | null;
  source: string;
  reference?: string | null;
  responseMetadata?: unknown;
  recordedByUserId: number;
}

export async function recordDncrStatus(input: RecordDncrStatusInput) {
  return db.transaction(async (tx) => {
    await lockConsentBrokerage(tx, input.brokerageId);
    await assertPartyInBrokerage(tx, input.brokerageId, input.partyId);
    await assertUserInBrokerage(tx, input.brokerageId, input.recordedByUserId);
    if (!GROW_CONSENT_CHANNELS.includes(input.channel) || !input.source.trim()) {
      throw new Error("DNCR source and a supported consent channel are required.");
    }
    if (!GROW_DNCR_STATUSES.includes(input.status)) throw new Error(`Unsupported DNCR status: ${input.status}`);
    if (input.status === "CLEARED" && !input.reference?.trim()) {
      throw new Error("CLEARED DNCR status requires a provider-neutral supporting reference.");
    }
    if (input.status === "CLEARED" && (!input.validUntil || !input.reviewAt)) {
      throw new Error("CLEARED DNCR status requires validity and review timestamps.");
    }

    const [row] = await tx
      .insert(growContactDncrStatuses)
      .values({
        brokerageId: input.brokerageId,
        partyId: input.partyId,
        channel: input.channel,
        jurisdiction: input.jurisdiction ?? null,
        status: input.status,
        checkedAt: input.checkedAt ?? new Date(),
        validUntil: input.validUntil ?? null,
        reviewAt: input.reviewAt ?? null,
        source: input.source,
        reference: input.reference ?? null,
        responseMetadata: input.responseMetadata ?? null,
        recordedByUserId: input.recordedByUserId,
      })
      .returning();

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.recordedByUserId,
        action: "grow_dncr_status_recorded",
        recordType: "grow_contact_dncr_status",
        recordId: String(row.id),
        updatedValue: JSON.stringify(row),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return row;
  });
}

export interface RecordSuppressionInput {
  brokerageId: number;
  partyId: number;
  channel: GrowConsentChannel;
  state: "SUPPRESSED" | "RELEASED";
  reason: string;
  effectiveAt?: Date;
  expiresAt?: Date | null;
  reference?: string | null;
  recordedByUserId: number;
}

export async function recordConsentSuppression(input: RecordSuppressionInput) {
  return db.transaction(async (tx) => {
    await lockConsentBrokerage(tx, input.brokerageId);
    await assertPartyInBrokerage(tx, input.brokerageId, input.partyId);
    await assertUserInBrokerage(tx, input.brokerageId, input.recordedByUserId);
    if (!GROW_CONSENT_CHANNELS.includes(input.channel)) throw new Error(`Unsupported consent channel: ${input.channel}`);
    if (!GROW_CONSENT_SUPPRESSION_STATES.includes(input.state)) throw new Error(`Unsupported suppression state: ${input.state}`);
    if (!input.reason.trim()) throw new Error("Suppression requires a reason.");

    const [row] = await tx
      .insert(growContactChannelSuppressions)
      .values({
        brokerageId: input.brokerageId,
        partyId: input.partyId,
        channel: input.channel,
        state: input.state,
        reason: input.reason,
        effectiveAt: input.effectiveAt ?? new Date(),
        expiresAt: input.expiresAt ?? null,
        reference: input.reference ?? null,
        recordedByUserId: input.recordedByUserId,
      })
      .returning();

    await logAudit(
      {
        brokerageId: input.brokerageId,
        userId: input.recordedByUserId,
        action: input.state === "SUPPRESSED" ? "grow_consent_suppression_recorded" : "grow_consent_suppression_released",
        recordType: "grow_contact_channel_suppression",
        recordId: String(row.id),
        updatedValue: JSON.stringify(row),
      },
      { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
    );
    return row;
  });
}

async function latestConsent(
  tx: ConsentExecutor,
  brokerageId: number,
  partyId: number,
  channel: string,
  purpose: string,
  scope: string,
) {
  const [row] = await tx
    .select()
    .from(growContactChannelConsents)
    .where(
      and(
        eq(growContactChannelConsents.brokerageId, brokerageId),
        eq(growContactChannelConsents.partyId, partyId),
        eq(growContactChannelConsents.channel, channel),
        eq(growContactChannelConsents.purpose, purpose),
        eq(growContactChannelConsents.scope, scope),
      ),
    )
    // capturedAt is caller-provided evidence metadata. Serial id is the
    // append order and therefore the only canonical current-state ordering.
    .orderBy(desc(growContactChannelConsents.id))
    .limit(1);
  return row ?? null;
}

async function latestDncr(tx: ConsentExecutor, brokerageId: number, partyId: number, channel: string) {
  const [row] = await tx
    .select()
    .from(growContactDncrStatuses)
    .where(
      and(
        eq(growContactDncrStatuses.brokerageId, brokerageId),
        eq(growContactDncrStatuses.partyId, partyId),
        eq(growContactDncrStatuses.channel, channel),
      ),
    )
    .orderBy(desc(growContactDncrStatuses.id))
    .limit(1);
  return row ?? null;
}

async function latestSuppression(tx: ConsentExecutor, brokerageId: number, partyId: number, channel: string, now: Date) {
  const [row] = await tx
    .select()
    .from(growContactChannelSuppressions)
    .where(
      and(
        eq(growContactChannelSuppressions.brokerageId, brokerageId),
        eq(growContactChannelSuppressions.partyId, partyId),
        eq(growContactChannelSuppressions.channel, channel),
        lte(growContactChannelSuppressions.effectiveAt, now),
      ),
    )
    .orderBy(desc(growContactChannelSuppressions.id))
    .limit(1);
  return row ?? null;
}

async function policyFor(
  tx: ConsentExecutor,
  brokerageId: number,
  jurisdiction: string | null | undefined,
  now = new Date(),
): Promise<GrowConsentPolicyVersion | null> {
  if (jurisdiction !== "AU" && jurisdiction !== "NZ") return null;

  const [row] = await tx
    .select()
    .from(growConsentPolicyVersions)
    .where(
      and(
        eq(growConsentPolicyVersions.brokerageId, brokerageId),
        eq(growConsentPolicyVersions.jurisdiction, jurisdiction),
        lte(growConsentPolicyVersions.effectiveAt, now),
        or(isNull(growConsentPolicyVersions.retiredAt), gt(growConsentPolicyVersions.retiredAt, now)),
      ),
    )
    .orderBy(desc(growConsentPolicyVersions.effectiveAt), desc(growConsentPolicyVersions.id))
    .limit(1);
  return row ?? null;
}

export interface EvaluateAndRecordConsentDecisionInput {
  brokerageId: number;
  partyId: number;
  channel: GrowConsentChannel;
  purpose: string;
  scope: string;
  jurisdiction?: "AU" | "NZ" | null;
  decidedByUserId?: number | null;
}

export interface RecordedConsentDecision {
  decision: typeof growConsentDecisions.$inferSelect;
  evaluation: ConsentDecisionResult;
}

/**
 * Presentation reads use the same current-state lookups and pure evaluator as
 * the audited decision boundary, but deliberately do not append a decision or
 * audit row.  A read must never manufacture an id that could be mistaken for
 * an enforcement decision; mutating call actions continue to use
 * RecordedConsentDecision above.
 */
export interface ReadonlyConsentDecision {
  decision: null;
  evaluation: ConsentDecisionResult;
  evidence: {
    consentSnapshot: unknown;
    dncrSnapshot: unknown;
    suppressionSnapshot: unknown;
    policySnapshot: unknown;
  };
}

export async function evaluateConsentDecisionReadOnly(
  input: EvaluateAndRecordConsentDecisionInput,
): Promise<ReadonlyConsentDecision> {
  await assertPartyInBrokerage(db, input.brokerageId, input.partyId);
  if (!input.purpose.trim() || !input.scope.trim()) {
    throw new Error("Consent decision purpose and scope are required.");
  }
  if (!GROW_CONSENT_CHANNELS.includes(input.channel)) {
    throw new Error(`Unsupported channel: ${input.channel}`);
  }

  const now = new Date();
  const consent = await latestConsent(db, input.brokerageId, input.partyId, input.channel, input.purpose, input.scope);
  // Keep the jurisdiction and policy resolution exactly aligned with the
  // audited evaluator. The caller's jurisdiction remains an assertion only;
  // recorded consent is the canonical policy jurisdiction.
  const jurisdiction = consent?.jurisdiction ?? null;
  const policy = await policyFor(db, input.brokerageId, jurisdiction, now);
  const dncr = await latestDncr(db, input.brokerageId, input.partyId, input.channel);
  const suppression = await latestSuppression(db, input.brokerageId, input.partyId, input.channel, now);
  const evaluation = evaluateConsentDecision({
    channel: input.channel,
    purpose: input.purpose,
    scope: input.scope,
    jurisdiction: input.jurisdiction,
    consent: consent as ConsentRecordForEvaluation | null,
    dncr: dncr as DncrStatusForEvaluation | null,
    suppression: suppression as SuppressionForEvaluation | null,
    policy: policy as ConsentPolicyForEvaluation | null,
    now,
  });

  return {
    decision: null,
    evaluation,
    evidence: {
      consentSnapshot: consent,
      dncrSnapshot: dncr,
      suppressionSnapshot: suppression,
      policySnapshot: policy,
    },
  };
}

/**
 * Resolves all current inputs under one brokerage and appends one immutable
 * decision-evidence row. This function does not call a DNCR service.
 */
export async function evaluateAndRecordConsentDecisionInTransaction(
  tx: ConsentTransaction,
  input: EvaluateAndRecordConsentDecisionInput,
): Promise<RecordedConsentDecision> {
  await assertPartyInBrokerage(tx, input.brokerageId, input.partyId);
  if (input.decidedByUserId !== null && input.decidedByUserId !== undefined) {
    await assertUserInBrokerage(tx, input.brokerageId, input.decidedByUserId);
  }
  if (!input.purpose.trim() || !input.scope.trim()) {
    throw new Error("Consent decision purpose and scope are required.");
  }
  if (!GROW_CONSENT_CHANNELS.includes(input.channel)) {
    throw new Error(`Unsupported consent channel: ${input.channel}`);
  }

  // Eligibility timing is trusted server time; callers cannot replay an
  // evaluation at an arbitrary instant.
  const now = new Date();
  const consent = await latestConsent(tx, input.brokerageId, input.partyId, input.channel, input.purpose, input.scope);
  // Caller jurisdiction is only a consistency assertion. It cannot supply a
  // jurisdiction missing from the recorded consent.
  const jurisdiction = consent?.jurisdiction ?? null;
  const policy = await policyFor(tx, input.brokerageId, jurisdiction, now);
  const dncr = await latestDncr(tx, input.brokerageId, input.partyId, input.channel);
  const suppression = await latestSuppression(tx, input.brokerageId, input.partyId, input.channel, now);

  const evaluationInput: EvaluateConsentDecisionInput = {
    channel: input.channel,
    purpose: input.purpose,
    scope: input.scope,
    jurisdiction: input.jurisdiction,
    consent: consent as ConsentRecordForEvaluation | null,
    dncr: dncr as DncrStatusForEvaluation | null,
    suppression: suppression as SuppressionForEvaluation | null,
    policy: policy as ConsentPolicyForEvaluation | null,
    now,
  };
  const evaluation = evaluateConsentDecision(evaluationInput);

  // These rows and the evidence snapshot are read inside the same
  // transaction as the decision and its audit row.
  const evidence = {
    request: {
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      channel: input.channel,
      purpose: input.purpose,
      scope: input.scope,
      requestedJurisdiction: input.jurisdiction ?? null,
    },
    consentSnapshot: consent,
    dncrSnapshot: dncr,
    suppressionSnapshot: suppression,
    policySnapshot: policy,
    evaluation,
  };
  const [decision] = await tx
    .insert(growConsentDecisions)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      channel: input.channel,
      decision: evaluation.decision,
      reasonCode: evaluation.reasonCode,
      reasonCodes: evaluation.reasonCodes,
      consentId: consent?.id ?? null,
      dncrStatusId: dncr?.id ?? null,
      suppressionId: suppression?.id ?? null,
      policyVersionId: policy?.id ?? null,
      jurisdiction: evaluation.jurisdiction,
      policyVersion: evaluation.policyVersion,
      evaluatedAt: now,
      decidedByUserId: input.decidedByUserId ?? null,
      evidence,
    })
    .returning();

  await logAudit(
    {
      brokerageId: input.brokerageId,
      userId: input.decidedByUserId ?? undefined,
      action: "grow_consent_decision_recorded",
      recordType: "grow_consent_decision",
      recordId: String(decision.id),
      updatedValue: JSON.stringify(decision),
      providerReference: `grow-consent-decision:${decision.id}`,
    },
    { strict: true, write: (auditInput) => writeAuditInTransaction(tx, auditInput) },
  );

  return { decision, evaluation };
}

export async function evaluateAndRecordConsentDecision(input: EvaluateAndRecordConsentDecisionInput): Promise<RecordedConsentDecision> {
  return withConsentBrokerageLock(input.brokerageId, (tx) => evaluateAndRecordConsentDecisionInTransaction(tx, input));
}

// Short aliases for callers that want a shorter name. recordConsent is not
// one of them. That name is the legacy Comms Hub writer in
// lib/communications/consent.ts (communication_consent: destination-based
// marketing and transactional consent). Grow channel-consent capture is
// captureConsentState (grow_contact_channel_consents). Aliasing it as
// recordConsent made the two writers look interchangeable (A-11).
export const recordDncrObservation = recordDncrStatus;
export const recordSuppression = recordConsentSuppression;
export const decideConsent = evaluateAndRecordConsentDecision;