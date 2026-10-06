import { Link } from "wouter";
import { appraisalWorkspacePath, formatAppraisalMoney } from "../lib/appraisalUi";

// Property page summary. Editing lives on the Appraisal Workspace.
export interface PropertyAppraisalSummaryBlock {
  id: number;
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  isFinalised: boolean;
}

export function PropertyAppraisalSummary({
  appraisal,
  onStart,
  startError,
}: {
  appraisal: PropertyAppraisalSummaryBlock | null;
  onStart: () => void;
  startError: string | null;
}) {
  if (!appraisal) {
    return (
      <div>
        <p className="muted">No appraisal started yet.</p>
        <button className="btn btn-secondary" type="button" onClick={onStart}>
          Start Appraisal
        </button>
        {startError && <p className="error-text">{startError}</p>}
      </div>
    );
  }

  const low = formatAppraisalMoney(appraisal.priceRangeLow);
  const high = formatAppraisalMoney(appraisal.priceRangeHigh);

  return (
    <div className="stack">
      <p>
        {appraisal.isFinalised ? <span className="pill pill-success">Finalised</span> : <span className="pill">In progress</span>}
        {low && high ? ` ${low} – ${high}` : ""}
      </p>
      <p className="muted">Price, outcome, and history are on the appraisal workspace.</p>
      <Link href={appraisalWorkspacePath(appraisal.id)} className="btn btn-link btn-small" id="property-open-appraisal">
        Open appraisal
      </Link>
    </div>
  );
}
