import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { getAppraisalByProperty, getOrCreateAppraisal, updateAppraisal, finaliseAppraisal } from "../lib/appraisals.js";

export const appraisalsRouter = Router();

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  return !!property && property.brokerageId === brokerageId;
}

appraisalsRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const appraisal = await getAppraisalByProperty(propertyId);
  res.json({ appraisal });
});

// Idempotent start — reuses an existing in-progress appraisal for this
// property instead of creating a second one (getOrCreateAppraisal).
appraisalsRouter.post("/by-property/:propertyId/start", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const result = await getOrCreateAppraisal({ propertyId, userId: user.id, brokerageId: user.brokerageId });
    res.status(result.created ? 201 : 200).json({ appraisal: result.appraisal });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

const updateAppraisalSchema = z.object({
  priceRangeLow: z.string().optional(),
  priceRangeHigh: z.string().optional(),
  comparableSales: z.unknown().optional(),
});

appraisalsRouter.post("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const parsed = updateAppraisalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const appraisal = await updateAppraisal({
      propertyId,
      userId: user.id,
      brokerageId: user.brokerageId,
      priceRangeLow: parsed.data.priceRangeLow,
      priceRangeHigh: parsed.data.priceRangeHigh,
      comparableSales: parsed.data.comparableSales,
    });
    res.json({ appraisal });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

appraisalsRouter.post("/by-property/:propertyId/finalise", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const appraisal = await finaliseAppraisal({ propertyId, userId: user.id, brokerageId: user.brokerageId });
    res.json({ appraisal });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
