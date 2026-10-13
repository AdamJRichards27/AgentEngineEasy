import { eq, and, ne, inArray, desc } from "drizzle-orm";
import {
  db,
  offers,
  transactions,
  properties,
  propertyParties,
  workflows,
  workflowSteps,
  agencyAgreementTerms,
  transactionConditions,
  amlVerifications,
  automationAttentionItems,
  automationTasks,
  financialDisputes,
  financialPaymentRequests,
  financialReconciliations,
  commissionCalculations,
  riskExceptions,
  OPEN_RISK_EXCEPTION_STATUSES,
} from "@aee/db";
import type { Transaction, Offer } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { refreshTransactionSteps } from "./workflowSteps.js";
import { logAudit } from "./audit.js";
import { initiateAmlIfNeeded } from "./aml.js";
import { completeSatisfiedAutomationTasks } from "./automation/closureAutoComplete.js";
import { MUST_COMPLETE_BEFORE_CLOSE_TASK_KEYS } from "./automation/closurePolicy.js";
import { computeFundsReconciliation } from "./transactionFunds.js";

const TRANSACTION_STEPS = [
  { stepKey: "ContractSigning", label: "Contract Signing", sequence: 1 },
  { stepKey: "Settlement", label: "Settlement", sequence: 2 },
  { stepKey: "Payout", label: "Payout", sequence: 3 },
];

const GST_RATE_BPS = 1000; // 10% — AU GST, same convention as ServiceOrder pricing (Phase 4/6)

/**
 * R-F30 — Closed is terminal. Call this only on a path that would write.
 * Idempotent replays that return before any write must not call it, so a
 * repeat of contract-signed / settlement-complete / agent-paid / close
 * stays a 200. Plain Error keeps the router's existing 400.
 */
function refuseClosedTransaction(transaction: { id: number; status: string }): void {
  if (transaction.status === "Closed") {
    throw new Error(`Transaction ${transaction.id} is closed — no further changes can be recorded.`);
  }
}

/**
 * R-F36 — unconditional status is `unconditionalAt` (transactionConditions.ts
 * sets it once the contract is exchanged and every tracked condition is
 * non-blocking, including the zero-condition case). This is the same check
 * closeTransaction uses. There is no override.
 */
function transactionIsUnconditional(transaction: { unconditionalAt: Date | null }): boolean {
  return Boolean(transaction.unconditionalAt);
}

export interface AcceptOfferResult {
  offer: Offer;
  transaction: Transaction;
  created: boolean;
}

interface OfferConditionsPayload {
  depositCents?: number;
  settlementDate?: string;
  conditions?: string;
  additionalTerms?: string;
}

interface AcceptOfferTxOutcome {
  offer: Offer;
  transaction: Transaction;
  created: boolean;
  propertyId: number;
  declinedSiblingIds: number[];
}

