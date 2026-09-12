import { and, eq } from "drizzle-orm";
import { db, properties, parties, growRelationships, type GrowOpportunitySignal, type PropertyExternalIdentifier, type PropertyProviderObservation } from "@aee/db";
import { PropertyIntelligenceAccessError, listCurrentObservations } from "./observations.js";
import { listMatchesForProperty } from "./matches.js";
import { listSignalsForProperty, listActiveSignalsForParty, recalculateSignalsForProperty } from "./signals.js";

export { PropertyIntelligenceAccessError } from "./observations.js";
export { PropertyIntelligenceTransitionError } from "./matches.js";
export {
  confirmMatch,
  rejectMatch,
  listMatchesForProperty,
} from "./matches.js";
export {
  recalculateSignalsForProperty,
  listSignalsForProperty,
  listActiveSignalsForParty,
  reviewSignal,
  dismissSignal,
  promoteSignal,
} from "./signals.js";
export { recordObservation, listCurrentObservations, listObservationHistory } from "./observations.js";

/**
 * AE GROW Priority 5 Remediation — the tenant-scoped read surface Contact
 * 360, the Property Workspace, and the API routes all sit on top of.
 * Every function here re-derives brokerage scoping itself (via the
 * per-module helpers it calls) rather than trusting a caller-supplied
 * brokerageId — see the remediation objective's "no service method may
 * trust a client-supplied brokerageId" requirement.
 */

export interface PropertyIntelligenceSummary {
  propertyId: number;
  dataQualityStatus: string | null;
  lastEnrichedAt: string | null;
  currentObservations: PropertyProviderObservation[];
  pendingMatches: PropertyExternalIdentifier[];
  activeSignals: GrowOpportunitySignal[];
}

export async function getPropertyIntelligenceSummary(propertyId: number, brokerageId: number): Promise<PropertyIntelligenceSummary> {
  const [property] = await db
    .select({ id: properties.id, dataQualityStatus: properties.dataQualityStatus, lastEnrichedAt: properties.lastEnrichedAt })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new PropertyIntelligenceAccessError("Property not found");

  const [currentObservations, pendingMatches, activeSignals] = await Promise.all([
    listCurrentObservations(propertyId, brokerageId),
    listMatchesForProperty(propertyId, brokerageId, "PendingReview"),
    listSignalsForProperty(propertyId, brokerageId, "Active"),
  ]);

  return {
    propertyId,
    dataQualityStatus: property.dataQualityStatus,
    lastEnrichedAt: property.lastEnrichedAt ? property.lastEnrichedAt.toISOString() : null,
    currentObservations,
    pendingMatches,
    activeSignals,
  };
}

export interface ContactPropertyIntelligenceEntry {
  propertyId: number;
  propertyAddress: string;
  relationshipType: string;
  activeSignals: GrowOpportunitySignal[];
  // Additive: lets Contact 360's Property Intelligence section show the same
  // "match/data-quality warnings" the remediation objective asks for,
  // without a second round-trip per property.
  pendingMatches: PropertyExternalIdentifier[];
}

/**
 * One entry per property this contact has an Active growRelationships row
 * against (the same source Contact 360's own "Properties" section already
 * reads), each carrying that property's own active signals and pending
 * (unreviewed) match candidates. Never invents a relationship the contact
 * doesn't already have recorded.
 */
export async function getContactPropertyIntelligenceSummary(partyId: number, brokerageId: number): Promise<ContactPropertyIntelligenceEntry[]> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");

  const relationshipRows = await db
    .select({
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      propertyAddress: properties.formattedAddress,
    })
    .from(growRelationships)
    .innerJoin(properties, eq(growRelationships.propertyId, properties.id))
    .where(and(eq(growRelationships.partyId, partyId), eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active")));

  const activeSignals = await listActiveSignalsForParty(partyId, brokerageId);
  const signalsByProperty = new Map<number, GrowOpportunitySignal[]>();
  for (const s of activeSignals) {
    if (s.propertyId === null) continue;
    const list = signalsByProperty.get(s.propertyId) ?? [];
    list.push(s);
    signalsByProperty.set(s.propertyId, list);
  }

  const seen = new Set<number>();
  const baseEntries: Omit<ContactPropertyIntelligenceEntry, "pendingMatches">[] = [];
  for (const r of relationshipRows) {
    if (r.propertyId === null || seen.has(r.propertyId)) continue;
    seen.add(r.propertyId);
    baseEntries.push({
      propertyId: r.propertyId,
      propertyAddress: r.propertyAddress,
      relationshipType: r.relationshipType,
      activeSignals: signalsByProperty.get(r.propertyId) ?? [],
    });
  }

  // One extra tenant-scoped lookup per distinct property (never per
  // relationship row, thanks to the `seen` dedupe above) — listMatchesForProperty
  // re-asserts the property belongs to this brokerage itself, the same
  // defence-in-depth every other Property Intelligence read in this module
  // already relies on rather than trusting the join above alone.
  return Promise.all(
    baseEntries.map(async (entry) => ({
      ...entry,
      pendingMatches: await listMatchesForProperty(entry.propertyId, brokerageId, "PendingReview"),
    })),
  );
}
