// Owner t177u(1) (CC #37): assigned Pit Crew may INITIATE collection of the
// AE Pit Crew service fee (the Financial Engine's PC_SUCCESS_FEE) once
// settlement is verified complete. Collection runs only through the
// existing, Brokerage-Administrator-activated PC fee authority and AE's
// payment processor (lib/financial/paymentOutbox.ts), never through a saved
// card and never for any other charge. Every prerequisite is re-verified
// server-side from existing rows on every call, and the call fails closed on
// any mismatch:
//   1. settlement complete: transactions.status Settled/Closed AND settlement_completed_at set
//      (only a Brokerage Administrator can record that);
//   2. fee from the agreed terms: computePcFee(authority, commission calculation)
//      must equal the stored FINALISED, undisputed fee calculation and the
//      payment request amount; the cap (maximum_amount_cents) must hold;
//   3. a valid authority covering the charge: ACTIVE, unrevoked, unexpired,
//      in effect, with a provider mandate, belonging to the property's
//      listing agent (the payer);
//   4. duplicate protection: one PC_SUCCESS_FEE request per transaction
//      (unique index), one SCHEDULE_DEBIT outbox row per request (unique
//      index); an already scheduled or paid request is a no-op; failed,
//      disputed, reversed, waived or written-off requests are refused, because
//      recovery stays with Brokerage Administrators.
// Pit Crew must also hold an active assignment on the transaction. The
// notice period (pc_fee_authorities.notice_required_days) is honoured: the
// first call starts it, and a call after it elapses schedules the debit.
// Brokerage Administrators may use the same gated path. No schema change.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  commissionCalculations,
  financialPaymentRequests,
  pcFeeAuthorities,
  pcFeeCalculations,
  pitCrewAssignments,
  properties,
  riskExceptions,
  transactions,
  type FinancialPaymentRequest,
} from "@aee/db";
import { computePcFee } from "./financial/pcFeeCalculations.js";
import { advancePaymentRequestToNoticeSent, scheduleDebitForPaymentRequest } from "./financial/paymentOutbox.js";
import { checkSettlementStatementGate, type SettlementStatementGateResult, type StatementPayer } from "./settlementStatementGate.js";

export const ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES = ["CLAIMED", "IN_PROGRESS", "WAITING_ON"] as const;

export type ServiceFeeCollectionCode =
  | "SERVICE_FEE_NOT_FOUND"
  | "SERVICE_FEE_COLLECTION_FORBIDDEN"
  | "PIT_CREW_NOT_ASSIGNED"
  | "SETTLEMENT_NOT_VERIFIED"
  | "SERVICE_FEE_NOT_VERIFIED"
  | "SERVICE_FEE_AUTHORITY_INVALID"
  | "SERVICE_FEE_NOT_COLLECTABLE"
  | "SERVICE_FEE_NOTICE_PERIOD_RUNNING"
  | "SETTLEMENT_STATEMENT_NOT_ISSUED"
  | "SETTLEMENT_STATEMENT_PAYER_MISMATCH"
  | "SETTLEMENT_STATEMENT_FEE_MISMATCH"
  | "SETTLEMENT_CONFIRMATIONS_INCOMPLETE"
  | "SETTLEMENT_STATEMENT_STALE";

export const SERVICE_FEE_ERROR_STATUS: Record<ServiceFeeCollectionCode, number> = {
  SERVICE_FEE_NOT_FOUND: 404,
  SERVICE_FEE_COLLECTION_FORBIDDEN: 403,
  PIT_CREW_NOT_ASSIGNED: 403,
  SETTLEMENT_NOT_VERIFIED: 409,
  SERVICE_FEE_NOT_VERIFIED: 409,
  SERVICE_FEE_AUTHORITY_INVALID: 409,
  SERVICE_FEE_NOT_COLLECTABLE: 409,
  SERVICE_FEE_NOTICE_PERIOD_RUNNING: 409,
  SETTLEMENT_STATEMENT_NOT_ISSUED: 409,
  SETTLEMENT_STATEMENT_PAYER_MISMATCH: 409,
  SETTLEMENT_STATEMENT_FEE_MISMATCH: 409,
  SETTLEMENT_CONFIRMATIONS_INCOMPLETE: 409,
  SETTLEMENT_STATEMENT_STALE: 409,
};

export class ServiceFeeCollectionError extends Error {
  constructor(
    public readonly code: ServiceFeeCollectionCode,
    detail?: string,
    /** Audit context, set only once the transaction is known to be in the caller's brokerage. */
    public readonly propertyId?: number,
  ) {
    super(detail ?? code);
    this.name = "ServiceFeeCollectionError";
  }
}

