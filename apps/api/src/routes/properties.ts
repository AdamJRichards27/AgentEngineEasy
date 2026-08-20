import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, properties, propertyParties, parties, workflows, workflowSteps, insertPropertySchema } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createPropertyDataProvider } from "@aee/integration-property-data";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";

export const propertiesRouter = Router();
const propertyDataProvider = createPropertyDataProvider();

const READY_TO_LIST_STEPS = [
  { stepKey: "VerifySellers", label: "Verify Sellers", sequence: 1 },
  { stepKey: "AgencyAgreement", label: "Agency Agreement", sequence: 2 },
  { stepKey: "RequiredDocuments", label: "Required Documents", sequence: 3 },
];

// Start Property (Build Brief §3): search or manually create an address,
// establish the Property Record immediately, gather everything else
// progressively rather than via one large creation form.
propertiesRouter.get("/address-search", requireAuth, async (req, res) => {
  const query = String(req.query.q ?? "");
  if (!query) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const candidates = await propertyDataProvider.searchAddress(query);
  res.json({ candidates });
});

const startPropertySchema = z.object({
  formattedAddress: z.string().min(1),
  placeId: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  isManualAddress: z.boolean().optional().default(false),
});

propertiesRouter.post("/", requireAuth, async (req, res) => {
  const parsed = startPropertySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  let ownershipData = null;
  if (parsed.data.placeId) {
    // Ownership check (Build Brief §8) — surfaced as a review prompt later,
    // never a hard block, since trusts/companies/estates/POAs can legitimately differ.
    ownershipData = await propertyDataProvider.lookupOwnership(parsed.data.placeId);
  }

  const [property] = await db
    .insert(properties)
    .values({
      brokerageId: user.brokerageId,
      agentId: user.id,
      formattedAddress: parsed.data.formattedAddress,
      placeId: parsed.data.placeId,
      suburb: parsed.data.suburb,
      state: parsed.data.state,
      postcode: parsed.data.postcode,
      isManualAddress: parsed.data.isManualAddress,
      ownershipData,
    })
    .returning();

  const correlationId = newCorrelationId();

  await logAudit({
    userId: user.id,
    action: "property_created",
    recordType: "property",
    recordId: String(property.id),
    propertyId: property.id,
  });

  try {
    await publishDomainEvent({
      eventType: "PROPERTY_CREATED",
      occurredAt: new Date(),
      propertyId: property.id,
      transactionId: null,
      partyId: null,
      brokerageId: user.brokerageId,
      agentId: user.id,
      actorType: "USER",
      actorId: user.id,
      source: "api:properties:start",
      correlationId,
      causationId: null,
      idempotencyKey: `property-created:${property.id}`,
      payload: { propertyId: property.id },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(PROPERTY_CREATED) failed", err);
  }

  res.status(201).json({ property });
});

propertiesRouter.get("/", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const rows = await db.select().from(properties).where(eq(properties.brokerageId, user.brokerageId));
  res.json({ properties: rows });
});

propertiesRouter.get("/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ property });
});

// The Property Action Screen's data source (ARCHITECTURE.md §4) — one
// response shaped for "what needs to happen next", not fifteen sub-screens.
propertiesRouter.get("/:id/workspace", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, id));
  const partyRows = links.length
    ? await db.select().from(parties).where(eq(parties.id, links[0].partyId))
    : [];

  const [workflow] = await db.select().from(workflows).where(eq(workflows.propertyId, id));
  const steps = workflow
    ? await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id))
    : [];

  res.json({
    property,
    parties: links.map((link) => ({
      role: link.role,
      partyId: link.partyId,
      party: partyRows.find((p) => p.id === link.partyId) ?? null,
    })),
    nextActions: steps
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({ label: s.label, status: s.status, blockedReason: s.blockedReason })),
  });
});

// Ready to List (Build Brief §5): once selected, AgentEngineEasy determines
// and orchestrates the required next steps — the agent does not separately
// visit an AML screen, a documents screen, and an e-signature screen.
propertiesRouter.post("/:id/ready-to-list", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [workflow] = await db
    .insert(workflows)
    .values({ propertyId: id, workflowType: "ReadyToList" })
    .returning();

  await db.insert(workflowSteps).values(
    READY_TO_LIST_STEPS.map((step) => ({ workflowId: workflow.id, ...step })),
  );

  await db.update(properties).set({ workflowStage: "Ready to List" }).where(eq(properties.id, id));

  try {
    await publishDomainEvent({
      eventType: "READY_TO_LIST",
      occurredAt: new Date(),
      propertyId: id,
      transactionId: null,
      partyId: null,
      brokerageId: user.brokerageId,
      agentId: user.id,
      actorType: "USER",
      actorId: user.id,
      source: "api:properties:ready-to-list",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `ready-to-list:${id}`,
      payload: { propertyId: id, workflowId: workflow.id },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(READY_TO_LIST) failed", err);
  }

  res.json({ workflow, steps: READY_TO_LIST_STEPS });
});

export const _internal = { insertPropertySchema }; // re-export for tests
