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
//
// R-F38 — completeSettlement returns 400 until transactionIsUnconditional,
// which is unconditionalAt. That timestamp is written once the contract is
// exchanged and every tracked condition is Satisfied, Waived, or
// NotApplicable, including when there are no conditions. The button stays
// visible to a Brokerage Administrator and is disabled until then. There
// is no override.

export const CLOSED_TRANSACTION_NOTE = "This transaction is closed — no further changes can be recorded.";

export const SETTLEMENT_CONDITIONAL_REASON = "Settlement can be completed once the contract is unconditional";

/** Same non-blocking set as maybeRecordUnconditional. Failed and Pending block. */
const NON_BLOCKING_CONDITION_STATUSES = new Set(["Satisfied", "Waived", "NotApplicable"]);

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
   * Brokerage Administrator only. R-F38 — still offered while the contract
   * is conditional, and disabled until it is unconditional.
   */
  completeSettlement: boolean;
  /**
   * R-F38 — present only while Mark Settlement Completed is offered and the
   * contract is still conditional. Null when the button is hidden or enabled.
   */
  completeSettlementReason: string | null;
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

/**
 * Mirrors transactionIsUnconditional (unconditionalAt is set).
 *
 * Condition rows are not on the transaction payload. Pass the list from the
 * existing GET /transactions/:id/conditions. null means that read has not
 * returned — an unknown list is not zero conditions. A loaded list
 * (including empty) plus a signed, exchanged contract is the moment the API
 * writes unconditionalAt; the transaction query can still be stale after a
 * condition is resolved, so that case counts as unconditional too. It does
 * not enable settlement before exchange. A set unconditionalAt wins even
 * when a condition row still looks blocking, because completeSettlement
 * reads the timestamp and does not re-check the rows.
 */
export function transactionIsUnconditionalForSettlement(
  transaction: Pick<TransactionPanelFields, "contractDate" | "exchangedAt" | "unconditionalAt">,
  conditions: ReadonlyArray<{ status: string }> | null,
): boolean {
  if (transaction.unconditionalAt) return true;
  if (conditions === null || !transaction.contractDate || !transaction.exchangedAt) return false;
  return conditions.every((condition) => NON_BLOCKING_CONDITION_STATUSES.has(condition.status));
}

export function transactionPanelActionVisibility(
  transaction: TransactionPanelFields,
  viewerRole: string | null | undefined,
  conditions: ReadonlyArray<{ status: string }> | null = null,
): TransactionPanelActionVisibility {
  const closed = transaction.status === "Closed";
  const settled = transaction.status === "Settled";
  const contractSigned = Boolean(transaction.contractDate);
  const settlementDone = Boolean(transaction.settlementCompletedAt);
  // Same string every other admin-only page compares against (useSession().user.role).
  const brokerageAdministrator = viewerRole === "Brokerage Administrator";
  const completeSettlement =
    brokerageAdministrator && contractSigned && Boolean(transaction.settlementDate) && !closed && !settlementDone;
  const settlementUnconditional = transactionIsUnconditionalForSettlement(transaction, conditions);

  return {
    closed,
    closedNote: closed ? CLOSED_TRANSACTION_NOTE : null,
    markContractSigned: !transaction.contractDate && !settled && !closed,
    markFinanceApproved: !transaction.financeApprovedAt && !closed,
    markExchange: !transaction.exchangedAt && !closed,
    markUnconditional: !transaction.unconditionalAt && !closed,
    scheduleSettlement: contractSigned && !settled && !closed && !settlementDone,
    completeSettlement,
    completeSettlementReason: completeSettlement && !settlementUnconditional ? SETTLEMENT_CONDITIONAL_REASON : null,
    calculateCommission: brokerageAdministrator && !transaction.commissionCalculatedAt && !closed,
    recordFundsReceived: brokerageAdministrator && !closed,
    markAgentPaid: !transaction.agentPaidAt && !closed,
    editConditions: !closed,
    editLegalRepresentatives: !closed,
  };
}
