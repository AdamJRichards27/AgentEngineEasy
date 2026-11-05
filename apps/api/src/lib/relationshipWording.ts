// t280u: server-side wording for stored Grow relationship keys. API-side copy of the approved
// labels in apps/web/src/lib/growInterest.ts (GROW_RELATIONSHIP_TYPE_LABELS). Keep in sync.
// A raw stored key (snake_case) is never returned to a client.
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

export const GROW_RELATIONSHIP_STATUS_LABELS: Readonly<Record<string, string>> = {
  Active: "Active",
  Historical: "Past",
  PendingReview: "To review",
};

function readable(raw: string, fallback: string): string {
  const spaced = String(raw ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.length === 0 ? fallback : spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function relationshipTypeWording(type: string): string {
  return GROW_RELATIONSHIP_TYPE_LABELS[type] ?? readable(type, "Relationship");
}

export function relationshipStatusWording(status: string): string {
  return GROW_RELATIONSHIP_STATUS_LABELS[status] ?? readable(status, "Updated");
}
