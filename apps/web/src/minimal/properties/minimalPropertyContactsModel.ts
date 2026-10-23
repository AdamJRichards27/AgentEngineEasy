// AE Minimal v1.0 — Link a Contact on the Grow property detail (Owner t148u/t149u).
// Existing routes only:
//   GET  /parties/by-property/:id   linked contacts (brokerage + visibility scoped)
//   GET  /grow/contacts?search=     Relationships search (name, email; grow.contacts.read)
//   POST /parties { propertyId, partyId, role }   link an EXISTING contact (no new contact row)
//   POST /grow/contacts             existing "New contact" create (grow.contacts.manage)
// The role is always chosen by the agent: nothing defaults to Seller/owner.

export const PROPERTY_PARTY_ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
export type PropertyPartyRole = (typeof PROPERTY_PARTY_ROLES)[number];

export const PROPERTY_PARTY_ROLE_LABELS: Record<PropertyPartyRole, string> = {
  Seller: "Seller / owner",
  Buyer: "Buyer",
  Solicitor: "Solicitor",
  PowerOfAttorney: "Power of attorney",
  Other: "Other",
};

export interface LinkedPartyRow {
  linkId: number;
  role: string;
  isPrimary?: boolean | null;
  party: { id: number; firstName?: string | null; lastName?: string | null; organisationName?: string | null; email?: string | null; mobile?: string | null } | null;
}

export interface LinkedContact {
  linkId: number;
  partyId: number;
  name: string;
  role: string;
  roleLabel: string;
  detail: string;
  contactHref: string;
}

export function isPropertyPartyRole(v: string): v is PropertyPartyRole {
  return (PROPERTY_PARTY_ROLES as readonly string[]).includes(v);
}

export function partyDisplayName(p: NonNullable<LinkedPartyRow["party"]>): string {
  const person = [p.firstName, p.lastName].map((s) => s?.trim() ?? "").filter(Boolean).join(" ");
  return person || p.organisationName?.trim() || `Contact ${p.id}`;
}

export function buildLinkedContacts(rows: readonly LinkedPartyRow[]): LinkedContact[] {
  return rows
    .filter((r): r is LinkedPartyRow & { party: NonNullable<LinkedPartyRow["party"]> } => r.party !== null)
    .map((r) => ({
      linkId: r.linkId,
      partyId: r.party.id,
      name: partyDisplayName(r.party),
      role: r.role,
      roleLabel: isPropertyPartyRole(r.role) ? PROPERTY_PARTY_ROLE_LABELS[r.role] : r.role,
      detail: [r.party.email, r.party.mobile].map((s) => s?.trim() ?? "").filter(Boolean).join(" · "),
      contactHref: `/grow/contacts/${r.party.id}`,
    }));
}

/** Client-side duplicate guard; the server still answers 409 PROPERTY_PARTY_LINK_EXISTS. */
export function isAlreadyLinked(linked: readonly LinkedContact[], partyId: number, role: string): boolean {
  return linked.some((l) => l.partyId === partyId && l.role === role);
}

/** One entry per contact, for "Start appraisal with …". */
export function appraisalCandidates(linked: readonly LinkedContact[]): { partyId: number; name: string }[] {
  const seen = new Set<number>();
  const out: { partyId: number; name: string }[] = [];
  for (const l of linked) {
    if (seen.has(l.partyId)) continue;
    seen.add(l.partyId);
    out.push({ partyId: l.partyId, name: l.name });
  }
  return out;
}

export function linkContactBody(propertyId: number, partyId: number, role: PropertyPartyRole) {
  return { propertyId, partyId, role };
}

export const LINK_ALREADY_EXISTS = "That contact is already linked to this property with that relationship.";
export const LINK_NOT_FOUND = "That contact or property isn't available in your brokerage. Refresh and search again.";
export const LINK_FORBIDDEN = "You don't have permission to link contacts to this property.";
export const LINK_INVALID = "Choose a contact and the contact's relationship to the property, then try again.";
export const LINK_ROLE_REQUIRED = "Choose the contact's relationship to this property.";

/** Friendly text for a failed link. */
export function linkFailureText(error: { status?: number; code?: string } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  if (error.status === 409) return LINK_ALREADY_EXISTS;
  if (error.status === 404) return LINK_NOT_FOUND;
  if (error.status === 403) return LINK_FORBIDDEN;
  if (error.status === 400) return LINK_INVALID;
  return fallback;
}

export function contactSearchPath(query: string): string {
  return `/grow/contacts?search=${encodeURIComponent(query.trim())}&limit=20`;
}

export function linkedPartiesPath(propertyId: number): string {
  return `/parties/by-property/${propertyId}`;
}
