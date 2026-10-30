// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage D.
//
// Durable payment outbox (Section 31): the reliable-delivery layer between
// a payment request's own state machine and the external mandate-payment
// provider. Calling the provider directly and inline would lose the
// request if the process crashed between the provider call succeeding and
// the local DB write recording that fact — exactly the failure mode
// lib/payments.ts's chargeServiceOrder avoids by inserting a durable
// "Pending" row before calling its own provider. The outbox generalises
// that idea into a retryable queue: enqueueing an action durably records
// the INTENT to call the provider before the call is attempted, so a
// crash mid-dispatch leaves a PENDING row a later sweep will retry, rather
// than nothing at all. The (paymentRequestId, action) unique index is the
// dedup backstop, mirroring financial_payment_requests_transaction_kind_idx
// one layer down.
//
// Scope note: Stage D builds the provider-facing dispatch/retry mechanics
// only. Advancing a payment request through its earlier, business-facing
// states (AWAITING_AUTHORITY, READY_TO_INVOICE, invoice-number issuance)
// is Stage E/G's job; this module picks up from NOTICE_SENT — the point
// at which Section 13's noticeRequiredDays cooling-off period has already
// started — and is the one place in the whole engine that actually calls
// a payment provider. Stage F wires a recurring caller for
// dispatchPendingPaymentOutbox (see lib/financial/bootstrap.ts); this
// module only provides the sweep itself, not its schedule. Stage F also
// adds FINANCIAL_PAYMENT_SCHEDULED/FINANCIAL_PAYMENT_FAILED/
// FINANCIAL_PAYMENT_REVERSED canonical-bus publishing at the three points
// below where a payment request's OWN outcome (not just an outbox
// mechanics detail) changes — see events.ts.

import { eq, and, lte, like, desc } from "drizzle-orm";
import { syncReceiptsForPaymentRequest } from "./receipts.js";
import { incrementCounter, logger } from "@aee/events";
import {
  db,
  financialPaymentRequests,
  financialPaymentOutbox,
  pcFeeAuthorities,
  financialLedgerEvents,
  auditLogs,
  type FinancialPaymentRequest,
  type FinancialPaymentOutbox,
} from "@aee/db";
import { mandatePaymentProvider, mandateProviderPermitted } from "./provider.js";
import { emitFinancialEvent } from "./events.js";
import { collectionTimingFor } from "./pcFeeTerms.js";

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
  correlationId?: string | null;
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
    correlationId: input.correlationId ?? null,
  });
}

const TERMINAL_PAYMENT_REQUEST_STATUSES = new Set(["PAID", "FAILED", "REVERSED", "WAIVED", "WRITTEN_OFF", "DISPUTED", "RECONCILED"]);

/**
 * Marks a payment request as having entered its statutory notice period
 * (Section 13's pcFeeAuthorities.noticeRequiredDays) — a simple pass-through
 * gate rather than a full invoicing workflow; see the module header's
 * scope note. Idempotent: calling it again once already past this point
 * is a no-op that returns the current row unchanged.
 */
export async function advancePaymentRequestToNoticeSent(paymentRequestId: number): Promise<FinancialPaymentRequest> {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, paymentRequestId));
  if (!request) throw new Error(`Payment request ${paymentRequestId} not found.`);

  if (request.status === "NOTICE_SENT" || request.status === "DEBIT_SCHEDULED" || request.status === "PROCESSING") {
    return request;
  }
  if (TERMINAL_PAYMENT_REQUEST_STATUSES.has(request.status)) {
    throw new Error(`Payment request ${paymentRequestId} is ${request.status} — cannot start a notice period from a terminal state.`);
  }
  if (!request.pcFeeAuthorityId) throw new Error(`Payment request ${paymentRequestId} has no pcFeeAuthorityId to read a notice period from.`);

  const [authority] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, request.pcFeeAuthorityId));
  if (!authority) throw new Error(`PC fee authority ${request.pcFeeAuthorityId} not found.`);
  if (authority.status !== "ACTIVE") {
    throw new Error(`PC fee authority ${authority.id} is ${authority.status}, not ACTIVE — cannot start the notice period.`);
  }

  const [updated] = await db
    .update(financialPaymentRequests)
    .set({ status: "NOTICE_SENT", noticeSentAt: new Date(), updatedAt: new Date() })
    .where(eq(financialPaymentRequests.id, paymentRequestId))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    eventType: "PC_FEE_NOTICE_SENT",
    amountCents: updated.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(updated.id),
    actorType: "SYSTEM",
  });

  return updated;
}

