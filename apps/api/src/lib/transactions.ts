import { eq, and, ne } from "drizzle-orm";
import {
  db,
  offers,
  transactions,
  properties,
  propertyParties,
  workflows,
  workflowSteps,
  agencyAgreementTerms,
} from "@aee/db";
import type { Transaction, Offer } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { refreshTransactionSteps } from "./workflowSteps.js";
import { logAudit } from "./audit.js";

const TRANSACTION_STEPS = [
  { stepKey: "ContractSigning", label: "Contract Signing", sequence: 1 },
  { stepKey: "Settlement", label: "Settlement", sequence: 2 },
  { stepKey: "Payout", label: "Payout", sequence: 3 },
];

const GST_RATE_BPS = 1000; // 10% — AU GST, same convention as ServiceOrder pricing (Phase 4/6)

export interface AcceptOfferResult {
  offer: Offer;
  transaction: Transaction;
  created: boolean;
}

/**
 * Idempotent chokepoint (Build Brief §21 pattern, same shape as
 * initiateAmlIfNeeded / chargeServiceOrder): accepting an already-Accepted
 * offer just returns the existing Transaction rather than creating a
 * second one. Accepting also auto-declines every other still-Received
 * offer on the same property — a property can only have one accepted
 * offer at a time in this build (multiple concurrent transactions per
 * property, e.g. a fallen-through contract followed by a fresh sale, is
 * real future scope, documented rather than silently mishandled — see the
 * comment on refreshTransactionSteps).
 */
export async function acceptOffer(input: { offerId: number; userId: number; brokerageId: number }): Promise<AcceptOfferResult> {
  const [offer] = await db.select().from(offers).where(eq(offers.id, input.offerId));
  if (!offer) {
    throw new Error(`Offer ${input.offerId} not found`);
  }

  if (offer.status === "Accepted") {
    const [existingTransaction] = await db.select().from(transactions).where(eq(transactions.acceptedOfferId, offer.id));
    if (existingTransaction) {
      return { offer, transaction: existingTransaction, created: false };
    }
    // Offer says Accepted but no Transaction exists (shouldn't happen outside
    // a prior crash mid-acceptance) — fall through and create it below.
  } else if (offer.status !== "Received") {
    throw new Error(`Offer ${input.offerId} cannot be accepted from status ${offer.status}`);
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, offer.propertyId));
  if (!property) {
    throw new Error(`Property ${offer.propertyId} not found`);
  }

  // Auto-decline every other still-open offer on this property — you can't
  // accept two offers on the same sale.
  const siblingOffers = await db
    .select()
    .from(offers)
    .where(and(eq(offers.propertyId, offer.propertyId), eq(offers.status, "Received"), ne(offers.id, offer.id)));
  for (const sibling of siblingOffers) {
    await db.update(offers).set({ status: "Declined" }).where(eq(offers.id, sibling.id));
    await logAudit({
      userId: input.userId,
      action: "offer_auto_declined",
      recordType: "offer",
      recordId: String(sibling.id),
      propertyId: offer.propertyId,
      updatedValue: `Auto-declined: offer ${offer.id} was accepted instead.`,
    });
  }

  if (offer.status !== "Accepted") {
    await db.update(offers).set({ status: "Accepted" }).where(eq(offers.id, offer.id));
  }

  const sellerLinks = await db
    .select()
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, offer.propertyId), eq(propertyParties.role, "Seller")));

  const [transaction] = await db
    .insert(transactions)
    .values({
      propertyId: offer.propertyId,
      acceptedOfferId: offer.id,
      sellerPartyIds: sellerLinks.map((l) => l.partyId),
      buyerPartyIds: offer.buyerPartyId ? [offer.buyerPartyId] : [],
      purchasePriceCents: offer.offerPriceCents,
      status: "ContractPreparation",
    })
    .returning();

  let [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, offer.propertyId), eq(workflows.workflowType, "Transaction")));
  if (!workflow) {
    [workflow] = await db.insert(workflows).values({ propertyId: offer.propertyId, workflowType: "Transaction" }).returning();
    await db.insert(workflowSteps).values(TRANSACTION_STEPS.map((step) => ({ workflowId: workflow.id, ...step })));
  }

  await db.update(properties).set({ workflowStage: "Under Offer", updatedAt: new Date() }).where(eq(properties.id, offer.propertyId));
  await refreshTransactionSteps(offer.propertyId);

  await logAudit({
    userId: input.userId,
    action: "offer_accepted",
    recordType: "offer",
    recordId: String(offer.id),
    propertyId: offer.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "OFFER_ACCEPTED",
      occurredAt: new Date(),
      propertyId: offer.propertyId,
      transactionId: transaction.id,
      partyId: offer.buyerPartyId,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:offers:accept",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `offer-accepted:${offer.id}`,
      payload: { offerId: offer.id, transactionId: transaction.id, purchasePriceCents: transaction.purchasePriceCents },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(OFFER_ACCEPTED) failed", err);
  }

  const [finalOffer] = await db.select().from(offers).where(eq(offers.id, offer.id));
  return { offer: finalOffer, transaction, created: true };
}

