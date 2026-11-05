// AE Mobile (CC Task #64, M4 linking): which contact and property link controls the phone may enable. No React, no network.
//
// DECISION (owner, 1 Nov 2026): person-to-property links live on `property_parties`, and nowhere else. Contact 360 and the
// property page use the SAME operations on the SAME table. There is no read-side union and no dual write.

/** Server catalogue keys (packages/db/src/schema/billing.ts ENTITLEMENT_KEYS); a test keeps these in step. Display only: the API enforces every one. */
export const GROW_RELATIONSHIPS_MANAGE = "grow.relationships.manage";
export const GROW_PROPERTIES_LINK = "grow.properties.link";

export interface LinkingFlags {
  /** Contact 360: link an existing property. POST /parties (the property page's own route). */
  contactLinkProperty: boolean;
  /** Contact 360: change the role on a link. PATCH /parties/link/:linkId. PROPOSED: the route does not exist yet. */
  contactEditRole: boolean;
  /** Contact 360: remove a link. DELETE /parties/link/:linkId. */
  contactUnlink: boolean;
  /** Contact 360: make this contact the property's primary contact. PATCH /parties/link/:linkId {isPrimary:true}. PROPOSED. */
  contactEditPrimary: boolean;
  /** Contact 360 reads its property links from property_parties. GET /parties/by-contact/:partyId. PROPOSED: does not exist yet. */
  contactCanonicalRead: boolean;
  /** Property: link an existing contact. POST /parties with a partyId. */
  propertyLinkContact: boolean;
  /** Property: change the role on a link. PATCH /parties/link/:linkId. PROPOSED. */
  propertyEditRole: boolean;
  /** Property: make a contact the property's primary contact. PATCH /parties/link/:linkId {isPrimary:true}. PROPOSED. */
  propertyEditPrimary: boolean;
  /** Property: remove a link. DELETE /parties/link/:linkId. */
  propertyUnlink: boolean;
}

/**
 * Every control is OFF. They switch on only when Grok confirms that BOTH directions are supported by the backend, securely:
 * the same four operations (read, link, change role, unlink) for a contact and for a property, each with its entitlement
 * and own-property checks. So the flags move together: a test fails if a contact-side flag and its property-side twin differ.
 * Change a value here and the test that guards it in the same pull request.
 */
export const MOBILE_LINKING: LinkingFlags = {
  contactLinkProperty: false,
  contactEditRole: false,
  contactUnlink: false,
  contactEditPrimary: false,
  contactCanonicalRead: false,
  propertyLinkContact: false,
  propertyEditRole: false,
  propertyEditPrimary: false,
  propertyUnlink: false,
};

/** Pairs that must always match: the same operation from either side. */
export const LINKING_TWINS: ReadonlyArray<readonly [keyof LinkingFlags, keyof LinkingFlags]> = [
  ["contactLinkProperty", "propertyLinkContact"],
  ["contactEditRole", "propertyEditRole"],
  ["contactUnlink", "propertyUnlink"],
  ["contactEditPrimary", "propertyEditPrimary"],
];

/** Roles `property_parties` accepts today (packages/db/src/schema/property.ts PROPERTY_PARTY_ROLES, and the zod enum in routes/parties.ts). */
export const ROLES_ACCEPTED_NOW = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;
/** The owner-approved additions. Offered only once Grok's backend validates them. */
export const ROLES_APPROVED_PENDING = ["Owner", "Landlord", "Tenant"] as const;
export type LinkRole = (typeof ROLES_ACCEPTED_NOW)[number] | (typeof ROLES_APPROVED_PENDING)[number];

export interface LinkContract {
  /** True only when the server's role list includes Owner, Landlord and Tenant. A test compares this with the real server files. */
  expandedRolesAccepted: boolean;
}
export const MOBILE_LINK_CONTRACT: LinkContract = { expandedRolesAccepted: true };

export const LINK_ROLE_LABELS: Readonly<Record<LinkRole, string>> = {
  Seller: "Seller",
  Buyer: "Buyer",
  Solicitor: "Solicitor",
  PowerOfAttorney: "Power of attorney",
  Other: "Other",
  Owner: "Owner",
  Landlord: "Landlord",
  Tenant: "Tenant",
};

/** Rows shown in a picker. */
export const LINK_PICKER_ROWS = 5;
