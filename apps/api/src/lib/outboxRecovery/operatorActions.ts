// Outbound recovery: operator visibility and resolution of MANUAL_REVIEW rows
// (specs/outbound-message-recovery.md §4). Brokerage-scoped: a row in another
// brokerage is reported NOT_FOUND, exactly like a row that does not exist.

import { and, asc, eq, sql } from "drizzle-orm";
import { db, communicationMessages, financialPaymentOutbox, integrationOutbox } from "@aee/db";
import { logger } from "@aee/events";
import { logAudit } from "../audit.js";
import { writeDeadLetter } from "../integrations/deadLetters.js";
import { applyMessageTransition } from "../communications/outbox.js";
import { CommunicationConcurrencyError, CommunicationTenancyError, CommunicationTransitionError } from "../communications/types.js";
import { MANUAL_REVIEW_STATUS } from "./policy.js";

export const MANUAL_REVIEW_QUEUES = ["integration_outbox", "financial_payment_outbox", "communication_messages"] as const;
export type ManualReviewQueue = (typeof MANUAL_REVIEW_QUEUES)[number];
/** Queues that carry Run (Pit Crew fee) money movement: resolving them also requires run.access. */
export const RUN_SCOPED_QUEUES: ManualReviewQueue[] = ["financial_payment_outbox"];

export const MANUAL_REVIEW_RESOLUTIONS = ["MARK_SENT", "MARK_FAILED", "REQUEUE"] as const;
export type ManualReviewResolution = (typeof MANUAL_REVIEW_RESOLUTIONS)[number];

export type OutboundRecoveryErrorCode =
  | "NOT_FOUND"
  | "ALREADY_RESOLVED"
  | "RESOLUTION_NOT_SUPPORTED"
  | "DUPLICATE_RISK_NOT_ACKNOWLEDGED"
  | "NOTE_REQUIRED";
export class OutboundRecoveryError extends Error {
  constructor(public readonly code: OutboundRecoveryErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "OutboundRecoveryError";
  }
}

export interface ManualReviewItem {
  queue: ManualReviewQueue;
  id: string;
  idempotencyKey: string | null;
  correlationId: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

export const MANUAL_REVIEW_LIST_LIMIT = 100;

export async function listManualReview(brokerageId: number): Promise<ManualReviewItem[]> {
  const [integ, pay, comms] = await Promise.all([
    db.select().from(integrationOutbox).where(and(eq(integrationOutbox.brokerageId, brokerageId), eq(integrationOutbox.status, MANUAL_REVIEW_STATUS))).orderBy(asc(integrationOutbox.updatedAt)).limit(MANUAL_REVIEW_LIST_LIMIT),
    db.select().from(financialPaymentOutbox).where(and(eq(financialPaymentOutbox.brokerageId, brokerageId), eq(financialPaymentOutbox.status, MANUAL_REVIEW_STATUS))).orderBy(asc(financialPaymentOutbox.updatedAt)).limit(MANUAL_REVIEW_LIST_LIMIT),
    db.select().from(communicationMessages).where(and(eq(communicationMessages.brokerageId, brokerageId), eq(communicationMessages.status, MANUAL_REVIEW_STATUS))).orderBy(asc(communicationMessages.updatedAt)).limit(MANUAL_REVIEW_LIST_LIMIT),
  ]);
  return [
    ...integ.map((r) => ({ queue: "integration_outbox" as const, id: r.id, idempotencyKey: r.idempotencyKey, correlationId: r.correlationId, attempts: r.attempts, lastError: r.lastError, updatedAt: r.updatedAt })),
    ...pay.map((r) => ({ queue: "financial_payment_outbox" as const, id: String(r.id), idempotencyKey: r.idempotencyKey, correlationId: r.correlationId ?? null, attempts: r.attempts, lastError: r.lastError ?? null, updatedAt: r.updatedAt })),
    ...comms.map((r) => ({ queue: "communication_messages" as const, id: String(r.id), idempotencyKey: r.idempotencyKey ?? null, correlationId: r.correlationId ?? null, attempts: r.retryCount ?? 0, lastError: r.failureDetail ?? null, updatedAt: r.updatedAt })),
  ];
}

export interface ResolveManualReviewInput {
  queue: ManualReviewQueue;
  id: string;
  brokerageId: number;
  actorUserId: number;
  resolution: ManualReviewResolution;
  /** Operator's evidence, e.g. the provider reference that proves delivery. Required for every resolution. */
  note: string;
  /** REQUEUE re-sends a message whose earlier send may have been delivered. The operator must accept that explicitly. */
  acknowledgeDuplicateRisk?: boolean;
}

export async function resolveManualReview(input: ResolveManualReviewInput): Promise<{ queue: ManualReviewQueue; id: string; status: string }> {
  const note = input.note?.trim();
  if (!note) throw new OutboundRecoveryError("NOTE_REQUIRED");
  if (input.resolution === "REQUEUE" && input.acknowledgeDuplicateRisk !== true) throw new OutboundRecoveryError("DUPLICATE_RISK_NOT_ACKNOWLEDGED");

  const status = await resolveInQueue(input, note.slice(0, 500));
  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.actorUserId,
    action: `outbound_recovery_manual_${input.resolution.toLowerCase()}`,
    recordType: input.queue,
    recordId: input.id,
    previousValue: MANUAL_REVIEW_STATUS,
    updatedValue: `${status}: ${note.slice(0, 200)}`,
  } as Parameters<typeof logAudit>[0]);
  logger.warn("outbound_recovery_manual_resolved", { queue: input.queue, id: input.id, brokerageId: input.brokerageId, resolution: input.resolution, actorUserId: input.actorUserId });
  return { queue: input.queue, id: input.id, status };
}

