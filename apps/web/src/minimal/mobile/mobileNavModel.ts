import { buildMinimalSidebar, minimalSidebarIsCurrent, minimalSidebarLinks } from "../minimalNav";
import { mobilePermissions } from "./mobilePermissions";

// AE Mobile (CC Task #64, M1): the four primary mobile tabs (Today, People,
// Properties, Search) and the "More" list. Pure logic: no React, no network,
// no storage. M2 renders it.
//
// "More" is never re-derived. It is every clickable link buildMinimalSidebar
// already produced for this user, in its existing order, minus the primary
// destinations. Run, Financial and Pit Crew visibility therefore stays exactly
// as the desktop shell decides it, including the desktop's own parity rules
// (Grow pages stay listed so the locked/upgrade screen stays reachable).
//
// Search has no route yet (its screen is M2), so it is an action tab.

export type MobileTabKey = "today" | "people" | "properties" | "search";

export interface MobileNavTab {
  key: MobileTabKey;
  label: string;
  /** Destination for link tabs. Null for the Search action tab. */
  href: string | null;
  /** Set only on the Search tab; the screen decides what opening search means. */
  action: "open-search" | null;
}

export interface MobileMoreItem {
  key: string;
  label: string;
  href: string;
  path: string;
}

export interface MobileNav {
  tabs: MobileNavTab[];
  more: MobileMoreItem[];
}

export interface MobileNavInput {
  role: string | undefined;
  entitlements: readonly string[] | null | undefined;
  /** True while the entitlement query is still running. Fails closed. */
  entitlementsLoading?: boolean;
  /** Platform owner with no brokerage selected. The shell shows no nav for them. */
  ownerWithoutContext?: boolean;
  /** Same flags buildMinimalSidebar already takes (cached query succeeded). */
  marketActivityAvailable?: boolean;
  momentumAvailable?: boolean;
}

/** Mobile wording only. The desktop sidebar still says "Relationships". */
export const MOBILE_PEOPLE_LABEL = "People";
export const MOBILE_MORE_LABEL = "More";

const TODAY_HREF = "/grow";
const PEOPLE_HREF = "/grow?tab=contacts";
const PROPERTIES_HREF = "/properties";
/** Sidebar-only today, and left out of the current mobile bar. Kept out of "More" for parity. */
const START_PROPERTY_HREF = "/properties/start";
const PRIMARY_HREFS: ReadonlySet<string> = new Set([TODAY_HREF, PEOPLE_HREF, PROPERTIES_HREF]);

export function buildMobileNav(input: MobileNavInput): MobileNav {
  if (input.ownerWithoutContext || input.entitlementsLoading || !Array.isArray(input.entitlements)) {
    return { tabs: [], more: [] };
  }
  const entitlements: string[] = [...input.entitlements];
  const perms = mobilePermissions(entitlements);

  const tabs: MobileNavTab[] = [];
  if (perms.today) tabs.push({ key: "today", label: "Today", href: TODAY_HREF, action: null });
  if (perms.people) tabs.push({ key: "people", label: MOBILE_PEOPLE_LABEL, href: PEOPLE_HREF, action: null });
  if (perms.properties) tabs.push({ key: "properties", label: "Properties", href: PROPERTIES_HREF, action: null });
  if (perms.search) tabs.push({ key: "search", label: "Search", href: null, action: "open-search" });

  const groups = buildMinimalSidebar({
    role: input.role,
    entitlements,
    marketActivityAvailable: input.marketActivityAvailable === true,
    momentumAvailable: input.momentumAvailable === true,
  });
  const more = minimalSidebarLinks(groups)
    .filter((l) => !PRIMARY_HREFS.has(l.href) && l.href !== START_PROPERTY_HREF)
    .map((l) => ({ key: l.href, label: l.label, href: l.href, path: l.path }));

  return { tabs, more };
}

/** Same matcher the desktop sidebar uses, so a tab is current exactly where its sidebar link is. */
export function mobileTabIsCurrent(tab: MobileNavTab, location: string, search: string): boolean {
  if (tab.href === null) return false;
  return minimalSidebarIsCurrent(location, search, tab.href);
}

/** True when the current page belongs to a "More" item, so the More button can show as current. */
export function mobileMoreIsCurrent(more: readonly MobileMoreItem[], location: string, search: string): boolean {
  return more.some((item) => minimalSidebarIsCurrent(location, search, item.href));
}
