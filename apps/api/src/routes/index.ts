import { Router } from "express";
import { healthRouter } from "./health.js";
import { propertiesRouter } from "./properties.js";
import { partiesRouter } from "./parties.js";
import { amlRouter } from "./aml.js";
import { documentsRouter } from "./documents.js";
import { paymentsRouter } from "./payments.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/properties", propertiesRouter);
apiRouter.use("/parties", partiesRouter);
apiRouter.use("/aml", amlRouter);
apiRouter.use("/documents", documentsRouter);
apiRouter.use("/payments", paymentsRouter);

// Phase 7+ route stubs — offers.ts, transactions.ts land as those phases
// are built (ARCHITECTURE.md §10).
