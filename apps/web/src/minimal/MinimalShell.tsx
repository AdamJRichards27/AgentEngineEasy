import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { focusMinimalMain, minimalPageLabel, minimalPageReady, minimalRouteKey, shouldMoveMinimalFocus } from "./minimalA11y";
import type { SessionUser } from "../lib/session";
import { useQuery } from "@tanstack/react-query";
import { MINIMAL_COMING_SOON, buildMinimalSidebar, minimalSidebarIsCurrent, minimalSidebarLinks, type MinimalSidebarItem } from "./minimalNav";
import { formatMinimalHeaderDate, minimalBreadcrumb } from "../lib/minimalUx";
import { apiFetch } from "../lib/api";
import { isFeatureHiddenError, momentumQueryPath } from "./momentum/minimalMomentumModel";
import { marketActivityQueryPath } from "./market/minimalMarketActivityModel";
import gear from "./brand/AE_Gear_Orange_Large.png";
import wordmarkDark from "./brand/AE_Wordmark_Dark.png";
import wordmarkWhite from "./brand/AE_Wordmark_White.png";
import { MinimalSidebarIcon } from "./icons";
import "./minimal.css";

// AE Minimal A shell with the v1.0 grouped sidebar (V1, Owner t457u). Same
// product routes as classic, no sample records. Run and Pit Crew show as
// non-clickable "Coming Soon" placeholders without run.access; Marketing sub-items are
// non-clickable until V7. Market Activity / My Momentum appear only when their
// flag-gated APIs answer (same cached queries as the Today cards, no retry on 404/403).

const noRetryWhenHidden = (n: number, e: unknown) => !isFeatureHiddenError(e) && n < 1;

function initials(firstName?: string, lastName?: string): string {
  return `${firstName?.[0] ?? ""}${lastName?.[0] ?? ""}`.toUpperCase() || "?";
}

