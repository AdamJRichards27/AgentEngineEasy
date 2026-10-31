// Owner t212u items 3-4: reconciliation exceptions for Brokerage Administrator review.
//   PAID_AFTER_WAIVER / PAID_AFTER_WRITE_OFF: the provider reported payment for a fee AE had
//     already waived or written off. The provider event is persisted (financial_payment_provider_events,
//     linked here), never discarded; the locked request, ledger and receipts are NOT mutated (0044
//     triggers would refuse it anyway). A BA records a refund assessment.
//   CANCELLATION_UNCONFIRMED: raised by recovery.ts when the provider did not confirm cancelling its
//     pending retries before a waiver/write-off (the hold stays).
// One OPEN exception per (payment request, kind); repeated notices are persisted but do not duplicate it.
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, db, financialReconciliationExceptions, type FinancialPaymentRequest, type FinancialReconciliationException } from "@aee/db";

export const ADJUSTED_STATUSES = new Set(["WAIVED", "WRITTEN_OFF"]);
export const REFUND_ASSESSMENTS = ["REFUND_REQUIRED", "NO_REFUND_REQUIRED", "NOT_APPLICABLE"] as const;
export type RefundAssessment = (typeof REFUND_ASSESSMENTS)[number];
const BA_ROLE = "Brokerage Administrator";

export type ReconExceptionCode = "RECON_FORBIDDEN" | "RECON_NOT_FOUND" | "RECON_ASSESSMENT_REQUIRED" | "RECON_REASON_REQUIRED" | "RECON_EXCEPTION_NOT_OPEN";
export const RECON_ERROR_STATUS: Record<ReconExceptionCode, number> = {
  RECON_FORBIDDEN: 403,
  RECON_NOT_FOUND: 404,
  RECON_ASSESSMENT_REQUIRED: 400,
  RECON_REASON_REQUIRED: 400,
  RECON_EXCEPTION_NOT_OPEN: 409,
};
export class ReconExceptionRefusal extends Error {
  constructor(
    readonly code: ReconExceptionCode,
    message: string,
  ) {
    super(message);
  }
}

/** Raise (idempotently) a Paid-after-adjustment exception. Returns the OPEN exception. Never mutates the request. */
export async function raisePaidAfterAdjustment(input: {
  request: FinancialPaymentRequest;
  source: "WEBHOOK" | "RECONCILIATION";
  providerEventRowId?: number | null;
  providerRequestRef: string;
  detail?: Record<string, unknown>;
}): Promise<{ exception: FinancialReconciliationException; created: boolean }> {
  const { request } = input;
  const kind = request.status === "WAIVED" ? "PAID_AFTER_WAIVER" : "PAID_AFTER_WRITE_OFF";
  const [created] = await db
    .insert(financialReconciliationExceptions)
    .values({
      brokerageId: request.brokerageId,
      paymentRequestId: request.id,
      propertyId: request.propertyId,
      kind,
      source: input.source,
      providerEventRowId: input.providerEventRowId ?? null,
      providerRequestRef: input.providerRequestRef,
      amountCents: request.amountCents,
      detail: { requestStatus: request.status, refundAssessmentNeeded: true, ...(input.detail ?? {}), policy: "t212u item 3" },
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    await db.insert(auditLogs).values({
      brokerageId: request.brokerageId,
      userId: null,
      action: "reconciliation_exception_raised",
      recordType: "financial_reconciliation_exception",
      recordId: String(created.id),
      propertyId: request.propertyId,
      updatedValue: JSON.stringify({ kind, source: input.source, paymentRequestId: request.id, amountCents: request.amountCents, providerEventRowId: input.providerEventRowId ?? null }),
    });
    return { exception: created, created: true };
  }
  const [open] = await db
    .select()
    .from(financialReconciliationExceptions)
    .where(and(eq(financialReconciliationExceptions.paymentRequestId, request.id), eq(financialReconciliationExceptions.kind, kind), eq(financialReconciliationExceptions.status, "OPEN")));
  return { exception: open!, created: false };
}

export async function hasPaidAfterAdjustmentException(paymentRequestId: number): Promise<boolean> {
  const rows = await db
    .select({ id: financialReconciliationExceptions.id, kind: financialReconciliationExceptions.kind })
    .from(financialReconciliationExceptions)
    .where(eq(financialReconciliationExceptions.paymentRequestId, paymentRequestId));
  return rows.some((r) => r.kind === "PAID_AFTER_WAIVER" || r.kind === "PAID_AFTER_WRITE_OFF");
}

interface Actor {
  id: number;
  role: string;
  brokerageId: number;
}
function assertBa(actor: Actor) {
  if (actor.role !== BA_ROLE) throw new ReconExceptionRefusal("RECON_FORBIDDEN", "Only a Brokerage Administrator can review reconciliation exceptions.");
}

export async function listReconciliationExceptions(actor: Actor, opts: { status?: string } = {}) {
  assertBa(actor);
  const conds = [eq(financialReconciliationExceptions.brokerageId, actor.brokerageId)];
  if (opts.status === "OPEN" || opts.status === "RESOLVED") conds.push(eq(financialReconciliationExceptions.status, opts.status));
  return db.select().from(financialReconciliationExceptions).where(and(...conds)).orderBy(desc(financialReconciliationExceptions.id)).limit(200);
}

/** Records the BA's review and refund assessment. Never edits the locked financial records; any refund is a separate, approved action. */
export async function resolveReconciliationException(actor: Actor, id: number, input: { refundAssessment?: unknown; reason?: unknown }) {
  assertBa(actor);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ReconExceptionRefusal("RECON_NOT_FOUND", "Not found.");
  const assessment = typeof input.refundAssessment === "string" && (REFUND_ASSESSMENTS as readonly string[]).includes(input.refundAssessment) ? (input.refundAssessment as RefundAssessment) : null;
  if (!assessment) throw new ReconExceptionRefusal("RECON_ASSESSMENT_REQUIRED", `A refund assessment is required (${REFUND_ASSESSMENTS.join(", ")}).`);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 2000) throw new ReconExceptionRefusal("RECON_REASON_REQUIRED", "A reason (3-2000 characters) is required.");
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(financialReconciliationExceptions)
      .where(and(eq(financialReconciliationExceptions.id, id), eq(financialReconciliationExceptions.brokerageId, actor.brokerageId)))
      .for("update");
    if (!row) throw new ReconExceptionRefusal("RECON_NOT_FOUND", "Not found.");
    if (row.status !== "OPEN") throw new ReconExceptionRefusal("RECON_EXCEPTION_NOT_OPEN", "This exception has already been resolved.");
    const [updated] = await tx
      .update(financialReconciliationExceptions)
      .set({ status: "RESOLVED", refundAssessment: assessment, resolutionReason: reason, resolvedByUserId: actor.id, resolvedAt: new Date() })
      .where(eq(financialReconciliationExceptions.id, id))
      .returning();
    await tx.insert(auditLogs).values({
      brokerageId: actor.brokerageId,
      userId: actor.id,
      action: "reconciliation_exception_resolved",
      recordType: "financial_reconciliation_exception",
      recordId: String(id),
      propertyId: row.propertyId,
      previousValue: JSON.stringify({ status: row.status }),
      updatedValue: JSON.stringify({ status: "RESOLVED", kind: row.kind, refundAssessment: assessment, reason, paymentRequestId: row.paymentRequestId, policy: "t212u item 3" }),
    });
    return updated!;
  });
}
