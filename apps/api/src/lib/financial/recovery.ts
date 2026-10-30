// Owner t181u (t178-plan slice 7): controlled recovery of the AE Pit Crew
// service fee. Brokerage Administrator only (the routes enforce the role; this
// module enforces tenancy, the state machine and the evidence rules):
//   * waive        – a fee the brokerage chooses not to collect, before any
//                    money has moved;
//   * write-off    – a fee whose collection was attempted and failed
//                    (RETRY_SCHEDULED or FAILED);
//   * resolve-dispute – PAYABLE / WAIVED / WRITTEN_OFF for a DISPUTED request;
//   * resolve an UNKNOWN stored-card charge (gap G2) to SUCCEEDED or FAILED.
// Every action needs a non-blank reason AND evidence (a document on the
// transaction's property, or a non-blank written note). Each transition runs
// under a row lock on the payment request, writes a ledger event (which the
// receipt history reads) and a value-free audit row in the same DB
// transaction, then runs the idempotent receipt sync (0042 hook). A replay of
// an action already applied is a 200 no-op (idempotent: true) with no second
// event. Nothing here ever calls a payment provider, so nothing is retried
// automatically: after an UNKNOWN charge is resolved FAILED a retry still
// needs an explicit, fully re-gated collect (N23). Paid money is never
// waived or written off here (a refund/reversal comes first). No schema change.
import { nextCardRetryAt } from "./retryBackoff.js";
import { lookupCardChargeProviderStatus, outcomeForProviderStatus, type CardChargeProviderStatus } from "./cardChargeStatus.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  db,
  documents,
  financialCardCharges,
  financialDisputes,
  financialLedgerEvents,
  financialPaymentOutbox,
  financialPaymentRequests,
  pcFeeCalculations,
  settlementStatements,
  type FinancialCardCharge,
  type FinancialPaymentRequest,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { emitFinancialEvent } from "./events.js";
import { syncReceiptsForPaymentRequest } from "./receipts.js";

export const RECOVERY_POLICY = "t181u";

export type RecoveryAction = "waive" | "write_off" | "resolve_dispute" | "resolve_card_charge" | "refund_card_charge" | "resolve_card_refund";
export type DisputeOutcome = "PAYABLE" | "WAIVED" | "WRITTEN_OFF";
export type CardChargeResolution = "SUCCEEDED" | "FAILED";

export type RecoveryCode =
  | "RECOVERY_NOT_FOUND"
  | "RECOVERY_REASON_REQUIRED"
  | "RECOVERY_EVIDENCE_REQUIRED"
  | "RECOVERY_EVIDENCE_INVALID"
  | "RECOVERY_REFERENCE_INVALID"
  | "RECOVERY_INVALID_TRANSITION"
  | "RECOVERY_USE_DISPUTE_RESOLUTION"
  | "RECOVERY_USE_CANCEL_DEBIT"
  | "RECOVERY_PAYMENT_IN_FLIGHT"
  | "RECOVERY_PAID_REFUND_REQUIRED"
  | "RECOVERY_NOT_DISPUTED"
  | "RECOVERY_PROVIDER_STATE_UNRESOLVED"
  | "CARD_CHARGE_NOT_UNKNOWN"
  | "CARD_CHARGE_ALREADY_FINAL"
  | "CARD_CHARGE_RESOLVER_IS_INITIATOR"
  | "CARD_CHARGE_OUTCOME_MISMATCH"
  | "CARD_CHARGE_PROVIDER_STATUS_UNAVAILABLE"
  | "CARD_REFUND_PROVIDER_NOT_PERMITTED"
  | "CARD_REFUND_CHARGE_NOT_REFUNDABLE"
  | "CARD_REFUND_EXCEEDS_REFUNDABLE"
  | "CARD_REFUND_REFUNDER_IS_INITIATOR"
  | "CARD_REFUND_KEY_REUSED"
  | "CARD_REFUND_NOT_UNKNOWN"
  | "CARD_REFUND_STATE_CHANGED"
  | "CARD_REFUND_ALREADY_FINAL"
  | "CARD_REFUND_RESOLVER_IS_REQUESTER"
  | "CARD_REFUND_OUTCOME_MISMATCH"
  | "CARD_REFUND_PROVIDER_STATUS_UNAVAILABLE";

