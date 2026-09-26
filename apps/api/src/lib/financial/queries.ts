// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E.
//
// Read model for the financial operations routes (Section 32). Every
// function here is scoped by brokerageId (never a client-supplied
// tenant id — mirrors routes/exceptions.ts's own header comment) and
// returns brokerage-owned rows only. Section 33 sensitive-data
// protection: PC fee authority reads always go through
// redactPcFeeAuthority — the raw mandateProviderRef is never serialised
// by any function in this file.

import { eq, and, desc, ne } from "drizzle-orm";
import {
  db,
  commissionAgreements,
  commissionCalculations,
  pcFeeAuthorities,
  pcFeeCalculations,
  financialPaymentRequests,
  financialDisputes,
  financialLedgerEvents,
  marketingPaymentRecords,
  financialDeposits,
  financialReconciliations,
  auditReturnReminders,
  financialSettings,
  properties,
  transactions,
  type FinancialSettingsRow,
} from "@aee/db";
import { incrementCounter } from "@aee/events";
import { redactPcFeeAuthority, type RedactedPcFeeAuthority } from "./pcFeeAuthorities.js";
import { getLegacyCommissionContext, getExistingLegacyReconciliation, type LegacyCommissionContext } from "./legacyReconciliation.js";

export async function listCommissionAgreements(brokerageId: number, transactionId?: number) {
  const conditions = [eq(commissionAgreements.brokerageId, brokerageId)];
  if (transactionId != null) conditions.push(eq(commissionAgreements.transactionId, transactionId));
  return db
    .select()
    .from(commissionAgreements)
    .where(and(...conditions))
    .orderBy(desc(commissionAgreements.version));
}

export async function getCommissionAgreement(id: number, brokerageId: number) {
  const [row] = await db.select().from(commissionAgreements).where(and(eq(commissionAgreements.id, id), eq(commissionAgreements.brokerageId, brokerageId)));
  return row ?? null;
}

export async function listCommissionCalculations(brokerageId: number, transactionId?: number) {
  const conditions = [eq(commissionCalculations.brokerageId, brokerageId)];
  if (transactionId != null) conditions.push(eq(commissionCalculations.transactionId, transactionId));
  return db
    .select()
    .from(commissionCalculations)
    .where(and(...conditions))
    .orderBy(desc(commissionCalculations.calculationVersion));
}

export async function listPcFeeAuthorities(brokerageId: number, agentUserId?: number): Promise<RedactedPcFeeAuthority[]> {
  const conditions = [eq(pcFeeAuthorities.brokerageId, brokerageId)];
  if (agentUserId != null) conditions.push(eq(pcFeeAuthorities.agentUserId, agentUserId));
  const rows = await db
    .select()
    .from(pcFeeAuthorities)
    .where(and(...conditions))
    .orderBy(desc(pcFeeAuthorities.version));
  return rows.map(redactPcFeeAuthority);
}

export async function getPcFeeAuthority(id: number, brokerageId: number): Promise<RedactedPcFeeAuthority | null> {
  const [row] = await db.select().from(pcFeeAuthorities).where(and(eq(pcFeeAuthorities.id, id), eq(pcFeeAuthorities.brokerageId, brokerageId)));
  return row ? redactPcFeeAuthority(row) : null;
}

export async function listPcFeeCalculations(brokerageId: number, transactionId?: number) {
  const conditions = [eq(pcFeeCalculations.brokerageId, brokerageId)];
  if (transactionId != null) conditions.push(eq(pcFeeCalculations.transactionId, transactionId));
  return db
    .select()
    .from(pcFeeCalculations)
    .where(and(...conditions))
    .orderBy(desc(pcFeeCalculations.calculationVersion));
}

export async function listPaymentRequests(brokerageId: number, filters: { transactionId?: number; status?: string; restrictToPropertyIds?: number[] | null }) {
  const conditions = [eq(financialPaymentRequests.brokerageId, brokerageId)];
  if (filters.transactionId != null) conditions.push(eq(financialPaymentRequests.transactionId, filters.transactionId));
  if (filters.status) conditions.push(eq(financialPaymentRequests.status, filters.status));
  const rows = await db
    .select()
    .from(financialPaymentRequests)
    .where(and(...conditions))
    .orderBy(desc(financialPaymentRequests.createdAt));
  if (filters.restrictToPropertyIds == null) return rows;
  const allowed = new Set(filters.restrictToPropertyIds);
  return rows.filter((r) => allowed.has(r.propertyId));
}

export async function getPaymentRequest(id: number, brokerageId: number) {
  const [row] = await db.select().from(financialPaymentRequests).where(and(eq(financialPaymentRequests.id, id), eq(financialPaymentRequests.brokerageId, brokerageId)));
  return row ?? null;
}

