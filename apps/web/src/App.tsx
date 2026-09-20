import { useEffect, useRef, useState } from "react";
import { Switch, Route, Link, Redirect, useLocation, useSearch } from "wouter";
import Home from "./pages/Home";
import PropertiesList from "./pages/PropertiesList";
import StartProperty from "./pages/StartProperty";
import PropertyWorkspace from "./pages/PropertyWorkspace";
import CommandCentre from "./pages/CommandCentre";
import Grow from "./pages/Grow";
import GrowImport from "./pages/GrowImport";
import Exceptions from "./pages/Exceptions";
import PitCrewCommandCentre from "./pages/PitCrewCommandCentre";
import CommunicationsHub from "./pages/CommunicationsHub";
import FinancialOperations from "./pages/FinancialOperations";
import Settings from "./pages/Settings";
import SettingsIntegrations from "./pages/SettingsIntegrations";
import SettingsUsers from "./pages/SettingsUsers";
import Login from "./pages/Login";
import AcceptInvitation from "./pages/AcceptInvitation";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import { AskAgentEngine } from "./components/AskAgentEngine";
import { useSession, useLogout, useEntitlements } from "./lib/session";
import {
  buildProductNavGroups,
  buildQuickActions,
  resolveLandingRoute,
  type NavContext,
  type NavLink,
  type QuickAction,
} from "./lib/productNav";

function initials(firstName?: string, lastName?: string): string {
  return `${firstName?.[0] ?? ""}${lastName?.[0] ?? ""}`.toUpperCase() || "?";
}

// Shallow route table by design (Build Brief §26): almost everything lives
// inside the Property Workspace. One exception, added deliberately (#145,
// Build Instructions §18): "Exceptions" is a cross-property operational
// view — by definition not something that can live inside a single
// property's workspace — explicitly scoped as a foundation for the future
// Agent Daily Command Centre, not that dashboard itself.
//
// Agent Engine 2.0 -- Communications Hub (Priority 8, Section 32) adds a
// second such cross-property view for the same reason Exceptions needed
// one: "what needs attention across every property" cannot live inside a
// single property's workspace. Composing and reading an individual
// property's communication threads still lives inside the Property
// Workspace (Section 10) -- this route is the summary feed, not a second
// composer.
//
// Agent Engine 2.0 -- Financial Transaction Engine (Priority 9, Stage G,
// Section 29) adds a third such cross-property view -- the Brokerage
// Financial Operations queue -- for the same "can't live inside one
// property's workspace" reason. Unlike Exceptions/Communications, this
// one is Brokerage Administrator only (every /financial/* route is gated
// that way server-side -- see routes/financial.ts's own header comment),
// so canSeeFinancial below mirrors canSeePitCrew's existing role-gate
// pattern rather than inventing a new one.
//
// Sidebar navigation (dark #424242, orange active pill) matches the existing Agent Engine design
// system. The product groups are intentionally an information architecture layer only: all
// destinations below continue to use the existing routes and role/entitlement gates.
export default function App() {
  const { user, isLoading, isSignedIn } = useSession();
  const { entitlements, isLoading: entitlementsLoading } = useEntitlements();
  const logout = useLogout();

  return (
    <Switch>
      <Route path="/login">
        {!isSignedIn ? (
          <Login />
        ) : entitlementsLoading ? (
          <div className="app-loading">Loading…</div>
        ) : (
          <Redirect to={resolveLandingRoute({ role: user?.role, entitlements })} />
        )}
      </Route>
      {/* Critical Blocker Remediation, Phases 2/4 — public, unauthenticated
          routes for the invitation-only auth flows. These must sit outside
          the isSignedIn gate below: an invitation/reset link is opened from
          an email, before any session cookie exists (and a currently
          signed-in admin must still be able to open their own invite links
          when testing, so none of these redirect away on isSignedIn). */}
      <Route path="/accept-invitation/:token" component={AcceptInvitation} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password/:token" component={ResetPassword} />
      <Route>
        {isLoading ? (
          <div className="app-loading">Loading…</div>
        ) : !isSignedIn ? (
          <Redirect to="/login" />
        ) : (
          <div className="app-root">
            <div className="staging-banner">Staging Environment — Test Data Only</div>
            <div className="app-shell">
              <SidebarLayout user={user} entitlements={entitlements} onSignOut={() => logout()} />
            </div>
          </div>
        )}
      </Route>
    </Switch>
  );
}

