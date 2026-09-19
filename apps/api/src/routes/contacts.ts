import { Router } from "express";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import {
  db,
  growActivities,
  growCommitments,
  growContactRelationships,
  growContactRoles,
  growOpportunities,
  growRelationships,
  parties,
  properties,
  GROW_CONTACT_ROLES,
  GROW_CONTACT_RELATIONSHIP_TYPES,
} from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { getRelationshipTimeline } from "../lib/relationshipTimeline.js";
import { getContactIntelligenceSummary } from "../lib/contactIntelligence.js";
import { logAudit } from "../lib/audit.js";

// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline.
//
// Mounted at /grow/contacts (routes/index.ts) — nested under Grow's own namespace, not a new
// top-level surface, since Contact 360 is a Grow-specific view onto the canonical `parties`
// table (packages/db/src/schema/property.ts), never a second contact database. Every read here
// uses grow.contacts.read; every mutation this priority introduces (role assignment/removal,
// household-relationship create/remove) uses grow.contacts.manage — both keys were already
// reserved but unused (packages/db/src/schema/billing.ts). Commitments reuse
// grow.activities.manage, exactly as growActivities writes already do — no new entitlement key
// was needed for this priority. Existing POST/PATCH /grow/relationships (routes/grow.ts)
// continue to be the only way to create/update a contact<->property relationship; this file
// only adds a partyId-scoped READ over that same table for Contact 360, never a duplicate
// mutation path.

export const contactsRouter = Router();

// AE GROW Pilot Readiness WP1 (P2-4): free-text length bounds, matching the 2000-character
// ceiling routes/ai.ts already applies to free text a user types into Grow.
const CONTACT_FREE_TEXT_MAX = 2000;

/** A positive integer id, or null when the value is not one (so callers can 400 instead of
 * handing NaN to Postgres and surfacing a 500).
 *
 * Bounded by MAX_SIGNED_INT4, matching routes/grow.ts and routes/communications.ts: every id
 * this router resolves is a `serial` column, i.e. int4. Without the ceiling a value like
 * "99999999999999999999" or "2147483648" IS an integer as far as Number.isInteger is
 * concerned, so it passed the guard and reached Postgres as an unbindable bind value —
 * producing exactly the 500 this helper exists to prevent. */
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

// AE GROW Pilot Readiness WP1 (P2-1): every contact-intelligence mutation below is audited via
// logAudit (lib/audit.ts) with ids/enum values only -- never free text (descriptions, notes,
// cancel reasons), matching routes/grow.ts's own audit conventions.

function displayName(party: { firstName: string | null; lastName: string | null; organisationName: string | null }): string {
  if (party.organisationName) return party.organisationName;
  const name = `${party.firstName ?? ""} ${party.lastName ?? ""}`.trim();
  return name.length > 0 ? name : "Unnamed contact";
}

