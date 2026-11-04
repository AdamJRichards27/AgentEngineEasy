import type { GrowContact360 } from "./growContact360";

// PROPOSED SHARED HELPER (Release 1, Contact 360): "Grow interest & history", one pure function used by BOTH the phone and the desktop.
// Proposed location: apps/web/src/lib/growInterest.ts. No React, no network, no storage, and no import from the mobile or desktop trees. No React, no network, no storage.
//
// Two different kinds of information, never mixed (Less Tech, Not More):
//   PROPERTIES  = current property relationships, from property_parties (the one canonical table). Shown elsewhere.
//   GROW INTEREST & HISTORY = everything Grow recorded about this person's relationships with properties: interest, prospecting, past
//   relationships and Grow's own records. Every row is labelled so it can never be read as current ownership.
//
// Owner decisions built in (revision 2):
//   - NOTHING IS LEFT OUT. A Grow row that is the same fact as a property listed under Properties stays visible, carries the label
//     "Also listed under Properties", and KEEPS its original Grow classification (matching never changes it).
//   - The matching rule only decides that label. It is deliberately narrow and still PROVISIONAL until Grok confirms the contract: an Active
//     row, the same property, and a type whose name is a canonical role the Owner approved for automatic mapping (owner, tenant, landlord,
//     buyer) equal to the canonical role. Seller, vendor, co-owner, occupier and every other type are never matched.
//   - The Grow record count and the canonical property count are SEPARATE numbers and are never added together.
//
// Classification, in strict order of precedence:
//   1. status PendingReview                         -> To review   (pending review takes priority over everything)
//   2. an UNKNOWN relationship type                 -> To review   (a type this list does not know, or unknown_pending_review)
//   3. any other status that is not Active          -> Past        (Historical, ended, merged ...)
//   4. former_owner                                 -> Past
//   5. a type that SOUNDS current (owner, co_owner, occupier, tenant, landlord, buyer, seller, vendor) -> Grow record
//   6. every other known type                       -> Interest

/** The words for the 17 stored relationship types (the same map the phone's People list uses). */
export const GROW_RELATIONSHIP_TYPE_LABELS: Readonly<Record<string, string>> = {
  owner: "Owner",
  co_owner: "Co-owner",
  former_owner: "Former owner",
  occupier: "Occupier",
  tenant: "Tenant",
  landlord: "Landlord",
  buyer: "Buyer",
  prospective_buyer: "Prospective buyer",
  seller: "Seller",
  prospective_seller: "Future seller",
  appraisal_contact: "Appraisal contact",
  vendor: "Vendor",
  investor: "Investor",
  developer: "Developer",
  referrer: "Referrer",
  related_party: "Related party",
  unknown_pending_review: "Unknown, pending review",
};

