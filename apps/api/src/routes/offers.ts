import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, offers } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { createOffer, listOffersForProperty, withdrawOffer, declineOffer, getOfferByShareToken } from "../lib/offers.js";
import { acceptOffer } from "../lib/transactions.js";

export const offersRouter = Router();

const createOfferSchema = z.object({
  offerPriceCents: z.number().int().positive(),
  conditions: z.record(z.unknown()).optional(),
  buyerPartyId: z.number().optional(),
  buyer: z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      mobile: z.string().optional(),
    })
    .optional(),
});

offersRouter.post("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const parsed = createOfferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  try {
    const offer = await createOffer({
      propertyId,
      offerPriceCents: parsed.data.offerPriceCents,
      conditions: parsed.data.conditions,
      buyerPartyId: parsed.data.buyerPartyId,
      buyer: parsed.data.buyer,
      userId: user.id,
      brokerageId: user.brokerageId,
    });
    res.status(201).json({ offer });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

offersRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const rows = await listOffersForProperty(propertyId);
  res.json({ offers: rows });
});

offersRouter.get("/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  if (!offer) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ offer });
});

// The chokepoint that converts a Property into an active Transaction —
// idempotent, and auto-declines every other still-open offer on the
// property (see lib/transactions.ts acceptOffer).
offersRouter.post("/:id/accept", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const result = await acceptOffer({ offerId: id, userId: user.id, brokerageId: user.brokerageId });
    res.status(result.created ? 201 : 200).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

offersRouter.post("/:id/decline", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const offer = await declineOffer(id, user.id);
    res.json({ offer });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

offersRouter.post("/:id/withdraw", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  try {
    const offer = await withdrawOffer(id, user.id);
    res.json({ offer });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Public, unauthenticated — lets a buyer who submitted an offer through the
// agent check its status via the link the agent sends them (offers.shareToken
// schema comment: "public buyer-facing link, no sign-in required").
offersRouter.get("/public/:shareToken", async (req, res) => {
  const result = await getOfferByShareToken(req.params.shareToken);
  if (!result) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(result);
});
