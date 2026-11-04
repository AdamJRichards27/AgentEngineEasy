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
/** The AI entitlement that governs Ask AE and the Business Coach (packages/db ENTITLEMENT_KEYS). */
export const GROW_AI_USE = "grow.ai.use";
/** The role the agent tools (Ask AE, Business Coach) belong to. A Brokerage Administrator or Pit Crew does not inherit it. */
export const AGENT_ROLE = "Agent";
/**
 * The Grow keys that let a user CHANGE something. A user who holds none of them is read-only on the phone. This is a display inference from the keys
 * the server resolves; the server's own definition of "read-only" is Grok's (see the hand-off), and the API enforces every request regardless.
 */
export const GROW_WRITE_KEYS: readonly string[] = ["grow.contacts.manage", "grow.activities.manage", "grow.relationships.manage", "grow.opportunities.manage"];

export function isReadOnlyUser(entitlements: readonly string[] | null | undefined): boolean {
  return !Array.isArray(entitlements) || !GROW_WRITE_KEYS.some((k) => entitlements.includes(k));
}

/**
 * Who is offered the agent tools (Ask AE and the Business Coach) in More: an AGENT (the role itself, never inherited by a Brokerage Administrator or
 * Pit Crew), who holds grow.ai.use, and who is not read-only. Fails closed: no role, no list or an unknown role gives nothing. Display only: the AI
 * routes enforce grow.ai.use and the deployment flags; enforcing the AGENT role there is a backend matter.
 */
export function agentToolsOffered(entitlements: readonly string[] | null | undefined, role: string | null | undefined): boolean {
  return role === AGENT_ROLE && Array.isArray(entitlements) && entitlements.includes(GROW_AI_USE) && !isReadOnlyUser(entitlements);
}

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
  /** Grow subscriber without run.access: show the single "Add Run" offer (t222u: not unsubscribed, not Run). */
  upgradeToRun: boolean;
  /** More: Business Coach. Agents only (see agentToolsOffered). */
  businessCoach: boolean;
  /** More: Ask AE. Agents only (see agentToolsOffered). */
  askAe: boolean;
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
  businessCoach: false,
  askAe: false,
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
    upgradeToRun: !runSubscribed && hasEntitlement(ctx, GROW_ACCESS),
    businessCoach: agentToolsOffered(entitlements, role),
    askAe: agentToolsOffered(entitlements, role),
  };
}
