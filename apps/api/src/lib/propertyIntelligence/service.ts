import { and, eq, inArray } from "drizzle-orm";
import { db, properties, parties, growRelationships, type GrowOpportunitySignal, type PropertyExternalIdentifier, type PropertyProviderObservation } from "@aee/db";
import { PropertyIntelligenceAccessError, listCurrentObservations } from "./observations.js";
import { listMatchesForProperty } from "./matches.js";
import { listSignalsForProperty, readActiveSignalsForParty, recalculateSignalsForProperty, type ContactOutreachRestriction } from "./signals.js";
import { classifySignalAnchor, type SignalAnchor } from "./evaluation.js";
import { readEvidence, type SignalObservation } from "./evidence.js";

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
  readActiveSignalsForParty,
  isOutreachRestrictedForParty,
  CONTACT_OUTREACH_RESTRICTION_NOTICE,
  CONTACT_OUTREACH_RESTRICTION_ACTION,
  reviewSignal,
  dismissSignal,
  promoteSignal,
  type ContactOutreachRestriction,
  type PartySignalRead,
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
 * AE GROW Completion W2-D — a signal that is legitimately about the PERSON,
 * with no verified property association.
 *
 * Deliberately a SEPARATE shape rather than a ContactPropertyIntelligenceEntry
 * with `propertyId: null`. That entry type is property-shaped end to end — it
 * carries an address, a relationshipType and this property's pending matches,
 * and the web panel links every one of them to /properties/:id. Widening its
 * propertyId to `number | null` would have made every one of those fields a
 * null sentinel the caller had to remember to guard, which is precisely how a
 * `/properties/null` link gets shipped. A contact-anchored signal has no
 * property, so it is not carried in a property-shaped field at all.
 *
 * NO PROPERTY ASSOCIATION IS EVER INFERRED OR SUBSTITUTED to make this
 * renderable — not the contact's other properties, not a "primary" property,
 * not a placeholder. The absence is carried explicitly, as prose, in
 * `missingPropertyAnchor`.
 */
export interface ContactAnchoredSignalEntry {
  /** Discriminant, so a caller cannot mistake this for a property entry. */
  anchor: "contact";
  signal: GrowOpportunitySignal;
  /** WHAT AE OBSERVED — the rule's own facts, each with the record it came from. Empty for a legacy row that recorded none. */
  observations: SignalObservation[];
  /** WHAT AE DOES NOT KNOW — the inputs the rule looked for and did not find, as the rule itself authored them. */
  unknowns: string[];
  /**
   * The defining unknown of this category, stated once and identically for
   * every entry rather than left to each rule to remember. Kept out of
   * `unknowns` so the rule's own list stays the rule's own list.
   */
  missingPropertyAnchor: string;
  /**
   * WHAT THE AGENT MIGHT CONSIDER DOING — contact-scoped by construction,
   * never performed by AE. Null when the rule offered none.
   *
   * W2-D: ALSO NULL, UNCONDITIONALLY, WHENEVER AN OUTREACH RESTRICTION IS IN
   * FORCE. Every one of these strings the rules author is an outreach
   * suggestion — "Consider a check-in", "Consider sending this owner the
   * comparable result", "Consider a genuine, useful reason to get back in
   * touch" (evaluation.ts:450, :706, :1325). That is a GENERATED OUTREACH
   * ACTION, and a suppressed contact must not be given one.
   *
   * Suppressed by category rather than by inspecting each string: the
   * decision is made on whether the contact may be approached, never on
   * whether a particular sentence happens to read like an approach. A rule
   * added tomorrow inherits the suppression without its author having to know
   * this rule exists. See applyOutreachRestriction() below.
   */
  agentAction: string | null;
}

/**
 * The single sentence every contact-anchored signal carries about its own
 * missing anchor.
 *
 * Phrased as a statement about AE's records, never about the world: AE does
 * not know that this person owns no property, only that it has no verified
 * association on file. Centralised so the wording cannot drift and cannot be
 * quietly dropped, the same reason NON_PREDICTION_CAVEAT is centralised.
 */