async function loadTransaction(transactionId: number): Promise<Transaction> {
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!transaction) throw new Error(`Transaction ${transactionId} not found`);
  return transaction;
}

async function publishTransactionEvent(
  eventType:
    | "CONTRACT_SIGNED"
    | "FINANCE_APPROVED"
    | "SETTLEMENT_SCHEDULED"
    | "SETTLEMENT_COMPLETED"
    | "COMMISSION_CALCULATED"
    | "FUNDS_RECEIVED"
    | "AGENT_PAID"
    | "TRANSACTION_CLOSED",
  transaction: Transaction,
  input: { userId: number; brokerageId: number; idempotencyKey: string; payload?: Record<string, unknown> },
): Promise<void> {
  try {
    await publishDomainEvent({
      eventType,
      occurredAt: new Date(),
      propertyId: transaction.propertyId,
      transactionId: transaction.id,
      partyId: null,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:transactions",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      metadata: {},
    });
  } catch (err) {
    console.error(`publishDomainEvent(${eventType}) failed`, err);
  }
}

/** Idempotent — a second call after contractDate is already set is a no-op. */
export async function recordContractSigned(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  contractDate?: Date;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.contractDate) return transaction;

  const contractDate = input.contractDate ?? new Date();
  const [updated] = await db
    .update(transactions)
    .set({ contractDate, status: "UnderContract", updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await db.update(properties).set({ workflowStage: "Contract", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "contract_signed",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });
  await publishTransactionEvent("CONTRACT_SIGNED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `contract-signed:${transaction.id}`,
  });

  return updated;
}

/** Informational milestone — not every contract carries a finance condition, so this never gates transaction status. */
export async function recordFinanceApproved(input: { transactionId: number; userId: number; brokerageId: number }): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.financeApprovedAt) return transaction;

  const [updated] = await db
    .update(transactions)
    .set({ financeApprovedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "finance_approved",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });
  await publishTransactionEvent("FINANCE_APPROVED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `finance-approved:${transaction.id}`,
  });

  return updated;
}

/**
 * Not a one-shot chokepoint — rescheduling a settlement date is a
 * legitimate real-world action (both sides can agree to move the date), so
 * this always updates the date; the idempotency key is scoped to the exact
 * date so an identical duplicate call (e.g. a double-click) doesn't publish
 * a second identical event.
 */
export async function scheduleSettlement(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  settlementDate: Date;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.status === "Settled" || transaction.status === "Closed") {
    throw new Error(`Transaction ${transaction.id} has already settled — cannot reschedule.`);
  }

  const [updated] = await db
    .update(transactions)
    .set({ settlementDate: input.settlementDate, status: "SettlementScheduled", updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await db.update(properties).set({ workflowStage: "Settlement", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "settlement_scheduled",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
    updatedValue: input.settlementDate.toISOString(),
  });
  await publishTransactionEvent("SETTLEMENT_SCHEDULED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `settlement-scheduled:${transaction.id}:${input.settlementDate.toISOString()}`,
    payload: { settlementDate: input.settlementDate.toISOString() },
  });

  return updated;
}

/**
 * Commission calculation (Phase 7) — reads the real structured
 * agencyAgreementTerms captured in Phase 5 rather than any ad hoc figure.
 * Idempotent: once calculated, a second call is a no-op unless `force` is
 * passed (e.g. terms were corrected after the fact).
 */
