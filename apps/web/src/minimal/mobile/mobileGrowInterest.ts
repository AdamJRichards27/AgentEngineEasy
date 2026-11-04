import type { GrowContact360 } from "../../lib/growContact360";

// AE Mobile (Release 1, Contact 360): "Grow interest & history", as one pure function. No React, no network, no storage.
//
// Two different kinds of information, never mixed (Less Tech, Not More):
//   PROPERTIES  = current property relationships, from property_parties (the one canonical table). Shown elsewhere.
//   GROW INTEREST & HISTORY = what Grow has recorded that is NOT a current property link: interest, prospecting, past relationships, and Grow's
//   own records. Every row is labelled so it can never be read as current ownership or a current property link.
//
// Nothing is silently dropped. A Grow row is left out of the list ONLY when it is the very same fact as a canonical link shown in Properties, and
// then it is COUNTED and SAID ("1 Grow record matches a property listed above"). The match is deliberately narrow (PROVISIONAL until Grok
// confirms the contract): an Active row, the same property, and a type whose name is a canonical role the Owner approved for automatic mapping
// (owner, tenant, landlord, buyer). Seller, vendor, co-owner, occupier and every other type are never treated as a match.

export const GROW_INTEREST_TITLE = "Grow interest & history";
export const GROW_INTEREST_NOTE = "From Grow: interest, prospecting and past relationships. These are not current property links.";

export type GrowInterestKind = "record" | "interest" | "review" | "past";
export interface GrowInterestRow {
  key: number;
  label: string;
  /** "Prospective buyer", "Related party · Executor" ... never the raw stored value. */
  relationship: string;
  kind: GrowInterestKind;
  /** "Grow record", "Interest", "To review" or "Past". */
  kindLabel: string;
  href: string | null;
  propertyId: number | null;
}
export interface GrowInterest {
  rows: GrowInterestRow[];
  /** Grow rows left out because each is the same fact as a canonical link above. Counted, never hidden. */
  matchedCount: number;
}

type GrowRelationship = GrowContact360["properties"][number];
export interface CanonicalLinkLike {
  propertyId: number;
  role: string;
}

const CANONICAL_ROLE_OF: Readonly<Record<string, string>> = { owner: "Owner", tenant: "Tenant", landlord: "Landlord", buyer: "Buyer" };
/** Types that SOUND like a current property relationship: shown as "Grow record" so they are never read as current. */
const CURRENT_SOUNDING = new Set(["owner", "co_owner", "occupier", "tenant", "landlord", "buyer", "seller", "vendor"]);
const KIND_LABEL: Readonly<Record<GrowInterestKind, string>> = { record: "Grow record", interest: "Interest", review: "To review", past: "Past" };
const KIND_RANK: Readonly<Record<GrowInterestKind, number>> = { record: 0, interest: 1, review: 2, past: 3 };

export function growInterestKind(status: string, relationshipType: string): GrowInterestKind {
  if (status === "PendingReview") return "review";
  if (status !== "Active") return "past"; // Historical, ended, merged ...: not current
  if (relationshipType === "former_owner") return "past";
  if (relationshipType === "unknown_pending_review") return "review";
  return CURRENT_SOUNDING.has(relationshipType) ? "record" : "interest";
}

/** True when this Grow row is the same fact as a canonical link (see the file header for the deliberately narrow rule). */
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
  const out: GrowInterestRow[] = [];
  let matchedCount = 0;
  for (const r of rows) {
    if (matchesCanonicalLink(r, canonical)) {
      matchedCount++;
      continue;
    }
    const kind = growInterestKind(r.status, r.relationshipType);
    out.push({
      key: r.relationshipId,
      label: r.propertyAddress ?? "Not linked to a property",
      relationship: describe(r.relationshipType, r.role),
      kind,
      kindLabel: KIND_LABEL[kind],
      href: r.propertyId === null ? null : propertyHref(r.propertyId),
      propertyId: r.propertyId,
    });
  }
  // stable: Grow records and interest first, then to-review, then past; the order within a group is the server's
  const ranked = out.map((row, i) => ({ row, i })).sort((a, b) => KIND_RANK[a.row.kind] - KIND_RANK[b.row.kind] || a.i - b.i).map((x) => x.row);
  return { rows: ranked, matchedCount };
}

export function matchedNoteText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 Grow record matches a property listed above, so it is not repeated here." : `${count} Grow records match properties listed above, so they are not repeated here.`;
}
