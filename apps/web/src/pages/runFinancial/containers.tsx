// Owner t181u phase 2b item 6: data containers for the Run financial screens.
// Fetch with React Query through apiFetch (the server re-checks every
// permission and gate; a refusal is shown as returned). Mounted only from
// Run-owned pages (PropertyWorkspace, FinancialOperations). Mock/sandbox
// providers only; no live sends.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiErrorMessage, apiFetch } from "../../lib/api";
import {
  runFinancialCapabilities,
  type AdjustmentRecord,
  type CardCharge,
  type HeldDebit,
  type CardRefund,
  type ProviderStatus,
  type Receipt,
  type ServiceFeeResponse,
  type SettlementConfirmation,
  type SettlementStatement,
} from "../../lib/runFinancial";
import {
  AdjustmentRecordsView,
  CardChargeRow,
  HeldDebitsView,
  CardRefundRow,
  ReceiptsView,
  RecoveryActionsView,
  ServiceFeePanelView,
  StatementPrintView,
  StatementView,
  type EvidenceInput,
} from "./views";

const post = <T,>(path: string, body: unknown) => apiFetch<T>(path, { method: "POST", body: JSON.stringify(body) });

/** Settlement statement + service fee + receipts for one transaction (property workspace). */
export function RunTransactionFinancials({ transactionId, role }: { transactionId: number; role: string | null | undefined }) {
  const caps = runFinancialCapabilities(role);
  const qc = useQueryClient();
  const [printId, setPrintId] = useState<number | null>(null);
  const [lastOutcome, setLastOutcome] = useState<string | null>(null);

  const statementsQ = useQuery({
    queryKey: ["run-statements", transactionId],
    queryFn: () => apiFetch<{ statements: SettlementStatement[] }>(`/financial/settlement-statements?transactionId=${transactionId}`),
    enabled: caps.viewStatements,
  });
  const confirmationsQ = useQuery({
    queryKey: ["run-confirmations", transactionId],
    queryFn: () => apiFetch<{ confirmations: SettlementConfirmation[] }>(`/financial/settlement-confirmations?transactionId=${transactionId}`),
    enabled: caps.viewStatements,
  });
  const feeQ = useQuery({
    queryKey: ["run-service-fee", transactionId],
    queryFn: () => apiFetch<ServiceFeeResponse>(`/payments/pit-crew-service-fee/${transactionId}`),
    enabled: caps.viewServiceFee,
    retry: false,
  });
  const receiptsQ = useQuery({
    queryKey: ["run-receipts", transactionId],
    queryFn: () => apiFetch<{ receipts: Receipt[] }>(`/financial/receipts?transactionId=${transactionId}`),
    enabled: caps.viewStatements,
  });
  const refresh = () => {
    for (const k of ["run-statements", "run-confirmations", "run-service-fee", "run-receipts"]) qc.invalidateQueries({ queryKey: [k, transactionId] });
  };

  const prepare = useMutation({
    mutationFn: (input: { payerType: "Agent" | "Brokerage"; supersedeReason?: string }) => post("/financial/settlement-statements/prepare", { transactionId, ...input }),
    onSuccess: refresh,
  });
  const issue = useMutation({ mutationFn: (id: number) => post(`/financial/settlement-statements/${id}/issue`, {}), onSuccess: refresh });
  const confirm = useMutation({
    mutationFn: (input: { side: "BUYER" | "SELLER"; representativePartyId: number; evidenceNote: string; confirmedAt: string }) => post("/financial/settlement-confirmations", { transactionId, ...input }),
    onSuccess: refresh,
  });
  const collect = useMutation({
    mutationFn: () => post<{ outcome?: string }>(`/payments/pit-crew-service-fee/${transactionId}/collect`, {}),
    onSuccess: (r) => {
      setLastOutcome(r?.outcome ?? null);
      refresh();
    },
  });

  if (!caps.viewStatements && !caps.viewServiceFee) return null;
  const statements = statementsQ.data?.statements ?? [];
  const printing = printId != null ? statements.find((s) => s.id === printId) : undefined;
  const statementError = [prepare, issue, confirm].find((m) => m.isError);

  return (
    <div id="run-transaction-financials">
      {printing && (
        <section className="card">
          <div className="inline-form">
            <button className="btn btn-primary" type="button" onClick={() => window.print()}>
              Print now
            </button>
          </div>
          <StatementPrintView statement={printing} onClose={() => setPrintId(null)} />
        </section>
      )}
      <StatementView
        caps={caps}
        statements={statements}
        confirmations={confirmationsQ.data?.confirmations ?? []}
        busy={prepare.isPending || issue.isPending || confirm.isPending}
        error={
          statementsQ.isError
            ? apiErrorMessage(statementsQ.error, "Couldn't load the settlement statement.")
            : statementError
              ? apiErrorMessage(statementError.error, "That statement action was refused.")
              : null
        }
        onPrepare={(input) => prepare.mutate(input)}
        onIssue={(id) => issue.mutate(id)}
        onRecordConfirmation={(input) => confirm.mutate(input)}
        onPrint={(id) => setPrintId(id)}
      />
      <ServiceFeePanelView
        caps={caps}
        data={feeQ.data}
        busy={collect.isPending}
        error={feeQ.isError ? apiErrorMessage(feeQ.error, "The service fee is not available for this transaction.") : collect.isError ? apiErrorMessage(collect.error, "Collection was refused.") : null}
        lastOutcome={lastOutcome}
        onCollect={() => collect.mutate()}
      />
      {caps.viewStatements && <ReceiptsView receipts={receiptsQ.data?.receipts} error={receiptsQ.isError ? apiErrorMessage(receiptsQ.error, "Couldn't load receipts.") : null} />}
    </div>
  );
}

