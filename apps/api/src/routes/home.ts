import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { getHomeSummary } from "../lib/homeSummary.js";

export const homeRouter = Router();

// Phase 8 (ARCHITECTURE.md §10) — the Home screen's single data source.
// Brokerage-scoped, matching every other list endpoint in this app; see the
// scoping note on getHomeSummary in lib/homeSummary.ts.
homeRouter.get("/summary", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const items = await getHomeSummary(user.brokerageId);
  res.json({
    exceptions: items.filter((i) => i.category === "Exception"),
    nextActions: items.filter((i) => i.category === "NextAction"),
  });
});
