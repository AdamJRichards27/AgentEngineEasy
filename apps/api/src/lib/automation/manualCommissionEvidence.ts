// R-F42 amendment B — manual S2 (commission checklist) evidence.
//
// Stored on the completion audit row's updated_value as JSON, in the same
// database transaction as the task status change. automation_tasks has no
// jsonb column; detail is the human task text and part of the supersede
// identity, so it is not an evidence slot. audit_logs has no metadata jsonb
// column. updated_value is the append-only field this codebase already uses
// for structured audit detail.

import { eq } from "drizzle-orm";
import { db, transactions } from "@aee/db";
import {
  MANUAL_COMMISSION_PAYMENT_METHODS,
  type ManualCommissionPaymentMethod,
} from "./closurePolicy.js";

export interface ManualCommissionEvidence {
  amountCents: number;
  date: string;
  paymentMethod: ManualCommissionPaymentMethod;
  reference: string;
}

export interface StoredManualCommissionEvidence extends ManualCommissionEvidence {
  kind: "manual_commission_sign_off";
  expectedCents: number;
  reconciled: true;
}

export type ManualEvidenceFailure = "EVIDENCE_REQUIRED" | "EVIDENCE_INVALID" | "EVIDENCE_DOES_NOT_RECONCILE";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseManualCommissionEvidence(
  raw: unknown,
): { ok: true; evidence: ManualCommissionEvidence } | { ok: false; reason: ManualEvidenceFailure; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reason: "EVIDENCE_REQUIRED",
      message: "Manual commission sign-off requires amountCents, date, paymentMethod, and reference.",
    };
  }
  const body = raw as Record<string, unknown>;
  const missing =
    body.amountCents == null && body.date == null && body.paymentMethod == null && body.reference == null;
  if (missing) {
    return {
      ok: false,
      reason: "EVIDENCE_REQUIRED",
      message: "Manual commission sign-off requires amountCents, date, paymentMethod, and reference.",
    };
  }

  if (!Number.isInteger(body.amountCents) || (body.amountCents as number) < 0) {
    return { ok: false, reason: "EVIDENCE_INVALID", message: "amountCents must be a non-negative integer number of cents." };
  }
  if (typeof body.date !== "string" || !isCalendarDate(body.date)) {
    return { ok: false, reason: "EVIDENCE_INVALID", message: "date must be a calendar date in YYYY-MM-DD form." };
  }
  if (typeof body.paymentMethod !== "string" || !(MANUAL_COMMISSION_PAYMENT_METHODS as readonly string[]).includes(body.paymentMethod)) {
    return {
      ok: false,
      reason: "EVIDENCE_INVALID",
      message: `paymentMethod must be one of ${MANUAL_COMMISSION_PAYMENT_METHODS.join(", ")}.`,
    };
  }
  if (typeof body.reference !== "string" || body.reference.trim().length === 0 || body.reference.trim().length > 200) {
    return { ok: false, reason: "EVIDENCE_INVALID", message: "reference must be a non-empty string of at most 200 characters." };
  }

  return {
    ok: true,
    evidence: {
      amountCents: body.amountCents as number,
      date: body.date,
      paymentMethod: body.paymentMethod as ManualCommissionPaymentMethod,
      reference: body.reference.trim(),
    },
  };
}

function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * The evidence amount must equal calculated commission plus GST. A different
 * figure is rejected. Amendment A already blocks close unless funds
 * reconciliation is MATCHED, so a stored deviation would record a mismatch
 * on a completed checklist without clearing that block.
 */
export async function reconcileManualCommissionEvidence(
  transactionId: number | null,
  evidence: ManualCommissionEvidence,
): Promise<{ ok: true; stored: StoredManualCommissionEvidence } | { ok: false; reason: ManualEvidenceFailure; message: string }> {
  if (!transactionId) {
    return {
      ok: false,
      reason: "EVIDENCE_DOES_NOT_RECONCILE",
      message: "This commission checklist is not attached to a transaction, so the amount cannot be reconciled.",
    };
  }
  const [transaction] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  if (!transaction?.commissionCalculatedAt) {
    return {
      ok: false,
      reason: "EVIDENCE_DOES_NOT_RECONCILE",
      message: "Commission has not been calculated, so a manual sign-off amount cannot be reconciled.",
    };
  }
  const expectedCents = (transaction.grossCommissionCents ?? 0) + (transaction.gstCents ?? 0);
  if (evidence.amountCents !== expectedCents) {
    return {
      ok: false,
      reason: "EVIDENCE_DOES_NOT_RECONCILE",
      message: `Manual commission evidence amount must equal commission plus GST (${expectedCents} cents). A deviation is not accepted.`,
    };
  }
  return {
    ok: true,
    stored: {
      kind: "manual_commission_sign_off",
      ...evidence,
      expectedCents,
      reconciled: true,
    },
  };
}
