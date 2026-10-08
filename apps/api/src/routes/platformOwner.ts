import { Router } from "express";
import { z } from "zod";
import { db, brokerages, users, platformOwnerAudit } from "@aee/db";
import { eq, asc, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { auditOwner, brokerageNameTaken, setOwnerContextCookie } from "../lib/platformOwner.js";
import { readSessionCookie } from "../lib/session.js";
import { verifyPassword } from "../lib/auth/password.js";
import { authRateLimiter } from "../middlewares/rateLimit.js";
import { logAudit } from "../lib/audit.js";

export const platformOwnerRouter = Router();
platformOwnerRouter.use(requireAuth);
platformOwnerRouter.get("/status", (req, res) => {
  res.json(req.platformOwner ? { isOwner: true, ...req.platformOwner } : { isOwner: false });
});
platformOwnerRouter.use((req, res, next) => {
  if (!req.platformOwner) { res.status(403).json({ error: "Platform Owner access required." }); return; }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.get("X-AEE-Owner-Action") !== "1") {
    res.status(403).json({ error: "Owner action header required." }); return;
  }
  next();
});
platformOwnerRouter.get("/brokerages", async (_req, res) => {
  res.json({ brokerages: await db.select({ id: brokerages.id, name: brokerages.name }).from(brokerages).orderBy(asc(brokerages.name)) });
});
const nameSchema = z.object({ name: z.string().trim().min(1).max(160) }).strict();
platformOwnerRouter.post("/brokerages", async (req, res) => {
  const parsed = nameSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Enter a brokerage name (1–160 characters)." }); return; }
  if (await brokerageNameTaken(parsed.data.name)) {
    res.status(409).json({ error: "A brokerage with this name already exists." });
    return;
  }
  // The change and its precise target audit are committed atomically.
  const brokerage = await db.transaction(async tx => {
    const duplicates = await tx
      .select({ id: brokerages.id })
      .from(brokerages)
      .where(sql`lower(${brokerages.name}) = lower(${parsed.data.name})`);
    if (duplicates.length > 0) return null;
    const [created] = await tx.insert(brokerages).values({ name: parsed.data.name }).returning();
    await tx.insert(platformOwnerAudit).values({ ownerUserId: req.authedUser!.id, brokerageId: created!.id,
      action: "brokerage_created", method: req.method, surface: "owner" });
    return created!;
  });
  if (!brokerage) { res.status(409).json({ error: "A brokerage with this name already exists." }); return; }
  await logAudit({
    brokerageId: brokerage.id,
    userId: req.authedUser!.id,
    action: "platform_owner:brokerage_created",
    recordType: "platform_owner",
    recordId: String(brokerage.id),
    updatedValue: "platform_owner=true",
    providerReference: req.correlationId ? `correlation:${req.correlationId}` : undefined,
  });
  res.status(201).json({ brokerage: { id: brokerage.id, name: brokerage.name } });
});
platformOwnerRouter.patch("/brokerages/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = nameSchema.safeParse(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) { res.status(400).json({ error: "Invalid brokerage or name." }); return; }
  if (await brokerageNameTaken(parsed.data.name, id)) {
    res.status(409).json({ error: "A brokerage with this name already exists." });
    return;
  }
  const brokerage = await db.transaction(async tx => {
    const [existing] = await tx.select().from(brokerages).where(eq(brokerages.id, id));
    if (!existing) return "missing" as const;
    const duplicates = await tx
      .select({ id: brokerages.id })
      .from(brokerages)
      .where(sql`lower(${brokerages.name}) = lower(${parsed.data.name}) and ${brokerages.id} <> ${id}`);
    if (duplicates.length > 0) return "duplicate" as const;
    const [updated] = await tx.update(brokerages).set({ name: parsed.data.name, updatedAt: new Date() }).where(eq(brokerages.id, id)).returning();
    if (!updated) return "missing" as const;
    await tx.insert(platformOwnerAudit).values({ ownerUserId: req.authedUser!.id, brokerageId: id,
      action: `brokerage_renamed:${existing.name}=>${updated.name}`, method: req.method, surface: "owner" });
    return updated;
  });
  if (brokerage === "duplicate") { res.status(409).json({ error: "A brokerage with this name already exists." }); return; }
  if (brokerage === "missing" || !brokerage) { res.status(404).json({ error: "Brokerage not found." }); return; }
  await logAudit({
    brokerageId: brokerage.id,
    userId: req.authedUser!.id,
    action: "platform_owner:brokerage_renamed",
    recordType: "platform_owner",
    recordId: String(brokerage.id),
    updatedValue: "platform_owner=true",
    providerReference: req.correlationId ? `correlation:${req.correlationId}` : undefined,
  });
  res.json({ brokerage: { id: brokerage.id, name: brokerage.name } });
});
const contextSchema = z.object({
  brokerageId: z.number().int().positive().nullable(),
  currentPassword: z.string().min(1),
}).strict();
platformOwnerRouter.post("/context", authRateLimiter, async (req, res) => {
  const parsed = contextSchema.safeParse(req.body);
  if (!parsed.success) {
    const passwordIssue = parsed.error.issues.some((issue) => issue.path[0] === "currentPassword");
    const brokerageIssue = parsed.error.issues.some((issue) => issue.path[0] === "brokerageId");
    if (passwordIssue && !brokerageIssue) {
      res.status(401).json({ error: "Enter your current password to switch brokerage.", code: "OWNER_REAUTH_REQUIRED" });
      return;
    }
    res.status(400).json({ error: "Select a brokerage or exit to the Owner console." });
    return;
  }
  const { brokerageId, currentPassword } = parsed.data;
  const [user] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, req.authedUser!.id));
  if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
    res.status(401).json({ error: "Current password is incorrect.", code: "OWNER_REAUTH_REQUIRED" });
    return;
  }
  if (brokerageId !== null) {
    const [exists] = await db.select({ id: brokerages.id }).from(brokerages).where(eq(brokerages.id, brokerageId));
    if (!exists) { res.status(404).json({ error: "Brokerage not found." }); return; }
  }
  await auditOwner(req, brokerageId === null ? "context_exited" : "context_selected", brokerageId);
  setOwnerContextCookie(res, brokerageId, readSessionCookie(req.headers.cookie)!);
  res.json({ selectedBrokerageId: brokerageId });
});
