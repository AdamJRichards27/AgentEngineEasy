import type { Request, Response } from "express";
import { db, brokerages, platformOwners, platformOwnerAudit } from "@aee/db";
import { eq } from "drizzle-orm";
import { createOwnerContextToken, verifyOwnerContextToken } from "./ownerContextToken.js";
import { readSessionCookie } from "./session.js";
import { isInsecureCookieExplicitlyAllowed } from "./env.js";

const CONTEXT_COOKIE = "aee_owner_context";
export interface PlatformOwnerContext {
  homeBrokerageId: number;
  selectedBrokerageId: number | null;
}
declare global {
  namespace Express {
    interface Request { platformOwner?: PlatformOwnerContext }
  }
}

export async function isPlatformOwner(userId: number): Promise<boolean> {
  const [owner] = await db.select({ userId: platformOwners.userId }).from(platformOwners).where(eq(platformOwners.userId, userId));
  return !!owner;
}
function contextCookie(req: Request): string | undefined {
  const entry = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${CONTEXT_COOKIE}=`));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice(CONTEXT_COOKIE.length + 1)); } catch { return ""; }
}
export function setOwnerContextCookie(res: Response, brokerageId: number | null, session: string): void {
  const secure = isInsecureCookieExplicitlyAllowed() ? "" : "; Secure";
  const value = brokerageId === null ? "" : createOwnerContextToken(brokerageId, session, process.env.SESSION_SECRET ?? "");
  res.append("Set-Cookie", `${CONTEXT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${brokerageId === null ? 0 : 28800}${secure}`);
}
export async function auditOwner(req: Request, action: string, brokerageId: number | null): Promise<void> {
  // Await before allowing the request: audit unavailability fails closed.
  const family = req.path.split("/")[2] ?? "";
  const surface = ["auth", "owner", "grow", "properties", "financial", "pit-crew", "documents", "contacts"].includes(family)
    ? family : "other";
  await db.insert(platformOwnerAudit).values({
    ownerUserId: req.authedUser!.id, brokerageId, action, method: req.method, surface,
  });
}
export async function applyPlatformOwnerContext(req: Request, res: Response): Promise<boolean> {
  const actor = req.authedUser!;
  const owner = await isPlatformOwner(actor.id);
  if (!owner) return true;
  const homeBrokerageId = actor.brokerageId;
  const token = contextCookie(req);
  let selectedBrokerageId: number | null = null;
  if (token) {
    selectedBrokerageId = verifyOwnerContextToken(token, readSessionCookie(req.headers.cookie) ?? "", process.env.SESSION_SECRET ?? "");
    if (selectedBrokerageId !== null) {
      const [selected] = await db.select({ id: brokerages.id }).from(brokerages).where(eq(brokerages.id, selectedBrokerageId));
      if (!selected) selectedBrokerageId = null;
    }
  }
  req.platformOwner = { homeBrokerageId, selectedBrokerageId };
  // Auth/admin routes operate on selected tenant; personal authentication
  // routes operate on the actual account and are permitted without selection.
  const personalAuth = req.path.startsWith("/api/auth/") && !req.path.startsWith("/api/auth/admin/");
  const controlSurface = req.path === "/api/owner" || req.path.startsWith("/api/owner/") ||
    req.path.startsWith("/api/legal/") || personalAuth || req.path.startsWith("/api/health");
  if (selectedBrokerageId !== null) {
    req.authedUser = { ...actor, role: "Brokerage Administrator", brokerageId: selectedBrokerageId };
  }
  if (!controlSurface && selectedBrokerageId === null) {
    res.status(409).json({ error: "Select a brokerage in the Owner console before using brokerage operations.", code: "OWNER_CONTEXT_REQUIRED" });
    return false;
  }
  if (!controlSurface && !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("X-AEE-Owner-Brokerage") !== String(selectedBrokerageId)) {
    res.status(409).json({ error: "Your brokerage context changed. Reload before making changes.", code: "OWNER_CONTEXT_CHANGED" });
    return false;
  }
  await auditOwner(req, "request_authorized", selectedBrokerageId);
  return true;
}
