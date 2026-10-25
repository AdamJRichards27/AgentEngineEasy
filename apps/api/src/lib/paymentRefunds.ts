// Refund ledger (Owner t429u; design orchestrator/specs/partial-refund-ledger.md; migration 0039, GATED).
//
// remaining = payments.amount_cents - payments.refunded_cents - SUM(in-flight payment_refunds)
//
// Request: one short transaction locks the payment row (FOR UPDATE, brokerage-scoped), checks the
// remaining amount including in-flight reservations, inserts a PENDING refund row with an idempotency
// key minted once, and commits. The provider call happens AFTER commit (no DB lock across a network
// call). The outcome is then written with conditional updates, so a webhook, the reconciler and the
// request path can race without double-counting: whichever moves the row first wins, the others are
// no-ops. payments.refunded_cents only moves on the one transition into SUCCEEDED, and the 0039 CHECK
// (refunded_cents <= amount_cents) is the last-line guard against over-refund.
//
// Unknown outcomes are never blindly retried: the reconciler looks the refund up at the provider first;
// it re-sends only with the SAME key, only when the lookup proves no refund exists and the key is still
// inside the provider's idempotency window; otherwise MANUAL_REVIEW.
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, payments, paymentRefunds, serviceOrders, properties, auditLogs } from "@aee/db";
import type { Payment, PaymentRefund, PaymentRefundStatus } from "@aee/db";
import { logger } from "@aee/events";
import { RefundRejectedError, type ProviderRefundReport, type RefundResult } from "@aee/integration-payments";
import { paymentProvider } from "./paymentProvider.js";

export type PaymentRefundErrorCode =
  | "PAYMENT_NOT_FOUND"
  | "PAYMENT_NOT_REFUNDABLE"
  | "PAYMENT_NO_CHARGE_REFERENCE"
  | "REFUND_AMOUNT_INVALID"
  | "REFUND_AMOUNT_EXCEEDS_REMAINING"
  | "REFUND_NOT_FOUND"
  | "REFUND_ALREADY_RESOLVED"
  | "REFUND_IN_REVIEW";
export class PaymentRefundError extends Error {
  constructor(public readonly code: PaymentRefundErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "PaymentRefundError";
  }
}

export const IN_FLIGHT_REFUND_STATUSES: PaymentRefundStatus[] = ["PENDING", "SUBMITTED", "UNKNOWN", "MANUAL_REVIEW"];
export const REFUNDABLE_PAYMENT_STATUSES = ["Succeeded", "PartiallyRefunded"];
/** A PENDING row older than this is treated as UNKNOWN (process died between INSERT and the provider call). */
export const PENDING_LEASE_MS = 5 * 60 * 1000;
export const MAX_RECONCILE_ATTEMPTS = 5;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface RefundOutcome {
  payment: Payment;
  refund: PaymentRefund;
  replayed: boolean;
}

function providerName(): string {
  return process.env.PAYMENT_PROVIDER ?? "mock";
}

async function audit(tx: Tx | typeof db, input: { brokerageId: number; userId?: number | null; refund: PaymentRefund; from: string; to: string; note?: string }) {
  await tx.insert(auditLogs).values({
    brokerageId: input.brokerageId,
    userId: input.userId ?? null,
    action: `payment_refund_${input.to.toLowerCase()}`,
    recordType: "payment_refund",
    recordId: String(input.refund.id),
    previousValue: input.from,
    updatedValue: JSON.stringify({ status: input.to, paymentId: input.refund.paymentId, amountCents: input.refund.amountCents, note: input.note }),
    providerReference: input.refund.providerRefundRef ?? undefined,
  });
}

async function lockPaymentInBrokerage(tx: Tx, paymentId: number, brokerageId: number): Promise<Payment | null> {
  const [row] = await tx
    .select({ payment: payments })
    .from(payments)
    .innerJoin(serviceOrders, eq(serviceOrders.id, payments.serviceOrderId))
    .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
    .where(and(eq(payments.id, paymentId), eq(properties.brokerageId, brokerageId)))
    .for("update", { of: payments });
  return row?.payment ?? null;
}

