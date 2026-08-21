import { Switch, Route, Link, Redirect, useLocation } from "wouter";
import Home from "./pages/Home";
import PropertiesList from "./pages/PropertiesList";
import StartProperty from "./pages/StartProperty";
import PropertyWorkspace from "./pages/PropertyWorkspace";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { useSession, useLogout } from "./lib/session";
import { LOGO_SIDEBAR } from "./brand";

function initials(firstName?: string, lastName?: string): string {
  return `${firstName?.[0] ?? ""}${lastName?.[0] ?? ""}`.toUpperCase() || "?";
}

// Shallow route table by design (Build Brief §26): 5 top-level destinations,
// not 15. Almost everything else lives inside the Property Workspace.
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

  const links: Array<{ path: string; label: string }> = [
    { path: "/", label: "Home" },
    { path: "/properties", label: "Properties" },
    { path: "/settings", label: "Settings" },
  ];

  return (
    <>
      <nav className="app-sidebar">
        <div>
          <img src={LOGO_SIDEBAR} alt="Agent Engine" className="app-sidebar-brand" />
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
            <Route path="/properties" component={PropertiesList} />
            <Route path="/properties/start" component={StartProperty} />
            <Route path="/properties/:id" component={PropertyWorkspace} />
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