/** Brokerage Administrator queues (financial operations page). */
export function BaPaymentQueues({ role }: { role: string | null | undefined }) {
  const caps = runFinancialCapabilities(role);
  const qc = useQueryClient();
  const [chargeFilter, setChargeFilter] = useState("UNKNOWN");
  const [refundFilter, setRefundFilter] = useState("UNKNOWN");
  const [chargeStatus, setChargeStatus] = useState<Record<number, ProviderStatus>>({});
  const [refundStatus, setRefundStatus] = useState<Record<number, ProviderStatus>>({});
  const [message, setMessage] = useState<string | null>(null);

  const chargesQ = useQuery({
    queryKey: ["run-card-charges", chargeFilter],
    queryFn: () => apiFetch<{ cardCharges: CardCharge[] }>(`/financial/card-charges${chargeFilter ? `?status=${chargeFilter}` : ""}`),
    enabled: caps.baQueues,
  });
  const refundsQ = useQuery({
    queryKey: ["run-card-refunds", refundFilter],
    queryFn: () => apiFetch<{ cardRefunds: CardRefund[] }>(`/financial/card-refunds${refundFilter ? `?status=${refundFilter}` : ""}`),
    enabled: caps.baQueues,
  });
  const heldQ = useQuery({
    queryKey: ["run-held-debits"],
    queryFn: () => apiFetch<{ held: HeldDebit[] }>("/financial/payment-outbox/held"),
    enabled: caps.heldDebits,
  });
  const done = (text: string) => {
    setMessage(text);
    qc.invalidateQueries({ queryKey: ["run-held-debits"] });
    qc.invalidateQueries({ queryKey: ["run-card-charges"] });
    qc.invalidateQueries({ queryKey: ["run-card-refunds"] });
    qc.invalidateQueries({ queryKey: ["financial-payment-requests"] });
  };
  const fail = (e: unknown) => setMessage(apiErrorMessage(e, "That action was refused."));
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn() });
  const run = (fn: () => Promise<unknown>, ok: string) => act.mutate(fn, { onSuccess: () => done(ok), onError: fail });

  if (!caps.baQueues) return null;
  const ev = (e: EvidenceInput) => ({ reason: e.reason.trim(), evidenceNote: e.evidenceNote.trim() });
  return (
    <>
      {message && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
      <section className="card" aria-labelledby="run-card-charges-heading">
        <h2 id="run-card-charges-heading">Card charges</h2>
        <p className="muted">Unknown outcomes are resolved only to match the (mock) provider; the person who started a charge cannot resolve it. Refunds go back to the original card only.</p>
        <label>
          Status
          <select value={chargeFilter} onChange={(e) => setChargeFilter(e.target.value)}>
            <option value="UNKNOWN">Unknown outcome</option>
            <option value="SUCCEEDED">Succeeded (refundable)</option>
            <option value="FAILED">Failed</option>
            <option value="">All</option>
          </select>
        </label>
        {chargesQ.isError && <p className="error-text">{apiErrorMessage(chargesQ.error, "Couldn't load card charges.")}</p>}
        {(chargesQ.data?.cardCharges.length ?? 0) === 0 && !chargesQ.isError && <p className="muted">Nothing here.</p>}
        <ul className="item-list">
          {(chargesQ.data?.cardCharges ?? []).map((c) => (
            <CardChargeRow
              key={c.id}
              charge={c}
              status={chargeStatus[c.id]}
              busy={act.isPending}
              onCheckStatus={(id) =>
                apiFetch<ProviderStatus>(`/financial/card-charges/${id}/provider-status`).then((s) => setChargeStatus((m) => ({ ...m, [id]: s })), fail)
              }
              onResolve={(id, outcome, e) => run(() => post(`/financial/card-charges/${id}/resolve`, { outcome, ...ev(e) }), "Charge resolved.")}
              onRefund={(id, input) => run(() => post(`/financial/card-charges/${id}/refunds`, { amountCents: input.amountCents, requestKey: input.requestKey, ...ev(input) }), "Refund requested.")}
            />
          ))}
        </ul>
      </section>
      <section className="card" aria-labelledby="run-card-refunds-heading">
        <h2 id="run-card-refunds-heading">Card refunds</h2>
        <label>
          Status
          <select value={refundFilter} onChange={(e) => setRefundFilter(e.target.value)}>
            <option value="UNKNOWN">Unknown outcome</option>
            <option value="PENDING">Pending (no recorded outcome)</option>
            <option value="SUCCEEDED">Succeeded</option>
            <option value="FAILED">Failed</option>
            <option value="">All</option>
          </select>
        </label>
        {refundsQ.isError && <p className="error-text">{apiErrorMessage(refundsQ.error, "Couldn't load card refunds.")}</p>}
        {(refundsQ.data?.cardRefunds.length ?? 0) === 0 && !refundsQ.isError && <p className="muted">Nothing here.</p>}
        <ul className="item-list">
          {(refundsQ.data?.cardRefunds ?? []).map((r) => (
            <CardRefundRow
              key={r.id}
              refund={r}
              status={refundStatus[r.id]}
              busy={act.isPending}
              onCheckStatus={(id) =>
                apiFetch<ProviderStatus>(`/financial/card-refunds/${id}/provider-status`).then((s) => setRefundStatus((m) => ({ ...m, [id]: s })), fail)
              }
              onResolve={(id, outcome, e) => run(() => post(`/financial/card-refunds/${id}/resolve`, { outcome, ...ev(e) }), "Refund resolved.")}
            />
          ))}
        </ul>
      </section>
      {caps.heldDebits && (
        <section className="card" aria-label="Held debits">
          <HeldDebitsView
            held={heldQ.data?.held}
            error={heldQ.isError ? apiErrorMessage(heldQ.error, "Couldn't load held debits.") : null}
            busy={act.isPending}
            onResolve={(id, body) => run(() => post(`/financial/payment-outbox/${id}/resolve-held`, body), "Held debit resolved.")}
          />
        </section>
      )}
    </>
  );
}

