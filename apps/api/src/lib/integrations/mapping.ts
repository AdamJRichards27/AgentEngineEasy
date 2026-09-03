// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// External identity mapping (Section 5). This module is the only writer
// of integration_external_mappings. It is deliberately NOT a source of
// domain truth (Section 4) — resolveMapping only ever answers "what
// external id, if any, is linked to this internal record", never anything
// a domain service should treat as authoritative state.
//
// Ambiguous mapping -> manual review (Section 14): recordMapping never
// silently overwrites an existing, DIFFERENT mapping for the same
// (connection, entityType, internalId) or (connection, entityType,
// externalId) pair — the unique indexes on both directions
// (packages/db/src/schema/integrations.ts) make a genuine conflict a caught
// 23505, surfaced here as a MappingConflictError rather than a fabricated
// merge. The caller (e.g. webhooks.ts) is responsible for routing that
// conflict to a human via the existing Exception & Risk Engine / dead-letter
// path rather than guessing.

import { and, eq } from "drizzle-orm";
import { db, integrationExternalMappings, type IntegrationExternalMapping } from "@aee/db";

export class MappingConflictError extends Error {
  constructor(
    public readonly entityType: string,
    public readonly conflictingField: "internalId" | "externalId",
  ) {
    super(`Mapping conflict on ${entityType}.${conflictingField} — this ${conflictingField} is already mapped to a different value on this connection.`);
    this.name = "MappingConflictError";
  }
}

export interface RecordMappingInput {
  connectionId: string;
  brokerageId: number;
  entityType: string;
  internalId: string;
  externalId: string;
  externalRef?: Record<string, unknown> | null;
}

export async function recordMapping(input: RecordMappingInput): Promise<IntegrationExternalMapping> {
  const [existingByInternal] = await db
    .select()
    .from(integrationExternalMappings)
    .where(and(eq(integrationExternalMappings.connectionId, input.connectionId), eq(integrationExternalMappings.entityType, input.entityType), eq(integrationExternalMappings.internalId, input.internalId)));

  if (existingByInternal) {
    if (existingByInternal.externalId !== input.externalId) {
      throw new MappingConflictError(input.entityType, "internalId");
    }
    const [updated] = await db
      .update(integrationExternalMappings)
      .set({ externalRef: input.externalRef ?? existingByInternal.externalRef, lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationExternalMappings.id, existingByInternal.id))
      .returning();
    return updated;
  }

  try {
    const [created] = await db
      .insert(integrationExternalMappings)
      .values({
        connectionId: input.connectionId,
        brokerageId: input.brokerageId,
        entityType: input.entityType,
        internalId: input.internalId,
        externalId: input.externalId,
        externalRef: input.externalRef ?? null,
        lastSyncedAt: new Date(),
      })
      .returning();
    return created;
  } catch (err: any) {
    if (err?.code === "23505") {
      throw new MappingConflictError(input.entityType, "externalId");
    }
    throw err;
  }
}

export async function resolveByInternalId(connectionId: string, entityType: string, internalId: string): Promise<IntegrationExternalMapping | null> {
  const [row] = await db
    .select()
    .from(integrationExternalMappings)
    .where(and(eq(integrationExternalMappings.connectionId, connectionId), eq(integrationExternalMappings.entityType, entityType), eq(integrationExternalMappings.internalId, internalId)));
  return row ?? null;
}

export async function resolveByExternalId(connectionId: string, entityType: string, externalId: string): Promise<IntegrationExternalMapping | null> {
  const [row] = await db
    .select()
    .from(integrationExternalMappings)
    .where(and(eq(integrationExternalMappings.connectionId, connectionId), eq(integrationExternalMappings.entityType, entityType), eq(integrationExternalMappings.externalId, externalId)));
  return row ?? null;
}
