import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, offers, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { createOffer, listOffersForProperty, withdrawOffer, declineOffer, getOfferByShareToken } from "../lib/offers.js";
import { acceptOffer } from "../lib/transactions.js";

export const offersRouter = Router();

// #123 — tenant scoping. None of these routes previously verified that the
// offer's (or property's) brokerage matched the caller's — a property id
// or offer id from any brokerage worked as long as the caller was
// authenticated at all.
async function propertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  return !!property && property.brokerageId === brokerageId;
}

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

offeredRoutersPlaceholder: any;
