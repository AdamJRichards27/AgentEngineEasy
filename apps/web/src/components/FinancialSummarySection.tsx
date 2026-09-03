// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage G,
// Section 28: the Property Financial Summary.
//
// Self-contained (owns its own data fetching) so it drops into the
// Property Workspace without adding more state to that already-large
// component — mirrors components/CommunicationsSection.tsx's own header
// comment exactly. Rendered as a native progressive-disclosure <details>
// element, tucked in alongside the other "detail, not the primary
// action" sections further down PropertyWorkspace.tsx (Appraisal,
// Listing details, Documents & Agency Agreement, Payment methods &
// service charges) — same convention, not a plain <section className="card">.
//
// EVERY financial route is Brokerage Administrator only (routes/
// financial.ts's own header comment). Unlike Communications — which every
// signed-in user on the property sees — this component must self-gate on
// role, because PropertyWorkspace.tsx itself has no role awareness today
// (it never imports useSession). Gating here is a UX nicety only, exactly
// like canSeePitCrew in App.tsx: the real boundary is the API's own
// requireRole(...BROKERAGE_ADMIN_ROLES) on every route this component
// calls, which 403s an unauthorised request independently of anything
// rendered (or not rendered) client-side.
//
// Financial Transaction Engine Verification (Step 2), COHERENCE-001
// remediation: the Commission Agreement / Commission Calculation
// subsections below now render a `legacyCommission` branch (see
// lib/financial.ts's LegacyCommissionSummary) instead of a bare "No
// commission agreement/calculation recorded yet." whenever the API
// reports a pre-existing legacy commission figure for this property with
// no Financial Engine agreement to explain it — the exact contradiction
// the audit found (a real commission amount in the legacy Transaction
// section next to "no commission" here). That branch never invents an
// agreement or a calculation; it labels the legacy figure by its source
// and offers the single authorised next step ("Flag for Reconciliation").
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ApiError } from "../lib/api";
import { useSession } from "../lib/session";
import {
  approveCommissionAgreement,
  commissionAgreementStatusLabel,
  commissionAgreementStatusPillClass,
  depositStatusLabel,
  depositStatusPillClass,
  fetchPropertyFinancialSummary,
  flagLegacyCommissionForReconciliation,
  formatBps,
  formatCents,
  formatDate,
  paymentRequestStatusLabel,
  paymentRequestStatusPillClass,
  snapshotStateLabel,
  snapshotStatePillClass,
  type LegacyCommissionSummary,
  type PropertyFinancialSummaryResponse,
} from "../lib/financial";

