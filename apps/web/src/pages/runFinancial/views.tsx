// Owner t181u phase 2b item 6: presentational views for the Run financial
// screens. Pure (props in, callbacks out): no fetching, no session, no
// provider. Controls are hidden or disabled by role via lib/runFinancial.ts
// capabilities; the server stays authoritative and its refusal text is shown.
// Mock/sandbox providers only; nothing here sends a message.
import { useState } from "react";
import {
  activeConfirmations,
  formatAud,
  formatAestTime,
  formatDay,
  heldResolveBody,
  methodText,
  newRefundRequestKey,
  reconciliationIssueText,
  reconciliationLabel,
  reconciliationPill,
  recoveryActionsFor,
  statementActions,
  statementGateText,
  statementPrintModel,
  statementStatusLabel,
  statementStatusPill,
  statementVersions,
  timingText,
  type AdjustmentRecord,
  type AuthoritySummary,
  type HeldDebit,
  type HeldResolveOutcome,
  type RetryState,
  type CardCharge,
  type CardRefund,
  type ProviderStatus,
  type Receipt,
  type RunFinancialCapabilities,
  type ServiceFeeResponse,
  type SettlementConfirmation,
  type SettlementStatement,
  type StatementReconciliation,
  CORRECTABLE_TABLES,
  correctionBody,
  reconResolveBody,
  RECON_KIND_LABEL,
  REFUND_ASSESSMENT_LABEL,
  type CorrectionRecord,
  type ReconciliationException,
} from "../../lib/runFinancial";

export const DEMO_NOTICE =
  "Mock payment provider only · no live payments or messages";

export interface EvidenceInput {
  reason: string;
  evidenceNote: string;
}

function EvidenceFields({
  value,
  onChange,
  idPrefix,
}: {
  value: EvidenceInput;
  onChange: (v: EvidenceInput) => void;
  idPrefix: string;
}) {
  return (
    <>
      <label htmlFor={`${idPrefix}-reason`}>
        Reason (required)
        <input
          id={`${idPrefix}-reason`}
          value={value.reason}
          onChange={(e) => onChange({ ...value, reason: e.target.value })}
        />
      </label>
      <label htmlFor={`${idPrefix}-evidence`}>
        Evidence note (required, no card details)
        <input
          id={`${idPrefix}-evidence`}
          value={value.evidenceNote}
          onChange={(e) => onChange({ ...value, evidenceNote: e.target.value })}
        />
      </label>
    </>
  );
}
const evidenceReady = (v: EvidenceInput) =>
  v.reason.trim().length >= 3 && v.evidenceNote.trim().length > 0;

