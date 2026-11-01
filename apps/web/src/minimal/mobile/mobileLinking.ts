import { GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, LINK_ROLE_LABELS, MOBILE_LINKING, MOBILE_LINK_CONTRACT, ROLES_ACCEPTED_NOW, ROLES_APPROVED_PENDING, type LinkContract, type LinkRole, type LinkingFlags } from "./mobileLinkingConfig";
import { LINK_ALREADY_EXISTS, LINK_ROLE_REQUIRED, linkFailureText } from "../properties/minimalPropertyContactsModel";

// AE Mobile (CC Task #64, M4 linking): the link, change-role and unlink requests the phone may send, and when each control may be
// enabled, as pure functions. No React, no network, no storage.
//
// ONE canonical contract, `property_parties`, used identically from a contact and from a property:
//
//   POST   /parties                  { propertyId, partyId, role }   link an EXISTING contact (no contact fields, so no duplicate contact)   EXISTS
//   DELETE /parties/link/:linkId                                      remove the link only; the contact and property stay                    EXISTS
//   GET    /parties/by-property/:id  the contacts on a property, with roles                                                                 EXISTS
//   PATCH  /parties/link/:linkId     { role }                         change the role                                                        PROPOSED
//   GET    /parties/by-contact/:id   the properties of a contact, with roles                                                                 PROPOSED
//
// The two PROPOSED routes are specified in CANONICAL-LINK-CONTRACT-REQUEST.md. Until Grok builds and confirms them, with the
// permission and own-property checks the existing routes lack, every control stays off (mobileLinkingConfig.ts).

export type LinkingAction = keyof LinkingFlags;
export interface LinkingCapability {
  enabled: boolean;
  /** Why it is off, in plain words, or null when it is on. */
  reason: string | null;
}
export type LinkingCapabilities = Record<LinkingAction, LinkingCapability>;

export const NOT_AVAILABLE_YET = "Not available on your phone yet.";
export const NO_PERMISSION = "You don’t have permission to change links.";

const NEEDS: Record<LinkingAction, readonly string[]> = {
  contactLinkProperty: [GROW_RELATIONSHIPS_MANAGE, GROW_PROPERTIES_LINK],
  contactEditRole: [GROW_RELATIONSHIPS_MANAGE],
  contactUnlink: [GROW_RELATIONSHIPS_MANAGE],
  contactEditPrimary: [GROW_RELATIONSHIPS_MANAGE],
  contactCanonicalRead: [],
  // The property-side routes check nothing but a signed-in brokerage user today. Until the server enforces more, the phone asks for
  // the Grow key that governs relationships, so a read-only agent sees read-only controls. Display only: Grok enforces it.
  propertyLinkContact: [GROW_RELATIONSHIPS_MANAGE],
  propertyEditRole: [GROW_RELATIONSHIPS_MANAGE],
  propertyEditPrimary: [GROW_RELATIONSHIPS_MANAGE],
  propertyUnlink: [GROW_RELATIONSHIPS_MANAGE],
};

/** Off unless the backend is ready (flag) AND the user holds the keys. Fails closed on a missing entitlement list. */
export function linkingCapabilities(entitlements: readonly string[] | null | undefined, flags: LinkingFlags = MOBILE_LINKING): LinkingCapabilities {
  const out = {} as LinkingCapabilities;
  for (const action of Object.keys(NEEDS) as LinkingAction[]) {
    if (!flags[action]) {
      out[action] = { enabled: false, reason: NOT_AVAILABLE_YET };
      continue;
    }
    const held = Array.isArray(entitlements) && NEEDS[action].every((key) => entitlements.includes(key));
    out[action] = held ? { enabled: true, reason: null } : { enabled: false, reason: NO_PERMISSION };
  }
  return out;
}

export type LinkRequest = { path: string; method: "POST" | "PATCH" | "DELETE"; body?: Record<string, unknown> };
export type LinkBuild = { ok: true; request: LinkRequest } | { ok: false; error: string };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

export const CHOOSE_PROPERTY = "Choose a property first.";
export const CHOOSE_CONTACT = "Choose a contact first.";
export const SAME_ROLE = "That is already their role.";
export const LINK_GONE = "That link couldn’t be found.";