/**
 * Idempotent chokepoint (Build Brief §21 pattern, same shape as
 * initiateAmlIfNeeded / chargeServiceOrder): accepting an already-Accepted
 * offer just returns the existing Transaction rather than creating a
 * second one. Accepting also auto-declines every other still-Received
 * offer on the same property — a property can only have one accepted
 * offer at a time in this build.
 *
 * Run Transaction Vertical Slice (#117) — this codebase's first use of
 * db.transaction(). "One accepted offer per property" is a per-property
 * invariant, not a per-offer one — two different agents accepting two
 * different offers on the same property at the same instant is a real
 * race an offer-row-level check alone cannot close (each request sees its
 * own offer row as still Received). Locking the PROPERTY row
 * (SELECT ... FOR UPDATE) for the duration of the accept serialises any
 * concurrent accept attempt on the same property, so the second request to
 * reach the lock always sees state that already reflects the first.
 *
 * #117 also closes a confirmed data-loss gap: the conditions captured on
 * the offer (deposit, settlement date, free-text conditions/additional
 * terms — see PropertyWorkspace.tsx's OffersBlock capture form) were
 * previously discarded at acceptance. They are now carried forward onto
 * the Transaction's structured fields and into a transactionConditions row.
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
    // Offer says Accepted but no Transaction exists (shouldn't happen
    // outside a prior crash mid-acceptance) — fall through and create it.
  } else if (offer.status !== "Received") {
    throw new Error(`Offer ${input.offerId} cannot be accepted from status ${offer.status}`);
  }

  const outcome = await db.transaction(async (tx): Promise<AcceptOfferTxOutcome> => {
    const [property] = await tx.select().from(properties).where(eq(properties.id, offer.propertyId)).for("update");
    if (!property) {
      throw new Error(`Property ${offer.propertyId} not found`);
    }

    // Re-read the offer under the property lock — a concurrent accept on a
    // sibling offer for this property may have auto-declined this one, or
    // another request may have already accepted this exact offer, between
    // the pre-lock read above and acquiring the lock.
    const [lockedOffer] = await tx.select().from(offers).where(eq(offers.id, offer.id));
    if (!lockedOffer) {
      throw new Error(`Offer ${input.offerId} not found`);
    }
    if (lockedOffer.status === "Accepted") {
      const [existingTransaction] = await tx.select().from(transactions).where(eq(transactions.acceptedOfferId, lockedOffer.id));
      if (existingTransaction) {
        return { offer: lockedOffer, transaction: existingTransaction, created: false, propertyId: lockedOffer.propertyId, declinedSiblingIds: [] };
      }
    } else if (lockedOffer.status !== "Received") {
      throw new Error(`Offer ${input.offerId} cannot be accepted from status ${lockedOffer.status}`);
    }

    const siblingOffers = await tx
      .select()
      .from(offers)
      .where(and(eq(offers.propertyId, lockedOffer.propertyId), eq(offers.status, "Received"), ne(offers.id, lockedOffer.id)));
    for (const sibling of siblingOffers) {
      await tx.update(offers).set({ status: "Declined" }).where(eq(offers.id, sibling.id));
    }

    if (lockedOffer.status !== "Accepted") {
      await tx.update(offers).set({ status: "Accepted" }).where(eq(offers.id, lockedOffer.id));
    }

    const sellerLinks = await tx
      .select()
      .from(propertyParties)
      .where(and(eq(propertyParties.propertyId, lockedOffer.propertyId), eq(propertyParties.role, "Seller")));

    const offerConditions = (lockedOffer.conditions ?? {}) as OfferConditionsPayload;
    const depositCents = typeof offerConditions.depositCents === "number" ? offerConditions.depositCents : null;
    const parsedSettlementDate = offerConditions.settlementDate ? new Date(offerConditions.settlementDate) : null;
    const settlementDate = parsedSettlementDate && !Number.isNaN(parsedSettlementDate.getTime()) ? parsedSettlementDate : null;

    const [transaction] = await tx
      .insert(transactions)
      .values({
        propertyId: lockedOffer.propertyId,
        acceptedOfferId: lockedOffer.id,
        sellerPartyIds: sellerLinks.map((l) => l.partyId),
        buyerPartyIds: lockedOffer.buyerPartyId ? [lockedOffer.buyerPartyId] : [],
        purchasePriceCents: lockedOffer.offerPriceCents,
        depositCents,
        settlementDate,
        status: "ContractPreparation",
      })
      .returning();

    if (offerConditions.conditions && offerConditions.conditions.trim().length > 0) {
      await tx.insert(transactionConditions).values({
        transactionId: transaction.id,
        description: offerConditions.conditions.trim(),
        dueDateHistory: [],
        status: "Pending",
        notes: offerConditions.additionalTerms?.trim() ? `Additional terms from offer: ${offerConditions.additionalTerms.trim()}` : null,
      });
    }

    let [workflow] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.propertyId, lockedOffer.propertyId), eq(workflows.workflowType, "Transaction")));
    if (!workflow) {
      [workflow] = await tx.insert(workflows).values({ propertyId: lockedOffer.propertyId, workflowType: "Transaction" }).returning();
      await tx.insert(workflowSteps).values(TRANSACTION_STEPS.map((step) => ({ workflowId: workflow.id, ...step })));
    }

    await tx.update(properties).set({ workflowStage: "Under Offer", updatedAt: new Date() }).where(eq(properties.id, lockedOffer.propertyId));

    const [finalOffer] = await tx.select().from(offers).where(eq(offers.id, lockedOffer.id));
    return {
      offer: finalOffer,
      transaction,
      created: true,
      propertyId: lockedOffer.propertyId,
      declinedSiblingIds: siblingOffers.map((s) => s.id),
    };
  });

  if (!outcome.created) {
    return { offer: outcome.offer, transaction: outcome.transaction, created: false };
  }

  // Side effects that must only run once the accepting transaction has
  // actually committed: refreshTransactionSteps re-reads committed state,
  // and logAudit/publishDomainEvent must never fire for a change that got
  // rolled back.
  for (const siblingId of outcome.declinedSiblingIds) {
    await logAudit({
      brokerageId: input.brokerageId,
      userId: input.userId,
      action: "offer_auto_declined",
      recordType: "offer",
      recordId: String(siblingId),
      propertyId: outcome.propertyId,
      updatedValue: `Auto-declined: offer ${outcome.offer.id} was accepted instead.`,
    });
  }

  await refreshTransactionSteps(outcome.propertyId);

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "offer_accepted",
    recordType: "offer",
    recordId: String(outcome.offer.id),
    propertyId: outcome.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "OFFER_ACCEPTED",
      occurredAt: new Date(),
      propertyId: outcome.propertyId,
      transactionId: outcome.transaction.id,
      partyId: outcome.offer.buyerPartyId,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:offers:accept",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `offer-accepted:${outcome.offer.id}`,
      payload: { offerId: outcome.offer.id, transactionId: outcome.transaction.id, purchasePriceCents: outcome.transaction.purchasePriceCents },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", {
      eventType: "OFFER_ACCEPTED",
      propertyId: outcome.propertyId,
      transactionId: outcome.transaction.id,
      partyId: outcome.offer.buyerPartyId,
      error: err,
    });
  }

  return { offer: outcome.offer, transaction: outcome.transaction, created: true };
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
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", {
      eventType,
      propertyId: transaction.propertyId,
      transactionId: transaction.id,
      error: err,
    });
  }
}

/**
 * Idempotent — a second call after contractDate is already set is a no-op,
 * including after the transaction is Closed.
 *
 * R-F30 — never move status or workflowStage backward. UnderContract /
 * workflowStage Contract is set only from ContractPreparation. A later
 * status (SettlementScheduled, and anything else that is not Settled or
 * Closed) still records the contract date, buyer AML, the audit row, and
 * CONTRACT_SIGNED, and leaves status and workflowStage where they are.
 * Settled or Closed with no contract date is refused: those states cannot
 * acquire a contract date after the fact.
 */
