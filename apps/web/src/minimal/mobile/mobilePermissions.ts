import { hasEntitlement } from "../../lib/productNav";
import { minimalHasRunAccess } from "../minimalNav";

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
// Owner t217u (31 Oct 2026): Grow is the entry point for every user and is always
// visible to a signed-in brokerage user, so the Grow tabs no longer depend on
// grow.access. Run is an optional upgrade: Run items need the run.access
// subscription entitlement AND a brokerage role (Agent, Brokerage Administrator,
// Pit Crew); per-item role rules (Financial, Pit Crew) stay in buildProductNavLinks.
// Contact search keeps its action-level permission, grow.contacts.read.
//
// This is UI gating only. The API enforces each entitlement, role and brokerage
// scope on every request; nothing here is an access decision.

export const GROW_CONTACTS_READ = "grow.contacts.read";

/** Roles that may use Run when the brokerage holds run.access (packages/db USER_ROLES). */
export const MOBILE_RUN_ROLES: readonly string[] = ["Agent", "Brokerage Administrator", "Pit Crew"];

export interface MobilePermissions {
  /** Today tab: always, for a signed-in brokerage user (Grow is always visible). */
  today: boolean;
  /** People tab: always. Contact data still needs grow.contacts.read (searchContacts, and the API). */
  people: boolean;
  /** Properties tab: always. Properties support Grow work (appraisals, opportunities) without Run. */
  properties: boolean;
  /** Search tab: always. */
  search: boolean;
  /** Search may call GET /grow/contacts (action permission grow.contacts.read). */
  searchContacts: boolean;
  /** Search may call GET /properties (Grow-safe fields only unless `run`). */
  searchProperties: boolean;
  /** Run items and Run data: run.access subscription AND a brokerage role. */
  run: boolean;
  /** Grow-only user (no run.access): show the single "Add Run" offer. */
  upgradeToRun: boolean;
}

const NONE: MobilePermissions = {
  today: false,
  people: false,
  properties: false,
  search: false,
  searchContacts: false,
  searchProperties: false,
  run: false,
  upgradeToRun: false,
};

/**
 * Fails closed: a missing or non-array entitlement list (loading, signed out, no brokerage)
 * grants nothing. A loaded list, even an empty one, is a signed-in brokerage user: Grow shows.
 */
export function mobilePermissions(entitlements: readonly string[] | null | undefined, role?: string): MobilePermissions {
  if (!Array.isArray(entitlements)) return { ...NONE };
  const ctx = { role, entitlements: [...entitlements] };
  const runSubscribed = minimalHasRunAccess(entitlements);
  const runRole = typeof role === "string" && MOBILE_RUN_ROLES.includes(role);
  return {
    today: true,
    people: true,
    properties: true,
    search: true,
    searchContacts: hasEntitlement(ctx, GROW_CONTACTS_READ),
    searchProperties: true,
    run: runSubscribed && runRole,
    upgradeToRun: !runSubscribed,
  };
}
