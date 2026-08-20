import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, parties, propertyParties, properties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";

export const partiesRouter = Router();

// One-time party capture (Build Brief §4): minimum fields only; entity
// structure detail (trust/company/estate) is requested only when needed.
const addPartySchema = z.object({
  propertyId: z.number(),
  role: z.enum(["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"]),
  partyType: z.enum(["Person", "Organisation", "Trust", "Estate", "Other"]).default("Person"),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  lastName: z.string().optional(),
  organisationName: z.string().optional(),
  mobile: z.string().optional(),
  email: z.string().email().optional(),
  residentialAddress: z.string().optional(),
});

partiesRouter.post("/", requireAuth, async (req, res) => {
  const parsed = addPartySchema.safeParse(req.body);
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

  const [party] = await db
    .insert(parties)
    .values({
      brokerageId: user.brokerageId,
      partyType: parsed.data.partyType,
      firstName: parsed.data.firstName,
      middleName: parsed.data.middleName,
      lastName: parsed.data.lastName,
      organisationName: parsed.data.organisationName,
      mobile: parsed.data.mobile,
      email: parsed.data.email,
      residentialAddress: parsed.data.residentialAddress,
    })
    .returning();

  const [link] = await db
    .insert(propertyParties)
    .values({ propertyId: parsed.data.propertyId, partyId: party.id, role: parsed.data.role })
    .returning();

  await logAudit({
    userId: user.id,
    action: "party_added",
    recordType: "party",
    recordId: String(party.id),
    propertyId: parsed.data.propertyId,
  });

  res.status(201).json({ party, link });
});

partiesRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  const partyIds = links.map((l) => l.partyId);
  const allParties = partyIds.length
    ? await db.select().from(parties)
    : [];
  const partyRows = allParties.filter((p) => partyIds.includes(p.id));

  res.json({
    parties: links.map((link) => ({
      role: link.role,
      party: partyRows.find((p) => p.id === link.partyId) ?? null,
    })),
  });
});