// GET /grow/contacts — list/search, for the Grow Contacts entry point and any "find a contact"
// picker elsewhere in Grow. Always scoped to the caller's own brokerage; a client-supplied
// brokerageId is never trusted (matches every other Grow route in routes/grow.ts).
contactsRouter.get("/", requireAuth, requireEntitlement("grow.contacts.read"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const role = typeof req.query.role === "string" ? req.query.role : undefined;

  const conditions = [eq(parties.brokerageId, brokerageId)];
  if (search.length > 0) {
    const pattern = `%${search}%`;
    conditions.push(
      or(
        ilike(parties.firstName, pattern),
        ilike(parties.lastName, pattern),
        ilike(parties.organisationName, pattern),
        ilike(parties.email, pattern),
      )!,
    );
  }

  let partyRows = await db.select().from(parties).where(and(...conditions)).orderBy(desc(parties.createdAt)).limit(200);

  if (role) {
    const roleRows = await db
      .select({ partyId: growContactRoles.partyId })
      .from(growContactRoles)
      .where(and(eq(growContactRoles.brokerageId, brokerageId), eq(growContactRoles.role, role)));
    const partyIdsWithRole = new Set(roleRows.map((r) => r.partyId));
    partyRows = partyRows.filter((p) => partyIdsWithRole.has(p.id));
  }

  const partyIds = partyRows.map((p) => p.id);
  const [roleRows, relationshipCountRows] = partyIds.length > 0
    ? await Promise.all([
        db.select().from(growContactRoles).where(eq(growContactRoles.brokerageId, brokerageId)),
        db.select({ partyId: growRelationships.partyId, propertyId: growRelationships.propertyId })
          .from(growRelationships)
          .where(eq(growRelationships.brokerageId, brokerageId)),
      ])
    : [[], []];

  const rolesByParty = new Map<number, string[]>();
  for (const r of roleRows) {
    if (!rolesByParty.has(r.partyId)) rolesByParty.set(r.partyId, []);
    rolesByParty.get(r.partyId)!.push(r.role);
  }
  const propertyCountByParty = new Map<number, Set<number>>();
  for (const r of relationshipCountRows) {
    if (!r.propertyId) continue;
    if (!propertyCountByParty.has(r.partyId)) propertyCountByParty.set(r.partyId, new Set());
    propertyCountByParty.get(r.partyId)!.add(r.propertyId);
  }

  res.json({
    contacts: partyRows.map((p) => ({
      id: p.id,
      displayName: displayName(p),
      partyType: p.partyType,
      email: p.email,
      mobile: p.mobile,
      roles: rolesByParty.get(p.id) ?? [],
      relatedPropertyCount: propertyCountByParty.get(p.id)?.size ?? 0,
    })),
  });
});

