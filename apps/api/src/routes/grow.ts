import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  growActivities,
  growOpportunities,
  growRelationships,
  parties,
  properties,
} from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { resolveEntitlements } from "../lib/entitlements/resolver.js";
import { newCorrelationId, publishDomainEvent } from "@aee/events";

export const growRouter = Router();

// Every route below is authenticated first. Beyond that, /access is intentionally the ONLY
// route that does not also requireEntitlement("grow.access") - it exists so the frontend can
// ask "should I show the locked shell or the real one" without the answer itself ever being
// used as an access-control decision. No protected Grow data is returned from here.
growRouter.get("/access", requireAuth, async (req, res) => {
  const entitlements = await resolveEntitlements(req.authedUser!);
  res.json({
    entitled: entitlements.has("grow.access"),
    entitlements: Array.from(entitlements),
  });
});

// Minimal proving overview: counts only, scoped strictly to the caller's brokerageId. Never
// trusts a client-supplied brokerageId - always req.authedUser.brokerageId.
growRouter.get("/overview", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const [relationships, activities, opportunities] = await Promise.all([
    db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerageId)),
    db.select().from(growActivities).where(eq(growActivities.brokerageId, brokerageId)),
    db.select().from(growOpportunities).where(eq(growOpportunities.brokerageId, brokerageId)),
  ]);
  res.json({
    relationshipCount: relationships.length,
    activityCount: activities.length,
    openOpportunityCount: opportunities.filter((o) => o.status === "Open").length,
  });
});

growRouter.get("/relationships", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const rows = await db
    .select({
      id: growRelationships.id,
      relationshipType: growRelationships.relationshipType,
      role: growRelationships.role,
      status: growRelationships.status,
      isPrimary: growRelationships.isPrimary,
      confidenceScore: growRelationships.confidenceScore,
      validFrom: growRelationships.validFrom,
      validTo: growRelationships.validTo,
      partyId: growRelationships.partyId,
      partyFirstName: parties.firstName,
      partyLastName: parties.lastName,
      partyOrganisationName: parties.organisationName,
      propertyId: growRelationships.propertyId,
      propertyAddress: properties.formattedAddress,
    })
    .from(growRelationships)
    .innerJoin(parties, eq(growRelationships.partyId, parties.id))
    .innerJoin(properties, eq(growRelationships.propertyId, properties.id))
    .where(eq(growRelationships.brokerageId, brokerageId))
    .orderBy(desc(growRelationships.createdAt))
    .limit(200);
  res.json({ relationships: rows });
});

