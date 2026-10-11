import type { Request, Response } from "express";
import { db, brokerages, invitations, platformOwners, platformOwnerAudit } from "@aee/db";
import { and, eq, gt, isNull, like, sql } from "drizzle-orm";
import { incrementCounter, logger } from "@aee/events";
import { createOwnerContextToken, verifyOwnerContextToken } from "./ownerContextToken.js";
import { readSessionCookie } from "./session.js";
import { isInsecureCookieExplicitlyAllowed } from "./env.js";
import { logAudit } from "./audit.js";

const CONTEXT_COOKIE = "aee_owner_context";

/** Absolute lifetime of a Platform Owner session. Ordinary sessions stay at 30 days. */
export const OWNER_SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cross-brokerage writes by a Platform Owner who has selected a brokerage
 * other than their home brokerage. Everything else is denied with
 * OWNER_ACTION_NOT_PERMITTED. Reads are not filtered here. Home-brokerage
 * writes stay on the caller's real administrator authority.
 * Enforced only from applyPlatformOwnerContext (global loadSession).
 */
export const OWNER_CROSS_BROKERAGE_WRITE_ALLOWLIST: readonly RegExp[] = [
  /^\/api\/auth\/admin\/users\/\d+\/disable$/,
  /^\/api\/auth\/admin\/users\/\d+\/enable$/,
  /^\/api\/auth\/admin\/invitations$/,
  /^\/api\/auth\/admin\/invitations\/\d+\/revoke$/,
  /^\/api\/auth\/admin\/succession$/,
];

const AUDIT_SURFACES = ["auth", "owner", "grow", "properties", "financial", "pit-crew", "documents", "contacts"];

export interface PlatformOwnerContext {
  homeBrokerageId: number;
  selectedBrokerageId: number | null;
}
declare global {
  namespace Express {
    interface Request { platformOwner?: PlatformOwnerContext }
  }
}

export type PlatformOwnerLookup = "yes" | "no" | "missing" | "error";

type LookupHook = (userId: number) => Promise<PlatformOwnerLookup | "passthrough">;
let lookupOverride: LookupHook | null = null;
let auditInsertOverride: (() => Promise<void>) | null = null;

function testHooksEnabled(): boolean {
  return process.env.NODE_ENV === "test";
}

/** Test-only. Simulates a missing platform_owners table or a lookup failure. */
export function __setPlatformOwnerLookupForTests(fn: LookupHook | null): void {
  if (!testHooksEnabled()) return;
  lookupOverride = fn;
}

/** Test-only. Replaces the platform_owner_audit insert so tests need not rename the table. */
export function __setPlatformOwnerAuditInsertForTests(fn: (() => Promise<void>) | null): void {
  if (!testHooksEnabled()) return;
  auditInsertOverride = fn;
}

export function __resetPlatformOwnerTestHooks(): void {
  lookupOverride = null;
  auditInsertOverride = null;
}