export const CONTACT_ANCHORED_MISSING_PROPERTY =
  "AE has no verified property association for this signal. It is about this person, not about a property — AE is not saying they own nothing, only that nothing is linked here.";

/**
 * AE GROW Completion W2-D — everything Contact 360 needs about this contact's
 * own active signals, split by ANCHOR rather than silently filtered down to
 * the ones that happen to have a property.
 *
 * `properties` is unchanged from W2-B, including its SIGNAL_ONLY behaviour.
 * `contactAnchoredSignals` is what `if (s.propertyId === null) continue` used
 * to throw away — which, because re_engagement_opportunity is ALWAYS
 * contact-anchored (evaluation.ts:1290), meant every re-engagement signal AE
 * raised was invisible on the contact record built to show it.
 * `unusableSignalCount` is the third category: rows AE cannot honestly
 * present as either, reported as a number rather than surfaced as if they
 * were contact-anchored.
 */
export interface ContactIntelligenceSummary {
  properties: ContactPropertyIntelligenceEntry[];
  contactAnchoredSignals: ContactAnchoredSignalEntry[];
  /**
   * Active signals for this contact that are neither property- nor
   * contact-anchored: a property-dependent rule's row that arrived without
   * the property its entire explanation is about (a data-integrity problem,
   * not intelligence about a person), or a row whose type this codebase has
   * no rule for. Counted honestly and shown as a count, never dressed up as a
   * contact-anchored signal to make the surface look fuller.
   */
  unusableSignalCount: number;
  /**
   * W2-D — non-null when this contact must not be contacted. See
   * signals.ts's ContactOutreachRestriction and the invariant block above
   * readActiveSignalsForParty().
   *
   * The signals above are returned in FULL when this is set: a DNC listing
   * restricts outreach, it does not un-happen the tenure or the enquiry, and
   * an authorised internal user keeps their own brokerage's intelligence.
   * What is withheld is the ability to ACT on it — every `agentAction` is
   * nulled (see applyOutreachRestriction), and promoteSignal() refuses.
   *
   * A client MUST render this before any signal. The API does not depend on
   * it doing so: there is no email, phone or channel affordance anywhere in
   * this response for a client to render whether it honours the field or not,
   * which is the property __tests__/contactabilityOutreachPathway.test.ts
   * asserts field by field.
   */
  outreachRestriction: ContactOutreachRestriction | null;
}

/**
 * Strips every GENERATED OUTREACH ACTION from a contact-anchored entry when
 * outreach is prohibited, leaving the intelligence itself untouched.
 *
 * The split this function draws, and it is the whole of decision gate 19 in
 * one place:
 *
 *   KEPT    title, explanation, observations, unknowns, the signal row.
 *           This is what AE OBSERVED. A DNC listing does not make it untrue,
 *           and an entitled internal user is not made safer by being blinded
 *           to it.
 *   DROPPED agentAction. This is what AE SUGGESTS THE AGENT DO, and every
 *           rule authors it as an approach to the person — "Consider a
 *           check-in", "Consider sending this owner the comparable result",
 *           "Consider a genuine, useful reason to get back in touch"
 *           (evaluation.ts:450, :706, :1325).
 *
 * Total and unconditional: no attempt is made to decide whether a particular
 * agentAction is "really" outreach. If the contact may not be approached, AE
 * offers no suggested action at all, and the restriction's own
 * recommendedAction ("Do not contact…") is what the surface shows instead.
 *
 * =====================================================================
 * IT IS DROPPED IN BOTH PLACES IT LIVES, AND THAT IS THE SUBTLE PART
 * =====================================================================
 *
 * `agentAction` appears TWICE in this response. Once as the entry's own
 * field, read out by readEvidence() — and once more inside
 * `entry.signal.evidence`, the raw jsonb column, which is returned whole
 * because the signal row is returned whole.
 *
 * Nulling only the first left the sentence sitting in
 * `contactAnchoredSignals[0].signal.evidence.agentAction`, one dereference
 * away from any client that went looking — and a client that renders
 * evidence generically WOULD find it. The field-level null looked like the
 * fix and was not; the payload still told an agent how to approach a
 * do-not-contact person.
 *
 * __tests__/contactabilityOutreachPathway.test.ts caught this by searching
 * the RAW RESPONSE TEXT for the seeded sentence rather than asserting on the
 * field, which is why that assertion is written the way it is. Do not relax
 * it to a field check.
 *
 * WHAT IS NOT REDACTED, and must not be: `observations`, `unknowns`, `rule`,
 * `schemaVersion`, `basis` — the evidence proper. Gate 19 requires signal
 * evidence and history to be PRESERVED. This removes one authored
 * suggestion from one response; it changes no stored row, and the column
 * itself is untouched in the database.
 */
