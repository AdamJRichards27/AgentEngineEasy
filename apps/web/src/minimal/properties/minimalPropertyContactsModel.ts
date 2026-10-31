// AE Minimal v1.0 — Link a Contact on the Grow property detail (Owner t148u/t149u).
// Existing routes only:
//   GET  /parties/by-property/:id   linked contacts (brokerage + visibility scoped)
//   GET  /grow/contacts?search=     Relationships search (name, email; grow.contacts.read)
//   POST /parties { propertyId, partyId, role }   link an EXISTING contact (no new contact row)
//   POST /grow/contacts             existing "New contact" create (grow.contacts.manage)
// The role is always chosen by the agent: nothing defaults to Seller/owner.

export const PROPERTY_PARTY_ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Owner", "Landlord", "Tenant", "Other"] as const;
export type PropertyPartyRole = (typeof PROPERTY_PARTY_ROLES)[number];

export const PROPERTY_PARTY_ROLE_LABELS: Record<PropertyPartyRole, string> = {
  // t230u: Owner is its own role, so Seller no longer reads "Seller / owner".
  Seller: "Seller",
  Buyer: "Buyer",
  Solicitor: "Solicitor",
  PowerOfAttorney: "Power of attorney",
  Owner: "Owner",
  Landlord: "Landlord",
  Tenant: "Tenant",
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
  isPrimary: boolean;
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
      roleLabel: roleLabel(r.role),
      isPrimary: r.isPrimary === true,
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

export function roleLabel(role: string): string {
  return isPropertyPartyRole(role) ? PROPERTY_PARTY_ROLE_LABELS[role] : role;
}

// t228u Priority 2 — the contact side of property_parties (authoritative):
//   GET    /parties/by-contact/:partyId   properties linked to a contact (brokerage + visibility scoped)
//   PATCH  /parties/link/:linkId          { role?, isPrimary? }
//   DELETE /parties/link/:linkId          unlink (the contact record is kept)
//   GET    /properties?q=                 property search for "Link to a property" (own-property scoped)

export interface ContactPropertyRow {
  linkId: number;
  propertyId: number;
  role: string;
  isPrimary: boolean;
  formattedAddress: string | null;
  suburb?: string | null;
}

export interface ContactPropertyLink {
  linkId: number;
  propertyId: number;
  role: string;
  roleLabel: string;
  isPrimary: boolean;
  label: string;
  propertyHref: string;
}

export function contactPropertiesPath(partyId: number): string {
  return `/parties/by-contact/${partyId}`;
}

export function linkPath(linkId: number): string {
  return `/parties/link/${linkId}`;
}

export function propertySearchPath(query: string): string {
  const q = query.trim();
  return q ? `/properties?q=${encodeURIComponent(q)}` : "/properties";
}

export function buildContactPropertyLinks(rows: readonly ContactPropertyRow[]): ContactPropertyLink[] {
  return rows.map((r) => ({
    linkId: r.linkId,
    propertyId: r.propertyId,
    role: r.role,
    roleLabel: roleLabel(r.role),
    isPrimary: r.isPrimary === true,
    label: r.formattedAddress?.trim() || `Property ${r.propertyId}`,
    propertyHref: `/grow/properties/${r.propertyId}`,
  }));
}

/** Body for PATCH /parties/link/:id. Only changed fields are sent; null when nothing changed. */
export function updateLinkBody(
  current: { role: string; isPrimary: boolean },
  next: { role?: string; isPrimary?: boolean },
): { role?: PropertyPartyRole; isPrimary?: boolean } | null {
  const body: { role?: PropertyPartyRole; isPrimary?: boolean } = {};
  if (next.role !== undefined && next.role !== current.role && isPropertyPartyRole(next.role)) body.role = next.role;
  if (next.isPrimary !== undefined && next.isPrimary !== current.isPrimary) body.isPrimary = next.isPrimary;
  return Object.keys(body).length ? body : null;
}

/** Client-side duplicate guard from the contact side. */
export function isPropertyAlreadyLinked(links: readonly ContactPropertyLink[], propertyId: number, role: string): boolean {
  return links.some((l) => l.propertyId === propertyId && l.role === role);
}

export const UNLINK_CONFIRM = "Remove this link? The contact and the property are both kept.";

/**
 * t230u: link-from-contact, role/primary edit and unlink stay OFF until the
 * security and integration tests pass in CI and the Owner enables them
 * (VITE_PROPERTY_LINK_CONTROLS=true at build). Read-only lists always render.
 */
export function propertyLinkControlsEnabled(env: Record<string, unknown> | undefined = (import.meta as { env?: Record<string, unknown> }).env): boolean {
  return env?.VITE_PROPERTY_LINK_CONTROLS === "true";
}
