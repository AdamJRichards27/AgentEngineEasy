// R-F37 — read-only comparison of funds received with calculated commission.
// Integer cents only. This does not write, gate, or override anything.

import type { Transaction } from "@aee/db";

export const FUNDS_RECONCILIATION_STATUSES = [
  "COMMISSION_NOT_CALCULATED",
  "NOT_RECEIVED",
  "PARTIAL",
  "MATCHED",
  "OVER_RECEIVED",
] as const;

export type FundsReconciliationStatus = (typeof FUNDS_RECONCILIATION_STATUSES)[number];

export interface FundsReconciliation {
  status: FundsReconciliationStatus;
  expectedCents: number | null;
  receivedCents: number;
  varianceCents: number | null;
}

/**
 * Expected commission is gross + GST, and only after commission has been
 * calculated. Variance is received − expected. Zero is MATCHED; a shortfall
 * with nothing received is NOT_RECEIVED; any other shortfall is PARTIAL;
 * a surplus is OVER_RECEIVED.
 */
export function computeFundsReconciliation(
  t: Pick<Transaction, "grossCommissionCents" | "gstCents" | "commissionCalculatedAt" | "fundsReceivedCents">,
): FundsReconciliation {
  const receivedCents = t.fundsReceivedCents;
  if (!t.commissionCalculatedAt) {
    return {
      status: "COMMISSION_NOT_CALCULATED",
      expectedCents: null,
      receivedCents,
      varianceCents: null,
    };
  }

  const expectedCents = (t.grossCommissionCents ?? 0) + (t.gstCents ?? 0);
  const varianceCents = receivedCents - expectedCents;
  const status: FundsReconciliationStatus =
    varianceCents === 0
      ? "MATCHED"
      : varianceCents < 0 && receivedCents === 0
        ? "NOT_RECEIVED"
        : varianceCents < 0
          ? "PARTIAL"
          : "OVER_RECEIVED";

  return { status, expectedCents, receivedCents, varianceCents };
}
