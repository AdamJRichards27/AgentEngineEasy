import { eq } from "drizzle-orm";
import { db, growActivities, growCommitments, growOpportunities, growRelationships, parties, properties } from "@aee/db";

// AE GROW Priority 2 — Contact Intelligence & Relationship Timeline (§7).
//
// The Relationship Timeline is a per-contact, chronological AGGREGATION of data that already
// lives in Grow's existing tables (growRelationships, growActivities, growOpportunities) plus
// this priority's own growCommitments — never a new copy/log of that data. Deliberately built
// as a direct, per-table query + in-memory merge rather than a join: a join across
// growRelationships/growActivities/growOpportunities/growCommitments would multiply rows
// (a party with 3 relationships and 2 activities would produce 6 joined rows, not 5 events),
// which is exactly the "join-caused duplicate" failure mode AE GROW Priority 2 §16 requires a
// test to rule out. Querying each table independently and merging in memory avoids that by
// construction: each source row can contribute at most a small, fixed number of well-defined
// events (see buildEventsFor* below), never a multiplied cross-product.
//
// Also deliberately does NOT read packages/db's `domainEvents` table: not every Grow write
// publishes a domain event today (growActivities.create, growCommitments.create/complete, and
// growContactRoles/growContactRelationships writes never call publishDomainEvent), so building
// the Timeline on top of best-effort event publication would silently under-report history.
// Querying the source-of-truth tables directly is correct today and remains correct if event
// publication coverage changes later.
//
// §13 (future communications contract): the EMAIL_*/SMS_* members of GrowTimelineEventType
// exist so the Timeline's shape is ready for Priority 3 to plug real send/receive/delivery
// events into once a Grow-specific nurture/communications surface exists. Nothing produces
// them yet, and no provider is integrated here or anywhere else in this priority.

export const GROW_TIMELINE_EVENT_TYPES = [
  "CONTACT_CREATED",
  "PROPERTY_RELATIONSHIP_ESTABLISHED",
  "PROPERTY_RELATIONSHIP_UPDATED",
  "NOTE_ADDED",
  "ACTIVITY_LOGGED",
  "OPPORTUNITY_CREATED",
  "OPPORTUNITY_UPDATED",
  "COMMITMENT_CREATED",
  "COMMITMENT_COMPLETED",
  "COMMITMENT_CANCELLED",
  // Reserved for a future Grow-specific communications surface (§13) — provider-neutral,
  // unpopulated today. No code anywhere in this priority emits these.
  "EMAIL_SENT",
  "EMAIL_RECEIVED",
  "EMAIL_DELIVERED",
  "EMAIL_OPENED",
  "EMAIL_FAILED",
  "SMS_SENT",
  "SMS_RECEIVED",
  "SMS_DELIVERED",
  "SMS_FAILED",
] as const;
export type GrowTimelineEventType = (typeof GROW_TIMELINE_EVENT_TYPES)[number];

export interface GrowTimelineEvent {
  id: string;
  type: GrowTimelineEventType;
  occurredAt: string;
  summary: string;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
  sourceType: "party" | "relationship" | "activity" | "opportunity" | "commitment";
  sourceId: number;
}

// A source row's updatedAt is only treated as a distinct "...UPDATED" event when it is
// meaningfully later than its own createdAt — otherwise every row would always emit a
// same-instant duplicate pair (createdAt and updatedAt default to the same `now()` on insert).
const UPDATE_EVENT_THRESHOLD_MS = 2000;

function isMeaningfulUpdate(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > UPDATE_EVENT_THRESHOLD_MS;
}