export async function recordContractSigned(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  contractDate?: Date;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.contractDate) return transaction;
  refuseClosedTransaction(transaction);
  if (transaction.status === "Settled") {
    throw new Error(`Transaction ${transaction.id} cannot record a signed contract after settlement.`);
  }

  const contractDate = input.contractDate ?? new Date();
  const advanceToUnderContract = transaction.status === "ContractPreparation";
  const [updated] = await db
    .update(transactions)
    .set({
      contractDate,
      ...(advanceToUnderContract ? { status: "UnderContract" } : {}),
      updatedAt: new Date(),
    })
    .where(eq(transactions.id, transaction.id))
    .returning();

  if (advanceToUnderContract) {
    await db.update(properties).set({ workflowStage: "Contract", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
  }
  await refreshTransactionSteps(transaction.propertyId);

  // Stage F (#119) — AML/CTF buyer-party linkage. Sellers are AML-checked
  // at Ready to List (routes/properties.ts); buyers were never initiated
  // anywhere in this codebase — a confirmed gap. Contract signing is the
  // first point a buyer is a committed party to a real transaction, so
  // that's where their check starts. Idempotent — initiateAmlIfNeeded
  // (lib/aml.ts) is a no-op for a party that already has a verification row.
  const buyerPartyIds = Array.isArray(updated.buyerPartyIds) ? (updated.buyerPartyIds as number[]) : [];
  for (const partyId of buyerPartyIds) {
    try {
      await initiateAmlIfNeeded({ propertyId: updated.propertyId, partyId, userId: input.userId, brokerageId: input.brokerageId });
    } catch (err) {
      logger.error("initiate_aml_if_needed_failed", { propertyId: updated.propertyId, partyId, error: err });
    }
  }

  await logAudit({
    brokerageId: input.brokerageId,
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
  refuseClosedTransaction(transaction);

  const [updated] = await db
    .update(transactions)
    .set({ financeApprovedAt: new Date(), updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await logAudit({
    brokerageId: input.brokerageId,
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
  if (!transaction.contractDate) {
    throw new Error(`Transaction ${transaction.id} cannot schedule settlement before the contract is signed.`);
  }

  const [updated] = await db
    .update(transactions)
    .set({ settlementDate: input.settlementDate, status: "SettlementScheduled", updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  await db.update(properties).set({ workflowStage: "Settlement", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
  await refreshTransactionSteps(transaction.propertyId);

  await logAudit({
    brokerageId: input.brokerageId,
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
  refuseClosedTransaction(transaction);

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
    brokerageId: input.brokerageId,
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
 * scheduled (can't complete what was never scheduled), a signed contract,
 * and unconditional status. The unconditional check is the same
 * `unconditionalAt` predicate closeTransaction uses. There is no override
 * and no force flag. scheduleSettlement is unchanged and does not require
 * unconditional status.
 *
 * On first completion, also triggers commission calculation automatically
 * (that's when commission becomes real/invoiceable) if it hasn't run yet —
 * a missing/incomplete agencyAgreementTerms row doesn't block settlement
 * itself, it's logged and left for a manual calculate-commission retry.
 *
 * A repeat after settlementCompletedAt is already set returns the row
 * without writing, including when the transaction is already Settled.
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
  if (!transaction.contractDate) {
    throw new Error(`Transaction ${transaction.id} cannot complete settlement before the contract is signed.`);
  }
  refuseClosedTransaction(transaction);
  if (!transactionIsUnconditional(transaction)) {
    throw new Error(`Transaction ${transaction.id} cannot complete settlement until it is unconditional.`);
  }

  const completedAt = input.completedAt ?? new Date();

  // Part B Stage 2 remediation (open item: "synchronously refreshed
  // projection, non-atomic"): the transactions write and the workflowSteps
  // refresh now commit together. Previously these were two separate
  // statements, and the idempotent guard above
  // (`if (transaction.settlementCompletedAt) return transaction;`) meant a
  // crash between them left workflowSteps permanently stale — a retry
  // would see settlementCompletedAt already set and return immediately,
  // never re-running the refresh. Same db.transaction() pattern acceptOffer
  // already uses elsewhere in this file.
  const updated = await db.transaction(async (tx): Promise<Transaction> => {
    const [row] = await tx
      .update(transactions)
      .set({ settlementCompletedAt: completedAt, status: "Settled", updatedAt: new Date() })
      .where(eq(transactions.id, transaction.id))
      .returning();

    await refreshTransactionSteps(transaction.propertyId, tx);
    return row;
  });

  await logAudit({
    brokerageId: input.brokerageId,
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
    logger.error("calculate_commission_after_settlement_failed", { transactionId: transaction.id, propertyId: transaction.propertyId, error: err });
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
  refuseClosedTransaction(transaction);

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
    brokerageId: input.brokerageId,
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
  refuseClosedTransaction(transaction);
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
    brokerageId: input.brokerageId,
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

/**
 * Stage D/F (#117) — sets/updates the transaction's legal representatives.
 * Either side can be set/cleared independently (undefined leaves the
 * existing value untouched; explicit null clears it) so a solicitor change
 * mid-transaction never loses the other side's value. References parties
 * already linked to the property with role "Solicitor" — this reuses the
 * existing party-capture UI, it does not invent a second solicitor entry
 * path.
 */
export async function recordLegalRepresentatives(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  sellerSolicitorPartyId?: number | null;
  buyerSolicitorPartyId?: number | null;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  refuseClosedTransaction(transaction);
  const existing = (transaction.legalRepresentatives ?? {}) as {
    sellerSolicitorPartyId?: number | null;
    buyerSolicitorPartyId?: number | null;
  };

  const legalRepresentatives = {
    sellerSolicitorPartyId:
      input.sellerSolicitorPartyId !== undefined ? input.sellerSolicitorPartyId : (existing.sellerSolicitorPartyId ?? null),
    buyerSolicitorPartyId:
      input.buyerSolicitorPartyId !== undefined ? input.buyerSolicitorPartyId : (existing.buyerSolicitorPartyId ?? null),
  };

  const [updated] = await db
    .update(transactions)
    .set({ legalRepresentatives, updatedAt: new Date() })
    .where(eq(transactions.id, transaction.id))
    .returning();

  const auditId = await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: "transaction_legal_representatives_updated",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
    updatedValue: JSON.stringify(legalRepresentatives),
  });

  try {
    await completeSatisfiedAutomationTasks({
      brokerageId: input.brokerageId,
      propertyId: updated.propertyId,
      transactionId: updated.id,
      eventType: "transaction_legal_representatives_updated",
      eventId: auditId != null ? String(auditId) : `transaction-legal-representatives:${updated.id}`,
      correlationId: currentCorrelationId(),
    });
  } catch (err) {
    logger.error("closure_auto_complete_failed", {
      eventType: "transaction_legal_representatives_updated",
      transactionId: updated.id,
      brokerageId: input.brokerageId,
      error: err,
    });
  }

  return updated;
}

/** Thrown by closeTransaction when real, unresolved blockers exist and the caller did not pass `force`. */
export class TransactionClosureBlockedError extends Error {
  blockers: string[];
  constructor(blockers: string[]) {
    super(`Transaction cannot be closed: ${blockers.join("; ")}`);
    this.name = "TransactionClosureBlockedError";
    this.blockers = blockers;
  }
}

/**
 * Stage H (#121) — closure preconditions. Closure previously only checked
 * `status === "Settled"`; it did not check that the transaction had
 * actually become unconditional, that every tracked condition was
 * resolved, that buyer AML/CTF verification had cleared, or that no open
 * WAE attention item / active WAE task remained outstanding for this
 * transaction. R-F42 counts only the must-finish automation tasks (O2, C4,
 * S1, S2, S3) and adds the approved financial and seller-AML blocks.
 * `force` (role-gated at the route layer to Brokerage Administrator, same
 * as this whole endpoint) remains available for a deliberate override, and
 * is always audited distinctly from an ordinary close. Settlement
 * prerequisites are not changed here.
 */
async function collectClosureBlockers(transaction: Transaction): Promise<string[]> {
  const blockers: string[] = [];
  const [property] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, transaction.propertyId));
  const brokerageId = property?.brokerageId ?? null;

  if (!transactionIsUnconditional(transaction)) {
    blockers.push("The transaction has not become unconditional yet.");
  }

  const openConditions = await db
    .select()
    .from(transactionConditions)
    .where(and(eq(transactionConditions.transactionId, transaction.id), eq(transactionConditions.status, "Pending")));
  if (openConditions.length > 0) {
    blockers.push(`${openConditions.length} contract condition(s) are still Pending.`);
  }

  const buyerAml = await incompleteAmlBlocker(transaction, partyIds(transaction.buyerPartyIds), "buyer");
  if (buyerAml) blockers.push(buyerAml);
  const sellerAml = await incompleteAmlBlocker(transaction, partyIds(transaction.sellerPartyIds), "seller");
  if (sellerAml) blockers.push(sellerAml);

  const openAttentionItems = await db
    .select()
    .from(automationAttentionItems)
    .where(and(eq(automationAttentionItems.transactionId, transaction.id), eq(automationAttentionItems.status, "OPEN")));
  if (openAttentionItems.length > 0) {
    blockers.push(`${openAttentionItems.length} open attention item(s) require review.`);
  }

  const activeMustFinish = await db
    .select()
    .from(automationTasks)
    .where(
      and(
        eq(automationTasks.transactionId, transaction.id),
        eq(automationTasks.status, "ACTIVE"),
        eq(automationTasks.kind, "TASK"),
        inArray(automationTasks.taskKey, [...MUST_COMPLETE_BEFORE_CLOSE_TASK_KEYS]),
        ...(brokerageId != null ? [eq(automationTasks.brokerageId, brokerageId)] : []),
      ),
    );
  if (activeMustFinish.length > 0) {
    blockers.push(`Must-finish task(s) still open: ${activeMustFinish.map((task) => task.title).join("; ")}.`);
  }

  if (!transaction.commissionCalculatedAt) {
    blockers.push("Commission has not been calculated.");
  }

  const funds = computeFundsReconciliation(transaction);
  if (funds.status !== "MATCHED") {
    blockers.push(`Funds reconciliation is ${funds.status}, not MATCHED.`);
  }

  if (brokerageId != null) {
    const openDisputes = await db
      .select({ id: financialDisputes.id })
      .from(financialDisputes)
      .innerJoin(financialPaymentRequests, eq(financialDisputes.paymentRequestId, financialPaymentRequests.id))
      .where(
        and(
          eq(financialDisputes.brokerageId, brokerageId),
          eq(financialPaymentRequests.brokerageId, brokerageId),
          eq(financialPaymentRequests.transactionId, transaction.id),
          inArray(financialDisputes.status, ["OPEN", "UNDER_REVIEW"]),
        ),
      );
    if (openDisputes.length > 0) {
      blockers.push("An open financial dispute (FIN02) must be resolved before close.");
    }

    const discrepancy = await commissionDiscrepancyBlocker(transaction, brokerageId);
    if (discrepancy) blockers.push(discrepancy);

    const unassigned = await db
      .select({ id: riskExceptions.id, ownerType: riskExceptions.ownerType, ownerUserId: riskExceptions.ownerUserId })
      .from(riskExceptions)
      .where(
        and(
          eq(riskExceptions.brokerageId, brokerageId),
          eq(riskExceptions.transactionId, transaction.id),
          inArray(riskExceptions.status, OPEN_RISK_EXCEPTION_STATUSES),
          ne(riskExceptions.category, "FINANCIAL"),
        ),
      );
    const needingOwner = unassigned.filter((row) => row.ownerUserId == null || row.ownerType === "UNASSIGNED_QUEUE");
    if (needingOwner.length > 0) {
      blockers.push(`${needingOwner.length} open non-financial exception(s) need an assigned owner.`);
    }
  }

  return blockers;
}

/**
 * Read-only copy of the blockers `closeTransaction` reports. It does not
 * write, and it does not apply the Settled check or the force override.
 */
export async function listTransactionClosureBlockers(transaction: Transaction): Promise<string[]> {
  return collectClosureBlockers(transaction);
}

function partyIds(value: unknown): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

async function incompleteAmlBlocker(transaction: Transaction, ids: number[], label: "buyer" | "seller"): Promise<string | null> {
  if (ids.length === 0) return null;
  const verifications = await db
    .select()
    .from(amlVerifications)
    .where(and(eq(amlVerifications.propertyId, transaction.propertyId), inArray(amlVerifications.partyId, ids)));
  const unresolved = ids.filter((id) => {
    const verification = verifications.find((row) => row.partyId === id);
    return !verification || verification.status !== "Complete";
  });
  if (unresolved.length === 0) return null;
  return `AML/CTF verification is not complete for ${unresolved.length} ${label} part${unresolved.length === 1 ? "y" : "ies"}.`;
}

/**
 * Detectable commission mismatch between the legacy transaction figures and
 * a current Financial Engine calculation, or a legacy/calculation
 * reconciliation row that already records a variance. An UNRECONCILED legacy
 * flag with no numeric difference is not a detected mismatch.
 */
async function commissionDiscrepancyBlocker(transaction: Transaction, brokerageId: number): Promise<string | null> {
  const message = "Commission does not reconcile between the transaction record and the Financial Engine.";
  const calculations = await db
    .select()
    .from(commissionCalculations)
    .where(and(eq(commissionCalculations.transactionId, transaction.id), eq(commissionCalculations.brokerageId, brokerageId)))
    .orderBy(desc(commissionCalculations.calculationVersion));
  const current = calculations.find((row) => row.state !== "SUPERSEDED");
  if (current && transaction.grossCommissionCents != null) {
    const legacyGst = transaction.gstCents ?? 0;
    if (transaction.grossCommissionCents !== current.grossCommissionCents || legacyGst !== current.gstCents) {
      return message;
    }
  }

  const legacyRows = await db
    .select()
    .from(financialReconciliations)
    .where(
      and(
        eq(financialReconciliations.brokerageId, brokerageId),
        eq(financialReconciliations.recordType, "LEGACY_TRANSACTION_COMMISSION"),
        eq(financialReconciliations.recordId, String(transaction.id)),
      ),
    );
  if (legacyRows.some((row) => row.status === "VARIANCE" || row.status === "DISPUTED" || (row.differenceCents != null && row.differenceCents !== 0))) {
    return message;
  }

  if (current) {
    const calculationRows = await db
      .select()
      .from(financialReconciliations)
      .where(
        and(
          eq(financialReconciliations.brokerageId, brokerageId),
          eq(financialReconciliations.recordType, "COMMISSION_CALCULATION"),
          eq(financialReconciliations.recordId, String(current.id)),
        ),
      );
    if (
      calculationRows.some(
        (row) => row.status === "VARIANCE" || row.status === "DISPUTED" || (row.differenceCents != null && row.differenceCents !== 0),
      )
    ) {
      return message;
    }
  }

  return null;
}

/** Idempotent chokepoint — role-gated at the route layer (Brokerage Administrator), the final sign-off. */
export async function closeTransaction(input: {
  transactionId: number;
  userId: number;
  brokerageId: number;
  force?: boolean;
}): Promise<Transaction> {
  const transaction = await loadTransaction(input.transactionId);
  if (transaction.status === "Closed") return transaction;
  if (transaction.status !== "Settled") {
    throw new Error(`Transaction ${transaction.id} cannot be closed before settlement is completed.`);
  }

  const blockers = await collectClosureBlockers(transaction);
  if (blockers.length > 0 && !input.force) {
    throw new TransactionClosureBlockedError(blockers);
  }

  // Part B Stage 2 remediation (open item: "synchronously refreshed
  // projection, non-atomic"): all three writes -- transactions,
  // properties.workflowStage, and the workflowSteps refresh -- now commit
  // together. Previously these were three separate statements, and the
  // idempotent guard above (`if (transaction.status === "Closed") return
  // transaction;`) meant a crash between them left properties/workflowSteps
  // permanently behind a transaction the database already considered
  // Closed — a retry would return immediately without ever finishing the
  // stalled writes. Same db.transaction() pattern acceptOffer already uses
  // elsewhere in this file.
  const updated = await db.transaction(async (tx): Promise<Transaction> => {
    const [row] = await tx
      .update(transactions)
      .set({ status: "Closed", closedAt: new Date(), updatedAt: new Date() })
      .where(eq(transactions.id, transaction.id))
      .returning();

    await tx.update(properties).set({ workflowStage: "Closed", updatedAt: new Date() }).where(eq(properties.id, transaction.propertyId));
    await refreshTransactionSteps(transaction.propertyId, tx);
    return row;
  });

  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.userId,
    action: blockers.length > 0 ? "transaction_closed_forced" : "transaction_closed",
    recordType: "transaction",
    recordId: String(transaction.id),
    propertyId: transaction.propertyId,
    updatedValue: blockers.length > 0 ? blockers.join("; ") : undefined,
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
