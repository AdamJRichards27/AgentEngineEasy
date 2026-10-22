import { type AppraisalListRow, appraisalIsTerminal, appraisalWorkspacePath, formatAppraisalDate } from "../../lib/appraisalUi";
import { appraisalStatusLabel } from "../../lib/growAppraisals";
import { propertyLocationLine, type MinimalPropertyRow } from "./minimalPropertiesModel";

// AE Minimal A — Property detail (Grow view of one property record).
// Existing endpoints only, nothing new on the server:
//   GET /properties/:id                 (brokerage + visibility scoped; 404 otherwise)
//   GET /grow/appraisals/pipeline       (filtered to this property in the browser)
//   GET /grow/opportunities?limit=100   (no propertyId filter exists; filtered in the browser)
// Run workspace (/properties/:id) is linked only with run.access (Owner D5).

export const MINIMAL_PROPERTIES_LIST_HREF = "/properties";
export const MINIMAL_PROPERTY_OPPORTUNITY_LIMIT = 100;

export interface MinimalPropertyDetailRow extends MinimalPropertyRow {
  salesMethod?: string | null;
  priceDisplay?: string | null;
  amlStatusSummary?: string | null;
}

export interface MinimalPropertyDetailOpportunity {
  id: number;
  propertyId: number | null;
  partyId: number;
  status: string;
  stage: string;
  opportunityType: string;
  contactName: string | null;
}

export interface MinimalPropertyDetailModel {
  id: number;
  address: string;
  location: string;
  stage: string;
  listingStatus: string;
  salesMethod: string;
  priceDisplay: string;
  runHref: string | null;
  appraisals: { id: number; href: string; statusLabel: string; contact: string; updated: string | null; closed: boolean }[];
  opportunities: { id: number; href: string; contact: string; contactHref: string; stage: string; open: boolean }[];
  /** True when the opportunity page hit the limit, so the list may be incomplete. */
  opportunitiesTruncated: boolean;
}

/** "/grow/properties/12" style param → id, or null for anything that is not a positive integer. */
export function parseDetailId(raw: string | undefined | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function minimalPropertyDetailPath(id: number): string {
  return `/grow/properties/${id}`;
}

function isOpenOpportunity(o: Pick<MinimalPropertyDetailOpportunity, "status" | "stage">): boolean {
  return !["Lost", "Closed", "Converted"].includes(o.status) && o.stage !== "Lost" && o.stage !== "Converted";
}

export function buildMinimalPropertyDetail(
  property: MinimalPropertyDetailRow,
  appraisals: AppraisalListRow[],
  opportunities: MinimalPropertyDetailOpportunity[],
  opts: { runAccess: boolean; opportunityPageFull?: boolean },
): MinimalPropertyDetailModel {
  const mine = appraisals
    .filter((a) => a.propertyId === property.id)
    .map((a) => ({
      id: a.id,
      href: appraisalWorkspacePath(a.id),
      statusLabel: appraisalStatusLabel(a.status),
      contact: a.partyDisplayName?.trim() || "No contact linked",
      updated: formatAppraisalDate(a.updatedAt ?? null),
      closed: appraisalIsTerminal(a),
    }))
    .sort((x, y) => Number(x.closed) - Number(y.closed) || y.id - x.id);
  const opps = opportunities
    .filter((o) => o.propertyId === property.id)
    .map((o) => ({
      id: o.id,
      href: minimalOpportunityDetailHref(o.id),
      contact: o.contactName?.trim() || "Unnamed contact",
      contactHref: `/grow/contacts/${o.partyId}`,
      stage: o.status === "Open" || !o.status ? o.stage : o.status,
      open: isOpenOpportunity(o),
    }))
    .sort((x, y) => Number(y.open) - Number(x.open) || y.id - x.id);
  return {
    id: property.id,
    address: property.formattedAddress,
    location: propertyLocationLine(property),
    stage: property.workflowStage,
    listingStatus: property.listingStatus,
    salesMethod: property.salesMethod?.trim() || "Not recorded",
    priceDisplay: property.priceDisplay?.trim() || "Not recorded",
    runHref: opts.runAccess ? `/properties/${property.id}` : null,
    appraisals: mine,
    opportunities: opps,
    opportunitiesTruncated: Boolean(opts.opportunityPageFull),
  };
}

/** Kept here (not imported from the opportunity detail model) so the two pages do not depend on each other. */
function minimalOpportunityDetailHref(id: number): string {
  return `/grow/opportunities/${id}`;
}

/** Route selector: Minimal shell → Minimal detail; otherwise or "?view=full" → classic. */
export function selectPropertyDetailView(minimalShell: boolean, search = ""): "minimal" | "classic" {
  if (!minimalShell) return "classic";
  return new URLSearchParams(search).get("view") === "full" ? "classic" : "minimal";
}
