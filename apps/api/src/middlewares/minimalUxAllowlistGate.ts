import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { isMinimalUxAllowlisted, isMinimalUxFlagEnabled, parseMinimalUxAllowlist, MINIMAL_UX_ALLOWLIST_ENV } from "../lib/minimalUx.js";

// Pilot-scope gate for Minimal-A-only Grow features (My Momentum, Market
// Activity). Mount AFTER requireAuth. Even when a feature's own flag is on,
// the API answers 404 (feature does not exist) unless AE_MINIMAL_UX_ENABLED
// is "true" AND the signed-in user is named in AE_MINIMAL_UX_ALLOWLIST.
// Decided per request from the env, so emptying the allowlist closes access
// immediately. Not an entitlement; grow.access is still required separately.
export async function requireMinimalUxAllowlisted(req: Request, res: Response, next: NextFunction): Promise<void> {
  const notFound = () => void res.status(404).json({ error: "Not found" });
  if (!isMinimalUxFlagEnabled()) return notFound();
  const authed = req.authedUser;
  if (!authed) return notFound();
  const allowlist = parseMinimalUxAllowlist(process.env[MINIMAL_UX_ALLOWLIST_ENV]);
  if (allowlist.userIds.has(authed.id)) return next();
  if (allowlist.emails.size === 0) return notFound();
  const [row] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, authed.id));
  if (!row || !isMinimalUxAllowlisted({ id: row.id, email: row.email }, allowlist)) return notFound();
  next();
}
