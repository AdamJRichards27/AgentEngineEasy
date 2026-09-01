// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Commission agreement authoring/approval service (Section 9). Stage B
// built the versioned, approval-gated schema; Stage C's calculations.ts
// only ever READS an existing commissionAgreements row (it has no create
// or approve path of its own — "callers resolve the correct agent/
// authority" was always Stage E's job, per that module's own comments).
// This is the missing write path: draft, approve, cancel.
//
// Separation of duties (Section 32/33 — "control money-related events"):
// the person who drafts a commission agreement must not be the same
// person who approves it. This is enforced here, not just at the route
// layer, so it holds regardless of caller. Both draft and approve are
// restricted to Brokerage Administrator by the route layer's
// requireRole(...BROKERAGE_ADMIN_ROLES) — separation-of-duties is an
// ADDITIONAL control on top of that, not a substitute for it.
//
// Stage F: approveCommissionAgreement additionally publishes
// COMMISSION_AGREEMENT_APPROVED to the canonical event bus (see
// events.ts) — the one commission-agreement milestone another engine
// (Timeline, Exception & Risk, Command Centre) might care about.
// createCommissionAgreement/cancelCommissionAgreement stay ledger-only
// (financialLedgerEvents already records both, via recordLedgerEvent
// below) — a draft or a cancellation isn't the kind of cross-engine-
// relevant milestone events.ts's own module comment scopes this bus to.

import { eq, and } from "drizzle-orm";
import { db, commissionAgreements, financialLedgerEvents, type CommissionAgreement, type CommissionTier, type CommissionMethod } from "@aee/db";
import { emitFinancialEvent } from "./events.js";

export type FinancialControlErrorReason = "NOT_FOUND" | "INVALID_STATUS" | "SEPARATION_OF_DUTIES";

export class FinancialControlError extends Error {
  reason: FinancialControlErrorReason;
  constructor(reason: FinancialControlErrorReason, message: string) {
    super(message);
    this.name = "FinancialControlError";
    this.reason = reason;
  }
}

async function recordLedgerEvent(input: {
  brokerageId: number;
  propertyId?: number | null;
  transactionId?: number | null;
  eventType: string;
  amountCents?: number | null;
  sourceRecordType: string;
  sourceRecordId: string;
  actorType: "SYSTEM" | "USER";
  actorUserId?: number | null;
  reason?: string | null;
}): Promise<void> {
  await db.insert(financialLedgerEvents).values({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId ?? null,
    transactionId: input.transactionId ?? null,
    eventType: input.eventType,
    amountCents: input.amountCents ?? null,
    sourceRecordType: input.sourceRecordType,
    sourceRecordId: input.sourceRecordId,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    reason: input.reason ?? null,
  });
}

async function nextCommissionAgreementVersion(transactionId: number): Promise<number> {
  const rows = await db.select({ version: commissionAgreements.version }).from(commissionAgreements).where(eq(commissionAgreements.transactionId, transactionId));
  const maxVersion = rows.reduce((max, r) => Math.max(max, r.version), 0);
  return maxVersion + 1;
}

export interface CreateCommissionAgreementInput {
  brokerageId: number;
  propertyId: number;
  transactionId: number;
  method: CommissionMethod;
  rateBps?: number | null;
  fixedAmountCents?: number | null;
  tiers?: CommissionTier[] | null;
  minimumAmountCents?: number | null;
  manualReason?: string | null;
  gstApplicable?: boolean;
  gstRateBps?: number;
  referralFeeCents?: number;
  brokerageSplitBps?: number | null;
  agentSplitBps?: number | null;
  seededFromAgencyAgreementTermsId?: number | null;
  sourceDocumentRef?: string | null;
  effectiveDate?: Date | null;
  notes?: string | null;
  createdByUserId: number;
}

/**
 * Drafts a new, unapproved commission agreement version for a transaction.
 * Never edits a prior version (Section 9) — always the next version
 * number for the transaction, starting at DRAFT.
 */
