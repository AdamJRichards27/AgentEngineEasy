import { Switch, Route, Link, Redirect, useLocation } from "wouter";
import Home from "./pages/Home";
import PropertiesList from "./pages/PropertiesList";
import StartProperty from "./pages/StartProperty";
import PropertyWorkspace from "./pages/PropertyWorkspace";
import CommandCentre from "./pages/CommandCentre";
import Grow from "./pages/Grow";
import GrowImport from "./pages/GrowImport";
import Exceptions from "./pages/Exceptions";
import PitCrewCommandCentre from "./pages/PitCrewCommandCentre";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { useSession, useLogout } from "./lib/session";

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
// Sidebar navigation (dark #424242, orange active pill) matches the
// reference Agent Engine app's design system rather than the earlier plain
// top bar — see the "why does this look different" thread: this app is a
// ground-up rebuild that hadn't had a real design pass until now.
export default function App() {
  const { user, isLoading, isSignedIn } = useSession();
  const logout = useLogout();

  return (
    <Switch>
      <Route path="/login">
        {isSignedIn ? <Redirect to="/" /> : <Login />}
      </Route>
      <Route>
        {isLoading ? (
          <div className="app-loading">Loading…</div>
        ) : !isSignedIn ? (
          <Redirect to="/login" />
        ) : (
          <div className="app-root">
            <div className="staging-banner">Staging Environment — Test Data Only</div>
            <div className="app-shell">
              <SidebarLayout user={user} onSignOut={() => logout()} />
            </div>
          </div>
        )}
      </Route>
    </Switch>
  );
}

function SidebarLayout({
  user,
  onSignOut,
}: {
  user: { firstName: string; lastName: string; role: string; brokerageName: string | null } | undefined;
  onSignOut: () => void;
}) {
  const [location] = useLocation();

  // Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7, Section 26):
  // only Pit Crew and Brokerage Administrator ever see this link. Agents
  // keep their existing nav unchanged. The API enforces the same gate
  // independently (requireRole in routes/pitCrew.ts) -- this is a UX
  // nicety, not the security boundary.
  const canSeePitCrew = user?.role === "Pit Crew" || user?.role === "Brokerage Administrator";
  const links: Array<{ path: string; label: string }> = [
    { path: "/", label: "Home" },
    { path: "/today", label: "Today" },
    { path: "/properties", label: "Properties" },
    { path: "/exceptions", label: "Exceptions" },
    ...(canSeePitCrew ? [{ path: "/pit-crew", label: "Pit Crew" }] : []),
    { path: "/grow", label: "Grow" },
    { path: "/settings", label: "Settings" },
  ];

  return (
    <>
      <nav className="app-sidebar">
        <div>
          <div className="app-sidebar-brand" role="img" aria-label="Agent Engine">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path fill="currentColor" d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
            </svg>
            <span>Agent Engine</span>
          </div>
          <div className="app-sidebar-nav">
            {links.map((l) => (
              <Link
                key={l.path}
                href={l.path}
                className={`app-sidebar-link${location === l.path ? " active" : ""}`}
              >
                {l.label}
              </Link>
            ))}
            <Link href="/properties/start" className="btn btn-primary btn-small app-sidebar-cta">
              + Start Property
            </Link>
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
            <Route path="/pit-crew" component={PitCrewCommandCentre} />
            <Route path="/grow" component={Grow} />
            <Route path="/grow/import" component={GrowImport} />
            <Route path="/settings" component={Settings} />
            <Route>
              <p>Page not found.</p>
            </Route>
          </Switch>
        </main>
      </div>
    </>
  );
}