/** The roles the phone offers: what the server accepts today, plus Owner, Landlord and Tenant once the server validates them. The agent chooses: nothing defaults. */
export function roleChoices(contract: LinkContract = MOBILE_LINK_CONTRACT): Array<{ value: LinkRole; label: string }> {
  const roles: readonly LinkRole[] = contract.expandedRolesAccepted ? [...ROLES_ACCEPTED_NOW, ...ROLES_APPROVED_PENDING] : ROLES_ACCEPTED_NOW;
  return roles.map((value) => ({ value, label: LINK_ROLE_LABELS[value] }));
}

export function linkRoleLabel(role: string): string {
  return (LINK_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

const isOffered = (role: string, contract: LinkContract): role is LinkRole => roleChoices(contract).some((r) => r.value === role);

/** A link a screen already knows about, from either side: enough to stop a repeat before the server has to. */
export interface KnownLink {
  linkId: number;
  propertyId: number;
  partyId: number;
  role: string;
}

/** Link an EXISTING contact to a property, from a contact or from a property: the same request. */
export function linkRequest(propertyId: number, partyId: number | null, role: string, known: readonly KnownLink[], contract: LinkContract = MOBILE_LINK_CONTRACT): LinkBuild {
  if (!positive(propertyId)) return { ok: false, error: CHOOSE_PROPERTY };
  if (partyId === null || !positive(partyId)) return { ok: false, error: CHOOSE_CONTACT };
  if (!isOffered(role, contract)) return { ok: false, error: LINK_ROLE_REQUIRED };
  if (known.some((k) => k.propertyId === propertyId && k.partyId === partyId && k.role === role)) return { ok: false, error: LINK_ALREADY_EXISTS };
  // partyId only: no contact fields, so no duplicate contact can be created here.
  return { ok: true, request: { path: "/parties", method: "POST", body: { propertyId, partyId, role } } };
}

/** Change a link's role. PROPOSED route; the screens keep the control off until it exists. */
export function changeRoleRequest(linkId: number, role: string, currentRole: string | null, contract: LinkContract = MOBILE_LINK_CONTRACT): LinkBuild {
  if (!positive(linkId)) return { ok: false, error: LINK_GONE };
  if (!isOffered(role, contract)) return { ok: false, error: LINK_ROLE_REQUIRED };
  if (currentRole !== null && currentRole === role) return { ok: false, error: SAME_ROLE };
  return { ok: true, request: { path: `/parties/link/${linkId}`, method: "PATCH", body: { role } } };
}

/** Make this the property's primary contact. PROPOSED route: at most one primary per (property, role); the server clears the others in the same transaction. */
export function setPrimaryRequest(linkId: number): LinkBuild {
  if (!positive(linkId)) return { ok: false, error: LINK_GONE };
  return { ok: true, request: { path: `/parties/link/${linkId}`, method: "PATCH", body: { isPrimary: true } } };
}

/** Remove the link only. The contact and the property stay. */
export function unlinkRequest(linkId: number): LinkBuild {
  if (!positive(linkId)) return { ok: false, error: LINK_GONE };
  return { ok: true, request: { path: `/parties/link/${linkId}`, method: "DELETE" } };
}

export function canonicalContactLinksPath(partyId: number): string {
  return `/parties/by-contact/${partyId}`;
}

/** One property link of a contact, as the proposed GET /parties/by-contact/:partyId returns it. */
export interface CanonicalContactLink {
  linkId: number;
  role: string;
  isPrimary: boolean;
  propertyId: number;
  address: string;
}

/** Reads the proposed response defensively: a row that is not what the contract says is dropped, never guessed. */
export function parseContactLinks(data: unknown): CanonicalContactLink[] {
  const rows = typeof data === "object" && data !== null && Array.isArray((data as { links?: unknown }).links) ? (data as { links: unknown[] }).links : [];
  const out: CanonicalContactLink[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const property = typeof r.property === "object" && r.property !== null ? (r.property as Record<string, unknown>) : null;
    if (!positive(r.linkId) || typeof r.role !== "string" || property === null || !positive(property.id)) continue;
    out.push({ linkId: r.linkId, role: r.role, isPrimary: r.isPrimary === true, propertyId: property.id, address: typeof property.formattedAddress === "string" && property.formattedAddress.trim() ? property.formattedAddress.trim() : `Property ${property.id}` });
  }
  return out;
}

export function unlinkConfirmText(contactName: string, propertyLabel: string): string {
  return `Unlink ${contactName} from ${propertyLabel}? This ends the link. The contact and the property stay.`;
}

/** A plain sentence for a failed link, role change or unlink. Never a status code or a raw server message. */
export function linkingFailureText(error: { status?: number } | null | undefined, fallback: string): string {
  return linkFailureText(error ?? null, fallback);
}
