import { Router } from "express";
import { authRouter } from "./auth.js";
import { healthRouter } from "./health.js";
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
import { commandCentreRouter } from "./commandCentre.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/health", healthRouter);
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
