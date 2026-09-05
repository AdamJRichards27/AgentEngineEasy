import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, parties, propertyParties, properties, workflows } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { reviewOwnershipForProperty } from "../lib/ownership.js";
import { initiateAmlIfNeeded } from "../lib/aml.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";

async function readyToListWorkflowExists(propertyId: number): Promise<boolean> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "ReadyToList")));
  return Boolean(workflow);
}

export const partiesRouter = Router();

// One-time party capture (Build Brief §4): minimum fields only; entity
// structure detail (trust/company/estate) is requested only when needed.
// Multi-seller capture (ARCHITECTURE.md §10 Phase 2): a property can have
// any number of Seller links — nothing here caps it to one.
const addPartySchema = z.object({
  propertyId: z.number(),
  role: z.enum(["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"]),
  partyType: z.enum(["Person", "Organisation", "Trust", "Estate", "Other"]).default("Person"),
  isPrimary: z.boolean().optional().default(false),
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

  // Tenant-scoped in the same fetch that loads the property, not a check
  // bolted on after — a propertyId from another brokerage is
  // indistinguishable from a nonexistent one, matching
  // assertPropertyInBrokerage (lib/launch/model.ts) and
  // assertPartyOnPropertyInBrokerage (lib/aml.ts). Without this, a party
  // could be linked (and AML/ownership-review side effects triggered) on
  // an arbitrary cross-brokerage property.
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, parsed.data.propertyId), eq(properties.brokerageId, user.brokerageId)));
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
    .values({
      propertyId: parsed.data.propertyId,
      partyId: party.id,
      role: parsed.data.role,
      isPrimary: parsed.data.isPrimary,
    })
    .returning();

  await logAudit({
    userId: user.id,
    action: "party_added",
    recordType: "party",
    recordId: String(party.id),
    propertyId: parsed.data.propertyId,
  });

  if (parsed.data.role === "Seller") {
    // Re-run the ownership review-not-block check now that a seller exists
    // to compare against (Build Brief §8) — see apps/api/src/lib/ownership.ts.
    await reviewOwnershipForProperty(parsed.data.propertyId).catch((err) =>
      logger.error("review_ownership_for_property_failed", { propertyId: parsed.data.propertyId, error: err }),
    );

    // If Ready to List already ran for this property, a seller added
    // afterwards still needs AML initiated and the workflow steps
    // recomputed — Ready to List itself only covers sellers present at the
    // time it was triggered.
    if (await readyToListWorkflowExists(parsed.data.propertyId)) {
      await initiateAmlIfNeeded({
        propertyId: parsed.data.propertyId,
        partyId: party.id,
        userId: user.id,
        brokerageId: user.brokerageId,
      }).catch((err) => logger.error("initiate_aml_if_needed_failed", { propertyId: parsed.data.propertyId, partyId: party.id, error: err }));
      await refreshReadyToListSteps(parsed.data.propertyId).catch((err) =>
        logger.error("refresh_ready_to_list_steps_failed", { propertyId: parsed.data.propertyId, error: err }),
      );
    }
  }

  res.status(201).json({ party, link });
});

partiesRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;

  // Same tenant chokepoint as POST / above — without it this route leaks
  // another brokerage's party PII (name/email/mobile) to any authenticated
  // caller who guesses/enumerates a propertyId.
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  const partyIds = links.map((l) => l.partyId);
  const partyRows = partyIds.length ? await db.select().from(parties).where(inArray(parties.id, partyIds)) : [];

  res.json({
    parties: links.map((link) => ({
      linkId: link.id,
      role: link.role,
      isPrimary: link.isPrimary,
      party: partyRows.find((p) => p.id === link.partyId) ?? null,
    })),
  });
});

// Removing a mis-added seller/buyer link (multi-seller capture polish,
// Phase 2) — removes the property↔party link only; the Party record itself
// is left intact since it may be linked elsewhere or worth keeping.
partiesRouter.delete("/link/:linkId", requireAuth, async (req, res) => {
  const linkId = Number(req.params.linkId);
  const user = req.authedUser!;

  // propertyParties carries no brokerageId of its own, so the lookup joins
  // onto properties and filters by brokerageId in that same query — not a
  // check performed after the row is loaded — mirroring
  // retryAmlVerification/resolveAmlException in lib/aml.ts. Without this, any
  // authenticated user could delete another brokerage's party-property link
  // (and trigger the ownership-review/workflow-refresh side effects below on
  // that brokerage's property) just by guessing/enumerating a linkId.
  const [row] = await db
    .select({ link: propertyParties })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.id, linkId), eq(properties.brokerageId, user.brokerageId)));
  if (!row) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const link = row.link;

  await db.delete(propertyParties).where(eq(propertyParties.id, linkId));

  await logAudit({
    userId: user.id,
    action: "party_link_removed",
    recordType: "property_party",
    recordId: String(linkId),
    propertyId: link.propertyId,
  });

  if (link.role === "Seller") {
    await reviewOwnershipForProperty(link.propertyId).catch((err) =>
      logger.error("review_ownership_for_property_failed", { propertyId: link.propertyId, error: err }),
    );
    if (await readyToListWorkflowExists(link.propertyId)) {
      // The seller's existing AML verification record is left in place —
      // it's history, not deleted — but the workflow steps need to reflect
      // the current seller list.
      await refreshReadyToListSteps(link.propertyId).catch((err) =>
        logger.error("refresh_ready_to_list_steps_failed", { propertyId: link.propertyId, error: err }),
      );
    }
  }

  res.status(204).end();
});