// GET /grow/contacts/:partyId — Contact 360. One response covers the whole view: canonical
// identity, Grow's multi-valued roles, household relationships, property relationships,
// opportunities, recent activities/commitments, the Relationship Timeline, and the
// deterministic Contact Intelligence Summary — matching the "understand this relationship in
// seconds" UX goal (§11) rather than a screen that fires off five separate requests.
contactsRouter.get("/:partyId", requireAuth, requireEntitlement("grow.contacts.read"), async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const partyId = parsePositiveId(req.params.partyId);
  if (!partyId) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId))).limit(1);
  if (!party) {
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
  }

  const [householdRows, propertyRelRows, opportunityRows, roleRows, activityRows, commitmentRows, timeline, intelligence] =
    await Promise.all([
      // §5 — household relationships are recorded as a single directed row per pair+type (see
      // the dedup check in POST /:partyId/relationships below), but the relationship itself is
      // symmetric: "A is B's spouse" and "B is A's spouse" are the same fact. Querying by
      // partyId alone would only surface it on whichever contact happened to be `partyId` at
      // creation time — the other contact's own Contact 360 page would silently omit it. Both
      // directions are fetched here so either contact sees it.
      db
        .select()
        .from(growContactRelationships)
        .where(
          and(
            eq(growContactRelationships.brokerageId, brokerageId),
            or(eq(growContactRelationships.partyId, partyId), eq(growContactRelationships.relatedPartyId, partyId)),
          ),
        ),
      db
        .select({
          id: growRelationships.id,
          relationshipType: growRelationships.relationshipType,
          role: growRelationships.role,
          status: growRelationships.status,
          isPrimary: growRelationships.isPrimary,
          validFrom: growRelationships.validFrom,
          validTo: growRelationships.validTo,
          propertyId: growRelationships.propertyId,
          propertyAddress: properties.formattedAddress,
          createdBy: growRelationships.createdBy,
          createdAt: growRelationships.createdAt,
        })
        .from(growRelationships)
        .leftJoin(properties, eq(growRelationships.propertyId, properties.id))
        .where(and(eq(growRelationships.partyId, partyId), eq(growRelationships.brokerageId, brokerageId)))
        .orderBy(desc(growRelationships.createdAt)),
      db
        .select()
        .from(growOpportunities)
        .where(and(eq(growOpportunities.partyId, partyId), eq(growOpportunities.brokerageId, brokerageId)))
        .orderBy(desc(growOpportunities.createdAt)),
      db.select().from(growContactRoles).where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.brokerageId, brokerageId))),
      db
        .select()
        .from(growActivities)
        .where(and(eq(growActivities.partyId, partyId), eq(growActivities.brokerageId, brokerageId)))
        .orderBy(desc(growActivities.occurredAt))
        .limit(50),
      db
        .select()
        .from(growCommitments)
        .where(and(eq(growCommitments.partyId, partyId), eq(growCommitments.brokerageId, brokerageId)))
        .orderBy(desc(growCommitments.dueAt)),
      getRelationshipTimeline(brokerageId, partyId, 100),
      getContactIntelligenceSummary(brokerageId, partyId),
    ]);

  // Batch-resolve display info for whichever party is on "the other side" of each household
  // relationship row, regardless of which column (partyId or relatedPartyId) holds this contact.
  const otherPartyIds = Array.from(
    new Set(householdRows.map((h) => (h.partyId === partyId ? h.relatedPartyId : h.partyId))),
  );
  const otherPartyRows = otherPartyIds.length > 0
    ? await db
        .select({ id: parties.id, firstName: parties.firstName, lastName: parties.lastName, organisationName: parties.organisationName })
        .from(parties)
        .where(inArray(parties.id, otherPartyIds))
    : [];
  const otherPartyById = new Map(otherPartyRows.map((p) => [p.id, p]));

  // Derived, not canonical: `parties` has no owner/assigned-agent column of its own (§3 — Grow
  // extends the canonical model rather than adding fields to it for something this deterministic
  // to derive). The most recently created property relationship's createdBy is used as a
  // reasonable "who's been working this contact" signal, falling back to the most recently
  // created opportunity's owner when there is no relationship yet.
  const assignedAgentUserId =
    propertyRelRows.find((r) => r.createdBy !== null)?.createdBy ?? opportunityRows[0]?.ownerUserId ?? null;

  res.json({
    contact: {
      id: party.id,
      partyType: party.partyType,
      firstName: party.firstName,
      middleName: party.middleName,
      lastName: party.lastName,
      organisationName: party.organisationName,
      displayName: displayName(party),
      email: party.email,
      mobile: party.mobile,
      residentialAddress: party.residentialAddress,
      createdAt: party.createdAt.toISOString(),
      updatedAt: party.updatedAt.toISOString(),
    },
    assignedAgentUserId,
    roles: roleRows.map((r) => r.role),
    householdRelationships: householdRows.map((h) => {
      const otherPartyId = h.partyId === partyId ? h.relatedPartyId : h.partyId;
      const other = otherPartyById.get(otherPartyId);
      return {
        id: h.id,
        relatedPartyId: otherPartyId,
        relatedPartyDisplayName: other ? displayName(other) : "Unknown contact",
        relationshipType: h.relationshipType,
        note: h.note,
        createdAt: h.createdAt.toISOString(),
      };
    }),
    properties: propertyRelRows.map((r) => ({
      relationshipId: r.id,
      propertyId: r.propertyId,
      propertyAddress: r.propertyAddress,
      relationshipType: r.relationshipType,
      role: r.role,
      status: r.status,
      isPrimary: r.isPrimary,
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo ? r.validTo.toISOString() : null,
    })),
    opportunities: opportunityRows.map((o) => ({
      id: o.id,
      opportunityType: o.opportunityType,
      status: o.status,
      stage: o.stage,
      reason: o.reason,
      nextActionDueAt: o.nextActionDueAt ? o.nextActionDueAt.toISOString() : null,
      recommendedNextAction: o.recommendedNextAction,
      propertyId: o.propertyId,
    })),
    activities: activityRows.map((a) => ({
      id: a.id,
      activityType: a.activityType,
      occurredAt: a.occurredAt.toISOString(),
      summary: a.summary,
      propertyId: a.propertyId,
      opportunityId: a.opportunityId,
    })),
    commitments: commitmentRows.map((c) => ({
      id: c.id,
      description: c.description,
      dueAt: c.dueAt.toISOString(),
      status: c.status,
      propertyId: c.propertyId,
      opportunityId: c.opportunityId,
      completedAt: c.completedAt ? c.completedAt.toISOString() : null,
      cancelledAt: c.cancelledAt ? c.cancelledAt.toISOString() : null,
      cancelReason: c.cancelReason,
    })),
    timeline,
    intelligence,
  });
});

