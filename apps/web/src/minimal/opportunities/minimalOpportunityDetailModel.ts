import {
  GROW_OPPORTUNITY_LIST_TYPE_FILTERS,
  GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS,
  type GrowOpportunityListTypeFilter,
} from "@aee/domain";
import { appraisalWorkspacePath, formatAppraisalDate } from "../../lib/appraisalUi";
import { MINIMAL_PIPELINE_COLUMNS, opportunityActions, pipelineColumnKey, type MinimalOpportunityRow } from "./minimalOpportunitiesModel";

// AE Minimal A — Opportunity detail and opportunity search. Existing endpoints only:
//   GET   /grow/opportunities?id=<id>&limit=1               (one row, same scoping as the list; empty → not found)
//   GET   /grow/opportunities?search=<q>&type=<f>&limit=50  (server-side search + C-5a type filter)
//   PATCH /grow/opportunities/:id/lifecycle                 (#187; reused for stage / lost / close)

export const MINIMAL_OPPORTUNITIES_HREF = "/grow/opportunities";
export const MINIMAL_OPPORTUNITY_SEARCH_LIMIT = 50;

const TYPE_LABELS: Record<string, string> = {
  Listing: "Listing",
  Appraisal: "Appraisal",
  PropertyManagement: "Property management",
  Other: "Other",
};

export function minimalOpportunityDetailPath(id: number): string {
  return `/grow/opportunities/${id}`;
}

export function opportunityDetailQueryPath(id: number): string {
  return `/grow/opportunities?id=${id}&limit=1`;
}

export function opportunitySearchQueryPath(search: string, type: GrowOpportunityListTypeFilter): string {
  const params = new URLSearchParams({ limit: String(MINIMAL_OPPORTUNITY_SEARCH_LIMIT) });
  const q = search.trim();
  if (q) params.set("search", q);
  if (type !== "all") params.set("type", type);
  return `/grow/opportunities?${params.toString()}`;
}

export const OPPORTUNITY_TYPE_FILTER_OPTIONS = GROW_OPPORTUNITY_LIST_TYPE_FILTERS.map((value) => ({
  value,
  label: GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS[value],
}));

export function parseTypeFilter(raw: string): GrowOpportunityListTypeFilter {
  return (GROW_OPPORTUNITY_LIST_TYPE_FILTERS as readonly string[]).includes(raw) ? (raw as GrowOpportunityListTypeFilter) : "all";
}

export interface MinimalOpportunityDetailRow extends MinimalOpportunityRow {
  lostReason?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface MinimalOpportunityDetailModel {
  id: number;
  contactName: string;
  contactHref: string;
  typeLabel: string;
  stageLabel: string;
  closed: boolean;
  reason: string | null;
  lostReason: string | null;
  nextAction: string | null;
  nextActionDue: string | null;
  created: string | null;
  propertyHref: string | null;
  appraisalHref: string | null;
  actions: ReturnType<typeof opportunityActions>;
}

export function buildOpportunityDetail(row: MinimalOpportunityDetailRow): MinimalOpportunityDetailModel {
  const key = pipelineColumnKey(row);
  const column = MINIMAL_PIPELINE_COLUMNS.find((c) => c.key === key)!;
  return {
    id: row.id,
    contactName: row.contactName?.trim() || "Unnamed contact",
    contactHref: `/grow/contacts/${row.partyId}`,
    typeLabel: TYPE_LABELS[row.opportunityType] ?? row.opportunityType,
    stageLabel: column.label,
    closed: column.closed,
    reason: row.reason?.trim() || null,
    lostReason: row.lostReason?.trim() || null,
    nextAction: row.recommendedNextAction?.trim() || null,
    nextActionDue: formatAppraisalDate(row.nextActionDueAt),
    created: formatAppraisalDate(row.createdAt ?? null),
    // Grow property detail (Minimal), not the Run workspace.
    propertyHref: row.propertyId != null ? `/grow/properties/${row.propertyId}` : null,
    appraisalHref: row.convertedAppraisalId != null ? appraisalWorkspacePath(row.convertedAppraisalId) : null,
    actions: opportunityActions(row),
  };
}

/** The ?id= list call returns an array; zero rows means hidden or absent (same as a 404). */
export function pickOpportunity(rows: MinimalOpportunityDetailRow[] | undefined, id: number): MinimalOpportunityDetailRow | null {
  return rows?.find((r) => r.id === id) ?? null;
}

export interface OpportunitySearchResult {
  id: number;
  href: string;
  contactName: string;
  typeLabel: string;
  stageLabel: string;
  reason: string | null;
}

export function buildOpportunitySearchResults(rows: MinimalOpportunityRow[]): OpportunitySearchResult[] {
  return rows.map((row) => ({
    id: row.id,
    href: minimalOpportunityDetailPath(row.id),
    contactName: row.contactName?.trim() || "Unnamed contact",
    typeLabel: TYPE_LABELS[row.opportunityType] ?? row.opportunityType,
    stageLabel: MINIMAL_PIPELINE_COLUMNS.find((c) => c.key === pipelineColumnKey(row))!.label,
    reason: row.reason?.trim() || null,
  }));
}

export function selectOpportunityDetailView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}
