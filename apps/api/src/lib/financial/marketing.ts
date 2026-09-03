// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage F.
//
// Marketing payment overlay write path (Section 17) — the missing
// counterpart to lib/financial/queries.ts's listMarketingPaymentRecords
// (a read Stage B/E already shipped). packages/db/src/schema/financial.ts's
// own header comment (§F) already fixed the design: "Launch's
// launchPlans.budgetCents/budgetSpentCents and campaignItems.costCents/
// vendorApprovals stay the single source of truth for marketing budget/
// spend/approval. marketingPaymentRecords below is a thin overlay (one
// optional row per campaignItem, exactly mirroring pit_crew_assignments'
// proven 'overlay table on an existing table' pattern) that adds ONLY
// invoice/payment/reconciliation status — never a second budget or cost
// figure." This module is that overlay's write path: it never reads or
// writes campaignItems.costCents/budgetCents, only validates that the
// referenced campaignItemId exists and belongs to the same brokerage/
// property before recording invoice/payment/reconciliation facts about it.
//
// Lifecycle (MARKETING_EXPENSE_STATUSES): PLANNED/AUTHORISED (Launch's own
// states, read-only from here) -> INVOICED -> REPORTED_PAID -> RECONCILED,
// with DISPUTED/CANCELLED as off-ramps. paymentSource is a REPORTED fact
// ("Agent general account", "Brokerage account") — Section 3's custody
// boundary means this module never executes a payment itself, only
// records that one was reported to have happened, mirroring
// pcFeeAuthorities.ts's own "records the resulting reference, never
// originates the underlying authorisation" posture for a different kind
// of financial fact.

import { eq } from "drizzle-orm";
import { db, campaignItems, marketingPaymentRecords, type MarketingPaymentRecord } from "@aee/db";
import { FinancialControlError } from "./agreements.js";
import { emitFinancialEvent } from "./events.js";

async function loadRecord(id: number, brokerageId: number): Promise<MarketingPaymentRecord> {
  const [row] = await db.select().from(marketingPaymentRecords).where(eq(marketingPaymentRecords.id, id));
  if (!row || row.brokerageId !== brokerageId) {
    throw new FinancialControlError("NOT_FOUND", `Marketing payment record ${id} not found.`);
  }
  return row;
}

export interface RecordMarketingInvoiceInput {
  brokerageId: number;
  propertyId: number;
  /** A launch.campaignItems.id (uuid) — app-validated cross-file reference, per financial.ts's schema header. */
  campaignItemId: string;
  supplierName?: string | null;
  invoiceReference?: string | null;
  invoicedAmountCents: number;
  recordedByUserId: number;
}

/**
 * Records that a marketing invoice was received for a campaign item —
 * creates the overlay row on first use (a campaign item starts with no
 * overlay row at all, per the schema's "one OPTIONAL row per campaignItem"
 * design), or advances an existing PLANNED/AUTHORISED row to INVOICED.
 */
