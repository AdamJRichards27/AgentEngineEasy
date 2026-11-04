import { builtRelationshipControlGroup } from "../../lib/relationshipControlFlags";
import { GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, LINK_ROLE_LABELS, MOBILE_LINKING, MOBILE_LINK_CONTRACT, ROLES_ACCEPTED_NOW, ROLES_APPROVED_PENDING, type LinkContract, type LinkRole, type LinkingFlags } from "./mobileLinkingConfig";
import { canManageRelationships } from "../../lib/relationshipPermission";
import { LINK_ALREADY_EXISTS, LINK_ROLE_REQUIRED, linkFailureText } from "../properties/minimalPropertyContactsModel";
import type { CanonicalLinkLike } from "./mobileGrowInterest";

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

/**
 * Off unless the backend is ready (flag) AND the user may do it. Fails closed on a missing entitlement list.
 * "May manage relationships" is the SHARED rule (lib/relationshipPermission.ts: the key, or run.access for an Agent or Brokerage Administrator;
 * run.access alone, such as Pit Crew, is not enough), the same rule the server enforces on the canonical routes: it is not re-derived from a raw
 * key. Any OTHER key an action needs (grow.properties.link for contactLinkProperty) is still required as before.
 */
export function linkingCapabilities(entitlements: readonly string[] | null | undefined, flags: LinkingFlags = builtRelationshipControlGroup().mobile, role?: string | null): LinkingCapabilities {
  const out = {} as LinkingCapabilities;
  const has = (key: string) => Array.isArray(entitlements) && entitlements.includes(key);
  for (const action of Object.keys(NEEDS) as LinkingAction[]) {
    if (!flags[action]) {
      out[action] = { enabled: false, reason: NOT_AVAILABLE_YET };
      continue;
    }
    const held = Array.isArray(entitlements) && NEEDS[action].every((key) => (key === GROW_RELATIONSHIPS_MANAGE ? canManageRelationships(has, role) : has(key)));
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

/** What the by-contact response says about itself, so the screen can SAY when it shows less than there is. */
export interface ContactLinksResult {
  links: CanonicalContactLink[];
  /** The server capped `links`. */
  truncated: boolean;
  /** The server's count of ALL links this caller may see. Null when absent or not believable (smaller than what was shown). */
  total: number | null;
  limit: number | null;
  /** Rows the phone could not read: counted, never dropped silently. */
  skipped: number;
  /**
   * EVERY property link this caller may see, as (propertyId, role) and nothing else, from the response's uncapped `properties[]` (the same
   * list the desktop reads). Used ONLY to decide "Also listed under Properties", so that result never depends on the 100-link display cap.
   * Null when the response does not carry the list (an older server): matching then falls back to the capped `links`.
   */
  matchLinks: CanonicalLinkLike[] | null;
}

/**
 * Reads the uncapped `properties[]` rows defensively, keeping ONLY propertyId and role. Nothing else in a row (address, dates, ids) is kept,
 * so the matching set carries no more than the capped list already shows. A malformed row is dropped; a non-array gives null.
 */
export function parsePropertyMatchLinks(data: unknown): CanonicalLinkLike[] | null {
  const rows = typeof data === "object" && data !== null ? (data as Record<string, unknown>).properties : undefined;
  if (!Array.isArray(rows)) return null;
  const out: CanonicalLinkLike[] = [];
  for (const r of rows) {
    const row = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : null;
    if (row && positive(row.propertyId) && typeof row.role === "string" && row.role.trim().length > 0) out.push({ propertyId: row.propertyId, role: row.role.trim() });
  }
  return out;
}

export function parseContactLinksResult(data: unknown): ContactLinksResult {
  const obj = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const raw = Array.isArray(obj.links) ? obj.links.length : 0;
  const links = parseContactLinks(data);
  const wholeNumber = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
  return {
    links,
    truncated: obj.truncated === true,
    total: wholeNumber(obj.total) && obj.total >= links.length ? obj.total : null,
    limit: positive(obj.limit) ? obj.limit : null,
    skipped: raw - links.length,
    matchLinks: parsePropertyMatchLinks(data),
  };
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

