import { Router } from "express";
import { authRateLimiter } from "../middlewares/rateLimit.js";
import { authRouter } from "./auth.js";
import { healthRouter } from "./health.js";
import { metricsRouter } from "./metrics.js";
import { propertiesRouter } from "./properties.js";
import { partiesRouter } from "./parties.js";
import { amlRouter } from "./aml.js";
import { documentsRouter } from "./documents.js";
import { paymentsRouter } from "./payments.js";
import { offersRouter } from "./offers.js";
import { transactionsRouter } from "./transactions.js";
import { homeRouter } from "./home.js";
import { aiRouter } from "./ai.js";
import { aiActionsRouter } from "./ai-actions.js";
import { billingRouter } from "./billing.js";
import { growRouter } from "./grow.js";
import { importRouter } from "./import.js";
import { automationOpsRouter } from "./automationOps.js";
import { appraisalsRouter } from "./appraisals.js";
import { tasksRouter } from "./tasks.js";
import { exceptionsRouter } from "./exceptions.js";
import { launchRouter } from "./launch.js";
import { pitCrewRouter } from "./pitCrew.js";
import { commandCentreRouter } from "./commandCentre.js";
import { communicationsRouter } from "./communications.js";
import { communicationsWebhooksRouter } from "./communicationsWebhooks.js";
import { financialRouter } from "./financial.js";
import { financialWebhooksRouter } from "./financialWebhooks.js";
import { integrationsRouter } from "./integrations.js";
import { integrationsWebhooksRouter } from "./integrationsWebhooks.js";

export const apiRouter = Router();