export async function recordMarketingInvoice(input: RecordMarketingInvoiceInput): Promise<MarketingPaymentRecord> {
  const [campaignItem] = await db.select().from(campaignItems).where(eq(campaignItems.id, input.campaignItemId));
  if (!campaignItem) {
    throw new FinancialControlError("NOT_FOUND", `Campaign item ${input.campaignItemId} not found.`);
  }
  if (campaignItem.brokerageId !== input.brokerageId || campaignItem.propertyId !== input.propertyId) {
    throw new FinancialControlError("NOT_FOUND", `Campaign item ${input.campaignItemId} does not belong to this property.`);
  }

  const [existing] = await db.select().from(marketingPaymentRecords).where(eq(marketingPaymentRecords.campaignItemId, input.campaignItemId));
  if (existing && existing.status !== "PLANNED" && existing.status !== "AUTHORISED") {
    throw new FinancialControlError("INVALID_STATUS", `Marketing payment record for campaign item ${input.campaignItemId} is already ${existing.status}, not PLANNED/AUTHORISED.`);
  }

  let row: MarketingPaymentRecord;
  if (existing) {
    [row] = await db
      .update(marketingPaymentRecords)
      .set({
        status: "INVOICED",
        supplierName: input.supplierName ?? existing.supplierName,
        invoiceReference: input.invoiceReference ?? existing.invoiceReference,
        invoicedAmountCents: input.invoicedAmountCents,
        invoicedAt: new Date(),
        recordedByUserId: input.recordedByUserId,
        updatedAt: new Date(),
      })
      .where(eq(marketingPaymentRecords.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(marketingPaymentRecords)
      .values({
        brokerageId: input.brokerageId,
        propertyId: input.propertyId,
        campaignItemId: input.campaignItemId,
        status: "INVOICED",
        supplierName: input.supplierName ?? null,
        invoiceReference: input.invoiceReference ?? null,
        invoicedAmountCents: input.invoicedAmountCents,
        invoicedAt: new Date(),
        recordedByUserId: input.recordedByUserId,
      })
      .returning();
  }

  await emitFinancialEvent({
    eventType: "MARKETING_INVOICE_RECORDED",
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    actorType: "USER",
    actorId: input.recordedByUserId,
    source: "api:financial:recordMarketingInvoice",
    payload: { marketingPaymentRecordId: row.id, campaignItemId: input.campaignItemId, invoicedAmountCents: input.invoicedAmountCents },
  });

  return row;
}

export interface RecordMarketingPaymentReportedInput {
  marketingPaymentRecordId: number;
  brokerageId: number;
  reportedPaidAmountCents: number;
  /** e.g. "Agent general account", "Brokerage account" — a reported fact, never executed by AE (Section 3). */
  paymentSource: string;
  evidenceRef?: string | null;
  recordedByUserId: number;
}

/** Records that an invoiced marketing expense was reported as paid (outside AE — Section 3's custody boundary). */
export async function recordMarketingPaymentReported(input: RecordMarketingPaymentReportedInput): Promise<MarketingPaymentRecord> {
  const record = await loadRecord(input.marketingPaymentRecordId, input.brokerageId);
  if (record.status !== "INVOICED" && record.status !== "AUTHORISED") {
    throw new FinancialControlError("INVALID_STATUS", `Marketing payment record ${record.id} is ${record.status}, not INVOICED/AUTHORISED.`);
  }

  const [updated] = await db
    .update(marketingPaymentRecords)
    .set({
      status: "REPORTED_PAID",
      reportedPaidAmountCents: input.reportedPaidAmountCents,
      reportedPaidAt: new Date(),
      paymentSource: input.paymentSource,
      evidenceRef: input.evidenceRef ?? record.evidenceRef,
      reconciliationStatus: "UNRECONCILED",
      recordedByUserId: input.recordedByUserId,
      updatedAt: new Date(),
    })
    .where(eq(marketingPaymentRecords.id, record.id))
    .returning();
  return updated;
}

export interface ReconcileMarketingPaymentInput {
  marketingPaymentRecordId: number;
  brokerageId: number;
  actorUserId: number;
}

/** Marks a reported-paid marketing expense as reconciled against brokerage financial records. */
export async function reconcileMarketingPayment(input: ReconcileMarketingPaymentInput): Promise<MarketingPaymentRecord> {
  const record = await loadRecord(input.marketingPaymentRecordId, input.brokerageId);
  if (record.status !== "REPORTED_PAID") {
    throw new FinancialControlError("INVALID_STATUS", `Marketing payment record ${record.id} is ${record.status}, not REPORTED_PAID.`);
  }

  const [updated] = await db
    .update(marketingPaymentRecords)
    .set({
      status: "RECONCILED",
      reconciliationStatus: "RECONCILED",
      reconciledAt: new Date(),
      reconciledByUserId: input.actorUserId,
      updatedAt: new Date(),
    })
    .where(eq(marketingPaymentRecords.id, record.id))
    .returning();

  await emitFinancialEvent({
    eventType: "MARKETING_PAYMENT_RECONCILED",
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    actorType: "USER",
    actorId: input.actorUserId,
    source: "api:financial:reconcileMarketingPayment",
    payload: { marketingPaymentRecordId: updated.id, campaignItemId: updated.campaignItemId, reportedPaidAmountCents: updated.reportedPaidAmountCents },
  });

  return updated;
}

export interface DisputeMarketingPaymentInput {
  marketingPaymentRecordId: number;
  brokerageId: number;
  reason: string;
}

/** Flags a reported-paid marketing expense as disputed (a discrepancy against brokerage records) rather than reconciling it. */
export async function disputeMarketingPayment(input: DisputeMarketingPaymentInput): Promise<MarketingPaymentRecord> {
  const record = await loadRecord(input.marketingPaymentRecordId, input.brokerageId);
  if (record.status !== "REPORTED_PAID") {
    throw new FinancialControlError("INVALID_STATUS", `Marketing payment record ${record.id} is ${record.status}, not REPORTED_PAID.`);
  }

  const [updated] = await db
    .update(marketingPaymentRecords)
    .set({ status: "DISPUTED", reconciliationStatus: "DISPUTED", updatedAt: new Date() })
    .where(eq(marketingPaymentRecords.id, record.id))
    .returning();
  return updated;
}

export interface CancelMarketingPaymentInput {
  marketingPaymentRecordId: number;
  brokerageId: number;
}

/** Cancels an overlay row before any money has moved (PLANNED/AUTHORISED/INVOICED only — never once REPORTED_PAID). */
export async function cancelMarketingPayment(input: CancelMarketingPaymentInput): Promise<MarketingPaymentRecord> {
  const record = await loadRecord(input.marketingPaymentRecordId, input.brokerageId);
  if (record.status !== "PLANNED" && record.status !== "AUTHORISED" && record.status !== "INVOICED") {
    throw new FinancialControlError("INVALID_STATUS", `Marketing payment record ${record.id} is ${record.status} — cannot cancel once money has been reported paid.`);
  }

  const [updated] = await db
    .update(marketingPaymentRecords)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(eq(marketingPaymentRecords.id, record.id))
    .returning();
  return updated;
}
