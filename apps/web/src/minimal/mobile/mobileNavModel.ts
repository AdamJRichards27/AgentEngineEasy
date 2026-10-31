import { RUN_ACCESS, buildMinimalSidebar, minimalSidebarIsCurrent, minimalSidebarLinks } from "../minimalNav";
import { mobilePermissions } from "./mobilePermissions";

// AE Mobile (CC Task #64, M1): the four primary mobile tabs (Today, People,
// Properties, Search) and the "More" list. Pure logic: no React, no network,
// no storage. M2 renders it.
//
// Owner t217u: the four tabs show for every signed-in brokerage user (Grow is
// always visible). "More" is grouped Grow / Run / Account. Its links still come
// from buildMinimalSidebar (labels, order, the Market Activity / My Momentum
// availability flags and the Financial / Pit Crew role rules are not
// re-derived), but Run links are offered only when mobilePermissions().run
// (run.access AND a brokerage role). Grow-only users get one "Upgrade to Run"
// entry in Account instead.
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

export type MobileMoreGroupKey = "grow" | "run" | "account";

export interface MobileMoreGroup {
  key: MobileMoreGroupKey;
  label: string;
  items: MobileMoreItem[];
}

export interface MobileNav {
  tabs: MobileNavTab[];
  /** Every More item, flattened from moreGroups in order (for current-page matching). */
  more: MobileMoreItem[];
  /** More, grouped Grow / Run / Account. Empty groups are omitted. */
  moreGroups: MobileMoreGroup[];
  /** The single "Upgrade to Run" entry (also listed in the Account group), or null. */
  upgrade: MobileMoreItem | null;
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

/** Each More group shows at most this many items, so More stays short (at most 3 groups). */
export const MOBILE_MORE_GROUP_MAX_ITEMS = 5;

/**
 * PLACEHOLDER (t217u): there is no plan/upgrade page in the web app yet, so the upgrade
 * entry opens Settings with a marker query. Replace when a plan page exists. No pricing here.
 */
export const RUN_UPGRADE_HREF = "/settings?upgrade=run";
export const RUN_UPGRADE_LABEL = "Upgrade to Run";

const ACCOUNT_HREFS: ReadonlySet<string> = new Set(["/settings"]);

export function buildMobileNav(input: MobileNavInput): MobileNav {
  if (input.ownerWithoutContext || input.entitlementsLoading || !Array.isArray(input.entitlements)) {
    return { tabs: [], more: [], moreGroups: [], upgrade: null };
  }
  const entitlements: string[] = [...input.entitlements];
  const perms = mobilePermissions(entitlements, input.role);

  const tabs: MobileNavTab[] = [];
  if (perms.today) tabs.push({ key: "today", label: "Today", href: TODAY_HREF, action: null });
  if (perms.people) tabs.push({ key: "people", label: MOBILE_PEOPLE_LABEL, href: PEOPLE_HREF, action: null });
  if (perms.properties) tabs.push({ key: "properties", label: "Properties", href: PROPERTIES_HREF, action: null });
  if (perms.search) tabs.push({ key: "search", label: "Search", href: null, action: "open-search" });

  // The sidebar only offers Run links with run.access; drop it unless the role may use Run too.
  const sidebarEntitlements = perms.run ? entitlements : entitlements.filter((e) => e !== RUN_ACCESS);
  const groups = buildMinimalSidebar({
    role: input.role,
    entitlements: sidebarEntitlements,
    marketActivityAvailable: input.marketActivityAvailable === true,
    momentumAvailable: input.momentumAvailable === true,
  });
  const toItem = (l: { href: string; label: string; path: string }): MobileMoreItem => ({ key: l.href, label: l.label, href: l.href, path: l.path });
  const growItems: MobileMoreItem[] = [];
  const runItems: MobileMoreItem[] = [];
  const accountItems: MobileMoreItem[] = [];
  for (const g of groups) {
    for (const l of minimalSidebarLinks([g])) {
      if (PRIMARY_HREFS.has(l.href) || l.href === START_PROPERTY_HREF) continue;
      if (ACCOUNT_HREFS.has(l.href)) accountItems.push(toItem(l));
      else if (g.key === "operations") {
        if (perms.run) runItems.push(toItem(l));
      } else growItems.push(toItem(l)); // Grow group, plus Communications (a Grow feature)
    }
  }
  const upgrade: MobileMoreItem | null = perms.upgradeToRun
    ? { key: "upgrade-run", label: RUN_UPGRADE_LABEL, href: RUN_UPGRADE_HREF, path: "/settings" }
    : null;
  if (upgrade) accountItems.push(upgrade);

  const moreGroups: MobileMoreGroup[] = (
    [
      { key: "grow", label: "Grow", items: growItems },
      { key: "run", label: "Run", items: runItems },
      { key: "account", label: "Account", items: accountItems },
    ] as MobileMoreGroup[]
  )
    .map((g) => ({ ...g, items: g.items.slice(0, MOBILE_MORE_GROUP_MAX_ITEMS) }))
    .filter((g) => g.items.length > 0);

  return { tabs, more: moreGroups.flatMap((g) => g.items), moreGroups, upgrade };
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
