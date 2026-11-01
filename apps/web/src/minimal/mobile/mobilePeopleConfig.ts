// AE Mobile (CC Task #64, M4): fixed settings for the phone People list and Contact 360. No React, no network.

/**
 * Server catalogue keys (packages/db/src/schema/billing.ts ENTITLEMENT_KEYS). The web package cannot
 * import @aee/db, so lib/__tests__/minimalMobilePeopleSource.test.ts keeps these strings in step with
 * the catalogue. Display only: they decide which buttons to offer. The API enforces every one.
 */
export const GROW_ACTIVITIES_MANAGE = "grow.activities.manage";
/** May read contacts: with Run access, who may be called from a property page. Display only; the server decides what is returned. */
export const GROW_CONTACTS_READ = "grow.contacts.read";
export const GROW_IMPORT_EXECUTE = "grow.import.execute";

/** Contacts per page on a phone. */
export const PEOPLE_PAGE_SIZE = 25;

/**
 * The Grow section bar stays on the phone People list and Contact 360 until its destinations are
 * verified and listed in More (specification decision 3). Flip it, and its test, together.
 */
export const MOBILE_PEOPLE_SHOWS_GROW_SECTIONS = true;

/** The server's own ceiling for a commitment description and an activity summary. */
export const CONTACT_TEXT_MAX = 2000;

/**
 * How a contact relates to a property, in the words the Contact 360 "Link property" form already uses
 * (pages/Grow.tsx GROW_PROPERTY_RELATIONSHIP_OPTIONS, a hand-mirror of GROW_RELATIONSHIP_TYPES). The stored
 * value is snake_case ("co_owner"); a phone shows "Co-owner". lib/__tests__/minimalMobilePeopleSource.test.ts
 * reads that file and fails if the two drift.
 */
export const PROPERTY_RELATIONSHIP_LABELS: Readonly<Record<string, string>> = {
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

/** Timeline lines shown before "Show all". */
export const HISTORY_VISIBLE = 6;
