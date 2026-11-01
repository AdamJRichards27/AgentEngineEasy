// AE Mobile (CC Task #64, M2): fixed settings for the phone search screens. No React, no network.

/**
 * Phone-number search is NOT available. GET /grow/contacts does not match mobile numbers, and
 * nothing may assume it does until the backend change is built and verified. Flip this only
 * after that, and change the test that guards it in the same pull request.
 */
export const PHONE_SEARCH_SUPPORTED = false;

/**
 * Server catalogue key (packages/db/src/schema/billing.ts ENTITLEMENT_KEYS). No web-side
 * definition exists and @aee/db is not a web dependency, so lib/__tests__/minimalMobileSearchConfig.test.ts
 * keeps this string in step with the catalogue, as it does for grow.contacts.read in M1.
 * Display only: it decides whether to offer "Add a contact". The API enforces it.
 */
export const GROW_CONTACTS_MANAGE = "grow.contacts.manage";

export const MOBILE_SEARCH_ROUTE = "/search";
export const MOBILE_MORE_ROUTE = "/more";

/** Label under which a result opened from search is remembered for this visit. */
export const RECENT_KEY = ["mobile-search-recent"] as const;
export const RECENT_LIMIT = 5;
export const TODAY_SUGGESTION_LIMIT = 3;

export function searchPlaceholder(phoneSearchSupported: boolean): string {
  return phoneSearchSupported ? "Name, mobile, email or address" : "Name, email or address";
}

export function searchHintLine(phoneSearchSupported: boolean): string {
  return phoneSearchSupported
    ? "Try a name, a mobile number, an email, an address, a suburb or a postcode."
    : "Try a name, an email, an address, a suburb or a postcode.";
}