export interface ScheduleDebitResult {
  paymentRequest: FinancialPaymentRequest;
  outboxEntry: FinancialPaymentOutbox;
  dispatched: boolean;
}

/**
 * Idempotent chokepoint (mirrors lib/payments.ts's chargeServiceOrder):
 * enqueues a durable SCHEDULE_DEBIT outbox entry for this payment request
 * — the (paymentRequestId, action) unique index means a repeated call
 * returns the SAME outbox row rather than enqueueing twice — then makes
 * one best-effort synchronous dispatch attempt. If that attempt fails (or
 * the process never gets this far), the row is left PENDING for
 * dispatchPendingPaymentOutbox to retry later; nothing is lost either way.
 */
export async function scheduleDebitForPaymentRequest(input: {
  /** The user whose action raised this send (null for system triggers); recorded if the send is held. */
  initiatedByUserId?: number | null;
  paymentRequestId: number;
  correlationId?: string | null;
}): Promise<ScheduleDebitResult> {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, input.paymentRequestId));
  if (!request) throw new Error(`Payment request ${input.paymentRequestId} not found.`);

  // Idempotent short-circuit, checked BEFORE the NOTICE_SENT guard below:
  // once a SCHEDULE_DEBIT outbox entry has actually DISPATCHED, the debit
  // has already been scheduled with the provider and the payment request
  // has already moved on to DEBIT_SCHEDULED — a repeated call (the exact
  // scenario the (paymentRequestId, action) unique index and this
  // function's own idempotent-chokepoint design are for) must return that
  // same completed result rather than fail the NOTICE_SENT precondition,
  // which no longer holds precisely BECAUSE the first call already
  // succeeded.
  const [existingDispatched] = await db
    .select()
    .from(financialPaymentOutbox)
    .where(
      and(
        eq(financialPaymentOutbox.paymentRequestId, input.paymentRequestId),
        eq(financialPaymentOutbox.action, "SCHEDULE_DEBIT"),
        eq(financialPaymentOutbox.status, "DISPATCHED"),
      ),
    );
  if (existingDispatched) {
    return { paymentRequest: request, outboxEntry: existingDispatched, dispatched: true };
  }

  if (request.status !== "NOTICE_SENT") {
    throw new Error(`Payment request ${input.paymentRequestId} is ${request.status}, not NOTICE_SENT — call advancePaymentRequestToNoticeSent first.`);
  }
  if (!request.pcFeeAuthorityId) throw new Error(`Payment request ${input.paymentRequestId} has no pcFeeAuthorityId.`);

  const [authority] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, request.pcFeeAuthorityId));
  if (!authority) throw new Error(`PC fee authority ${request.pcFeeAuthorityId} not found.`);
  if (authority.status !== "ACTIVE") {
    throw new Error(`PC fee authority ${authority.id} is ${authority.status}, not ACTIVE — cannot schedule a debit against it.`);
  }
  // t180u(3) D8: no fallback. A stored-card authority is never debited through the mandate outbox.
  if (authority.authorisedPaymentMethod !== "GENERAL_ACCOUNT_DEBIT_MANDATE") {
    throw new Error(`PC fee authority ${authority.id} nominates ${authority.authorisedPaymentMethod}, not a direct-debit mandate — no fallback.`);
  }
  if (!authority.mandateProviderRef) {
    throw new Error(`PC fee authority ${authority.id} has no mandateProviderRef on file — cannot schedule a debit.`);
  }

  const noticeSentAt = request.noticeSentAt ?? new Date();
  const noticeElapsesAt = new Date(noticeSentAt.getTime() + authority.noticeRequiredDays * 24 * 60 * 60 * 1000);
  // t181u(A): the notice period is waived only when the signed agreement AND mandate terms both permit immediate collection.
  const immediate = collectionTimingFor(authority).rule === "IMMEDIATE_ON_STATEMENT_ISSUE";
  if (!immediate && new Date() < noticeElapsesAt) {
    throw new Error(
      `Payment request ${input.paymentRequestId}'s ${authority.noticeRequiredDays}-day notice period has not elapsed yet (elapses ${noticeElapsesAt.toISOString()}).`,
    );
  }

  const [existing] = await db
    .select()
    .from(financialPaymentOutbox)
    .where(and(eq(financialPaymentOutbox.paymentRequestId, input.paymentRequestId), eq(financialPaymentOutbox.action, "SCHEDULE_DEBIT")));

  let outboxEntry: FinancialPaymentOutbox;
  if (existing) {
    outboxEntry = existing;
  } else {
    const idempotencyKey = `schedule-debit:${input.paymentRequestId}`;
    const [inserted] = await db
      .insert(financialPaymentOutbox)
      .values({
        brokerageId: request.brokerageId,
        paymentRequestId: request.id,
        action: "SCHEDULE_DEBIT",
        status: "PENDING",
        idempotencyKey,
        correlationId: input.correlationId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      outboxEntry = inserted;
    } else {
      const [raceWinner] = await db
        .select()
        .from(financialPaymentOutbox)
        .where(and(eq(financialPaymentOutbox.paymentRequestId, input.paymentRequestId), eq(financialPaymentOutbox.action, "SCHEDULE_DEBIT")));
      if (!raceWinner) throw new Error("Failed to create or find a SCHEDULE_DEBIT outbox entry.");
      outboxEntry = raceWinner;
    }
  }

  if (outboxEntry.status === "DISPATCHED") {
    return { paymentRequest: request, outboxEntry, dispatched: true };
  }

  const outcome = await dispatchOutboxEntry(outboxEntry, { initiatedByUserId: input.initiatedByUserId ?? null });
  return {
    paymentRequest: outcome.paymentRequest ?? request,
    outboxEntry: outcome.outboxEntry,
    dispatched: outcome.outboxEntry.status === "DISPATCHED",
  };
}

