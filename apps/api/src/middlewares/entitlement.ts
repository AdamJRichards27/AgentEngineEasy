import type { Request, Response, NextFunction } from "express";
import type { EntitlementKey } from "@aee/db";
import { logger } from "@aee/events";
import { explainEntitlementDecision } from "../lib/entitlements/resolver.js";

/**
 * The fourth access question (entitlement), alongside requireAuth/requireRole's authentication
 * and role checks. Direct API calls from an unentitled account must fail here regardless of
 * what the frontend shows - this is the actual security boundary, not the UI's locked state.
 */
export function requireEntitlement(entitlementKey: EntitlementKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.authedUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      const decision = await explainEntitlementDecision(req.authedUser, entitlementKey);
      if (decision.allowed === false) {
        res.status(403).json({
          error: "Not entitled",
          reason: decision.reason,
          entitlementKey,
          upgrade: { action: "grow.checkout", productCode: "grow" },
        });
        return;
      }
      next();
    } catch (err) {
      logger.error("require_entitlement_middleware_failed_closed", { entitlementKey, userId: req.authedUser.id, error: err });
      res.status(403).json({ error: "Not entitled", reason: "ENTITLEMENT_MISSING", entitlementKey });
    }
  };
}
