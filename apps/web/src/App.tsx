import { lazy, Suspense, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Switch, Route, Link, Redirect, useLocation, useSearch } from "wouter";
import { selectContact360View } from "./minimal/minimalContactModel";
import { selectPropertiesView } from "./minimal/properties/minimalPropertiesModel";
import { selectAppraisalsView } from "./minimal/appraisals/minimalAppraisalsModel";
import { selectOpportunitiesView } from "./minimal/opportunities/minimalOpportunitiesModel";
import { selectPropertyDetailView } from "./minimal/properties/minimalPropertyDetailModel";
import { selectOpportunityDetailView } from "./minimal/opportunities/minimalOpportunityDetailModel";
import { selectAppraisalBuilderView } from "./minimal/appraisal/appraisalBuilderModel";
import Login from "./pages/Login";
import AcceptInvitation from "./pages/AcceptInvitation";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import { useSession, useLogout, useEntitlements } from "./lib/session";
import { navLinkIsActive, resolveLandingRoute } from "./lib/productNav";
import { buildClassicNavLinks, minimalHasRunAccess } from "./minimal/minimalNav";
import {
  selectMinimalUxVariant,
  shouldOfferMinimalView,
  shouldRenderMinimalShell,
  useMinimalUx,
} from "./lib/minimalUx";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { OwnerContextBanner } from "./components/OwnerContextBanner";
import type { SessionUser } from "./lib/session";

// I-18 — each authenticated page is its own chunk. Pre-session pages stay
// eager: they render before a session exists, outside the Suspense below,
// and Login is the first paint for a signed-out visitor.
const Home = lazy(() => import("./pages/Home"));
const PropertiesList = lazy(() => import("./pages/PropertiesList"));
const StartProperty = lazy(() => import("./pages/StartProperty"));
const PropertyWorkspace = lazy(() => import("./pages/PropertyWorkspace"));
const CommandCentre = lazy(() => import("./pages/CommandCentre"));
const Grow = lazy(() => import("./pages/Grow"));
const GrowAppraisals = lazy(() => import("./pages/GrowAppraisals"));
const AppraisalWorkspace = lazy(() => import("./pages/AppraisalWorkspace"));
const GrowImport = lazy(() => import("./pages/GrowImport"));
const Exceptions = lazy(() => import("./pages/Exceptions"));
const PitCrewCommandCentre = lazy(() => import("./pages/PitCrewCommandCentre"));
const CommunicationsHub = lazy(() => import("./pages/CommunicationsHub"));
const FinancialOperations = lazy(() => import("./pages/FinancialOperations"));
const Settings = lazy(() => import("./pages/Settings"));
const SettingsIntegrations = lazy(() => import("./pages/SettingsIntegrations"));
const SettingsUsers = lazy(() => import("./pages/SettingsUsers"));
const Owner = lazy(() => import("./pages/Owner"));
const MinimalShell = lazy(() => import("./minimal/MinimalShell"));
const MinimalToday = lazy(() => import("./minimal/MinimalToday"));
const MinimalContact360 = lazy(() => import("./minimal/MinimalContact360"));
const MinimalProperties = lazy(() => import("./minimal/properties/MinimalProperties"));
const MinimalAppraisals = lazy(() => import("./minimal/appraisals/MinimalAppraisals"));
const MinimalOpportunities = lazy(() => import("./minimal/opportunities/MinimalOpportunities"));
const MinimalAppraisalBuilder = lazy(() => import("./minimal/appraisal/MinimalAppraisalBuilder"));
const MinimalPropertyDetail = lazy(() => import("./minimal/properties/MinimalPropertyDetail"));
const MinimalOpportunityDetail = lazy(() => import("./minimal/opportunities/MinimalOpportunityDetail"));

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
// Sidebar navigation (dark #424242, orange active pill) matches the
// reference Agent Engine app's design system rather than the earlier plain
// top bar — see the "why does this look different" thread: this app is a
// ground-up rebuild that hadn't had a real design pass until now.
//
// AE GROW Priority 0.5 -- Workstream 2: Grow-first main navigation. Grow is now the #1 product
// selection (see lib/productNav.ts's buildProductNavLinks) and post-login landing is
// entitlement-aware (resolveLandingRoute) rather than always "/". Every existing RUN route,
// role gate, and the "/" fallback for a signed-in-but-not-Grow-entitled user are unchanged --
// this is additive navigation/landing logic, not a rebuild of this route table.
//
// AE GROW Pilot Readiness WP8 -- the authenticated gate below now tells "you
// have no session" apart from "the API never answered" (see
// lib/sessionProbe.ts). A hard reload while the API is unreachable used to
// fall straight through to `<Redirect to="/login" />`, showing a sign-in form
// that could not possibly work; it now shows ApiUnreachable with a retry. The
// public routes above are untouched, and a genuine 401 still redirects to
// /login exactly as before.
export default function App() {
  const { user, isLoading, isSignedIn, probe, retryProbe } = useSession();
  const { entitlements } = useEntitlements();
  const logout = useLogout();

  return (
    <div className="app-root">
      <div className="staging-banner">Staging Environment — Test Data Only</div>
      <Switch>
      <Route path="/login">
        {isSignedIn ? <Redirect to={user?.platformOwner && user.ownerSelectedBrokerageId == null
          ? "/owner" : resolveLandingRoute({ role: user?.role, entitlements })} /> : <Login />}
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
        {probe === "loading" || isLoading ? (
          <div className="app-loading">Loading…</div>
        ) : probe === "api-unreachable" ? (
          <ApiUnreachable onRetry={retryProbe} />
        ) : !isSignedIn || !user ? (
          <Redirect to="/login" replace />
        ) : (
          <AuthenticatedExperience user={user} entitlements={entitlements} onSignOut={() => void logout()} />
        )}
      </Route>
      </Switch>
    </div>
  );
}