export interface DispatchOutcome {
  outboxEntry: FinancialPaymentOutbox;
  paymentRequest: FinancialPaymentRequest | null;
}

const BASE_BACKOFF_MINUTES = 2;

/** Exponential backoff capped at 24 hours. attempts is post-increment (the attempt that just failed), so attempts=1 backs off 2 minutes, attempts=2 backs off 4, etc. */
function backoffMinutesFor(attempts: number): number {
  return Math.min(BASE_BACKOFF_MINUTES * 2 ** (attempts - 1), 24 * 60);
}

/**
 * Dispatches a single outbox entry: calls the provider, and on success
 * both marks the entry DISPATCHED and advances the payment request to
 * DEBIT_SCHEDULED. On failure, the entry's attempts/backoff are updated in
 * place (never a new row) and, once maxAttempts is exhausted, both the
 * outbox entry and the payment request are marked FAILED permanently — a
 * human has to intervene past that point (e.g. via reverseDebit's or a
 * future write-off path), not another automatic retry.
 */
export async function dispatchOutboxEntry(outboxEntry: FinancialPaymentOutbox, opts: { initiatedByUserId?: number | null } = {}): Promise<DispatchOutcome> {
  if (outboxEntry.status === "DISPATCHED") return { outboxEntry, paymentRequest: null };
  // t183u item 6: never send to anything but the sandbox mandate provider. The entry is left exactly
  // as it was (no attempt counted, nothing sent) so a misconfiguration can never burn its budget.
  if (!mandateProviderPermitted()) {
    logger.warn("financial_payment_outbox_provider_not_permitted", { outboxEntryId: outboxEntry.id, provider: mandatePaymentProvider.name });
    return { outboxEntry, paymentRequest: null };
  }
  if (outboxEntry.action !== "SCHEDULE_DEBIT") {
    throw new Error(`dispatchOutboxEntry does not yet handle action ${outboxEntry.action}.`);
  }

  try {
    const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, outboxEntry.paymentRequestId));
    if (!request) throw new Error(`Payment request ${outboxEntry.paymentRequestId} not found.`);

    const [authority] = request.pcFeeAuthorityId
      ? await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, request.pcFeeAuthorityId))
      : [undefined];
    if (!authority?.mandateProviderRef || authority.authorisedPaymentMethod !== "GENERAL_ACCOUNT_DEBIT_MANDATE") {
      throw new Error(`Payment request ${request.id} has no active mandate to debit.`);
    }

    // Owner t210u: once the provider is called, an error means the outcome is UNCERTAIN (the debit
    // may have been accepted). Never auto-resend: hold it for Brokerage Administrator review.
    let result: Awaited<ReturnType<typeof mandatePaymentProvider.scheduleDebit>>;
    try {
      result = await mandatePaymentProvider.scheduleDebit({
        mandateProviderRef: authority.mandateProviderRef,
        amountCents: request.amountCents,
        currency: "AUD",
        idempotencyKey: outboxEntry.idempotencyKey,
        description: `PC success fee — payment request #${request.id}`,
      });
    } catch (providerErr) {
      return await holdUncertainDispatch(outboxEntry, request, providerErr as Error, opts.initiatedByUserId ?? null);
    }

    const [dispatchedEntry] = await db
      .update(financialPaymentOutbox)
      .set({ status: "DISPATCHED", dispatchedAt: new Date(), updatedAt: new Date() })
      .where(eq(financialPaymentOutbox.id, outboxEntry.id))
      .returning();

    const [updatedRequest] = await db
      .update(financialPaymentRequests)
      .set({
        status: "DEBIT_SCHEDULED",
        provider: mandatePaymentProvider.name,
        providerRequestRef: result.providerRequestRef,
        providerStatus: result.status,
        scheduledAt: result.scheduledFor ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(financialPaymentRequests.id, request.id))
      .returning();

    await recordLedgerEvent({
      brokerageId: updatedRequest.brokerageId,
      propertyId: updatedRequest.propertyId,
      transactionId: updatedRequest.transactionId,
      eventType: "PC_FEE_DEBIT_SCHEDULED",
      amountCents: updatedRequest.amountCents,
      sourceRecordType: "PAYMENT_REQUEST",
      sourceRecordId: String(updatedRequest.id),
      actorType: "SYSTEM",
      correlationId: outboxEntry.correlationId,
    });

    await emitFinancialEvent({
      eventType: "FINANCIAL_PAYMENT_SCHEDULED",
      brokerageId: updatedRequest.brokerageId,
      propertyId: updatedRequest.propertyId,
      transactionId: updatedRequest.transactionId,
      actorType: "SYSTEM",
      source: "api:financial:dispatchOutboxEntry",
      correlationId: outboxEntry.correlationId,
      payload: { paymentRequestId: updatedRequest.id, amountCents: updatedRequest.amountCents, kind: updatedRequest.kind },
    });

    return { outboxEntry: dispatchedEntry, paymentRequest: updatedRequest };
  } catch (err) {
    const attempts = outboxEntry.attempts + 1;
    const exhausted = attempts >= outboxEntry.maxAttempts;
    const [updatedEntry] = await db
      .update(financialPaymentOutbox)
      .set({
        attempts,
        status: exhausted ? "FAILED" : "PENDING",
        nextAttemptAt: exhausted ? outboxEntry.nextAttemptAt : new Date(Date.now() + backoffMinutesFor(attempts) * 60 * 1000),
        lastError: (err as Error).message,
        updatedAt: new Date(),
      })
      .where(eq(financialPaymentOutbox.id, outboxEntry.id))
      .returning();

    let updatedRequest: FinancialPaymentRequest | null = null;
    if (exhausted) {
      // AE Step 2 closure — Part B: this outbox entry has exhausted its
      // retry budget (attempts >= maxAttempts) and just moved to terminal
      // FAILED above — the generalised, cross-domain version of what
      // lib/integrations/outbox.ts's own dead-letter path already tracks
      // as integration_dead_letter_total. See docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
      incrementCounter("job_repeated_failure_total", { job: "financial_payment_outbox_command" });
      const [failedRequest] = await db
        .select()
        .from(financialPaymentRequests)
        .where(eq(financialPaymentRequests.id, outboxEntry.paymentRequestId));

      if (failedRequest) {
        const [saved] = await db
          .update(financialPaymentRequests)
          .set({ status: "FAILED", failedAt: new Date(), failureReason: (err as Error).message, updatedAt: new Date() })
          .where(eq(financialPaymentRequests.id, failedRequest.id))
          .returning();
        updatedRequest = saved;

        await recordLedgerEvent({
          brokerageId: saved.brokerageId,
          propertyId: saved.propertyId,
          transactionId: saved.transactionId,
          eventType: "PC_FEE_PAYMENT_FAILED",
          amountCents: saved.amountCents,
          sourceRecordType: "PAYMENT_REQUEST",
          sourceRecordId: String(saved.id),
          actorType: "SYSTEM",
          reason: `Outbox dispatch exhausted after ${attempts} attempts: ${(err as Error).message}`,
          correlationId: outboxEntry.correlationId,
        });

        await emitFinancialEvent({
          eventType: "FINANCIAL_PAYMENT_FAILED",
          brokerageId: saved.brokerageId,
          propertyId: saved.propertyId,
          transactionId: saved.transactionId,
          actorType: "SYSTEM",
          source: "api:financial:dispatchOutboxEntry",
          correlationId: outboxEntry.correlationId,
          payload: { paymentRequestId: saved.id, amountCents: saved.amountCents, reason: saved.failureReason },
        });
      }
    }

    // Owner t180u(2): exhausted dispatch -> failure receipt (idempotent).
    if (updatedRequest) await syncReceiptsForPaymentRequest(updatedRequest.id);
    return { outboxEntry: updatedEntry, paymentRequest: updatedRequest };
  }
}