async function resolveInQueue(input: ResolveManualReviewInput, note: string): Promise<string> {
  if (input.queue === "integration_outbox") {
    const [row] = await db.select().from(integrationOutbox).where(and(eq(integrationOutbox.id, input.id), eq(integrationOutbox.brokerageId, input.brokerageId)));
    if (!row) throw new OutboundRecoveryError("NOT_FOUND");
    if (row.status !== MANUAL_REVIEW_STATUS) throw new OutboundRecoveryError("ALREADY_RESOLVED");
    const guard = and(eq(integrationOutbox.id, row.id), eq(integrationOutbox.brokerageId, input.brokerageId), eq(integrationOutbox.status, MANUAL_REVIEW_STATUS));
    const set =
      input.resolution === "MARK_SENT"
        ? { status: "SENT", dispatchedAt: new Date(), lastError: null, updatedAt: new Date() }
        : input.resolution === "MARK_FAILED"
          ? { status: "DEAD_LETTERED", lastError: `manual review: marked failed (${note})`, updatedAt: new Date() }
          : { status: "RETRY_SCHEDULED", nextAttemptAt: sql`now()`, lastError: `manual review: requeued, duplicate risk acknowledged (${note})`, updatedAt: new Date() };
    const [updated] = await db.update(integrationOutbox).set(set as never).where(guard).returning();
    if (!updated) throw new OutboundRecoveryError("ALREADY_RESOLVED");
    if (input.resolution === "MARK_FAILED") {
      // Lands on the existing audited dead-letter replay path.
      await writeDeadLetter({ brokerageId: row.brokerageId, connectionId: row.connectionId, sourceType: "OUTBOX", sourceId: row.id, reason: "MANUAL_REVIEW_MARKED_FAILED", payloadSnapshot: row.commandPayload } as Parameters<typeof writeDeadLetter>[0]);
    }
    return updated.status;
  }

  if (input.queue === "financial_payment_outbox") {
    const id = Number(input.id);
    if (!Number.isSafeInteger(id)) throw new OutboundRecoveryError("NOT_FOUND");
    const [row] = await db.select().from(financialPaymentOutbox).where(and(eq(financialPaymentOutbox.id, id), eq(financialPaymentOutbox.brokerageId, input.brokerageId)));
    if (!row) throw new OutboundRecoveryError("NOT_FOUND");
    if (row.status !== MANUAL_REVIEW_STATUS) throw new OutboundRecoveryError("ALREADY_RESOLVED");
    // MARK_SENT would have to record the provider's debit reference and ledger event; that is a financial correction,
    // not a queue action, so it is refused here. Use MARK_FAILED, or REQUEUE (same idempotency key; the mandate
    // provider replays rather than double-debits).
    if (input.resolution === "MARK_SENT") throw new OutboundRecoveryError("RESOLUTION_NOT_SUPPORTED");
    const set =
      input.resolution === "MARK_FAILED"
        ? { status: "FAILED", lastError: `manual review: marked failed (${note})`, updatedAt: new Date() }
        : { status: "PENDING", nextAttemptAt: sql`now()`, lastError: `manual review: requeued, duplicate risk acknowledged (${note})`, updatedAt: new Date() };
    const [updated] = await db
      .update(financialPaymentOutbox)
      .set(set as never)
      .where(and(eq(financialPaymentOutbox.id, id), eq(financialPaymentOutbox.brokerageId, input.brokerageId), eq(financialPaymentOutbox.status, MANUAL_REVIEW_STATUS)))
      .returning();
    if (!updated) throw new OutboundRecoveryError("ALREADY_RESOLVED");
    return updated.status;
  }

  const id = Number(input.id);
  if (!Number.isSafeInteger(id)) throw new OutboundRecoveryError("NOT_FOUND");
  const [row] = await db.select().from(communicationMessages).where(and(eq(communicationMessages.id, id), eq(communicationMessages.brokerageId, input.brokerageId)));
  if (!row) throw new OutboundRecoveryError("NOT_FOUND");
  if (row.status !== MANUAL_REVIEW_STATUS) throw new OutboundRecoveryError("ALREADY_RESOLVED");
  try {
    const updated = await applyMessageTransition({
      messageId: id,
      brokerageId: input.brokerageId,
      toStatus: input.resolution === "MARK_SENT" ? "SENT" : input.resolution === "MARK_FAILED" ? "FAILED" : "RETRY_SCHEDULED",
      expectedVersion: row.version,
      actorUserId: input.actorUserId,
      auditAction: `communication_message_manual_${input.resolution.toLowerCase()}`,
      patch:
        input.resolution === "REQUEUE"
          ? { scheduledAt: new Date(), failureDetail: `manual review: requeued, duplicate risk acknowledged (${note})` }
          : { failureDetail: input.resolution === "MARK_FAILED" ? `manual review: marked failed (${note})` : null },
    });
    return updated.status;
  } catch (err) {
    if (err instanceof CommunicationTenancyError) throw new OutboundRecoveryError("NOT_FOUND");
    if (err instanceof CommunicationConcurrencyError || err instanceof CommunicationTransitionError) throw new OutboundRecoveryError("ALREADY_RESOLVED");
    throw err;
  }
}
