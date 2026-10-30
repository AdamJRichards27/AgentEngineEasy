// Owner t211u item 4: provider-managed direct-debit retries.
//
// AE never re-collects a direct debit itself (the scheduler retries stored
// cards only; collection refuses a DD in RETRY_SCHEDULED; one SCHEDULE_DEBIT
// outbox row per fee). When the provider manages retries, AE only RECONCILES
// the provider's own status for each debit it already scheduled:
//   provider RetryScheduled -> RETRY_SCHEDULED (provider's attempt count and time)
//   provider Processing     -> PROCESSING
//   provider Paid           -> PAID (+ receipt)
//   provider Failed (final) -> FAILED (+ failure receipt)
// A non-final Failed, Scheduled, or no record changes nothing. Read-only
// provider calls only; sandbox (mock) provider only. Each change is a
// compare-and-set under a row lock, so repeated passes are no-ops.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, financialLedgerEvents, financialPaymentRequests, pcFeeAuthorities, type FinancialPaymentRequest } from "@aee/db";
import type { ProviderDebitStatus } from "@aee/integration-mandate-payments";
import { logger } from "@aee/events";
import { mandatePaymentProvider, mandateProviderPermitted } from "./provider.js";
import { ADJUSTED_STATUSES, hasPaidAfterAdjustmentException, raisePaidAfterAdjustment } from "./reconciliationExceptions.js";
import { syncReceiptsForPaymentRequest } from "./receipts.js";
import { emitFinancialEvent } from "./events.js";

const RECONCILABLE = ["DEBIT_SCHEDULED", "PROCESSING", "RETRY_SCHEDULED"];

export interface DdReconciliationResult {
  /** t212u item 3: Paid reported for a waived / written-off fee -> reconciliation exceptions raised (no mutation). */
  exceptions?: number;
  checked: number;
  updated: number;
  unchanged: number;
  unavailable: number;
}

type Target = { status: string; set: Partial<FinancialPaymentRequest>; ledger: string; reason: string } | null;

function targetFor(req: FinancialPaymentRequest, p: ProviderDebitStatus): Target {
  const now = new Date();
  switch (p.status) {
    case "RetryScheduled": {
      const next = p.nextAttemptAt ?? null;
      if (req.status === "RETRY_SCHEDULED" && req.retryCount === p.attempt && (req.nextAttemptAt?.getTime() ?? null) === (next?.getTime() ?? null)) return null;
      return {
        status: "RETRY_SCHEDULED",
        set: { retryCount: p.attempt, nextAttemptAt: next, failureReason: p.failureReason ?? "Payment failed", providerStatus: "RetryScheduled", failedAt: null },
        ledger: "PC_FEE_PAYMENT_FAILED",
        reason: `Direct debit attempt ${p.attempt} failed (${p.failureReason ?? "unspecified"}); the provider will retry${next ? ` at ${next.toISOString()}` : ""}. AE does not re-collect.`,
      };
    }
    case "Processing":
      if (req.status === "PROCESSING") return null;
      return { status: "PROCESSING", set: { processingStartedAt: req.processingStartedAt ?? now, nextAttemptAt: null, providerStatus: "Processing" }, ledger: "PC_FEE_PAYMENT_PROCESSING", reason: "Provider reports the debit is processing." };
    case "Paid":
      return { status: "PAID", set: { paidAt: now, nextAttemptAt: null, failureReason: null, providerStatus: "Paid" }, ledger: "PC_FEE_PAID", reason: `Provider reports the debit paid (attempt ${p.attempt}).` };
    case "Failed":
      if (!p.final) return null;
      return {
        status: "FAILED",
        set: { retryCount: p.attempt, nextAttemptAt: null, failedAt: now, failureReason: p.failureReason ?? "Payment failed", providerStatus: "Failed" },
        ledger: "PC_FEE_PAYMENT_FAILED",
        reason: `Provider stopped retrying after ${p.attempt} attempt(s) (${p.failureReason ?? "unspecified"}).`,
      };
    default:
      return null;
  }
}

