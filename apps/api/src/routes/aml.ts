import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, amlVerifications, parties, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { initiateAmlIfNeeded } from "../lib/aml.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";

// Manual/direct AML request path — Ready to List (routes/properties.ts)
// covers the common case automatically, but a Brokerage Administrator or
// Pit Crew member may need to (re-)trigger a check for a party outside that
// flow. Both paths funnel through lib/aml.ts's initiateAmlIfNeeded(), so
// neither can double-order (Build Brief critical idempotency requirement).
// Full workflow (payment gate, webhook processing, exceptions) is Phase 4
// per ARCHITECTURE.md §10.
export const amlRouter = Router();

const requestSchema = z.object({
  propertyId: z.number(),
  partyId: z.number(),
  verificationType: z.string().default("Individual"),
});

amlRouter.post("/request", requireAuth, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  const [property] = await db.select().from(properties).where(eq(properties.id, parsed.data.propertyId));
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  const [party] = await db.select().from(parties).where(eq(parties.id, parsed.data.partyId));
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }

  const { verification, created } = await initiateAmlIfNeeded({
    propertyId: parsed.data.propertyId,
    partyId: parsed.data.partyId,
    verificationType: parsed.data.verificationType,
    userId: user.id,
    brokerageId: user.brokerageId,
  });

  await refreshReadyToListSteps(parsed.data.propertyId).catch((err) =>
    console.error("refreshReadyToListSteps failed", err),
  );

  res.status(created ? 201 : 200).json({ verification, created });
});

amlRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const rows = await db.select().from(amlVerifications).where(eq(amlVerifications.propertyId, propertyId));
  res.json({ verifications: rows });
});
