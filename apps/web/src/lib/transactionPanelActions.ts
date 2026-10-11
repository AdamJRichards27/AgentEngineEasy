// R-F32 — which Transaction panel controls the API would accept under R-F30.
// Derived from fields GET /transactions/by-property already returns
// (status, contractDate, and the milestone timestamps the panel already
// reads) plus the signed-in role useSession() already has. This does not
// call the API and does not invent a new status.
//
// R-F35a — settlement completion, recording funds received, and calculating
// commission (including force; the panel has no separate force control) are
// Brokerage Administrator only. Hiding them is a UX nicety. The API's
// requireRole gate stays the source of truth.

export const CLOSED_TRANSACTION_NOTE = "This transaction is closed — no further changes can be recorded.";

export interface TransactionPanelFields {
  status: string;
  contractDate: string | null;
  financeApprovedAt: string | null;
  exchangedAt: string | null;
  unconditionalAt: string | null;
  settlementDate: string | null;
  settlementCompletedAt: string | null;
  commissionCalculatedAt: string | null;
  agentPaidAt: string | null;
}

export interface TransactionPanelActionVisibility {
  closed: boolean;
  closedNote: string | null;
  /** Hidden once a contract date exists, and on Settled or Closed even when it does not. */
  markContractSigned: boolean;
  /** Closed refuses a finance write. An already-recorded approval stays a no-op and has no button. */
  markFinanceApproved: boolean;
  /** Closed refuses a new exchange. An exchange already recorded stays a no-op and has no button. */
  markExchange: boolean;
  /** Closed refuses the write. Hidden on Closed so the panel stays read-only. */
  markUnconditional: boolean;
  /** Requires contractDate. Settled and Closed cannot be rescheduled. */
  scheduleSettlement: boolean;
  /**
   * Requires contractDate and a settlement date. Closed cannot be completed.
   * Brokerage Administrator only.
   */
  completeSettlement: boolean;
  /**
   * Closed refuses calculate-commission, including force. The panel has no
   * separate force control; this is the only commission action it offers.
   * Brokerage Administrator only.
   */
  calculateCommission: boolean;
  /** Closed refuses a new funds write. Brokerage Administrator only. */
  recordFundsReceived: boolean;
  /** Closed refuses a new agent-paid write. An already-paid row stays a no-op and has no button. */
  markAgentPaid: boolean;
  /** Add, reschedule, and resolve. Closed refuses all three. */
  editConditions: boolean;
  /** Closed refuses legal-representative writes. */
  editLegalRepresentatives: boolean;
}

export function transactionPanelActionVisibility(
  transaction: TransactionPanelFields,
  viewerRole: string | null | undefined,
): TransactionPanelActionVisibility {
  const closed = transaction.status === "Closed";
  const settled = transaction.status === "Settled";
  const contractSigned = Boolean(transaction.contractDate);
  const settlementDone = Boolean(transaction.settlementCompletedAt);
  // Same string every other admin-only page compares against (useSession().user.role).
  const brokerageAdministrator = viewerRole === "Brokerage Administrator";

  return {
    closed,
    closedNote: closed ? CLOSED_TRANSACTION_NOTE : null,
    markContractSigned: !transaction.contractDate && !settled && !closed,
    markFinanceApproved: !transaction.financeApprovedAt && !closed,
    markExchange: !transaction.exchangedAt && !closed,
    markUnconditional: !transaction.unconditionalAt && !closed,
    scheduleSettlement: contractSigned && !settled && !closed && !settlementDone,
    completeSettlement:
      brokerageAdministrator && contractSigned && Boolean(transaction.settlementDate) && !closed && !settlementDone,
    calculateCommission: brokerageAdministrator && !transaction.commissionCalculatedAt && !closed,
    recordFundsReceived: brokerageAdministrator && !closed,
    markAgentPaid: !transaction.agentPaidAt && !closed,
    editConditions: !closed,
    editLegalRepresentatives: !closed,
  };
}