export type ServiceFeeCollectionOutcome = "notice_started" | "debit_scheduled" | "debit_queued" | "already_in_progress" | "already_paid";

export interface ServiceFeeCaller {
  id: number;
  role: string;
  brokerageId: number;
}

export interface VerifiedServiceFee {
  paymentRequest: FinancialPaymentRequest;
  propertyId: number;
  transactionId: number;
  grossFeeCents: number;
  gstCents: number;
  totalFeeCents: number;
  capCents: number | null;
  noticeElapsesAt: Date | null;
  pitCrewAssignmentIds: number[];
  /** The authorised payer (today always the authority's agent; brokerage payer needs S2). */
  payer: StatementPayer;
}

const IN_PROGRESS = new Set(["DEBIT_SCHEDULED", "PROCESSING", "RETRY_SCHEDULED"]);
const PAID = new Set(["PAID", "RECONCILED"]);
const RECOVERY_ONLY = new Set(["FAILED", "DISPUTED", "REVERSED", "WAIVED", "WRITTEN_OFF"]);
const STARTABLE = new Set(["CALCULATED", "READY_TO_INVOICE", "INVOICED"]);

export async function activePitCrewAssignmentIdsOnTransaction(caller: ServiceFeeCaller, propertyId: number, transactionId: number): Promise<number[]> {
  const rows = await db
    .select({ id: pitCrewAssignments.id })
    .from(pitCrewAssignments)
    .innerJoin(
      riskExceptions,
      and(
        eq(pitCrewAssignments.sourceType, "EXCEPTION"),
        sql`${pitCrewAssignments.sourceRecordId} = ${riskExceptions.id}::text`,
        eq(riskExceptions.brokerageId, pitCrewAssignments.brokerageId),
        eq(riskExceptions.propertyId, pitCrewAssignments.propertyId),
      ),
    )
    .where(
      and(
        eq(pitCrewAssignments.brokerageId, caller.brokerageId),
        eq(pitCrewAssignments.assignedToUserId, caller.id),
        eq(pitCrewAssignments.propertyId, propertyId),
        inArray(pitCrewAssignments.status, [...ACTIVE_PIT_CREW_ASSIGNMENT_STATUSES]),
        eq(riskExceptions.transactionId, transactionId),
      ),
    )
    .orderBy(pitCrewAssignments.id);
  return rows.map((r) => r.id);
}

/** Every gate except the request-status/notice step. Throws ServiceFeeCollectionError. */
export interface ServiceFeeCollectionOptions {
  /**
   * t180u(1) D2: set ONLY by the statement-issue path (never from a request
   * body). The issuer was already authorised as a D1 actor (assigned Pit
   * Crew, listing agent or Brokerage Administrator) inside the issue
   * transaction, so the role/assignment check is not repeated; every other
   * gate is.
   */
  trigger?: "statement_issued";
}