async function inFlightCents(tx: Tx, paymentId: number): Promise<number> {
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${paymentRefunds.amountCents}), 0)::int` })
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.paymentId, paymentId), inArray(paymentRefunds.status, IN_FLIGHT_REFUND_STATUSES)));
  return Number(row?.total ?? 0);
}

export function remainingCents(payment: Pick<Payment, "amountCents" | "refundedCents">, inFlight: number): number {
  return payment.amountCents - payment.refundedCents - inFlight;
}

/** Request path: reserve, then submit once. */
export async function requestRefund(input: {
  paymentId: number;
  amountCents?: number;
  brokerageId: number;
  userId?: number;
  clientIdempotencyKey?: string;
  reason?: string;
}): Promise<RefundOutcome> {
  const reserved = await db.transaction(async (tx) => {
    const payment = await lockPaymentInBrokerage(tx, input.paymentId, input.brokerageId);
    if (!payment) throw new PaymentRefundError("PAYMENT_NOT_FOUND", `Payment ${input.paymentId} not found`);

    // Client double-click safety: the same caller key returns the same refund row, never a second refund.
    const clientKey = input.clientIdempotencyKey ? `payment-refund:${payment.id}:client:${input.clientIdempotencyKey}` : null;
    if (clientKey) {
      const [existing] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.idempotencyKey, clientKey));
      if (existing) return { payment, refund: existing, replayed: true };
    }

    if (!REFUNDABLE_PAYMENT_STATUSES.includes(payment.status)) {
      throw new PaymentRefundError("PAYMENT_NOT_REFUNDABLE", `Payment ${input.paymentId} is not in a refundable state (status: ${payment.status})`);
    }
    if (!payment.providerChargeRef) {
      throw new PaymentRefundError("PAYMENT_NO_CHARGE_REFERENCE", `Payment ${input.paymentId} has no provider charge reference to refund`);
    }
    const remaining = remainingCents(payment, await inFlightCents(tx, payment.id));
    if (remaining <= 0) {
      // Everything left is reserved by refunds still in flight or in review.
      throw new PaymentRefundError("REFUND_IN_REVIEW", `Payment ${input.paymentId} has no unreserved amount left`);
    }
    if (input.amountCents !== undefined && input.amountCents > remaining) {
      throw new PaymentRefundError("REFUND_AMOUNT_EXCEEDS_REMAINING", `requested ${input.amountCents} > remaining ${remaining}`);
    }
    const amount = input.amountCents ?? remaining;

    const placeholder = clientKey ?? `payment-refund:${payment.id}:pending:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const [inserted] = await tx
      .insert(paymentRefunds)
      .values({
        paymentId: payment.id,
        brokerageId: input.brokerageId,
        amountCents: amount,
        status: "PENDING",
        idempotencyKey: placeholder,
        provider: providerName(),
        reason: input.reason ?? null,
        requestedByUserId: input.userId ?? null,
      })
      .returning();
    let refund = inserted;
    if (!clientKey) {
      // The key is minted ONCE here, from the row id, and never re-minted.
      [refund] = await tx.update(paymentRefunds).set({ idempotencyKey: `payment-refund:${payment.id}:${inserted.id}` }).where(eq(paymentRefunds.id, inserted.id)).returning();
    }
    await audit(tx, { brokerageId: input.brokerageId, userId: input.userId, refund, from: "-", to: "PENDING" });
    return { payment, refund, replayed: false };
  });

  if (reserved.replayed) {
    return { payment: await reloadPayment(reserved.payment.id), refund: reserved.refund, replayed: true };
  }
  const refund = await submitToProvider(reserved.refund, reserved.payment.providerChargeRef!, input.userId);
  return { payment: await reloadPayment(reserved.payment.id), refund, replayed: false };
}