function withoutAgentAction(evidence: unknown): unknown {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) return evidence;
  const { agentAction: _dropped, ...rest } = evidence as Record<string, unknown>;
  return rest;
}

function applyOutreachRestriction(
  entries: ContactAnchoredSignalEntry[],
  restriction: ContactOutreachRestriction | null,
): ContactAnchoredSignalEntry[] {
  if (!restriction) return entries;
  return entries.map((entry) => ({
    ...entry,
    agentAction: null,
    signal: { ...entry.signal, evidence: withoutAgentAction(entry.signal.evidence) },
  }));
}

/**
 * The same redaction for this contact's PROPERTY-anchored signals.
 *
 * The restriction is a property of the PERSON, not of which section of the
 * response their signal is filed under. A suppressed contact's
 * long_ownership_tenure signal carries "Consider a market update for this
 * owner" in exactly the same evidence column, and it is exactly as much a
 * suggested approach to a do-not-contact person.
 *
 * Separate from applyOutreachRestriction only because the two carry the
 * signal in differently shaped containers; they redact the same thing for
 * the same reason.
 */
function applyOutreachRestrictionToProperties(
  entries: ContactPropertyIntelligenceEntry[],
  restriction: ContactOutreachRestriction | null,
): ContactPropertyIntelligenceEntry[] {
  if (!restriction) return entries;
  return entries.map((entry) => ({
    ...entry,
    activeSignals: entry.activeSignals.map((s) => ({ ...s, evidence: withoutAgentAction(s.evidence) })),
  }));
}

/**
 * `properties`: one entry per property this contact has an Active
 * growRelationships row against (the same source Contact 360's own
 * "Properties" section already reads), each carrying that property's own
 * active signals and pending (unreviewed) match candidates. Never invents a
 * relationship the contact doesn't already have recorded — a property reached
 * only via a signal is reported with SIGNAL_ONLY_RELATIONSHIP_TYPE rather than
 * a fabricated one.
 *
 * `contactAnchoredSignals`: W2-B's KNOWN GAP, now closed. The schema declares
 * both anchors nullable with no CHECK requiring either
 * (packages/db/src/schema/propertyIntelligence.ts:155-156), and three rules
 * legitimately use that — so these rows are not malformed, they are the
 * "we know the person, we do not know the property" case. They are returned
 * in their own shape, with their evidence and their unknowns, and with no
 * property link for the caller to render.
 *
 * Which category a row falls into is decided by classifySignalAnchor(), whose
 * answer comes from the rule registry itself — not from a propertyId null
 * check at this call site, which is what made the old behaviour both wrong
 * and invisible.
 */