// AE GROW Pilot Readiness WP8 — shown instead of the sign-in form when the
// initial session probe never reached the API. Deliberately does NOT redirect
// anywhere: the current URL is preserved, so retrying once the API is back
// lands the agent on the page they reloaded rather than bouncing them to
// /login. "Try again" refetches GET /auth/me only (lib/session.ts
// retryProbe), so there is no navigation to loop on.
function ApiUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="card error-boundary error-boundary-page api-unreachable" role="alert">
      <h1>Agent Engine can't be reached</h1>
      <p className="muted">
        We couldn't connect to Agent Engine. This usually means your connection dropped, or the service is briefly
        unavailable — it doesn't mean you've been signed out.
      </p>
      <p className="muted">Check your connection and try again. If it keeps happening, contact support.</p>
      <div className="error-boundary-actions">
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    </div>
  );
}

function AuthenticatedExperience({
  user,
  entitlements,
  onSignOut,
}: {
  user: SessionUser;
  entitlements: string[];
  onSignOut: () => void;
}) {
  const ux = useMinimalUx();
  const queryClient = useQueryClient();
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const ownerWithoutContext = !!user.platformOwner && user.ownerSelectedBrokerageId == null;

  async function selectVariant(variant: "classic" | "minimal") {
    setSwitching(true);
    setSwitchError(null);
    try {
      await selectMinimalUxVariant(variant);
    } catch {
      setSwitchError("Couldn't switch views. You're still on this view.");
    } finally {
      try {
        await queryClient.invalidateQueries({ queryKey: ["session"], exact: true });
      } catch {
        // The cookie is already stored. The next session read corrects the shell.
      }
      setSwitching(false);
    }
  }

  const page = (
    <>
      {user?.platformOwner && <OwnerContextBanner user={user} />}
      {!ownerWithoutContext && (!user.firstName?.trim() || !user.lastName?.trim()) && (
        <section className="card" role="status">
          <h2>Complete your profile</h2>
          <p>Add your first and last name so your brokerage can see who you are.</p>
          <Link href="/settings" className="btn btn-primary btn-small">
            Add your name
          </Link>
        </section>
      )}
      <AuthenticatedRoutes ownerWithoutContext={ownerWithoutContext} />
    </>
  );

  if (shouldRenderMinimalShell(ux)) {
    return (
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        <MinimalShell
          user={user}
          entitlements={entitlements}
          onSignOut={onSignOut}
          onClassicView={() => void selectVariant("classic")}
          switching={switching}
          switchError={switchError}
        >
          {page}
        </MinimalShell>
      </Suspense>
    );
  }

  return (
    <div className="app-shell" data-ae-ux="classic">
      <SidebarLayout
        user={user}
        entitlements={entitlements}
        onSignOut={onSignOut}
        showMinimalView={shouldOfferMinimalView(ux)}
        onMinimalView={() => void selectVariant("minimal")}
        switching={switching}
        switchError={switchError}
      >
        {page}
      </SidebarLayout>
    </div>
  );
}

