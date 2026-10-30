// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage G,
// Section 29: the Brokerage Financial Operations queue.
//
// A cross-property operational view, same reasoning pages/Exceptions.tsx's
// own header comment gives for why /exceptions is a separate top-level
// route rather than something tucked inside a single property's workspace:
// "what needs attention across every property" cannot live on one
// property's page. This is the financial-specific counterpart — three
// brokerage-wide feeds in one place: open FINANCIAL-category exceptions
// (reusing GET /exceptions?category=FINANCIAL exactly as that route's own
// comment anticipates — "a foundation for... the future Agent Daily
// Command Centre / Brokerage Dashboard"), the payment-request queue
// (Sections 14-16), and annual audit-return reminders (Section 23).
//
// EVERY route this page calls is Brokerage Administrator only
// (routes/financial.ts's own header comment). Unlike Exceptions.tsx —
// where every agent sees their own properties' exceptions and only the
// ops-health panel is admin-only — this entire page is financial data, so
// the whole page self-gates on role rather than gating one panel within
// it. That gate is a UX nicety only: the API's own
// requireRole(...BROKERAGE_ADMIN_ROLES) on every route below is the real
// boundary, independent of anything rendered here.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch, apiErrorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import {
  type CrossPropertyExceptionsResponse,
  OPEN_EXCEPTION_STATUSES,
  severityLabel,
  severityPillClass,
  statusLabel,
  formatDueDate,
  isOverdue,
} from "../lib/riskExceptions";
import {
  PAYMENT_REQUEST_STATUSES,
  auditReturnStatusLabel,
  auditReturnStatusPillClass,
  fetchAuditReturnReminders,
  fetchPaymentRequests,
  formatCents,
  formatDate,
  paymentRequestStatusLabel,
  paymentRequestStatusPillClass,
} from "../lib/financial";
import { BaPaymentQueues, BaReconciliationAndCorrections, PaymentRequestRecovery } from "./runFinancial/containers";

