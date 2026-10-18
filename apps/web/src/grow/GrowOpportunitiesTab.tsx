// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../lib/api";
import { useEntitlements } from "../lib/session";
// AE GROW Pilot Readiness WP6b (D6) — the shared loading/failed/empty region
// presentation, and the pure state logic behind it and the tab bar.
import { GrowDataRegionStatus } from "../components/GrowDataRegion";
import { growDataRegionState, growContactPath } from "../lib/growWorkspace";
import { formatWhen } from "../lib/growToday";
import { GrowVirtualTable, memoRow, useGrowCursorPages } from "../components/GrowVirtualList";
import { growListPath, listSearchEmptyMessage } from "../lib/growListQuery";
import {
  GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS,
  GROW_OPPORTUNITY_LIST_TYPE_FILTERS,
  parseGrowOpportunityListTypeFilter,
  type GrowOpportunityListTypeFilter,
} from "@aee/domain";
import { appraisalForProperty, type GrowAppraisalSummary } from "../lib/growAppraisals";
import { GrowListSearch } from "./GrowListSearch";
import { GrowNewOpportunityForm } from "./GrowNewOpportunityForm";
import { GrowOpportunityRowActions } from "./GrowOpportunityRowActions";
import { opportunityStatusLabel } from "./messages";
import type { GrowOpportunity, GrowOpportunityListPage } from "./types";
import { useCanReadAppraisals, useAppraisalPipeline, useDebouncedListSearch } from "./useGrowMutations";