// POST /grow/contacts/:partyId/roles — assign a relationship-classification role (§4). A party
// may hold several roles at once; assigning a role it already holds is a no-op (the unique
// index on (partyId, role) is the enforcement, this just makes re-assigning harmless rather than
// a 500).
contactsRouter.post("/:partyId/roles", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const role = typeof req.body?.role === "string" ? req.body.role : undefined;
  if (!partyId || !role || !(GROW_CONTACT_ROLES as readonly string[]).includes(role)) {
    res.status(400).json({ error: `role must be one of: ${GROW_CONTACT_ROLES.join(", ")}` });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
  if (!party) {
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
  }

  const [existing] = await db
    .select()
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.role, role)))
    .limit(1);
  if (existing) {
    res.status(200).json({ role: existing });
    return;
  }

  const [inserted] = await db
    .insert(growContactRoles)
    .values({ brokerageId: user.brokerageId, partyId, role, assignedByUserId: user.id })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_role_assigned",
    recordType: "grow_contact_role",
    recordId: String(inserted.id),
    updatedValue: JSON.stringify({ partyId, role }),
  });
  res.status(201).json({ role: inserted });
});

// DELETE /grow/contacts/:partyId/roles/:role
contactsRouter.delete("/:partyId/roles/:role", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const role = req.params.role;
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id" });
    return;
  }

  const [existing] = await db
    .select()
    .from(growContactRoles)
    .where(and(eq(growContactRoles.partyId, partyId), eq(growContactRoles.role, role), eq(growContactRoles.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Role assignment not found in this brokerage" });
    return;
  }

  await db.delete(growContactRoles).where(eq(growContactRoles.id, existing.id));
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_role_removed",
    recordType: "grow_contact_role",
    recordId: String(existing.id),
    previousValue: JSON.stringify({ partyId: existing.partyId, role: existing.role }),
  });
  res.status(204).send();
});