/** Marker on a held outbox entry's lastError (no new status or column: Owner t210u, no schema change). */
export const HELD_UNCERTAIN_PREFIX = "HELD_UNCERTAIN: ";

/**
 * Owner t210u: the provider call errored, so the debit may or may not exist. Stop and flag for a
 * human. The outbox entry leaves PENDING (FAILED + HELD_UNCERTAIN marker, so no sweep resends it);
 * the fee goes to PROCESSING (outcome unknown, the same never-auto-retried state as an UNKNOWN card
 * charge); a ledger event and an audit row record the hold; Brokerage Administrators see it at
 * GET /financial/payment-outbox/held. Nothing here calls the provider again.
 */
async function holdUncertainDispatch(outboxEntry: FinancialPaymentOutbox, request: FinancialPaymentRequest, err: Error, raisedByUserId: number | null): Promise<DispatchOutcome> {
  const message = err.message || "provider error";
  const { heldEntry, heldRequest } = await db.transaction(async (tx) => {
    const [heldEntry] = await tx
      .update(financialPaymentOutbox)
      .set({ status: "FAILED", attempts: outboxEntry.attempts + 1, lastError: `${HELD_UNCERTAIN_PREFIX}${message}`, updatedAt: new Date() })
      .where(and(eq(financialPaymentOutbox.id, outboxEntry.id), eq(financialPaymentOutbox.status, "PENDING")))
      .returning();
    const [heldRequest] = await tx
      .update(financialPaymentRequests)
      .set({ status: "PROCESSING", processingStartedAt: new Date(), nextAttemptAt: null, provider: mandatePaymentProvider.name, updatedAt: new Date() })
      .where(eq(financialPaymentRequests.id, request.id))
      .returning();
    await tx.insert(auditLogs).values({
      brokerageId: request.brokerageId,
      userId: raisedByUserId,
      action: "financial_payment_debit_dispatch_held",
      recordType: "financial_payment_request",
      recordId: String(request.id),
      propertyId: request.propertyId,
      updatedValue: JSON.stringify({ outboxEntryId: outboxEntry.id, attempt: outboxEntry.attempts + 1, outcome: "UNCERTAIN", autoResend: false, raisedByUserId, needs: "BROKERAGE_ADMIN_REVIEW", error: message }),
    });
    return { heldEntry: heldEntry ?? outboxEntry, heldRequest: heldRequest ?? request };
  });
  // The hold is committed above (audit row included). What follows is best effort: an error here
  // must NEVER fall through to the caller's retry path and re-arm a resend.
  try {
    await recordLedgerEvent({
      brokerageId: heldRequest.brokerageId,
      propertyId: heldRequest.propertyId,
      transactionId: heldRequest.transactionId,
      eventType: "PC_FEE_PAYMENT_PROCESSING",
      amountCents: heldRequest.amountCents,
      sourceRecordType: "PAYMENT_REQUEST",
      sourceRecordId: String(heldRequest.id),
      actorType: "SYSTEM",
      reason: `Debit scheduling outcome uncertain (${message}); held for manual review by a Brokerage Administrator, not resent.`,
      correlationId: outboxEntry.correlationId,
    });
    incrementCounter("job_repeated_failure_total", { job: "financial_payment_outbox_command" });
  } catch (sideEffectErr) {
    logger.error("financial_payment_debit_dispatch_held_side_effect_failed", { outboxEntryId: outboxEntry.id, error: (sideEffectErr as Error).message });
  }
  return { outboxEntry: heldEntry, paymentRequest: heldRequest };
}

