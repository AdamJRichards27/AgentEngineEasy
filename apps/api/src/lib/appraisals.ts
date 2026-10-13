import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, appraisals, properties } from "@aee/db";
import type { Appraisal } from "@aee/db";
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { logAudit } from "./audit.js";
import { enforceAppraisalPricingRule } from "./appraisalFinaliseGuard.js";
import { noteGrowPropertyIsolationRejection } from "./grow/isolationRejection.js";

/**
 * Stage A — Appraisals (Agent Engine 2.0 — Run Transaction Vertical
 * Slice). The `appraisals` table (packages/db/src/schema/appraisal.ts) had
 * zero route/lib references anywhere in this codebase before this change —
 * schema-only, unreachable from any request. This closes that gap with the
 * minimum real Run-tier appraisal flow: capture a price range and
 * comparable sales, finalise it (immutable snapshot, matching the schema's
 * own finalisedSnapshot comment), and publish the two canonical events that
 * already existed in the event registry with zero publishers before this
 * (APPRAISAL_CREATED / APPRAISAL_COMPLETED).
 *
 * Deliberately excluded (Run-tier boundary, governing spec §8): no
 * automatic suburb/comparable-sales data-provider integration, no PDF
 * generation, no supplier ordering. Comparable sales are agent-entered
 * free-form JSON — same "no invented integration" discipline
 * offers.conditions already established.
 */

/**
 * `appraisals.brokerage_id` is the property's brokerage (migration 0036).
 * Updates cannot join, so the WHERE carries the direct column and this
 * property subquery together. Inserts copy the brokerage from the property
 * row already loaded.
 */
export function appraisalInBrokerage(brokerageId: number) {
  return sql`${appraisals.brokerageId} = ${brokerageId} and ${appraisals.propertyId} in (select ${properties.id} from ${properties} where ${properties.brokerageId} = ${brokerageId})`;
}

async function selectAppraisalForBrokerageProperty(propertyId: number, brokerageId: number): Promise<Appraisal | undefined> {
  const [row] = await db
    .select({ appraisal: appraisals })
    .from(appraisals)
    .innerJoin(properties, eq(properties.id, appraisals.propertyId))
    .where(and(eq(appraisals.propertyId, propertyId), eq(appraisals.brokerageId, brokerageId), eq(properties.brokerageId, brokerageId)));
  return row?.appraisal;
}

export async function getOrCreateAppraisal(input: {
  propertyId: number;
  userId: number;
  brokerageId: number;
}): Promise<{ appraisal: Appraisal; created: boolean }> {
  // E-9 A4: the property is the tenant parent. The brokerage predicate is in
  // this query, not only in the comparison below.
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.brokerageId, input.brokerageId)));
  if (!property || property.brokerageId !== input.brokerageId) {
    await noteGrowPropertyIsolationRejection(input.propertyId, input.brokerageId);
    throw new Error(`Property ${input.propertyId} not found`);
  }

  const existing = await selectAppraisalForBrokerageProperty(input.propertyId, input.brokerageId);
  if (existing) {
    return { appraisal: existing, created: false };
  }

  const [appraisal] = await db
    .insert(appraisals)
    .values({
      propertyId: input.propertyId,
      brokerageId: property.brokerageId,
      shareToken: randomBytes(16).toString("hex"),
    })
    .returning();

  await logAudit({
    userId: input.userId,
    action: "appraisal_created",
    recordType: "appraisal",
    recordId: String(appraisal.id),
    propertyId: input.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "APPRAISAL_CREATED",
      occurredAt: new Date(),
      propertyId: input.propertyId,
      transactionId: null,
      partyId: null,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:appraisals:create",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `appraisal-created:${appraisal.id}`,
      payload: { appraisalId: appraisal.id },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", {
      eventType: "APPRAISAL_CREATED",
      propertyId: input.propertyId,
      appraisalId: appraisal.id,
      error: err,
    });
  }

  return { appraisal, created: true };
}