export function postgresErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && typeof (current as { code?: unknown }).code === "string") {
      return (current as { code: string }).code;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function noteTablesMissing(relation: string): void {
  logger.error("platform_owner_tables_missing", { relation, code: "42P01" });
  incrementCounter("platform_owner_guard_total", { event: "tables_missing" });
}

export async function lookupPlatformOwner(userId: number): Promise<PlatformOwnerLookup> {
  if (testHooksEnabled() && lookupOverride) {
    const hooked = await lookupOverride(userId);
    if (hooked !== "passthrough") {
      if (hooked === "missing") noteTablesMissing("platform_owners");
      return hooked;
    }
  }
  try {
    const [owner] = await db
      .select({ userId: platformOwners.userId })
      .from(platformOwners)
      .where(eq(platformOwners.userId, userId));
    return owner ? "yes" : "no";
  } catch (err) {
    if (postgresErrorCode(err) === "42P01") {
      noteTablesMissing("platform_owners");
      return "missing";
    }
    logger.error("platform_owner_lookup_failed", { code: postgresErrorCode(err) ?? "unknown" });
    return "error";
  }
}

export async function isPlatformOwner(userId: number): Promise<boolean> {
  const status = await lookupPlatformOwner(userId);
  if (status === "error") {
    throw Object.assign(new Error("platform owner lookup failed"), { code: "PLATFORM_OWNER_LOOKUP_FAILED" });
  }
  return status === "yes";
}

/**
 * Brokerage-admin mutations must not change another Platform Owner.
 * A missing platform_owners table means nobody is an owner ("allow").
 * Any other lookup failure is "unavailable" so the route can fail closed
 * without granting the mutation.
 */
export async function platformOwnerAdminGuard(targetUserId: number): Promise<"allow" | "protected" | "unavailable"> {
  const status = await lookupPlatformOwner(targetUserId);
  if (status === "yes") return "protected";
  if (status === "error") return "unavailable";
  return "allow";
}

/**
 * The request path as the owner guards compare it. Express routing is
 * case-insensitive and tolerates repeated slashes, so `/api/auth//Admin/...`
 * reaches the same handler as `/api/auth/admin/...`. The guards normalise the
 * same way (lower case, collapsed slashes, no trailing slash, no query, and
 * no scheme or host from an absolute-form request target) so a
 * path variant cannot be classified as a different surface than the handler
 * it is routed to.
 */
export function requestPathname(req: Request): string {
  const raw = req.originalUrl || req.url || req.path || "";
  const path = (raw.split("?")[0] ?? "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
  if (path.length > 1 && path.endsWith("/")) return path.replace(/\/+$/, "");
  return path || "/";
}

export function isOwnerCrossBrokerageWriteAllowed(pathname: string): boolean {
  return OWNER_CROSS_BROKERAGE_WRITE_ALLOWLIST.some((pattern) => pattern.test(pathname));
}

export function platformOwnerAuditSurface(req: Request): string {
  const path = requestPathname(req);
  const segments = path.split("/").filter(Boolean);
  const family = segments[0] === "api" ? (segments[1] ?? "") : (segments[0] ?? "");
  return AUDIT_SURFACES.includes(family) ? family : "other";
}

export function platformOwnerInvitationAction(invitationId: number, role: string): string {
  return `invitation_created:id=${invitationId}:role=${role}:platform_owner=1`;
}

function contextCookie(req: Request): string | undefined {
  const entry = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`${CONTEXT_COOKIE}=`));
  if (!entry) return undefined;
  try { return decodeURIComponent(entry.slice(CONTEXT_COOKIE.length + 1)); } catch { return ""; }
}

function ownerPrivilegeSurface(req: Request): boolean {
  const path = requestPathname(req);
  if (path === "/api/owner" || path.startsWith("/api/owner/")) return true;
  if (contextCookie(req)) return true;
  if (req.get("X-AEE-Owner-Action") || req.get("X-AEE-Owner-Brokerage")) return true;
  return false;
}

export function setOwnerContextCookie(res: Response, brokerageId: number | null, session: string): void {
  const secure = isInsecureCookieExplicitlyAllowed() ? "" : "; Secure";
  const value = brokerageId === null ? "" : createOwnerContextToken(brokerageId, session, process.env.SESSION_SECRET ?? "");
  res.append("Set-Cookie", `${CONTEXT_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${brokerageId === null ? 0 : 28800}${secure}`);
}

async function mirrorPlatformOwnerAction(req: Request, action: string, brokerageId: number | null): Promise<void> {
  await logAudit({
    brokerageId: brokerageId ?? undefined,
    userId: req.authedUser!.id,
    action: `platform_owner:${action}`,
    recordType: "platform_owner",
    recordId: brokerageId === null ? String(req.authedUser!.id) : String(brokerageId),
    updatedValue: "platform_owner=true",
    providerReference: req.correlationId ? `correlation:${req.correlationId}` : undefined,
  });
}

export async function auditOwner(req: Request, action: string, brokerageId: number | null): Promise<void> {
  // Await before allowing the request: audit unavailability fails closed.
  const surface = platformOwnerAuditSurface(req);
  if (testHooksEnabled() && auditInsertOverride) await auditInsertOverride();
  else {
    await db.insert(platformOwnerAudit).values({
      ownerUserId: req.authedUser!.id, brokerageId, action, method: req.method, surface,
    });
  }
  if (action !== "request_authorized") await mirrorPlatformOwnerAction(req, action, brokerageId);
}

export async function recordPlatformOwnerInvitation(input: {
  ownerUserId: number;
  brokerageId: number;
  invitationId: number;
  role: string;
  method: string;
}): Promise<void> {
  await db.insert(platformOwnerAudit).values({
    ownerUserId: input.ownerUserId,
    brokerageId: input.brokerageId,
    action: platformOwnerInvitationAction(input.invitationId, input.role),
    method: input.method,
    surface: "auth",
  });
}

