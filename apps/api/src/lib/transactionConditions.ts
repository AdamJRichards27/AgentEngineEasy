import { eq } from "drizzle-orm";
import { db, transactionConditions, transactions, properties } from "@aee/db";
import type { TransactionCondition, Transaction, ContractConditionStatus } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";

// Stage E — Contract & Conditions (Agent Engine 2.0 — Run Transaction
// Vertical Slice, #118). CONTRACT_EXCHANGED and TRANSACTION_UNCONDITIONAL
// existed in the canonical event registry with zero publishers before this
// file. "Unconditional" is treated as vacuously true once a transaction has
// been exchanged and every recorded condition is in a non-blocking state —
// a transaction with no tracked conditions at all becomes unconditional the
// moment it's exchanged, same as a real cash/unconditional contract.
const RESOLVED_NON_BLOCKING_STATUSES: ContractConditionStatus[] = ["Satisfied", "Waived", "NotApplicable"];

/**
 * R-F30 — Closed is terminal for condition and exchange writers too.
 * Call only on a path that would write. Exchange and unconditional
 * replays that return before any write stay successful.
 */
function refuseClosedTransaction(transaction: { id: number; status: string }): void {
  if (transaction.status === "Closed") {
    throw new Error(`Transaction ${transaction.id} is closed — no further changes can be recorded.`);
  }
}

async function loadTransactionInBrokerage(transactionId: number, brokerageId: number): Promise<Transaction> {
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
  const [property] = await db.select().from(properties).where(eq(properties.id, transaction.propertyId));
  if (!property || property.brokerageId !== brokerageId) throw new Error(`Transaction ${transactionId} not found`);
  return transaction;
}

export async function listConditions(transactionId: number): Promise<TransactionCondition[]> {
  return db.select().from(transactionConditions).where(eq(transactionConditions.transactionId, transactionId));
}

export async function addCondition(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  description: string;
  dueDate?: Date | null;
}): Promise<TransactionCondition> {
  const transaction = await loadTransactionInBrokerage(input.transactionId, input.brokerageId);
  refuseClosedTransaction(transaction);
  if (transaction.unconditionalAt) {
    throw new Error(`Transaction ${transaction.id} is already unconditional — cannot add further conditions.`);
  }

  const [condition] = await db
    .insert(transactionConditions)
    .values({
      transactionId: input.transactionId,
      description: input.description,
      dueDate: input.dueDate ?? null,
      dueDateHistory: [],
      status: "Pending",
    })
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "transaction_condition_added",
    recordType: "transaction_condition",
    recordId: String(condition.id),
    propertyId: transaction.propertyId,
    updatedValue: input.description,
  });

  return condition;
}

/** Governing spec §16: date changes must preserve audit history — every prior due date is appended to dueDateHistory, never overwritten in place. */
export async function rescheduleConditionDueDate(input: {
  conditionId: number;
  userId: number;
  brokerageId: number;
  newDueDate: Date | null;
}): Promise<TransactionCondition> {
  const [condition] = await db.select().from(transactionConditions).where(eq(transactionConditions.id, input.conditionId));
  if (!condition) throw new Error(`Condition ${input.conditionId} not found`);
  const transaction = await loadTransactionInBrokerage(condition.transactionId, input.brokerageId);
  refuseClosedTransaction(transaction);

  const history = Array.isArray(condition.dueDateHistory) ? condition.dueDateHistory : [];
  const nextHistory = [
    ...history,
    {
      previousDueDate: condition.dueDate ? condition.dueDate.toISOString() : null,
      changedAt: new Date().toISOString(),
      changedByUserId: input.userId,
    },
  ];

  const [updated] = await db
    .update(transactionConditions)
    .set({ dueDate: input.newDueDate, dueDateHistory: nextHistory, updatedAt: new Date() })
    .where(eq(transactionConditions.id, condition.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "transaction_condition_rescheduled",
    recordType: "transaction_condition",
    recordId: String(condition.id),
    propertyId: transaction.propertyId,
    previousValue: condition.dueDate ? condition.dueDate.toISOString() : "none",
    updatedValue: input.newDueDate ? input.newDueDate.toISOString() : "none",
  });

  return updated;
}

/**
 * Resolves one condition (Satisfied / Waived / Failed / NotApplicable).
 * Re-resolving an already-resolved condition to a different status is
 * allowed — a compliance record, not a one-shot chokepoint — but always
 * records who made the *current* call. After resolving, checks whether the
 * transaction as a whole is now eligible to become unconditional (see
 * maybeRecordUnconditional below) — this is the path that fires
 * TRANSACTION_UNCONDITIONAL automatically for the common case, without a
 * separate manual step.
 */
