import { and, desc, eq } from "drizzle-orm";
import {
  db,
  appraisals,
  appraisalComparableSales,
  appraisalMarketCompetition,
  properties,
  parties,
  growOpportunities,
  users,
} from "@aee/db";
import type { Appraisal, AppraisalComparableSale, AppraisalMarketCompetition } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger, type AgentEngineEasyEventType } from "@aee/events";
import { partyDisplayName as computePartyDisplayName } from "./communications/recipientResolution.js";
import { logAudit } from "./audit.js";
import { getOrCreateAppraisal } from "./appraisals.js";
import {
  noteGrowAppraisalIsolationRejection,
  noteGrowOpportunityIsolationRejection,
  noteGrowPartyIsolationRejection,
  noteGrowUserIsolationRejection,
} from "./grow/isolationRejection.js";

/**
 * AE GROW Priority 4 -- Appraisal Workspace. This file is the Grow-facing
 * layer on top of the existing RUN-tier appraisals.ts (Stage A). It never
 * duplicates appraisals.ts's own creation/finalise/publish logic -- every
 * Grow entry point below calls getOrCreateAppraisal() first (so the RUN
 * side keeps its one canonical row and its own APPRAISAL_CREATED
 * publish/audit), then layers the Grow workspace fields on top with a
 * direct update.
 */

export class AppraisalAccessError extends Error {}
export class AppraisalTransitionError extends Error {}

/** Sec.6 -- explicit, auditable status graph. Deliberately not fully linear:
 * an agent can jump straight to APPOINTMENT_SCHEDULED from DRAFT, but can
 * never move backwards out of a recorded outcome. */
const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["PREPARING", "APPOINTMENT_SCHEDULED", "ARCHIVED"],
  PREPARING: ["READY", "APPOINTMENT_SCHEDULED", "DRAFT", "ARCHIVED"],
  READY: ["SENT", "APPOINTMENT_SCHEDULED", "PREPARING", "ARCHIVED"],
  SENT: ["VIEWED", "APPOINTMENT_SCHEDULED", "PRESENTED", "FOLLOW_UP", "ARCHIVED"],
  VIEWED: ["APPOINTMENT_SCHEDULED", "PRESENTED", "FOLLOW_UP", "ARCHIVED"],
  APPOINTMENT_SCHEDULED: ["PRESENTED", "FOLLOW_UP", "SENT", "ARCHIVED"],
  PRESENTED: ["FOLLOW_UP", "WON", "LOST", "DEFERRED", "ARCHIVED"],
  FOLLOW_UP: ["PRESENTED", "WON", "LOST", "DEFERRED", "ARCHIVED"],
  WON: ["ARCHIVED"],
  LOST: ["ARCHIVED"],
  DEFERRED: ["FOLLOW_UP", "ARCHIVED"],
  ARCHIVED: [],
};

const OUTCOME_STATUSES = new Set(["WON", "LOST", "DEFERRED"]);

async function publishAppraisalEvent(eventType: AgentEngineEasyEventType, appraisal: Appraisal, brokerageId: number, userId: number, extra: Record<string, unknown> = {}) {
  try {
    await publishDomainEvent({
      eventType,
      occurredAt: new Date(),
      propertyId: appraisal.propertyId,
      transactionId: null,
      partyId: appraisal.partyId ?? null,
      brokerageId,
      agentId: userId,
      actorType: "USER",
      actorId: userId,
      source: "api:grow-appraisals",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `${eventType.toLowerCase()}:${appraisal.id}:${Date.now()}`,
      payload: { appraisalId: appraisal.id, ...extra },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType, appraisalId: appraisal.id, error: err });
  }
}

/** Tenant isolation: every Grow appraisal function resolves the row through
 * this helper first, joining to properties.brokerageId (there is no
 * denormalised brokerageId on appraisals -- see schema comment). Never
 * trust a caller-supplied brokerageId without this join. */
