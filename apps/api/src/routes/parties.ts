import { Router } from "express";
import { eq, and, inArray, ne, asc } from "drizzle-orm";
import { z } from "zod";
import { db, parties, propertyParties, properties, workflows } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { restrictedPropertyIdsFor, propertyHiddenFromCaller } from "../lib/propertyVisibility.js";
import { requireAnyEntitlement } from "../middlewares/entitlement.js";
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

// R-F9 — the party boundary of tenant_isolation_rejection_total.
// Scoped loads cannot tell a missing id from one in another brokerage.
// On a miss only, one existence lookup (never on the success path) checks
// whether the record belongs to another brokerage and, if so, increments
// once with boundary "party". The lookup selects no brokerage id and no
// other tenant's columns (no party PII). Callers still answer 404 either
// way. Same rule as routes/transactions.ts and routes/offers.ts: a missing
// row does not increment, and the other brokerage's id is not logged or
// returned.
async function notePartyPropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)));
  if (elsewhere) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
  }
}

async function notePartyLinkIsolationRejection(linkId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(linkId) || linkId <= 0) return;
  const [elsewhere] = await db
    .select({ id: propertyParties.id })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.id, linkId), ne(properties.brokerageId, brokerageId)));
  if (elsewhere) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
  }
}

export const partiesRouter = Router();

// t228u Priority 1: property contacts belong to Grow (kept per t223u) and Run.
// An active grant for either product is required; an unsubscribed brokerage
// gets 403 on reads and writes. Mutations additionally need access to the
// specific property (own-property scope, #147): hidden properties answer 404,
// the same as a cross-brokerage id.
const canReadPropertyContacts = requireAnyEntitlement("grow.contacts.read", "run.access");
const canManagePropertyContacts = requireAnyEntitlement("grow.contacts.manage", "run.access");

/** property_parties.role values accepted by the API (text column; no DB enum). */
export const PROPERTY_PARTY_ROLES = ["Seller", "Buyer", "Solicitor", "PowerOfAttorney", "Other"] as const;

// One-time party capture (Build Brief §4): minimum fields only; entity
// structure detail (trust/company/estate) is requested only when needed.
// Multi-seller capture (ARCHITECTURE.md §10 Phase 2): a property can have
// any number of Seller links — nothing here caps it to one.
const addPartySchema = z.object({
  propertyId: z.number(),
  role: z.enum(PROPERTY_PARTY_ROLES),
  partyType: z.enum(["Person", "Organisation", "Trust", "Estate", "Other"]).default("Person"),
  isPrimary: z.boolean().optional().default(false),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  lastName: z.string().optional(),
  organisationName: z.string().optional(),
  mobile: z.string().optional(),
  email: z.string().email().optional(),
  residentialAddress: z.string().optional(),
  // AE Minimal v1.0 (Owner t149u): link an EXISTING contact instead of
  // creating one. When present, no contact fields are read and no party row
  // is inserted. Omitted = the original create-and-link behaviour.
  partyId: z.number().int().positive().optional(),
});

// Party boundary twin of notePartyPropertyIsolationRejection: on a miss only.
async function notePartyIsolationRejection(partyId: number, brokerageId: number): Promise<void> {
  const [elsewhere] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), ne(parties.brokerageId, brokerageId)));
  if (elsewhere) incrementCounter("tenant_isolation_rejection_total", { boundary: "party" });
}

async function runSellerSideEffects(propertyId: number, partyId: number, user: { id: number; brokerageId: number }) {
  // Re-run the ownership review-not-block check now that a seller exists
  // to compare against (Build Brief §8) — see apps/api/src/lib/ownership.ts.
  await reviewOwnershipForProperty(propertyId).catch((err) =>
    logger.error("review_ownership_for_property_failed", { propertyId, error: err }),
  );
  // If Ready to List already ran for this property, a seller added
  // afterwards still needs AML initiated and the workflow steps recomputed.
  if (await readyToListWorkflowExists(propertyId)) {
    await initiateAmlIfNeeded({ propertyId, partyId, userId: user.id, brokerageId: user.brokerageId }).catch((err) =>
      logger.error("initiate_aml_if_needed_failed", { propertyId, partyId, error: err }),
    );
    await refreshReadyToListSteps(propertyId).catch((err) =>
      logger.error("refresh_ready_to_list_steps_failed", { propertyId, error: err }),
    );
  }
}

