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
import { explainEntitlementDecision, resolveEntitlements } from "../lib/entitlements/resolver.js";
import { currentCorrelationId, logger, publishDomainEvent } from "@aee/events";
import {
  noteGrowOpportunityIsolationRejection,
  noteGrowPartyIsolationRejection,
  noteGrowPropertyIsolationRejection,
  noteGrowRelationshipIsolationRejection,
} from "../lib/grow/isolationRejection.js";
import { getBillingProvider } from "../lib/billing/gateway.js";
import { getGrowTodaySummary } from "../lib/growToday.js";
import { logAudit } from "../lib/audit.js";
import { assertPropertyVisibleForWrite, linkedPropertyHidden, restrictedPropertyIdsFor, visibleLinkedPropertySql } from "../lib/propertyVisibility.js";

export const growRouter = Router();

// AE GROW Pilot Readiness WP6a (D1-residual): route-id validation, same
// helper shape as routes/contacts.ts's parsePositiveId. PATCH
// /grow/opportunities/:id previously passed `Number(req.params.id)` straight
// into a `where(eq(growOpportunities.id, ...))` bind, so a non-numeric id
// reached Postgres as NaN and returned 500 instead of 400. Bounded by
// MAX_SIGNED_INT4 because these ids are `serial` columns
// (packages/db/src/schema/grow.ts), i.e. int4 — an id like "1e20" is an
// integer as far as Number.isInteger is concerned but still out of range for
// the bind, which was the same 500.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

// Canonical growRelationships.status values (packages/db/src/schema/grow.ts column comment;
// "PendingReview" is also what the import pipeline writes, lib/import/execute.ts).
const GROW_RELATIONSHIP_STATUSES = ["Active", "Historical", "PendingReview"] as const;
const GROW_RELATIONSHIP_ROLE_MAX = 200;

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
  const restrictTo = await restrictedPropertyIdsFor(req.authedUser!);
  const [relationships, activities, opportunities] = await Promise.all([
    db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerageId)),
    db.select().from(growActivities).where(eq(growActivities.brokerageId, brokerageId)),
    db.select().from(growOpportunities).where(eq(growOpportunities.brokerageId, brokerageId)),
  ]);
  // Counts follow the same own-property rule as the lists below. A row with
  // no property stays in the brokerage-wide count.
  const visibleRelationships = relationships.filter((row) => !linkedPropertyHidden(row.propertyId, restrictTo));
  const visibleActivities = activities.filter((row) => !linkedPropertyHidden(row.propertyId, restrictTo));
  const visibleOpportunities = opportunities.filter((row) => !linkedPropertyHidden(row.propertyId, restrictTo));
  res.json({
    relationshipCount: visibleRelationships.length,
    activityCount: visibleActivities.length,
    openOpportunityCount: visibleOpportunities.filter((o) => o.status === "Open").length,
  });
});

// AE GROW Priority 1 — Daily Command Centre: Grow's own "what needs my attention today?"
// surface. Reuses the exact same requireAuth + requireEntitlement("grow.access") gate as every
// other Grow read route above — no separate/looser entitlement check, and no RUN/PC/financial
// data is ever read (see lib/growToday.ts's own header comment for the full boundary this
// endpoint was built to respect). One purpose-built response covers the whole screen so the
// frontend does not need to make four or five separate requests just to render Today.
//
// AE GROW Priority 5 Remediation — Rule F is a strictly additive layer on top of grow.access,
// not a second gate on the whole route: a brokerage/user with grow.access but WITHOUT
// grow.propertyIntelligence.read still gets the full, unchanged Rules A-E summary — they just
// never see a Rule F card, exactly the same "no protected data returned without its own
// entitlement, but the surrounding surface still works" shape /access's own comment above
// describes. resolveEntitlements is the same set-of-entitlement-strings helper /access already
// uses (Array.from(entitlements) / entitlements.has(...)) — reused here rather than
// requireEntitlement("grow.propertyIntelligence.read") specifically because that middleware
// would 403 the entire route for a user who simply doesn't have Property Intelligence, which is
// not the behaviour this route wants.
growRouter.get("/today", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const user = req.authedUser!;
  const entitlements = await resolveEntitlements(user);
  const summary = await getGrowTodaySummary(user.brokerageId, {
    includePropertyIntelligenceSignals: entitlements.has("grow.propertyIntelligence.read"),
    restrictToPropertyIds: await restrictedPropertyIdsFor(user),
  });
  res.json(summary);
});