export async function getRelationshipTimeline(
  brokerageId: number,
  partyId: number,
  limit = 100,
): Promise<GrowTimelineEvent[]> {
  const [party, relationshipRows, activityRows, opportunityRows, commitmentRows] = await Promise.all([
    db.select().from(parties).where(eq(parties.id, partyId)).limit(1).then((rows) => rows[0] ?? null),
    db.select().from(growRelationships).where(eq(growRelationships.partyId, partyId)),
    db.select().from(growActivities).where(eq(growActivities.partyId, partyId)),
    db.select().from(growOpportunities).where(eq(growOpportunities.partyId, partyId)),
    db.select().from(growCommitments).where(eq(growCommitments.partyId, partyId)),
  ]);

  const events: GrowTimelineEvent[] = [];

  // Tenant isolation: every source row above was already looked up by partyId alone (not yet
  // brokerage-scoped), so nothing is trusted until the party itself is confirmed to belong to
  // the caller's brokerage — callers MUST check this themselves before calling, but as a second
  // line of defence this function refuses to produce any events for a cross-tenant party.
  if (!party || party.brokerageId !== brokerageId) {
    return [];
  }

  events.push({
    id: `party:${party.id}:CONTACT_CREATED`,
    type: "CONTACT_CREATED",
    occurredAt: party.createdAt.toISOString(),
    summary: "Contact added to AE.",
    propertyId: null,
    propertyLabel: null,
    opportunityId: null,
    sourceType: "party",
    sourceId: party.id,
  });

  const propertyIds = new Set<number>();
  for (const r of relationshipRows) if (r.propertyId) propertyIds.add(r.propertyId);
  for (const a of activityRows) if (a.propertyId) propertyIds.add(a.propertyId);
  for (const o of opportunityRows) if (o.propertyId) propertyIds.add(o.propertyId);
  for (const c of commitmentRows) if (c.propertyId) propertyIds.add(c.propertyId);

  const propertyLabelById = new Map<number, string>();
  if (propertyIds.size > 0) {
    const propertyRows = await db.select({ id: properties.id, formattedAddress: properties.formattedAddress }).from(properties);
    for (const p of propertyRows) {
      if (propertyIds.has(p.id)) propertyLabelById.set(p.id, p.formattedAddress);
    }
  }

  for (const r of relationshipRows) {
    const propertyLabel = r.propertyId ? propertyLabelById.get(r.propertyId) ?? null : null;
    events.push({
      id: `relationship:${r.id}:ESTABLISHED`,
      type: "PROPERTY_RELATIONSHIP_ESTABLISHED",
      occurredAt: r.createdAt.toISOString(),
      summary: propertyLabel
        ? `Relationship recorded: ${r.relationshipType} at ${propertyLabel}.`
        : `Relationship recorded: ${r.relationshipType}.`,
      propertyId: r.propertyId,
      propertyLabel,
      opportunityId: null,
      sourceType: "relationship",
      sourceId: r.id,
    });
    if (isMeaningfulUpdate(r.createdAt, r.updatedAt)) {
      events.push({
        id: `relationship:${r.id}:UPDATED`,
        type: "PROPERTY_RELATIONSHIP_UPDATED",
        occurredAt: r.updatedAt.toISOString(),
        summary: `Relationship updated: ${r.relationshipType} (${r.status}).`,
        propertyId: r.propertyId,
        propertyLabel,
        opportunityId: null,
        sourceType: "relationship",
        sourceId: r.id,
      });
    }
  }

  for (const a of activityRows) {
    const propertyLabel = a.propertyId ? propertyLabelById.get(a.propertyId) ?? null : null;
    events.push({
      id: `activity:${a.id}`,
      type: a.activityType === "note" ? "NOTE_ADDED" : "ACTIVITY_LOGGED",
      occurredAt: a.occurredAt.toISOString(),
      summary: a.summary,
      propertyId: a.propertyId,
      propertyLabel,
      opportunityId: a.opportunityId,
      sourceType: "activity",
      sourceId: a.id,
    });
  }

  for (const o of opportunityRows) {
    const propertyLabel = o.propertyId ? propertyLabelById.get(o.propertyId) ?? null : null;
    events.push({
      id: `opportunity:${o.id}:CREATED`,
      type: "OPPORTUNITY_CREATED",
      occurredAt: o.createdAt.toISOString(),
      summary: `Opportunity created: ${o.opportunityType} — ${o.reason ?? "no reason recorded"}.`,
      propertyId: o.propertyId,
      propertyLabel,
      opportunityId: o.id,
      sourceType: "opportunity",
      sourceId: o.id,
    });
    if (isMeaningfulUpdate(o.createdAt, o.updatedAt)) {
      events.push({
        id: `opportunity:${o.id}:UPDATED`,
        type: "OPPORTUNITY_UPDATED",
        occurredAt: o.updatedAt.toISOString(),
        summary: `Opportunity updated: ${o.opportunityType} (${o.stage}/${o.status}).`,
        propertyId: o.propertyId,
        propertyLabel,
        opportunityId: o.id,
        sourceType: "opportunity",
        sourceId: o.id,
      });
    }
  }

  for (const c of commitmentRows) {
    const propertyLabel = c.propertyId ? propertyLabelById.get(c.propertyId) ?? null : null;
    events.push({
      id: `commitment:${c.id}:CREATED`,
      type: "COMMITMENT_CREATED",
      occurredAt: c.createdAt.toISOString(),
      summary: `Commitment made: ${c.description}.`,
      propertyId: c.propertyId,
      propertyLabel,
      opportunityId: c.opportunityId,
      sourceType: "commitment",
      sourceId: c.id,
    });
    if (c.status === "Completed" && c.completedAt) {
      events.push({
        id: `commitment:${c.id}:COMPLETED`,
        type: "COMMITMENT_COMPLETED",
        occurredAt: c.completedAt.toISOString(),
        summary: `Commitment completed: ${c.description}.`,
        propertyId: c.propertyId,
        propertyLabel,
        opportunityId: c.opportunityId,
        sourceType: "commitment",
        sourceId: c.id,
      });
    } else if (c.status === "Cancelled" && c.cancelledAt) {
      events.push({
        id: `commitment:${c.id}:CANCELLED`,
        type: "COMMITMENT_CANCELLED",
        occurredAt: c.cancelledAt.toISOString(),
        summary: `Commitment cancelled: ${c.description}.`,
        propertyId: c.propertyId,
        propertyLabel,
        opportunityId: c.opportunityId,
        sourceType: "commitment",
        sourceId: c.id,
      });
    }
  }

  // Newest first — a reverse-chronological feed, matching every other Grow "what's recent"
  // surface (growActivities list, growOpportunities list) already ordered by desc(createdAt).
  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return events.slice(0, limit);
}
