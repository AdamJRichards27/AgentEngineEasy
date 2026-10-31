import { GROW_TABS, growTabHref, growWorkspaceEntryState, isGrowContactPath, type GrowTab } from "../lib/growWorkspace";

// AE Minimal A: which screen /grow shows, and the Grow section nav.
// Today and Contacts have Minimal screens. Every other Grow section
// (Opportunities, Nurture, Performance, Ask AE) renders the classic Grow
// workspace inside the Minimal shell until it has a Minimal screen, so
// nothing a classic user can reach is hidden from a Minimal user.

export type MinimalGrowView = "minimal-today" | "minimal-contacts" | "classic";

export function selectGrowView(minimalShell: boolean, search: string): MinimalGrowView {
  if (!minimalShell) return "classic";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("view") === "full") return "classic";
  const entry = growWorkspaceEntryState(search);
  // A legacy ?contact= link is rewritten to /grow/contacts/:id by the classic workspace.
  if (entry.contactPartyId !== null) return "classic";
  if (entry.tab === "today") return "minimal-today";
  if (entry.tab === "contacts") return "minimal-contacts";
  return "classic";
}

export interface MinimalGrowSection {
  key: GrowTab;
  label: string;
  href: string;
}

export const MINIMAL_GROW_SECTIONS: readonly MinimalGrowSection[] = GROW_TABS.map((t) => ({
  key: t.key,
  label: t.label,
  href: growTabHref(t.key),
}));

/** The full classic contacts workspace (new contact form, relationships, activity) from the Minimal shell. */
export const MINIMAL_CONTACTS_FULL_HREF = "/grow?tab=contacts&view=full";

export function minimalGrowSectionFor(pathname: string, search: string): GrowTab {
  if (isGrowContactPath(pathname)) return "contacts";
  return growWorkspaceEntryState(search).tab;
}