// AE GROW Priority 0.5 — Workstream 6: leftJoin (not innerJoin) against `properties`, matching
// growRelationships.propertyId now being nullable (packages/db/src/schema/grow.ts). A
// pre-property relationship (no propertyId at all) must still be returned here — an innerJoin
// would silently drop it from every list response, which is exactly the "prospecting contact
// disappears from the list" bug a naive migration could have introduced. propertyId/
// propertyAddress simply come back null for such a row.
growRouter.get("/relationships", requireAuth, requireEntitlement("grow.access"), async (req, res) => {
  const user = req.authedUser!;
  const brokerageId = user.brokerageId;
  const restrictTo = await restrictedPropertyIdsFor(user);
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
    .where(and(eq(growRelationships.brokerageId, brokerageId), visibleLinkedPropertySql(growRelationships.propertyId, restrictTo)))
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
      await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }
    if (propertyId !== null) {
      const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
      if (!property) {
        await noteGrowPropertyIsolationRejection(propertyId, user.brokerageId);
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
      // Same 404 as a property outside this brokerage. The isolation counter
      // above runs only when the id belongs to another brokerage.
      if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
      // G-UAT-3: naming a property is a link, so it needs grow.properties.link
      // as well as grow.relationships.manage (already required above). The
      // catalogue grants both keys together on Grow and the Pro+Grow bundle;
      // neither key alone is described as governing the link. A relationship
      // with no propertyId keeps the manage gate only. This check runs after
      // the existing not-found responses so a hidden or cross-brokerage
      // property still answers 404 for a caller who holds the link key.
      const linkDecision = await explainEntitlementDecision(user, "grow.properties.link");
      if (linkDecision.allowed === false) {
        res.status(403).json({
          error: "Not entitled",
          reason: linkDecision.reason,
          entitlementKey: "grow.properties.link",
          upgrade: { action: "grow.checkout", productCode: "grow" },
        });
        return;
      }
      // No unique index exists. A second row for the same contact, property,
      // and relationship type in this session's brokerage is a duplicate link.
      // A different type on the same property is a different link.
      const [duplicate] = await db
        .select({ id: growRelationships.id })
        .from(growRelationships)
        .where(
          and(
            eq(growRelationships.brokerageId, user.brokerageId),
            eq(growRelationships.partyId, partyId),
            eq(growRelationships.propertyId, propertyId),
            eq(growRelationships.relationshipType, relationshipType),
          ),
        )
        .limit(1);
      if (duplicate) {
        res.status(409).json({
          error: "This contact is already linked to that property with this relationship.",
          relationshipId: duplicate.id,
        });
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
    const id = parsePositiveId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid relationship id" });
      return;
    }
    // AE GROW Pilot Readiness WP1 (P2-4): status is validated against the canonical
    // growRelationships.status values (packages/db/src/schema/grow.ts: Active | Historical |
    // PendingReview); role is a documented free-text refinement (e.g. "Executor") with no
    // canonical list, so it is bounded (non-empty string, trimmed, <= GROW_RELATIONSHIP_ROLE_MAX)
    // rather than enumerated. Validated before any database read.
    const rawStatus = req.body?.status;
    if (rawStatus !== undefined && (typeof rawStatus !== "string" || !(GROW_RELATIONSHIP_STATUSES as readonly string[]).includes(rawStatus))) {
      res.status(400).json({ error: `status must be one of: ${GROW_RELATIONSHIP_STATUSES.join(", ")}` });
      return;
    }
    const rawRole = req.body?.role;
    if (
      rawRole !== undefined &&
      rawRole !== null &&
      (typeof rawRole !== "string" || rawRole.trim().length === 0 || rawRole.length > GROW_RELATIONSHIP_ROLE_MAX)
    ) {
      res.status(400).json({ error: `role must be a non-empty string of at most ${GROW_RELATIONSHIP_ROLE_MAX} characters` });
      return;
    }
    const rawIsPrimary = req.body?.isPrimary;
    if (rawIsPrimary !== undefined && typeof rawIsPrimary !== "boolean") {
      res.status(400).json({ error: "isPrimary must be a boolean" });
      return;
    }

    const [existing] = await db
      .select()
      .from(growRelationships)
      .where(and(eq(growRelationships.id, id), eq(growRelationships.brokerageId, user.brokerageId)))
      .limit(1);
    if (!existing) {
      await noteGrowRelationshipIsolationRejection(id, user.brokerageId);
      res.status(404).json({ error: "Relationship not found" });
      return;
    }
    // A relationship tied to a property this caller cannot see is the same
    // 404 as a relationship that is not in the brokerage. A null property
    // id stays writable.
    if (!(await assertPropertyVisibleForWrite(user, existing.propertyId))) {
      res.status(404).json({ error: "Relationship not found" });
      return;
    }

    const status = typeof rawStatus === "string" ? rawStatus : existing.status;
    // null (like an omitted role) leaves the existing role unchanged, exactly as before.
    const role = typeof rawRole === "string" ? rawRole.trim() : existing.role;
    const isPrimary = typeof rawIsPrimary === "boolean" ? rawIsPrimary : existing.isPrimary;

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
  const user = req.authedUser!;
  const restrictTo = await restrictedPropertyIdsFor(user);
  const rows = await db
    .select()
    .from(growActivities)
    .where(and(eq(growActivities.brokerageId, user.brokerageId), visibleLinkedPropertySql(growActivities.propertyId, restrictTo)))
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
  // Reviewed call summaries require server-authenticated approval provenance.
  // They can only be created by the explicit transcription review Save route.
  if (activityType === "call_summary") {
    res.status(400).json({ error: "Call summaries must be saved through transcription review." });
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
      await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }
  }
  if (propertyId !== null) {
    const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, user.brokerageId))).limit(1);
    if (!property) {
      await noteGrowPropertyIsolationRejection(propertyId, user.brokerageId);
      res.status(404).json({ error: "Property not found in this brokerage" });
      return;
    }
    if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
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
      await noteGrowOpportunityIsolationRejection(opportunityId, user.brokerageId);
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
  const user = req.authedUser!;
  const restrictTo = await restrictedPropertyIdsFor(user);
  const rows = await db
    .select()
    .from(growOpportunities)
    .where(and(eq(growOpportunities.brokerageId, user.brokerageId), visibleLinkedPropertySql(growOpportunities.propertyId, restrictTo)))
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
      await noteGrowPartyIsolationRejection(partyId, user.brokerageId);
      res.status(404).json({ error: "Party not found in this brokerage" });
      return;
    }

    // propertyId used to be stored with no lookup. A supplied id must exist
    // in this brokerage and be visible, same 404 as the other Grow writes.
    // A non-number is still ignored (stored as null), as it was before.
    let propertyId: number | null = null;
    if (typeof req.body?.propertyId === "number") {
      const supplied = req.body.propertyId;
      if (!Number.isInteger(supplied) || supplied <= 0) {
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
      const [property] = await db
        .select({ id: properties.id })
        .from(properties)
        .where(and(eq(properties.id, supplied), eq(properties.brokerageId, user.brokerageId)))
        .limit(1);
      if (!property) {
        await noteGrowPropertyIsolationRejection(supplied, user.brokerageId);
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
      if (!(await assertPropertyVisibleForWrite(user, supplied))) {
        res.status(404).json({ error: "Property not found in this brokerage" });
        return;
      }
      propertyId = supplied;
    }

    const [inserted] = await db
      .insert(growOpportunities)
      .values({
        brokerageId: user.brokerageId,
        partyId,
        propertyId,
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

// AE GROW Priority 1 — Daily Command Centre: the minimal write this phase actually needs behind
// Today's "Create follow-up" action — updating an opportunity's own next-action fields. Mirrors
// the sibling PATCH /relationships/:id above (tenant-scoped lookup by id + brokerageId, 404 for
// anything outside this brokerage) but intentionally does NOT publish a new canonical domain
// event: OPPORTUNITY_CREATED/OPPORTUNITY_STAGE_CHANGED/OPPORTUNITY_CONVERTED
// (packages/events/src/types.ts) are the only Grow opportunity events that exist, and none of
// them describes "the next-action plan changed" — inventing a new event type here would mean
// touching the shared, cross-app event registry for what is a small, purely-Grow-local field
// update. logAudit() (lib/audit.ts), already used the same way by routes/parties.ts, is the
// right weight for this.
growRouter.patch(
  "/opportunities/:id",
  requireAuth,
  requireEntitlement("grow.opportunities.manage"),
  async (req, res) => {
    const user = req.authedUser!;
    const id = parsePositiveId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid opportunity id" });
      return;
    }
    const [existing] = await db
      .select()
      .from(growOpportunities)
      .where(and(eq(growOpportunities.id, id), eq(growOpportunities.brokerageId, user.brokerageId)))
      .limit(1);
    if (!existing) {
      await noteGrowOpportunityIsolationRejection(id, user.brokerageId);
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }
    if (!(await assertPropertyVisibleForWrite(user, existing.propertyId))) {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }

    const hasNextActionDueAt = Object.prototype.hasOwnProperty.call(req.body ?? {}, "nextActionDueAt");
    const hasRecommendedNextAction = Object.prototype.hasOwnProperty.call(req.body ?? {}, "recommendedNextAction");
    if (!hasNextActionDueAt && !hasRecommendedNextAction) {
      res.status(400).json({ error: "nextActionDueAt and/or recommendedNextAction must be supplied" });
      return;
    }

    let nextActionDueAt = existing.nextActionDueAt;
    if (hasNextActionDueAt) {
      if (req.body.nextActionDueAt === null) {
        nextActionDueAt = null;
      } else {
        const parsed = new Date(req.body.nextActionDueAt);
        if (Number.isNaN(parsed.getTime())) {
          res.status(400).json({ error: "nextActionDueAt must be a valid date or null" });
          return;
        }
        nextActionDueAt = parsed;
      }
    }

    const recommendedNextAction = hasRecommendedNextAction
      ? (typeof req.body.recommendedNextAction === "string" ? req.body.recommendedNextAction : null)
      : existing.recommendedNextAction;

    const [updated] = await db
      .update(growOpportunities)
      .set({ nextActionDueAt, recommendedNextAction, updatedAt: new Date() })
      .where(eq(growOpportunities.id, id))
      .returning();

    await logAudit({
      userId: user.id,
      action: "grow_opportunity_next_action_updated",
      recordType: "grow_opportunity",
      recordId: String(id),
      propertyId: existing.propertyId ?? undefined,
      previousValue: JSON.stringify({
        nextActionDueAt: existing.nextActionDueAt,
        recommendedNextAction: existing.recommendedNextAction,
      }),
      updatedValue: JSON.stringify({
        nextActionDueAt: updated.nextActionDueAt,
        recommendedNextAction: updated.recommendedNextAction,
      }),
    });

    res.json({ opportunity: updated });
  },
);
