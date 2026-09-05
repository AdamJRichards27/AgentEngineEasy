// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// State-transition layer over risk_exceptions / risk_exception_transitions.
// Every exported function here is the ONLY way any of those two tables is
// ever written — routes and the engine's scan loop both call through this
// module, mirroring the existing domain-service convention (compare
// apps/api/src/lib/automation/tasks.ts, attentionItems.ts).
//
// Concurrency (Build Instructions §23): createOrUpdateException takes a
// Postgres advisory transaction lock keyed on the finding's dedup key
// before its read-check-write, so two concurrent evaluations of the same
// underlying condition (an event-driven rule firing at the same moment a
// scheduled scan re-evaluates it, or two scan workers) serialise instead
// of racing. See packages/db/src/schema/exceptions.ts's own comment on
// openDedupKey for the second, DB-constraint layer of protection.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  riskExceptions,
  riskExceptionTransitions,
  properties,
  type RiskException,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId, currentCorrelationId } from "@aee/events";
import { logAudit } from "../audit.js";
import {
  RISK_EXCEPTION_METADATA_ALLOW_LIST,
  OPEN_RISK_EXCEPTION_STATUSES,
  type RiskFinding,
  type ResolutionEvidence,
  type RiskExceptionMetadataKey,
} from "./types.js";

export class RiskExceptionError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

