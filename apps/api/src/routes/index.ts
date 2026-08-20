import { Router } from "express";
import { healthRouter } from "./health.js";
import { propertiesRouter } from "./properties.js";
import { partiesRouter } from "./parties.js";
import { amlRouter } from "./aml.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/properties", propertiesRouter);
apiRouter.use("/parties", partiesRouter);
apiRouter.use("/aml", amlRouter);

// Phase 5+ route stubs — documents.ts, offers.ts, transactions.ts,
// payments.ts land as those phases are built (ARCHITECTURE.md §10).
