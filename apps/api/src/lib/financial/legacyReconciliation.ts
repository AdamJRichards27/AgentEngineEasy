// Agent Engine 2.0 — Financial Transaction Engine Verification (Step 2,
// Integration Readiness Program) — COHERENCE-001 remediation.
//
// Consolidated Build-State and Merge Audit (docs/CONSOLIDATED_BUILD_STATE_
// AND_MERGE_AUDIT.md, finding COHERENCE-001) found a live, reproduced case
// where a closed transaction's pre-existing Transaction section shows a
// real commission figure while the new Financial Summary section says "No
// commission agreement recorded yet" / "No commission calculation recorded
// yet" — because finalizeCommissionForSettlement (settlement.ts) is a
// documented no-op when no APPROVED commissionAgreement exists, and this
// build never backfills one for transactions that closed before the
// Financial Transaction Engine existed in this workspace.
//
// This module investigated whether the "preferred solution" the Step 2
// verification brief describes (a full backfill that materialises new
// commissionAgreements + commissionCalculations rows tagged
// LEGACY_TRANSACTION_MIGRATION) is SAFE to do automatically. It is not,
// for a concrete, evidenced reason: the legacy transactions table
// (packages/db/src/schema/transaction.ts) only ever stored the two OUTPUT
// totals of a commission calculation — grossCommissionCents and gstCents
// — never the calculation METHOD, rateBps, tiers, referral fee, or
// brokerage/agent split that produced them. commissionCalculations.
// commissionAgreementId is NOT NULL and commissionAgreements.method is
// NOT NULL, so materialising either row for a legacy transaction would
// require inventing a method/rate that was never actually recorded
// anywhere — exactly what the brief's own "Do not fabricate commission
// agreements" / "Do not infer ... from historical commission data" rules
// forbid. This is therefore an "uncertain record" in the brief's own
// Section 7 vocabulary (point 8: "Marks uncertain records for manual
// review rather than inventing data") for every legacy transaction,
// without exception — there is no subset of legacy transactions this
// module could safely upgrade to a real, method-attributed calculation.
//
// So this module implements the brief's explicit SAFE FALLBACK instead
// (Section 7): it never writes to commissionAgreements or
// commissionCalculations. It creates a financialReconciliations row
// (recordType LEGACY_TRANSACTION_COMMISSION, additive — see schema/
// financial.ts's own comment on that value) that preserves the original
// legacy amounts exactly, labels its source, and gives a Brokerage
// Administrator a queue item to act on by hand — i.e. by drafting and
// approving a *real* commissionAgreement through the existing Stage E
// write path (agreements.ts) if and when they have the actual historical
// terms to enter, which this module never guesses at.
//
// Idempotency: reconcileLegacyCommission SELECTs-before-INSERTs on
// (brokerageId, recordType, recordId), mirroring the same idiom used
// throughout this build (settlement.ts's ensurePcSuccessFeeRequest,
// agreements.ts). There is no DB-level unique constraint backing this
// specific check (financialReconciliations.recordIdx is a plain, not
// unique, index — see schema/financial.ts) because, unlike a webhook or
// a SETTLEMENT_COMPLETED subscriber, this is an admin-triggered,
// low-frequency, sequential action (a button click, or a one-time backfill
// script run) rather than an at-least-once delivery path — sequential
// reruns are what "safe to rerun" means for this specific action, and
// SELECT-before-INSERT genuinely prevents duplicates across sequential
// runs. A true concurrent double-submit race is a low-probability,
// non-financially-dangerous outcome if it ever occurred (it would produce,
// at worst, one duplicate UNRECONCILED reconciliation record for a human
// to notice and merge — never a duplicate payment or agreement) and is
// recorded as an open follow-up recommendation (a real unique index would
// need its own migration) in docs/FINANCIAL_TRANSACTION_ENGINE_VERIFICATION.md
// rather than solved here, consistent with keeping this remediation
// tightly scoped.

