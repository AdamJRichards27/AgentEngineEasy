import { Switch, Route, Link, Redirect } from "wouter";
import Home from "./pages/Home";
import PropertiesList from "./pages/PropertiesList";
import StartProperty from "./pages/StartProperty";
import PropertyWorkspace from "./pages/PropertyWorkspace";
import Settings from "./pages/Settings";
import Login from "./pages/Login";
import { useSession, useLogout } from "./lib/session";

// Shallow route table by design (Build Brief §26): 5 top-level destinations,
// not 15. Almost everything else lives inside the Property Workspace.
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
          <div className="app-shell">
            <nav className="app-nav">
              <div className="app-nav-links">
                <Link href="/">Home</Link>
                <Link href="/properties">Properties</Link>
                <Link href="/properties/start" className="btn btn-primary btn-small">
                  + Start Property
                </Link>
                <Link href="/settings">Settings</Link>
              </div>
              <div className="app-nav-user">
                <span className="muted">
                  {user?.firstName} {user?.lastName}
                  {user?.brokerageName ? ` · ${user.brokerageName}` : ""}
                </span>
                <button className="btn btn-link" onClick={() => logout()}>
                  Sign out
                </button>
              </div>
            </nav>
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
        )}
      </Route>
    </Switch>
  );
}