export async function listDisputesForPaymentRequest(paymentRequestId: number, brokerageId: number) {
  return db
    .select()
    .from(financialDisputes)
    .where(and(eq(financialDisputes.paymentRequestId, paymentRequestId), eq(financialDisputes.brokerageId, brokerageId)));
}

export async function listLedgerEvents(brokerageId: number, filters: { transactionId?: number; propertyId?: number; limit?: number }) {
  const conditions = [eq(financialLedgerEvents.brokerageId, brokerageId)];
  if (filters.transactionId != null) conditions.push(eq(financialLedgerEvents.transactionId, filters.transactionId));
  if (filters.propertyId != null) conditions.push(eq(financialLedgerEvents.propertyId, filters.propertyId));
  return db
    .select()
    .from(financialLedgerEvents)
    .where(and(...conditions))
    .orderBy(desc(financialLedgerEvents.occurredAt))
    .limit(filters.limit ?? 200);
}

export async function listMarketingPaymentRecords(brokerageId: number, propertyId?: number) {
  const conditions = [eq(marketingPaymentRecords.brokerageId, brokerageId)];
  if (propertyId != null) conditions.push(eq(marketingPaymentRecords.propertyId, propertyId));
  return db
    .select()
    .from(marketingPaymentRecords)
    .where(and(...conditions))
    .orderBy(desc(marketingPaymentRecords.createdAt));
}

export async function listFinancialDeposits(brokerageId: number, transactionId?: number) {
  const conditions = [eq(financialDeposits.brokerageId, brokerageId)];
  if (transactionId != null) conditions.push(eq(financialDeposits.transactionId, transactionId));
  return db
    .select()
    .from(financialDeposits)
    .where(and(...conditions))
    .orderBy(desc(financialDeposits.createdAt));
}

export async function listFinancialReconciliations(brokerageId: number, recordType?: string, recordId?: string) {
  const conditions = [eq(financialReconciliations.brokerageId, brokerageId)];
  if (recordType) conditions.push(eq(financialReconciliations.recordType, recordType));
  if (recordId) conditions.push(eq(financialReconciliations.recordId, recordId));
  return db
    .select()
    .from(financialReconciliations)
    .where(and(...conditions))
    .orderBy(desc(financialReconciliations.createdAt));
}

export async function listAuditReturnReminders(brokerageId: number) {
  return db.select().from(auditReturnReminders).where(eq(auditReturnReminders.brokerageId, brokerageId)).orderBy(desc(auditReturnReminders.dueDate));
}

/** Lazily creates the one settings row per brokerage on first read — mirrors communicationSettings. */
export async function getOrCreateFinancialSettings(brokerageId: number): Promise<FinancialSettingsRow> {
  const [existing] = await db.select().from(financialSettings).where(eq(financialSettings.brokerageId, brokerageId));
  if (existing) return existing;
  const [inserted] = await db.insert(financialSettings).values({ brokerageId }).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [raceWinner] = await db.select().from(financialSettings).where(eq(financialSettings.brokerageId, brokerageId));
  if (!raceWinner) throw new Error("Failed to create or find financial settings.");
  return raceWinner;
}

/**
 * Re-derives (propertyId, brokerageId) for a transactionId from the
 * transaction's own property row — never from a client-supplied
 * propertyId/brokerageId in a write request body (mirrors routes/
 * exceptions.ts's own header comment: "every handler re-derives
 * brokerageId ... from req.authedUser — never from a client-supplied
 * tenant id"). Returns null if the transaction doesn't exist or its
 * property doesn't belong to the given brokerage — routes turn that into
 * a 404, exactly like a cross-tenant id anywhere else in this app.
 *
 * R-F8 — the scoped query cannot tell those two misses apart. On a miss
 * only, one existence lookup (never on the success path) checks whether
 * the transaction's property belongs to another brokerage and, if so,
 * increments tenant_isolation_rejection_total{boundary="financial"} once.
 * That lookup selects no brokerage id and no other tenant's columns.
 * The return value stays null either way.
 */
export async function resolveTransactionScope(transactionId: number, brokerageId: number): Promise<{ transactionId: number; propertyId: number } | null> {
  const [row] = await db
    .select({ transactionId: transactions.id, propertyId: transactions.propertyId, brokerageId: properties.brokerageId })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .where(and(eq(transactions.id, transactionId), eq(properties.brokerageId, brokerageId)));
  if (row) return { transactionId: row.transactionId, propertyId: row.propertyId };
  if (await transactionExistsInAnotherBrokerage(transactionId, brokerageId)) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "financial" });
  }
  return null;
}

async function transactionExistsInAnotherBrokerage(transactionId: number, brokerageId: number): Promise<boolean> {
  if (!Number.isInteger(transactionId) || transactionId <= 0) return false;
  const [elsewhere] = await db
    .select({ transactionId: transactions.id })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .where(and(eq(transactions.id, transactionId), ne(properties.brokerageId, brokerageId)));
  return Boolean(elsewhere);
}

