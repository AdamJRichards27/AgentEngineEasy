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

// Phase 8 (Agent command experience: Home screen, exceptions surfaced) is
// built. No further phases are scoped in ARCHITECTURE.md §10 beyond this —
// BI dashboards are explicitly out of scope for this build.