async function reloadPayment(id: number): Promise<Payment> {
  const [p] = await db.select().from(payments).where(eq(payments.id, id));
  return p;
}
async function reloadRefund(id: number): Promise<PaymentRefund> {
  const [r] = await db.select().from(paymentRefunds).where(eq(paymentRefunds.id, id));
  return r;
}

/** PENDING|UNKNOWN -> SUBMITTED, then exactly one provider call with the row's own key. */
async function submitToProvider(refund: PaymentRefund, providerChargeRef: string, userId?: number | null, fromStatuses: PaymentRefundStatus[] = ["PENDING"]): Promise<PaymentRefund> {
  const now = new Date();
  const [claimed] = await db
    .update(paymentRefunds)
    .set({ status: "SUBMITTED", submittedAt: refund.submittedAt ?? now, updatedAt: now, nextReconcileAt: new Date(now.getTime() + PENDING_LEASE_MS) })
    .where(and(eq(paymentRefunds.id, refund.id), inArray(paymentRefunds.status, fromStatuses)))
    .returning();
  if (!claimed) return reloadRefund(refund.id); // someone else already moved it

  let result: RefundResult;
  try {
    result = await paymentProvider.refund({
      providerChargeRef,
      amountCents: claimed.amountCents,
      idempotencyKey: claimed.idempotencyKey,
      aeRefundId: claimed.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RefundRejectedError) {
      return markFailed(claimed.id, message, ["SUBMITTED"], userId);
    }
    logger.warn("payment_refund_outcome_unknown", { refundId: claimed.id, paymentId: claimed.paymentId, error: message });
    return transition(claimed.id, ["SUBMITTED"], "UNKNOWN", { failureReason: message, nextReconcileAt: new Date(Date.now() + 60_000) }, userId);
  }
  return applyProviderResult(claimed.id, result, ["SUBMITTED"], userId);
}

async function applyProviderResult(refundId: number, result: RefundResult, fromStatuses: PaymentRefundStatus[], userId?: number | null): Promise<PaymentRefund> {
  if (result.status === "Succeeded") return markSucceeded(refundId, result.providerRefundRef, fromStatuses, userId);
  if (result.status === "Failed") return markFailed(refundId, result.failureReason ?? "Provider reported the refund failed", fromStatuses, userId, result.providerRefundRef);
  // Pending: keep SUBMITTED with the provider ref; the webhook or reconciler resolves it.
  const [row] = await db
    .update(paymentRefunds)
    .set({ status: "SUBMITTED", providerRefundRef: result.providerRefundRef, updatedAt: new Date(), nextReconcileAt: new Date(Date.now() + PENDING_LEASE_MS) })
    .where(and(eq(paymentRefunds.id, refundId), inArray(paymentRefunds.status, fromStatuses)))
    .returning();
  return row ?? reloadRefund(refundId);
}

async function transition(
  refundId: number,
  fromStatuses: PaymentRefundStatus[],
  to: PaymentRefundStatus,
  patch: Partial<Pick<PaymentRefund, "failureReason" | "nextReconcileAt" | "providerRefundRef" | "reconcileAttempts">>,
  userId?: number | null,
  note?: string,
): Promise<PaymentRefund> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, refundId));
    const [row] = await tx
      .update(paymentRefunds)
      .set({ ...patch, status: to, updatedAt: new Date(), resolvedAt: to === "FAILED" || to === "SUCCEEDED" ? new Date() : null })
      .where(and(eq(paymentRefunds.id, refundId), inArray(paymentRefunds.status, fromStatuses)))
      .returning();
    if (!row) return before;
    await audit(tx, { brokerageId: row.brokerageId, userId, refund: row, from: before.status, to, note });
    return row;
  });
}

export async function markFailed(refundId: number, reason: string, fromStatuses: PaymentRefundStatus[], userId?: number | null, providerRefundRef?: string): Promise<PaymentRefund> {
  return transition(refundId, fromStatuses, "FAILED", { failureReason: reason, ...(providerRefundRef ? { providerRefundRef } : {}) }, userId);
}