/**
 * THE TOTAL ORDER for Contact 360's property entries.
 *
 * Contact 360 read its entries out of an unordered query, so the same contact
 * could render the same properties in a different sequence on consecutive
 * loads. No row was lost — which is exactly what made it hard to notice, and
 * what makes it corrosive: an agent watching a list reshuffle between refreshes
 * cannot tell "the data changed" from "the data moved", so they stop trusting
 * either reading.
 *
 * THREE KEYS, AND THE LAST ONE IS WHY THIS IS A FUNCTION AND NOT AN `ORDER BY`:
 *
 *   1. RECORDED RELATIONSHIPS FIRST, signal-only entries last. Preserves the
 *      grouping this response already had — a property the agent actually
 *      recorded against the contact outranks one reached only via a signal —
 *      rather than quietly reordering the panel while fixing its stability.
 *   2. ADDRESS, so the order a human sees is the one they would expect, and so
 *      it does not silently change when an unrelated row is inserted
 *      elsewhere. Compared with localeCompare for a sane A-Z.
 *   3. propertyId, THE UNIQUE TIEBREAK. Keys 1 and 2 are both non-unique: two
 *      properties can share an address (a duplicate record, or unit entries
 *      normalising to the same string), and every entry in a group shares its
 *      group rank. Without a unique final key those ties stay free to reorder
 *      and the whole exercise achieves nothing. This is the key that makes the
 *      order TOTAL rather than merely better.
 *
 * Entries come from two sources (the relationship query and the signal-only
 * lookup) and are concatenated, so no single ORDER BY could express this; the
 * comparator is applied once to the assembled array instead.
 */
function compareContactPropertyEntries(a: ContactPropertyIntelligenceEntry, b: ContactPropertyIntelligenceEntry): number {
  const rank = (e: ContactPropertyIntelligenceEntry) => (e.relationshipType === SIGNAL_ONLY_RELATIONSHIP_TYPE ? 1 : 0);
  return rank(a) - rank(b) || a.propertyAddress.localeCompare(b.propertyAddress) || a.propertyId - b.propertyId;
}