function humanise(type: string): string {
  const spaced = type.replace(/_/g, " ").trim();
  return spaced.length === 0 ? "Event" : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** "Co-owner", or "Related party · Executor" when the link carries a free-text role. Never the raw stored value. */
export function growRelationshipText(relationshipType: string, role: string | null): string {
  const known = GROW_RELATIONSHIP_TYPE_LABELS[relationshipType];
  const label = known ?? humanise(relationshipType);
  const refinement = role !== null && role.trim().length > 0 ? role.trim() : null;
  return refinement && refinement.toLowerCase() !== label.toLowerCase() ? `${label} · ${refinement}` : label;
}

export const GROW_INTEREST_TITLE = "Grow interest & history";
export const GROW_INTEREST_NOTE = "From Grow: interest, prospecting and past relationships. These are not current property links.";
export const ALSO_LISTED_LABEL = "Also listed under Properties";

export type GrowInterestKind = "record" | "interest" | "review" | "past";
export interface GrowInterestRow {
  key: number;
  label: string;
  /** "Prospective buyer", "Related party · Executor" ... never the raw stored value. */
  relationship: string;
  kind: GrowInterestKind;
  /** "Grow record", "Interest", "To review" or "Past": the ORIGINAL Grow classification, unchanged by matching. */
  kindLabel: string;
  /** True when this row is the same fact as a property listed under Properties. Shown, never hidden. */
  alsoListed: boolean;
  href: string | null;
  propertyId: number | null;
}
export interface GrowInterest {
  /** EVERY Grow row, none left out. */
  rows: GrowInterestRow[];
  /** How many of them carry the "Also listed under Properties" label. */
  alsoListedCount: number;
}

type GrowRelationship = GrowContact360["properties"][number];
export interface CanonicalLinkLike {
  propertyId: number;
  role: string;
}

const CANONICAL_ROLE_OF: Readonly<Record<string, string>> = { owner: "Owner", tenant: "Tenant", landlord: "Landlord", buyer: "Buyer" };
/** Types that SOUND like a current property relationship: shown as "Grow record" so they are never read as current. */
const CURRENT_SOUNDING = new Set(["owner", "co_owner", "occupier", "tenant", "landlord", "buyer", "seller", "vendor"]);
const KNOWN_TYPES = new Set(Object.keys(GROW_RELATIONSHIP_TYPE_LABELS));
const KIND_LABEL: Readonly<Record<GrowInterestKind, string>> = { record: "Grow record", interest: "Interest", review: "To review", past: "Past" };
const KIND_RANK: Readonly<Record<GrowInterestKind, number>> = { record: 0, interest: 1, review: 2, past: 3 };

/** True for a type this phone does not know, and for the stored "unknown_pending_review". */
export function isUnknownRelationshipType(relationshipType: string): boolean {
  return relationshipType === "unknown_pending_review" || !KNOWN_TYPES.has(relationshipType);
}

export function growInterestKind(status: string, relationshipType: string): GrowInterestKind {
  if (status === "PendingReview") return "review";
  if (isUnknownRelationshipType(relationshipType)) return "review";
  if (status !== "Active") return "past"; // Historical, ended, merged ...: not current
  if (relationshipType === "former_owner") return "past";
  return CURRENT_SOUNDING.has(relationshipType) ? "record" : "interest";
}

/** True when this Grow row is the same fact as a canonical link (see the file header for the deliberately narrow rule). It only adds a label. */
export function matchesCanonicalLink(row: Pick<GrowRelationship, "status" | "propertyId" | "relationshipType">, links: readonly CanonicalLinkLike[]): boolean {
  const role = CANONICAL_ROLE_OF[row.relationshipType];
  if (!role || row.status !== "Active" || row.propertyId === null) return false;
  return links.some((l) => l.propertyId === row.propertyId && l.role.trim().toLowerCase() === role.toLowerCase());
}

export function buildGrowInterest(
  rows: readonly GrowRelationship[],
  canonical: readonly CanonicalLinkLike[],
  describe: (relationshipType: string, role: string | null) => string,
  propertyHref: (propertyId: number) => string,
): GrowInterest {
  const out: GrowInterestRow[] = rows.map((r) => {
    const kind = growInterestKind(r.status, r.relationshipType);
    return {
      key: r.relationshipId,
      label: r.propertyAddress ?? "Not linked to a property",
      relationship: describe(r.relationshipType, r.role),
      kind,
      kindLabel: KIND_LABEL[kind],
      alsoListed: matchesCanonicalLink(r, canonical),
      href: r.propertyId === null ? null : propertyHref(r.propertyId),
      propertyId: r.propertyId,
    };
  });
  // stable: Grow records and interest first, then to-review, then past; the order within a group is the server's
  const ranked = out.map((row, i) => ({ row, i })).sort((a, b) => KIND_RANK[a.row.kind] - KIND_RANK[b.row.kind] || a.i - b.i).map((x) => x.row);
  return { rows: ranked, alsoListedCount: ranked.filter((r) => r.alsoListed).length };
}