const STATUS_FOR: Record<RecoveryCode, number> = {
  RECOVERY_NOT_FOUND: 404,
  RECOVERY_REASON_REQUIRED: 422,
  RECOVERY_EVIDENCE_REQUIRED: 422,
  RECOVERY_EVIDENCE_INVALID: 422,
  RECOVERY_REFERENCE_INVALID: 422,
  RECOVERY_INVALID_TRANSITION: 409,
  RECOVERY_USE_DISPUTE_RESOLUTION: 409,
  RECOVERY_USE_CANCEL_DEBIT: 409,
  RECOVERY_PAYMENT_IN_FLIGHT: 409,
  RECOVERY_PAID_REFUND_REQUIRED: 409,
  RECOVERY_NOT_DISPUTED: 409,
  RECOVERY_PROVIDER_STATE_UNRESOLVED: 409,
  CARD_CHARGE_NOT_UNKNOWN: 409,
  CARD_CHARGE_ALREADY_FINAL: 409,
  CARD_CHARGE_RESOLVER_IS_INITIATOR: 403,
  CARD_CHARGE_OUTCOME_MISMATCH: 409,
  CARD_CHARGE_PROVIDER_STATUS_UNAVAILABLE: 409,
  CARD_REFUND_PROVIDER_NOT_PERMITTED: 409,
  CARD_REFUND_CHARGE_NOT_REFUNDABLE: 409,
  CARD_REFUND_EXCEEDS_REFUNDABLE: 409,
  CARD_REFUND_REFUNDER_IS_INITIATOR: 403,
  CARD_REFUND_KEY_REUSED: 409,
  CARD_REFUND_NOT_UNKNOWN: 409,
  CARD_REFUND_STATE_CHANGED: 409,
  CARD_REFUND_ALREADY_FINAL: 409,
  CARD_REFUND_RESOLVER_IS_REQUESTER: 403,
  CARD_REFUND_OUTCOME_MISMATCH: 409,
  CARD_REFUND_PROVIDER_STATUS_UNAVAILABLE: 409,
};

export class RecoveryRefusal extends Error {
  readonly status: number;
  constructor(
    public readonly code: RecoveryCode,
    message: string,
    public readonly paymentRequestId: number | null = null,
    public readonly propertyId: number | null = null,
  ) {
    super(message);
    this.name = "RecoveryRefusal";
    this.status = STATUS_FOR[code];
  }
}

export interface RecoveryActor {
  id: number;
  role: string;
  brokerageId: number;
}

export interface RecoveryInput {
  reason?: string | null;
  evidenceDocumentId?: number | null;
  evidenceNote?: string | null;
}

export type Evidence = { kind: "document"; documentId: number; note?: string } | { kind: "note"; note: string };

export interface RecoveryResult {
  idempotent: boolean;
  paymentRequest: FinancialPaymentRequest;
  cardCharge?: FinancialCardCharge;
  statusBefore: string;
}

/** Waivable: nothing collected and nothing in flight. */
const WAIVABLE = new Set(["NOT_CALCULATED", "ESTIMATED", "CALCULATED", "AWAITING_AUTHORITY", "READY_TO_INVOICE", "INVOICED", "NOTICE_SENT", "RETRY_SCHEDULED", "FAILED"]);
/** Write-off: collection was attempted and failed. */
const WRITE_OFFABLE = new Set(["RETRY_SCHEDULED", "FAILED"]);
const PAID = new Set(["PAID", "RECONCILED"]);
const OPEN_DISPUTE = ["OPEN", "UNDER_REVIEW"];
const DISPUTE_STATUS_FOR: Record<DisputeOutcome, string> = { PAYABLE: "RESOLVED_PAYABLE", WAIVED: "RESOLVED_WAIVED", WRITTEN_OFF: "CLOSED" };
const MANUAL_FAILURE = "Resolved as failed by a Brokerage Administrator";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function cleanReason(input: RecoveryInput, prId: number | null, propertyId: number | null): string {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) throw new RecoveryRefusal("RECOVERY_REASON_REQUIRED", "A reason is required.", prId, propertyId);
  return reason.slice(0, 2000);
}

export async function evidenceFor(q: Tx, input: RecoveryInput, pr: FinancialPaymentRequest): Promise<Evidence> {
  const note = (input.evidenceNote ?? "").trim().slice(0, 2000);
  if (input.evidenceDocumentId != null) {
    const [doc] = await q.select({ id: documents.id }).from(documents).where(and(eq(documents.id, input.evidenceDocumentId), eq(documents.propertyId, pr.propertyId)));
    if (!doc) throw new RecoveryRefusal("RECOVERY_EVIDENCE_INVALID", "The evidence document must be on this transaction's property.", pr.id, pr.propertyId);
    return note ? { kind: "document", documentId: doc.id, note } : { kind: "document", documentId: doc.id };
  }
  if (note) return { kind: "note", note };
  throw new RecoveryRefusal("RECOVERY_EVIDENCE_REQUIRED", "Attach a document or describe the evidence.", pr.id, pr.propertyId);
}

export async function lockRequest(tx: Tx, actor: RecoveryActor, paymentRequestId: number): Promise<FinancialPaymentRequest> {
  if (!Number.isSafeInteger(paymentRequestId) || paymentRequestId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [pr] = await tx
    .select()
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.id, paymentRequestId), eq(financialPaymentRequests.brokerageId, actor.brokerageId)))
    .for("update");
  // Cross-brokerage reads as 404 (never reveals existence).
  if (!pr || pr.kind !== "PC_SUCCESS_FEE") throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  return pr;
}

