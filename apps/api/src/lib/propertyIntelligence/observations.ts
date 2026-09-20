import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  growRelationships,
  propertyProviderObservations,
  properties,
  GROW_OWNERSHIP_RELATIONSHIP_TYPES,
  type PropertyProviderObservation,
  type PropertyObservationType,
} from "@aee/db";
import { logger } from "@aee/events";
import { extractProviderOwnershipStart } from "../ownershipStart.js";

/**
 * AE GROW Priority 5 Remediation — the observations module the merged
 * schema (packages/db/src/schema/propertyIntelligence.ts) already
 * documents but which never actually shipped. See that file's own header
 * comment: a refresh INSERTS a new row and flips the previous current
 * row's isCurrent to false, rather than overwriting anything — so a
 * provider observation's history is never destroyed by a later refresh.
 *
 * This module is deliberately narrow. It is the write path a future
 * provider-ingestion job would call — no such job exists yet, and this
 * remediation does not build one (Priority 5 remains mock-only; see the
 * remediation tracking report's Provider boundary section). Today it is
 * exercised by tests seeding fixtures and is available for
 * lib/propertyIntelligence/signals.ts to read from.
 */

export interface RecordObservationInput {
  brokerageId: number;
  propertyId: number;
  observationType: PropertyObservationType;
  provider: string;
  providerReference?: string | null;
  payload: Record<string, unknown>;
  sourceTimestamp?: Date | null;
  licenceExpiresAt?: Date | null;
  retentionExpiresAt?: Date | null;
}

export class PropertyIntelligenceAccessError extends Error {}

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) {
    throw new PropertyIntelligenceAccessError("Property not found");
  }
}

/**
 * Records a new provider observation and supersedes the previous current
 * row for the same (propertyId, observationType, provider), if any. Never
 * merges into properties.ownershipData or any other canonical column —
 * see the schema file's own Duplication Stop Condition comment. Always
 * tenant-checks the target property first; never trusts a caller-supplied
 * brokerageId on its own.
 */
export async function recordObservation(input: RecordObservationInput): Promise<PropertyProviderObservation> {
  await assertPropertyInBrokerage(input.propertyId, input.brokerageId);

  const [previousCurrent] = await db
    .select({ id: propertyProviderObservations.id })
    .from(propertyProviderObservations)
    .where(
      and(
        eq(propertyProviderObservations.propertyId, input.propertyId),
        eq(propertyProviderObservations.observationType, input.observationType),
        eq(propertyProviderObservations.provider, input.provider),
        eq(propertyProviderObservations.isCurrent, true),
      ),
    );

  const [inserted] = await db
    .insert(propertyProviderObservations)
    .values({
      brokerageId: input.brokerageId,
      propertyId: input.propertyId,
      observationType: input.observationType,
      provider: input.provider,
      providerReference: input.providerReference ?? null,
      payload: input.payload,
      sourceTimestamp: input.sourceTimestamp ?? null,
      isCurrent: true,
      licenceExpiresAt: input.licenceExpiresAt ?? null,
      retentionExpiresAt: input.retentionExpiresAt ?? null,
    })
    .returning();

  if (previousCurrent) {
    await db
      .update(propertyProviderObservations)
      .set({ isCurrent: false, supersededByObservationId: inserted.id })
      .where(eq(propertyProviderObservations.id, previousCurrent.id));
  }

  if (input.observationType === "ownership") {
    await captureOwnershipStartFromObservation(inserted);
  }

  return inserted;
}

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 2 — OWNERSHIP-START CAPTURE
 * (the second of the two capture paths; the first is the import pipeline).
 *
 * WHAT IT DOES. When a provider `ownership` observation explicitly states
 * when the current owner acquired the property, that date is written onto the
 * brokerage's Active owner/co-owner/landlord relationships for that property
 * — but ONLY where AE currently has no value at all.
 *
 * WHY "ONLY WHERE NULL" IS THE WHOLE DESIGN.
 *   - It is a GAP-FILL, never a correction. An agent's imported or manually
 *     entered date is authoritative and a provider can never quietly
 *     overwrite it, so no signal's evidence can change underneath an agent
 *     who is looking at it.
 *   - It makes this operation idempotent. Re-recording the same observation,
 *     or a provider refreshing daily, writes nothing the second time — so it
 *     cannot churn growRelationships.updatedAt, which would in turn make the
 *     sweep's change-detection probe re-evaluate the brokerage forever.
 *
 * WHY IT DOES NOT TOUCH THE SALE HISTORY. See
 * PROVIDER_OWNERSHIP_START_KEYS in lib/ownershipStart.ts: only keys that
 * explicitly describe the start of an ownership are read. "This property last
 * sold in 2011" is a fact about the property, not about whoever AE currently
 * has recorded as its owner, and conflating the two is wrong precisely when
 * the owner record is stale.
 *
 * THIS IS NOT A SIGNAL AND CONTACTS NOBODY. It writes one column on rows the
 * caller's own brokerage owns. The tenure rule reads the result later.
 */
