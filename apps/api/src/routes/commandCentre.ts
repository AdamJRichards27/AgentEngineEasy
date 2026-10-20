import { Router } from "express";
import { requireAuth } from "../middlewares/auth.js";
import { db, users } from "@aee/db";
import { eq } from "drizzle-orm";
import { getCommandCentre } from "../lib/commandCentre/queries.js";
import { canViewFinancials, restrictedPropertyIdsFor } from "./exceptions.js";
import { requireEntitlement } from "../middlewares/entitlement.js";

// RUN-ACCESS (Owner approved 2026-10-20): a Run surface; the existing run.access entitlement middleware.
const requiresRunAccess = requireEntitlement("run.access");

export const commandCentreRouter = Router();

// Agent Engine 2.0 — Agent Daily Command Centre (Priority 6).
// "What needs my attention today?" — a read-model projection built on the
// Exception & Risk Engine (Priority 4, authoritative for "attention
// required" state) and Property Launch & Campaign Coordination (Priority 5),
// both merged into staging ahead of this build (see AGENT ENGINE 2.0 build
// spec, Section 1). Reuses the existing tenant/agent scoping helpers
// (canViewFinancials, restrictedPropertyIdsFor) from the exceptions route
// rather than reimplementing brokerage/agent isolation — same semantics,
// same source of truth.
commandCentreRouter.get("/", requireAuth, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const [restrictToPropertyIds, [row]] = await Promise.all([
    restrictedPropertyIdsFor(user),
    db.select({ firstName: users.firstName }).from(users).where(eq(users.id, user.id)),
  ]);
  const response = await getCommandCentre(
    { id: user.id, role: user.role, brokerageId: user.brokerageId, firstName: row?.firstName ?? "" },
    { canViewFinancials: canViewFinancials(user), restrictToPropertyIds },
  );
  res.json(response);
});