growRouter.post(
  "/relationships",
  requireAuth,
  requireEntitlement("grow.relationships.manage"),
  async (req, res) => {
    const user = req.authedUser!;
    const partyId = Number(req.body?.partyId);
    const propertyId = Number(req.body?.propertyId);
    const relationshipType = typeof req.body?.relationshipType === "string" ? req.body.relationshipType : undefined;
    if (!partyId || !propertyId || !relationshipType) {
      res.status(400).json({ error: "partyId, propertyId, and relationshipType are required" });
      return;
    }

    // Tenant isolation on the referenced rows, not just the new row: a canonical party/property
    // from another brokerage can never be linked into this brokerage's Grow relationships.
    const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
    const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
    if (!party || !property) {
      res.status(404).json({ error: "Party or property not found in this brokerage" });
      return;
    }

    const [inserted] = await db
      .insert(growRelationships)
      .values({
        brokerageId: user.brokerageId,
        partyId,
        propertyId,
        relationshipType,
        role: typeof req.body?.role === "string" ? req.body.role : null,
        status: "Active",
        isPrimary: Boolean(req.body?.isPrimary),
        confidenceScore: typeof req.body?.confidenceScore === "number" ? String(req.body.confidenceScore) : null,
        sourceType: typeof req.body?.sourceType === "string" ? req.body.sourceType : "manual",
        sourceEvidence: typeof req.body?.sourceEvidence === "string" ? req.body.sourceEvidence : null,
        createdBy: user.id,
      })
      .returning();

    try {
      await publishDomainEvent({
        eventType: "RELATIONSHIP_CREATED",
        occurredAt: new Date(),
        propertyId,
        transactionId: null,
        partyId,
        brokerageId: user.brokerageId,
        agentId: user.id,
        actorType: "USER",
        actorId: user.id,
        source: "api:grow:relationships:create",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `relationship-created:${inserted.id}`,
        payload: { relationshipId: inserted.id, relationshipType, role: inserted.role },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(RELATIONSHIP_CREATED) failed", err);
    }

    res.status(201).json({ relationship: inserted });
  },
);

growRouter.patch(
  "/relationships/:id",
  requireAuth,
  requireEntitlement("grow.relationships.manage"),
  async (req, res) => {
    const user = req.authedUser!;
    const id = Number(req.params.id);
    const [existing] = await db
      .select()
      .from(growRelationships)
      .where(and(eq(growRelationships.id, id), eq(growRelationships.brokerageId, user.brokerageId)))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Relationship not found" });
      return;
    }

    const status = typeof req.body?.status === "string" ? req.body.status : existing.status;
    const role = typeof req.body?.role === "string" ? req.body.role : existing.role;
    const isPrimary = typeof req.body?.isPrimary === "boolean" ? req.body.isPrimary : existing.isPrimary;

    const [updated] = await db
      .update(growRelationships)
      .set({ status, role, isPrimary, updatedAt: new Date() })
      .where(eq(growRelationships.id, id))
      .returning();

    try {
      await publishDomainEvent({
        eventType: "RELATIONSHIP_UPDATED",
        occurredAt: new Date(),
        propertyId: existing.propertyId,
        transactionId: null,
        partyId: existing.partyId,
        brokerageId: user.brokerageId,
        agentId: user.id,
        actorType: "USER",
        actorId: user.id,
        source: "api:grow:relationships:update",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `relationship-updated:${id}:${Date.now()}`,
        payload: { relationshipId: id, status, role },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(RELATIONSHIP_UPDATED) failed", err);
    }

    res.json({ relationship: updated });
  },
);

growRouter.get("/activities", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const rows = await db
    .select()
    .from(growActivities)
    .where(eq(growActivities.brokerageId, brokerageId))
    .orderBy(desc(growActivities.occurredAt))
    .limit(200);
  res.json({ activities: rows });
});

growRouter.post("/activities", requireAuth, requireEntitlement("grow.activities.manage"), async (req, res) => {
  const user = req.authedUser!;
  const activityType = typeof req.body?.activityType === "string" ? req.body.activityType : undefined;
  const summary = typeof req.body?.summary === "string" ? req.body.summary : undefined;
  if (!activityType || !summary) {
    res.status(400).json({ error: "activityType and summary are required" });
    return;
  }

  const partyId = typeof req.body?.partyId === "number" ? req.body.partyId : null;
  const propertyId = typeof req.body?.propertyId === "number" ? req.body.propertyId : null;
  const opportunityId = typeof req.body?.opportunityId === "number" ? req.body.opportunityId : null;

  // Tenant isolation on the referenced rows, not just the new row: mirrors the same check in
  // POST /relationships above. All three are optional here (unlike partyId/propertyId on
  // /relationships), so only the ids actually supplied are looked up -- but any one of them that
  // IS supplied must belong to this brokerage, or a Grow activity could be used to attach a
  // dangling/cross-tenant reference onto another brokerage's real party/property/opportunity.
  if (partyId !== null) {
    const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
    if (!party) {
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }
  }
  if (propertyId !== null) {
    const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
    if (!property) {
      res.status(404).json({ error: "Property not found in this brokerage" });
      return;
    }
  }
  if (opportunityId !== null) {
    const [opportunity] = await db
      .select()
      .from(growOpportunities)
      .where(and(eq(growOpportunities.id, opportunityId), eq(growOpportunities.brokerageId, user.brokerageId)))
      .limit(1);
    if (!opportunity) {
      res.status(404).json({ error: "Opportunity not found in this brokerage" });
      return;
    }
  }

  const [inserted] = await db
    .insert(growActivities)
    .values({
      brokerageId: user.brokerageId,
      partyId,
      propertyId,
      opportunityId,
      activityType,
      occurredAt: req.body?.occurredAt ? new Date(req.body.occurredAt) : new Date(),
      summary,
      details: req.body?.details ?? {},
      responsibleUserId: user.id,
      source: "manual",
    })
    .returning();

  res.status(201).json({ activity: inserted });
});

growRouter.get("/opportunities", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const rows = await db
    .select()
    .from(growOpportunities)
    .where(eq(growOpportunities.brokerageId, brokerageId))
    .orderBy(desc(growOpportunities.createdAt))
    .limit(200);
  res.json({ opportunities: rows });
});

growRouter.post(
  "/opportunities",
  requireAuth,
  requireEntitlement("grow.opportunities.manage"),
  async (req, res) => {
    const user = req.authedUser!;
    const partyId = Number(req.body?.partyId);
    const opportunityType = typeof req.body?.opportunityType === "string" ? req.body.opportunityType : undefined;
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    if (!partyId || !opportunityType || !reason) {
      res.status(400).json({ error: "partyId, opportunityType, and reason are required" });
      return;
    }

    const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
    if (!party) {
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }

    const [inserted] = await db
      .insert(growOpportunities)
      .values({
        brokerageId: user.brokerageId,
        partyId,
        propertyId: typeof req.body?.propertyId === "number" ? req.body.propertyId : null,
        opportunityType,
        status: "Open",
        stage: "New",
        ownerUserId: user.id,
        source: "manual",
        reason,
      })
      .returning();

    try {
      await publishDomainEvent({
        eventType: "OPPORTUNITY_CREATED",
        occurredAt: new Date(),
        propertyId: inserted.propertyId,
        transactionId: null,
        partyId,
        brokerageId: user.brokerageId,
        agentId: user.id,
        actorType: "USER",
        actorId: user.id,
        source: "api:grow:opportunities:create",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `opportunity-created:${inserted.id}`,
        payload: { opportunityId: inserted.id, opportunityType, reason },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(OPPORTUNITY_CREATED) failed", err);
    }

    res.status(201).json({ opportunity: inserted });
  },
);