/** Anything a provider may still act on: a PENDING/UNKNOWN card charge or an undelivered/delivered scheduled debit. */
async function inFlight(tx: Tx, pr: FinancialPaymentRequest): Promise<"card" | "debit" | null> {
  const open = await tx
    .select({ id: financialCardCharges.id })
    .from(financialCardCharges)
    .where(and(eq(financialCardCharges.paymentRequestId, pr.id), inArray(financialCardCharges.status, ["PENDING", "UNKNOWN"])));
  if (open.length > 0) return "card";
  const debits = await tx
    .select({ id: financialPaymentOutbox.id })
    .from(financialPaymentOutbox)
    .where(and(eq(financialPaymentOutbox.paymentRequestId, pr.id), eq(financialPaymentOutbox.action, "SCHEDULE_DEBIT"), inArray(financialPaymentOutbox.status, ["PENDING", "DISPATCHED"])));
  return debits.length > 0 ? "debit" : null;
}

export async function ledgerTx(
  tx: Tx,
  pr: FinancialPaymentRequest,
  eventType: string,
  actor: RecoveryActor,
  reason: string,
  metadata: Record<string, unknown>,
  occurredAt?: Date,
): Promise<number> {
  const [row] = await tx.insert(financialLedgerEvents).values({
    brokerageId: pr.brokerageId,
    propertyId: pr.propertyId,
    transactionId: pr.transactionId,
    eventType,
    amountCents: pr.amountCents,
    sourceRecordType: "PAYMENT_REQUEST",
    sourceRecordId: String(pr.id),
    actorType: "USER",
    actorUserId: actor.id,
    reason,
    metadata: { ...metadata, policy: RECOVERY_POLICY },
    ...(occurredAt ? { occurredAt } : {}),
  }).returning({ id: financialLedgerEvents.id });
  return row!.id;
}

// ---------------------------------------------------------------------------------------------------
// Owner t183u items 1-2: formal PC fee adjustment records (waivers and write-offs).
// One authorised Brokerage Administrator approves AND executes the adjustment in a single step; there
// is no second-admin approval. The formal record IS the PC_FEE_WAIVED / PC_FEE_WRITTEN_OFF ledger event
// (append-only: no code path updates or deletes ledger events): its `adjustment` metadata carries the
// amount, GST treatment, the settlement statement it adjusts, the reason and the approval details, and
// the record number is derived from the event id. It is not a payment receipt: it is never written to
// financial_receipts, never takes a receipt kind or number, and is read from its own endpoint.
// No schema change.
// ---------------------------------------------------------------------------------------------------
export type AdjustmentKind = "WAIVER" | "WRITE_OFF";
export type AdjustmentVia = "WAIVE" | "WRITE_OFF" | "DISPUTE_RESOLUTION";
export const ADJUSTMENT_EVENT_FOR: Record<AdjustmentKind, string> = { WAIVER: "PC_FEE_WAIVED", WRITE_OFF: "PC_FEE_WRITTEN_OFF" };
const KIND_FOR_EVENT: Record<string, AdjustmentKind> = { PC_FEE_WAIVED: "WAIVER", PC_FEE_WRITTEN_OFF: "WRITE_OFF" };

export function adjustmentRecordNumber(kind: AdjustmentKind, ledgerEventId: number): string {
  return `ADJ-${kind === "WAIVER" ? "W" : "WO"}-${String(ledgerEventId).padStart(8, "0")}`;
}

/** Writes the adjustment's ledger event (the formal record) and returns its record number. */
async function recordAdjustmentTx(
  tx: Tx,
  pr: FinancialPaymentRequest,
  kind: AdjustmentKind,
  via: AdjustmentVia,
  actor: RecoveryActor,
  reason: string,
  evidence: Evidence,
  extra: Record<string, unknown>,
): Promise<string> {
  const [calc] = pr.pcFeeCalculationId
    ? await tx.select({ gstCents: pcFeeCalculations.gstCents }).from(pcFeeCalculations).where(eq(pcFeeCalculations.id, pr.pcFeeCalculationId))
    : [];
  // The statement being adjusted: the transaction's currently ISSUED statement (null if none was issued yet).
  const [statement] = await tx
    .select({ id: settlementStatements.id, version: settlementStatements.version })
    .from(settlementStatements)
    .where(and(eq(settlementStatements.transactionId, pr.transactionId), eq(settlementStatements.brokerageId, pr.brokerageId), eq(settlementStatements.status, "ISSUED")));
  const gstCents = Math.max(0, Math.min(calc?.gstCents ?? 0, pr.amountCents));
  const approvedAt = new Date();
  const adjustment = {
    documentType: "PC_FEE_ADJUSTMENT",
    isReceipt: false,
    kind,
    via,
    amountCents: pr.amountCents,
    gstCents,
    amountExGstCents: pr.amountCents - gstCents,
    gstTreatment: gstCents > 0 ? "GST_INCLUSIVE" : "NO_GST",
    currency: pr.currency ?? "AUD",
    settlementStatementId: statement?.id ?? null,
    settlementStatementVersion: statement?.version ?? null,
    approvalMode: "SINGLE_BROKERAGE_ADMIN",
    approvedByUserId: actor.id,
    approvedByRole: actor.role,
    approvedAt: approvedAt.toISOString(),
    executedByUserId: actor.id,
  };
  const id = await ledgerTx(tx, pr, ADJUSTMENT_EVENT_FOR[kind], actor, reason, { ...extra, evidence, adjustment }, approvedAt);
  return adjustmentRecordNumber(kind, id);
}

