import { Switch, Route, Link } from "wouter";
import Home from "./pages/Home";
import PropertiesList from "./pages/PropertiesList";
import StartProperty from "./pages/StartProperty";
import PropertyWorkspace from "./pages/PropertyWorkspace";
import Settings from "./pages/Settings";

// Shallow route table by design (Build Brief §26): 5 top-level destinations,
// not 15. Almost everything else lives inside the Property Workspace.
export default function App() {
  return (
    <div className="app-shell">
      <nav className="app-nav">
        <Link href="/">Home</Link>
        <Link href="/properties">Properties</Link>
        <Link href="/properties/start">Start Property</Link>
        <Link href="/settings">Settings</Link>
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
  );
}