export async function resolveCondition(input: {
  conditionId: number;
  userId: number;
  brokerageId: number;
  status: Exclude<ContractConditionStatus, "Pending">;
  notes?: string;
}): Promise<TransactionCondition> {
  const [condition] = await db.select().from(transactionConditions).where(eq(transactionConditions.id, input.conditionId));
  if (!condition) throw new Error(`Condition ${input.conditionId} not found`);
  const transaction = await loadTransactionInBrokerage(condition.transactionId, input.brokerageId);
  refuseClosedTransaction(transaction);

  const [updated] = await db
    .update(transactionConditions)
    .set({
      status: input.status,
      resolvedAt: new Date(),
      resolvedByUserId: input.userId,
      notes: input.notes ?? condition.notes,
      updatedAt: new Date(),
    })
    .where(eq(transactionConditions.id, condition.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "transaction_condition_resolved",
    recordType: "transaction_condition",
    recordId: String(condition.id),
    propertyId: transaction.propertyId,
    updatedValue: input.status,
  });

  await maybeRecordUnconditional({ transactionId: transaction.id, userId: input.userId, brokerageId: input.brokerageId }).catch((err) =>
    logger.error("maybe_record_unconditional_after_condition_resolved_failed", {
      transactionId: transaction.id,
      conditionId: condition.id,
      status: input.status,
      error: err,
    }),
  );

  return updated;
}

/** Idempotent — recording exchange twice is a no-op. Requires the contract to already be signed (contractDate set). */
export async function recordExchange(input: { transactionId: number; userId: number; brokerageId: number }): Promise<Transaction> {
  const transaction = await loadTransactionInBrokerage(input.transactionId, input.brokerageId);
  if (transaction.exchangedAt) return transaction;
  refuseClosedTransaction(transaction);
  if (!transaction.contractDate) {
    throw new Error(`Transaction ${transaction.id} cannot be exchanged before the contract is signed.`);
  }

  await db.update(transactions).set({ exchangedAt: new Date(), updatedAt: new Date() }).where(eq(transactions.id, transaction.id));

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "contract_exchanged",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "CONTRACT_EXCHANGED",
      occurredAt: new Date(),
      propertyId: transaction.propertyId,
      transactionId: transaction.id,
      partyId: null,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:transactions:exchange",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `contract-exchanged:${transaction.id}`,
      payload: { transactionId: transaction.id },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType: "CONTRACT_EXCHANGED", propertyId: transaction.propertyId, transactionId: transaction.id, error: err });
  }

  const afterUnconditionalCheck = await maybeRecordUnconditional({
    transactionId: transaction.id,
    userId: input.userId,
    brokerageId: input.brokerageId,
  }).catch((err) => {
    logger.error("maybe_record_unconditional_after_exchange_failed", { transactionId: transaction.id, error: err });
    return null;
  });

  if (afterUnconditionalCheck) return afterUnconditionalCheck;
  const [finalTransaction] = await db.select().from(transactions).where(eq(transactions.id, transaction.id));
  return finalTransaction;
}

/**
 * Idempotent — internal (called after every condition resolves and after
 * exchange) and externally callable as an explicit "mark unconditional"
 * action. Requires exchange to have happened first; requires every
 * recorded condition to be in a non-blocking state (Satisfied / Waived /
 * NotApplicable) — a transaction with zero conditions, or all-resolved
 * conditions, is vacuously eligible. A "Failed" condition deliberately
 * blocks this: it means the contract has not become unconditional as-is —
 * resolving it to Waived instead is the explicit way to record "the
 * parties proceeded anyway."
 */
export async function maybeRecordUnconditional(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
}): Promise<Transaction> {
  const transaction = await loadTransactionInBrokerage(input.transactionId, input.brokerageId);
  if (transaction.unconditionalAt) return transaction;
  if (!transaction.exchangedAt) return transaction;

  const conditions = await db.select().from(transactionConditions).where(eq(transactionConditions.transactionId, transaction.id));
  const allResolved = conditions.every((c) => RESOLVED_NON_BLOCKING_STATUSES.includes(c.status as ContractConditionStatus));
  if (!allResolved) return transaction;
  refuseClosedTransaction(transaction);

  const [updated] = await db
    .update(transactions)
    .set({ unconditionalAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "transaction_unconditional",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "TRANSACTION_UNCONDITIONAL",
      occurredAt: new Date(),
      propertyId: transaction.propertyId,
      transactionId: transaction.id,
      partyId: null,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:transactions:unconditional",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `transaction-unconditional:${transaction.id}`,
      payload: { transactionId: transaction.id },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType: "TRANSACTION_UNCONDITIONAL", propertyId: transaction.propertyId, transactionId: transaction.id, error: err });
  }

  return updated;
}
