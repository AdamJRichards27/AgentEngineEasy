import { and, eq, inArray } from "drizzle-orm";
import { presentStoredActivitySummaries } from "./commitmentRescheduleSummary.js";
import { linkedPropertyHidden, ownedOrLinkedHidden } from "./propertyVisibility.js";
import {
  db,
  appraisals,
  growActivities,
  growCommitments,
  growOpportunities,
  growOpportunitySignals,
  growRelationships,
  parties,
  properties,
  communicationMessages,
  communicationParticipants,
  communicationThreads,
  type CommunicationMessage,
} from "@aee/db";

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
// AE GROW PRIORITY 3 — communications, live-sourced from the Communications Hub. The EMAIL_*/
// SMS_* members of GrowTimelineEventType were reserved by Priority 2 for exactly this. The
// Communications Hub's communicationThreads/communicationMessages (packages/db/src/schema/
// communications.ts) are the source of truth for every send/receive/delivery fact — nothing is
// copied into a Grow table here, this file queries those tables directly, same as every other
// source above. Two independent paths feed a contact's communications, matching the Hub's own
// contact-first-or-property-first anchoring: (1) messages denormalised directly onto this
// party via communicationMessages.partyId (a contact-first thread), and (2) messages on a
// property-first thread where this contact is nonetheless a listed participant
// (communicationParticipants.partyId). Both are resolved without a SQL join — a join across
// communicationThreads/communicationParticipants/communicationMessages would multiply rows the
// same way joining the Grow tables above would, so this follows the same per-table-query +
// in-memory-merge convention, just over two sequential hops for path (2) instead of one.
//
// Noise control: communicationMessages.status is denormalised to always hold a message's
// LATEST known state (see communications.ts's own header comment) — there is exactly one
// status per message row, never a separate row per transition. Mapping status -> event type
// in buildCommunicationEvent below therefore naturally produces at most one Timeline event per
// message: once a message's status moves from SENT to DELIVERED, the row now reads DELIVERED
// and produces only an EMAIL_DELIVERED/SMS_DELIVERED event — its earlier SENT state is not
// separately re-emitted, so a message is never shown twice for the same underlying send. Only
// EMAIL and SMS channels are surfaced (the only channels with a reserved event type — PHONE_CALL,
// EXTERNAL_MESSAGE and INTERNAL_NOTE have none and are left out), and only statuses that
// represent something dispatch-confirmed (SENT/DELIVERED/FAILED-family for outbound, any row at
// all for inbound) produce an event — a DRAFT, AWAITING_APPROVAL, QUEUED, etc. message hasn't
// yet become a fact from the contact's perspective and is not surfaced.

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
  // AE GROW Priority 3 — populated by buildCommunicationEvent below, sourced live from the
  // Communications Hub. EMAIL_OPENED has no backing column (no open-tracking timestamp exists
  // on communicationMessages today) and is never emitted; it stays reserved for when the Hub
  // gains open tracking.
  "EMAIL_SENT",
  "EMAIL_RECEIVED",
  "EMAIL_DELIVERED",
  "EMAIL_OPENED",
  "EMAIL_FAILED",
  "SMS_SENT",
  "SMS_RECEIVED",
  "SMS_DELIVERED",
  "SMS_FAILED",
  // AE GROW Priority 4 -- Appraisal Workspace (Sec.16). Sourced live from the `appraisals`
  // table itself (see growAppraisals.ts) -- same per-table-query convention as every other
  // event family above, never a new copy/log. APPRAISAL_READY has no dedicated timestamp
  // column, so it is inferred from the row's own updatedAt while status is currently READY
  // (mirrors how COMMITMENT_COMPLETED/CANCELLED are gated on current status + timestamp
  // above); every other Appraisal event is sourced from a dedicated timestamp column that
  // growAppraisals.ts sets once, and is emitted whenever that column is populated.
  "APPRAISAL_CREATED",
  "APPRAISAL_READY",
  "APPRAISAL_SENT",
  "APPRAISAL_VIEWED",
  "APPRAISAL_PRESENTED",
  "APPRAISAL_FOLLOW_UP",
  "APPRAISAL_WON",
  "APPRAISAL_LOST",
  "APPRAISAL_DEFERRED",
  // AE GROW Priority 5 Remediation — Property Intelligence. Sourced live from
  // growOpportunitySignals rows LINKED TO THIS CONTACT (partyId set) — only the meaningful,
  // human-decided outcomes, per the remediation objective's own "add only meaningful business
  // events... avoid technical refresh noise" instruction. A signal simply becoming Active
  // (raised or recalculated) is deliberately NOT a Timeline event — that's routine background
  // computation, not a business event a contact's history should record; only a human
  // reviewing, dismissing, or promoting it is. A signal with no linked contact (every current
  // observation-derived signal type) never appears here at all — see getRelationshipTimeline's
  // own query below — it is Property Timeline-only (lib/timeline.ts), matching
  // propertyExternalIdentifiers/growOpportunitySignals' own property-anchored-only shape.
  "PROPERTY_INTELLIGENCE_SIGNAL_REVIEWED",
  "PROPERTY_INTELLIGENCE_SIGNAL_DISMISSED",
  "PROPERTY_INTELLIGENCE_SIGNAL_PROMOTED",
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
  sourceType:
    | "party"
    | "relationship"
    | "activity"
    | "opportunity"
    | "commitment"
    | "communication"
    | "appraisal"
    // AE GROW Priority 5 Remediation.
    | "property_intelligence_signal";
  sourceId: number;
}