export interface AdjustmentRecord {
  recordNumber: string;
  documentType: "PC_FEE_ADJUSTMENT";
  isReceipt: false;
  kind: AdjustmentKind;
  via: AdjustmentVia;
  ledgerEventId: number;
  paymentRequestId: number;
  transactionId: number;
  settlementStatementId: number | null;
  settlementStatementVersion: number | null;
  amountCents: number;
  gstCents: number;
  amountExGstCents: number;
  gstTreatment: string;
  currency: string;
  reason: string;
  approval: { mode: string; approvedByUserId: number; approvedByRole: string; approvedAt: string; executedByUserId: number };
  evidence: { kind: string; documentId: number | null };
}

/** Brokerage Administrator read: the formal adjustment records for one payment request (oldest first). */
export async function listAdjustmentRecords(actor: RecoveryActor, paymentRequestId: number): Promise<AdjustmentRecord[]> {
  if (!Number.isSafeInteger(paymentRequestId) || paymentRequestId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [pr] = await db
    .select()
    .from(financialPaymentRequests)
    .where(and(eq(financialPaymentRequests.id, paymentRequestId), eq(financialPaymentRequests.brokerageId, actor.brokerageId)));
  if (!pr) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const rows = await db
    .select()
    .from(financialLedgerEvents)
    .where(
      and(
        eq(financialLedgerEvents.brokerageId, pr.brokerageId),
        eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"),
        eq(financialLedgerEvents.sourceRecordId, String(pr.id)),
        inArray(financialLedgerEvents.eventType, Object.values(ADJUSTMENT_EVENT_FOR)),
      ),
    )
    .orderBy(financialLedgerEvents.id);
  return rows.flatMap((e) => {
    const meta = (e.metadata ?? {}) as { adjustment?: Record<string, unknown>; evidence?: { kind?: string; documentId?: number } };
    const a = meta.adjustment;
    const kind = KIND_FOR_EVENT[e.eventType];
    if (!a || !kind) return []; // events recorded before formal records existed carry no adjustment metadata
    return [
      {
        recordNumber: adjustmentRecordNumber(kind, e.id),
        documentType: "PC_FEE_ADJUSTMENT" as const,
        isReceipt: false as const,
        kind,
        via: a.via as AdjustmentVia,
        ledgerEventId: e.id,
        paymentRequestId: pr.id,
        transactionId: pr.transactionId,
        settlementStatementId: (a.settlementStatementId as number | null) ?? null,
        settlementStatementVersion: (a.settlementStatementVersion as number | null) ?? null,
        amountCents: a.amountCents as number,
        gstCents: a.gstCents as number,
        amountExGstCents: a.amountExGstCents as number,
        gstTreatment: a.gstTreatment as string,
        currency: a.currency as string,
        reason: e.reason ?? "",
        approval: {
          mode: a.approvalMode as string,
          approvedByUserId: a.approvedByUserId as number,
          approvedByRole: a.approvedByRole as string,
          approvedAt: a.approvedAt as string,
          executedByUserId: a.executedByUserId as number,
        },
        evidence: { kind: meta.evidence?.kind ?? "unknown", documentId: meta.evidence?.kind === "document" ? (meta.evidence.documentId ?? null) : null },
      },
    ];
  });
}

/** Value-free: ids, statuses, evidence kind/document id only. Never amounts, reason or note text. */
export function auditValue(fields: Record<string, unknown>, evidence?: Evidence): string {
  return JSON.stringify({
    ...fields,
    ...(evidence ? { evidenceKind: evidence.kind, evidenceDocumentId: evidence.kind === "document" ? evidence.documentId : null, reasonProvided: true } : {}),
    policy: RECOVERY_POLICY,
  });
}

export async function auditTx(tx: Tx, actor: RecoveryActor, action: string, pr: FinancialPaymentRequest, value: string) {
  await tx.insert(auditLogs).values({
    brokerageId: actor.brokerageId,
    userId: actor.id,
    action,
    recordType: "financial_payment_request",
    recordId: String(pr.id),
    propertyId: pr.propertyId,
    updatedValue: value,
  });
}

/** Refusals and replays: value-free, best effort, after the transaction. */
export async function auditRecoveryOutcome(actor: RecoveryActor, action: RecoveryAction, outcome: { refused: RecoveryRefusal } | { replayed: RecoveryResult }, targetId: number) {
  const isRefusal = "refused" in outcome;
  const prId = isRefusal ? outcome.refused.paymentRequestId : outcome.replayed.paymentRequest.id;
  await logAudit({
    brokerageId: actor.brokerageId,
    userId: actor.id,
    action: isRefusal ? "financial_pc_fee_recovery_refused" : "financial_pc_fee_recovery_replayed",
    recordType: "financial_payment_request",
    recordId: String(prId ?? targetId),
    propertyId: isRefusal ? outcome.refused.propertyId : outcome.replayed.paymentRequest.propertyId,
    updatedValue: JSON.stringify(
      isRefusal
        ? { outcome: "refused", recoveryAction: action, callerRole: actor.role, code: outcome.refused.code, targetId, policy: RECOVERY_POLICY }
        : { outcome: "idempotent_replay", recoveryAction: action, callerRole: actor.role, status: outcome.replayed.paymentRequest.status, targetId, policy: RECOVERY_POLICY },
    ),
  });
}

/** Shared refusal order for waive / write-off on a locked request. */
async function assertRecoverable(tx: Tx, pr: FinancialPaymentRequest, allowed: Set<string>) {
  if (pr.status === "DISPUTED") throw new RecoveryRefusal("RECOVERY_USE_DISPUTE_RESOLUTION", "A disputed fee is resolved through dispute resolution.", pr.id, pr.propertyId);
  if (pr.status === "DEBIT_SCHEDULED") throw new RecoveryRefusal("RECOVERY_USE_CANCEL_DEBIT", "A scheduled debit is cancelled with the provider first.", pr.id, pr.propertyId);
  if (pr.status === "PROCESSING" || (await inFlight(tx, pr))) {
    throw new RecoveryRefusal("RECOVERY_PAYMENT_IN_FLIGHT", "A payment is in flight or unresolved; resolve it first.", pr.id, pr.propertyId);
  }
  if (PAID.has(pr.status) || (pr.paidAt && !pr.reversedAt)) throw new RecoveryRefusal("RECOVERY_PAID_REFUND_REQUIRED", "Paid money is refunded or reversed first.", pr.id, pr.propertyId);
  if (!allowed.has(pr.status)) throw new RecoveryRefusal("RECOVERY_INVALID_TRANSITION", `A ${pr.status} fee cannot be changed this way.`, pr.id, pr.propertyId);
}

async function finish(result: RecoveryResult): Promise<RecoveryResult> {
  if (!result.idempotent) await syncReceiptsForPaymentRequest(result.paymentRequest.id);
  return result;
}

export async function waivePaymentRequest(actor: RecoveryActor, paymentRequestId: number, input: RecoveryInput): Promise<RecoveryResult> {
  const result = await db.transaction(async (tx) => {
    const pr = await lockRequest(tx, actor, paymentRequestId);
    if (pr.status === "WAIVED") return { idempotent: true, paymentRequest: pr, statusBefore: pr.status };
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    await assertRecoverable(tx, pr, WAIVABLE);
    const [updated] = await tx
      .update(financialPaymentRequests)
      .set({ status: "WAIVED", waivedAt: new Date(), waivedByUserId: actor.id, waiveReason: reason, updatedAt: new Date() })
      .where(eq(financialPaymentRequests.id, pr.id))
      .returning();
    const recordNumber = await recordAdjustmentTx(tx, pr, "WAIVER", "WAIVE", actor, reason, evidence, { recoveryAction: "waive", statusBefore: pr.status });
    await auditTx(tx, actor, "financial_pc_fee_waived", pr, auditValue({ paymentRequestId: pr.id, statusBefore: pr.status, statusAfter: "WAIVED", adjustmentRecordNumber: recordNumber }, evidence));
    return { idempotent: false, paymentRequest: updated!, statusBefore: pr.status };
  });
  return finish(result);
}

export async function writeOffPaymentRequest(actor: RecoveryActor, paymentRequestId: number, input: RecoveryInput): Promise<RecoveryResult> {
  const result = await db.transaction(async (tx) => {
    const pr = await lockRequest(tx, actor, paymentRequestId);
    if (pr.status === "WRITTEN_OFF") return { idempotent: true, paymentRequest: pr, statusBefore: pr.status };
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    await assertRecoverable(tx, pr, WRITE_OFFABLE);
    const [updated] = await tx
      .update(financialPaymentRequests)
      .set({ status: "WRITTEN_OFF", writtenOffAt: new Date(), writtenOffByUserId: actor.id, writeOffReason: reason, updatedAt: new Date() })
      .where(eq(financialPaymentRequests.id, pr.id))
      .returning();
    const recordNumber = await recordAdjustmentTx(tx, pr, "WRITE_OFF", "WRITE_OFF", actor, reason, evidence, { recoveryAction: "write_off", statusBefore: pr.status });
    await auditTx(tx, actor, "financial_pc_fee_written_off", pr, auditValue({ paymentRequestId: pr.id, statusBefore: pr.status, statusAfter: "WRITTEN_OFF", adjustmentRecordNumber: recordNumber }, evidence));
    return { idempotent: false, paymentRequest: updated!, statusBefore: pr.status };
  });
  return finish(result);
}

export async function resolvePaymentRequestDispute(actor: RecoveryActor, paymentRequestId: number, outcome: DisputeOutcome, input: RecoveryInput): Promise<RecoveryResult> {
  const result = await db.transaction(async (tx) => {
    const pr = await lockRequest(tx, actor, paymentRequestId);
    if (pr.status !== "DISPUTED") {
      // Idempotent only when THIS resolution was the last one applied and the request still reflects it.
      const [last] = await tx
        .select()
        .from(financialLedgerEvents)
        .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(pr.id)), eq(financialLedgerEvents.eventType, "PC_FEE_DISPUTE_RESOLVED")))
        .orderBy(desc(financialLedgerEvents.id))
        .limit(1);
      const meta = (last?.metadata ?? {}) as { outcome?: string; statusAfter?: string };
      if (last && meta.outcome === outcome && meta.statusAfter === pr.status) return { idempotent: true, paymentRequest: pr, statusBefore: pr.status };
      throw new RecoveryRefusal("RECOVERY_NOT_DISPUTED", "This fee is not disputed.", pr.id, pr.propertyId);
    }
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    const paid = pr.paidAt != null && pr.reversedAt == null;
    let statusAfter: string;
    const set: Partial<typeof financialPaymentRequests.$inferInsert> = { updatedAt: new Date() };
    if (outcome === "PAYABLE") {
      if (paid) statusAfter = pr.reconciledAt ? "RECONCILED" : "PAID";
      else {
        if (await inFlight(tx, pr)) throw new RecoveryRefusal("RECOVERY_PROVIDER_STATE_UNRESOLVED", "A provider debit or card charge is still open for this fee; resolve it first.", pr.id, pr.propertyId);
        // Re-enters collection from the start; every collection gate (issued statement, notice) applies again.
        statusAfter = pr.pcFeeCalculationId ? "CALCULATED" : "NOT_CALCULATED";
      }
    } else {
      if (paid) throw new RecoveryRefusal("RECOVERY_PAID_REFUND_REQUIRED", "Paid money is refunded or reversed before the fee is waived or written off.", pr.id, pr.propertyId);
      if (await inFlight(tx, pr)) throw new RecoveryRefusal("RECOVERY_PAYMENT_IN_FLIGHT", "A payment is in flight or unresolved; resolve it first.", pr.id, pr.propertyId);
      statusAfter = outcome;
      if (outcome === "WAIVED") Object.assign(set, { waivedAt: new Date(), waivedByUserId: actor.id, waiveReason: reason });
      else Object.assign(set, { writtenOffAt: new Date(), writtenOffByUserId: actor.id, writeOffReason: reason });
    }
    const [updated] = await tx
      .update(financialPaymentRequests)
      .set({ ...set, status: statusAfter })
      .where(eq(financialPaymentRequests.id, pr.id))
      .returning();
    const resolvedDisputes = await tx
      .update(financialDisputes)
      .set({ status: DISPUTE_STATUS_FOR[outcome], resolution: reason, resolvedByUserId: actor.id, resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(financialDisputes.paymentRequestId, pr.id), eq(financialDisputes.brokerageId, pr.brokerageId), inArray(financialDisputes.status, OPEN_DISPUTE)))
      .returning({ id: financialDisputes.id });
    const disputeIds = resolvedDisputes.map((d) => d.id);
    await ledgerTx(tx, pr, "PC_FEE_DISPUTE_RESOLVED", actor, reason, { recoveryAction: "resolve_dispute", outcome, statusBefore: pr.status, statusAfter, disputeIds, evidence });
    const recordNumber =
      outcome === "PAYABLE"
        ? null
        : await recordAdjustmentTx(tx, pr, outcome === "WAIVED" ? "WAIVER" : "WRITE_OFF", "DISPUTE_RESOLUTION", actor, reason, evidence, { recoveryAction: "resolve_dispute", disputeIds });
    await auditTx(
      tx,
      actor,
      "financial_pc_fee_dispute_resolved",
      pr,
      auditValue({ paymentRequestId: pr.id, outcome, statusBefore: pr.status, statusAfter, disputeIds, ...(recordNumber ? { adjustmentRecordNumber: recordNumber } : {}) }, evidence),
    );
    return { idempotent: false, paymentRequest: updated!, statusBefore: pr.status };
  });
  return finish(result);
}

