import { Link } from "wouter";
import { MOBILE_MORE_LABEL, mobileMoreIsCurrent, mobileTabIsCurrent, type MobileNav, type MobileNavTab } from "./mobileNavModel";
import { MOBILE_MORE_ROUTE, MOBILE_SEARCH_ROUTE } from "./mobileSearchConfig";

// AE Mobile (CC Task #64, M2): the bottom bar. Today, People, Properties, Search, then More. It
// draws whatever the corrected PR #280 navigation model returns: Grow is always visible, so the four
// tabs are the same for everyone; entitlements only change what More holds. Presentational: no hooks,
// no network. Shown on phones only (mobile.css).

function TabIcon({ tab }: { tab: string }) {
  const common = { viewBox: "0 0 24 24", width: 22, height: 22, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (tab) {
    case "today":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="17" rx="3" />
          <path d="M8 2v4M16 2v4M3 10h18M9 15l2 2 4-4" />
        </svg>
      );
    case "people":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
          <circle cx="17" cy="9" r="2.5" />
          <path d="M17 14c2.8 0 4.5 1.8 4.5 4.5" />
        </svg>
      );
    case "properties":
      return (
        <svg {...common}>
          <path d="M3 11l9-7 9 7" />
          <path d="M5 10v10h14V10" />
          <path d="M10 20v-6h4v6" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width={22} height={22} fill="currentColor" aria-hidden={true}>
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      );
  }
}

function tabHref(tab: MobileNavTab): string {
  return tab.action === "open-search" || tab.href === null ? MOBILE_SEARCH_ROUTE : tab.href;
}

function tabCurrent(tab: MobileNavTab, location: string, search: string): boolean {
  if (tab.action === "open-search") return location.split("?")[0] === MOBILE_SEARCH_ROUTE;
  return mobileTabIsCurrent(tab, location, search);
}

export function MobileBottomBar({ nav, location, search }: { nav: MobileNav; location: string; search: string }) {
  if (nav.tabs.length === 0) return null;
  const moreCurrent = location.split("?")[0] === MOBILE_MORE_ROUTE || mobileMoreIsCurrent(nav.more, location, search);
  return (
    <nav className="mob-bar" aria-label="Primary">
      {nav.tabs.map((tab) => {
        const current = tabCurrent(tab, location, search);
        return (
          <Link key={tab.key} href={tabHref(tab)} className={current ? "is-current" : undefined} aria-current={current ? "page" : undefined}>
            <TabIcon tab={tab.key} />
            {tab.label}
          </Link>
        );
      })}
      <Link href={MOBILE_MORE_ROUTE} className={moreCurrent ? "is-current" : undefined} aria-current={moreCurrent ? "page" : undefined}>
        <TabIcon tab="more" />
        {MOBILE_MORE_LABEL}
      </Link>
    </nav>
  );
}