/** Held (uncertain) debit dispatches for one brokerage, newest first. Brokerage Administrator view. */
export async function listHeldDebitDispatches(brokerageId: number) {
  const rows = await db
    .select()
    .from(financialPaymentOutbox)
    .where(and(eq(financialPaymentOutbox.brokerageId, brokerageId), eq(financialPaymentOutbox.status, "FAILED"), like(financialPaymentOutbox.lastError, `${HELD_UNCERTAIN_PREFIX}%`)))
    .orderBy(desc(financialPaymentOutbox.updatedAt));
  return rows.map((r) => ({
    outboxEntryId: r.id,
    paymentRequestId: r.paymentRequestId,
    action: r.action,
    attempts: r.attempts,
    heldAt: r.updatedAt,
    reason: (r.lastError ?? "").slice(HELD_UNCERTAIN_PREFIX.length),
  }));
}

export interface DispatchSweepResult {
  attempted: number;
  dispatched: number;
  stillPending: number;
  failed: number;
}

/**
 * The actual durability mechanism: call this from a recurring job (Stage F
 * wires the schedule — lib/financial/bootstrap.ts's registerFinancialEngine;
 * this module only provides the sweep itself) to retry every outbox entry
 * whose backoff window has elapsed. Processes entries one at a time and
 * never lets one entry's error stop the sweep.
 */