export async function getContactPropertyIntelligenceSummary(partyId: number, brokerageId: number): Promise<ContactIntelligenceSummary> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");

  // ORDERED BY growRelationships.id, and that is load-bearing TWICE.
  //
  // 1. It fixes WHICH ROW WINS. The dedupe below keeps the FIRST row it sees
  //    per propertyId, so when a contact has two Active relationships against
  //    the same property — owner and landlord, say — the unordered query let
  //    Postgres decide which relationshipType the panel displayed, and it was
  //    free to decide differently on the next read. The same contact could be
  //    labelled "owner" on one load and "landlord" on the next. Ordering by
  //    id makes it the EARLIEST RECORDED relationship, always.
  // 2. It fixes the ENTRY ORDER for the subsequent sort's stability.
  //
  // `id` is unique, so this is a total order with no ties left to break.
  const relationshipRows = await db
    .select({
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      propertyAddress: properties.formattedAddress,
    })
    .from(growRelationships)
    .innerJoin(properties, eq(growRelationships.propertyId, properties.id))
    .where(and(eq(growRelationships.partyId, partyId), eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active")))
    .orderBy(growRelationships.id);

  // One read, three destinations. Every Active signal for this contact lands
  // in exactly one of them and none is dropped on the floor — which is the
  // whole of W2-D's correction to this function.
  //
  // The restriction arrives in the SAME value as the signals and is carried
  // into the response below. It is not looked up separately and cannot be
  // omitted by forgetting to look it up.
  const { signals: activeSignals, outreachRestriction } = await readActiveSignalsForParty(partyId, brokerageId);
  const signalsByProperty = new Map<number, GrowOpportunitySignal[]>();
  const contactAnchoredSignals: ContactAnchoredSignalEntry[] = [];
  let unusableSignalCount = 0;

  for (const s of activeSignals) {
    const anchor: SignalAnchor = classifySignalAnchor(s);
    if (anchor === "property") {
      // classifySignalAnchor only returns "property" when propertyId is
      // non-null; the assertion is for the type checker, not a runtime claim.
      const propertyId = s.propertyId as number;
      const list = signalsByProperty.get(propertyId) ?? [];
      list.push(s);
      signalsByProperty.set(propertyId, list);
      continue;
    }
    if (anchor === "contact") {
      const evidence = readEvidence(s.evidence);
      contactAnchoredSignals.push({
        anchor: "contact",
        signal: s,
        observations: evidence.observations,
        unknowns: evidence.unknowns,
        missingPropertyAnchor: CONTACT_ANCHORED_MISSING_PROPERTY,
        agentAction: evidence.agentAction,
      });
      continue;
    }
    // "unusable" — a property-dependent type with no property, or a type no
    // rule in this codebase produces. Counted, never surfaced as if AE could
    // explain it.
    unusableSignalCount += 1;
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
      .where(and(inArray(properties.id, signalOnlyPropertyIds), eq(properties.brokerageId, brokerageId)))
      .orderBy(properties.id);
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
  //
  // Its rows are sorted HERE rather than in matches.ts: that function is
  // shared with the property workspace and is not this slice's to change, but
  // an unordered nested array makes THIS response unstable just as surely as
  // an unordered outer one. Sorted by unique id, so the order is total.
  const propertyEntries = await Promise.all(
    baseEntries.map(async (entry) => ({
      ...entry,
      pendingMatches: (await listMatchesForProperty(entry.propertyId, brokerageId, "PendingReview")).slice().sort((a, b) => a.id - b.id),
    })),
  );

  propertyEntries.sort(compareContactPropertyEntries);

  // Already in signal-id order, because they were appended while walking an
  // id-ordered read. Sorted again explicitly so the guarantee belongs to THIS
  // function rather than to an ordering decision made in another file that a
  // future edit there could remove without anything here noticing.
  contactAnchoredSignals.sort((a, b) => a.signal.id - b.signal.id);

  // The restriction is applied at the LAST possible moment, on the way out,
  // so there is exactly one place to look to answer "what does a suppressed
  // contact's response actually contain?" — and so no branch above can
  // assemble an entry that skips it. BOTH signal-bearing collections go
  // through it; a signal is not less of a suggestion for having a property.
  return {
    properties: applyOutreachRestrictionToProperties(propertyEntries, outreachRestriction),
    contactAnchoredSignals: applyOutreachRestriction(contactAnchoredSignals, outreachRestriction),
    unusableSignalCount,
    outreachRestriction,
  };
}

/* =====================================================================
 * REMOVED IN W2-D: countContactAnchoredSignals()
 *
 * W2-B added it as a count of `propertyId === null` for one reason: the
 * summary could not REPRESENT such a signal, so the number existed to make
 * the gap measurable instead of invisible. It was a placeholder for a missing
 * feature, and it was honest about being one.
 *
 * It never became reachable. It had no non-test caller, and the route that
 * serves this data returned `{ properties: entries }` — there was no field
 * for the count to travel in, so no client could ever read it. The measure of
 * the gap was itself inside the gap. For a contact whose only Active signal
 * was contact-anchored, Contact 360 therefore rendered "No property
 * intelligence connected to this contact yet." — affirmatively false, with
 * the number that would have contradicted it sitting unreachable one layer
 * below.
 *
 * W2-D closes the gap the function was measuring, which retires the function.
 * `contactAnchoredSignals` now carries the signals themselves, and its
 * `.length` IS the count — reachable, on the wire, and incapable of
 * disagreeing with the list it is derived from. A separate function
 * recomputing the same number from a second read could only ever agree by
 * luck or disagree by accident.
 *
 * Deleted rather than wired into the route, because the alternative was a
 * response field duplicating an array length already beside it. The empty
 * state is fixed too: the panel's `isEmpty` now requires BOTH collections to
 * be empty, so a contact with only contact-anchored signals no longer gets
 * told there is nothing to see. Both are asserted in
 * __tests__/contactAnchoredSignals.test.ts.
 * =====================================================================*/