// POST /grow/contacts/:partyId/relationships — household / person-to-person relationships (§5).
// Deliberately does not merge records and does not auto-infer anything — every row here is an
// explicit user action. Both partyId and relatedPartyId are validated against the caller's own
// brokerage before the row is created.
contactsRouter.post("/:partyId/relationships", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const relatedPartyId = parsePositiveId(req.body?.relatedPartyId);
  const relationshipType = typeof req.body?.relationshipType === "string" ? req.body.relationshipType : undefined;
  if (!partyId || !relatedPartyId || !relationshipType || !(GROW_CONTACT_RELATIONSHIP_TYPES as readonly string[]).includes(relationshipType)) {
    res.status(400).json({ error: `relatedPartyId and relationshipType (one of: ${GROW_CONTACT_RELATIONSHIP_TYPES.join(", ")}) are required` });
    return;
  }
  const note = req.body?.note;
  if (note !== undefined && note !== null && (typeof note !== "string" || note.length > CONTACT_FREE_TEXT_MAX)) {
    res.status(400).json({ error: `note must be a string of at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }
  if (partyId === relatedPartyId) {
    res.status(400).json({ error: "A contact cannot have a relationship with itself" });
    return;
  }

  const [party, relatedParty] = await Promise.all([
    db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1).then((r) => r[0]),
    db.select().from(parties).where(and(eq(parties.id, relatedPartyId), eq(parties.brokerageId, user.brokerageId))).limit(1).then((r) => r[0]),
  ]);
  if (!party || !relatedParty) {
    res.status(404).json({ error: "Both contacts must exist in this brokerage" });
    return;
  }

  // Dedup checked in both directions: A-related_contact-of-B and B-related_contact-of-A
  // describe the same fact even though they're stored as two directed rows at most once each.
  const existing = await db
    .select()
    .from(growContactRelationships)
    .where(
      and(
        eq(growContactRelationships.brokerageId, user.brokerageId),
        eq(growContactRelationships.relationshipType, relationshipType),
        or(
          and(eq(growContactRelationships.partyId, partyId), eq(growContactRelationships.relatedPartyId, relatedPartyId)),
          and(eq(growContactRelationships.partyId, relatedPartyId), eq(growContactRelationships.relatedPartyId, partyId)),
        ),
      ),
    );
  if (existing.length > 0) {
    res.status(200).json({ relationship: existing[0] });
    return;
  }

  const [inserted] = await db
    .insert(growContactRelationships)
    .values({
      brokerageId: user.brokerageId,
      partyId,
      relatedPartyId,
      relationshipType,
      note: typeof req.body?.note === "string" ? req.body.note : null,
      createdBy: user.id,
    })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_relationship_created",
    recordType: "grow_contact_relationship",
    recordId: String(inserted.id),
    updatedValue: JSON.stringify({ partyId, relatedPartyId, relationshipType }),
  });
  res.status(201).json({ relationship: inserted });
});

// DELETE /grow/contacts/relationships/:id — remove a household relationship. Does not affect
// either party record and does not cascade into any other Grow data.
contactsRouter.delete("/relationships/:id", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const id = parsePositiveId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid relationship id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(growContactRelationships)
    .where(and(eq(growContactRelationships.id, id), eq(growContactRelationships.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Relationship not found in this brokerage" });
    return;
  }
  await db.delete(growContactRelationships).where(eq(growContactRelationships.id, id));
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_contact_relationship_removed",
    recordType: "grow_contact_relationship",
    recordId: String(existing.id),
    previousValue: JSON.stringify({
      partyId: existing.partyId,
      relatedPartyId: existing.relatedPartyId,
      relationshipType: existing.relationshipType,
    }),
  });
  res.status(204).send();
});

// POST /grow/contacts/:partyId/commitments — a future-dated promise (§8). Reuses
// grow.activities.manage, matching Priority 1's existing growActivities write gate, since a
// commitment is conceptually the same "structured Grow activity-adjacent record" surface.
contactsRouter.post("/:partyId/commitments", requireAuth, requireEntitlement("grow.activities.manage"), async (req, res) => {
  const user = req.authedUser!;
  const partyId = parsePositiveId(req.params.partyId);
  const description = typeof req.body?.description === "string" ? req.body.description : undefined;
  const dueAtRaw = req.body?.dueAt;
  const dueAt = typeof dueAtRaw === "string" ? new Date(dueAtRaw) : undefined;
  if (!partyId || !description || !dueAt || Number.isNaN(dueAt.getTime())) {
    res.status(400).json({ error: "description and a valid dueAt are required" });
    return;
  }
  if (description.length > CONTACT_FREE_TEXT_MAX) {
    res.status(400).json({ error: `description must be at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }
  // Non-numeric ids are a client error (400), never a NaN handed to Postgres (500).
  const propertyIdSupplied = req.body?.propertyId !== undefined && req.body?.propertyId !== null;
  const propertyId = propertyIdSupplied ? parsePositiveId(req.body.propertyId) : null;
  const opportunityIdSupplied = req.body?.opportunityId !== undefined && req.body?.opportunityId !== null;
  const opportunityId = opportunityIdSupplied ? parsePositiveId(req.body.opportunityId) : null;
  if ((propertyIdSupplied && propertyId === null) || (opportunityIdSupplied && opportunityId === null)) {
    res.status(400).json({ error: "propertyId and opportunityId, if supplied, must be valid ids" });
    return;
  }

  const [party] = await db.select().from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, user.brokerageId))).limit(1);
  if (!party) {
    res.status(404).json({ error: "Contact not found in this brokerage" });
    return;
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
    .insert(growCommitments)
    .values({
      brokerageId: user.brokerageId,
      partyId,
      propertyId,
      opportunityId,
      description,
      dueAt,
      status: "Open",
      createdBy: user.id,
    })
    .returning();
  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: "grow_commitment_created",
    recordType: "grow_commitment",
    recordId: String(inserted.id),
    propertyId,
    updatedValue: JSON.stringify({ partyId, propertyId, opportunityId, dueAt: dueAt.toISOString(), status: "Open" }),
  });
  res.status(201).json({ commitment: inserted });
});