import { eq, and, isNull } from "drizzle-orm";
import {
  db,
  transactions,
  properties,
  commissionAgreements,
  financialReconciliations,
  financialLedgerEvents,
  type Transaction,
  type FinancialReconciliation,
} from "@aee/db";

export const LEGACY_RECONCILIATION_SOURCE = "LEGACY_TRANSACTION_MIGRATION";
export const LEGACY_RECONCILIATION_RECORD_TYPE = "LEGACY_TRANSACTION_COMMISSION";

// Only a transaction that has reached a final state is in scope — this
// mirrors the exact case the audit reproduced ("a fully Closed
// transaction") and deliberately excludes anything still in progress: an
// in-flight transaction can still get a real commissionAgreement drafted
// and approved through the normal Stage E flow before it settles, so
// there is nothing to reconcile yet and flagging it would just be noise.
const RECONCILIATION_ELIGIBLE_STATUSES = ["Settled", "Closed"] as const;

export interface LegacyCommissionContext {
  transactionId: number;
  propertyId: number;
  brokerageId: number;
  transactionStatus: string;
  grossCommissionCents: number;
  gstCents: number | null;
  commissionCalculatedAt: Date | null;
}

/**
 * Returns the legacy flat commission figures for a single transaction —
 * never null-coalesced or guessed — only when they are actually present
 * (grossCommissionCents recorded) AND the transaction has reached a final
 * status. Returns null otherwise (nothing to reconcile).
 */
export async function getLegacyCommissionContext(transactionId: number, brokerageId: number): Promise<LegacyCommissionContext | null> {
  const [row] = await db
    .select({
      id: transactions.id,
      propertyId: transactions.propertyId,
      brokerageId: properties.brokerageId,
      status: transactions.status,
      grossCommissionCents: transactions.grossCommissionCents,
      gstCents: transactions.gstCents,
      commissionCalculatedAt: transactions.commissionCalculatedAt,
    })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .where(and(eq(transactions.id, transactionId), eq(properties.brokerageId, brokerageId)));

  if (!row || row.grossCommissionCents == null) return null;
  if (!(RECONCILIATION_ELIGIBLE_STATUSES as readonly string[]).includes(row.status)) return null;

  return {
    transactionId: row.id,
    propertyId: row.propertyId,
    brokerageId: row.brokerageId,
    transactionStatus: row.status,
    grossCommissionCents: row.grossCommissionCents,
    gstCents: row.gstCents,
    commissionCalculatedAt: row.commissionCalculatedAt,
  };
}

/** Whether ANY Financial Engine commissionAgreement (any status) exists for this transaction. */
export async function hasFinancialEngineAgreement(transactionId: number): Promise<boolean> {
  const [row] = await db.select({ id: commissionAgreements.id }).from(commissionAgreements).where(eq(commissionAgreements.transactionId, transactionId));
  return Boolean(row);
}

export async function getExistingLegacyReconciliation(transactionId: number, brokerageId: number): Promise<FinancialReconciliation | null> {
  const [row] = await db
    .select()
    .from(financialReconciliations)
    .where(
      and(
        eq(financialReconciliations.brokerageId, brokerageId),
        eq(financialReconciliations.recordType, LEGACY_RECONCILIATION_RECORD_TYPE),
        eq(financialReconciliations.recordId, String(transactionId)),
      ),
    );
  return row ?? null;
}

export interface ReconcileLegacyCommissionInput {
  transactionId: number;
  brokerageId: number;
  propertyId: number;
  actorUserId?: number | null;
  /** When true, performs every check but writes nothing — used by the backfill script's dry-run mode. */
  dryRun?: boolean;
}

export interface ReconcileLegacyCommissionResult {
  created: boolean;
  dryRun: boolean;
  reconciliation: FinancialReconciliation | null;
  skippedReason?: string;
  preview?: LegacyCommissionContext;
}

/**
 * The single-transaction action behind "Flag for reconciliation" in
 * FinancialSummarySection.tsx, and the per-row operation the backfill
 * script below calls in a loop. Never touches commissionAgreements or
 * commissionCalculations — only ever creates a financialReconciliations
 * row, preserving the original legacy amounts exactly (Section 7 point 6)
 * and tagging its source (point 5) so it is always traceable back to the
 * legacy transactions row it came from.
 */