export async function updateAppraisal(input: {
  propertyId: number;
  userId: number;
  brokerageId: number;
  priceRangeLow?: string | null;
  priceRangeHigh?: string | null;
  comparableSales?: unknown;
}): Promise<Appraisal> {
  const { appraisal } = await getOrCreateAppraisal(input);
  // Same rule Grow uses. Finalised pricing is locked, and a closed
  // lifecycle (WON / LOST / DEFERRED / ARCHIVED) is not editable here
  // either. A DRAFT that is not finalised still saves, which is Stage A.
  enforceAppraisalPricingRule(appraisal);

  const [updated] = await db
    .update(appraisals)
    .set({
      priceRangeLow: input.priceRangeLow !== undefined ? input.priceRangeLow : appraisal.priceRangeLow,
      priceRangeHigh: input.priceRangeHigh !== undefined ? input.priceRangeHigh : appraisal.priceRangeHigh,
      comparableSales: input.comparableSales !== undefined ? input.comparableSales : appraisal.comparableSales,
      updatedAt: new Date(),
    })
    .where(and(eq(appraisals.id, appraisal.id), appraisalInBrokerage(input.brokerageId)))
    .returning();
  if (!updated) {
    await noteGrowPropertyIsolationRejection(input.propertyId, input.brokerageId);
    throw new Error(`Property ${input.propertyId} not found`);
  }

  await logAudit({
    userId: input.userId,
    action: "appraisal_updated",
    recordType: "appraisal",
    recordId: String(appraisal.id),
    propertyId: input.propertyId,
  });

  return updated;
}

/** Idempotent chokepoint — finalising an already-finalised appraisal just returns it unchanged. */
export async function finaliseAppraisal(input: { propertyId: number; userId: number; brokerageId: number }): Promise<Appraisal> {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, input.propertyId), eq(properties.brokerageId, input.brokerageId)));
  if (!property || property.brokerageId !== input.brokerageId) {
    await noteGrowPropertyIsolationRejection(input.propertyId, input.brokerageId);
    throw new Error(`Property ${input.propertyId} not found`);
  }

  const existing = await selectAppraisalForBrokerageProperty(input.propertyId, input.brokerageId);
  if (!existing) {
    throw new Error(`No appraisal has been started for property ${input.propertyId}.`);
  }
  if (existing.isFinalised) return existing;
  if (!existing.priceRangeLow || !existing.priceRangeHigh) {
    throw new Error("A price range is required before an appraisal can be finalised.");
  }

  const finalisedSnapshot = {
    priceRangeLow: existing.priceRangeLow,
    priceRangeHigh: existing.priceRangeHigh,
    comparableSales: existing.comparableSales,
    finalisedAt: new Date().toISOString(),
  };

  const [updated] = await db
    .update(appraisals)
    .set({ isFinalised: true, finalisedSnapshot, updatedAt: new Date() })
    .where(and(eq(appraisals.id, existing.id), appraisalInBrokerage(input.brokerageId)))
    .returning();
  if (!updated) {
    await noteGrowPropertyIsolationRejection(input.propertyId, input.brokerageId);
    throw new Error(`Property ${input.propertyId} not found`);
  }

  await logAudit({
    userId: input.userId,
    action: "appraisal_finalised",
    recordType: "appraisal",
    recordId: String(existing.id),
    propertyId: input.propertyId,
  });

  try {
    await publishDomainEvent({
      eventType: "APPRAISAL_COMPLETED",
      occurredAt: new Date(),
      propertyId: input.propertyId,
      transactionId: null,
      partyId: null,
      brokerageId: input.brokerageId,
      agentId: input.userId,
      actorType: "USER",
      actorId: input.userId,
      source: "api:appraisals:finalise",
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `appraisal-completed:${existing.id}`,
      payload: { appraisalId: existing.id, priceRangeLow: existing.priceRangeLow, priceRangeHigh: existing.priceRangeHigh },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", {
      eventType: "APPRAISAL_COMPLETED",
      propertyId: input.propertyId,
      appraisalId: existing.id,
      error: err,
    });
  }

  return updated;
}

export async function getAppraisalByProperty(propertyId: number, brokerageId: number): Promise<Appraisal | null> {
  const appraisal = await selectAppraisalForBrokerageProperty(propertyId, brokerageId);
  return appraisal ?? null;
}
