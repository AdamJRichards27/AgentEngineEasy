import { and, eq } from "drizzle-orm";
import { db, propertyProviderObservations, properties, type PropertyProviderObservation, type PropertyObservationType } from "@aee/db";

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

  return inserted;
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