// A source row's updatedAt is only treated as a distinct "...UPDATED" event when it is
// meaningfully later than its own createdAt — otherwise every row would always emit a
// same-instant duplicate pair (createdAt and updatedAt default to the same `now()` on insert).
const UPDATE_EVENT_THRESHOLD_MS = 2000;

function isMeaningfulUpdate(createdAt: Date, updatedAt: Date): boolean {
  return updatedAt.getTime() - createdAt.getTime() > UPDATE_EVENT_THRESHOLD_MS;
}

// The update event is the lifecycle line Contact 360 already renders from `summary`.
// lostReason is a column on the opportunity row this function already selected for
// this brokerage and party — no extra query. It is appended only while the row is Lost.
function opportunityUpdatedSummary(opportunity: {
  opportunityType: string;
  stage: string;
  status: string;
  lostReason: string | null;
}): string {
  const base = `Opportunity updated: ${opportunity.opportunityType} (${opportunity.stage}/${opportunity.status}).`;
  if (opportunity.status !== "Lost") return base;
  const lostReason = opportunity.lostReason?.trim() ?? "";
  if (lostReason.length === 0) return base;
  return `${base} Lost reason: ${lostReason}.`;
}

// AE GROW Priority 3. See the file header for why this produces at most one event per message
// row (status is always the message's latest known state) and why only EMAIL/SMS surface.
function buildCommunicationEvent(
  message: CommunicationMessage,
  propertyLabelById: Map<number, string>,
): GrowTimelineEvent | null {
  const isEmail = message.channel === "EMAIL";
  const isSms = message.channel === "SMS";
  if (!isEmail && !isSms) {
    return null;
  }

  const propertyLabel = message.propertyId ? propertyLabelById.get(message.propertyId) ?? null : null;
  const destination = message.recipientDisplayName ?? message.recipientDestination ?? "the contact";

  let type: GrowTimelineEventType;
  let occurredAt: Date;
  let summary: string;

  if (message.direction === "INBOUND") {
    // Any inbound row is, by definition, something the contact already sent us — surfaced
    // regardless of its status field, timestamped by when it was recorded.
    type = isEmail ? "EMAIL_RECEIVED" : "SMS_RECEIVED";
    occurredAt = message.createdAt;
    summary = isEmail ? `Email received${message.subject ? `: ${message.subject}` : "."}` : "SMS received.";
  } else if (message.status === "DELIVERED") {
    type = isEmail ? "EMAIL_DELIVERED" : "SMS_DELIVERED";
    occurredAt = message.deliveredAt ?? message.updatedAt;
    summary = isEmail
      ? `Email delivered to ${destination}${message.subject ? `: ${message.subject}` : "."}`
      : `SMS delivered to ${destination}.`;
  } else if (message.status === "FAILED" || message.status === "BOUNCED" || message.status === "UNDELIVERABLE") {
    type = isEmail ? "EMAIL_FAILED" : "SMS_FAILED";
    occurredAt = message.failedAt ?? message.updatedAt;
    summary = isEmail
      ? `Email to ${destination} failed${message.failureCategory ? ` (${message.failureCategory})` : ""}.`
      : `SMS to ${destination} failed${message.failureCategory ? ` (${message.failureCategory})` : ""}.`;
  } else if (message.status === "SENT") {
    type = isEmail ? "EMAIL_SENT" : "SMS_SENT";
    occurredAt = message.sentAt ?? message.updatedAt;
    summary = isEmail
      ? `Email sent to ${destination}${message.subject ? `: ${message.subject}` : "."}`
      : `SMS sent to ${destination}.`;
  } else {
    // DRAFT, AWAITING_APPROVAL, APPROVED, QUEUED, SENDING, RETRY_SCHEDULED, CANCELLED,
    // BLOCKED_BY_CONSENT, BLOCKED_BY_COST_CONTROL — nothing dispatch-confirmed has happened
    // toward the contact yet (or it was deliberately withheld before reaching them), so this
    // message contributes no Timeline event at its current status.
    return null;
  }

  return {
    id: `communication:${message.id}:${type}`,
    type,
    occurredAt: occurredAt.toISOString(),
    summary,
    propertyId: message.propertyId,
    propertyLabel,
    opportunityId: null,
    sourceType: "communication",
    sourceId: message.id,
  };
}

