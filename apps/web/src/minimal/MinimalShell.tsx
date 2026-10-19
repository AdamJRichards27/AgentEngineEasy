import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { focusMinimalMain, minimalRouteKey, shouldMoveMinimalFocus } from "./minimalA11y";
import type { SessionUser } from "../lib/session";
import { buildMinimalNavLinks } from "./minimalNav";
import { formatMinimalHeaderDate, minimalBreadcrumb, minimalNavIsCurrent } from "../lib/minimalUx";
import gear from "./brand/AE_Gear_Orange_Large.png";
import wordmarkDark from "./brand/AE_Wordmark_Dark.png";
import wordmarkWhite from "./brand/AE_Wordmark_White.png";
import { MinimalNavIcon } from "./icons";
import "./minimal.css";

// Empty AE Minimal A shell. Same product routes as classic. No sample
// records, no "coming soon" Run or Pit Crew items, and no actions that do
// not already exist on a route.

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
  const links = ownerWithoutContext ? [] : buildMinimalNavLinks({ role: user.role, entitlements });
  // Start property stays a sidebar-only entry, as before; the mobile bar keeps the main sections.
  const mobileLinks = links.filter((link) => link.path !== "/properties/start");
  if (user.platformOwner) links.unshift({ path: "/owner", label: "Platform Owner" });
  const crumb = minimalBreadcrumb(location, links);
  const dateLabel = formatMinimalHeaderDate(new Date());
  const pageName = crumb.page === crumb.section ? crumb.section : `${crumb.section}, ${crumb.page}`;

  // After a client-side route change, move focus to the new page's heading and
  // announce it. Pages are lazy chunks, so wait (up to ~1s) for the heading.
  useEffect(() => {
    const previous = lastRouteKey.current;
    lastRouteKey.current = routeKey;
    if (!shouldMoveMinimalFocus(previous, routeKey)) return;
    setAnnouncement(pageName);
    let frames = 0;
    let handle = 0;
    const tryFocus = () => {
      const hasHeading = document.querySelector("#ae-main-workspace h1") !== null;
      if (hasHeading || frames >= 60) {
        focusMinimalMain(document);
        return;
      }
      frames += 1;
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
          <p className="am-nav-label">Your workspace</p>
          <nav className="am-nav" aria-label="Primary">
            {links.map((link) => {
              const current = minimalNavIsCurrent(location, link.path);
              return (
                <Link
                  key={link.path}
                  href={link.path}
                  className={`am-nav-button${current ? " is-current" : ""}`}
                  aria-current={current ? "page" : undefined}
                >
                  <span className="am-nav-glyph">
                    <MinimalNavIcon path={link.path} />
                  </span>
                  <span>{link.label}</span>
                </Link>
              );
            })}
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
              <span aria-current="page">{crumb.page}</span>
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
          const current = minimalNavIsCurrent(location, link.path);
          return (
            <Link
              key={link.path}
              href={link.path}
              className={current ? "is-current" : undefined}
              aria-current={current ? "page" : undefined}
            >
              <MinimalNavIcon path={link.path} />
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
