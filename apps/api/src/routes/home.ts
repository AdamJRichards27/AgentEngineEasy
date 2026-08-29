import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { getHomeSummary, getDashboardOverview } from "../lib/homeSummary.js";

export const homeRouter = Router();

// Phase 8 (ARCHITECTURE.md §10) — the Home screen's single data source.
// Brokerage-scoped, matching every other list endpoint in this app; see the
// scoping note on getHomeSummary in lib/homeSummary.ts.
//
// Also carries the Dashboard's other two sections (staging brief: "Needs
// Attention, Active Properties, Settlements") — one round trip for the
// whole Dashboard rather than three.
homeRouter.get("/summary", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const [items, overview] = await Promise.all([
    getHomeSummary(user.brokerageId),
    getDashboardOverview(user.brokerageId),
  ]);
  res.json({
    exceptions: items.filter((i) => i.category === "Exception"),
    nextActions: items.filter((i) => i.category === "NextAction"),
    activeProperties: overview.activeProperties,
    upcomingSettlements: overview.upcomingSettlements,
  });
});