export async function platformOwnerInvitationActor(invitationId: number): Promise<{ ownerUserId: number } | null> {
  try {
    const rows = await db
      .select({ ownerUserId: platformOwnerAudit.ownerUserId, action: platformOwnerAudit.action })
      .from(platformOwnerAudit)
      .where(like(platformOwnerAudit.action, `invitation_created:id=${invitationId}:%`));
    const match = rows.find((row) => row.action.includes(":platform_owner=1") && row.action.startsWith(`invitation_created:id=${invitationId}:`));
    return match ? { ownerUserId: match.ownerUserId } : null;
  } catch (err) {
    if (postgresErrorCode(err) === "42P01") return null;
    throw err;
  }
}

/**
 * Pending invitations issued by a Platform Owner who is no longer in
 * platform_owners are revoked. Already-accepted accounts are left in place:
 * there is no schema in which to cascade them, and their attribution remains
 * on the invitation row and in audit. A missing owner table does not revoke
 * rows (that is not evidence the owner was removed); the invitation simply
 * cannot be accepted until the lookup works again.
 */
export async function gatePlatformOwnerInvitation(invitationId: number): Promise<"allow" | "revoked" | "unverified"> {
  const actor = await platformOwnerInvitationActor(invitationId);
  if (!actor) return "allow";
  const status = await lookupPlatformOwner(actor.ownerUserId);
  if (status === "yes") return "allow";
  if (status === "missing" || status === "error") return "unverified";
  await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  return "revoked";
}

export async function invalidatePendingInvitationsFromRevokedOwners(brokerageId: number): Promise<void> {
  const pending = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(
      eq(invitations.brokerageId, brokerageId),
      isNull(invitations.acceptedAt),
      isNull(invitations.revokedAt),
      gt(invitations.expiresAt, new Date()),
    ));
  for (const row of pending) await gatePlatformOwnerInvitation(row.id);
}

export async function brokerageNameTaken(name: string, exceptId?: number): Promise<boolean> {
  const rows = await db
    .select({ id: brokerages.id })
    .from(brokerages)
    .where(sql`lower(${brokerages.name}) = lower(${name})`);
  return rows.some((row) => row.id !== exceptId);
}

export async function applyPlatformOwnerContext(req: Request, res: Response, sessionIssuedAtMs?: number): Promise<boolean> {
  const actor = req.authedUser!;
  const ownerStatus = await lookupPlatformOwner(actor.id);
  if (ownerStatus === "error") {
    res.status(503).json({ error: "Your access could not be verified. Please retry." });
    return false;
  }
  if (ownerStatus === "missing") {
    // Nobody can be an owner without the table. Do not 503 ordinary
    // sessions. The owner console and any presented owner context fail closed.
    if (ownerPrivilegeSurface(req)) {
      res.status(503).json({
        error: "Platform Owner access could not be verified. Please retry.",
        code: "OWNER_TABLES_MISSING",
      });
      return false;
    }
    return true;
  }
  if (ownerStatus === "no") return true;

  const ageMs = sessionIssuedAtMs === undefined ? Number.POSITIVE_INFINITY : Date.now() - sessionIssuedAtMs;
  if (!Number.isFinite(ageMs) || ageMs > OWNER_SESSION_ABSOLUTE_MS) {
    incrementCounter("platform_owner_guard_total", { event: "session_expired" });
    res.status(401).json({
      error: "Platform Owner sessions expire after 12 hours. Sign in again.",
      code: "OWNER_SESSION_EXPIRED",
    });
    return false;
  }

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
  const path = requestPathname(req);
  const personalAuth = path.startsWith("/api/auth/") && !path.startsWith("/api/auth/admin/");
  const controlSurface = path === "/api/owner" || path.startsWith("/api/owner/") ||
    path.startsWith("/api/legal/") || personalAuth || path.startsWith("/api/health");
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
  if (
    selectedBrokerageId !== null &&
    selectedBrokerageId !== homeBrokerageId &&
    WRITE_METHODS.has(req.method) &&
    !controlSurface &&
    !isOwnerCrossBrokerageWriteAllowed(path)
  ) {
    incrementCounter("platform_owner_guard_total", { event: "write_denied" });
    res.status(403).json({
      error: "Platform Owners can only change users and invitations in another brokerage.",
      code: "OWNER_ACTION_NOT_PERMITTED",
    });
    return false;
  }
  try {
    await auditOwner(req, "request_authorized", selectedBrokerageId);
  } catch (err) {
    incrementCounter("platform_owner_guard_total", { event: "audit_unavailable" });
    logger.error("platform_owner_audit_unavailable", { code: postgresErrorCode(err) ?? "unknown" });
    throw err;
  }
  return true;
}