export async function createCommissionAgreement(input: CreateCommissionAgreementInput): Promise<CommissionAgreement> {
  const version = await nextCommissionAgreementVersion(input.transactionId);
  const [row] = await db
    .insert(commissionAgreements)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      transactionId: input.transactionId,
      version,
      status: "DRAFT",
      method: input.method,
      rateBps: input.rateBps ?? null,
      fixedAmountCents: input.fixedAmountCents ?? null,
      tiers: input.tiers ?? null,
      minimumAmountCents: input.minimumAmountCents ?? null,
      manualReason: input.manualReason ?? null,
      gstApplicable: input.gstApplicable ?? true,
      gstRateBps: input.gstRateBps ?? 1000,
      referralFeeCents: input.referralFeeCents ?? 0,
      brokerageSplitBps: input.brokerageSplitBps ?? null,
      agentSplitBps: input.agentSplitBps ?? null,
      seededFromAgencyAgreementTermsId: input.seededFromAgencyAgreementTermsId ?? null,
      sourceDocumentRef: input.sourceDocumentRef ?? null,
      effectiveDate: input.effectiveDate ?? null,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning();
  return row;
}

/**
 * Approves a DRAFT/AWAITING_APPROVAL agreement. Whichever prior APPROVED
 * version exists for the same transaction (there is at most one, per
 * Section 9) is marked SUPERSEDED and linked via supersedesId — mirroring
 * commissionCalculations' own supersede pattern in calculations.ts.
 * Rejects self-approval: the approver must not be the row's own
 * createdByUserId.
 */
export async function approveCommissionAgreement(id: number, brokerageId: number, actorUserId: number): Promise<CommissionAgreement> {
  const [agreement] = await db.select().from(commissionAgreements).where(eq(commissionAgreements.id, id));
  if (!agreement || agreement.brokerageId !== brokerageId) {
    throw new FinancialControlError("NOT_FOUND", `Commission agreement ${id} not found.`);
  }
  if (agreement.status !== "DRAFT" && agreement.status !== "AWAITING_APPROVAL") {
    throw new FinancialControlError("INVALID_STATUS", `Commission agreement ${id} is ${agreement.status}, not DRAFT/AWAITING_APPROVAL.`);
  }
  if (agreement.createdByUserId != null && agreement.createdByUserId === actorUserId) {
    throw new FinancialControlError("SEPARATION_OF_DUTIES", "The user who drafted a commission agreement cannot also approve it.");
  }

  const priorApprovedRows = await db
    .select()
    .from(commissionAgreements)
    .where(and(eq(commissionAgreements.transactionId, agreement.transactionId), eq(commissionAgreements.status, "APPROVED")));
  const priorApproved = priorApprovedRows.sort((a, b) => b.version - a.version)[0];
  if (priorApproved) {
    await db.update(commissionAgreements).set({ status: "SUPERSEDED", updatedAt: new Date() }).where(eq(commissionAgreements.id, priorApproved.id));
  }

  const [updated] = await db
    .update(commissionAgreements)
    .set({
      status: "APPROVED",
      supersedesId: priorApproved?.id ?? agreement.supersedesId,
      approvedByUserId: actorUserId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(commissionAgreements.id, id))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    eventType: "COMMISSION_AGREEMENT_APPROVED",
    sourceRecordType: "COMMISSION_AGREEMENT",
    sourceRecordId: String(updated.id),
    actorType: "USER",
    actorUserId,
  });

  await emitFinancialEvent({
    eventType: "COMMISSION_AGREEMENT_APPROVED",
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    actorType: "USER",
    actorId: actorUserId,
    source: "api:financial:approveCommissionAgreement",
    payload: { commissionAgreementId: updated.id, method: updated.method, rateBps: updated.rateBps, fixedAmountCents: updated.fixedAmountCents },
  });

  return updated;
}

/** Cancels a not-yet-superseded agreement (DRAFT, AWAITING_APPROVAL, or APPROVED). */
export async function cancelCommissionAgreement(id: number, brokerageId: number, actorUserId: number, reason: string): Promise<CommissionAgreement> {
  const [agreement] = await db.select().from(commissionAgreements).where(eq(commissionAgreements.id, id));
  if (!agreement || agreement.brokerageId !== brokerageId) {
    throw new FinancialControlError("NOT_FOUND", `Commission agreement ${id} not found.`);
  }
  if (agreement.status === "CANCELLED" || agreement.status === "SUPERSEDED") {
    throw new FinancialControlError("INVALID_STATUS", `Commission agreement ${id} is already ${agreement.status}.`);
  }

  const [updated] = await db
    .update(commissionAgreements)
    .set({ status: "CANCELLED", cancelledByUserId: actorUserId, cancelledAt: new Date(), cancelReason: reason, updatedAt: new Date() })
    .where(eq(commissionAgreements.id, id))
    .returning();
  return updated;
}