/** The ONLY place refunded_cents moves: the single conditional transition into SUCCEEDED. */
export async function markSucceeded(refundId: number, providerRefundRef: string | null, fromStatuses: PaymentRefundStatus[], userId?: number | null, note?: string): Promise<PaymentRefund> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(paymentRefunds).where(eq(paymentRefunds.id, refundId));
    if (!before) throw new PaymentRefundError("REFUND_NOT_FOUND");
    // Lock the payment first (same order as the request path) to avoid deadlocks.
    await tx.select({ id: payments.id }).from(payments).where(eq(payments.id, before.paymentId)).for("update");
    const [row] = await tx
      .update(paymentRefunds)
      .set({
        status: "SUCCEEDED",
        providerRefundRef: providerRefundRef ?? before.providerRefundRef,
        resolvedAt: new Date(),
        updatedAt: new Date(),
        nextReconcileAt: null,
      })
      .where(and(eq(paymentRefunds.id, refundId), inArray(paymentRefunds.status, fromStatuses)))
      .returning();
    if (!row) return before; // already resolved by someone else: do nothing
    const [p] = await tx
      .update(payments)
      .set({ refundedCents: sql`${payments.refundedCents} + ${row.amountCents}`, updatedAt: new Date() })
      .where(eq(payments.id, row.paymentId))
      .returning();
    const status = p.refundedCents >= p.amountCents ? "Refunded" : "PartiallyRefunded";
    await tx.update(payments).set({ status }).where(eq(payments.id, p.id));
    await tx.update(serviceOrders).set({ paymentStatus: status }).where(eq(serviceOrders.id, p.serviceOrderId));
    await audit(tx, { brokerageId: row.brokerageId, userId, refund: row, from: before.status, to: "SUCCEEDED", note });
    return row;
  });
}

export interface ReconcileSummary {
  examined: number;
  succeeded: number;
  failed: number;
  retried: number;
  manualReview: number;
  stillPending: number;
}

/**
 * Reconciler sweep: SUBMITTED/UNKNOWN rows that are due, plus stale PENDING rows (older than the
 * lease: the process died between INSERT and the provider call). Ordered by due time then id.
 */
export async function reconcileRefunds(options: { now?: Date; limit?: number; onlyPaymentIds?: number[] } = {}): Promise<ReconcileSummary> {
  const now = options.now ?? new Date();
  const summary: ReconcileSummary = { examined: 0, succeeded: 0, failed: 0, retried: 0, manualReview: 0, stillPending: 0 };
  const due = await db
    .select({ refund: paymentRefunds, chargeRef: payments.providerChargeRef })
    .from(paymentRefunds)
    .innerJoin(payments, eq(payments.id, paymentRefunds.paymentId))
    .where(
      and(
        or(
          and(inArray(paymentRefunds.status, ["SUBMITTED", "UNKNOWN"]), or(sql`${paymentRefunds.nextReconcileAt} is null`, lte(paymentRefunds.nextReconcileAt, now))),
          and(eq(paymentRefunds.status, "PENDING"), lte(paymentRefunds.createdAt, new Date(now.getTime() - PENDING_LEASE_MS))),
        ),
        options.onlyPaymentIds ? inArray(paymentRefunds.paymentId, options.onlyPaymentIds) : undefined,
      ),
    )
    .orderBy(asc(paymentRefunds.nextReconcileAt), asc(paymentRefunds.id))
    .limit(options.limit ?? 50);

  for (const { refund, chargeRef } of due) {
    summary.examined += 1;
    const outcome = await reconcileOne(refund, chargeRef, now);
    summary[outcome] += 1;
  }
  const unresolved = await db
    .select({ status: paymentRefunds.status, n: sql<number>`count(*)::int` })
    .from(paymentRefunds)
    .where(inArray(paymentRefunds.status, ["UNKNOWN", "MANUAL_REVIEW"]))
    .groupBy(paymentRefunds.status);
  // Gauge-equivalent log line (payment_refunds_unresolved{status}); alerting on MANUAL_REVIEW > 0 is an open item.
  logger.info("payment_refunds_unresolved", { counts: Object.fromEntries(unresolved.map((u) => [u.status, Number(u.n)])), ...summary });
  return summary;
}

