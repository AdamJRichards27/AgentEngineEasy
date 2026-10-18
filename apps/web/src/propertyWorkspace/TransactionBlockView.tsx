// Moved unchanged from PropertyWorkspace.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { transactionPanelActionVisibility } from "../lib/transactionPanelActions";
import {
  closeBlockedReason,
  closeTransactionDisabled,
  visibleClosureBlockerRows,
  type ClosureBlockerDetail,
} from "../lib/closureBlockers";
import { fundsReconciliationLabel, type FundsReconciliationView } from "../lib/fundsReconciliation";
import { ConditionsBlock } from "./ConditionsBlock";
import { LegalRepresentativesForm } from "./LegalRepresentativesForm";
import type { PartyLink, TransactionBlock, ConditionBlock } from "./types";
import { formatCents } from "./types";

// Transaction lifecycle (Phase 7; Stage D/E/F/H this build) — shown as a
// checklist with upcoming dates, matching the staging brief's Transaction
// Workspace example. Now also carries contract conditions, exchange /
// unconditional (#118), and legal representative capture (#117).
export function TransactionBlockView({
  transaction,
  fundsReconciliation,
  closureBlockers,
  closureBlockerDetails,
  viewerRole,
  onAction,
  error,
  conditions,
  settlementConditions,
  onAddCondition,
  addConditionError,
  onRescheduleCondition,
  onResolveCondition,
  onExchange,
  onMarkUnconditional,
  unconditionalError,
  solicitors,
  onSaveLegalReps,
}: {
  transaction: TransactionBlock;
  fundsReconciliation: FundsReconciliationView | null;
  /** R-F42 blockers from the transaction read. Null when the read omitted them. */
  closureBlockers: readonly string[] | null;
  closureBlockerDetails: readonly ClosureBlockerDetail[] | null;
  viewerRole: string | null | undefined;
  onAction: (action: string, body?: Record<string, unknown>) => void;
  error: string | null;
  conditions: ConditionBlock[];
  /** null while GET /transactions/:id/conditions has not returned. An empty list is loaded. */
  settlementConditions: ReadonlyArray<{ status: string }> | null;
  onAddCondition: (input: Record<string, unknown>) => void;
  addConditionError: string | null;
  onRescheduleCondition: (conditionId: number, newDueDate: string | null) => void;
  onResolveCondition: (conditionId: number, status: string, notes?: string) => void;
  onExchange: () => void;
  onMarkUnconditional: () => void;
  unconditionalError: string | null;
  solicitors: PartyLink[];
  onSaveLegalReps: (input: Record<string, unknown>) => void;
}) {
  const [settlementDate, setSettlementDate] = useState("");
  const [fundsAmount, setFundsAmount] = useState("");
  // R-F32 — offer a control only when R-F30 would accept the write.
  // R-F35a — settlement completion, funds received, and commission
  // calculation stay hidden unless the signed-in role is Brokerage
  // Administrator. Milestone text stays visible either way. `error` stays
  // below so a stale click still shows the server message, including a 403.
  // R-F38 — Mark Settlement Completed stays on screen for an administrator
  // and is disabled until the contract is unconditional. settlementConditions
  // is the existing conditions GET; null means it has not loaded.
  const actions = transactionPanelActionVisibility(transaction, viewerRole, settlementConditions);
  const closeBlockers = visibleClosureBlockerRows(transaction.status, closureBlockers, closureBlockerDetails);
  const closeDisabled = closeTransactionDisabled(transaction.status, closureBlockers);

  return (
    <div className="stack">
      <p>
        {formatCents(transaction.purchasePriceCents)} · <span className="pill">{transaction.status}</span>
      </p>
      {actions.closedNote && <p className="muted">{actions.closedNote}</p>}

      <div>
        Contract: {transaction.contractDate ? `signed ${transaction.contractDate}` : "not yet signed"}
        {actions.markContractSigned && (
          <button className="btn btn-small" onClick={() => onAction("contract-signed")} style={{ marginLeft: "0.5rem" }}>
            Mark Contract Signed
          </button>
        )}
      </div>

      <div>
        Finance: {transaction.financeApprovedAt ? `approved ${transaction.financeApprovedAt}` : "not recorded"}
        {actions.markFinanceApproved && (
          <button className="btn btn-small" onClick={() => onAction("finance-approved")} style={{ marginLeft: "0.5rem" }}>
            Mark Finance Approved
          </button>
        )}
      </div>

      {/* Stage E (#118) — contract conditions + exchange/unconditional. */}
      <ConditionsBlock
        conditions={conditions}
        editable={actions.editConditions}
        onAdd={onAddCondition}
        addError={addConditionError}
        onReschedule={onRescheduleCondition}
        onResolve={onResolveCondition}
      />

      <div>
        Exchange: {transaction.exchangedAt ? `exchanged ${transaction.exchangedAt}` : "not yet exchanged"}
        {actions.markExchange && (
          <button className="btn btn-small" onClick={onExchange} style={{ marginLeft: "0.5rem" }}>
            Mark Contracts Exchanged
          </button>
        )}
      </div>

      <div id="transaction-unconditional">
        Unconditional:{" "}
        {transaction.unconditionalAt
          ? `became unconditional ${transaction.unconditionalAt}`
          : "not yet unconditional"}
        {actions.markUnconditional && (
          <button className="btn btn-small" onClick={onMarkUnconditional} style={{ marginLeft: "0.5rem" }}>
            Mark Unconditional
          </button>
        )}
        {unconditionalError && <p className="error-text">{unconditionalError}</p>}
      </div>

      {/* Stage D/F (#117) — legal representatives. */}
      <LegalRepresentativesForm
        initial={transaction.legalRepresentatives}
        solicitors={solicitors}
        editable={actions.editLegalRepresentatives}
        onSave={onSaveLegalReps}
      />

      <div>
        Settlement:{" "}
        {transaction.settlementCompletedAt
          ? `completed ${transaction.settlementCompletedAt}`
          : transaction.settlementDate
            ? `scheduled ${new Date(transaction.settlementDate).toLocaleDateString()}`
            : "not yet scheduled"}
      </div>
      {(actions.scheduleSettlement || actions.completeSettlement) && (
        <div className="inline-form">
          {actions.scheduleSettlement && (
            <>
              <input type="date" value={settlementDate} onChange={(e) => setSettlementDate(e.target.value)} />
              <button
                className="btn btn-small"
                onClick={() => settlementDate && onAction("settlement-schedule", { settlementDate })}
                disabled={!settlementDate}
              >
                Schedule Settlement
              </button>
            </>
          )}
          {actions.completeSettlement && (
            <button
              className="btn btn-small"
              onClick={() => {
                if (actions.completeSettlementReason) return;
                onAction("settlement-complete");
              }}
              disabled={actions.completeSettlementReason !== null}
            >
              Mark Settlement Completed
            </button>
          )}
        </div>
      )}
      {actions.completeSettlementReason && <p className="muted">{actions.completeSettlementReason}</p>}

      <div id="transaction-commission">
        Commission:{" "}
        {transaction.commissionCalculatedAt
          ? `${formatCents(transaction.grossCommissionCents ?? 0)} + ${formatCents(transaction.gstCents ?? 0)} GST`
          : "not yet calculated"}
        {actions.calculateCommission && (
          <button className="btn btn-small" onClick={() => onAction("calculate-commission")} style={{ marginLeft: "0.5rem" }}>
            Calculate Commission
          </button>
        )}
      </div>

      <div className="inline-form" id="transaction-funds">
        <span>Funds received: {formatCents(transaction.fundsReceivedCents)}</span>
        {actions.recordFundsReceived && (
          <>
            <input value={fundsAmount} onChange={(e) => setFundsAmount(e.target.value)} placeholder="Amount ($)" />
            <button
              className="btn btn-small"
              onClick={() => {
                if (!fundsAmount) return;
                onAction("funds-received", { amountCents: Math.round(Number(fundsAmount) * 100) });
                setFundsAmount("");
              }}
              disabled={!fundsAmount}
            >
              Record Funds Received
            </button>
          </>
        )}
      </div>
      {fundsReconciliation && <div>{fundsReconciliationLabel(fundsReconciliation)}</div>}

      <div>
        Agent paid: {transaction.agentPaidAt ?? "not yet"}
        {actions.markAgentPaid && (
          <button className="btn btn-small" onClick={() => onAction("agent-paid")} style={{ marginLeft: "0.5rem" }}>
            Mark Agent Paid
          </button>
        )}
      </div>

      {closeBlockers.length > 0 && (
        <div>
          <p className="muted">{closeBlockedReason(viewerRole)}</p>
          <ul className="item-list">
            {closeBlockers.map((blocker, index) => (
              <li key={`${index}-${blocker.message}`}>
                {blocker.href ? <a href={blocker.href}>{blocker.plain}</a> : blocker.plain}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        {transaction.status === "Closed" ? (
          `Closed ${transaction.closedAt}`
        ) : (
          <button
            className="btn btn-primary btn-small"
            onClick={() => {
              if (closeDisabled) return;
              onAction("close");
            }}
            disabled={closeDisabled}
          >
            Close Transaction
          </button>
        )}
      </div>

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