export async function getRelationshipTimeline(
  brokerageId: number,
  partyId: number,
  limit = 100,
  restrictToPropertyIds: number[] | null = null,
  callerUserId: number | null = null,
): Promise<GrowTimelineEvent[]> {
  const [
    party,
    relationshipRows,
    activityRows,
    opportunityRows,
    commitmentRows,
    appraisalRows,
    signalRows,
    partyAnchoredMessages,
    participantThreadLinks,
  ] = await Promise.all([
    db.select().from(parties).where(eq(parties.id, partyId)).limit(1).then((rows) => rows[0] ?? null),
    // brokerageId is part of the SQL predicate, not only of the party guard below. Every index
    // on these tables LEADS with brokerage_id (grow_relationships_brokerage_party_idx,
    // grow_activities_brokerage_party_occurred_idx, grow_opportunities_brokerage_party_property_idx,
    // grow_commitments_brokerage_party_idx), so a bare `party_id =` predicate cannot seek: it
    // leaves the leading column unconstrained, and Postgres has to examine every row in the
    // table (a seq scan) or every entry in one of those indexes (a full index scan with party_id
    // as a non-leading Index Cond) — on every Contact 360 open. Either way the work grew with
    // the INSTANCE's row count rather than the tenant's. Naming the leading column makes it a
    // bounded seek into one tenant's slice: measured on this schema at 250,000 grow_activities
    // rows across 40 brokerages, planner cost 3568.85 -> 11.86 and 379 -> 80 shared buffers for
    // an identical result set.
    //
    // This is not a tenant-isolation change: the party's own brokerage is still checked below
    // and is still what decides whether any event is produced at all.
    db
      .select()
      .from(growRelationships)
      .where(and(eq(growRelationships.partyId, partyId), eq(growRelationships.brokerageId, brokerageId))),
    db
      .select()
      .from(growActivities)
      .where(and(eq(growActivities.partyId, partyId), eq(growActivities.brokerageId, brokerageId))),
    db
      .select()
      .from(growOpportunities)
      .where(and(eq(growOpportunities.partyId, partyId), eq(growOpportunities.brokerageId, brokerageId))),
    db
      .select()
      .from(growCommitments)
      .where(and(eq(growCommitments.partyId, partyId), eq(growCommitments.brokerageId, brokerageId))),
    // `appraisals` has no brokerage_id column (packages/db/src/schema/appraisal.ts). Tenancy
    // is the associated property. Inner-join `properties` and require that property's
    // brokerage_id to be the caller's, so a party_id match whose property sits in another
    // brokerage cannot emit that appraisal's id, property id, opportunity id, address, price,
    // or status event. No new column: the predicate is the parent row that already carries
    // brokerage_id. appraisals_party_idx still serves the party_id predicate.
    db
      .select({ appraisal: appraisals })
      .from(appraisals)
      .innerJoin(properties, eq(properties.id, appraisals.propertyId))
      .where(and(eq(appraisals.partyId, partyId), eq(properties.brokerageId, brokerageId)))
      .then((rows) => rows.map((row) => row.appraisal)),
    // AE GROW Priority 5 Remediation — Property Intelligence. brokerageId is filtered directly
    // here (the column is right there on this table), same reasoning as the
    // communicationMessages query below, in addition to the party.brokerageId guard every
    // other source in this function relies on.
    db
      .select()
      .from(growOpportunitySignals)
      .where(and(eq(growOpportunitySignals.partyId, partyId), eq(growOpportunitySignals.brokerageId, brokerageId))),
    // AE GROW Priority 3, path 1 — messages anchored directly to this contact (a contact-first
    // thread). communicationMessages.partyId is denormalised from its thread's own partyId (see
    // communications.ts's header comment), so this is a single-column lookup, no join needed.
    // Scoped by brokerageId directly since the column is right there on this table.
    db
      .select()
      .from(communicationMessages)
      .where(and(eq(communicationMessages.partyId, partyId), eq(communicationMessages.brokerageId, brokerageId))),
    // AE GROW Priority 3, path 2 (part 1/2) — property-first threads where this contact is
    // nonetheless a listed participant (e.g. a buyer on a property-anchored thread).
    // communicationParticipants carries no brokerageId of its own, so tenant-scoping this path
    // is finished below via its thread, once the party's own tenant match has been confirmed.
    db
      .select({ threadId: communicationParticipants.threadId })
      .from(communicationParticipants)
      .where(eq(communicationParticipants.partyId, partyId)),
  ]);

  const events: GrowTimelineEvent[] = [];

  // Tenant isolation: the party itself is the gate. Source queries above carry brokerageId
  // in SQL where the table has that column. `appraisals` has none, so the query above
  // inner-joins properties and requires properties.brokerage_id. communicationParticipants
  // still has no brokerage_id and is looked up by partyId alone; its threads are re-checked
  // below. A partyId collision across brokerages, while not actually possible, is still not
  // something this function trusts on its own — so nothing is trusted until the party itself is
  // confirmed to belong to the caller's brokerage. Callers MUST check this themselves before
  // calling, but as a second line of defence this function refuses to produce any events for a
  // cross-tenant party.
  if (!party || party.brokerageId !== brokerageId) {
    return [];
  }

  // Own-property scope, applied before any event or address is built. A
  // relationship or activity with no property stays. An unlinked commitment
  // or opportunity stays only for its owner when the caller is property-scoped.
  // null restrictTo means brokerage-wide (Admin, Pit Crew, historical callers).
  const relationshipEvents = relationshipRows.filter((row) => !linkedPropertyHidden(row.propertyId, restrictToPropertyIds));
  const activityEvents = activityRows.filter((row) => !linkedPropertyHidden(row.propertyId, restrictToPropertyIds));
  const opportunityEvents = opportunityRows.filter(
    (row) => !ownedOrLinkedHidden(row.propertyId, row.ownerUserId, restrictToPropertyIds, callerUserId),
  );
  const commitmentEvents = commitmentRows.filter(
    (row) => !ownedOrLinkedHidden(row.propertyId, row.createdBy, restrictToPropertyIds, callerUserId),
  );
  const appraisalEvents = appraisalRows.filter((row) => !linkedPropertyHidden(row.propertyId, restrictToPropertyIds));
  const signalEvents = signalRows.filter((row) => !linkedPropertyHidden(row.propertyId, restrictToPropertyIds));

  // AE GROW Priority 3, path 2 (part 2/2) — resolve the participant-linked threads to messages,
  // re-checking brokerageId on communicationThreads itself as the defence-in-depth this file's
  // tenant-isolation convention calls for.
  const participantThreadIds = [...new Set(participantThreadLinks.map((p) => p.threadId))];
  let participantLinkedMessages: CommunicationMessage[] = [];
  if (participantThreadIds.length > 0) {
    const tenantThreadRows = await db
      .select({ id: communicationThreads.id })
      .from(communicationThreads)
      .where(
        and(inArray(communicationThreads.id, participantThreadIds), eq(communicationThreads.brokerageId, brokerageId)),
      );
    const tenantThreadIds = tenantThreadRows.map((t) => t.id);
    if (tenantThreadIds.length > 0) {
      participantLinkedMessages = await db
        .select()
        .from(communicationMessages)
        .where(inArray(communicationMessages.threadId, tenantThreadIds));
    }
  }

  // Dedupe: a message could in principle be reachable via both paths (a contact-first thread
  // whose contact is also listed as an explicit participant on it) — merge by message id
  // rather than risk emitting the same message's event twice.
  const communicationMessageById = new Map<number, CommunicationMessage>();
  for (const m of partyAnchoredMessages) communicationMessageById.set(m.id, m);
  for (const m of participantLinkedMessages) communicationMessageById.set(m.id, m);
  const communicationMessageRows = [...communicationMessageById.values()].filter(
    (row) => !linkedPropertyHidden(row.propertyId, restrictToPropertyIds),
  );

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
  for (const r of relationshipEvents) if (r.propertyId) propertyIds.add(r.propertyId);
  for (const a of activityEvents) if (a.propertyId) propertyIds.add(a.propertyId);
  for (const o of opportunityEvents) if (o.propertyId) propertyIds.add(o.propertyId);
  for (const c of commitmentEvents) if (c.propertyId) propertyIds.add(c.propertyId);
  for (const ap of appraisalEvents) if (ap.propertyId) propertyIds.add(ap.propertyId);
  for (const m of communicationMessageRows) if (m.propertyId) propertyIds.add(m.propertyId);
  for (const s of signalEvents) if (s.propertyId) propertyIds.add(s.propertyId);

  // Label lookup for exactly the properties the events above actually reference. This used to
  // be an unfiltered `SELECT id, formatted_address FROM properties` with the id match done in
  // JS afterwards — i.e. an instance-wide read of every property row of every tenant, on every
  // Contact 360 open, to label a handful of timeline entries. The ids are matched in SQL now.
  // brokerageId is in the predicate too: propertyIds is derived entirely from rows already
  // scoped to this tenant (and the party's own brokerage was confirmed above), so this filters
  // nothing extra out in practice, but it keeps the read tenant-bounded by construction rather
  // than by that derivation staying true, and matches the defence-in-depth convention the rest
  // of this file follows.
  const propertyLabelById = new Map<number, string>();
  if (propertyIds.size > 0) {
    const propertyRows = await db
      .select({ id: properties.id, formattedAddress: properties.formattedAddress })
      .from(properties)
      .where(and(inArray(properties.id, [...propertyIds]), eq(properties.brokerageId, brokerageId)));
    for (const p of propertyRows) {
      propertyLabelById.set(p.id, p.formattedAddress);
    }
  }

  for (const r of relationshipEvents) {
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

  for (const a of activityEvents) {
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

  for (const o of opportunityEvents) {
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
        summary: opportunityUpdatedSummary(o),
        propertyId: o.propertyId,
        propertyLabel,
        opportunityId: o.id,
        sourceType: "opportunity",
        sourceId: o.id,
      });
    }
  }

  for (const c of commitmentEvents) {
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

  // AE GROW Priority 3 — communications, live-sourced from the Communications Hub. See the
  // file header and buildCommunicationEvent for why this is at most one event per message row.
  for (const m of communicationMessageRows) {
    const event = buildCommunicationEvent(m, propertyLabelById);
    if (event) events.push(event);
  }

  // Newest first — a reverse-chronological feed, matching every other Grow "what's recent"
  // surface (growActivities list, growOpportunities list) already ordered by desc(createdAt).
  // AE GROW Priority 4 -- Appraisal Workspace (Sec.16). One appraisal row can surface several
  // events (created, ready, sent, viewed, presented, follow-up, outcome) since each is sourced
  // from its own dedicated timestamp column on the same row -- never a separate log table.
  for (const ap of appraisalEvents) {
    const propertyLabel = ap.propertyId ? propertyLabelById.get(ap.propertyId) ?? null : null;
    events.push({
      id: `appraisal:${ap.id}:CREATED`,
      type: "APPRAISAL_CREATED",
      occurredAt: ap.createdAt.toISOString(),
      summary: "Appraisal created.",
      propertyId: ap.propertyId,
      propertyLabel,
      opportunityId: ap.opportunityId,
      sourceType: "appraisal",
      sourceId: ap.id,
    });
    if (ap.status === "READY") {
      events.push({
        id: `appraisal:${ap.id}:READY`,
        type: "APPRAISAL_READY",
        occurredAt: ap.updatedAt.toISOString(),
        summary: "Appraisal marked ready to send.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
    if (ap.sentAt) {
      events.push({
        id: `appraisal:${ap.id}:SENT`,
        type: "APPRAISAL_SENT",
        occurredAt: ap.sentAt.toISOString(),
        summary: "Appraisal sent to client.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
    if (ap.viewedAt) {
      events.push({
        id: `appraisal:${ap.id}:VIEWED`,
        type: "APPRAISAL_VIEWED",
        occurredAt: ap.viewedAt.toISOString(),
        summary: "Client viewed the appraisal.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
    if (ap.presentationAt) {
      events.push({
        id: `appraisal:${ap.id}:PRESENTED`,
        type: "APPRAISAL_PRESENTED",
        occurredAt: ap.presentationAt.toISOString(),
        summary: "Appraisal presented to client.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
    if (ap.followUpAt && ap.status === "FOLLOW_UP") {
      events.push({
        id: `appraisal:${ap.id}:FOLLOW_UP`,
        type: "APPRAISAL_FOLLOW_UP",
        occurredAt: ap.followUpAt.toISOString(),
        summary: "Appraisal follow-up scheduled.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
    if (ap.outcome === "WON" && ap.outcomeAt) {
      events.push({
        id: `appraisal:${ap.id}:WON`,
        type: "APPRAISAL_WON",
        occurredAt: ap.outcomeAt.toISOString(),
        summary: "Appraisal won.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    } else if (ap.outcome === "LOST" && ap.outcomeAt) {
      events.push({
        id: `appraisal:${ap.id}:LOST`,
        type: "APPRAISAL_LOST",
        occurredAt: ap.outcomeAt.toISOString(),
        summary: "Appraisal lost.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    } else if (ap.outcome === "DEFERRED" && ap.outcomeAt) {
      events.push({
        id: `appraisal:${ap.id}:DEFERRED`,
        type: "APPRAISAL_DEFERRED",
        occurredAt: ap.outcomeAt.toISOString(),
        summary: "Appraisal deferred.",
        propertyId: ap.propertyId,
        propertyLabel,
        opportunityId: ap.opportunityId,
        sourceType: "appraisal",
        sourceId: ap.id,
      });
    }
  }

  // AE GROW Priority 5 Remediation — Property Intelligence. Only the meaningful, human-decided
  // outcome each signal reaches is surfaced (see this file's GROW_TIMELINE_EVENT_TYPES comment
  // above) — Active/Expired signals produce no event. Each signal reaches at most one of these
  // three terminal states exactly once, so this is always at most one event per row, never a
  // pair.
  for (const s of signalEvents) {
    const propertyLabel = s.propertyId ? propertyLabelById.get(s.propertyId) ?? null : null;
    if (s.status === "Reviewed" && s.reviewedAt) {
      events.push({
        id: `signal:${s.id}:REVIEWED`,
        type: "PROPERTY_INTELLIGENCE_SIGNAL_REVIEWED",
        occurredAt: s.reviewedAt.toISOString(),
        summary: `Property Intelligence signal reviewed: ${s.title}.`,
        propertyId: s.propertyId,
        propertyLabel,
        opportunityId: null,
        sourceType: "property_intelligence_signal",
        sourceId: s.id,
      });
    } else if (s.status === "Dismissed" && s.reviewedAt) {
      events.push({
        id: `signal:${s.id}:DISMISSED`,
        type: "PROPERTY_INTELLIGENCE_SIGNAL_DISMISSED",
        occurredAt: s.reviewedAt.toISOString(),
        summary: `Property Intelligence signal dismissed: ${s.title}${s.dismissedReason ? ` (${s.dismissedReason})` : ""}.`,
        propertyId: s.propertyId,
        propertyLabel,
        opportunityId: null,
        sourceType: "property_intelligence_signal",
        sourceId: s.id,
      });
    } else if (s.status === "Superseded" && s.promotedOpportunityId !== null && s.reviewedAt) {
      events.push({
        id: `signal:${s.id}:PROMOTED`,
        type: "PROPERTY_INTELLIGENCE_SIGNAL_PROMOTED",
        occurredAt: s.reviewedAt.toISOString(),
        summary: `Property Intelligence signal promoted to an opportunity: ${s.title}.`,
        propertyId: s.propertyId,
        propertyLabel,
        opportunityId: s.promotedOpportunityId,
        sourceType: "property_intelligence_signal",
        sourceId: s.id,
      });
    }
  }

  events.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return presentStoredActivitySummaries(events.slice(0, limit), brokerageId);
}
