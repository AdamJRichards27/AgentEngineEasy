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
  { key: "performance", label: "Performance" },
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

// ── Data regions (WP6b D6) ──────────────────────────────────────────────

export type GrowDataRegionState = "loading" | "error" | "empty" | "ready";

export interface GrowDataRegionQuery {
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
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
export function contactsEmptyMessage(search: string): string {
  const term = search.trim();
  return term.length > 0
    ? `No contacts match “${term}”. Try a different name, organisation, or email.`
    : "No contacts yet — import contacts and properties to get started.";
}