export async function verifyServiceFeeCollection(caller: ServiceFeeCaller, transactionId: number, now = new Date(), opts: ServiceFeeCollectionOptions = {}): Promise<VerifiedServiceFee> {
  const autoOnIssue = opts.trigger === "statement_issued";
  if (!autoOnIssue && caller.role !== "Pit Crew" && caller.role !== "Brokerage Administrator") {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_FOUND");
  }
  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_FOUND");

  const [row] = await db
    .select({ transaction: transactions, agentId: properties.agentId })
    .from(transactions)
    .innerJoin(properties, eq(properties.id, transactions.propertyId))
    .where(and(eq(transactions.id, transactionId), eq(properties.brokerageId, caller.brokerageId)));
  if (!row) throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_FOUND");
  const { transaction, agentId } = row;
  const propertyId = transaction.propertyId;

  let pitCrewAssignmentIds: number[] = [];
  if (!autoOnIssue && caller.role === "Pit Crew") {
    pitCrewAssignmentIds = await activePitCrewAssignmentIdsOnTransaction(caller, propertyId, transaction.id);
    if (pitCrewAssignmentIds.length === 0) throw new ServiceFeeCollectionError("PIT_CREW_NOT_ASSIGNED", undefined, propertyId);
  }

  if (!(transaction.status === "Settled" || transaction.status === "Closed") || transaction.settlementCompletedAt == null) {
    throw new ServiceFeeCollectionError("SETTLEMENT_NOT_VERIFIED", undefined, propertyId);
  }

  const [paymentRequest] = await db
    .select()
    .from(financialPaymentRequests)
    .where(
      and(
        eq(financialPaymentRequests.transactionId, transaction.id),
        eq(financialPaymentRequests.kind, "PC_SUCCESS_FEE"),
        eq(financialPaymentRequests.brokerageId, caller.brokerageId),
      ),
    );
  if (!paymentRequest) throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", "No service-fee request for this transaction.", propertyId);

  // Authority covering the charge.
  if (paymentRequest.pcFeeAuthorityId == null) throw new ServiceFeeCollectionError("SERVICE_FEE_AUTHORITY_INVALID", undefined, propertyId);
  const [authority] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, paymentRequest.pcFeeAuthorityId));
  const authorityValid =
    authority != null &&
    authority.brokerageId === caller.brokerageId &&
    authority.status === "ACTIVE" &&
    authority.revokedAt == null &&
    (authority.expiresAt == null || authority.expiresAt > now) &&
    (authority.effectiveDate == null || authority.effectiveDate <= now) &&
    !!authority.mandateProviderRef &&
    authority.agentUserId === agentId &&
    (paymentRequest.payerUserId == null || paymentRequest.payerUserId === authority.agentUserId);
  if (!authorityValid || !authority) throw new ServiceFeeCollectionError("SERVICE_FEE_AUTHORITY_INVALID", undefined, propertyId);

  // Fee from the agreed terms.
  if (paymentRequest.pcFeeCalculationId == null) throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", undefined, propertyId);
  const [feeCalc] = await db.select().from(pcFeeCalculations).where(eq(pcFeeCalculations.id, paymentRequest.pcFeeCalculationId));
  if (
    !feeCalc ||
    feeCalc.transactionId !== transaction.id ||
    feeCalc.pcFeeAuthorityId !== authority.id ||
    feeCalc.state !== "FINALISED" ||
    feeCalc.isDisputed ||
    feeCalc.commissionCalculationId == null
  ) {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", undefined, propertyId);
  }
  const [commissionCalc] = await db.select().from(commissionCalculations).where(eq(commissionCalculations.id, feeCalc.commissionCalculationId));
  if (!commissionCalc || commissionCalc.transactionId !== transaction.id || commissionCalc.state !== "FINALISED") {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", undefined, propertyId);
  }
  let recomputed: ReturnType<typeof computePcFee>;
  try {
    recomputed = computePcFee(authority, commissionCalc);
  } catch {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", undefined, propertyId);
  }
  const capOk = authority.maximumAmountCents == null || feeCalc.grossFeeCents <= authority.maximumAmountCents;
  if (
    !capOk ||
    recomputed.grossFeeCents !== feeCalc.grossFeeCents ||
    recomputed.gstCents !== feeCalc.gstCents ||
    recomputed.totalFeeCents !== feeCalc.totalFeeCents ||
    paymentRequest.amountCents !== feeCalc.totalFeeCents ||
    paymentRequest.currency !== "AUD" ||
    feeCalc.totalFeeCents <= 0
  ) {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_VERIFIED", undefined, propertyId);
  }

  const noticeElapsesAt = paymentRequest.noticeSentAt
    ? new Date(paymentRequest.noticeSentAt.getTime() + authority.noticeRequiredDays * 24 * 60 * 60 * 1000)
    : null;

  return {
    paymentRequest,
    propertyId,
    transactionId: transaction.id,
    grossFeeCents: feeCalc.grossFeeCents,
    gstCents: feeCalc.gstCents,
    totalFeeCents: feeCalc.totalFeeCents,
    capCents: authority.maximumAmountCents ?? null,
    noticeElapsesAt,
    pitCrewAssignmentIds,
    payer: { payerType: "Agent", userId: authority.agentUserId },
  };
}

/** Owner t178u(1): statement-first. Value-free result; never throws. */
export async function settlementStatementGateFor(verified: VerifiedServiceFee, brokerageId: number): Promise<SettlementStatementGateResult> {
  return checkSettlementStatementGate({
    brokerageId,
    transactionId: verified.transactionId,
    payer: verified.payer,
    paymentRequestId: verified.paymentRequest.id,
    amountCents: verified.paymentRequest.amountCents,
    currency: verified.paymentRequest.currency,
  });
}

export interface ServiceFeeCollectionResult {
  outcome: ServiceFeeCollectionOutcome;
  verified: VerifiedServiceFee;
  paymentRequest: FinancialPaymentRequest;
  settlementStatementId: number;
}

