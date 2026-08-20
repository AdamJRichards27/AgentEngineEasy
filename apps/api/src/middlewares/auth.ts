import type { Request, Response, NextFunction } from "express";
import type { UserRole } from "@aee/db";

// AgentEngineEasy's 3-role model (Build Brief §22) — deliberately small.
// Agent: full access to their own properties/transactions.
// Brokerage Administrator: brokerage users/settings/oversight.
// Pit Crew: optional delegated operational permissions only — never owns
// a transaction, and agents who don't use Pit Crew retain full access
// without it (Build Brief §22, §9 of the prior audit's Pit Crew section).
export const BROKERAGE_ADMIN_ROLES: UserRole[] = ["Brokerage Administrator"];
export const PIT_CREW_ROLES: UserRole[] = ["Pit Crew"];

export interface AuthedUser {
  id: number;
  role: UserRole;
  brokerageId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authedUser?: AuthedUser;
    }
  }
}

/**
 * Loads the authenticated user onto the request. Placeholder for the real
 * auth provider integration (Clerk or equivalent) — Phase 1 wires the shape,
 * not the provider, so route/permission code doesn't change when the real
 * provider is connected.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // TODO: verify the incoming session/bearer token against the configured
  // auth provider and populate req.authedUser from the resulting user record.
  if (!req.authedUser) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authedUser) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(req.authedUser.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