/** A provider reference typed by a BA: short, no whitespace, never a card-number-like digit run. */
export function validProviderChargeRef(ref: string): boolean {
  return /^[A-Za-z0-9_.:-]{3,120}$/.test(ref) && !/\d{12,}/.test(ref);
}

export async function resolveUnknownCardCharge(
  actor: RecoveryActor,
  chargeId: number,
  outcome: CardChargeResolution,
  input: RecoveryInput & { providerChargeRef?: string | null },
): Promise<RecoveryResult> {
  if (!Number.isSafeInteger(chargeId) || chargeId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [peek] = await db
    .select({ paymentRequestId: financialCardCharges.paymentRequestId, initiatedByUserId: financialCardCharges.initiatedByUserId, idempotencyKey: financialCardCharges.idempotencyKey, status: financialCardCharges.status })
    .from(financialCardCharges)
    .where(and(eq(financialCardCharges.id, chargeId), eq(financialCardCharges.brokerageId, actor.brokerageId)));
  if (!peek) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  // t181u(D) separation of duties: whoever initiated the charge never resolves it (system charges have no initiator).
  if (peek.initiatedByUserId != null && peek.initiatedByUserId === actor.id) {
    throw new RecoveryRefusal("CARD_CHARGE_RESOLVER_IS_INITIATOR", "The person who started this charge cannot resolve it; another Brokerage Administrator must.", peek.paymentRequestId);
  }
  // t181u(D): ask the provider (mock only; read-only, outside any lock). Unavailable fails closed below.
  const providerStatus: CardChargeProviderStatus = peek.status === "UNKNOWN" ? lookupCardChargeProviderStatus(peek.idempotencyKey) : "Unavailable";

  const result = await db.transaction(async (tx) => {
    // Same lock order as the charge path: payment request first, then the charge.
    const pr = await lockRequest(tx, actor, peek.paymentRequestId);
    const [charge] = await tx.select().from(financialCardCharges).where(eq(financialCardCharges.id, chargeId)).for("update");
    if (!charge || charge.brokerageId !== actor.brokerageId) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
    if (charge.status === "SUCCEEDED" || charge.status === "FAILED") {
      const resolved = await tx
        .select({ metadata: financialLedgerEvents.metadata })
        .from(financialLedgerEvents)
        .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(pr.id)), eq(financialLedgerEvents.eventType, "PC_FEE_CARD_CHARGE_RESOLVED")));
      const byUs = resolved.find((e) => (e.metadata as { chargeId?: number } | null)?.chargeId === charge.id);
      if (!byUs) throw new RecoveryRefusal("CARD_CHARGE_NOT_UNKNOWN", "Only a charge with an UNKNOWN outcome is resolved here.", pr.id, pr.propertyId);
      if (charge.status === outcome) return { idempotent: true, paymentRequest: pr, cardCharge: charge, statusBefore: pr.status };
      throw new RecoveryRefusal("CARD_CHARGE_ALREADY_FINAL", "This charge has already been resolved.", pr.id, pr.propertyId);
    }
    if (charge.status !== "UNKNOWN") throw new RecoveryRefusal("CARD_CHARGE_NOT_UNKNOWN", "Only a charge with an UNKNOWN outcome is resolved here.", pr.id, pr.propertyId);
    const reason = cleanReason(input, pr.id, pr.propertyId);
    const evidence = await evidenceFor(tx, input, pr);
    const ref = input.providerChargeRef?.trim() || null;
    if (ref && !validProviderChargeRef(ref)) throw new RecoveryRefusal("RECOVERY_REFERENCE_INVALID", "The provider reference must be the charge reference (no card numbers or spaces).", pr.id, pr.propertyId);
    // An UNKNOWN charge always leaves its request PROCESSING (N24); anything else is an inconsistent state.
    if (pr.status !== "PROCESSING") throw new RecoveryRefusal("RECOVERY_INVALID_TRANSITION", `Request is ${pr.status}, not PROCESSING.`, pr.id, pr.propertyId);
    const expected = outcomeForProviderStatus(providerStatus);
    if (expected == null) throw new RecoveryRefusal("CARD_CHARGE_PROVIDER_STATUS_UNAVAILABLE", "The payment provider cannot confirm this charge's status; it stays unresolved.", pr.id, pr.propertyId);
    if (expected !== outcome) throw new RecoveryRefusal("CARD_CHARGE_OUTCOME_MISMATCH", `The payment provider reports this charge as ${providerStatus}; the resolution must match it.`, pr.id, pr.propertyId);

    let updatedCharge: FinancialCardCharge;
    let updated: FinancialPaymentRequest;
    if (outcome === "SUCCEEDED") {
      // The one-SUCCEEDED partial unique index still backs this up.
      [updatedCharge] = (await tx
        .update(financialCardCharges)
        .set({ status: "SUCCEEDED", providerChargeRef: ref ?? charge.providerChargeRef, completedAt: new Date() })
        .where(and(eq(financialCardCharges.id, charge.id), eq(financialCardCharges.status, "UNKNOWN")))
        .returning()) as [FinancialCardCharge];
      [updated] = (await tx
        .update(financialPaymentRequests)
        .set({ status: "PAID", paidAt: new Date(), providerRequestRef: ref ?? pr.providerRequestRef, providerStatus: "Succeeded", failureReason: null, updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, pr.id))
        .returning()) as [FinancialPaymentRequest];
      await ledgerTx(tx, pr, "PC_FEE_PAID", actor, `stored card, attempt ${charge.attemptNo} (confirmed by a Brokerage Administrator)`, { chargeId: charge.id });
    } else {
      [updatedCharge] = (await tx
        .update(financialCardCharges)
        .set({ status: "FAILED", providerChargeRef: ref ?? charge.providerChargeRef, failureMessage: MANUAL_FAILURE, completedAt: new Date() })
        .where(and(eq(financialCardCharges.id, charge.id), eq(financialCardCharges.status, "UNKNOWN")))
        .returning()) as [FinancialCardCharge];
      const retryCount = pr.retryCount + 1;
      const willRetry = retryCount < pr.maxRetries;
      [updated] = (await tx
        .update(financialPaymentRequests)
        .set({ status: willRetry ? "RETRY_SCHEDULED" : "FAILED", retryCount, nextAttemptAt: willRetry ? nextCardRetryAt(new Date(), retryCount) : null, failedAt: willRetry ? null : new Date(), failureReason: MANUAL_FAILURE, providerStatus: "Failed", updatedAt: new Date() })
        .where(eq(financialPaymentRequests.id, pr.id))
        .returning()) as [FinancialPaymentRequest];
      await ledgerTx(tx, pr, "PC_FEE_PAYMENT_FAILED", actor, `${MANUAL_FAILURE} (stored card, attempt ${retryCount}/${pr.maxRetries}${willRetry ? ", next attempt after backoff" : ", exhausted"})`, { chargeId: charge.id });
    }
    await ledgerTx(tx, pr, "PC_FEE_CARD_CHARGE_RESOLVED", actor, reason, { recoveryAction: "resolve_card_charge", chargeId: charge.id, attemptNo: charge.attemptNo, outcome, providerStatus, initiatedBy: charge.initiatedByUserId == null ? "SYSTEM" : "USER", statusAfter: updated.status, evidence });
    await auditTx(
      tx,
      actor,
      "financial_card_charge_resolved",
      pr,
      auditValue({ paymentRequestId: pr.id, chargeId: charge.id, attemptNo: charge.attemptNo, outcome, providerStatus, statusBefore: pr.status, statusAfter: updated.status, providerReferenceRecorded: ref != null }, evidence),
    );
    return { idempotent: false, paymentRequest: updated, cardCharge: updatedCharge, statusBefore: pr.status };
  });
  if (!result.idempotent) {
    const pr = result.paymentRequest;
    await emitFinancialEvent({
      eventType: pr.status === "PAID" ? "FINANCIAL_PAYMENT_PAID" : "FINANCIAL_PAYMENT_FAILED",
      brokerageId: pr.brokerageId,
      propertyId: pr.propertyId,
      transactionId: pr.transactionId,
      actorType: "USER",
      source: "api:financial:recovery",
      payload: { paymentRequestId: pr.id, method: "STORED_CARD", resolvedBy: "BROKERAGE_ADMINISTRATOR" },
    });
  }
  return finish(result);
}