/** Verify every gate, then advance the existing workflow by exactly one step. */
export async function collectPitCrewServiceFee(caller: ServiceFeeCaller, transactionId: number, opts: ServiceFeeCollectionOptions = {}): Promise<ServiceFeeCollectionResult> {
  const now = new Date();
  const verified = await verifyServiceFeeCollection(caller, transactionId, now, opts);
  const request = verified.paymentRequest;

  // Owner t178u(1): no collection step of any kind (notice, debit, or an
  // idempotent status reply) before an ISSUED, itemised settlement statement
  // addressed to the authorised payer. Checked before any outbox/provider call.
  const gate = await settlementStatementGateFor(verified, caller.brokerageId);
  if (!gate.ok) throw new ServiceFeeCollectionError(gate.code, undefined, verified.propertyId);
  const settlementStatementId = gate.statementId;

  if (PAID.has(request.status)) return { outcome: "already_paid", verified, paymentRequest: request, settlementStatementId };
  if (IN_PROGRESS.has(request.status)) return { outcome: "already_in_progress", verified, paymentRequest: request, settlementStatementId };
  if (RECOVERY_ONLY.has(request.status)) {
    throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_COLLECTABLE", `Request is ${request.status}; recovery is a Brokerage Administrator action.`, verified.propertyId);
  }
  if (STARTABLE.has(request.status)) {
    const updated = await advancePaymentRequestToNoticeSent(request.id);
    return { outcome: "notice_started", verified, paymentRequest: updated, settlementStatementId };
  }
  if (request.status === "NOTICE_SENT") {
    if (verified.noticeElapsesAt == null || now < verified.noticeElapsesAt) {
      throw new ServiceFeeCollectionError("SERVICE_FEE_NOTICE_PERIOD_RUNNING", undefined, verified.propertyId);
    }
    const result = await scheduleDebitForPaymentRequest({ paymentRequestId: request.id });
    return { outcome: result.dispatched ? "debit_scheduled" : "debit_queued", verified, paymentRequest: result.paymentRequest, settlementStatementId };
  }
  throw new ServiceFeeCollectionError("SERVICE_FEE_NOT_COLLECTABLE", `Request is ${request.status}.`, verified.propertyId);
}

export type AutoCollectionResult =
  | { attempted: true; outcome: ServiceFeeCollectionOutcome; paymentRequestId: number; statusAfter: string }
  | { attempted: true; code: ServiceFeeCollectionCode | "SERVICE_FEE_COLLECTION_FAILED" }
  | { attempted: false; reason: "NO_SERVICE_FEE_LINE" };

/**
 * Owner t180u(1) / D2: issuing the final statement starts collection of the
 * Pit Crew service fee automatically, through exactly the same gated
 * workflow as the manual call (statement gate, settlement, confirmations,
 * finalised fee, valid authority, notice period, single debit). Never throws:
 * a refusal is recorded and the issued statement stands. Idempotent: an
 * already started, scheduled or paid fee is a no-op (a corrected statement
 * never re-collects a paid fee).
 */
export async function autoCollectOnStatementIssue(input: {
  brokerageId: number;
  transactionId: number;
  statementId: number;
  issuerUserId: number;
  issuerRole: string;
  hasServiceFeeLine: boolean;
}): Promise<AutoCollectionResult> {
  const { logAudit } = await import("./audit.js");
  if (!input.hasServiceFeeLine) return { attempted: false, reason: "NO_SERVICE_FEE_LINE" };
  const caller: ServiceFeeCaller = { id: input.issuerUserId, role: input.issuerRole, brokerageId: input.brokerageId };
  let result: AutoCollectionResult;
  let propertyId: number | null = null;
  let extra: Record<string, unknown> = {};
  try {
    const r = await collectPitCrewServiceFee(caller, input.transactionId, { trigger: "statement_issued" });
    propertyId = r.verified.propertyId;
    result = { attempted: true, outcome: r.outcome, paymentRequestId: r.paymentRequest.id, statusAfter: r.paymentRequest.status };
    extra = { paymentRequestId: r.paymentRequest.id, statusBefore: r.verified.paymentRequest.status, statusAfter: r.paymentRequest.status, totalFeeCents: r.verified.totalFeeCents, settlementStatementId: r.settlementStatementId };
  } catch (err) {
    if (err instanceof ServiceFeeCollectionError) {
      propertyId = err.propertyId ?? null;
      result = { attempted: true, code: err.code };
    } else {
      result = { attempted: true, code: "SERVICE_FEE_COLLECTION_FAILED" };
    }
  }
  await logAudit({
    brokerageId: input.brokerageId,
    userId: input.issuerUserId,
    action: "outcome" in result ? "pit_crew_service_fee_auto_collection" : "pit_crew_service_fee_auto_collection_refused",
    recordType: "transaction",
    recordId: String(input.transactionId),
    propertyId,
    updatedValue: JSON.stringify({
      trigger: "statement_issued",
      statementId: input.statementId,
      issuerRole: input.issuerRole,
      ...("outcome" in result ? { outcome: result.outcome } : "code" in result ? { code: result.code } : {}),
      ...extra,
      policy: "t180u",
    }),
  });
  return result;
}
