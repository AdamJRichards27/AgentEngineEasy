import { hasEntitlement } from "../../lib/productNav";
import { GROW_ACCESS, minimalHasRunAccess } from "../minimalNav";

// AE Mobile (CC Task #64, M1): who may see which mobile tab and run which
// search request. Pure logic: no React, no network, no storage.
//
// Reuses the existing definitions instead of copying them: hasEntitlement
// (lib/productNav), GROW_ACCESS and minimalHasRunAccess (minimal/minimalNav).
// The one key with no web-side definition is grow.contacts.read. The server
// catalogue (ENTITLEMENT_KEYS in packages/db/src/schema/billing.ts) is the
// source of truth and @aee/db is not a web dependency, so this string is kept
// in step by lib/__tests__/minimalMobilePermissions.test.ts, which reads that
// file and fails if the key is missing or renamed.
//
// This is UI gating only. The API enforces each entitlement on every request;
// nothing here is an access decision.

export const GROW_CONTACTS_READ = "grow.contacts.read";

export interface MobilePermissions {
  /** Today tab: Grow is entitled. */
  today: boolean;
  /** People tab: Grow is entitled and contacts may be read. Its destination lives in Grow. */
  people: boolean;
  /** Properties tab: Run or Grow is entitled (same rule as the desktop sidebar). */
  properties: boolean;
  /** Search tab: at least one search source is permitted. */
  search: boolean;
  /** Search may call GET /grow/contacts. */
  searchContacts: boolean;
  /** Search may call GET /properties. */
  searchProperties: boolean;
}

const NONE: MobilePermissions = {
  today: false,
  people: false,
  properties: false,
  search: false,
  searchContacts: false,
  searchProperties: false,
};

/** Fails closed: a missing or non-array entitlement list grants nothing. */
export function mobilePermissions(entitlements: readonly string[] | null | undefined): MobilePermissions {
  if (!Array.isArray(entitlements)) return { ...NONE };
  const ctx = { role: undefined, entitlements: [...entitlements] };
  const grow = hasEntitlement(ctx, GROW_ACCESS);
  const run = minimalHasRunAccess(entitlements);
  const contactsRead = hasEntitlement(ctx, GROW_CONTACTS_READ);
  const people = grow && contactsRead;
  const properties = grow || run;
  return {
    today: grow,
    people,
    properties,
    search: people || properties,
    searchContacts: people,
    searchProperties: properties,
  };
}