export default function FinancialOperations() {
  const { user, isLoading: sessionLoading } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";

  if (sessionLoading) {
    return <p className="muted">Loading…</p>;
  }

  if (!isAdmin) {
    return (
      <div className="primary-action">
        <div className="eyebrow">Financial Operations</div>
        <h1>Not available</h1>
        <p className="muted">Financial operations data is only visible to Brokerage Administrators.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="primary-action">
        <div className="eyebrow">Financial Operations</div>
        <h1>Financial Operations</h1>
        <p className="muted">
          Commission and PC success-fee exceptions, the payment-request queue, and audit-return reminders across every
          property — a foundation for the Command Centre, not the Command Centre itself.
        </p>
      </div>

      <FinancialExceptionsPanel />
      <PaymentRequestsPanel />
      {/* Owner t181u phase 2b item 6: BA card charge/refund queues (mock provider). */}
      <BaPaymentQueues role={user?.role} />
      {/* Owner t212u: reconciliation exceptions + audited corrections (BA only). */}
      <BaReconciliationAndCorrections role={user?.role} />
      <AuditReturnRemindersPanel />
    </div>
  );
}

const SEVERITY_OPTIONS = ["CRITICAL", "AT_RISK", "ATTENTION", "INFORMATION"];
const PAGE_SIZE = 25;

function FinancialExceptionsPanel() {
  const [severity, setSeverity] = useState("");
  const [openOnly, setOpenOnly] = useState(true);
  const [offset, setOffset] = useState(0);

  const params = new URLSearchParams();
  params.set("category", "FINANCIAL");
  if (severity) params.set("severity", severity);
  if (openOnly) params.set("status", OPEN_EXCEPTION_STATUSES.join(","));
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  const queryString = params.toString();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["financial-exceptions", queryString],
    queryFn: () => apiFetch<CrossPropertyExceptionsResponse>(`/exceptions?${queryString}`),
  });

  const updateFilter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <section className="card">
      <h2>Financial Exceptions{typeof data?.total === "number" ? ` (${data.total})` : ""}</h2>
      <div className="inline-form">
        <label>
          Severity
          <select value={severity} onChange={(e) => updateFilter(() => setSeverity(e.target.value))}>
            <option value="">All</option>
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {severityLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => updateFilter(() => setOpenOnly(e.target.checked))}
            style={{ display: "inline", width: "auto", marginRight: "0.4rem" }}
          />
          Open only
        </label>
      </div>

      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load financial exceptions. Try again.")}</p>}
      {!isLoading && !isError && (data?.exceptions.length ?? 0) === 0 && <p className="muted">No financial exceptions match these filters.</p>}
      {!isLoading && !isError && (data?.exceptions.length ?? 0) > 0 && (
        <>
          <ul className="item-list">
            {data!.exceptions.map((e) => (
              <li key={e.id}>
                <Link href={`/properties/${e.propertyId}`}>
                  <span className={severityPillClass(e.severity)}>{severityLabel(e.severity)}</span>{" "}
                  <strong>{e.title}</strong> — {e.propertyAddress ?? `Property #${e.propertyId}`}
                </Link>
                <div className="muted">
                  {statusLabel(e.status)}
                  {e.ownerName ? ` · ${e.ownerName}` : ""}
                  {e.dueAt && (
                    <>
                      {" · "}
                      {isOverdue(e.dueAt) ? "overdue " : "due "}
                      {formatDueDate(e.dueAt)}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div className="inline-form" style={{ marginTop: "0.75rem" }}>
            <button className="btn btn-small" onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}>
              Previous
            </button>
            <span className="muted">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, data!.total)} of {data!.total}
            </span>
            <button className="btn btn-small" onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= data!.total}>
              Next
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function PaymentRequestsPanel() {
  const [status, setStatus] = useState("");

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["financial-payment-requests", status],
    queryFn: () => fetchPaymentRequests(status ? { status } : undefined),
  });

  const requests = data?.paymentRequests ?? [];

  return (
    <section className="card">
      <h2>Payment Requests{requests.length > 0 ? ` (${requests.length})` : ""}</h2>
      <div className="inline-form">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {PAYMENT_REQUEST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {paymentRequestStatusLabel(s)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load payment requests. Try again.")}</p>}
      {!isLoading && !isError && requests.length === 0 && <p className="muted">No payment requests match this filter.</p>}
      {!isLoading && !isError && requests.length > 0 && (
        <ul className="item-list">
          {requests.map((pr) => (
            <li key={pr.id}>
              <Link href={`/properties/${pr.propertyId}`}>
                <span className={paymentRequestStatusPillClass(pr.status)}>{paymentRequestStatusLabel(pr.status)}</span>{" "}
                <strong>{pr.kind.replaceAll("_", " ").toLowerCase()}</strong> — {formatCents(pr.amountCents, pr.currency)} —{" "}
                {`Property #${pr.propertyId}`}
              </Link>
              <div className="muted">
                {pr.noticeSentAt && `Notice sent ${formatDate(pr.noticeSentAt)}`}
                {pr.paidAt && `${pr.noticeSentAt ? " · " : ""}Paid ${formatDate(pr.paidAt)}`}
                {pr.failureReason && <span className="error-text">{" · "}{pr.failureReason}</span>}
              </div>
              {pr.kind === "PC_SUCCESS_FEE" && <PaymentRequestRecovery role="Brokerage Administrator" paymentRequestId={pr.id} status={pr.status} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AuditReturnRemindersPanel() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["audit-return-reminders"],
    queryFn: () => fetchAuditReturnReminders(),
  });

  const reminders = data?.reminders ?? [];

  return (
    <section className="card">
      <h2>Audit Return Reminders{reminders.length > 0 ? ` (${reminders.length})` : ""}</h2>
      {isLoading && <p className="muted">Loading…</p>}
      {isError && <p className="error-text">{apiErrorMessage(error, "Couldn't load audit return reminders. Try again.")}</p>}
      {!isLoading && !isError && reminders.length === 0 && <p className="muted">No audit return reminders scheduled.</p>}
      {!isLoading && !isError && reminders.length > 0 && (
        <ul className="item-list">
          {reminders.map((r) => (
            <li key={r.id}>
              <span className={auditReturnStatusPillClass(r.status)}>{auditReturnStatusLabel(r.status)}</span>{" "}
              <strong>{r.jurisdiction}</strong>
              {r.reportingEntityName && ` · ${r.reportingEntityName}`} — due {formatDate(r.dueDate)}
              <div className="muted">
                Period {formatDate(r.reportingPeriodStart)} – {formatDate(r.reportingPeriodEnd)}
                {r.submittedAt && ` · submitted ${formatDate(r.submittedAt)}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