export async function dispatchPendingPaymentOutbox(limit = 20): Promise<DispatchSweepResult> {
  const due = await db
    .select()
    .from(financialPaymentOutbox)
    .where(and(eq(financialPaymentOutbox.status, "PENDING"), lte(financialPaymentOutbox.nextAttemptAt, new Date())))
    .limit(limit);

  const result: DispatchSweepResult = { attempted: due.length, dispatched: 0, stillPending: 0, failed: 0 };
  for (const entry of due) {
    const outcome = await dispatchOutboxEntry(entry);
    if (outcome.outboxEntry.status === "DISPATCHED") result.dispatched += 1;
    else if (outcome.outboxEntry.status === "FAILED") result.failed += 1;
    else result.stillPending += 1;
  }
  return result;
}

/**
 * Cancels a debit that has been scheduled with the provider but has not
 * yet started processing — the pre-clearing counterpart to reverseDebit
 * below. WAIVED is the closest fit in PAYMENT_REQUEST_STATUSES for "the
 * brokerage chose not to collect this fee after all", which is the only
 * realistic reason to cancel a debit before it fires.
 */
export async function cancelScheduledDebit(input: {
  paymentRequestId: number;
  reason: string;
  actorUserId?: number | null;
}): Promise<FinancialPaymentRequest> {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, input.paymentRequestId));
  if (!request) throw new Error(`Payment request ${input.paymentRequestId} not found.`);
  if (request.status !== "DEBIT_SCHEDULED") {
    throw new Error(`Payment request ${input.paymentRequestId} is ${request.status}, not DEBIT_SCHEDULED — nothing to cancel.`);
  }
  if (!request.providerRequestRef) throw new Error(`Payment request ${input.paymentRequestId} has no providerRequestRef to cancel.`);

  if (!mandateProviderPermitted()) throw new Error("Mandate provider not permitted: only the sandbox provider may cancel debits.");
  await mandatePaymentProvider.cancelScheduledDebit(request.providerRequestRef);

  const [updated] = await db
    .update(financialPaymentRequests)
    .set({ status: "WAIVED", waivedAt: new Date(), waivedByUserId: input.actorUserId ?? null, waiveReason: input.reason, updatedAt: new Date() })
    .where(eq(financialPaymentRequests.id, input.paymentRequestId))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    eventType: "PC_FEE_WAIVED",
    amountCents: updated.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(updated.id),
    actorType: "USER",
    actorUserId: input.actorUserId ?? null,
    reason: input.reason,
  });

  return updated;
}

/**
 * Admin-initiated reversal (mirrors lib/payments.ts's refundPayment) for a
 * debit that has already cleared (PAID) and needs unwinding — as opposed
 * to cancelScheduledDebit above, which only works before the debit fires.
 * A provider-reported reversal (the debit bounced, or was clawed back by
 * the payer's bank) arrives instead via lib/financial/paymentWebhooks.ts's
 * webhook handler, not through this function.
 */