async function reconcileOne(refund: PaymentRefund, chargeRef: string | null, now: Date): Promise<keyof Omit<ReconcileSummary, "examined">> {
  const from = [refund.status as PaymentRefundStatus];
  // Lease the row: bump attempts and push next_reconcile_at, conditionally, so two sweeps don't both work it.
  const backoffMs = Math.min(60_000 * 2 ** refund.reconcileAttempts, 60 * 60_000);
  const [leased] = await db
    .update(paymentRefunds)
    .set({ reconcileAttempts: refund.reconcileAttempts + 1, nextReconcileAt: new Date(now.getTime() + backoffMs), updatedAt: new Date() })
    .where(and(eq(paymentRefunds.id, refund.id), eq(paymentRefunds.status, refund.status), eq(paymentRefunds.reconcileAttempts, refund.reconcileAttempts)))
    .returning();
  if (!leased) return "stillPending";
  // A stale PENDING is treated exactly as UNKNOWN: it may or may not have reached the provider.
  if (leased.status === "PENDING") {
    await transition(leased.id, ["PENDING"], "UNKNOWN", { failureReason: "Stale PENDING past lease; outcome unknown" });
    from[0] = "UNKNOWN";
  }

  if (!chargeRef) return toManualReview(leased.id, from, "No provider charge reference");
  if (leased.reconcileAttempts > MAX_RECONCILE_ATTEMPTS) return toManualReview(leased.id, from, `Reconcile attempts exceeded ${MAX_RECONCILE_ATTEMPTS}`);
  if (typeof paymentProvider.lookupRefund !== "function") return toManualReview(leased.id, from, "Provider has no refund lookup");

  // 1. Lookup first.
  let found: RefundResult | null;
  try {
    found = await paymentProvider.lookupRefund({ providerChargeRef: chargeRef, aeRefundId: leased.id, providerRefundRef: leased.providerRefundRef });
  } catch (err) {
    logger.warn("payment_refund_lookup_failed", { refundId: leased.id, error: err instanceof Error ? err.message : String(err) });
    return "stillPending"; // try again later; attempts cap sends it to review
  }
  if (found) {
    const r = await applyProviderResult(leased.id, found, from);
    return r.status === "SUCCEEDED" ? "succeeded" : r.status === "FAILED" ? "failed" : "stillPending";
  }
  // 2. Proven absent. Retry only with the SAME key and only inside the idempotency window.
  const keyBornAt = (leased.submittedAt ?? leased.createdAt).getTime();
  if (now.getTime() - keyBornAt < paymentProvider.refundIdempotencyWindowMs) {
    await submitToProvider(leased, chargeRef, null, from);
    return "retried";
  }
  // 3. Otherwise: a human decides. Never a new key, never a blind POST.
  return toManualReview(leased.id, from, "Not found at provider and outside the idempotency window");
}

async function toManualReview(refundId: number, from: PaymentRefundStatus[], reason: string): Promise<"manualReview"> {
  await transition(refundId, from, "MANUAL_REVIEW", { failureReason: reason, nextReconcileAt: null });
  logger.warn("payment_refund_manual_review", { refundId, reason });
  return "manualReview";
}

/** Operator action on a MANUAL_REVIEW refund (Brokerage Administrator + run.access at the route). */
export async function resolveRefundManually(input: {
  refundId: number;
  brokerageId: number;
  userId: number;
  action: "mark_succeeded" | "mark_failed";
  providerRefundRef?: string;
  note: string;
}): Promise<PaymentRefund> {
  const [row] = await db.select().from(paymentRefunds).where(and(eq(paymentRefunds.id, input.refundId), eq(paymentRefunds.brokerageId, input.brokerageId)));
  if (!row) throw new PaymentRefundError("REFUND_NOT_FOUND", `Refund ${input.refundId} not found`);
  if (row.status !== "MANUAL_REVIEW") throw new PaymentRefundError("REFUND_ALREADY_RESOLVED", `Refund ${input.refundId} is ${row.status}`);
  const updated =
    input.action === "mark_succeeded"
      ? await markSucceeded(row.id, input.providerRefundRef ?? null, ["MANUAL_REVIEW"], input.userId, input.note)
      : await transition(row.id, ["MANUAL_REVIEW"], "FAILED", { failureReason: input.note }, input.userId, input.note);
  if (updated.status === "MANUAL_REVIEW") throw new PaymentRefundError("REFUND_ALREADY_RESOLVED");
  return updated;
}