function SidebarLayout({
  user,
  entitlements,
  onSignOut,
}: {
  user: { firstName: string; lastName: string; role: string; brokerageName: string | null } | undefined;
  entitlements: string[];
  onSignOut: () => void;
}) {
  const [location] = useLocation();
  const search = useSearch();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navContext: NavContext = { role: user?.role, entitlements };
  const groups = buildProductNavGroups(navContext);
  const quickActions = buildQuickActions(navContext);

  return (
    <>
      <nav className="app-sidebar">
        <div className="app-sidebar-main">
          <div className="app-sidebar-brand" role="img" aria-label="Agent Engine">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="currentColor" d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
            <span>Agent Engine</span>
          </div>
          <button
            type="button"
            className="app-sidebar-mobile-toggle"
            aria-expanded={mobileNavOpen}
            aria-controls="product-navigation"
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            {mobileNavOpen ? "Hide menu" : "Menu"}
          </button>
          <div
            id="product-navigation"
            className={`app-sidebar-nav-scroll${mobileNavOpen ? " is-open" : ""}`}
            onClick={() => setMobileNavOpen(false)}
          >
            <div className="app-sidebar-nav" aria-label="Product navigation">
              {groups.map((group) =>
                group.standalone ? (
                  <div className="app-sidebar-group app-sidebar-group-standalone" key={group.id}>
                    {group.links.map((link) => (
                      <SidebarLink key={link.path} link={link} location={location} search={search} />
                    ))}
                  </div>
                ) : (
                  <section className="app-sidebar-group" key={group.id} aria-labelledby={`nav-group-${group.id}`}>
                    <div className="app-sidebar-group-label" id={`nav-group-${group.id}`}>
                      {group.label}
                    </div>
                    {group.links.map((link) => (
                      <SidebarLink key={link.path} link={link} location={location} search={search} nested />
                    ))}
                  </section>
                ),
              )}
            </div>
          </div>
          <div className="app-sidebar-actions">
            <QuickActionsMenu actions={quickActions} />
            <AskAeLauncher />
          </div>
        </div>
        <div className="app-sidebar-footer">
          <span className="avatar-circle">{initials(user?.firstName, user?.lastName)}</span>
          <div className="app-sidebar-user-info">
            <span className="app-sidebar-user-name">
              {user?.firstName} {user?.lastName}
            </span>
            <span className="app-sidebar-user-role">
              {user?.role}
              {user?.brokerageName ? ` · ${user.brokerageName}` : ""}
            </span>
          </div>
          <button className="app-sidebar-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </nav>
      <div className="app-content">
        <main>
          <Switch>
            <Route path="/" component={Home} />
            <Route path="/today" component={CommandCentre} />
            <Route path="/properties" component={PropertiesList} />
            <Route path="/properties/start" component={StartProperty} />
            <Route path="/properties/:id" component={PropertyWorkspace} />
            <Route path="/exceptions" component={Exceptions} />
            <Route path="/communications" component={CommunicationsHub} />
            <Route path="/financial" component={FinancialOperations} />
            <Route path="/pit-crew" component={PitCrewCommandCentre} />
            <Route path="/grow" component={Grow} />
            <Route path="/grow/import" component={GrowImport} />
            <Route path="/settings" component={Settings} />
            <Route path="/settings/integrations" component={SettingsIntegrations} />
            <Route path="/settings/users" component={SettingsUsers} />
            <Route>
              <p>Page not found.</p>
            </Route>
          </Switch>
        </main>
      </div>
    </>
  );
}

