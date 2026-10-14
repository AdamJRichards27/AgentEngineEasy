// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useQueryClient } from "@tanstack/react-query";
import { useEntitlements } from "../lib/session";
import { formatWhen } from "../lib/growToday";
import { GrowTableScroll } from "../components/GrowTableScroll";
import { appraisalForProperty } from "../lib/growAppraisals";
import { GrowNewOpportunityForm } from "./GrowNewOpportunityForm";
import { GrowOpportunityRowActions } from "./GrowOpportunityRowActions";
import { opportunityStatusLabel } from "./messages";
import type { GrowContact360Opportunity } from "./types";
import { useCanReadAppraisals, useAppraisalPipeline } from "./useGrowMutations";

// AE GROW Completion W2-B (E-3) — Contact 360's opportunities table. Extracted
// from GrowContactDetail above only so the row actions it now carries can be
// exercised on their own; the markup is otherwise the table that was inline
// here, plus an Actions column.
export function GrowContactOpportunitiesSection({
  partyId,
  contactName,
  linkedProperties,
  opportunities,
  onChanged,
}: {
  partyId: number;
  contactName?: string;
  linkedProperties?: Array<{ propertyId: number | null; propertyAddress: string | null }>;
  opportunities: GrowContact360Opportunity[];
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canReadAppraisals = useCanReadAppraisals();
  const pipeline = useAppraisalPipeline(canReadAppraisals);
  const appraisalRows = canReadAppraisals ? (pipeline.data?.appraisals ?? []) : [];

  function onSaved() {
    // A follow-up or a note changes what Today and the activity list show.
    onChanged();
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-opportunities"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  }

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      <GrowNewOpportunityForm
        fixedParty={{ id: partyId, displayName: contactName?.trim() || "This contact" }}
        linkedProperties={linkedProperties ?? []}
      />
      {opportunities.length === 0 && <p className="empty-state">No opportunities yet.</p>}
      {opportunities.length > 0 && (
        <GrowTableScroll>
        <table className="grow-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Next action</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => (
              <tr key={o.id}>
                <td>{o.opportunityType}</td>
                <td>{o.stage}</td>
                <td>
                  <span className={`pill ${o.status === "Open" ? "pill-success" : o.status === "Lost" ? "pill-danger" : ""}`}>
                    {opportunityStatusLabel(o.status, o.lostReason)}
                  </span>
                </td>
                <td>{o.reason ?? "–"}</td>
                <td>
                  {o.recommendedNextAction ?? "–"}
                  {o.nextActionDueAt ? ` (due ${formatWhen(o.nextActionDueAt)})` : ""}
                </td>
                <td>
                  {/* onViewContact is null here on purpose — see
                      GrowOpportunityRowActions: this table is already inside
                      the contact these opportunities belong to. */}
                  <GrowOpportunityRowActions
                    opportunityId={o.id}
                    partyId={partyId}
                    propertyId={o.propertyId}
                    stage={o.stage}
                    status={o.status}
                    appraisal={appraisalForProperty(appraisalRows, o.propertyId, partyId)}
                    canManageOpportunities={canManageOpportunities}
                    canAddNote={canAddNote}
                    canViewContacts={false}
                    onViewContact={null}
                    onAskAE={null}
                    onSaved={onSaved}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </GrowTableScroll>
      )}
    </section>
  );
}