/** t181u(D): BA-only provider status of one card charge of the caller's brokerage (no key or token returned). */
export async function cardChargeProviderStatusFor(actor: RecoveryActor, chargeId: number) {
  if (!Number.isSafeInteger(chargeId) || chargeId <= 0) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const [row] = await db
    .select({ id: financialCardCharges.id, status: financialCardCharges.status, idempotencyKey: financialCardCharges.idempotencyKey, initiatedByUserId: financialCardCharges.initiatedByUserId })
    .from(financialCardCharges)
    .where(and(eq(financialCardCharges.id, chargeId), eq(financialCardCharges.brokerageId, actor.brokerageId)));
  if (!row) throw new RecoveryRefusal("RECOVERY_NOT_FOUND", "Not found.");
  const providerStatus = row.status === "UNKNOWN" ? lookupCardChargeProviderStatus(row.idempotencyKey) : null;
  return {
    chargeId: row.id,
    chargeStatus: row.status,
    providerStatus,
    suggestedOutcome: providerStatus ? outcomeForProviderStatus(providerStatus) : null,
    callerMayResolve: row.initiatedByUserId == null || row.initiatedByUserId !== actor.id,
  };
}

/** BA work queue: card charges of the caller's brokerage (no token or payment-method references). */
export async function listCardChargesForBrokerage(brokerageId: number, status?: string) {
  const rows = await db
    .select({
      id: financialCardCharges.id,
      paymentRequestId: financialCardCharges.paymentRequestId,
      attemptNo: financialCardCharges.attemptNo,
      status: financialCardCharges.status,
      amountCents: financialCardCharges.amountCents,
      currency: financialCardCharges.currency,
      payerType: financialCardCharges.payerType,
      provider: financialCardCharges.provider,
      providerChargeRef: financialCardCharges.providerChargeRef,
      failureMessage: financialCardCharges.failureMessage,
      trigger: financialCardCharges.trigger,
      createdAt: financialCardCharges.createdAt,
      completedAt: financialCardCharges.completedAt,
    })
    .from(financialCardCharges)
    .where(status ? and(eq(financialCardCharges.brokerageId, brokerageId), eq(financialCardCharges.status, status)) : eq(financialCardCharges.brokerageId, brokerageId))
    .orderBy(desc(financialCardCharges.createdAt))
    .limit(200);
  return rows;
}
