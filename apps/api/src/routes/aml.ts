import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, amlVerifications, parties } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createAMLProvider } from "@aee/integration-aml";
import { requireAuth } from "../middlewares/auth.js";

// Phase 1 stub — full workflow (payment gate, webhook processing, exceptions)
// is Phase 4 per ARCHITECTURE.md §10. This establishes the shape: AML must
// be triggered from the property/party flow, never operated as a standalone
// screen the agent has to separately visit (Build Brief §6).
export const amlRouter = Router();
const amlProvider = createAMLProvider();

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

  const [party] = await db.select().from(parties).where(eq(parties.id, parsed.data.partyId));
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }

  const { providerReference } = await amlProvider.requestVerification({
    propertyId: parsed.data.propertyId,
    partyId: parsed.data.partyId,
    verificationType: parsed.data.verificationType,
    partyDetails: {
      firstName: party.firstName ?? undefined,
      middleName: party.middleName ?? undefined,
      lastName: party.lastName ?? undefined,
      email: party.email ?? undefined,
      mobile: party.mobile ?? undefined,
      residentialAddress: party.residentialAddress ?? undefined,
    },
  });

  const [verification] = await db
    .insert(amlVerifications)
    .values({
      propertyId: parsed.data.propertyId,
      partyId: parsed.data.partyId,
      provider: process.env.AML_PROVIDER ?? "mock",
      providerReference,
      verificationType: parsed.data.verificationType,
      status: "Awaiting Seller",
      requestedAt: new Date(),
      createdBy: user.id,
    })
    .returning();

  try {
    await publishDomainEvent({
      eventType: "AML_REQUESTED",
      occurredAt: new Date(),
      propertyId: parsed.data.propertyId,
      transactionId: null,
      partyId: parsed.data.partyId,
      brokerageId: user.brokerageId,
      agentId: user.id,
      actorType: "USER",
      actorId: user.id,
      source: "api:aml:request",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `aml-requested:${verification.id}`,
      payload: { verificationId: verification.id, providerReference },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(AML_REQUESTED) failed", err);
  }

  res.status(201).json({ verification });
});

amlRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const rows = await db.select().from(amlVerifications).where(eq(amlVerifications.propertyId, propertyId));
  res.json({ verifications: rows });
});