function sanitizeMetadata(input: RiskFinding["metadata"]): Record<string, string | number> | null {
  if (!input) return null;
  const out: Record<string, string | number> = {};
  for (const key of RISK_EXCEPTION_METADATA_ALLOW_LIST as readonly RiskExceptionMetadataKey[]) {
    const value = input[key];
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// hashtext() is Postgres' built-in 32-bit string hash — good enough for an
// advisory lock key (collisions just serialise two unrelated dedup keys
// against each other occasionally, which costs a little contention, never
// correctness). pg_advisory_xact_lock auto-releases at transaction end
// (commit or rollback). Every read/write inside fn() runs on the SAME `tx`
// the lock was taken on, so a concurrent call for the same dedup key
// genuinely cannot observe or write anything until this transaction
// commits — not just "probably won't race in practice".
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function withDedupLock<T>(dedupKey: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dedupKey}))`);
    return fn(tx);
  });
}

export type CreateOrUpdateOutcome = "CREATED" | "UPDATED_STILL_OPEN" | "REOPENED" | "NEW_OCCURRENCE" | "UNCHANGED";

export interface CreateOrUpdateResult {
  exception: RiskException;
  outcome: CreateOrUpdateOutcome;
}

/**
 * The single entry point every rule detection (event-driven or
 * time-driven) funnels through. Idempotent per dedup key (Build
 * Instructions §11): re-detecting the same still-open problem updates the
 * existing row (occurrence count, evidence, severity if the rule says it
 * escalated) rather than creating a duplicate; detecting a problem whose
 * last occurrence was resolved/dismissed either reopens that row or starts
 * a new linked occurrence, per the rule's own declared recurrenceMode.
 */
export async function createOrUpdateException(
  finding: RiskFinding,
  brokerageId: number,
  propertyId: number,
  transactionId: number | null,
  correlationId: string,
  causationId: string | null,
): Promise<CreateOrUpdateResult> {
  const result = await withDedupLock(finding.dedupKey, async (tx) => {
    const [openRow] = await tx.select().from(riskExceptions).where(eq(riskExceptions.openDedupKey, finding.dedupKey));

    if (openRow) {
      return updateExistingOpenException(tx, openRow, finding);
    }

    const [priorClosed] = await tx
      .select()
      .from(riskExceptions)
      .where(eq(riskExceptions.dedupKey, finding.dedupKey))
      .orderBy(sql`${riskExceptions.createdAt} desc`)
      .limit(1);

    if (priorClosed && (priorClosed.status === "RESOLVED" || priorClosed.status === "DISMISSED")) {
      if (finding.recurrenceMode === "REOPEN") {
        return reopenClosedException(tx, priorClosed, finding);
      }
      return insertException(tx, finding, brokerageId, propertyId, transactionId, correlationId, causationId, priorClosed.id);
    }

    return insertException(tx, finding, brokerageId, propertyId, transactionId, correlationId, causationId, null);
  });

  // Best-effort side effects run only AFTER the transaction above has
  // actually committed (packages/events/src/publisher.ts's own documented
  // contract: "persist first, publish second — call this AFTER the write
  // it describes has already committed"). logAudit is independently
  // resilient by design (see lib/audit.ts) and never throws.
  await applyPostCommitEffects(result, finding, propertyId, transactionId, correlationId, causationId);
  return result;
}

async function applyPostCommitEffects(
  result: CreateOrUpdateResult,
  finding: RiskFinding,
  propertyId: number,
  transactionId: number | null,
  correlationId: string,
  causationId: string | null,
): Promise<void> {
  const { exception, outcome } = result;

  if (outcome === "CREATED" || outcome === "NEW_OCCURRENCE") {
    await logAudit({
      action: "risk_exception_opened",
      recordType: "risk_exception",
      recordId: exception.id,
      propertyId,
      updatedValue: exception.title,
    });
    await publishDomainEvent({
      eventType: "EXCEPTION_CREATED",
      occurredAt: new Date(),
      propertyId,
      transactionId,
      partyId: null,
      brokerageId: exception.brokerageId,
      agentId: null,
      actorType: "SYSTEM",
      actorId: null,
      source: `exception-engine:rule:${finding.ruleId}`,
      correlationId,
      causationId,
      idempotencyKey: null,
      payload: { exceptionId: exception.id, ruleId: finding.ruleId, severity: finding.severity, category: finding.category },
      metadata: {},
    }).catch((err) => console.error("publishDomainEvent(EXCEPTION_CREATED) failed", err));
    return;
  }

  if (outcome === "REOPENED") {
    await logAudit({
      action: "risk_exception_reopened",
      recordType: "risk_exception",
      recordId: exception.id,
      propertyId,
      updatedValue: exception.title,
    });
    return;
  }

  if (outcome === "UPDATED_STILL_OPEN") {
    // updateExistingOpenException already recorded the SEVERITY_CHANGED
    // transition (inside the same tx as the row update, since that ledger
    // entry must never be inconsistent with the row it describes); this is
    // just the best-effort audit-log mirror of it.
    await logAudit({
      action: "risk_exception_severity_changed",
      recordType: "risk_exception",
      recordId: exception.id,
      propertyId,
      updatedValue: exception.severity,
    });
  }
}

async function insertException(
  tx: Tx,
  finding: RiskFinding,
  brokerageId: number,
  propertyId: number,
  transactionId: number | null,
  correlationId: string,
  causationId: string | null,
  previousOccurrenceId: string | null,
): Promise<CreateOrUpdateResult> {
  const now = new Date();
  const [created] = await tx
    .insert(riskExceptions)
    .values({
      brokerageId,
      propertyId,
      transactionId,
      ruleId: finding.ruleId,
      ruleVersion: finding.ruleVersion,
      category: finding.category,
      severity: finding.severity,
      title: finding.title,
      problemDescription: finding.problemDescription,
      businessImpact: finding.businessImpact,
      detectedCause: finding.detectedCause,
      ownerType: finding.ownerType,
      ownerUserId: finding.ownerUserId,
      detectedAt: now,
      dueAt: finding.dueAt,
      escalatesAt: finding.escalatesAt,
      status: "OPEN",
      recommendedAction: finding.recommendedAction,
      resolutionRequirements: finding.resolutionRequirements,
      dismissible: finding.dismissible,
      sourceRecordType: finding.sourceRecordType,
      sourceRecordId: finding.sourceRecordId,
      correlationId,
      causationId,
      relatedTaskIds: [],
      relatedExecutionIds: [],
      dedupKey: finding.dedupKey,
      openDedupKey: finding.dedupKey,
      occurrenceCount: 1,
      lastDetectedAt: now,
      lastEvaluatedAt: now,
      previousOccurrenceId,
      metadata: sanitizeMetadata(finding.metadata),
      requiresFinancialEntitlement: finding.requiresFinancialEntitlement,
    })
    .returning();

  await recordTransition(tx, created.id, brokerageId, "OPENED", { toValue: "OPEN", actorType: "SYSTEM", ruleVersion: finding.ruleVersion });

  return { exception: created, outcome: previousOccurrenceId ? "NEW_OCCURRENCE" : "CREATED" };
}

async function updateExistingOpenException(tx: Tx, existing: RiskException, finding: RiskFinding): Promise<CreateOrUpdateResult> {
  const now = new Date();
  const severityChanged = existing.severity !== finding.severity;

  const materialChange =
    severityChanged ||
    existing.dueAt?.getTime() !== finding.dueAt?.getTime() ||
    existing.escalatesAt?.getTime() !== finding.escalatesAt?.getTime() ||
    existing.problemDescription !== finding.problemDescription;

  const [updated] = await tx
    .update(riskExceptions)
    .set({
      severity: finding.severity,
      title: finding.title,
      problemDescription: finding.problemDescription,
      businessImpact: finding.businessImpact,
      detectedCause: finding.detectedCause,
      dueAt: finding.dueAt,
      escalatesAt: finding.escalatesAt,
      recommendedAction: finding.recommendedAction,
      resolutionRequirements: finding.resolutionRequirements,
      ruleVersion: finding.ruleVersion,
      occurrenceCount: sql`${riskExceptions.occurrenceCount} + 1`,
      lastDetectedAt: now,
      lastEvaluatedAt: now,
      metadata: sanitizeMetadata(finding.metadata),
      updatedAt: now,
    })
    .where(eq(riskExceptions.id, existing.id))
    .returning();

  if (severityChanged) {
    await recordTransition(tx, existing.id, existing.brokerageId, "SEVERITY_CHANGED", {
      fromValue: existing.severity,
      toValue: finding.severity,
      actorType: "SYSTEM",
      ruleVersion: finding.ruleVersion,
      reason: "Deterministic re-evaluation",
    });
  }

  return { exception: updated, outcome: materialChange ? "UPDATED_STILL_OPEN" : "UNCHANGED" };
}

async function reopenClosedException(tx: Tx, priorClosed: RiskException, finding: RiskFinding): Promise<CreateOrUpdateResult> {
  const now = new Date();
  const [reopened] = await tx
    .update(riskExceptions)
    .set({
      status: "REOPENED",
      openDedupKey: finding.dedupKey,
      severity: finding.severity,
      title: finding.title,
      problemDescription: finding.problemDescription,
      businessImpact: finding.businessImpact,
      detectedCause: finding.detectedCause,
      dueAt: finding.dueAt,
      escalatesAt: finding.escalatesAt,
      recommendedAction: finding.recommendedAction,
      resolutionRequirements: finding.resolutionRequirements,
      ruleVersion: finding.ruleVersion,
      occurrenceCount: sql`${riskExceptions.occurrenceCount} + 1`,
      lastDetectedAt: now,
      lastEvaluatedAt: now,
      resolvedAt: null,
      resolvedByUserId: null,
      resolutionEvidence: null,
      resolutionMethod: null,
      dismissalReason: null,
      metadata: sanitizeMetadata(finding.metadata),
      updatedAt: now,
    })
    .where(eq(riskExceptions.id, priorClosed.id))
    .returning();

  await recordTransition(tx, priorClosed.id, priorClosed.brokerageId, "REOPENED", {
    fromValue: priorClosed.status,
    toValue: "REOPENED",
    actorType: "SYSTEM",
    ruleVersion: finding.ruleVersion,
    reason: "Condition recurred after resolution",
  });

  return { exception: reopened, outcome: "REOPENED" };
}

async function recordTransition(
  client: Tx | typeof db,
  exceptionId: string,
  brokerageId: number,
  transitionType: string,
  opts: {
    fromValue?: string | null;
    toValue?: string | null;
    reason?: string | null;
    actorType: "SYSTEM" | "USER";
    actorUserId?: number | null;
    ruleVersion?: number | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  await client.insert(riskExceptionTransitions).values({
    exceptionId,
    brokerageId,
    transitionType,
    fromValue: opts.fromValue ?? null,
    toValue: opts.toValue ?? null,
    reason: opts.reason ?? null,
    actorType: opts.actorType,
    actorUserId: opts.actorUserId ?? null,
    ruleVersion: opts.ruleVersion ?? null,
    metadata: opts.metadata ?? null,
  });
}

async function assertTenantAndLoad(exceptionId: string, brokerageId: number): Promise<RiskException> {
  const [row] = await db.select().from(riskExceptions).where(eq(riskExceptions.id, exceptionId));
  if (!row || row.brokerageId !== brokerageId) {
    // Deliberately identical to a nonexistent id — Build Instructions §21:
    // "Cross-tenant requests must not reveal whether the exception exists."
    throw new RiskExceptionError("NOT_FOUND", "Exception not found");
  }
  return row;
}

export interface ActorRef {
  id: number;
  role: string;
}

export async function acknowledgeException(exceptionId: string, brokerageId: number, actor: ActorRef): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (existing.status !== "OPEN" && existing.status !== "REOPENED") {
    throw new RiskExceptionError("INVALID_STATUS", `Cannot acknowledge an exception in status ${existing.status}`);
  }
  const [updated] = await db
    .update(riskExceptions)
    .set({ status: "ACKNOWLEDGED", updatedAt: new Date() })
    .where(eq(riskExceptions.id, exceptionId))
    .returning();
  await recordTransition(db, exceptionId, brokerageId, "ACKNOWLEDGED", { fromValue: existing.status, toValue: "ACKNOWLEDGED", actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "risk_exception_acknowledged", recordType: "risk_exception", recordId: exceptionId, propertyId: existing.propertyId });
  return updated;
}

export async function startRemediation(exceptionId: string, brokerageId: number, actor: ActorRef): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (!["OPEN", "ACKNOWLEDGED", "REOPENED", "AWAITING_EXTERNAL"].includes(existing.status)) {
    throw new RiskExceptionError("INVALID_STATUS", `Cannot start remediation on an exception in status ${existing.status}`);
  }
  const [updated] = await db
    .update(riskExceptions)
    .set({ status: "IN_PROGRESS", updatedAt: new Date() })
    .where(eq(riskExceptions.id, exceptionId))
    .returning();
  await recordTransition(db, exceptionId, brokerageId, "REMEDIATION_STARTED", { fromValue: existing.status, toValue: "IN_PROGRESS", actorType: "USER", actorUserId: actor.id });
  await logAudit({ userId: actor.id, action: "risk_exception_remediation_started", recordType: "risk_exception", recordId: exceptionId, propertyId: existing.propertyId });
  return updated;
}

export async function markAwaitingExternal(exceptionId: string, brokerageId: number, actor: ActorRef, note: string): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (!OPEN_RISK_EXCEPTION_STATUSES.includes(existing.status as any)) {
    throw new RiskExceptionError("INVALID_STATUS", `Cannot mark an exception in status ${existing.status} as awaiting external`);
  }
  const [updated] = await db
    .update(riskExceptions)
    .set({ status: "AWAITING_EXTERNAL", updatedAt: new Date() })
    .where(eq(riskExceptions.id, exceptionId))
    .returning();
  await recordTransition(db, exceptionId, brokerageId, "AWAITING_EXTERNAL", { fromValue: existing.status, toValue: "AWAITING_EXTERNAL", actorType: "USER", actorUserId: actor.id, reason: note });
  await logAudit({ userId: actor.id, action: "risk_exception_awaiting_external", recordType: "risk_exception", recordId: exceptionId, propertyId: existing.propertyId, updatedValue: note });
  return updated;
}

async function finalizeResolution(existing: RiskException, method: "AUTO" | "MANUAL", evidence: ResolutionEvidence, resolvedByUserId: number | null): Promise<RiskException> {
  const now = new Date();
  const [updated] = await db
    .update(riskExceptions)
    .set({
      status: "RESOLVED",
      openDedupKey: `${existing.dedupKey}:closed:${existing.id}`,
      resolvedAt: now,
      resolvedByUserId,
      resolutionEvidence: evidence,
      resolutionMethod: method,
      updatedAt: now,
    })
    .where(eq(riskExceptions.id, existing.id))
    .returning();

  await recordTransition(db, existing.id, existing.brokerageId, "RESOLVED", {
    fromValue: existing.status,
    toValue: "RESOLVED",
    actorType: method === "AUTO" ? "SYSTEM" : "USER",
    actorUserId: resolvedByUserId,
    metadata: { evidence },
  });
  await logAudit({
    userId: resolvedByUserId ?? undefined,
    action: method === "AUTO" ? "risk_exception_auto_resolved" : "risk_exception_resolved",
    recordType: "risk_exception",
    recordId: existing.id,
    propertyId: existing.propertyId,
    updatedValue: existing.title,
  });
  await publishDomainEvent({
    eventType: "EXCEPTION_RESOLVED",
    occurredAt: now,
    propertyId: existing.propertyId,
    transactionId: existing.transactionId,
    partyId: null,
    brokerageId: existing.brokerageId,
    agentId: null,
    actorType: method === "AUTO" ? "SYSTEM" : "USER",
    actorId: resolvedByUserId,
    source: `exception-engine:rule:${existing.ruleId}`,
    correlationId: existing.correlationId,
    causationId: existing.id,
    idempotencyKey: null,
    payload: { exceptionId: existing.id, ruleId: existing.ruleId, method },
    metadata: {},
  }).catch((err) => console.error("publishDomainEvent(EXCEPTION_RESOLVED) failed", err));

  return updated;
}

/** Called only by the engine's rescan loop, never by a route directly — an auto-resolution is a system decision made from authoritative evidence. */
export async function autoResolveException(exceptionId: string, brokerageId: number, evidence: ResolutionEvidence): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (existing.status === "RESOLVED" || existing.status === "DISMISSED") return existing;
  return finalizeResolution(existing, "AUTO", evidence, null);
}

export type ManualResolveDenialReason = "NOT_FOUND" | "INVALID_STATUS" | "REQUIRES_AUTHORITATIVE_EVIDENCE";

/**
 * Manual, human-attested resolution (Build Instructions §14). A CRITICAL,
 * non-dismissible exception can never be resolved this way — its
 * resolutionRequirements demand the underlying authoritative record
 * actually change (a condition satisfied through the real conditions
 * route, AML completed through the real AML pathway, etc.), which then
 * auto-resolves it on the next evaluation. This function's job is to
 * refuse exactly that "just mark it resolved" shortcut for the exceptions
 * where it would mean overriding a mandatory compliance/settlement state,
 * while still allowing it for anything the rule marked dismissible=true or
 * that is below CRITICAL severity, where a human confirming (with a
 * reason and evidence) something has been handled outside the app is
 * legitimate.
 */
export async function resolveExceptionManually(
  exceptionId: string,
  brokerageId: number,
  actor: ActorRef,
  note: string,
): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (existing.status === "RESOLVED" || existing.status === "DISMISSED") {
    throw new RiskExceptionError("INVALID_STATUS", `Exception is already ${existing.status}`);
  }
  if (existing.severity === "CRITICAL" && !existing.dismissible) {
    throw new RiskExceptionError(
      "REQUIRES_AUTHORITATIVE_EVIDENCE",
      "This exception can only be resolved by correcting the underlying record through its authorised pathway — it cannot be manually overridden.",
    );
  }
  const evidence: ResolutionEvidence = { kind: "MANUAL", note, recordedByUserId: actor.id };
  return finalizeResolution(existing, "MANUAL", evidence, actor.id);
}

export type DismissDenialReason = "NOT_FOUND" | "INVALID_STATUS" | "NOT_DISMISSIBLE";

export async function dismissException(exceptionId: string, brokerageId: number, actor: ActorRef, reason: string): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (existing.status === "RESOLVED" || existing.status === "DISMISSED") {
    throw new RiskExceptionError("INVALID_STATUS", `Exception is already ${existing.status}`);
  }
  if (!existing.dismissible) {
    throw new RiskExceptionError("NOT_DISMISSIBLE", "This exception's rule does not permit dismissal — it must be resolved with evidence.");
  }
  const now = new Date();
  const [updated] = await db
    .update(riskExceptions)
    .set({
      status: "DISMISSED",
      openDedupKey: `${existing.dedupKey}:closed:${existing.id}`,
      dismissalReason: reason,
      resolvedAt: now,
      resolvedByUserId: actor.id,
      resolutionMethod: "MANUAL",
      updatedAt: now,
    })
    .where(eq(riskExceptions.id, exceptionId))
    .returning();
  await recordTransition(db, exceptionId, brokerageId, "DISMISSED", { fromValue: existing.status, toValue: "DISMISSED", actorType: "USER", actorUserId: actor.id, reason });
  await logAudit({ userId: actor.id, action: "risk_exception_dismissed", recordType: "risk_exception", recordId: exceptionId, propertyId: existing.propertyId, updatedValue: reason });
  return updated;
}

export type ReassignDenialReason = "NOT_FOUND" | "INVALID_STATUS";

export async function reassignOwner(
  exceptionId: string,
  brokerageId: number,
  actor: ActorRef,
  ownerType: RiskException["ownerType"],
  ownerUserId: number | null,
  reason: string,
): Promise<RiskException> {
  const existing = await assertTenantAndLoad(exceptionId, brokerageId);
  if (existing.status === "RESOLVED" || existing.status === "DISMISSED") {
    throw new RiskExceptionError("INVALID_STATUS", `Cannot reassign an exception in status ${existing.status}`);
  }
  const [updated] = await db
    .update(riskExceptions)
    .set({ ownerType, ownerUserId, reassignmentCount: sql`${riskExceptions.reassignmentCount} + 1`, updatedAt: new Date() })
    .where(eq(riskExceptions.id, exceptionId))
    .returning();
  await recordTransition(db, exceptionId, brokerageId, "OWNER_ASSIGNED", {
    fromValue: `${existing.ownerType}:${existing.ownerUserId ?? ""}`,
    toValue: `${ownerType}:${ownerUserId ?? ""}`,
    actorType: "USER",
    actorUserId: actor.id,
    reason,
  });
  await logAudit({ userId: actor.id, action: "risk_exception_reassigned", recordType: "risk_exception", recordId: exceptionId, propertyId: existing.propertyId, updatedValue: `${ownerType}:${ownerUserId ?? ""}` });
  return updated;
}

export async function attachRelatedTask(exceptionId: string, taskId: string): Promise<void> {
  await db
    .update(riskExceptions)
    .set({ relatedTaskIds: sql`${riskExceptions.relatedTaskIds} || ${JSON.stringify([taskId])}::jsonb`, updatedAt: new Date() })
    .where(eq(riskExceptions.id, exceptionId));
}

export async function markEvaluated(exceptionId: string): Promise<void> {
  await db.update(riskExceptions).set({ lastEvaluatedAt: new Date() }).where(eq(riskExceptions.id, exceptionId));
}

export async function recordEvaluationFailure(exceptionId: string, brokerageId: number, error: string): Promise<void> {
  await recordTransition(db, exceptionId, brokerageId, "EVALUATION_FAILED", { actorType: "SYSTEM", reason: error });
}

/** Tenant + property chokepoint, matching the #123/#131 precedent (assertPropertyInBrokerage). */
export async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new RiskExceptionError("NOT_FOUND", `Property ${propertyId} not found`);
}

export { newCorrelationId, currentCorrelationId };
