import { Router } from "express";
import { requireAuth, PIT_CREW_ROLES } from "../middlewares/auth.js";
import { getHomeSummary, getDashboardOverview } from "../lib/homeSummary.js";
import { restrictedPropertyIdsFor } from "../lib/propertyVisibility.js";
import { requireEntitlement } from "../middlewares/entitlement.js";

// RUN-ACCESS (Owner approved 2026-10-20): a Run surface; the existing run.access entitlement middleware.
const requiresRunAccess = requireEntitlement("run.access");

export const homeRouter = Router();

// Phase 8 (ARCHITECTURE.md §10) — the Home screen's single data source.
// Property rows and the counts derived from them use the same own-property
// rule as Command Centre and Exceptions (lib/propertyVisibility.ts).
// Brokerage Administrator and Pit Crew stay brokerage-wide.
//
// Also carries the Dashboard's other two sections (staging brief: "Needs
// Attention, Active Properties, Settlements") — one round trip for the
// whole Dashboard rather than three.
homeRouter.get("/summary", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const restrictToPropertyIds = await restrictedPropertyIdsFor(user);
  const [items, overview] = await Promise.all([
    // Owner t170u (1): Pit Crew sees "Offer received" without the price.
    getHomeSummary(user.brokerageId, restrictToPropertyIds, { offerPriceVisible: !PIT_CREW_ROLES.includes(user.role) }),
    getDashboardOverview(user.brokerageId, restrictToPropertyIds),
  ]);
  res.json({
    exceptions: items.filter((i) => i.category === "Exception"),
    nextActions: items.filter((i) => i.category === "NextAction"),
    activeProperties: overview.activeProperties,
    upcomingSettlements: overview.upcomingSettlements,
  });
});