/**
 * Financial Transaction Engine Verification (Step 2), COHERENCE-001
 * remediation: the property's most recent transaction — the same row
 * getPropertyFinancialSummary would otherwise have no way to reach when
 * there is no Financial Engine agreement/calculation yet to key off of.
 * Only ever used to look up the LEGACY grossCommissionCents/gstCents
 * fields below — never to infer a Financial Engine calculation.
 */
async function getMostRecentTransactionForProperty(propertyId: number) {
  const rows = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.propertyId, propertyId)).orderBy(desc(transactions.id)).limit(1);
  return rows[0] ?? null;
}

export interface LegacyCommissionSummary extends LegacyCommissionContext {
  alreadyFlaggedForReconciliation: boolean;
}

/**
 * Section 28 preview: the Property Financial Summary's bundled read — the
 * latest commission agreement/calculation, PC fee authority/calculation,
 * and payment request for a single property's transaction(s), in one
 * round trip. Full progressive-disclosure detail views (Stage G) call the
 * more granular list functions above; this is the summary card's data.
 *
 * COHERENCE-001 remediation (Financial Transaction Engine Verification,
 * Step 2): when this property has no Financial Engine commissionAgreement
 * at all, `legacyCommission` surfaces the pre-existing legacy
 * transactions.grossCommissionCents/gstCents figure (if the transaction
 * has reached Settled/Closed and one was recorded) so the UI can show a
 * single, labelled, coherent explanation instead of a bare "No commission
 * agreement recorded yet" sitting beside a contradicting figure elsewhere
 * on the same page (see FinancialSummarySection.tsx). This field is
 * additive and read-only — computing it never writes anything; writing
 * only happens via the explicit "Flag for reconciliation" action
 * (routes/financial.ts's POST .../legacy-commission/reconcile), which
 * this function also reports the current status of via
 * alreadyFlaggedForReconciliation.
 */
export async function getPropertyFinancialSummary(propertyId: number, brokerageId: number) {
  const [property] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) return null;

  const [agreements, calculations, pcCalculations, paymentRequests, deposits] = await Promise.all([
    db
      .select()
      .from(commissionAgreements)
      .where(and(eq(commissionAgreements.propertyId, propertyId), eq(commissionAgreements.brokerageId, brokerageId)))
      .orderBy(desc(commissionAgreements.version)),
    db
      .select()
      .from(commissionCalculations)
      .where(and(eq(commissionCalculations.propertyId, propertyId), eq(commissionCalculations.brokerageId, brokerageId)))
      .orderBy(desc(commissionCalculations.calculationVersion)),
    db
      .select()
      .from(pcFeeCalculations)
      .where(and(eq(pcFeeCalculations.propertyId, propertyId), eq(pcFeeCalculations.brokerageId, brokerageId)))
      .orderBy(desc(pcFeeCalculations.calculationVersion)),
    db
      .select()
      .from(financialPaymentRequests)
      .where(and(eq(financialPaymentRequests.propertyId, propertyId), eq(financialPaymentRequests.brokerageId, brokerageId)))
      .orderBy(desc(financialPaymentRequests.createdAt)),
    db
      .select()
      .from(financialDeposits)
      .where(and(eq(financialDeposits.propertyId, propertyId), eq(financialDeposits.brokerageId, brokerageId)))
      .orderBy(desc(financialDeposits.createdAt)),
  ]);

  const currentCommissionAgreement = agreements.find((a) => a.status === "APPROVED") ?? agreements[0] ?? null;

  // Only look for a legacy figure when the Financial Engine has NOTHING
  // for this property yet — an in-progress agreement (DRAFT/AWAITING_
  // APPROVAL) is the normal, non-contradictory "being set up" state, not
  // the coherence gap the audit found.
  let legacyCommission: LegacyCommissionSummary | null = null;
  if (!currentCommissionAgreement) {
    const mostRecentTransaction = await getMostRecentTransactionForProperty(propertyId);
    if (mostRecentTransaction) {
      const context = await getLegacyCommissionContext(mostRecentTransaction.id, brokerageId);
      if (context) {
        const existingReconciliation = await getExistingLegacyReconciliation(mostRecentTransaction.id, brokerageId);
        legacyCommission = { ...context, alreadyFlaggedForReconciliation: Boolean(existingReconciliation) };
      }
    }
  }

  return {
    propertyId,
    currentCommissionAgreement,
    latestCommissionCalculation: calculations.find((c) => c.state === "FINALISED") ?? calculations[0] ?? null,
    latestPcFeeCalculation: pcCalculations.find((c) => c.state === "FINALISED" || c.state === "CONFIRMED") ?? pcCalculations[0] ?? null,
    paymentRequests,
    deposit: deposits[0] ?? null,
    legacyCommission,
  };
}
