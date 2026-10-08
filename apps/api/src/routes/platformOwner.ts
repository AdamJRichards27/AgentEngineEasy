import { Router } from "express";
import { z } from "zod";
import { db, brokerages } from "@aee/db";
import { eq, asc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { auditOwner, setOwnerContextCookie } from "../lib/platformOwner.js";
import { readSessionCookie } from "../lib/session.js";

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
  // The change and its precise target audit are committed atomically.
  const brokerage = await db.transaction(async tx => {
    const [created] = await tx.insert(brokerages).values({ name: parsed.data.name }).returning();
    const { platformOwnerAudit } = await import("@aee/db");
    await tx.insert(platformOwnerAudit).values({ ownerUserId: req.authedUser!.id, brokerageId: created!.id,
      action: "brokerage_created", method: req.method, surface: "owner" });
    return created!;
  });
  res.status(201).json({ brokerage: { id: brokerage.id, name: brokerage.name } });
});
platformOwnerRouter.patch("/brokerages/:id", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = nameSchema.safeParse(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !parsed.success) { res.status(400).json({ error: "Invalid brokerage or name." }); return; }
  const brokerage = await db.transaction(async tx => {
    const [updated] = await tx.update(brokerages).set({ name: parsed.data.name, updatedAt: new Date() }).where(eq(brokerages.id, id)).returning();
    if (!updated) return null;
    const { platformOwnerAudit } = await import("@aee/db");
    await tx.insert(platformOwnerAudit).values({ ownerUserId: req.authedUser!.id, brokerageId: id,
      action: "brokerage_renamed", method: req.method, surface: "owner" });
    return updated;
  });
  if (!brokerage) { res.status(404).json({ error: "Brokerage not found." }); return; }
  res.json({ brokerage: { id: brokerage.id, name: brokerage.name } });
});
platformOwnerRouter.post("/context", async (req, res) => {
  const parsed = z.object({ brokerageId: z.number().int().positive().nullable() }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Select a brokerage or exit to the Owner console." }); return; }
  const { brokerageId } = parsed.data;
  if (brokerageId !== null) {
    const [exists] = await db.select({ id: brokerages.id }).from(brokerages).where(eq(brokerages.id, brokerageId));
    if (!exists) { res.status(404).json({ error: "Brokerage not found." }); return; }
  }
  await auditOwner(req, brokerageId === null ? "context_exited" : "context_selected", brokerageId);
  setOwnerContextCookie(res, brokerageId, readSessionCookie(req.headers.cookie)!);
  res.json({ selectedBrokerageId: brokerageId });
});