export async function reverseDebit(input: { paymentRequestId: number; reason: string; actorUserId?: number | null }): Promise<FinancialPaymentRequest> {
  const [request] = await db.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, input.paymentRequestId));
  if (!request) throw new Error(`Payment request ${input.paymentRequestId} not found.`);
  if (request.status !== "PAID") {
    throw new Error(`Payment request ${input.paymentRequestId} is ${request.status}, not PAID — nothing to reverse.`);
  }
  if (!request.providerRequestRef) throw new Error(`Payment request ${input.paymentRequestId} has no providerRequestRef to reverse.`);
  // t180u(3): a stored-card fee is never reversed through the mandate provider (no cross-method action).
  // Card refunds are a separate, not-yet-wired Brokerage Administrator flow (fail closed).
  if (request.pcFeeAuthorityId != null) {
    const [auth] = await db.select({ method: pcFeeAuthorities.authorisedPaymentMethod }).from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, request.pcFeeAuthorityId));
    if (auth?.method === "STORED_CARD") throw new Error(`Payment request ${input.paymentRequestId} was paid by stored card; card refunds are not available through the mandate reversal path.`);
  }

  if (!mandateProviderPermitted()) throw new Error("Mandate provider not permitted: only the sandbox provider may reverse debits.");
  await mandatePaymentProvider.reverseDebit(request.providerRequestRef, request.amountCents, input.reason);

  const [updated] = await db
    .update(financialPaymentRequests)
    .set({ status: "REVERSED", reversedAt: new Date(), reversalReason: input.reason, updatedAt: new Date() })
    .where(eq(financialPaymentRequests.id, input.paymentRequestId))
    .returning();

  await recordLedgerEvent({
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    eventType: "PC_FEE_PAYMENT_REVERSED",
    amountCents: updated.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(updated.id),
    actorType: "USER",
    actorUserId: input.actorUserId ?? null,
    reason: input.reason,
  });

  await emitFinancialEvent({
    eventType: "FINANCIAL_PAYMENT_REVERSED",
    brokerageId: updated.brokerageId,
    propertyId: updated.propertyId,
    transactionId: updated.transactionId,
    actorType: "USER",
    actorId: input.actorUserId ?? null,
    source: "api:financial:reverseDebit",
    payload: { paymentRequestId: updated.id, amountCents: updated.amountCents, reason: input.reason },
  });

  // Owner t180u(2): refund (reversal) receipt (idempotent).
  await syncReceiptsForPaymentRequest(updated.id);
  return updated;
}

// ---------------------------------------------------------------------------
// #245 S5: Brokerage Administrator resolution of a HELD_UNCERTAIN debit
// dispatch (Owner t210u). Read-only provider check, then mark SCHEDULED or
// FAILED. Never sends, never resends.
// ---------------------------------------------------------------------------

export type HeldDebitProviderStatus = "Found" | "NotFound" | "Unavailable";

export class HeldDebitRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What the provider itself holds for this send. Only the sandbox answers; anything else is Unavailable. */
export async function heldDebitProviderStatus(entry: FinancialPaymentOutbox): Promise<{ status: HeldDebitProviderStatus; providerRequestRef?: string; providerStatus?: string }> {
  if (!mandateProviderPermitted() || typeof mandatePaymentProvider.lookupDebit !== "function") return { status: "Unavailable" };
  try {
    const rec = await mandatePaymentProvider.lookupDebit(entry.idempotencyKey);
    return rec ? { status: "Found", providerRequestRef: rec.providerRequestRef, providerStatus: rec.status } : { status: "NotFound" };
  } catch {
    return { status: "Unavailable" };
  }
}

const isHeld = (e: FinancialPaymentOutbox) => e.status === "FAILED" && (e.lastError ?? "").startsWith(HELD_UNCERTAIN_PREFIX);

