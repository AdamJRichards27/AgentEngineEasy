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

// Phase 8 (Agent command experience: Home screen, exceptions surfaced) is
// built. Phase 9 (Contextual AI Architecture - see ARCHITECTURE.md) adds a
// single read-only Copilot endpoint on top: POST /ai/ask, GET /ai/capabilities.
// No further phases are scoped beyond this - BI dashboards remain explicitly
// out of scope, and the AI build's own explicit stop point (ARCHITECTURE.md
// Phase 9) rules out Grow, prospecting AI, autonomous workflows, and every
// other capability the AI build instructions deferred.
