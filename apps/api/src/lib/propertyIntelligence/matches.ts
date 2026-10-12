import { and, eq } from "drizzle-orm";
import { db, propertyExternalIdentifiers, properties, type PropertyExternalIdentifier } from "@aee/db";
import { logAudit } from "../audit.js";
import { PropertyIntelligenceAccessError } from "./observations.js";

/**
 * AE GROW Priority 5 Remediation — match review workflow for
 * property_external_identifiers. Generalises apps/api/src/lib/ownership.ts's
 * "review, not block" philosophy: every row this module can create starts
 * PendingReview, and only an authenticated, entitled human ever moves it to
 * Confirmed or Rejected. Nothing here auto-links on a name/address
 * similarity alone, and nothing here merges or mutates a canonical
 * `properties` row — a match is a link, never a write to the property
 * itself.
 */

export class PropertyIntelligenceTransitionError extends Error {}

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new PropertyIntelligenceAccessError("Property not found");
}

/** Tenant-scoped lookup of a single identifier row — the one chokepoint every mutation below goes through. */
async function assertIdentifierInBrokerage(identifierId: number, brokerageId: number): Promise<PropertyExternalIdentifier> {
  const [row] = await db
    .select()
    .from(propertyExternalIdentifiers)
    .where(and(eq(propertyExternalIdentifiers.id, identifierId), eq(propertyExternalIdentifiers.brokerageId, brokerageId)));
  if (!row) throw new PropertyIntelligenceAccessError("Match not found");
  return row;
}

export interface ProposeMatchInput {
  brokerageId: number;
  propertyId: number;
  provider: string;
  externalId: string;
  matchConfidence?: number | null;
  matchReasons?: string[] | null;
}

/**
 * The write path a future provider-matching job would call to propose a
 * new (provider, externalId) <-> property link — the counterpart to
 * observations.ts's recordObservation() for this table. No such job exists
 * yet (Priority 5 remains mock-only; see the remediation tracking report's
 * Provider boundary section), so today this is exercised by tests seeding
 * fixtures, exactly like recordObservation(). Always starts PendingReview —
 * nothing in this module ever proposes a match as already Confirmed. On a
 * (provider, externalId) collision (the table's own unique index) the
 * existing row's confidence/reasons are refreshed only if it is still
 * PendingReview — an already-Confirmed or -Rejected match is never
 * silently reopened by a later proposal, the same "never silently
 * re-treated" rule confirmMatch/rejectMatch already enforce.
 */
export async function proposeMatch(input: ProposeMatchInput): Promise<PropertyExternalIdentifier> {
  await assertPropertyInBrokerage(input.propertyId, input.brokerageId);

  const [existing] = await db
    .select()
    .from(propertyExternalIdentifiers)
    .where(and(eq(propertyExternalIdentifiers.provider, input.provider), eq(propertyExternalIdentifiers.externalId, input.externalId)));

  if (!existing) {
    const [inserted] = await db
      .insert(propertyExternalIdentifiers)
      .values({
        brokerageId: input.brokerageId,
        propertyId: input.propertyId,
        provider: input.provider,
        externalId: input.externalId,
        matchConfidence: input.matchConfidence != null ? String(input.matchConfidence) : null,
        matchReasons: input.matchReasons ?? null,
        status: "PendingReview",
      })
      .returning();
    return inserted;
  }

  if (existing.status !== "PendingReview") {
    return existing;
  }

  const [updated] = await db
    .update(propertyExternalIdentifiers)
    .set({
      matchConfidence: input.matchConfidence != null ? String(input.matchConfidence) : existing.matchConfidence,
      matchReasons: input.matchReasons ?? existing.matchReasons,
      updatedAt: new Date(),
    })
    .where(and(eq(propertyExternalIdentifiers.id, existing.id), eq(propertyExternalIdentifiers.brokerageId, input.brokerageId)))
    .returning();
  if (!updated) throw new PropertyIntelligenceAccessError("Match not found");
  return updated;
}

export async function listMatchesForProperty(
  propertyId: number,
  brokerageId: number,
  status?: "PendingReview" | "Confirmed" | "Rejected",
): Promise<PropertyExternalIdentifier[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  const conditions = [eq(propertyExternalIdentifiers.propertyId, propertyId), eq(propertyExternalIdentifiers.brokerageId, brokerageId)];
  if (status) conditions.push(eq(propertyExternalIdentifiers.status, status));
  return db
    .select()
    .from(propertyExternalIdentifiers)
    .where(and(...conditions));
}

export async function confirmMatch(input: { identifierId: number; brokerageId: number; userId: number }): Promise<PropertyExternalIdentifier> {
  const existing = await assertIdentifierInBrokerage(input.identifierId, input.brokerageId);
  if (existing.status !== "PendingReview") {
    // A already-Confirmed or already-Rejected row is never silently re-treated — see
    // the remediation objective's "prevent a rejected match from being silently
    // treated as confirmed" requirement. Review history (reviewedByUserId/reviewedAt)
    // is preserved by simply refusing the second transition.
    throw new PropertyIntelligenceTransitionError(`Match is already ${existing.status}; it cannot be confirmed again`);
  }

  const [updated] = await db
    .update(propertyExternalIdentifiers)
    .set({ status: "Confirmed", reviewedByUserId: input.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(propertyExternalIdentifiers.id, existing.id), eq(propertyExternalIdentifiers.brokerageId, input.brokerageId)))
    .returning();
  if (!updated) throw new PropertyIntelligenceAccessError("Match not found");

  await logAudit({
    userId: input.userId,
    action: "property_intelligence_match_confirmed",
    recordType: "property_external_identifier",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
    previousValue: existing.status,
    updatedValue: "Confirmed",
  });

  return updated;
}

export async function rejectMatch(input: {
  identifierId: number;
  brokerageId: number;
  userId: number;
  rejectedReason?: string | null;
}): Promise<PropertyExternalIdentifier> {
  const existing = await assertIdentifierInBrokerage(input.identifierId, input.brokerageId);
  if (existing.status !== "PendingReview") {
    throw new PropertyIntelligenceTransitionError(`Match is already ${existing.status}; it cannot be rejected again`);
  }

  const [updated] = await db
    .update(propertyExternalIdentifiers)
    .set({
      status: "Rejected",
      reviewedByUserId: input.userId,
      reviewedAt: new Date(),
      rejectedReason: input.rejectedReason ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(propertyExternalIdentifiers.id, existing.id), eq(propertyExternalIdentifiers.brokerageId, input.brokerageId)))
    .returning();
  if (!updated) throw new PropertyIntelligenceAccessError("Match not found");

  await logAudit({
    userId: input.userId,
    action: "property_intelligence_match_rejected",
    recordType: "property_external_identifier",
    recordId: String(existing.id),
    propertyId: existing.propertyId,
    previousValue: existing.status,
    updatedValue: "Rejected",
  });

  return updated;
}