// E-3 — this tab was four read-only cells per row. #56 added View contact,
// View property, and Create follow-up, the same jumps and follow-up write Grow
// Today already had. Add note and Ask AE are the remaining non-outreach actions
// on Today's opportunity card, wired through the same handlers. The existing
// next action stays visible so creating one changes the row.
const GrowOpportunityCells = memoRow(function GrowOpportunityCells({
  opportunity,
  appraisal,
  canManageOpportunities,
  canAddNote,
  canViewContacts,
  onViewContact,
  onAskAE,
  onSaved,
}: {
  opportunity: GrowOpportunity;
  appraisal: GrowAppraisalSummary | null;
  canManageOpportunities: boolean;
  canAddNote: boolean;
  canViewContacts: boolean;
  onViewContact: (partyId: number) => void;
  onAskAE: (() => void) | null;
  onSaved: () => void;
}) {
  const contactName = opportunity.contactName?.trim() ? opportunity.contactName.trim() : null;
  return (
    <>
      <td>
        {contactName && canViewContacts ? (
          <Link href={growContactPath(opportunity.partyId)} className="btn btn-link btn-small">
            {contactName}
          </Link>
        ) : (
          (contactName ?? "–")
        )}
      </td>
      <td>{opportunity.opportunityType}</td>
      <td>{opportunity.stage}</td>
      <td>
        <span className={`pill ${opportunity.status === "Open" ? "pill-success" : opportunity.status === "Lost" ? "pill-danger" : ""}`}>
          {opportunityStatusLabel(opportunity.status, opportunity.lostReason)}
        </span>
      </td>
      <td>{opportunity.reason ?? "–"}</td>
      <td>
        {opportunity.recommendedNextAction ?? "–"}
        {opportunity.nextActionDueAt ? ` (due ${formatWhen(opportunity.nextActionDueAt)})` : ""}
      </td>
      <td className="grow-opportunity-actions-cell">
        <GrowOpportunityRowActions
          opportunityId={opportunity.id}
          partyId={opportunity.partyId}
          propertyId={opportunity.propertyId}
          stage={opportunity.stage}
          status={opportunity.status}
          appraisal={appraisal}
          canManageOpportunities={canManageOpportunities}
          canAddNote={canAddNote}
          canViewContacts={canViewContacts}
          onViewContact={onViewContact}
          onAskAE={onAskAE}
          onSaved={onSaved}
        />
      </td>
    </>
  );
});
export function GrowOpportunitiesTab({
  onViewContact,
  onAskAE,
}: {
  onViewContact: (partyId: number) => void;
  onAskAE?: () => void;
}) {
  const queryClient = useQueryClient();
  const { hasEntitlement } = useEntitlements();
  const canManageOpportunities = hasEntitlement("grow.opportunities.manage");
  const canAddNote = hasEntitlement("grow.activities.manage");
  const canViewContacts = hasEntitlement("grow.contacts.read");
  const canReadAppraisals = useCanReadAppraisals();
  const [typeFilter, setTypeFilter] = useState<GrowOpportunityListTypeFilter>("all");
  const [listVersion, setListVersion] = useState(0);
  const opportunitySearch = useDebouncedListSearch();
  // An empty search keeps the key C-5a already asserts: ["grow-opportunities", type].
  // A search is appended so the two filters refetch together.
  const opportunityQueryKey = opportunitySearch.query
    ? ["grow-opportunities", typeFilter, opportunitySearch.query]
    : ["grow-opportunities", typeFilter];

  const opportunities = useQuery<GrowOpportunityListPage>({
    queryKey: opportunityQueryKey,
    queryFn: () => apiFetch(growListPath("/grow/opportunities", { search: opportunitySearch.query, type: typeFilter })),
  });
  const opportunityPages = useGrowCursorPages({
    resetKey: `${typeFilter}\0${opportunitySearch.query}\0${listVersion}`,
    page: opportunities.data
      ? { items: opportunities.data.opportunities, nextCursor: opportunities.data.nextCursor, total: opportunities.data.total }
      : undefined,
    getId: (opportunity) => opportunity.id,
    fetchPage: (cursor) =>
      apiFetch<GrowOpportunityListPage>(
        growListPath("/grow/opportunities", { search: opportunitySearch.query, type: typeFilter, cursor }),
      ).then((page) => ({
        items: page.opportunities,
        nextCursor: page.nextCursor,
        total: page.total,
      })),
  });
  const pipeline = useAppraisalPipeline(canReadAppraisals);
  const appraisalRows = canReadAppraisals ? (pipeline.data?.appraisals ?? []) : [];
  const opportunityCount = opportunities.data ? opportunityPages.items.length : undefined;
  const opportunityState = growDataRegionState(opportunities, opportunityCount);

  function onSaved() {
    setListVersion((version) => version + 1);
    void opportunities.refetch();
    queryClient.invalidateQueries({ queryKey: ["grow-today"] });
    queryClient.invalidateQueries({ queryKey: ["grow-activities"] });
  }

  return (
    <section className="card">
      <h2>Opportunities</h2>
      <p className="muted">Explainable by design - every opportunity carries a reason, never just a score.</p>
      <GrowNewOpportunityForm />
      <div className="grow-inline-form-row">
        <label htmlFor="grow-opportunity-type-filter">Opportunity type</label>
        <select
          id="grow-opportunity-type-filter"
          value={typeFilter}
          onChange={(event) => {
            const parsed = parseGrowOpportunityListTypeFilter(event.target.value);
            if (parsed.ok) setTypeFilter(parsed.filter);
          }}
        >
          {GROW_OPPORTUNITY_LIST_TYPE_FILTERS.map((filter) => (
            <option key={filter} value={filter}>
              {GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS[filter]}
            </option>
          ))}
        </select>
      </div>
      <GrowListSearch
        id="grow-opportunities-search"
        label="Search opportunities"
        placeholder="Search by contact or reason"
        text={opportunitySearch.text}
        onText={opportunitySearch.setText}
        onCommit={opportunitySearch.commit}
      />
      {/* AE GROW Pilot Readiness WP6b (D6) — see GrowContactList above. */}
      <GrowDataRegionStatus
        key={`${typeFilter}\0${opportunitySearch.query}`}
        query={opportunities}
        itemCount={opportunityCount}
        errorFallback="Couldn't load opportunities."
        emptyMessage={listSearchEmptyMessage(opportunitySearch.query, "opportunities", "No opportunities yet.")}
        onRetry={() => void opportunities.refetch()}
      />
      {opportunityState === "ready" && (
        <GrowVirtualTable
          label="Opportunities"
          singular="opportunity"
          plural="opportunities"
          colSpan={7}
          estimate={160}
          resetKey={`${typeFilter}\0${opportunitySearch.query}\0${listVersion}`}
          items={opportunityPages.items}
          total={opportunityPages.total}
          getKey={(opportunity) => opportunity.id}
          hasMore={opportunityPages.hasMore}
          loadingMore={opportunityPages.loadingMore}
          moreError={opportunityPages.moreError}
          onLoadMore={opportunityPages.loadMore}
          head={
            <tr>
              <th>Contact</th>
              <th>Type</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Reason</th>
              <th>Next action</th>
              <th className="grow-opportunity-actions-cell"></th>
            </tr>
          }
          renderCells={(opportunity) => (
            <GrowOpportunityCells
              opportunity={opportunity}
              appraisal={appraisalForProperty(appraisalRows, opportunity.propertyId, opportunity.partyId)}
              canManageOpportunities={canManageOpportunities}
              canAddNote={canAddNote}
              canViewContacts={canViewContacts}
              onViewContact={onViewContact}
              onAskAE={onAskAE ?? null}
              onSaved={onSaved}
            />
          )}
        />
      )}
    </section>
  );
}
