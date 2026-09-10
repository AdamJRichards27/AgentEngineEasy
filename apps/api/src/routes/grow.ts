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
import { currentCorrelationId, logger, publishDomainEvent } from "@aee/events";
import { getBillingProvider } from "../lib/billing/gateway.js";

export const growRouter = Router();

// Every route below is authenticated first. Beyond that, /access is intentionally the ONLY
// route that does not also requireEntitlement("grow.access") - it exists so the frontend can
// ask "should I show the locked shell or the real one" without the answer itself ever being
// used as an access-control decision. No protected Grow data is returned from here.
//
// billingProviderName (Critical Blocker Remediation, Phase 10): surfaces which billing
// provider a checkout from this screen would actually use, so the "Add Grow" upgrade
// screen can honestly label itself — see apps/web/src/pages/Grow.tsx. Reading
// getBillingProvider().name here never itself triggers a checkout or any external call;
// it only reports the outcome of the same fail-closed provider selection
// POST /billing/checkout already uses.
growRouter.get("/access", requireAuth, async (req, res) => {
  const entitlements = await resolveEntitlements(req.authedUser!);
  res.json({
    entitled: entitlements.has("grow.access"),
    entitlements: Array.from(entitlements),
    billingProviderName: getBillingProvider().name,
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

// AE GROW Priority 0.5 — Workstream 6: leftJoin (not innerJoin) against `properties`, matching
// growRelationships.propertyId now being nullable (packages/db/src/schema/grow.ts). A
// pre-property relationship (no propertyId at all) must still be returned here — an innerJoin
// would silently drop it from every list response, which is exactly the "prospecting contact
// disappears from the list" bug a naive migration could have introduced. propertyId/
// propertyAddress simply come back null for such a row.
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
    .leftJoin(properties, eq(growRelationships.propertyId, properties.id))
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
    const relationshipType = typeof req.body?.relationshipType === "string" ? req.body.relationshipType : undefined;
    // AE GROW Priority 0.5 — Workstream 6: propertyId is now OPTIONAL. growRelationships.
    // propertyId is nullable (packages/db/src/schema/grow.ts) so an agent can record a
    // relationship with a contact before AE knows which property is relevant — the
    // pre-property relationship the revised Grow model requires (see
    // docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md §"Pre-Property Relationship Decision"). A
    // propertyId is still accepted and, when supplied, must resolve to a real property in this
    // brokerage exactly as before — this only makes it optional, never meaningless when present.
    const propertyIdSupplied = req.body?.propertyId !== undefined && req.body?.propertyId !== null;
    const propertyId = propertyIdSupplied ? Number(req.body.propertyId) : null;
    if (!partyId || !relationshipType || (propertyIdSupplied && !propertyId)) {
      res.status(400).json({ error: "partyId and relationshipType are required; propertyId, if supplied, must be a valid id" });
      return;
    }

    // Tenant isolation on the referenced rows, not just the new row: a canonical party/property
    // from another brokerage can never be linked into this brokerage's Grow relationships. The
    // property check only runs when a propertyId was actually supplied — a relationship
    // legitimately has none yet (see the comment above).
    const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
    if (!party) {
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }
    if (propertyId !== null) {
      const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
      if (!property) {
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
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
        correlationId: currentCorrelationId(),
        causationId: null,
        idempotencyKey: `relationship-created:${inserted.id}`,
        payload: { relationshipId: inserted.id, relationshipType, role: inserted.role },
        metadata: {},
      });
    } catch (err) {
      logger.error("publish_domain_event_failed", { eventType: "RELATIONSHIP_CREATED", error: err });
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
        correlationId: currentCorrelationId(),
        causationId: null,
        idempotencyKey: `relationship-updated:${id}:${Date.now()}`,
        payload: { relationshipId: id, status, role },
        metadata: {},
      });
    } catch (err) {
      logger.error("publish_domain_event_failed", { eventType: "RELATIONSHIP_UPDATED", error: err });
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
        correlationId: currentCorrelationId(),
        causationId: null,
        idempotencyKey: `opportunity-created:${inserted.id}`,
        payload: { opportunityId: inserted.id, opportunityType, reason },
        metadata: {},
      });
    } catch (err) {
      logger.error("publish_domain_event_failed", { eventType: "OPPORTUNITY_CREATED", error: err });
    }

    res.status(201).json({ opportunity: inserted });
  },
);