export async function reconcileProviderManagedDebits(opts: { brokerageIds?: number[]; limit?: number } = {}): Promise<DdReconciliationResult> {
  const result: DdReconciliationResult = { checked: 0, updated: 0, unchanged: 0, unavailable: 0 };
  if (!mandateProviderPermitted() || mandatePaymentProvider.retryManagement !== "PROVIDER_MANAGED" || typeof mandatePaymentProvider.getDebitStatus !== "function") return result;

  const conds = [
    eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE"),
    inArray(financialPaymentRequests.status, RECONCILABLE),
    isNotNull(financialPaymentRequests.providerRequestRef),
    eq(financialPaymentRequests.provider, mandatePaymentProvider.name),
    eq(pcFeeAuthorities.authorisedPaymentMethod, "GENERAL_ACCOUNT_DEBIT_MANDATE"),
  ];
  if (opts.brokerageIds) conds.push(inArray(financialPaymentRequests.brokerageId, opts.brokerageIds.length ? opts.brokerageIds : [-1]));
  const rows = await db
    .select({ req: financialPaymentRequests })
    .from(financialPaymentRequests)
    .innerJoin(pcFeeAuthorities, eq(pcFeeAuthorities.id, financialPaymentRequests.pcFeeAuthorityId))
    .where(and(...conds))
    .limit(opts.limit ?? 100);

  for (const { req } of rows) {
    result.checked += 1;
    let status: ProviderDebitStatus | null = null;
    try {
      status = await mandatePaymentProvider.getDebitStatus(req.providerRequestRef!);
    } catch (err) {
      logger.warn("financial_dd_reconciliation_status_unavailable", { paymentRequestId: req.id, error: (err as Error).message });
    }
    if (!status || status.providerRequestRef !== req.providerRequestRef) {
      result.unavailable += 1;
      continue;
    }
    const target = targetFor(req, status);
    if (!target) {
      result.unchanged += 1;
      continue;
    }
    const applied = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, req.id)).for("update");
      // Compare-and-set: act only on the state this pass read.
      if (!locked || locked.status !== req.status || locked.retryCount !== req.retryCount || locked.providerRequestRef !== req.providerRequestRef) return null;
      const again = targetFor(locked, status!);
      if (!again) return null;
      const [updated] = await tx
        .update(financialPaymentRequests)
        .set({ ...again.set, status: again.status, updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, req.id))
        .returning();
      await tx.insert(financialLedgerEvents).values({
        brokerageId: updated!.brokerageId,
        propertyId: updated!.propertyId,
        transactionId: updated!.transactionId,
        eventType: again.ledger,
        amountCents: updated!.amountCents,
        sourceRecordType: "PAYMENT_REQUEST",
        sourceRecordId: String(updated!.id),
        actorType: "SYSTEM",
        reason: `${again.reason} (provider status reconciliation)`,
      });
      return updated!;
    });
    if (!applied) {
      result.unchanged += 1;
      continue;
    }
    result.updated += 1;
    try {
      await syncReceiptsForPaymentRequest(applied.id);
      if (applied.status === "PAID" || applied.status === "FAILED") {
        await emitFinancialEvent({
          eventType: applied.status === "PAID" ? "FINANCIAL_PAYMENT_PAID" : "FINANCIAL_PAYMENT_FAILED",
          brokerageId: applied.brokerageId,
          propertyId: applied.propertyId,
          transactionId: applied.transactionId,
          actorType: "SYSTEM",
          source: "api:financial:reconcileProviderManagedDebits",
          payload: { paymentRequestId: applied.id, amountCents: applied.amountCents },
        });
      }
    } catch (err) {
      logger.error("financial_dd_reconciliation_side_effect_failed", { paymentRequestId: applied.id, error: (err as Error).message });
    }
  }
  // Owner t212u item 3: a provider that collects a fee AE already waived / wrote off is surfaced as a
  // reconciliation exception for BA review. The locked request is never changed here.
  const adjusted = await db
    .select({ req: financialPaymentRequests })
    .from(financialPaymentRequests)
    .innerJoin(pcFeeAuthorities, eq(pcFeeAuthorities.id, financialPaymentRequests.pcFeeAuthorityId))
    .where(
      and(
        eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE"),
        inArray(financialPaymentRequests.status, [...ADJUSTED_STATUSES]),
        isNotNull(financialPaymentRequests.providerRequestRef),
        eq(financialPaymentRequests.provider, mandatePaymentProvider.name),
        eq(pcFeeAuthorities.authorisedPaymentMethod, "GENERAL_ACCOUNT_DEBIT_MANDATE"),
        ...(opts.brokerageIds ? [inArray(financialPaymentRequests.brokerageId, opts.brokerageIds.length ? opts.brokerageIds : [-1])] : []),
      ),
    )
    .limit(opts.limit ?? 100);
  for (const { req } of adjusted) {
    if (await hasPaidAfterAdjustmentException(req.id)) continue;
    let status: ProviderDebitStatus | null = null;
    try {
      status = await mandatePaymentProvider.getDebitStatus(req.providerRequestRef!);
    } catch (err) {
      logger.warn("financial_dd_reconciliation_status_unavailable", { paymentRequestId: req.id, error: (err as Error).message });
    }
    if (status?.status === "Paid" && status.providerRequestRef === req.providerRequestRef) {
      const { created } = await raisePaidAfterAdjustment({ request: req, source: "RECONCILIATION", providerRequestRef: req.providerRequestRef!, detail: { providerAttempt: status.attempt } });
      if (created) result.exceptions = (result.exceptions ?? 0) + 1;
    }
  }
  return result;
}