/** Waive / write-off / resolve-dispute controls for one payment request (BA only). */
export function PaymentRequestRecovery({ role, paymentRequestId, status }: { role: string | null | undefined; paymentRequestId: number; status: string }) {
  const caps = runFinancialCapabilities(role);
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (v: { action: "waive" | "write-off" | "resolve-dispute"; body: Record<string, unknown> }) => post(`/financial/payment-requests/${paymentRequestId}/${v.action}`, v.body),
    onSuccess: () => {
      setMessage("Done.");
      qc.invalidateQueries({ queryKey: ["financial-payment-requests"] });
      qc.invalidateQueries({ queryKey: ["run-adjustments", paymentRequestId] });
    },
    onError: (e) => setMessage(apiErrorMessage(e, "That action was refused.")),
  });
  if (!caps.baQueues) return null;
  return (
    <>
      <PaymentRequestAdjustments enabled={caps.adjustmentRecords} paymentRequestId={paymentRequestId} />
      <RecoveryActionsView
        paymentRequestId={paymentRequestId}
        status={status}
        busy={m.isPending}
        onAction={(_id, action, input) =>
          m.mutate({ action, body: { reason: input.reason.trim(), evidenceNote: input.evidenceNote.trim(), ...(input.outcome && action === "resolve-dispute" ? { outcome: input.outcome } : {}) } })
        }
      />
      {message && <span className="muted">{message}</span>}
    </>
  );
}

/** S6: waiver / write-off records for one payment request (BA only, read). */
function PaymentRequestAdjustments({ enabled, paymentRequestId }: { enabled: boolean; paymentRequestId: number }) {
  const q = useQuery({
    queryKey: ["run-adjustments", paymentRequestId],
    queryFn: () => apiFetch<{ adjustments: AdjustmentRecord[] }>(`/financial/payment-requests/${paymentRequestId}/adjustments`),
    enabled,
  });
  if (!enabled) return null;
  return <AdjustmentRecordsView records={q.data?.adjustments} error={q.isError ? apiErrorMessage(q.error, "Couldn't load adjustment records.") : null} />;
}