export async function reconcileLegacyCommission(input: ReconcileLegacyCommissionInput): Promise<ReconcileLegacyCommissionResult> {
  const context = await getLegacyCommissionContext(input.transactionId, input.brokerageId);
  if (!context) {
    return { created: false, dryRun: Boolean(input.dryRun), reconciliation: null, skippedReason: "No eligible legacy commission found for this transaction (not present, or transaction not yet Settled/Closed)." };
  }

  // Financial Transaction Engine Verification (Step 2) defect found directly
  // while verifying COHERENCE-001: getPropertyFinancialSummary only ever
  // surfaces legacyCommission (and therefore the UI's "Flag for
  // Reconciliation" button) when the property has NO Financial Engine
  // commissionAgreement, but this function is reachable directly via its
  // route independent of that UI gate. Without this check, calling it on a
  // transaction that already has a real commissionAgreement would create a
  // confusing, superfluous LEGACY_TRANSACTION_COMMISSION reconciliation
  // record sitting alongside a real one — re-introducing a smaller version
  // of the exact two-systems incoherence COHERENCE-001 was about. Section 8
  // test 4 ("Transaction already containing a Financial Engine calculation")
  // covers this.
  if (await hasFinancialEngineAgreement(input.transactionId)) {
    return { created: false, dryRun: Boolean(input.dryRun), reconciliation: null, skippedReason: "A Financial Engine commission agreement already exists for this transaction; legacy reconciliation does not apply." };
  }

  const existing = await getExistingLegacyReconciliation(input.transactionId, input.brokerageId);
  if (existing) {
    return { created: false, dryRun: Boolean(input.dryRun), reconciliation: existing, skippedReason: "Already flagged for reconciliation." };
  }

  if (input.dryRun) {
    return { created: false, dryRun: true, reconciliation: null, preview: context };
  }

  const [inserted] = await db
    .insert(financialReconciliations)
    .values({
      brokerageId: input.brokerageId,
      recordType: LEGACY_RECONCILIATION_RECORD_TYPE,
      recordId: String(input.transactionId),
      expectedAmountCents: null, // nothing was ever "expected" under the Financial Engine's own rules — this predates them
      reportedAmountCents: context.grossCommissionCents,
      evidenceAmountCents: null,
      differenceCents: null,
      status: "UNRECONCILED",
      source: LEGACY_RECONCILIATION_SOURCE,
      externalReference: null,
      evidenceRef: null,
      notes:
        `Legacy commission ${(context.grossCommissionCents / 100).toFixed(2)}` +
        (context.gstCents != null ? ` + ${(context.gstCents / 100).toFixed(2)} GST` : "") +
        ` recorded on transaction ${context.transactionId} (status ${context.transactionStatus}) before the Financial Transaction Engine existed for this brokerage. ` +
        `No commissionAgreement/commissionCalculation exists for this transaction and none was fabricated by this process — the original calculation method and rate were never captured by the legacy schema. ` +
        `Resolve by drafting and approving a real commission agreement (Financial Summary → Commission Agreement) if the historical terms are known, or by manually marking this record RECONCILED with a note if no further action is warranted.`,
    })
    .returning();

  await db.insert(financialLedgerEvents).values({
    brokerageId: input.brokerageId,
    propertyId: input.propertyId,
    transactionId: input.transactionId,
    eventType: "LEGACY_COMMISSION_FLAGGED_FOR_RECONCILIATION",
    amountCents: context.grossCommissionCents,
    sourceRecordType: LEGACY_RECONCILIATION_RECORD_TYPE,
    sourceRecordId: String(inserted!.id),
    actorType: input.actorUserId != null ? "USER" : "SYSTEM",
    actorUserId: input.actorUserId ?? null,
    reason: LEGACY_RECONCILIATION_SOURCE,
  });

  return { created: true, dryRun: false, reconciliation: inserted! };
}