export default function MinimalShell({
  user,
  entitlements,
  onSignOut,
  onClassicView,
  switching,
  switchError,
  children,
}: {
  user: SessionUser;
  entitlements: string[];
  onSignOut: () => void;
  onClassicView: () => void;
  switching: boolean;
  switchError: string | null;
  children: ReactNode;
}) {
  const [location] = useLocation();
  const search = useSearch();
  const routeKey = minimalRouteKey(location, search);
  const lastRouteKey = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const ownerWithoutContext = !!user.platformOwner && user.ownerSelectedBrokerageId == null;
  const momentum = useQuery<unknown>({
    queryKey: ["grow-momentum", "week"],
    queryFn: () => apiFetch(momentumQueryPath("week")),
    retry: noRetryWhenHidden,
    enabled: !ownerWithoutContext,
  });
  const market = useQuery<unknown>({
    queryKey: ["grow-market-activity", "week", null],
    queryFn: () => apiFetch(marketActivityQueryPath({ range: "week", type: null })),
    retry: noRetryWhenHidden,
    enabled: !ownerWithoutContext,
  });
  const groups = ownerWithoutContext
    ? []
    : buildMinimalSidebar({
        role: user.role,
        entitlements,
        marketActivityAvailable: market.isSuccess,
        momentumAvailable: momentum.isSuccess,
      });
  const links = minimalSidebarLinks(groups);
  // Start property stays a sidebar-only entry, as before; the mobile bar keeps the main sections.
  const mobileLinks = links.filter((link) => link.path !== "/properties/start");
  if (user.platformOwner) {
    groups.unshift({ key: "workspace", label: "Platform", items: [{ kind: "link", key: "/owner", path: "/owner", href: "/owner", label: "Platform Owner" }] });
    links.unshift({ path: "/owner", href: "/owner", label: "Platform Owner" });
  }
  const isCurrent = (href: string) => minimalSidebarIsCurrent(location, search, href);
  const renderItem = (item: MinimalSidebarItem, nested = false): ReactNode => {
    const children = item.children?.length ? (
      <ul className="am-nav-sub" aria-label={`${item.label} pages`}>
        {item.children.map((c) => <li key={c.key}>{renderItem(c, true)}</li>)}
      </ul>
    ) : null;
    if (item.kind === "soon") {
      return (
        <>
          <span className={`am-nav-button am-nav-soon${nested ? " am-nav-nested" : ""}`} aria-disabled="true">
            {!nested && (
              <span className="am-nav-glyph">
                <MinimalSidebarIcon name={item.icon} />
              </span>
            )}
            <span>{item.label}</span>
            <span className="am-nav-tag">{MINIMAL_COMING_SOON}</span>
          </span>
          {children}
        </>
      );
    }
    const current = isCurrent(item.href);
    return (
      <>
        <Link
          href={item.href}
          className={`am-nav-button${nested ? " am-nav-nested" : ""}${current ? " is-current" : ""}`}
          aria-current={current ? "page" : undefined}
        >
          <span className="am-nav-glyph">
            <MinimalSidebarIcon name={item.href} />
          </span>
          <span>{item.label}</span>
        </Link>
        {children}
      </>
    );
  };
  const crumb = minimalBreadcrumb(location, links);
  const dateLabel = formatMinimalHeaderDate(new Date());
  const pageLabel = minimalPageLabel(location, search, crumb.page);
  const pageName = pageLabel === crumb.section ? crumb.section : `${crumb.section}, ${pageLabel}`;

  // After a client-side route change, move focus to the new page's heading and
  // announce it. Pages are lazy chunks, so wait (up to ~1s) for the heading.
  useEffect(() => {
    const previous = lastRouteKey.current;
    lastRouteKey.current = routeKey;
    if (!shouldMoveMinimalFocus(previous, routeKey)) return;
    setAnnouncement(pageName);
    // Wait for the lazy page to render (no Suspense line, a visible <h1>), focus
    // its heading, and retry if focus did not stick (the element was replaced).
    let frames = 0;
    let watchUntil = 0;
    let handle = 0;
    const tryFocus = () => {
      frames += 1;
      const active = document.activeElement;
      const holding = active !== null && active !== document.body && active.isConnected;
      if (watchUntil > 0) {
        // Focus was placed: keep it on the page if the element is swapped out, then stop.
        if (!holding) focusMinimalMain(document);
        if (frames >= watchUntil) return;
      } else if (minimalPageReady(document) || frames >= 90) {
        focusMinimalMain(document);
        watchUntil = frames + 20;
      }
      handle = window.requestAnimationFrame(tryFocus);
    };
    handle = window.requestAnimationFrame(tryFocus);
    return () => window.cancelAnimationFrame(handle);
  }, [routeKey, pageName]);

  return (
    <div className="ae-minimal" data-ae-ux="minimal">
      <a className="am-skip-link" href="#ae-main-workspace">Skip to main content</a>
      <p className="am-sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      <div className="am-shell">
        <aside className="am-sidebar" aria-label="Primary navigation">
          <div className="am-brand" role="img" aria-label="Agent Engine">
            <img className="am-brand-gear" src={gear} alt="" />
            <span className="am-brand-wordmark-clip" aria-hidden="true">
              <img className="am-brand-wordmark" src={wordmarkWhite} alt="" />
            </span>
          </div>
          <nav className="am-nav" aria-label="Primary">
            {groups.map((group) => (
              <div className="am-nav-group" key={`${group.key}-${group.label}`} role="group" aria-labelledby={`am-nav-group-${group.label.toLowerCase()}`}>
                <p className="am-nav-label" id={`am-nav-group-${group.label.toLowerCase()}`}>
                  {group.label}
                </p>
                <ul className="am-nav-list">
                  {group.items.map((item) => <li key={item.key}>{renderItem(item)}</li>)}
                </ul>
              </div>
            ))}
          </nav>
          <div className="am-sidebar-spacer" />
          <div className="am-user">
            <div className="am-avatar" aria-hidden="true">
              {initials(user.firstName, user.lastName)}
            </div>
            <div className="am-user-copy">
              <div className="am-user-name">
                {user.firstName} {user.lastName}
              </div>
              <div className="am-user-location">
                {user.role}
                {user.brokerageName ? ` · ${user.brokerageName}` : ""}
              </div>
            </div>
          </div>
        </aside>
        <main className="am-main" id="ae-main-workspace" tabIndex={-1}>
          <header className="am-topbar">
            <div className="am-mobile-brand">
              <img src={wordmarkDark} alt="Agent Engine" />
            </div>
            <nav className="am-breadcrumb" aria-label="Breadcrumb">
              <strong>{crumb.section}</strong>
              <span aria-hidden="true"> / </span>
              <span aria-current="page">{pageLabel}</span>
            </nav>
            <div className="am-top-right">
              <span className="am-date">{dateLabel}</span>
              <button type="button" className="am-classic-switch" onClick={onClassicView} disabled={switching}>
                Classic view
              </button>
              <button type="button" className="am-classic-switch" onClick={onSignOut}>
                Sign out
              </button>
              {switchError && (
                <p className="am-switch-error" role="alert">
                  {switchError}
                </p>
              )}
            </div>
          </header>
          <div className="am-content am-existing-outlet">{children}</div>
        </main>
      </div>
      <nav className="am-mobile-nav" aria-label="Mobile navigation">
        {mobileLinks.map((link) => {
          const current = isCurrent(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={current ? "is-current" : undefined}
              aria-current={current ? "page" : undefined}
            >
              <MinimalSidebarIcon name={link.href} />
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