function SidebarLink({
  link,
  location,
  search,
  nested = false,
}: {
  link: NavLink;
  location: string;
  search: string;
  nested?: boolean;
}) {
  const active = isNavLinkActive(link.path, location, search);
  return (
    <Link
      href={link.path}
      className={`app-sidebar-link${nested ? " app-sidebar-sublink" : ""}${
        active ? " active" : ""
      }`}
      aria-current={active ? "page" : undefined}
    >
      {link.label}
    </Link>
  );
}

function isNavLinkActive(path: string, location: string, search: string): boolean {
  const [expectedPath, expectedQuery = ""] = path.split("?");
  if (expectedPath !== location) return false;
  if (!expectedQuery) return true;

  const expected = new URLSearchParams(expectedQuery);
  const current = new URLSearchParams(search);
  // GrowWorkspace defaults to Today when /grow has no query string, so its Today deep link is
  // active for both /grow and /grow?tab=today.
  if (expectedPath === "/grow" && expected.get("tab") === "today" && !current.has("tab")) return true;
  for (const [key, value] of expected.entries()) {
    if (current.get(key) !== value) return false;
  }
  return true;
}

function QuickActionsMenu({ actions }: { actions: QuickAction[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const firstItem = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    firstItem?.focus();
  }, [open]);

  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Tab") {
      // A menu is a temporary branch in the sidebar's tab order. Keep Tab and
      // Shift+Tab predictable at its boundaries: close the branch and return
      // backwards to the trigger, or continue forwards to the next sidebar
      // control (Ask AE). Interior Tab movement remains native.
      if ((event.shiftKey && currentIndex === 0) || (!event.shiftKey && currentIndex === items.length - 1)) {
        event.preventDefault();
        const allFocusable = Array.from(
          document.querySelectorAll<HTMLElement>(
            'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((element) => !element.hasAttribute("disabled"));
        if (event.shiftKey) {
          setOpen(false);
          triggerRef.current?.focus();
        } else {
          const current = allFocusable.indexOf(items[items.length - 1]);
          const next = current >= 0 ? allFocusable[current + 1] : undefined;
          setOpen(false);
          next?.focus();
        }
      }
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(currentIndex + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  return (
    <div className="app-sidebar-quick-actions">
      <button
        ref={triggerRef}
        type="button"
        className="app-sidebar-action app-sidebar-quick-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="quick-actions-menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">+</span> Quick Action
      </button>
      {open && (
        <div
          id="quick-actions-menu"
          ref={menuRef}
          className="app-sidebar-quick-menu"
          role="menu"
          aria-label="Quick Action"
          onKeyDown={moveFocus}
        >
          {actions.map((action) => (
            <Link
              key={action.path}
              href={action.path}
              role="menuitem"
              className="app-sidebar-quick-item"
              onClick={() => setOpen(false)}
            >
              <strong>{action.label}</strong>
              <span>{action.description}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AskAeLauncher() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const getFocusable = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled"));

    getFocusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="app-sidebar-action app-sidebar-ask"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Ask AE
      </button>
      {open && (
        <div
          className="ask-ae-drawer-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <aside
            ref={drawerRef}
            className="ask-ae-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ask-ae-drawer-title"
          >
            <div className="ask-ae-drawer-header">
              <div>
                <h2 id="ask-ae-drawer-title">Ask AE</h2>
                <p className="muted">
                  Get a quick portfolio overview: ask how many active properties or upcoming settlements
                  you have. For record-specific questions, open Ask AE within a property or Grow.
                  This overview provides answers without sending messages or changing records.
                </p>
              </div>
              <button
                type="button"
                className="app-sidebar-action ask-ae-drawer-close"
                aria-label="Close Ask AE"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <AskAgentEngine contextType="business" contextId={null} />
          </aside>
        </div>
      )}
    </>
  );
}