export function FinancialSummarySection({ propertyId }: { propertyId: number }) {
  const { user } = useSession();
  const isAdmin = user?.role === "Brokerage Administrator";

  // Section 33 sensitive-data protection: don't even issue the request
  // for a role that the API would 403 anyway — same "no point asking"
  // reasoning as everywhere else financial data is gated.
  const { data, isLoading, isError } = useQuery({
    queryKey: ["financial-summary", propertyId],
    queryFn: () => fetchPropertyFinancialSummary(propertyId),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  return (
    <details className="section">
      <summary>Financial Summary</summary>

      {isLoading ? (
        <p className="muted">Loading financial summary…</p>
      ) : isError || !data ? (
        <p className="error-text">Couldn't load the financial summary for this property.</p>
      ) : (
        <FinancialSummaryBody propertyId={propertyId} summary={data} />
      )}

      <p className="muted" style={{ marginTop: "0.75rem" }}>
        <Link href="/financial">View the full Brokerage Financial Operations queue →</Link>
      </p>
    </details>
  );
}

function FinancialSummaryBody({
  propertyId,
  summary,
}: {
  propertyId: number;
  summary: PropertyFinancialSummaryResponse;
}) {
  const queryClient = useQueryClient();
  const [approveError, setApproveError] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["financial-summary", propertyId] });

  const approveMut = useMutation({
    mutationFn: (agreementId: number) => approveCommissionAgreement(agreementId),
    onSuccess: () => {
      setApproveError(null);
      invalidate();
    },
    onError: (err: unknown) => setApproveError(err instanceof ApiError ? err.friendly : "Couldn't approve this agreement."),
  });

  const flagMut = useMutation({
    mutationFn: (transactionId: number) => flagLegacyCommissionForReconciliation(transactionId),
    onSuccess: () => {
      setFlagError(null);
      invalidate();
    },
    onError: (err: unknown) => setFlagError(err instanceof ApiError ? err.friendly : "Couldn't flag this commission for reconciliation."),
  });

  const { currentCommissionAgreement, latestCommissionCalculation, latestPcFeeCalculation, paymentRequests, deposit, legacyCommission } = summary;

  return (
    <div className="stack">
      <div>
        <h3>Commission Agreement</h3>
        {currentCommissionAgreement ? (
          <>
            <p>
              <span className={commissionAgreementStatusPillClass(currentCommissionAgreement.status)}>
                {commissionAgreementStatusLabel(currentCommissionAgreement.status)}
              </span>{" "}
              v{currentCommissionAgreement.version} · {currentCommissionAgreement.method.replaceAll("_", " ").toLowerCase()}
              {currentCommissionAgreement.rateBps != null && ` · ${formatBps(currentCommissionAgreement.rateBps)}`}
              {currentCommissionAgreement.fixedAmountCents != null && ` · ${formatCents(currentCommissionAgreement.fixedAmountCents)}`}
            </p>
            <p className="muted">
              GST {currentCommissionAgreement.gstApplicable ? `applicable (${formatBps(currentCommissionAgreement.gstRateBps)})` : "not applicable"}
              {currentCommissionAgreement.approvedAt && ` · approved ${formatDate(currentCommissionAgreement.approvedAt)}`}
            </p>
            {currentCommissionAgreement.status === "AWAITING_APPROVAL" && (
              <>
                <button
                  className="btn btn-primary btn-small"
                  disabled={approveMut.isPending}
                  onClick={() => approveMut.mutate(currentCommissionAgreement.id)}
                >
                  Approve Agreement
                </button>
                {approveError && <p className="error-text">{approveError}</p>}
              </>
            )}
          </>
        ) : legacyCommission ? (
          <LegacyCommissionCard
            legacyCommission={legacyCommission}
            isPending={flagMut.isPending}
            error={flagError}
            onFlag={() => flagMut.mutate(legacyCommission.transactionId)}
          />
        ) : (
          <p className="muted">No commission agreement recorded yet.</p>
        )}
      </div>

      <div>
        <h3>Commission Calculation</h3>
        {latestCommissionCalculation ? (
          <>
            <p>
              <span className={snapshotStatePillClass(latestCommissionCalculation.state)}>{snapshotStateLabel(latestCommissionCalculation.state)}</span>{" "}
              Sale price {formatCents(latestCommissionCalculation.salePriceCentsInput)} → gross commission{" "}
              {formatCents(latestCommissionCalculation.grossCommissionCents)}
            </p>
            <p className="muted">
              Ex-GST {formatCents(latestCommissionCalculation.commissionExGstCents)} + GST {formatCents(latestCommissionCalculation.gstCents)}
              {latestCommissionCalculation.referralFeeCents > 0 && ` · referral fee ${formatCents(latestCommissionCalculation.referralFeeCents)}`}
              {latestCommissionCalculation.finalisedAt && ` · finalised ${formatDate(latestCommissionCalculation.finalisedAt)}`}
            </p>
          </>
        ) : legacyCommission ? (
          <p className="muted">
            No Financial Engine calculation exists for this property — see the legacy commission record above under Commission Agreement.
          </p>
        ) : (
          <p className="muted">No commission calculation recorded yet.</p>
        )}
      </div>

      <div>
        <h3>PC Success Fee</h3>
        {!latestPcFeeCalculation ? (
          <p className="muted">No PC success-fee calculation recorded yet.</p>
        ) : (
          <p>
            <span className={snapshotStatePillClass(latestPcFeeCalculation.state)}>{snapshotStateLabel(latestPcFeeCalculation.state)}</span>{" "}
            Total fee {formatCents(latestPcFeeCalculation.totalFeeCents)}
            {latestPcFeeCalculation.isDisputed && <span className="pill pill-danger" style={{ marginLeft: "0.4rem" }}>Disputed</span>}
            {latestPcFeeCalculation.isProvisional && !latestPcFeeCalculation.isDisputed && (
              <span className="muted"> (provisional)</span>
            )}
          </p>
        )}
      </div>

      <div>
        <h3>Payment Requests</h3>
        {paymentRequests.length === 0 ? (
          <p className="muted">No payment requests recorded yet.</p>
        ) : (
          <ul className="item-list">
            {paymentRequests.map((pr) => (
              <li key={pr.id}>
                <span className={paymentRequestStatusPillClass(pr.status)}>{paymentRequestStatusLabel(pr.status)}</span>{" "}
                {pr.kind.replaceAll("_", " ").toLowerCase()} — {formatCents(pr.amountCents, pr.currency)}
                {pr.paidAt && <span className="muted"> · paid {formatDate(pr.paidAt)}</span>}
                {pr.failureReason && <div className="error-text">{pr.failureReason}</div>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3>Deposit</h3>
        {!deposit ? (
          <p className="muted">No deposit recorded yet.</p>
        ) : (
          <p>
            <span className={depositStatusPillClass(deposit.status)}>{depositStatusLabel(deposit.status)}</span>{" "}
            {deposit.requiredAmountCents != null && `Required ${formatCents(deposit.requiredAmountCents)} · `}
            Reported received {formatCents(deposit.reportedReceivedAmountCents)}
            {deposit.externalHolderName && ` · held by ${deposit.externalHolderName}`}
          </p>
        )}
      </div>
    </div>
  );
}

// COHERENCE-001 remediation. Deliberately does not reuse the
// commissionAgreementStatusPillClass/-Label helpers — a legacy figure has
// no CommissionAgreementStatus at all (it is not DRAFT/AWAITING_APPROVAL/
// APPROVED/SUPERSEDED/CANCELLED, it is simply a number carried over from
// before the Financial Engine existed), so this renders its own
// unambiguous "Legacy" pill rather than forcing it into that vocabulary.
function LegacyCommissionCard({
  legacyCommission,
  isPending,
  error,
  onFlag,
}: {
  legacyCommission: LegacyCommissionSummary;
  isPending: boolean;
  error: string | null;
  onFlag: () => void;
}) {
  return (
    <div>
      <p>
        <span className="pill">Legacy · pre-Financial Engine</span>{" "}
        {formatCents(legacyCommission.grossCommissionCents)}
        {legacyCommission.gstCents != null && ` (incl. ${formatCents(legacyCommission.gstCents)} GST)`}
      </p>
      <p className="muted">
        Recorded on this property's transaction (status {legacyCommission.transactionStatus.toLowerCase()})
        {legacyCommission.commissionCalculatedAt && ` on ${formatDate(legacyCommission.commissionCalculatedAt)}`}. No Financial Engine commission
        agreement exists for this property — the original calculation method and rate were never captured, so none has been created or inferred here.
      </p>
      {legacyCommission.alreadyFlaggedForReconciliation ? (
        <p className="muted">Already flagged for reconciliation — see Financial Operations → Reconciliation.</p>
      ) : (
        <>
          <button className="btn btn-secondary btn-small" disabled={isPending} onClick={onFlag}>
            Flag for Reconciliation
          </button>
          {error && <p className="error-text">{error}</p>}
        </>
      )}
    </div>
  );
}