// Stricter rate limit than the app-wide default (see middlewares/rateLimit.ts)
// — sign-in/session endpoints are the highest-value target for
// credential-stuffing / brute-force-style abuse.
apiRouter.use("/auth", authRateLimiter, authRouter);
apiRouter.use("/health", healthRouter);
// Step 2 hardening — see routes/metrics.ts and lib/metricsAuth.ts. Mounted
// under /internal (never under /health) so it's trivially distinguishable
// in access logs and reverse-proxy rules from the public, unauthenticated
// liveness/readiness probes above.
apiRouter.use("/internal/metrics", metricsRouter);
apiRouter.use("/properties", propertiesRouter);
apiRouter.use("/parties", partiesRouter);
apiRouter.use("/aml", amlRouter);
apiRouter.use("/documents", documentsRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/offers", offersRouter);
apiRouter.use("/transactions", transactionsRouter);
apiRouter.use("/home", homeRouter);
apiRouter.use("/ai", aiRouter);
apiRouter.use("/ai/actions", aiActionsRouter);
apiRouter.use("/billing", billingRouter);
apiRouter.use("/grow", growRouter);
apiRouter.use("/import", importRouter);
apiRouter.use("/automation/ops", automationOpsRouter);
// Agent Engine 2.0 — Run Transaction Vertical Slice.
apiRouter.use("/appraisals", appraisalsRouter);
apiRouter.use("/tasks", tasksRouter);
// Agent Engine 2.0 — Exception & Risk Engine (Priority 4). Mounted
// unprefixed: exceptionsRouter's own route paths are already fully
// qualified ("/properties/:propertyId/exceptions", "/exceptions...") rather
// than relative to a mount prefix, since the property-scoped read sits
// under the existing /properties namespace while the rest of the surface
// is its own top-level /exceptions namespace — no single prefix covers
// both, so the router declares its own paths in full instead.
apiRouter.use(exceptionsRouter);
// Agent Engine 2.0 — Property Launch & Campaign Coordination. Same
// unprefixed-mount reasoning as exceptionsRouter above — launchRouter's
// own paths span both /properties/:propertyId/launch and a top-level
// /launch/... namespace.
apiRouter.use(launchRouter);
// Agent Engine 2.0 — Agent Daily Command Centre (Priority 6). Built from
// staging after Exception & Risk Engine (Priority 4) and Property Launch &
// Campaign Coordination (Priority 5) were merged in. Prefixed mount, unlike
// exceptionsRouter/launchRouter above — this router's own paths are relative.
apiRouter.use("/command-centre", commandCentreRouter);

// Phase 8 (Agent command experience: Home screen, exceptions surfaced) is
// built. Phase 9 (Contextual AI Architecture - see ARCHITECTURE.md) adds a
// single read-only Copilot endpoint on top: POST /ai/ask, GET /ai/capabilities.
// No further phases are scoped beyond this - BI dashboards remain explicitly
// out of scope, and the AI build's own explicit stop point (ARCHITECTURE.md
// Phase 9) rules out Grow, prospecting AI, autonomous workflows, and every
// other capability the AI build instructions deferred.
// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7): unprefixed mount,
// same reasoning as exceptionsRouter/launchRouter above -- pitCrewRouter
// declares its own full "/pit-crew/..." paths.
apiRouter.use(pitCrewRouter);
// Agent Engine 2.0 — Communications Hub (Priority 8): unprefixed mount,
// same reasoning as exceptionsRouter/launchRouter/pitCrewRouter above —
// communicationsRouter's own paths span both /properties/:propertyId/
// communications/... and a top-level /communications/... namespace.
// communicationsWebhooksRouter is mounted separately (and NOT behind
// requireAuth — see its own module comment) since a provider callback
// carries no session cookie.
apiRouter.use(communicationsRouter);
apiRouter.use(communicationsWebhooksRouter);
// Agent Engine 2.0 — Financial Transaction Engine (Priority 9), Stage E:
// unprefixed mount, same reasoning as exceptionsRouter/launchRouter/
// pitCrewRouter/communicationsRouter above — financialRouter's own paths
// span both /properties/:propertyId/financial/... and a top-level
// /financial/... namespace. financialWebhooksRouter is mounted separately
// (and NOT behind financialRouter's requireRole gate — see its own module
// comment) since a provider callback carries no session cookie.
apiRouter.use(financialRouter);
apiRouter.use(financialWebhooksRouter);
// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
// Unprefixed mount, same reasoning as exceptionsRouter/launchRouter/
// pitCrewRouter/communicationsRouter/financialRouter above —
// integrationsRouter's own paths are all under a top-level
// /integrations/... namespace already. integrationsWebhooksRouter is
// mounted separately (and NOT behind requireAuth) since a provider
// callback carries no session cookie — same reasoning as
// communicationsWebhooksRouter/financialWebhooksRouter.
//
// AE Step 2 closure — Part C (typed-error-handling audit): integrationsWebhooksRouter
// MUST be mounted BEFORE integrationsRouter, unlike the communications/
// financial pairs above. Unlike financialRouter/communicationsRouter
// (which apply requireAuth/requireRole PER ROUTE, precisely to avoid this),
// integrationsRouter applies its auth gate via a single unprefixed
// `integrationsRouter.use(requireAuth, requireRole(...))` — see that
// file's own module comment. Express dispatches routers mounted with
// `apiRouter.use(...)` (no path) in registration order, over every request
// that reaches apiRouter, regardless of whether that request's path
// matches any route the router itself declares. With the previous
// ordering (integrationsRouter mounted first), an unauthenticated inbound
// webhook request to /integrations/webhooks/:connectionId/:provider was
// intercepted and rejected 401 by integrationsRouter's blanket gate before
// it ever reached integrationsWebhooksRouter — meaning this endpoint was
// completely unreachable by its real, unauthenticated caller (a provider
// callback carries no session cookie, by design) despite every one of
// this router's own comments describing it as mounted outside requireAuth.
// Confirmed via a real HTTP-level test that previously had no coverage at
// all (routes/__tests__/integrationsWebhooks.test.ts) — every request to
// this path returned 401 regardless of body shape, proving the route
// handler itself never ran. Swapping the mount order below fixes this:
// integrationsWebhooksRouter's own routes are matched and handled first,
// so a real webhook request never reaches integrationsRouter's gate at
// all. This does not change integrationsRouter's own behaviour for any of
// its own /integrations/connections|dead-letters|settings|overview/...
// paths, none of which overlap with /integrations/webhooks/....
apiRouter.use(integrationsWebhooksRouter);
apiRouter.use(integrationsRouter);