async function captureOwnershipStartFromObservation(observation: PropertyProviderObservation): Promise<void> {
  const extracted = extractProviderOwnershipStart(observation.payload);
  if (!extracted) return;

  const result = await db
    .update(growRelationships)
    .set({
      ownershipStartDate: extracted.value,
      ownershipStartSource: "provider_observation",
      ownershipStartPrecision: extracted.precision,
      // Deliberately NOT touching updatedAt: this is AE recording what it
      // already knew how to look up, not the relationship itself changing.
      // Moving updatedAt would trip the sweep's change-detection probe on
      // every provider refresh.
    })
    .where(
      and(
        // Tenant scope comes from the observation row, which recordObservation
        // has already verified belongs to the caller's brokerage.
        eq(growRelationships.brokerageId, observation.brokerageId),
        eq(growRelationships.propertyId, observation.propertyId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, [...GROW_OWNERSHIP_RELATIONSHIP_TYPES]),
        // The gap-fill condition. Never an overwrite.
        isNull(growRelationships.ownershipStartDate),
      ),
    );

  const filled = result.rowCount ?? 0;
  if (filled > 0) {
    logger.info("property_intelligence_ownership_start_captured", {
      brokerageId: observation.brokerageId,
      propertyId: observation.propertyId,
      observationId: observation.id,
      provider: observation.provider,
      payloadKey: extracted.payloadKey,
      precision: extracted.precision,
      relationshipsFilled: filled,
    });
  }
}

/**
 * Ops/diagnostics: how much of a brokerage's owner population can actually
 * support the long_ownership_tenure rule.
 *
 * Exists because "the tenure rule produced nothing" has two completely
 * different causes — nobody has owned long enough, or AE has no acquisition
 * dates at all — and a brokerage cannot fix the second one without being told
 * it is the case. One statement, brokerage-scoped.
 */
export async function ownershipStartCoverage(brokerageId: number): Promise<{
  ownerRelationships: number;
  withOwnershipStart: number;
  bySource: Record<string, number>;
}> {
  const rows = await db
    .select({
      source: growRelationships.ownershipStartSource,
      total: sql<number>`count(*)::int`,
      withStart: sql<number>`count(${growRelationships.ownershipStartDate})::int`,
    })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, [...GROW_OWNERSHIP_RELATIONSHIP_TYPES]),
      ),
    )
    .groupBy(growRelationships.ownershipStartSource);

  let ownerRelationships = 0;
  let withOwnershipStart = 0;
  const bySource: Record<string, number> = {};
  for (const row of rows) {
    ownerRelationships += Number(row.total);
    withOwnershipStart += Number(row.withStart);
    if (row.source) bySource[row.source] = Number(row.withStart);
  }
  return { ownerRelationships, withOwnershipStart, bySource };
}

/** Current (isCurrent = true) observations for a property, tenant-scoped. */
export async function listCurrentObservations(
  propertyId: number,
  brokerageId: number,
  observationType?: PropertyObservationType,
): Promise<PropertyProviderObservation[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  const conditions = [
    eq(propertyProviderObservations.propertyId, propertyId),
    eq(propertyProviderObservations.brokerageId, brokerageId),
    eq(propertyProviderObservations.isCurrent, true),
  ];
  if (observationType) conditions.push(eq(propertyProviderObservations.observationType, observationType));
  return db
    .select()
    .from(propertyProviderObservations)
    .where(and(...conditions));
}

/** Full history (current + superseded) for a property, tenant-scoped. */
export async function listObservationHistory(propertyId: number, brokerageId: number): Promise<PropertyProviderObservation[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  return db
    .select()
    .from(propertyProviderObservations)
    .where(and(eq(propertyProviderObservations.propertyId, propertyId), eq(propertyProviderObservations.brokerageId, brokerageId)));
}