partiesRouter.post("/", requireAuth, canManagePropertyContacts, async (req, res) => {
  const parsed = addPartySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  if (parsed.data.partyId !== undefined) {
    const { propertyId, partyId, role, isPrimary } = parsed.data;
    if (await propertyHiddenFromCaller(user, propertyId)) {
      res.status(404).json({ error: "Property not found" });
      return;
    }
    // One transaction; the property row is locked FOR UPDATE so concurrent
    // submissions for the same property serialise and the duplicate check
    // below cannot race. property_parties has no unique constraint and this
    // change adds no migration (Owner t149u), so the lock is the guard.
    const outcome = await db.transaction(async (tx) => {
      const [property] = await tx
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId)))
        .for("update");
      if (!property) return { kind: "property_missing" as const };
      const [party] = await tx
        .select()
        .from(parties)
        .where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
      if (!party) return { kind: "party_missing" as const };
      const [existing] = await tx
        .select()
        .from(propertyParties)
        .where(and(eq(propertyParties.propertyId, propertyId), eq(propertyParties.partyId, partyId), eq(propertyParties.role, role)));
      if (existing) return { kind: "exists" as const, party, link: existing };
      const [link] = await tx.insert(propertyParties).values({ propertyId, partyId, role, isPrimary }).returning();
      return { kind: "created" as const, party, link };
    });
    if (outcome.kind === "property_missing") {
      await notePartyPropertyIsolationRejection(propertyId, user.brokerageId);
      res.status(404).json({ error: "Property not found" });
      return;
    }
    if (outcome.kind === "party_missing") {
      await notePartyIsolationRejection(partyId, user.brokerageId);
      res.status(404).json({ error: "Contact not found" });
      return;
    }
    if (outcome.kind === "exists") {
      res.status(409).json({
        error: "This contact is already linked to the property with that role",
        code: "PROPERTY_PARTY_LINK_EXISTS",
        link: outcome.link,
      });
      return;
    }
    await logAudit({
      userId: user.id,
      action: "party_linked_existing",
      recordType: "party",
      recordId: String(partyId),
      propertyId,
    });
    if (role === "Seller") await runSellerSideEffects(propertyId, partyId, user);
    res.status(201).json({ party: outcome.party, link: outcome.link });
    return;
  }

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
  if (!property || (await propertyHiddenFromCaller(user, property.id))) {
    if (!property) await notePartyPropertyIsolationRejection(parsed.data.propertyId, user.brokerageId);
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

partiesRouter.get("/by-property/:propertyId", requireAuth, canReadPropertyContacts, async (req, res) => {
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
    await notePartyPropertyIsolationRejection(propertyId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const restrictTo = await restrictedPropertyIdsFor(user);
  if (restrictTo !== null && !restrictTo.includes(property.id)) {
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
partiesRouter.delete("/link/:linkId", requireAuth, canManagePropertyContacts, async (req, res) => {
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
    await notePartyLinkIsolationRejection(linkId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const link = row.link;
  if (await propertyHiddenFromCaller(user, link.propertyId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

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

// t228u Priority 2: the contact side of property_parties (authoritative for
// contact <-> property). Lists every property the caller can see that this
// contact is linked to, with role and primary flag. The contact must be in
// the caller's brokerage (404 otherwise); links on properties hidden by
// own-property scope (#147) are omitted, not revealed.
partiesRouter.get("/by-contact/:partyId", requireAuth, canReadPropertyContacts, async (req, res) => {
  const partyId = Number(req.params.partyId);
  const user = req.authedUser!;
  if (!Number.isInteger(partyId) || partyId <= 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [party] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId)));
  if (!party) {
    await notePartyIsolationRejection(partyId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  const restrictTo = await restrictedPropertyIdsFor(user);
  const rows = await db
    .select({
      linkId: propertyParties.id,
      propertyId: propertyParties.propertyId,
      role: propertyParties.role,
      isPrimary: propertyParties.isPrimary,
      createdAt: propertyParties.createdAt,
      formattedAddress: properties.formattedAddress,
      suburb: properties.suburb,
    })
    .from(propertyParties)
    .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
    .where(and(eq(propertyParties.partyId, partyId), eq(properties.brokerageId, user.brokerageId)))
    .orderBy(asc(propertyParties.propertyId), asc(propertyParties.id));
  const visible = restrictTo === null ? rows : rows.filter((r) => restrictTo.includes(r.propertyId));
  res.json({ partyId, properties: visible });
});

const updateLinkSchema = z
  .object({ role: z.enum(PROPERTY_PARTY_ROLES).optional(), isPrimary: z.boolean().optional() })
  .strict()
  .refine((v) => v.role !== undefined || v.isPrimary !== undefined, { message: "role or isPrimary is required" });

// t228u Priority 2: change a link's role and/or primary flag. Same gates as
// unlink (Grow or Run manage, brokerage, own-property scope). Changing the
// role to one this contact already holds on the property is a 409, the same
// PROPERTY_PARTY_LINK_EXISTS answer as POST. Seller side effects run when the
// Seller set changes.
partiesRouter.patch("/link/:linkId", requireAuth, canManagePropertyContacts, async (req, res) => {
  const linkId = Number(req.params.linkId);
  const user = req.authedUser!;
  const parsed = updateLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ link: propertyParties })
      .from(propertyParties)
      .innerJoin(properties, eq(propertyParties.propertyId, properties.id))
      .where(and(eq(propertyParties.id, linkId), eq(properties.brokerageId, user.brokerageId)));
    if (!row) return { kind: "missing" as const };
    const link = row.link;
    if (await propertyHiddenFromCaller(user, link.propertyId)) return { kind: "hidden" as const };
    // Same serialisation point as POST's duplicate guard.
    await tx.select({ id: properties.id }).from(properties).where(eq(properties.id, link.propertyId)).for("update");
    const role = parsed.data.role ?? link.role;
    if (role !== link.role) {
      const [clash] = await tx
        .select({ id: propertyParties.id })
        .from(propertyParties)
        .where(and(eq(propertyParties.propertyId, link.propertyId), eq(propertyParties.partyId, link.partyId), eq(propertyParties.role, role)));
      if (clash) return { kind: "exists" as const };
    }
    const [updated] = await tx
      .update(propertyParties)
      .set({ role, isPrimary: parsed.data.isPrimary ?? link.isPrimary })
      .where(eq(propertyParties.id, linkId))
      .returning();
    return { kind: "updated" as const, before: link, link: updated };
  });
  if (outcome.kind === "missing") {
    await notePartyLinkIsolationRejection(linkId, user.brokerageId);
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (outcome.kind === "hidden") {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (outcome.kind === "exists") {
    res.status(409).json({ error: "This contact is already linked to the property with that role", code: "PROPERTY_PARTY_LINK_EXISTS" });
    return;
  }
  await logAudit({
    userId: user.id,
    action: "party_link_updated",
    recordType: "property_party",
    recordId: String(linkId),
    propertyId: outcome.link.propertyId,
  });
  if (outcome.before.role !== outcome.link.role) {
    if (outcome.link.role === "Seller") {
      await runSellerSideEffects(outcome.link.propertyId, outcome.link.partyId, user);
    } else if (outcome.before.role === "Seller") {
      await reviewOwnershipForProperty(outcome.link.propertyId).catch((err) =>
        logger.error("review_ownership_for_property_failed", { propertyId: outcome.link.propertyId, error: err }),
      );
      if (await readyToListWorkflowExists(outcome.link.propertyId)) {
        await refreshReadyToListSteps(outcome.link.propertyId).catch((err) =>
          logger.error("refresh_ready_to_list_steps_failed", { propertyId: outcome.link.propertyId, error: err }),
        );
      }
    }
  }
  res.json({ link: outcome.link });
});
