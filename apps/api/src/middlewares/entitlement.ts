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

/**
 * Allow when ANY of `entitlementKeys` is granted. Used where a surface belongs
 * to both products (property contacts: Grow keeps them per t223u, Run has
 * always had them). Same 403 body as requireEntitlement, naming the first key.
 */
export function requireAnyEntitlement(...entitlementKeys: EntitlementKey[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.authedUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    try {
      let reason: string | undefined;
      for (const key of entitlementKeys) {
        const decision = await explainEntitlementDecision(req.authedUser, key);
        if (decision.allowed) {
          next();
          return;
        }
        reason ??= decision.reason;
      }
      res.status(403).json({
        error: "Not entitled",
        reason: reason ?? "ENTITLEMENT_MISSING",
        entitlementKey: entitlementKeys[0],
        upgrade: { action: "grow.checkout", productCode: "grow" },
      });
    } catch (err) {
      logger.error("require_entitlement_middleware_failed_closed", { entitlementKeys, userId: req.authedUser.id, error: err });
      res.status(403).json({ error: "Not entitled", reason: "ENTITLEMENT_MISSING", entitlementKey: entitlementKeys[0] });
    }
  };
}

/**
 * t246u (Owner, #285 release blocker): who may change person-property
 * relationships (link, unlink, change role, change primary).
 *
 * Root cause this fixes: relationship management was gated on the Grow-only
 * key grow.relationships.manage. Legacy Run brokerages (run.access from the
 * boot-time backfill, dev-login auto-grant, the Starter/RUN catalogue product
 * or an admin grant) only ever hold run.access, so #285 silently removed a
 * capability they legitimately had via property-contact management
 * (canManagePropertyContacts accepts run.access). Rather than seed a one-off
 * grant, the permission is DERIVED:
 *
 *   1. grow.relationships.manage granted (Grow, Bundle, explicit grant), OR
 *   2. run.access granted AND the user's role carries Run contact-management
 *      rights (Agent or Brokerage Administrator).
 *
 * run.access alone is NOT enough: Pit Crew (Run support role, no contact
 * management) needs the explicit key. Read-only Grow callers (contacts.read
 * without manage, no Run) are still refused. Property visibility and brokerage
 * isolation are enforced by the route itself (404), unchanged.
 */
export const RUN_CONTACT_MANAGE_ROLES = ["Agent", "Brokerage Administrator"] as const;

export function requireRelationshipManage() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authedUser;
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const entitlementKey = "grow.relationships.manage";
    try {
      const explicit = await explainEntitlementDecision(user, entitlementKey);
      if (explicit.allowed) {
        next();
        return;
      }
      if ((RUN_CONTACT_MANAGE_ROLES as readonly string[]).includes(user.role)) {
        const run = await explainEntitlementDecision(user, "run.access");
        if (run.allowed) {
          next();
          return;
        }
      }
      res.status(403).json({
        error: "Not entitled",
        reason: explicit.reason,
        entitlementKey,
        upgrade: { action: "grow.checkout", productCode: "grow" },
      });
    } catch (err) {
      logger.error("require_entitlement_middleware_failed_closed", { entitlementKey, userId: user.id, error: err });
      res.status(403).json({ error: "Not entitled", reason: "ENTITLEMENT_MISSING", entitlementKey });
    }
  };
}