/**
 * Webhook: route each reported refund to its own row. Unknown refunds (made outside AE, e.g. in the
 * provider dashboard) become an EXTERNAL MANUAL_REVIEW row and an alert; the ledger is not changed silently.
 * Returns true when anything changed.
 */
export async function applyProviderRefundReports(payment: Payment, reports: ProviderRefundReport[]): Promise<boolean> {
  let changed = false;
  const [scope] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(serviceOrders)
    .innerJoin(properties, eq(properties.id, serviceOrders.propertyId))
    .where(eq(serviceOrders.id, payment.serviceOrderId));
  for (const report of reports) {
    const [row] = await db
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.paymentId, payment.id),
          report.aeRefundId !== undefined
            ? or(eq(paymentRefunds.providerRefundRef, report.providerRefundRef), eq(paymentRefunds.id, report.aeRefundId))
            : eq(paymentRefunds.providerRefundRef, report.providerRefundRef),
        ),
      );
    if (!row) {
      if (!scope) continue;
      const [inserted] = await db
        .insert(paymentRefunds)
        .values({
          paymentId: payment.id,
          brokerageId: scope.brokerageId,
          amountCents: Math.max(1, report.amountCents),
          status: "MANUAL_REVIEW",
          idempotencyKey: `payment-refund:${payment.id}:external:${report.providerRefundRef}`,
          provider: providerName(),
          providerRefundRef: report.providerRefundRef,
          reason: "EXTERNAL",
          failureReason: "Refund reported by the provider with no matching AE refund",
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        await audit(db, { brokerageId: scope.brokerageId, refund: inserted, from: "-", to: "MANUAL_REVIEW", note: "EXTERNAL" });
        logger.warn("payment_refund_external_detected", { paymentId: payment.id, providerRefundRef: report.providerRefundRef, amountCents: report.amountCents });
        changed = true;
      }
      continue;
    }
    const open: PaymentRefundStatus[] = ["PENDING", "SUBMITTED", "UNKNOWN"];
    if (!open.includes(row.status as PaymentRefundStatus)) continue; // duplicate delivery / already resolved / in review
    const r = await applyProviderResult(row.id, { providerRefundRef: report.providerRefundRef, status: report.status, failureReason: report.failureReason }, open);
    if (r.status !== row.status) changed = true;
  }
  return changed;
}

export async function listRefundsForPayment(paymentId: number, brokerageId: number): Promise<PaymentRefund[]> {
  return db
    .select()
    .from(paymentRefunds)
    .where(and(eq(paymentRefunds.paymentId, paymentId), eq(paymentRefunds.brokerageId, brokerageId)))
    .orderBy(asc(paymentRefunds.id));
}

// ---- Scheduler (registered from index.ts; OFF unless PAYMENT_REFUND_RECONCILER_ENABLED="true") ----
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;
export function registerPaymentRefundReconciler(options: { startScheduler?: boolean; intervalMs?: number } = {}): void {
  const start = options.startScheduler ?? (process.env.NODE_ENV !== "test" && process.env.PAYMENT_REFUND_RECONCILER_ENABLED === "true");
  if (!start || intervalHandle) return;
  intervalHandle = setInterval(() => {
    if (running) return;
    running = true;
    reconcileRefunds()
      .catch((error) => logger.error("payment_refund_reconcile_failed", { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        running = false;
      });
  }, options.intervalMs ?? 60_000);
  intervalHandle.unref?.();
}
export function stopPaymentRefundReconciler(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
