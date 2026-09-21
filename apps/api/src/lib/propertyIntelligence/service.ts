import { and, eq, inArray } from "drizzle-orm";
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
  /**
   * The growRelationships.relationshipType this contact has recorded against the
   * property, or SIGNAL_ONLY_RELATIONSHIP_TYPE when there is no recorded
   * relationship at all and the property is here only because one of the
   * contact's own active signals points at it — see below.
   */
  relationshipType: string;
  activeSignals: GrowOpportunitySignal[];
  // Additive: lets Contact 360's Property Intelligence section show the same
  // "match/data-quality warnings" the remediation objective asks for,
  // without a second round-trip per property.
  pendingMatches: PropertyExternalIdentifier[];
}

/**
 * AE GROW Completion W2-B (E-4) — the relationshipType reported for a property
 * that this contact has NO Active growRelationships row against, but which one
 * of their own active signals is anchored to.
 *
 * Contact 360's panel renders this as "recorded as Signal only", which is
 * exactly what it is: AE is not claiming a relationship it has not been told
 * about, it is saying the only reason the property is listed is the signal.
 * Before this, such a signal was bucketed by propertyId and then dropped on the
 * floor, because entries were only ever emitted for properties that already had
 * an Active relationship row — the contact's own signal rendered nowhere, with
 * no notice. See this module's "no active signal for a contact is invisible
 * without explanation" rule.
 */
export const SIGNAL_ONLY_RELATIONSHIP_TYPE = "signal_only";

/**
 * One entry per property this contact has an Active growRelationships row
 * against (the same source Contact 360's own "Properties" section already
 * reads), each carrying that property's own active signals and pending
 * (unreviewed) match candidates. Never invents a relationship the contact
 * doesn't already have recorded — a property reached only via a signal is
 * reported with SIGNAL_ONLY_RELATIONSHIP_TYPE rather than a fabricated one.
 *
 * KNOWN GAP (W2-B, reported rather than fixed here): a signal whose propertyId
 * is genuinely null — anchored to the contact and nothing else, which the
 * schema explicitly allows (packages/db/src/schema/propertyIntelligence.ts:155
 * -156 has no CHECK requiring either anchor) — still has nowhere to go in this
 * response, because every entry is keyed by a real propertyId and the caller
 * (apps/web/src/components/PropertyIntelligencePanel.tsx) links each entry to
 * /properties/:id. Widening propertyId to `number | null` here without that
 * component's matching hand-mirror change would create a third instance of the
 * mirror drift this same work item exists to remove, so it is deliberately left
 * for the owner of that file. countContactAnchoredSignals below exists so that
 * gap is measurable rather than invisible.
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

  // AE GROW Completion W2-B (E-4) — a signal anchored to this contact and to a
  // property they have no Active relationship row against used to be bucketed
  // above and then silently discarded, because only relationshipRows produced
  // entries. It is now emitted as its own entry, flagged SIGNAL_ONLY so the
  // panel never presents it as a relationship the agent recorded. The address
  // lookup is re-scoped to this brokerage rather than trusting the signal row's
  // own propertyId, the same defence-in-depth every other read here uses.
  const signalOnlyPropertyIds = Array.from(signalsByProperty.keys()).filter((id) => !seen.has(id));
  if (signalOnlyPropertyIds.length > 0) {
    const signalOnlyProperties = await db
      .select({ id: properties.id, formattedAddress: properties.formattedAddress })
      .from(properties)
      .where(and(inArray(properties.id, signalOnlyPropertyIds), eq(properties.brokerageId, brokerageId)));
    for (const p of signalOnlyProperties) {
      seen.add(p.id);
      baseEntries.push({
        propertyId: p.id,
        propertyAddress: p.formattedAddress,
        relationshipType: SIGNAL_ONLY_RELATIONSHIP_TYPE,
        activeSignals: signalsByProperty.get(p.id) ?? [],
      });
    }
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

/**
 * AE GROW Completion W2-B (E-4) — how many of this contact's own active signals
 * are anchored to the contact alone, with no propertyId at all.
 *
 * getContactPropertyIntelligenceSummary cannot represent these (every entry it
 * returns is keyed by a real property — see its KNOWN GAP note), so this is the
 * honest count a caller needs to say "N signal(s) are recorded against this
 * contact directly and are not shown below", the same shape of withholding
 * notice Grow Today already gives. It exists so the gap is a measured number
 * rather than an invisible `continue`.
 */
export async function countContactAnchoredSignals(partyId: number, brokerageId: number): Promise<number> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");
  const activeSignals = await listActiveSignalsForParty(partyId, brokerageId);
  return activeSignals.filter((s) => s.propertyId === null).length;
}
