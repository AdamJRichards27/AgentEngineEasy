// AE GROW Pilot Readiness WP2a (P0-1): side-effect import. Every app built
// via createApp() (app.ts imports this module) and every route module
// (they import requireAuth from here) therefore runs with async-rejection
// forwarding installed — including in tests that build the app directly.
import "../lib/asyncRouteErrors.js";
import type { Request, Response, NextFunction } from "express";
import { db, users, type UserRole } from "@aee/db";
import { eq } from "drizzle-orm";
import { logger, incrementCounter } from "@aee/events";
import { readSessionCookie, verifySessionToken } from "../lib/session.js";
import { applyPlatformOwnerContext } from "../lib/platformOwner.js";

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
export async function loadSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  let token: string | undefined;
  let verified: ReturnType<typeof verifySessionToken> = null;
  try {
    token = readSessionCookie(req.headers.cookie);
    verified = verifySessionToken(token);
  } catch (err) {
    // A malformed Cookie header (e.g. an invalid percent-escape that
    // decodeURIComponent rejects) is a client-side problem, not an outage:
    // treat it as an invalid session, exactly as before.
    logger.warn("load_session_cookie_unparseable", { error: err instanceof Error ? err.message : String(err) });
    verified = null;
  }
  if (!verified) {
    // AE Step 2 closure — Part B: only a PRESENT-but-invalid token is a
    // security-relevant signal (tampered/expired/malformed — a proxy for
    // session-forgery attempts) — a request with no cookie at all is
    // ordinary unauthenticated traffic (most webhook/public routes) and
    // must not inflate this counter. See docs/METRICS_ALERTS_AND_SERVICE_OBJECTIVES.md.
    if (token) {
      incrementCounter("auth_security_event_total", { event: "invalid_session_token" });
      // AE GROW Pilot Readiness: the counter alone cannot be correlated with a
      // user's report ("I was signed out"), so record the shape of the failure
      // — never the token itself, and no PII.
      logger.warn("load_session_token_rejected", { correlationId: req.correlationId });
    }
    next();
    return;
  }
  let row: typeof users.$inferSelect | undefined;
  try {
    [row] = await db.select().from(users).where(eq(users.id, verified.uid));
  } catch (err) {
    // AE GROW Pilot Readiness WP2a: a cryptographically valid, unexpired
    // session whose user row could not be LOADED (database blip, pool
    // exhaustion) is not an unauthenticated request. Previously this fell
    // through with req.authedUser unset, so every protected route answered
    // 401 and the web app logged the user out during a transient outage.
    // Answer 503 (retryable) instead; genuinely invalid, expired, revoked or
    // deactivated sessions still reach the 401 paths below/in requireAuth.
    logger.error("load_session_failed", {
      error: err instanceof Error ? err.message : String(err),
      userId: verified.uid,
      outcome: "service_unavailable",
    });
    res.setHeader("Retry-After", "5");
    res.status(503).json({ error: "Your session could not be verified right now. Please try again shortly." });
    return;
  }
  // Foundation Remediation - server-side session revocation: a token
  // whose embedded epoch (lib/session.ts) no longer matches the user's
  // current sessionEpoch was issued before their last logout (POST
  // /auth/logout increments it) and must be treated exactly like a
  // missing/invalid session - just don't populate req.authedUser, same
  // as the isActive/brokerageId checks already do below.
  if (row && row.isActive && row.brokerageId && row.sessionEpoch === verified.epoch) {
    req.authedUser = { id: row.id, role: row.role as UserRole, brokerageId: row.brokerageId };
    try {
      // A missing platform_owners table is handled inside
      // applyPlatformOwnerContext: normal users continue, and only the
      // owner privilege surface fails closed. This catch remains for a
      // confirmed owner whose mandatory audit write failed.
      if (!await applyPlatformOwnerContext(req, res, verified.iat)) return;
    } catch {
      res.status(503).json({ error: "Your access could not be verified. Please retry." });
      return;
    }
  } else if (!row || !row.isActive || !row.brokerageId) {
    // AE GROW Pilot Readiness: this branch was completely silent, so a
    // cryptographically valid session that stopped resolving produced a bare
    // 401 with nothing in the logs to explain it — the hardest possible thing
    // to support during a pilot, and the reason a long-standing intermittent
    // 401 in the test suite resisted diagnosis. Ids only, never PII.
    logger.warn("load_session_user_unusable", {
      userId: verified.uid,
      reason: !row ? "user_row_missing" : !row.isActive ? "user_inactive" : "user_without_brokerage",
    });
  } else if (row && row.sessionEpoch !== verified.epoch) {
    // A cryptographically valid, non-expired token whose embedded epoch
    // is stale — exactly the "captured via XSS, replayed after the
    // legitimate user logged out" scenario logout-everywhere semantics
    // exist to close off (see the epoch comment above).
    incrementCounter("auth_security_event_total", { event: "revoked_session_reused" });
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