export async function assertAppraisalInBrokerage(appraisalId: number, brokerageId: number): Promise<Appraisal> {
  const [row] = await db
    .select({ appraisal: appraisals, propertyBrokerageId: properties.brokerageId })
    .from(appraisals)
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .where(eq(appraisals.id, appraisalId));
  if (!row || row.propertyBrokerageId !== brokerageId) {
    await noteGrowAppraisalIsolationRejection(appraisalId, brokerageId);
    throw new AppraisalAccessError("Appraisal not found");
  }
  return row.appraisal;
}

export interface AppraisalWorkspace {
  appraisal: Appraisal;
  comparableSales: AppraisalComparableSale[];
  marketCompetition: AppraisalMarketCompetition[];
}

export async function getAppraisalWorkspace(appraisalId: number, brokerageId: number): Promise<AppraisalWorkspace> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  const [comparableSales, marketCompetition] = await Promise.all([
    db.select().from(appraisalComparableSales).where(eq(appraisalComparableSales.appraisalId, appraisalId)).orderBy(appraisalComparableSales.displayOrder),
    db.select().from(appraisalMarketCompetition).where(eq(appraisalMarketCompetition.appraisalId, appraisalId)).orderBy(appraisalMarketCompetition.displayOrder),
  ]);
  return { appraisal, comparableSales, marketCompetition };
}

/** Sec.7 -- Create from Contact 360. propertyId must already be a real,
 * canonical property (selected or created through the existing property
 * mechanism before this is called) -- this never creates an appraisal-only
 * property record. */
export async function createAppraisalFromContact(input: {
  partyId: number;
  propertyId: number;
  brokerageId: number;
  userId: number;
}): Promise<Appraisal> {
  const [party] = await db.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party || party.brokerageId !== input.brokerageId) {
    await noteGrowPartyIsolationRejection(input.partyId, input.brokerageId);
    throw new AppraisalAccessError("Contact not found");
  }

  const { appraisal: base } = await getOrCreateAppraisal({
    propertyId: input.propertyId,
    userId: input.userId,
    brokerageId: input.brokerageId,
  });

  const [updated] = await db
    .update(appraisals)
    .set({
      partyId: input.partyId,
      ownerUserId: base.ownerUserId ?? input.userId,
      createdByUserId: base.createdByUserId ?? input.userId,
      status: base.status ?? "DRAFT",
      updatedAt: new Date(),
    })
    .where(eq(appraisals.id, base.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_workspace_linked_to_contact",
    recordType: "appraisal",
    recordId: String(updated.id),
    propertyId: input.propertyId,
  });

  return updated;
}

/** Sec.8 -- Create from Grow Opportunity. Pre-populates contact/property from
 * the opportunity and records the opportunity as the appraisal's origin.
 * growOpportunities.convertedAppraisalId / stage were already reserved for
 * exactly this handoff (see packages/db/src/schema/grow.ts) -- this is the
 * first code that actually populates them. */
export async function createAppraisalFromOpportunity(input: {
  opportunityId: number;
  brokerageId: number;
  userId: number;
}): Promise<Appraisal> {
  const [opportunity] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, input.opportunityId));
  if (!opportunity || opportunity.brokerageId !== input.brokerageId) {
    await noteGrowOpportunityIsolationRejection(input.opportunityId, input.brokerageId);
    throw new AppraisalAccessError("Opportunity not found");
  }
  if (!opportunity.propertyId) {
    throw new AppraisalTransitionError("Opportunity has no linked property yet -- link or create a property before starting an appraisal");
  }

  const { appraisal: base } = await getOrCreateAppraisal({
    propertyId: opportunity.propertyId,
    userId: input.userId,
    brokerageId: input.brokerageId,
  });

  const [updated] = await db
    .update(appraisals)
    .set({
      partyId: opportunity.partyId,
      opportunityId: opportunity.id,
      ownerUserId: base.ownerUserId ?? opportunity.ownerUserId ?? input.userId,
      createdByUserId: base.createdByUserId ?? input.userId,
      status: base.status ?? "DRAFT",
      updatedAt: new Date(),
    })
    .where(eq(appraisals.id, base.id))
    .returning();

  await db
    .update(growOpportunities)
    .set({ stage: "AppraisalBooked", convertedAppraisalId: updated.id, updatedAt: new Date() })
    .where(eq(growOpportunities.id, opportunity.id));

  await logAudit({
    userId: input.userId,
    action: "appraisal_workspace_created_from_opportunity",
    recordType: "appraisal",
    recordId: String(updated.id),
    propertyId: opportunity.propertyId,
  });
  await publishAppraisalEvent("OPPORTUNITY_STAGE_CHANGED", updated, input.brokerageId, input.userId, {
    opportunityId: opportunity.id,
    stage: "AppraisalBooked",
  });

  return updated;
}

export interface UpdateAppraisalWorkspaceInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  priceRangeLow?: string | null;
  priceRangeHigh?: string | null;
  priceRangeCurrency?: string;
  pricingCommentary?: string | null;
  marketPositionNarrative?: string | null;
  sellingStrategy?: string | null;
  marketingProposal?: string | null;
  commissionRatePercent?: string | null;
  commissionProposal?: string | null;
  recommendedNextSteps?: string | null;
  appointmentAt?: string | null;
  presentationAt?: string | null;
  ownerUserId?: number | null;
}

/** Sec.9 -- the Workspace's editable narrative/pricing/strategy fields, all in
 * one PATCH (the UI is sectioned/tabbed, but there is one underlying record
 * -- no reason to fragment this into one endpoint per section). */
export async function updateAppraisalWorkspace(input: UpdateAppraisalWorkspaceInput): Promise<Appraisal> {
  const existing = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  if (OUTCOME_STATUSES.has(existing.status) || existing.status === "ARCHIVED") {
    throw new AppraisalTransitionError(`Appraisal is ${existing.status} and is no longer editable`);
  }
  if (
    input.priceRangeLow != null &&
    input.priceRangeHigh != null &&
    Number(input.priceRangeLow) > Number(input.priceRangeHigh)
  ) {
    throw new AppraisalTransitionError("Price range low cannot exceed price range high");
  }
  // WP1 P1-2: an appraisal owner must be a user of the SAME brokerage. Without this a caller
  // could assign any user id in the system, and that foreign user's name would then surface in
  // the pipeline and the generated presentation. A foreign/unknown id is reported exactly like
  // any other out-of-tenant id (404 via AppraisalAccessError), never confirming it exists.
  if (input.ownerUserId != null) {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.ownerUserId), eq(users.brokerageId, input.brokerageId)));
    if (!owner) {
      await noteGrowUserIsolationRejection(input.ownerUserId, input.brokerageId);
      throw new AppraisalAccessError("Owner user not found");
    }
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of [
    "priceRangeLow",
    "priceRangeHigh",
    "priceRangeCurrency",
    "pricingCommentary",
    "marketPositionNarrative",
    "sellingStrategy",
    "marketingProposal",
    "commissionRatePercent",
    "commissionProposal",
    "recommendedNextSteps",
    "ownerUserId",
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (input.appointmentAt !== undefined) patch.appointmentAt = input.appointmentAt ? new Date(input.appointmentAt) : null;
  if (input.presentationAt !== undefined) patch.presentationAt = input.presentationAt ? new Date(input.presentationAt) : null;

  const [updated] = await db.update(appraisals).set(patch).where(eq(appraisals.id, existing.id)).returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_workspace_updated",
    recordType: "appraisal",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
  });

  return updated;
}

/** Sec.6 -- explicit status transition, validated against ALLOWED_STATUS_TRANSITIONS.
 * WON/LOST/DEFERRED must go through recordOutcome() instead, which sets the
 * required outcome fields atomically with the status change. */
export async function transitionAppraisalStatus(input: {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  toStatus: string;
}): Promise<Appraisal> {
  if (OUTCOME_STATUSES.has(input.toStatus)) {
    throw new AppraisalTransitionError("Use recordOutcome() to move an appraisal to WON, LOST or DEFERRED");
  }
  const existing = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  const allowed = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(input.toStatus)) {
    throw new AppraisalTransitionError(`Cannot move an appraisal from ${existing.status} to ${input.toStatus}`);
  }

  const patch: Record<string, unknown> = { status: input.toStatus, updatedAt: new Date() };
  if (input.toStatus === "SENT" && !existing.sentAt) patch.sentAt = new Date();
  if (input.toStatus === "VIEWED" && !existing.viewedAt) patch.viewedAt = new Date();
  if (input.toStatus === "PRESENTED" && !existing.presentationAt) patch.presentationAt = new Date();

  const [updated] = await db.update(appraisals).set(patch).where(eq(appraisals.id, existing.id)).returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_status_changed",
    recordType: "appraisal",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
  });
  await publishAppraisalEvent("APPRAISAL_STATUS_CHANGED", updated, input.brokerageId, input.userId, {
    fromStatus: existing.status,
    toStatus: input.toStatus,
  });

  return updated;
}