export async function calculateCommission(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  force?: boolean;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.commissionCalculatedAt && !input.force) return transaction;

  const [terms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, transaction.propertyId));
  if (!terms) {
    throw new Error("Agency agreement terms have not been captured for this property — cannot calculate commission.");
  }

  const grossCommissionCents =
    terms.commissionType === "FlatFee"
      ? (terms.flatFeeCents ?? 0)
      : Math.round((transaction.purchasePriceCents * (terms.commissionRateBps ?? 0)) / 10000);
  const gstCents = Math.round((grossCommissionCents * GST_RATE_BPS) / 10000);

  const [updated] = await db
    .update(transactions)
    .set({ grossCommissionCents, gstCents, commissionCalculatedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "commission_calculated",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
    updatedValue: `gross=${grossCommissionCents} gst=${gstCents}`,
  });
  await publishTransactionEvent("COMMISSION_CALCULATED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `commission-calculated:${transaction.id}:${updated.commissionCalculatedAt!.toISOString()}`,
    payload: { grossCommissionCents, gstCents },
  });

  return updated;
}

/**
 * Idempotent chokepoint — requires a settlement date to already be
 * scheduled (can't complete what was never scheduled). On first
 * completion, also triggers commission calculation automatically (that's
 * when commission becomes real/invoiceable) if it hasn't run yet — a
 * missing/incomplete agencyAgreementTerms row doesn't block settlement
 * itself, it's logged and left for a manual calculate-commission retry.
 */
export async function completeSettlement(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  completedAt?: Date;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.settlementCompletedAt) return transaction;
  if (!transaction.settlementDate) {
    throw new Error(`Transaction ${transaction.id} has no settlement date scheduled yet.`);
  }

  const completedAt = input.completedAt ?? new Date();
  const [updated] = await db
    .update(transactions)
    .set({ settlementCompletedAt: completedAt, status: "Settled", updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "settlement_completed",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });
  await publishTransactionEvent("SETTLEMENT_COMPLETED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `settlement-completed:${transaction.id}`,
  });

  try {
    return await calculateCommission({ transactionId: transaction.id, userId: input.userId, brokerageId: input.brokerageId });
  } catch (err) {
    console.error("calculateCommission after settlement failed", err);
    return updated;
  }
}

/**
 * Manual bookkeeping record, not a real charge — additive, since funds can
 * legitimately arrive in more than one transfer (FUNDS_RECEIVED "may recur
 * for partial payments" per the event registry description).
 */
export async function recordFundsReceived(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  amountCents: number;
}): Promise<Transaction> {
  if (input.amountCents <= 0) {
    throw new Error("amountCents must be a positive number.");
  }
  const transaction = await loadTransaction(input.transactionId);

  const [updated] = await db
    .update(transactions)
    .set({
      fundsReceivedCents: transaction.fundsReceivedCents + input.amountCents,
      fundsReceivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "funds_received",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
    updatedValue: String(input.amountCents),
  });
  await publishTransactionEvent("FUNDS_RECEIVED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `funds-received:${transaction.id}:${updated.updatedAt.toISOString()}`,
    payload: { amountCents: input.amountCents, totalReceivedCents: updated.fundsReceivedCents },
  });

  return updated;
}

/** Idempotent — role-gated at the route layer (Brokerage Administrator), same precedent as refunds/exception-resolution. */
export async function recordAgentPaid(input: { transactionId: number; userId: number; brokerageId: number }): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.agentPaidAt) return transaction;
  if (!transaction.settlementCompletedAt) {
    throw new Error(`Transaction ${transaction.id} cannot be marked paid before settlement is completed.`);
  }

  const [updated] = await db
    .update(transactions)
    .set({ agentPaidAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "agent_paid",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });
  await publishTransactionEvent("AGENT_PAID", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `agent-paid:${transaction.id}`,
  });

  return updated;
}

/** Idempotent chokepoint — role-gated at the route layer (Brokerage Administrator), the final sign-off. */
export async function closeTransaction(input: { transactionId: number; userId: number; brokerageId: number }): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.status === "Closed") return transaction;
  if (transaction.status !== "Settled") {
    throw new Error(`Transaction ${transaction.id} cannot be closed before settlement is completed.`);
  }

  const [updated] = await db
    .update(transactions)
    .set({ status: "Closed", closedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await db.update(properties).set({ workflowStage: "Closed", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    userId: input.userId,
    action: "transaction_closed",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
  });
  await publishTransactionEvent("TRANSACTION_CLOSED", updated, {
    userId: input.userId,
    brokerageId: input.brokerageId,
    idempotencyKey: `transaction-closed:${transaction.id}`,
  });

  return updated;
}

export async function getTransactionByProperty(propertyId: number): Promise<Transaction | null> {
  const [transaction] = await db.select().from(transactions).where(eq(transactions.propertyId, propertyId));
  return transaction ?? null;
}
