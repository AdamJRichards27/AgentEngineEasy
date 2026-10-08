/**
 * Opportunity type groups for the Grow opportunities list (C-5a).
 *
 * Stored values are the ones named on `grow_opportunities.opportunity_type`
 * in packages/db/src/schema/grow.ts: Listing | Appraisal | PropertyManagement | Other.
 * That column is text, not a Postgres enum. This module does not add types.
 *
 * Seller-side is Listing and Appraisal only.
 * Property Management is the stored value PropertyManagement, and it is not seller-side.
 * Other is unclassified: the stored value Other, any unknown string, and null.
 * Unclassified values are never treated as seller-side.
 */

export const GROW_OPPORTUNITY_TYPES = ["Listing", "Appraisal", "PropertyManagement", "Other"] as const;
export type GrowOpportunityType = (typeof GROW_OPPORTUNITY_TYPES)[number];

export const GROW_OPPORTUNITY_LIST_TYPE_FILTERS = ["all", "seller_side", "property_management", "other"] as const;
export type GrowOpportunityListTypeFilter = (typeof GROW_OPPORTUNITY_LIST_TYPE_FILTERS)[number];

export type GrowOpportunityTypeGroup = Exclude<GrowOpportunityListTypeFilter, "all">;

export const GROW_OPPORTUNITY_LIST_TYPE_FILTER_LABELS: Record<GrowOpportunityListTypeFilter, string> = {
  all: "All",
  seller_side: "Seller-side (Listing + Appraisal)",
  property_management: "Property Management",
  other: "Other",
};

/** Stored types in the seller-side group. PropertyManagement is intentionally absent. */
export const SELLER_SIDE_OPPORTUNITY_TYPES = ["Listing", "Appraisal"] as const;

/** Stored value for the property-management group. Not a seller-side type. */
export const PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE = "PropertyManagement" as const;

/**
 * Stored types that belong to a named group. The list filter `other` is every
 * value outside this list, including the stored value "Other", unknown strings, and NULL.
 */
export const CLASSIFIED_OPPORTUNITY_TYPES = [...SELLER_SIDE_OPPORTUNITY_TYPES, PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE] as const;

const SELLER_SIDE_TYPES: ReadonlySet<string> = new Set(SELLER_SIDE_OPPORTUNITY_TYPES);

export function classifyGrowOpportunityType(value: string | null | undefined): GrowOpportunityTypeGroup {
  if (value === PROPERTY_MANAGEMENT_OPPORTUNITY_TYPE) return "property_management";
  if (typeof value === "string" && SELLER_SIDE_TYPES.has(value)) return "seller_side";
  return "other";
}

const TYPE_FILTER_ERROR = "type must be one of all, seller_side, property_management, other";

export function parseGrowOpportunityListTypeFilter(
  raw: unknown,
): { ok: true; filter: GrowOpportunityListTypeFilter } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, filter: "all" };
  if (typeof raw === "string" && (GROW_OPPORTUNITY_LIST_TYPE_FILTERS as readonly string[]).includes(raw)) {
    return { ok: true, filter: raw as GrowOpportunityListTypeFilter };
  }
  return { ok: false, error: TYPE_FILTER_ERROR };
}