function SidebarLayout({
  user,
  entitlements,
  onSignOut,
  showMinimalView,
  onMinimalView,
  switching,
  switchError,
  children,
}: {
  user: SessionUser;
  entitlements: string[];
  onSignOut: () => void;
  showMinimalView: boolean;
  onMinimalView: () => void;
  switching: boolean;
  switchError: string | null;
  children: React.ReactNode;
}) {
  const [location] = useLocation();

  // AE GROW Priority 0.5 -- Workstream 2: navigation ordering (Grow first) and the existing
  // role-based link visibility (Pit Crew / Brokerage Administrator only) are now centralised in
  // lib/productNav.ts rather than recomputed inline here -- see that file's own header comment
  // for the full ordering/entitlement rationale. This is a straight extraction: who sees
  // Pit Crew/Financial is unchanged, only Grow's position (now first) has moved.
  const ownerWithoutContext = !!user?.platformOwner && user.ownerSelectedBrokerageId == null;
  // Owner D5: Run links (and Start Property) only with run.access, same rule as the Minimal shell.
  const links = ownerWithoutContext ? [] : buildClassicNavLinks({ role: user?.role, entitlements });
  const canStartProperty = !ownerWithoutContext && minimalHasRunAccess(entitlements);

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
            {user?.platformOwner && <Link href="/owner"
              className={`app-sidebar-link${location === "/owner" ? " active" : ""}`}>
              Platform Owner
            </Link>}
            {links.map((l) => (
              <Link
                key={l.path}
                href={l.path}
                className={`app-sidebar-link${navLinkIsActive(location, l.path) ? " active" : ""}`}
              >
                {l.label}
              </Link>
            ))}
            {canStartProperty && <Link href="/properties/start" className="btn btn-primary btn-small app-sidebar-cta">
              + Start Property
            </Link>}
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
          {showMinimalView && (
            <button type="button" className="app-sidebar-signout" onClick={onMinimalView} disabled={switching}>
              Minimal view
            </button>
          )}
          <button className="app-sidebar-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </nav>
      <div className="app-content">
        <main>
          {switchError && <p role="alert">{switchError}</p>}
          {children}
        </main>
      </div>
    </>
  );
}

function AuthenticatedRoutes({ ownerWithoutContext }: { ownerWithoutContext: boolean }) {
  const [location] = useLocation();
  const minimalShell = shouldRenderMinimalShell(useMinimalUx());
  const search = useSearch();
  // AE GROW Pilot Readiness WP5 — a page that fails to render shows a
  // contained fallback here (sidebar stays usable); navigating away resets it.
  return (
    <ErrorBoundary label="this page" resetKey={location}>
      <Suspense fallback={<div className="app-loading">Loading…</div>}>
        {ownerWithoutContext && location !== "/owner" ? <Redirect to="/owner" replace /> : <Switch>
          <Route path="/owner" component={Owner} />
          <Route path="/" component={Home} />
          <Route path="/today" component={CommandCentre} />
          <Route path="/properties">
            {selectPropertiesView(minimalShell, search) === "minimal" ? <MinimalProperties /> : <PropertiesList />}
          </Route>
          <Route path="/properties/start" component={StartProperty} />
          <Route path="/properties/:id" component={PropertyWorkspace} />
          <Route path="/exceptions" component={Exceptions} />
          <Route path="/communications" component={CommunicationsHub} />
          <Route path="/financial" component={FinancialOperations} />
          <Route path="/pit-crew" component={PitCrewCommandCentre} />
          <Route path="/grow/appraisals/:id/build">
            {selectAppraisalBuilderView(minimalShell) === "minimal" ? <MinimalAppraisalBuilder /> : <AppraisalWorkspace />}
          </Route>
          <Route path="/grow/appraisals/:id" component={AppraisalWorkspace} />
          <Route path="/grow/appraisals">
            {selectAppraisalsView(minimalShell, search) === "minimal" ? <MinimalAppraisals /> : <GrowAppraisals />}
          </Route>
          {/* CC #25/#26: Minimal detail pages, before /grow and /grow/opportunities (first match wins). */}
          <Route path="/grow/properties/:id">
            {(params) =>
              selectPropertyDetailView(minimalShell, search) === "minimal" ? (
                <MinimalPropertyDetail />
              ) : (
                <Redirect to={`/properties/${params.id}`} replace />
              )
            }
          </Route>
          <Route path="/grow/opportunities/:id">
            {selectOpportunityDetailView(minimalShell, search) === "minimal" ? (
              <MinimalOpportunityDetail />
            ) : (
              <Redirect to="/grow?tab=opportunities" replace />
            )}
          </Route>
          <Route path="/grow">{minimalShell ? <MinimalToday /> : <Grow />}</Route>
          <Route path="/grow/contacts/:id">
            {selectContact360View(minimalShell, search) === "minimal" ? <MinimalContact360 /> : <Grow />}
          </Route>
          <Route path="/grow/opportunities">
            {selectOpportunitiesView(minimalShell, search) === "minimal" ? <MinimalOpportunities /> : <Redirect to="/grow?tab=opportunities" replace />}
          </Route>
          <Route path="/grow/import" component={GrowImport} />
          <Route path="/settings" component={Settings} />
          <Route path="/settings/integrations" component={SettingsIntegrations} />
          <Route path="/settings/users" component={SettingsUsers} />
          <Route>
            <p>Page not found.</p>
          </Route>
        </Switch>}
      </Suspense>
    </ErrorBoundary>
  );
}