// PATCH /grow/contacts/commitments/:id — complete or cancel a commitment. Completion also
// writes a growActivities row (activityType "task_completion", already reserved for exactly
// this by AE GROW Priority 1/0.5's GROW_ACTIVITY_TYPES) so the Relationship Timeline picks the
// completion up through the ordinary activity feed without any special-casing.
contactsRouter.patch("/commitments/:id", requireAuth, requireEntitlement("grow.activities.manage"), async (req, res) => {
  const user = req.authedUser!;
  const id = parsePositiveId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid commitment id" });
    return;
  }
  const status = req.body?.status;
  if (status !== "Completed" && status !== "Cancelled") {
    res.status(400).json({ error: "status must be Completed or Cancelled" });
    return;
  }
  const cancelReason = req.body?.cancelReason;
  if (cancelReason !== undefined && cancelReason !== null && (typeof cancelReason !== "string" || cancelReason.length > CONTACT_FREE_TEXT_MAX)) {
    res.status(400).json({ error: `cancelReason must be a string of at most ${CONTACT_FREE_TEXT_MAX} characters` });
    return;
  }

  const [existing] = await db
    .select()
    .from(growCommitments)
    .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Commitment not found in this brokerage" });
    return;
  }
  if (existing.status !== "Open") {
    res.status(409).json({ error: `Commitment is already ${existing.status}` });
    return;
  }

  // AE GROW Pilot Readiness WP1 (P2-1): the UPDATE is conditional on status = 'Open' (and the
  // caller's brokerage), so of two concurrent complete/cancel requests exactly one wins; the
  // loser gets 409 and -- because the task_completion activity is written in the same
  // transaction, only when the conditional UPDATE actually changed a row -- no duplicate
  // Timeline activity. growCommitments has no cancelled-by column, so the canceller is recorded
  // in the audit row below (userId + cancelledByUserId) rather than by adding a column.
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(growCommitments)
      .set(
        status === "Completed"
          ? { status, completedAt: now, completedByUserId: user.id, updatedAt: now }
          : { status, cancelledAt: now, cancelReason: typeof cancelReason === "string" ? cancelReason : null, updatedAt: now },
      )
      .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId), eq(growCommitments.status, "Open")))
      .returning();
    if (!row) return null;

    if (status === "Completed") {
      await tx.insert(growActivities).values({
        brokerageId: user.brokerageId,
        partyId: existing.partyId,
        propertyId: existing.propertyId,
        opportunityId: existing.opportunityId,
        activityType: "task_completion",
        occurredAt: now,
        summary: `Commitment completed: ${existing.description}`,
        responsibleUserId: user.id,
        source: "manual",
      });
    }
    return row;
  });

  if (!updated) {
    const [current] = await db
      .select({ status: growCommitments.status })
      .from(growCommitments)
      .where(and(eq(growCommitments.id, id), eq(growCommitments.brokerageId, user.brokerageId)))
      .limit(1);
    res.status(409).json({ error: `Commitment is already ${current?.status ?? "closed"}` });
    return;
  }

  await logAudit({
    brokerageId: user.brokerageId,
    userId: user.id,
    action: status === "Completed" ? "grow_commitment_completed" : "grow_commitment_cancelled",
    recordType: "grow_commitment",
    recordId: String(updated.id),
    propertyId: updated.propertyId,
    previousValue: JSON.stringify({ status: "Open" }),
    updatedValue: JSON.stringify(
      status === "Completed"
        ? { status, completedByUserId: user.id }
        : { status, cancelledByUserId: user.id },
    ),
  });

  res.json({ commitment: updated });
});