// ---------------------------------------------------------------------------
// Reconciliation section (G17), shared by the screen and the print view.
export function ReconciliationSection({
  reconciliation,
  currency = "AUD",
}: {
  reconciliation: StatementReconciliation | null;
  currency?: string;
}) {
  if (!reconciliation)
    return (
      <p className="muted">
        Reconciliation is shown for the issued statement only.
      </p>
    );
  const r = reconciliation;
  return (
    <div className="stack" data-testid="statement-reconciliation">
      <h3>
        Payments and refunds{" "}
        <span className={reconciliationPill(r.status)}>
          {reconciliationLabel(r.status)}
        </span>
      </h3>
      <p className="muted">
        Worked out from issued receipts and the ledger as at {formatDay(r.asOf)}
        . The issued statement itself never changes.
      </p>
      {r.issues.length > 0 && (
        <ul className="error-text">
          {r.issues.map((i, n) => (
            <li key={n}>{reconciliationIssueText(i.code)}</li>
          ))}
        </ul>
      )}
      {r.entries.length === 0 ? (
        <p className="muted">No payments or refunds yet.</p>
      ) : (
        <div style={{ overflowX: "auto", maxWidth: "100%" }}>
          <table>
            <thead>
              <tr>
                <th>Receipt</th>
                <th>Type</th>
                <th>Credit/Debit</th>
                <th>Amount</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {r.entries.map((e) => (
                <tr key={`${e.kind}-${e.receiptId}`}>
                  <td>{e.receiptNumber}</td>
                  <td>
                    {e.kind === "PAYMENT" ? "Payment received" : "Refund"}
                  </td>
                  <td>{e.effect === "CREDIT" ? "Credit" : "Debit"}</td>
                  <td>{formatAud(e.amountCents, currency)}</td>
                  <td>{formatDay(e.issuedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <dl className="cost-summary">
        <dt>Itemised service fee</dt>
        <dd>{formatAud(r.totals.itemisedServiceFeeCents, currency)}</dd>
        <dt>Paid</dt>
        <dd>{formatAud(r.totals.paidCents, currency)}</dd>
        <dt>Refunded</dt>
        <dd>{formatAud(r.totals.refundedCents, currency)}</dd>
        <dt>Net collected</dt>
        <dd>{formatAud(r.totals.netCollectedCents, currency)}</dd>
        <dt>Balance</dt>
        <dd>{formatAud(r.totals.balanceCents, currency)}</dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settlement statement: draft, issue, versions, confirmations, reconciliation.
export interface StatementViewProps {
  caps: RunFinancialCapabilities;
  statements: SettlementStatement[];
  confirmations: SettlementConfirmation[];
  busy?: boolean;
  error?: string | null;
  onPrepare: (input: {
    payerType: "Agent" | "Brokerage";
    supersedeReason?: string;
  }) => void;
  onIssue: (statementId: number) => void;
  onRecordConfirmation: (input: {
    side: "BUYER" | "SELLER";
    representativePartyId: number;
    evidenceNote: string;
    confirmedAt: string;
  }) => void;
  onPrint: (statementId: number) => void;
}

export function StatementView(props: StatementViewProps) {
  const { caps, statements, confirmations, busy, error } = props;
  const { current, versions, issued, draft } = statementVersions(statements);
  const actions = statementActions(caps, statements);
  const conf = activeConfirmations(confirmations);
  const [payerType, setPayerType] = useState<"Agent" | "Brokerage">(
    current?.payerType ?? "Agent",
  );
  const [supersedeReason, setSupersedeReason] = useState("");
  const [confSide, setConfSide] = useState<"BUYER" | "SELLER">("BUYER");
  const [confParty, setConfParty] = useState("");
  const [confNote, setConfNote] = useState("");
  const [confDate, setConfDate] = useState("");

  if (!caps.viewStatements) return null;
  return (
    <section className="card" aria-labelledby="run-statement-heading">
      <div className="eyebrow">Settlement</div>
      <h2 id="run-statement-heading">Settlement statement</h2>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      <h3>Written settlement confirmations</h3>
      <ul className="item-list">
        <li>
          Buyer&apos;s representative:{" "}
          {conf.buyer ? (
            <span className="pill pill-success">
              Confirmed {formatDay(conf.buyer.confirmedAt)}
            </span>
          ) : (
            <span className="pill pill-warning">Not yet</span>
          )}
        </li>
        <li>
          Seller&apos;s representative:{" "}
          {conf.seller ? (
            <span className="pill pill-success">
              Confirmed {formatDay(conf.seller.confirmedAt)}
            </span>
          ) : (
            <span className="pill pill-warning">Not yet</span>
          )}
        </li>
      </ul>
      {caps.prepareStatement && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const id = Number(confParty);
            if (
              !Number.isInteger(id) ||
              id <= 0 ||
              !confNote.trim() ||
              !confDate
            )
              return;
            props.onRecordConfirmation({
              side: confSide,
              representativePartyId: id,
              evidenceNote: confNote.trim(),
              confirmedAt: new Date(confDate).toISOString(),
            });
          }}
        >
          <label>
            Side
            <select
              value={confSide}
              onChange={(e) =>
                setConfSide(e.target.value as "BUYER" | "SELLER")
              }
            >
              <option value="BUYER">Buyer</option>
              <option value="SELLER">Seller</option>
            </select>
          </label>
          <label>
            Representative (party no.)
            <input
              inputMode="numeric"
              value={confParty}
              onChange={(e) => setConfParty(e.target.value)}
            />
          </label>
          <label>
            Written confirmation note
            <input
              value={confNote}
              onChange={(e) => setConfNote(e.target.value)}
            />
          </label>
          <label>
            Confirmed on
            <input
              type="date"
              value={confDate}
              onChange={(e) => setConfDate(e.target.value)}
            />
          </label>
          <button
            className="btn btn-secondary btn-small"
            type="submit"
            disabled={busy}
          >
            Record confirmation
          </button>
        </form>
      )}

      <h3>Statement</h3>
      {!current && <p className="muted">No statement has been prepared yet.</p>}
      {current && (
        <div className="stack">
          <p>
            Version {current.version}{" "}
            <span className={statementStatusPill(current.status)}>
              {statementStatusLabel(current.status)}
            </span>
            {current.issuedAt && (
              <span className="muted">
                {" "}
                · issued {formatDay(current.issuedAt)}
              </span>
            )}
            <span className="muted">
              {" "}
              · payer:{" "}
              {current.payerType === "Brokerage" ? "Brokerage" : "Agent"}
            </span>
          </p>
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Item</th>
                  <th>Credit/Debit</th>
                  <th>Amount (inc. GST)</th>
                </tr>
              </thead>
              <tbody>
                {current.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.lineNo}</td>
                    <td>{l.description}</td>
                    <td>{l.effect === "CREDIT" ? "Credit" : "Debit"}</td>
                    <td>
                      {formatAud(l.amountCents + l.gstCents, current.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted">
            Credits {formatAud(current.creditsCents, current.currency)} · Debits{" "}
            {formatAud(current.debitsCents, current.currency)} · Net{" "}
            {formatAud(current.netCents, current.currency)}
          </p>
          {current.status === "ISSUED" && (
            <ReconciliationSection
              reconciliation={current.reconciliation}
              currency={current.currency}
            />
          )}
        </div>
      )}

      <div className="inline-form">
        {actions.prepare && (
          <>
            <label>
              Payer
              <select
                value={payerType}
                onChange={(e) =>
                  setPayerType(e.target.value as "Agent" | "Brokerage")
                }
              >
                <option value="Agent">Agent</option>
                <option value="Brokerage">Brokerage</option>
              </select>
            </label>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={busy}
              onClick={() => props.onPrepare({ payerType })}
            >
              {draft ? "Refresh draft" : "Prepare draft"}
            </button>
          </>
        )}
        {actions.issue && draft && (
          <button
            className="btn btn-primary"
            type="button"
            disabled={busy}
            onClick={() => props.onIssue(draft.id)}
          >
            Issue final statement
          </button>
        )}
        {issued && (
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => props.onPrint(issued.id)}
          >
            Print / save as PDF
          </button>
        )}
      </div>
      {actions.supersede && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (supersedeReason.trim())
              props.onPrepare({
                payerType: issued?.payerType ?? payerType,
                supersedeReason: supersedeReason.trim(),
              });
          }}
        >
          <label>
            Correct the issued statement (reason required)
            <input
              value={supersedeReason}
              onChange={(e) => setSupersedeReason(e.target.value)}
            />
          </label>
          <button
            className="btn btn-secondary btn-small"
            type="submit"
            disabled={busy || !supersedeReason.trim()}
          >
            Prepare correction
          </button>
        </form>
      )}
      {issued && !caps.supersedeStatement && (
        <p className="muted">
          Only a Brokerage Administrator can correct an issued statement.
        </p>
      )}

      {versions.length > 1 && (
        <details>
          <summary>Versions ({versions.length})</summary>
          <ul className="item-list">
            {versions.map((v) => (
              <li key={v.id}>
                v{v.version}{" "}
                <span className={statementStatusPill(v.status)}>
                  {statementStatusLabel(v.status)}
                </span>{" "}
                prepared {formatDay(v.preparedAt)}
                {v.issuedAt && ` · issued ${formatDay(v.issuedAt)}`}
                {v.supersedeReason && (
                  <span className="muted">
                    {" "}
                    · correction: {v.supersedeReason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** Printable statement including the reconciliation section (browser print → PDF). */
export function StatementPrintView({
  statement,
  onClose,
}: {
  statement: SettlementStatement;
  onClose?: () => void;
}) {
  const m = statementPrintModel(statement);
  return (
    <article className="legal-document" data-testid="statement-print">
      <h1>{m.title}</h1>
      <p>
        {m.status} · issued {m.issuedOn}
      </p>
      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Item</th>
              <th>Credit/Debit</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {m.lines.map((l) => (
              <tr key={l.no}>
                <td>{l.no}</td>
                <td>{l.description}</td>
                <td>{l.effect}</td>
                <td>{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Credits {m.totals.credits} · Debits {m.totals.debits} · Net{" "}
        {m.totals.net}
      </p>
      <h2>Payments and refunds</h2>
      {m.reconciliation ? (
        <>
          <p>
            {m.reconciliation.status} (as at {m.reconciliation.asOf})
          </p>
          {m.reconciliation.issues.map((i) => (
            <p key={i}>Review: {i}</p>
          ))}
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <table>
              <tbody>
                {m.reconciliation.entries.map((e) => (
                  <tr key={`${e.kind}-${e.receipt}`}>
                    <td>{e.receipt}</td>
                    <td>{e.kind}</td>
                    <td>{e.effect}</td>
                    <td>{e.amount}</td>
                    <td>{e.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            Itemised fee {m.reconciliation.totals.itemised} · Paid{" "}
            {m.reconciliation.totals.paid} · Refunded{" "}
            {m.reconciliation.totals.refunded} · Net{" "}
            {m.reconciliation.totals.net} · Balance{" "}
            {m.reconciliation.totals.balance}
          </p>
        </>
      ) : (
        <p>Not applicable (statement not issued).</p>
      )}
      {onClose && (
        <p className="no-print">
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Close print view
          </button>
        </p>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Read-only payment authority.
export function AuthorityView({
  authority,
}: {
  authority: AuthoritySummary | undefined;
}) {
  if (!authority)
    return <p className="muted">No payment authority details available.</p>;
  const a = authority;
  return (
    <div className="stack" data-testid="authority-view">
      {a.status === "REPLACED" && (
        <p className="muted">Replaced by a newer version — shown as read-only history.</p>
      )}
      <h3>
        Payment authority v{a.version}{" "}
        <span
          className={
            a.status === "ACTIVE" ? "pill pill-success" : "pill pill-warning"
          }
        >
          {a.status}
        </span>
      </h3>
      <dl className="cost-summary">
        <dt>Payer</dt>
        <dd>{a.payerType}</dd>
        <dt>Method</dt>
        <dd>{methodText(a.authorisedPaymentMethod)}</dd>
        <dt>Fee</dt>
        <dd>
          {a.rateBps != null
            ? `${(a.rateBps / 100).toFixed(2)}% of GCI`
            : formatAud(a.fixedAmountCents)}
          {a.gstApplicable ? " + GST" : ""}
        </dd>
        <dt>Cap</dt>
        <dd>{formatAud(a.maximumAmountCents)}</dd>
        <dt>Notice</dt>
        <dd>{a.noticeRequiredDays} days</dd>
        <dt>Agreement terms</dt>
        <dd>{a.agreementTermsVersion ?? "Not versioned (notice applies)"}</dd>
        <dt>Mandate terms</dt>
        <dd>{a.mandateTermsVersion ?? "Not versioned (notice applies)"}</dd>
        <dt>Effective</dt>
        <dd>{formatDay(a.effectiveDate)}</dd>
        <dt>Signed evidence on file</dt>
        <dd>{a.hasSignedEvidence ? "Yes" : "No"}</dd>
        {a.payerType === "Brokerage" && (
          <>
            <dt>Brokerage approval</dt>
            <dd>{a.brokerageCardApproved ? "Approved" : "Not approved"}</dd>
          </>
        )}
      </dl>
      <p className="muted">
        Read only. Changes to an authority are made by a Brokerage Administrator
        as a new version.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pit Crew service fee panel: timing, collect, status.
export function ServiceFeePanelView({
  caps,
  data,
  busy,
  error,
  lastOutcome,
  onCollect,
}: {
  caps: RunFinancialCapabilities;
  data: ServiceFeeResponse | undefined;
  busy?: boolean;
  error?: string | null;
  lastOutcome?: string | null;
  onCollect: () => void;
}) {
  if (!caps.viewServiceFee) return null;
  return (
    <section className="card" aria-labelledby="run-service-fee-heading">
      <div className="eyebrow">AE Pit Crew</div>
      <h2 id="run-service-fee-heading">Pit Crew service fee</h2>
      <p className="muted">{DEMO_NOTICE}</p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <p>
            Status:{" "}
            <span className="pill">
              {data.serviceFee.status.replaceAll("_", " ").toLowerCase()}
            </span>{" "}
            ·{" "}
            {formatAud(data.serviceFee.totalFeeCents, data.serviceFee.currency)}{" "}
            ({formatAud(data.serviceFee.grossFeeCents)} + GST{" "}
            {formatAud(data.serviceFee.gstCents)})
          </p>
          <p>Timing: {timingText(data.serviceFee.collectionTiming)}</p>
          {data.serviceFee.noticeElapsesAt &&
            data.serviceFee.collectionTiming.rule === "NOTICE_PERIOD" && (
              <p className="muted">
                Notice ends {formatDay(data.serviceFee.noticeElapsesAt)}
              </p>
            )}
          <RetryStatusView retry={data.serviceFee.retry} />
          {data.serviceFee.paidAt && (
            <p className="text-success">
              Paid {formatDay(data.serviceFee.paidAt)}
            </p>
          )}
          <p className="muted">
            Method: {methodText(data.serviceFee.paymentMethod.type)}
            {data.serviceFee.paymentMethod.label
              ? ` (${data.serviceFee.paymentMethod.label})`
              : ""}
          </p>
          {!data.settlementStatement.issued && (
            <p className="pill pill-warning">
              {statementGateText(data.settlementStatement.code)}
            </p>
          )}
          {caps.collectServiceFee && (
            <button
              className="btn btn-primary"
              type="button"
              disabled={busy || !data.collectable}
              onClick={onCollect}
            >
              Collect service fee
            </button>
          )}
          {caps.collectServiceFee && !data.collectable && (
            <p className="muted">
              Collection is not available yet; every check is made again when
              you collect.
            </p>
          )}
          {lastOutcome && (
            <p className="muted">
              Last result: {lastOutcome.replaceAll("_", " ")}
            </p>
          )}
          <AuthorityView authority={data.serviceFee.authority} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Receipts list + PDF.
export function receiptPdfHref(id: number) {
  return `/api/financial/receipts/${id}/pdf`;
}
export function ReceiptsView({
  receipts,
  error,
}: {
  receipts: Receipt[] | undefined;
  error?: string | null;
}) {
  return (
    <section className="card" aria-labelledby="run-receipts-heading">
      <div className="eyebrow">Receipts</div>
      <h2 id="run-receipts-heading">Receipts</h2>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {!receipts && !error && <p className="muted">Loading…</p>}
      {receipts && receipts.length === 0 && (
        <p className="muted">No receipts yet.</p>
      )}
      {receipts && receipts.length > 0 && (
        <ul className="item-list">
          {receipts.map((r) => (
            <li key={r.id}>
              <strong>{r.receiptNumber}</strong> ·{" "}
              {r.kind.replaceAll("_", " ").toLowerCase()} ·{" "}
              {formatAud(r.amountCents, r.currency)} · {formatDay(r.issuedAt)}
              {r.paymentMethodLabel && (
                <span className="muted"> · {r.paymentMethodLabel}</span>
              )}
              {r.settlementStatement && (
                <span className="muted">
                  {" "}· Statement #{r.settlementStatement.id} v{r.settlementStatement.version}
                </span>
              )}
              {r.failureMessage && (
                <div className="error-text">
                  {r.failureMessage}
                  {r.retryScheduled ? " (retry scheduled)" : ""}
                </div>
              )}{" "}
              <a
                className="btn-link"
                href={receiptPdfHref(r.id)}
                target="_blank"
                rel="noreferrer"
              >
                Download PDF
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// BA: card charges queue (provider status, resolve, refund).
export function CardChargeRow({
  charge,
  status,
  busy,
  onCheckStatus,
  onResolve,
  onRefund,
}: {
  charge: CardCharge;
  status?: ProviderStatus | null;
  busy?: boolean;
  onCheckStatus: (id: number) => void;
  onResolve: (
    id: number,
    outcome: "SUCCEEDED" | "FAILED",
    ev: EvidenceInput,
  ) => void;
  onRefund: (
    id: number,
    input: { amountCents: number; requestKey: string } & EvidenceInput,
  ) => void;
}) {
  const [ev, setEv] = useState<EvidenceInput>({ reason: "", evidenceNote: "" });
  const [amount, setAmount] = useState("");
  const [requestKey] = useState(() => newRefundRequestKey());
  const cents = Math.round(Number(amount) * 100);
  return (
    <li>
      <strong>Charge #{charge.id}</strong> · attempt {charge.attemptNo} ·{" "}
      <span
        className={
          charge.status === "UNKNOWN"
            ? "pill pill-danger"
            : charge.status === "SUCCEEDED"
              ? "pill pill-success"
              : "pill"
        }
      >
        {charge.status}
      </span>{" "}
      · {formatAud(charge.amountCents, charge.currency)} · {charge.trigger}
      {charge.status === "UNKNOWN" && (
        <div className="stack">
          <button
            className="btn btn-small btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => onCheckStatus(charge.id)}
          >
            Check provider status
          </button>
          {status && (
            <p className="muted">
              Provider says: {status.providerStatus ?? "unavailable"}
              {status.suggestedOutcome
                ? ` → resolve as ${status.suggestedOutcome}`
                : " → cannot be resolved yet"}
              {!status.callerMayResolve &&
                " · you started this charge, so another Brokerage Administrator must resolve it"}
            </p>
          )}
          <div className="inline-form">
            <EvidenceFields
              value={ev}
              onChange={setEv}
              idPrefix={`charge-${charge.id}`}
            />
            {(["SUCCEEDED", "FAILED"] as const).map((o) => (
              <button
                key={o}
                className="btn btn-small"
                type="button"
                disabled={
                  busy ||
                  !evidenceReady(ev) ||
                  !status ||
                  status.suggestedOutcome !== o ||
                  !status.callerMayResolve
                }
                onClick={() => onResolve(charge.id, o, ev)}
              >
                Resolve as {o === "SUCCEEDED" ? "charged" : "not charged"}
              </button>
            ))}
          </div>
        </div>
      )}
      {charge.status === "SUCCEEDED" && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (cents > 0 && evidenceReady(ev))
              onRefund(charge.id, { amountCents: cents, requestKey, ...ev });
          }}
        >
          <label>
            Refund amount ($, back to the original card only)
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <EvidenceFields
            value={ev}
            onChange={setEv}
            idPrefix={`refund-${charge.id}`}
          />
          <button
            className="btn btn-small btn-danger"
            type="submit"
            disabled={
              busy ||
              !(cents > 0) ||
              cents > charge.amountCents ||
              !evidenceReady(ev)
            }
          >
            Refund
          </button>
        </form>
      )}
    </li>
  );
}

export function CardRefundRow({
  refund,
  status,
  busy,
  onCheckStatus,
  onResolve,
}: {
  refund: CardRefund;
  status?: ProviderStatus | null;
  busy?: boolean;
  onCheckStatus: (id: number) => void;
  onResolve: (
    id: number,
    outcome: "SUCCEEDED" | "FAILED",
    ev: EvidenceInput,
  ) => void;
}) {
  const [ev, setEv] = useState<EvidenceInput>({ reason: "", evidenceNote: "" });
  return (
    <li>
      <strong>Refund #{refund.id}</strong> of charge #{refund.cardChargeId} ·{" "}
      <span
        className={refund.status === "UNKNOWN" ? "pill pill-danger" : "pill"}
      >
        {refund.status}
      </span>{" "}
      · {formatAud(refund.amountCents, refund.currency)}
      {(refund.status === "UNKNOWN" || refund.status === "PENDING") && (
        <div className="stack">
          <button
            className="btn btn-small btn-secondary"
            type="button"
            disabled={busy}
            onClick={() => onCheckStatus(refund.id)}
          >
            Check provider status
          </button>
          {status && (
            <p className="muted">
              {refund.status === "PENDING" && "Pending with no recorded outcome · "}
              Provider says: {status.providerStatus ?? "unavailable"}
              {status.suggestedOutcome
                ? ` → resolve as ${status.suggestedOutcome}`
                : " → no definite answer; the amount stays reserved"}
              {!status.callerMayResolve &&
                " · you requested this refund, so another Brokerage Administrator must resolve it"}
            </p>
          )}
          <div className="inline-form">
            <EvidenceFields
              value={ev}
              onChange={setEv}
              idPrefix={`cardrefund-${refund.id}`}
            />
            {(["SUCCEEDED", "FAILED"] as const).map((o) => (
              <button
                key={o}
                className="btn btn-small"
                type="button"
                disabled={
                  busy ||
                  !evidenceReady(ev) ||
                  !status ||
                  status.suggestedOutcome !== o ||
                  !status.callerMayResolve
                }
                onClick={() => onResolve(refund.id, o, ev)}
              >
                Resolve as {o === "SUCCEEDED" ? "refunded" : "not refunded"}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// BA: waive / write-off / dispute resolution for one payment request.
export function RecoveryActionsView({
  paymentRequestId,
  status,
  busy,
  onAction,
}: {
  paymentRequestId: number;
  status: string;
  busy?: boolean;
  onAction: (
    id: number,
    action: "waive" | "write-off" | "resolve-dispute",
    input: EvidenceInput & { outcome?: "PAYABLE" | "WAIVED" | "WRITTEN_OFF" },
  ) => void;
}) {
  const allowed = recoveryActionsFor(status);
  const [ev, setEv] = useState<EvidenceInput>({ reason: "", evidenceNote: "" });
  const [outcome, setOutcome] = useState<"PAYABLE" | "WAIVED" | "WRITTEN_OFF">(
    "PAYABLE",
  );
  if (!allowed.waive && !allowed.writeOff && !allowed.resolveDispute)
    return null;
  const ready = evidenceReady(ev) && !busy;
  return (
    <div className="inline-form" data-testid={`recovery-${paymentRequestId}`}>
      <EvidenceFields
        value={ev}
        onChange={setEv}
        idPrefix={`recovery-${paymentRequestId}`}
      />
      {allowed.waive && (
        <button
          className="btn btn-small"
          type="button"
          disabled={!ready}
          onClick={() => onAction(paymentRequestId, "waive", ev)}
        >
          Waive
        </button>
      )}
      {allowed.writeOff && (
        <button
          className="btn btn-small"
          type="button"
          disabled={!ready}
          onClick={() => onAction(paymentRequestId, "write-off", ev)}
        >
          Write off
        </button>
      )}
      {allowed.resolveDispute && (
        <>
          <select
            aria-label="Dispute outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          >
            <option value="PAYABLE">Payable</option>
            <option value="WAIVED">Waived</option>
            <option value="WRITTEN_OFF">Written off</option>
          </select>
          <button
            className="btn btn-small"
            type="button"
            disabled={!ready}
            onClick={() =>
              onAction(paymentRequestId, "resolve-dispute", { ...ev, outcome })
            }
          >
            Resolve dispute
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// #245 S6 screens (existing role gates; mock/read states; nothing sends here).

export function RetryStatusView({ retry }: { retry: RetryState | null | undefined }) {
  if (!retry) return null;
  return (
    <p className="muted" data-testid="retry-status">
      Attempt {retry.attempts} of {retry.maxAttempts}
      {retry.nextAttemptAt ? ` · next attempt ${formatAestTime(retry.nextAttemptAt)}` : " · no further automatic attempts"}
    </p>
  );
}

export function AdjustmentRecordsView({ records, error }: { records: AdjustmentRecord[] | undefined; error?: string | null }) {
  return (
    <div className="stack" data-testid="adjustment-records">
      <h3>Waivers and write-offs</h3>
      <p className="muted">Adjustment records are not a receipt; no payment was taken.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!records && !error && <p className="muted">Loading…</p>}
      {records && records.length === 0 && <p className="muted">No waivers or write-offs.</p>}
      {records && records.length > 0 && (
        <ul className="item-list">
          {records.map((r) => (
            <li key={r.recordNumber}>
              <strong>{r.recordNumber}</strong> · {r.kind === "WAIVER" ? "Waiver" : "Write-off"} · {formatAud(r.amountCents, r.currency)} · {formatDay(r.approval.approvedAt)}
              {r.settlementStatementId != null && (
                <span className="muted"> · Statement #{r.settlementStatementId} v{r.settlementStatementVersion}</span>
              )}
              <div className="muted">{r.reason}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HeldDebitsView({
  held,
  onResolve,
  busy,
  error,
}: {
  held: HeldDebit[] | undefined;
  onResolve: (outboxEntryId: number, body: { outcome: HeldResolveOutcome; reason: string }) => void;
  busy: boolean;
  error?: string | null;
}) {
  return (
    <div className="stack" data-testid="held-debits">
      <h3>Held debits (needs review)</h3>
      <p className="muted">
        The provider outcome was uncertain, so these are never resent automatically. Check the provider, then record what happened.
        Another Brokerage Administrator must resolve a debit you raised.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!held && !error && <p className="muted">Loading…</p>}
      {held && held.length === 0 && <p className="muted">No held debits.</p>}
      {held && held.length > 0 && (
        <ul className="item-list">
          {held.map((h) => (
            <HeldDebitRow key={h.outboxEntryId} entry={h} onResolve={onResolve} busy={busy} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HeldDebitRow({ entry, onResolve, busy }: { entry: HeldDebit; onResolve: (id: number, body: { outcome: HeldResolveOutcome; reason: string }) => void; busy: boolean }) {
  const [outcome, setOutcome] = useState<HeldResolveOutcome>("SCHEDULED");
  const [reason, setReason] = useState("");
  const body = heldResolveBody(outcome, reason);
  return (
    <li>
      <strong>Payment request #{entry.paymentRequestId}</strong> · held {formatAestTime(entry.heldAt)} · attempts {entry.attempts}
      <div className="error-text">{entry.reason}</div>
      <label>
        Provider outcome{" "}
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as HeldResolveOutcome)} disabled={busy}>
          <option value="SCHEDULED">Scheduled at provider</option>
          <option value="FAILED">Failed / not at provider</option>
        </select>
      </label>
      <label>
        Reason (required){" "}
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} disabled={busy} />
      </label>
      <button type="button" className="btn" disabled={busy || !body} onClick={() => body && onResolve(entry.outboxEntryId, body)}>
        Resolve
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Owner t212u screens (BA only via existing role gate).

export function ReconciliationExceptionsView({
  exceptions,
  busy,
  error,
  onResolve,
}: {
  exceptions: ReconciliationException[] | undefined;
  busy: boolean;
  error?: string | null;
  onResolve: (id: number, body: { refundAssessment: string; reason: string }) => void;
}) {
  return (
    <div className="stack" data-testid="recon-exceptions">
      <h3>Reconciliation exceptions (needs review)</h3>
      <p className="muted">
        The provider reported something AE could not apply to a locked record, or did not confirm a cancellation. The provider event is kept and the
        locked records were not changed. Record a refund assessment; any refund is a separate, approved action.
      </p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!exceptions && !error && <p className="muted">Loading…</p>}
      {exceptions && exceptions.length === 0 && <p className="muted">No reconciliation exceptions.</p>}
      {exceptions && exceptions.length > 0 && (
        <ul className="item-list">
          {exceptions.map((e) => (
            <ReconExceptionRow key={e.id} exception={e} busy={busy} onResolve={onResolve} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReconExceptionRow({ exception: e, busy, onResolve }: { exception: ReconciliationException; busy: boolean; onResolve: (id: number, body: { refundAssessment: string; reason: string }) => void }) {
  const [assessment, setAssessment] = useState(e.kind === "CANCELLATION_UNCONFIRMED" ? "NOT_APPLICABLE" : "");
  const [reason, setReason] = useState("");
  const body = reconResolveBody(assessment, reason);
  return (
    <li data-testid={`recon-exception-${e.id}`}>
      <strong>{RECON_KIND_LABEL[e.kind] ?? e.kind}</strong> · payment request #{e.paymentRequestId} · {formatAud(e.amountCents)} · {e.source.toLowerCase()} ·{" "}
      {formatAestTime(e.createdAt)} · <span className={e.status === "OPEN" ? "error-text" : "muted"}>{e.status === "OPEN" ? "Open" : "Resolved"}</span>
      {e.status !== "OPEN" && (
        <div className="muted">
          {REFUND_ASSESSMENT_LABEL[e.refundAssessment ?? ""] ?? e.refundAssessment} · {e.resolutionReason}
        </div>
      )}
      {e.status === "OPEN" && (
        <div className="inline-form">
          <label>
            Refund assessment{" "}
            <select value={assessment} onChange={(ev) => setAssessment(ev.target.value)} disabled={busy}>
              <option value="">Choose…</option>
              {Object.entries(REFUND_ASSESSMENT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reason (required) <input value={reason} onChange={(ev) => setReason(ev.target.value)} maxLength={2000} disabled={busy} />
          </label>
          <button type="button" className="btn btn-small" disabled={busy || !body} onClick={() => body && onResolve(e.id, body)}>
            Resolve
          </button>
        </div>
      )}
    </li>
  );
}

export function CorrectionsView({
  corrections,
  busy,
  error,
  message,
  onSubmit,
}: {
  corrections: CorrectionRecord[] | undefined;
  busy: boolean;
  error?: string | null;
  message?: string | null;
  onSubmit: (body: NonNullable<ReturnType<typeof correctionBody>>) => void;
}) {
  const [f, setF] = useState({ table: CORRECTABLE_TABLES[0] as string, id: "", column: "", value: "", reason: "", evidenceRef: "", fileName: "", sha256: "", sizeBytes: "" });
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF((x) => ({ ...x, [k]: ev.target.value }));
  const upload = f.fileName || f.sha256 || f.sizeBytes ? { fileName: f.fileName, sha256: f.sha256.trim().toLowerCase(), sizeBytes: Number(f.sizeBytes) } : null;
  const body = correctionBody({ table: f.table, id: f.id, column: f.column, value: f.value, reason: f.reason, evidenceRef: f.evidenceRef, upload });
  return (
    <div className="stack" data-testid="corrections">
      <h3>Correct a locked financial record</h3>
      <p className="muted">
        Ledger events, issued statements, receipts, active authority terms and waiver/write-off records are locked. A correction needs a reason and
        supporting evidence, and is written to the audit trail with the before and after values.
      </p>
      <div className="inline-form">
        <label>
          Record type{" "}
          <select value={f.table} onChange={set("table")} disabled={busy}>
            {CORRECTABLE_TABLES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Record id <input value={f.id} onChange={set("id")} inputMode="numeric" disabled={busy} />
        </label>
        <label>
          Field <input value={f.column} onChange={set("column")} disabled={busy} />
        </label>
        <label>
          New value <input value={f.value} onChange={set("value")} disabled={busy} />
        </label>
        <label>
          Reason (required) <input value={f.reason} onChange={set("reason")} maxLength={2000} disabled={busy} />
        </label>
        <label>
          Evidence reference <input value={f.evidenceRef} onChange={set("evidenceRef")} maxLength={500} disabled={busy} />
        </label>
        <span className="muted">or upload metadata:</span>
        <label>
          File name <input value={f.fileName} onChange={set("fileName")} disabled={busy} />
        </label>
        <label>
          sha256 <input value={f.sha256} onChange={set("sha256")} maxLength={64} disabled={busy} />
        </label>
        <label>
          Size (bytes) <input value={f.sizeBytes} onChange={set("sizeBytes")} inputMode="numeric" disabled={busy} />
        </label>
        <button type="button" className="btn btn-small" disabled={busy || !body} onClick={() => body && onSubmit(body)}>
          Record correction
        </button>
      </div>
      {message && <p className="muted">{message}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      {!corrections && !error && <p className="muted">Loading…</p>}
      {corrections && corrections.length === 0 && <p className="muted">No corrections recorded.</p>}
      {corrections && corrections.length > 0 && (
        <ul className="item-list">
          {corrections.map((c) => (
            <li key={c.auditId}>
              <strong>Audit #{c.auditId}</strong> · {c.table} #{c.recordId} · {formatAestTime(c.correctedAt)}
              <div className="muted">
                {Object.keys(c.patch ?? {}).map((k) => `${k}: ${JSON.stringify(c.before?.[k])} → ${JSON.stringify(c.patch[k])}`).join("; ")}
              </div>
              <div className="muted">
                {c.reason} · evidence:{" "}
                {c.evidence?.kind === "reference" ? c.evidence.ref : c.evidence ? `${c.evidence.fileName} (sha256 ${c.evidence.sha256?.slice(0, 12)}…, ${c.evidence.sizeBytes} bytes)` : "—"}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
