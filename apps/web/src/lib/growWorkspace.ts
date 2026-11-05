import { formatSupportReference } from "./api";

// AE GROW Pilot Readiness WP6b — pure logic behind pages/Grow.tsx's tabbed
// workspace and its data regions (components/GrowDataRegion.tsx), kept here so
// it is unit-testable with `tsx --test` and free of React.
//
// The defect this exists to fix (WP6b D6): with the API down — or after a 401
// — Opportunities / Contacts / Relationships / Recent activity each rendered
// *nothing at all*, because every one of those sections only ever branched on
// `isLoading` and `data.length === 0`. An error left `data` undefined, so the
// empty branch was false and the table branch was false: the agent saw an
// empty card and could not tell "there is no data" from "we couldn't load it".
// growDataRegionState below makes that a single, total decision with an
// explicit error case, mirroring how Today and Contact 360 already read their
// query's error state.

export type GrowTab = "today" | "opportunities" | "contacts" | "nurture" | "performance" | "askAE";

export const GROW_TABS: Array<{ key: GrowTab; label: string }> = [
  { key: "today", label: "Today" },
  { key: "opportunities", label: "Opportunities" },
  { key: "contacts", label: "Contacts" },
  { key: "nurture", label: "Nurture" },
  { key: "performance", label: "Business Coach" }, // t222u: renamed from "Performance" (AI Business Coach)
  { key: "askAE", label: "Ask AE" },
];

export function growTabLabel(tab: GrowTab): string {
  return GROW_TABS.find((entry) => entry.key === tab)?.label ?? "Grow";
}

// ── Tab navigation (WP6b P3-e) ──────────────────────────────────────────
// The Contacts tab owns two views: the contact list and one open Contact 360.
// Clicking the *tab* is the agent asking for the tab's own landing view, so it
// must return to the list — previously the tab button only set `tab`, which was
// already "contacts", leaving the open contact on screen and the click looking
// broken. Jumping in from a Grow Today card (viewContact/emailContact) is a
// different path and still opens a contact directly; only this reducer, wired
// to the tab bar, resets. Any pending "open the composer" request is cleared at
// the same time so it can never fire against a contact that is no longer shown.

export interface GrowWorkspaceNavState {
  tab: GrowTab;
  contactPartyId: number | null;
  pendingComposeChannel: "EMAIL" | "SMS" | null;
}

export function growTabClickState(next: GrowTab, current: GrowWorkspaceNavState): GrowWorkspaceNavState {
  if (next !== "contacts") return { ...current, tab: next };
  return { tab: next, contactPartyId: null, pendingComposeChannel: null };
}

// Contact 360's own address. Opening a contact pushes this path so the
// browser Back button returns to the Grow view that was open before it.
// Old links still use ?contact=; canonicalGrowContactHref turns those into
// this path without adding a history entry.

const GROW_CONTACT_PATH = /^\/grow\/contacts\/([^/]+)$/;

export function growTabHref(tab: GrowTab): string {
  return tab === "today" ? "/grow" : `/grow?tab=${tab}`;
}

export function growContactPath(partyId: number, compose?: "EMAIL" | "SMS" | null): string {
  const path = `/grow/contacts/${partyId}`;
  if (compose === "EMAIL") return `${path}?compose=email`;
  if (compose === "SMS") return `${path}?compose=sms`;
  return path;
}

export function growContactPathSegment(path: string): string | null {
  const bare = path.split("?")[0].split("#")[0];
  const match = GROW_CONTACT_PATH.exec(bare);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Positive integer id, or null when the path is not a contact or the id is not a real one. */
export function growContactIdFromPath(path: string): number | null {
  const segment = growContactPathSegment(path);
  if (segment === null || !/^[1-9][0-9]*$/.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) ? id : null;
}

export function isGrowContactPath(path: string): boolean {
  return growContactPathSegment(path) !== null;
}

/**
 * Where /grow?tab=&contact= should open. A contact id forces the Contacts
 * tab, because that is the only tab that renders Contact 360. Junk values
 * leave the workspace on Today.
 */
export function growWorkspaceEntryState(search: string): { tab: GrowTab; contactPartyId: number | null } {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawContact = params.get("contact");
  const contactId = rawContact !== null && /^[1-9][0-9]*$/.test(rawContact) ? Number(rawContact) : null;
  const rawTab = params.get("tab");
  const tab = GROW_TABS.find((t) => t.key === rawTab)?.key ?? (contactId !== null ? "contacts" : "today");
  return contactId !== null ? { tab: "contacts", contactPartyId: contactId } : { tab, contactPartyId: null };
}

/** Href to replace a legacy ?contact= link with, or null when the URL is already canonical. */
export function canonicalGrowContactHref(path: string, search: string): string | null {
  if (isGrowContactPath(path)) return null;
  const contactId = growWorkspaceEntryState(search).contactPartyId;
  return contactId === null ? null : growContactPath(contactId);
}

export function growComposeChannelFromSearch(search: string): "EMAIL" | "SMS" | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const raw = params.get("compose")?.toLowerCase();
  if (raw === "email") return "EMAIL";
  if (raw === "sms") return "SMS";
  return null;
}