const APPRAISAL_OUTCOME_REASON_SET = new Set([
  "selected_another_agent",
  "fee_commission",
  "pricing_disagreement",
  "marketing_proposal",
  "relationship",
  "decided_not_to_sell",
  "timing_delayed",
  "unable_to_contact",
  "other",
]);

/** Sec.18 -- record WON / LOST / DEFERRED with a structured, extensible reason.
 * On WON, if this appraisal originated from a Grow opportunity, also moves
 * that opportunity to stage "Converted" -- the Grow-side half of the Sec.19
 * handoff; the Run-side half (creating the actual listing) is a separate,
 * agent-confirmed action (convertAppraisalToRun). */
export async function recordAppraisalOutcome(input: {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  outcome: "WON" | "LOST" | "DEFERRED";
  outcomeReason?: string | null;
  outcomeNotes?: string | null;
}): Promise<Appraisal> {
  const existing = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  const allowed = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];
  if (!allowed.includes(input.outcome)) {
    throw new AppraisalTransitionError(`Cannot record outcome ${input.outcome} from status ${existing.status}`);
  }
  if (input.outcomeReason && !APPRAISAL_OUTCOME_REASON_SET.has(input.outcomeReason)) {
    throw new AppraisalTransitionError(`Unknown outcome reason: ${input.outcomeReason}`);
  }

  const [updated] = await db
    .update(appraisals)
    .set({
      status: input.outcome,
      outcome: input.outcome,
      outcomeReason: input.outcomeReason ?? null,
      outcomeNotes: input.outcomeNotes ?? null,
      outcomeAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(appraisals.id, existing.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_outcome_recorded",
    recordType: "appraisal",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
  });
  await publishAppraisalEvent("APPRAISAL_STATUS_CHANGED", updated, input.brokerageId, input.userId, {
    fromStatus: existing.status,
    toStatus: input.outcome,
    outcomeReason: input.outcomeReason ?? null,
  });

  if (input.outcome === "WON" && updated.opportunityId) {
    await db
      .update(growOpportunities)
      .set({ stage: "Converted", status: "Converted", closedAt: new Date(), updatedAt: new Date() })
      .where(eq(growOpportunities.id, updated.opportunityId));
    await publishAppraisalEvent("OPPORTUNITY_CONVERTED", updated, input.brokerageId, input.userId, {
      opportunityId: updated.opportunityId,
    });
  } else if ((input.outcome === "LOST" || input.outcome === "DEFERRED") && updated.opportunityId) {
    await db
      .update(growOpportunities)
      .set({
        status: input.outcome === "LOST" ? "Lost" : "Open",
        lostReason: input.outcome === "LOST" ? (input.outcomeReason ?? "other") : null,
        closedAt: input.outcome === "LOST" ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(growOpportunities.id, updated.opportunityId));
  }

  return updated;
}

/** Sec.17 -- follow-up date/notes. Deliberately just two columns on the
 * appraisal itself rather than a new task row -- Grow Today (growToday.ts)
 * reads followUpAt directly instead of a second commitments-style table. */
export async function scheduleAppraisalFollowUp(input: {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  followUpAt: string;
  followUpNotes?: string | null;
}): Promise<Appraisal> {
  const existing = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  if (OUTCOME_STATUSES.has(existing.status) || existing.status === "ARCHIVED") {
    throw new AppraisalTransitionError(`Appraisal is ${existing.status}; cannot schedule a follow-up`);
  }
  const nextStatus = ALLOWED_STATUS_TRANSITIONS[existing.status]?.includes("FOLLOW_UP") ? "FOLLOW_UP" : existing.status;

  const [updated] = await db
    .update(appraisals)
    .set({
      followUpAt: new Date(input.followUpAt),
      followUpNotes: input.followUpNotes ?? null,
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(eq(appraisals.id, existing.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_follow_up_scheduled",
    recordType: "appraisal",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
  });

  return updated;
}

export interface AppraisalPipelineRow {
  id: number;
  status: string;
  outcome: string | null;
  propertyId: number;
  propertyAddress: string;
  partyId: number | null;
  partyDisplayName: string | null;
  ownerUserId: number | null;
  ownerName: string | null;
  priceRangeLow: string | null;
  priceRangeHigh: string | null;
  priceRangeCurrency: string;
  appointmentAt: Date | null;
  presentationAt: Date | null;
  followUpAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Sec.21 -- lightweight Grow pipeline view. One query, joined for display
 * fields only (address, contact name) -- not a second CRM pipeline. */
export async function listAppraisalPipeline(input: {
  brokerageId: number;
  filter?: "active" | "follow_up" | "won" | "lost" | "deferred";
  ownerUserId?: number;
}): Promise<AppraisalPipelineRow[]> {
  const rawRows = await db
    .select({
      id: appraisals.id,
      status: appraisals.status,
      outcome: appraisals.outcome,
      propertyId: appraisals.propertyId,
      propertyAddress: properties.formattedAddress,
      partyId: appraisals.partyId,
      partyType: parties.partyType,
      partyFirstName: parties.firstName,
      partyLastName: parties.lastName,
      partyOrganisationName: parties.organisationName,
      ownerUserId: appraisals.ownerUserId,
      ownerFirstName: users.firstName,
      ownerLastName: users.lastName,
      priceRangeLow: appraisals.priceRangeLow,
      priceRangeHigh: appraisals.priceRangeHigh,
      priceRangeCurrency: appraisals.priceRangeCurrency,
      appointmentAt: appraisals.appointmentAt,
      presentationAt: appraisals.presentationAt,
      followUpAt: appraisals.followUpAt,
      createdAt: appraisals.createdAt,
      updatedAt: appraisals.updatedAt,
    })
    .from(appraisals)
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .leftJoin(parties, eq(parties.id, appraisals.partyId))
    // WP1 P1-2: the owner join is tenant-scoped too, so even a pre-existing bad row whose
    // ownerUserId points at another brokerage's user never exposes that user's name.
    .leftJoin(users, and(eq(users.id, appraisals.ownerUserId), eq(users.brokerageId, input.brokerageId)))
    .where(eq(properties.brokerageId, input.brokerageId))
    .orderBy(desc(appraisals.updatedAt));

  const rows: AppraisalPipelineRow[] = rawRows.map((r) => {
    const { ownerFirstName, ownerLastName, partyType, partyFirstName, partyLastName, partyOrganisationName, ...rest } = r;
    const ownerName = ownerFirstName || ownerLastName ? `${ownerFirstName ?? ""} ${ownerLastName ?? ""}`.trim() : null;
    const partyDisplayName = partyType
      ? computePartyDisplayName({ partyType, firstName: partyFirstName, lastName: partyLastName, organisationName: partyOrganisationName })
      : null;
    return { ...rest, ownerName, partyDisplayName };
  });

  let filtered = rows;
  if (input.filter === "active") {
    filtered = filtered.filter((r) => !OUTCOME_STATUSES.has(r.status) && r.status !== "ARCHIVED");
  } else if (input.filter === "follow_up") {
    filtered = filtered.filter((r) => r.status === "FOLLOW_UP" || r.followUpAt !== null);
  } else if (input.filter === "won") {
    filtered = filtered.filter((r) => r.outcome === "WON");
  } else if (input.filter === "lost") {
    filtered = filtered.filter((r) => r.outcome === "LOST");
  } else if (input.filter === "deferred") {
    filtered = filtered.filter((r) => r.outcome === "DEFERRED");
  }
  if (input.ownerUserId) {
    filtered = filtered.filter((r) => r.ownerUserId === input.ownerUserId);
  }
  return filtered;
}
