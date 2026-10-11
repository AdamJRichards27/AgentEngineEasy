// R-F37 — the one read-only line under "Funds received" on the Transaction
// panel. The figures are the commission and funds the panel already shows.
// This does not offer an action.

export const FUNDS_RECONCILIATION_STATUSES = [
  "COMMISSION_NOT_CALCULATED",
  "NOT_RECEIVED",
  "PARTIAL",
  "MATCHED",
  "OVER_RECEIVED",
] as const;

export type FundsReconciliationStatus = (typeof FUNDS_RECONCILIATION_STATUSES)[number];

export interface FundsReconciliationView {
  status: FundsReconciliationStatus;
  expectedCents: number | null;
  receivedCents: number;
  varianceCents: number | null;
}

/** Same dollar text as the Transaction panel's formatCents. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function fundsReconciliationLabel(reconciliation: FundsReconciliationView): string {
  switch (reconciliation.status) {
    case "COMMISSION_NOT_CALCULATED":
      return "Commission not calculated yet";
    case "NOT_RECEIVED":
      return `Nothing received yet — ${formatCents(reconciliation.expectedCents ?? 0)} expected (incl. GST)`;
    case "PARTIAL":
      return `Outstanding ${formatCents(Math.abs(reconciliation.varianceCents ?? 0))} of ${formatCents(reconciliation.expectedCents ?? 0)} (incl. GST)`;
    case "MATCHED":
      return "Received in full";
    case "OVER_RECEIVED":
      return `Over-received by ${formatCents(reconciliation.varianceCents ?? 0)} — check with the brokerage's accounts`;
  }
}
