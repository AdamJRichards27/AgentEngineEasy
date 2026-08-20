import { Router } from "express";
import { healthRouter } from "./health.js";
import { propertiesRouter } from "./properties.js";
import { partiesRouter } from "./parties.js";
import { amlRouter } from "./aml.js";
import { documentsRouter } from "./documents.js";
import { paymentsRouter } from "./payments.js";
import { offersRouter } from "./offers.js";
import { transactionsRouter } from "./transactions.js";

export const apiRouter = Router();

apiRouter.use("/health", healthRouter);
apiRouter.use("/properties", propertiesRouter);
apiRouter.use("/parties", partiesRouter);
apiRouter.use("/aml", amlRouter);
apiRouter.use("/documents", documentsRouter);
apiRouter.use("/payments", paymentsRouter);
apiRouter.use("/offers", offersRouter);
apiRouter.use("/transactions", transactionsRouter);

// Phase 8 — Agent command experience (Home screen, exceptions surfaced) is
// next; no further route stubs remain (ARCHITECTURE.md §10).
