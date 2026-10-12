import { eq, and } from "drizzle-orm";
import { db, properties, workflows, workflowSteps, type Property } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";

export type GoLiveResult =
  | { ok: true; property: Property; alreadyLive: boolean }
  | { ok: false; reason: "NO_READY_TO_LIST_WORKFLOW" }
  | { ok: false; reason: "INCOMPLETE_STEPS"; incompleteSteps: Array<{ label: string; status: string; blockedReason: string | null }> };

/**
 * The single Go Live chokepoint — moves a property to workflowStage
 * "Listed" / listingStatus "Listed" and publishes LISTING_LIVE, gated on
 * every Ready to List step being genuinely Complete. Extracted from what
 * was inline logic in routes/properties.ts's POST /:id/go-live (Agent
 * Engine 2.0 — Property Launch & Campaign Coordination) so Launch's own
 * "confirm Listing Live" action (lib/launch/model.ts's confirmLaunchLive())
 * can call the exact same path instead of a second, parallel way to flip a
 * property live — the governing spec is explicit that Launch must reuse
 * the existing lifecycle rather than inventing a duplicate "live" concept.
 * Caller is responsible for the tenant/not-found check on propertyId
 * before calling this (both existing call sites already do).
 */
export async function goLiveProperty(
  propertyId: number,
  brokerageId: number,
  actor: { id: number },
  source: string,
): Promise<GoLiveResult> {
  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, propertyId), eq(workflows.workflowType, "ReadyToList")));
  if (!workflow) {
    return { ok: false, reason: "NO_READY_TO_LIST_WORKFLOW" };
  }

  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  const incomplete = steps.filter((s) => s.status !== "Complete");
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: "INCOMPLETE_STEPS",
      incompleteSteps: incomplete.map((s) => ({ label: s.label, status: s.status, blockedReason: s.blockedReason })),
    };
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) {
    return { ok: false, reason: "NO_READY_TO_LIST_WORKFLOW" };
  }

  if (property.listingStatus === "Listed") {
    return { ok: true, property, alreadyLive: true };
  }

  await db
    .update(properties)
    .set({ workflowStage: "Listed", listingStatus: "Listed", updatedAt: new Date() })
    .where(eq(properties.id, propertyId));

  try {
    await publishDomainEvent({
      eventType: "LISTING_LIVE",
      occurredAt: new Date(),
      propertyId,
      transactionId: null,
      partyId: null,
      brokerageId,
      agentId: actor.id,
      actorType: "USER",
      actorId: actor.id,
      source,
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `listing-live:${propertyId}`,
      payload: { propertyId },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType: "LISTING_LIVE", error: err });
  }

  await logAudit({ brokerageId, userId: actor.id, action: "listing_live", recordType: "property", recordId: String(propertyId), propertyId });

  const [updated] = await db.select().from(properties).where(eq(properties.id, propertyId));
  return { ok: true, property: updated, alreadyLive: false };
}
