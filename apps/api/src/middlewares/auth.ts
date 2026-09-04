import type { Request, Response, NextFunction } from "express";
import { db, users, type UserRole } from "@aee/db";
import { eq } from "drizzle-orm";
import { readSessionCookie, verifySessionToken } from "../lib/session.js";

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
 * Loads the authenticated user onto the request from the staging session
 * cookie (see lib/session.ts, routes/auth.ts). Mounted globally in app.ts,
 * ahead of every route — a missing/invalid cookie just leaves
 * req.authedUser unset, which requireAuth below turns into a 401.
 *
 * This is the "wire the shape, not the provider" placeholder Phase 1
 * originally described, now actually functional for staging use; swapping
 * in real Clerk verification later means changing this one function's body,
 * not any route or permission code (ARCHITECTURE.md §10 closing note).
 */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = readSessionCookie(req.headers.cookie);
    const verified = verifySessionToken(token);
    if (!verified) {
      next();
      return;
    }
    const [row] = await db.select().from(users).where(eq(users.id, verified.uid));
    // Foundation Remediation - server-side session revocation: a token
    // whose embedded epoch (lib/session.ts) no longer matches the user's
    // current sessionEpoch was issued before their last logout (POST
    // /auth/logout increments it) and must be treated exactly like a
    // missing/invalid session - just don't populate req.authedUser, same
    // as the isActive/brokerageId checks already do below.
    if (row && row.isActive && row.brokerageId && row.sessionEpoch === verified.epoch) {
      req.authedUser = { id: row.id, role: row.role as UserRole, brokerageId: row.brokerageId };
    }
  } catch (err) {
    console.error("loadSession failed", err);
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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