// ---------------------------------------------------------------------
// Backfill scan + report (Section 7's "preferred solution" shape, adapted
// to the safe-fallback content described above): finds every Settled/
// Closed transaction in a brokerage with a legacy commission and no
// Financial Engine agreement, and flags each one — never overwriting an
// existing Financial Engine record (it never touches those tables at
// all), safe to rerun (each row is independently idempotent via
// reconcileLegacyCommission's own SELECT-before-INSERT), and dry-run
// capable.
// ---------------------------------------------------------------------

export interface FindTransactionsNeedingLegacyReconciliationRow {
  transactionId: number;
  propertyId: number;
  status: string;
  grossCommissionCents: number;
}

export async function findTransactionsNeedingLegacyReconciliation(brokerageId: number): Promise<FindTransactionsNeedingLegacyReconciliationRow[]> {
  const rows = await db
    .select({
      transactionId: transactions.id,
      propertyId: transactions.propertyId,
      status: transactions.status,
      grossCommissionCents: transactions.grossCommissionCents,
    })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .leftJoin(commissionAgreements, eq(commissionAgreements.transactionId, transactions.id))
    .where(and(eq(properties.brokerageId, brokerageId), isNull(commissionAgreements.id)));

  return rows.filter(
    (r): r is FindTransactionsNeedingLegacyReconciliationRow =>
      r.grossCommissionCents != null && (RECONCILIATION_ELIGIBLE_STATUSES as readonly string[]).includes(r.status),
  );
}

export interface LegacyReconciliationBackfillReport {
  brokerageId: number;
  dryRun: boolean;
  scanned: number;
  created: number;
  alreadyFlagged: number;
  skipped: Array<{ transactionId: number; reason: string }>;
  rows: Array<{ transactionId: number; propertyId: number; grossCommissionCents: number; outcome: "created" | "already_flagged" | "would_create" }>;
}

/**
 * The backfill "script" (Section 7's numbered list) — a reusable function
 * called both by the CLI wrapper (scripts/reconcileLegacyCommissions.ts)
 * and, potentially, an authorised admin-triggered brokerage-wide route in
 * a future iteration (not added in this remediation, to stay tightly
 * scoped to what the audit's two findings actually require). Produces a
 * full report rather than a bare count, per Section 7 point 11.
 */
export async function runLegacyCommissionReconciliationBackfill(
  brokerageId: number,
  options: { dryRun?: boolean; actorUserId?: number | null } = {},
): Promise<LegacyReconciliationBackfillReport> {
  const dryRun = options.dryRun ?? true; // default to dry-run — an explicit opt-in is required to actually write
  const candidates = await findTransactionsNeedingLegacyReconciliation(brokerageId);

  const report: LegacyReconciliationBackfillReport = {
    brokerageId,
    dryRun,
    scanned: candidates.length,
    created: 0,
    alreadyFlagged: 0,
    skipped: [],
    rows: [],
  };

  for (const candidate of candidates) {
    const result = await reconcileLegacyCommission({
      transactionId: candidate.transactionId,
      brokerageId,
      propertyId: candidate.propertyId,
      actorUserId: options.actorUserId ?? null,
      dryRun,
    });

    if (result.created) {
      report.created += 1;
      report.rows.push({ transactionId: candidate.transactionId, propertyId: candidate.propertyId, grossCommissionCents: candidate.grossCommissionCents, outcome: "created" });
    } else if (result.skippedReason === "Already flagged for reconciliation.") {
      report.alreadyFlagged += 1;
      report.rows.push({ transactionId: candidate.transactionId, propertyId: candidate.propertyId, grossCommissionCents: candidate.grossCommissionCents, outcome: "already_flagged" });
    } else if (dryRun && result.preview) {
      report.rows.push({ transactionId: candidate.transactionId, propertyId: candidate.propertyId, grossCommissionCents: candidate.grossCommissionCents, outcome: "would_create" });
    } else if (result.skippedReason) {
      report.skipped.push({ transactionId: candidate.transactionId, reason: result.skippedReason });
    }
  }

  return report;
}

export type { Transaction };