export async function resolveHeldDebit(input: { brokerageId: number; actorUserId: number; outboxEntryId: number; outcome: "SCHEDULED" | "FAILED"; reason: string }) {
  if (!Number.isSafeInteger(input.outboxEntryId) || input.outboxEntryId <= 0) throw new HeldDebitRefusal(404, "NOT_FOUND", "Not found.");
  const [entry] = await db
    .select()
    .from(financialPaymentOutbox)
    .where(and(eq(financialPaymentOutbox.id, input.outboxEntryId), eq(financialPaymentOutbox.brokerageId, input.brokerageId)));
  if (!entry) throw new HeldDebitRefusal(404, "NOT_FOUND", "Not found.");
  if (!isHeld(entry)) throw new HeldDebitRefusal(409, "HELD_DEBIT_NOT_HELD", "This debit dispatch is not held for review.");

  // The person whose action raised the hold may not resolve it (recorded on the hold's audit row).
  const [hold] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "financial_payment_debit_dispatch_held"), eq(auditLogs.recordType, "financial_payment_request"), eq(auditLogs.recordId, String(entry.paymentRequestId))))
    .orderBy(desc(auditLogs.id))
    .limit(1);
  const raisedBy = hold?.userId ?? null;
  if (raisedBy != null && raisedBy === input.actorUserId) {
    throw new HeldDebitRefusal(403, "HELD_DEBIT_RESOLVER_IS_RAISER", "The user who raised this held debit cannot resolve it.");
  }

  const provider = await heldDebitProviderStatus(entry);
  if (provider.status === "Unavailable") throw new HeldDebitRefusal(409, "HELD_DEBIT_PROVIDER_STATUS_UNAVAILABLE", "The provider's record could not be read; nothing changed.");
  if ((input.outcome === "SCHEDULED") !== (provider.status === "Found")) {
    throw new HeldDebitRefusal(409, "HELD_DEBIT_OUTCOME_MISMATCH", `The provider record (${provider.status}) does not support ${input.outcome}.`);
  }

  const now = new Date();
  const { request } = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.id, entry.id)).for("update");
    if (!locked || !isHeld(locked)) throw new HeldDebitRefusal(409, "HELD_DEBIT_NOT_HELD", "This debit dispatch is not held for review.");
    const [req] = await tx.select().from(financialPaymentRequests).where(eq(financialPaymentRequests.id, entry.paymentRequestId)).for("update");
    if (!req || req.status !== "PROCESSING") throw new HeldDebitRefusal(409, "HELD_DEBIT_NOT_HELD", "The fee is no longer awaiting this resolution.");
    let updated: FinancialPaymentRequest;
    if (input.outcome === "SCHEDULED") {
      await tx.update(financialPaymentOutbox).set({ status: "DISPATCHED", dispatchedAt: now, updatedAt: now }).where(eq(financialPaymentOutbox.id, entry.id));
      [updated] = await tx
        .update(financialPaymentRequests)
        .set({ status: "DEBIT_SCHEDULED", provider: mandatePaymentProvider.name, providerRequestRef: provider.providerRequestRef!, providerStatus: provider.providerStatus ?? null, scheduledAt: now, updatedAt: now })
        .where(eq(financialPaymentRequests.id, req.id))
        .returning();
    } else {
      await tx
        .update(financialPaymentOutbox)
        .set({ lastError: `RESOLVED_FAILED: ${(locked.lastError ?? "").slice(HELD_UNCERTAIN_PREFIX.length)}`, updatedAt: now })
        .where(eq(financialPaymentOutbox.id, entry.id));
      [updated] = await tx
        .update(financialPaymentRequests)
        .set({ status: "FAILED", failedAt: now, failureReason: "Debit was not scheduled (held dispatch resolved by a Brokerage Administrator).", updatedAt: now })
        .where(eq(financialPaymentRequests.id, req.id))
        .returning();
    }
    await tx.insert(auditLogs).values({
      brokerageId: req.brokerageId,
      userId: input.actorUserId,
      action: "financial_payment_held_debit_resolved",
      recordType: "financial_payment_request",
      recordId: String(req.id),
      propertyId: req.propertyId,
      updatedValue: JSON.stringify({ outboxEntryId: entry.id, outcome: input.outcome, providerStatus: provider.status, reason: input.reason, raisedByUserId: raisedBy }),
    });
    return { request: updated! };
  });

  await recordLedgerEvent({
    brokerageId: request.brokerageId,
    propertyId: request.propertyId,
    transactionId: request.transactionId,
    eventType: input.outcome === "SCHEDULED" ? "PC_FEE_DEBIT_SCHEDULED" : "PC_FEE_PAYMENT_FAILED",
    amountCents: request.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(request.id),
    actorType: "USER",
    actorUserId: input.actorUserId,
    reason: `Held debit resolved ${input.outcome} by a Brokerage Administrator (provider: ${provider.status}): ${input.reason}`,
    correlationId: entry.correlationId,
  });
  if (input.outcome === "FAILED") await syncReceiptsForPaymentRequest(request.id);
  return { paymentRequest: request, providerStatus: provider.status };
}