export interface GrowHistory {
  readonly state: unknown;
  pushState: (state: unknown, title: string, url?: string | null) => void;
  replaceState: (state: unknown, title: string, url?: string | null) => void;
}

/** Push when leaving Contact 360 so Back returns to it; replace when only the tab changes. */
export function growNavigationMode(pathname: string): "push" | "replace" {
  return isGrowContactPath(pathname) ? "push" : "replace";
}

export function applyGrowNavigation(history: GrowHistory, href: string, mode: "push" | "replace"): void {
  const state = history.state;
  if (mode === "replace") history.replaceState(state, "", href);
  else history.pushState(state, "", href);
}

// One queued rewrite at a time, so a render that still sees the old query
// string does not schedule the replacement on every pass.
let queuedCanonicalHref: string | null = null;

export function queueCanonicalGrowContactRedirect(href: string): void {
  if (typeof window === "undefined") return;
  if (queuedCanonicalHref === href) return;
  queuedCanonicalHref = href;
  queueMicrotask(() => {
    queuedCanonicalHref = null;
    if (growContactIdFromPath(window.location.pathname) !== null) return;
    if (canonicalGrowContactHref(window.location.pathname, window.location.search) !== href) return;
    applyGrowNavigation(window.history, href, "replace");
  });
}

// ── Data regions (WP6b D6) ──────────────────────────────────────────────

export type GrowDataRegionState = "loading" | "error" | "empty" | "ready";

export interface GrowDataRegionQuery {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  /** True while a refetch or a new filter is in flight. */
  isFetching?: boolean;
  /** True when `data` is still the previous filter's result. */
  isPlaceholderData?: boolean;
}

/**
 * The one state a data region is in. `itemCount` is the number of rows the
 * region would render, or null/undefined when the response hasn't arrived.
 * A failure wins over everything else: a region that failed must never be
 * silently presented as empty.
 */
export function growDataRegionState(query: GrowDataRegionQuery, itemCount: number | null | undefined): GrowDataRegionState {
  if (query.isError) return "error";
  if (query.isLoading || itemCount === null || itemCount === undefined) return "loading";
  // A filter that has not produced rows yet must not keep the previous
  // "nothing matched …" sentence above the next result.
  if ((query.isFetching || query.isPlaceholderData) && itemCount === 0) return "loading";
  return itemCount === 0 ? "empty" : "ready";
}

export interface GrowDataRegionError {
  message: string;
  // "Reference: 1a2b3c4d" — only when the failure carries a server correlation
  // id and the humanised message doesn't already quote it (humanizeApiError
  // appends it itself for 5xx).
  reference?: string;
}

// Read structurally rather than with `instanceof ApiError` so this stays a
// pure function over a plain error shape (the same approach lib/errorBoundary
// .ts takes for correlationIdOf).
function friendlyOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const friendly = (error as { friendly?: unknown }).friendly;
  return typeof friendly === "string" && friendly.trim() ? friendly : undefined;
}

function correlationIdOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const id = (error as { correlationId?: unknown }).correlationId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

export function growDataRegionError(error: unknown, fallback: string): GrowDataRegionError {
  const message = friendlyOf(error) ?? fallback;
  const reference = formatSupportReference(correlationIdOf(error));
  if (reference === undefined || message.includes(reference)) return { message };
  return { message, reference };
}

// ── Empty-state copy (WP6b D6) ──────────────────────────────────────────
// "No contacts found." was shown both for a brokerage with no contacts at all
// and for a search that matched nothing — two different situations with two
// different next steps.
export function contactsEmptyMessage(search: string, role?: string): string {
  const term = search.trim();
  const roleName = typeof role === "string" ? role.trim() : "";
  if (term.length > 0 && roleName.length > 0) {
    return `No contacts match “${term}” with the ${roleName} role. Try a different name, organisation, email, or role.`;
  }
  if (roleName.length > 0) return `No contacts with the ${roleName} role.`;
  return term.length > 0
    ? `No contacts match “${term}”. Try a different name, organisation, or email.`
    : "No contacts yet — import contacts and properties to get started.";
}
