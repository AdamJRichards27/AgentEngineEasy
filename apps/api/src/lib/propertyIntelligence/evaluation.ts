import { and, eq, inArray, isNull, lte, or, sql, isNotNull, gte, asc } from "drizzle-orm";
import {
  db,
  growOpportunities,
  growRelationships,
  appraisals,
  properties,
  propertyProviderObservations,
  type PropertySignalType,
  type PropertySignalConfidenceBand,
} from "@aee/db";

/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 1 — the SET-BASED evaluation
 * core.
 *
 * This module is the single place every Property Intelligence rule is
 * expressed, and it is shared by both entry points:
 *
 *   - lib/propertyIntelligence/signals.ts's recalculateSignalsForProperty()
 *     — the single-property route (POST /property/:id/recalculate), which
 *     passes propertyIds: [thatProperty];
 *   - lib/propertyIntelligence/sweep.ts — the brokerage-wide sweep, which
 *     passes no property filter at all.
 *
 * One rule definition, two scopes: the two callers can never drift apart,
 * which is the same "one detection function per rule, one write path"
 * property lib/exceptions/engine.ts's own header argues for.
 *
 * WHY SET-BASED. The previous implementation ran, per property, one query
 * per rule plus one extra SELECT per prospective-buyer relationship, then
 * one SELECT + one UPDATE per candidate in a serial loop. A brokerage with
 * 2,000 candidates cost thousands of round trips. Every rule below is now a
 * single brokerage-scoped query returning every candidate at once, and
 * persistence.ts writes them in batched multi-row upserts — so the statement
 * count per brokerage is bounded by the number of RULES, not by the number
 * of candidates. lib/propertyIntelligence/__tests__/sweepScale.test.ts
 * asserts exactly that.
 *
 * TENANT ISOLATION. Every query here takes brokerageId as a mandatory
 * argument and filters on it. `appraisals` is the one source table with no
 * brokerage_id of its own (see packages/db/src/schema/appraisal.ts), so its
 * rule joins `properties` and filters properties.brokerageId — a stricter
 * scope than the pre-change per-property version had, never a looser one.
 *
 * NOTHING HERE CONTACTS ANYONE. These functions only read. They never write
 * a row, never publish an event, never call a provider, and never produce an
 * outbound message of any kind. A candidate is a proposal for a reviewable,
 * dismissable indicator — nothing more.
 */

/* ---------------------------------------------------------------------
 * Rule thresholds — unchanged from the pre-sweep implementation, kept here
 * because this module is now their only reader.
 * -----------------------------------------------------------------*/

const LONG_OWNERSHIP_TENURE_YEARS_EMERGING = 5;
const LONG_OWNERSHIP_TENURE_YEARS_WORTH_REVIEWING = 7;
const LONG_OWNERSHIP_TENURE_YEARS_STRONG = 10;

const STALE_APPRAISAL_OVERDUE_DAYS_EMERGING = 14;
const STALE_APPRAISAL_OVERDUE_DAYS_WORTH_REVIEWING = 30;
const STALE_APPRAISAL_OVERDUE_DAYS_STRONG = 60;

/** Observation-driven signals go stale (Expired) this many days after the observation's own sourceTimestamp. */
const OBSERVATION_SIGNAL_STALE_AFTER_DAYS = 180;
const OBSERVATION_FRESH_WITHIN_DAYS_STRONG = 30;
const OBSERVATION_FRESH_WITHIN_DAYS_WORTH_REVIEWING = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

export interface SignalCandidate {
  brokerageId: number;
  partyId: number | null;
  propertyId: number | null;
  signalType: PropertySignalType;
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
  source: string;
  sourceTimestamp: Date | null;
  confidenceBand: PropertySignalConfidenceBand;
  expiresAt: Date | null;
  dedupeKey: string;
  /** See buildEvidenceFingerprint() below — the "materially changed" input for the re-review policy. */
  evidenceFingerprint: string;
}

/**
 * DEDUPE KEY — the identity of "this kind of signal, about this subject,
 * justified by THIS specific underlying row".
 *
 * Property-anchored (the pre-existing form, deliberately byte-identical so
 * every row already in the database keeps its key):
 *     `${brokerageId}:${signalType}:${propertyId}:${sourceRowId}`
 *
 * Party-anchored (new — a contact who has no property at all can now hold a
 * signal; the literal "party" segment makes the two namespaces
 * unambiguous even if a property id and a party id ever collide):
 *     `${brokerageId}:${signalType}:party:${partyId}:${sourceRowId}`
 *
 * One unique index over dedupe_key therefore covers both anchors — see the
 * index comment in packages/db/src/schema/propertyIntelligence.ts.
 */
export function buildDedupeKey(input: {
  brokerageId: number;
  signalType: PropertySignalType;
  propertyId: number | null;
  partyId: number | null;
  sourceRowId: number | string;
}): string {
  if (input.propertyId !== null) {
    return `${input.brokerageId}:${input.signalType}:${input.propertyId}:${input.sourceRowId}`;
  }
  if (input.partyId === null) {
    // Unreachable through the rules below, which always produce at least one
    // anchor; fail loudly rather than silently minting an ambiguous key.
    throw new Error(`buildDedupeKey: a candidate must be anchored to a property or a party (signalType=${input.signalType})`);
  }
  return `${input.brokerageId}:${input.signalType}:party:${input.partyId}:${input.sourceRowId}`;
}

/**
 * EVIDENCE FINGERPRINT — the definition of "materially changed".
 *
 * The re-review policy (see lib/propertyIntelligence/signals.ts's module
 * header) only lets the sweep raise a human-decided dedupeKey again when BOTH
 * its quiet period has elapsed AND the underlying evidence has materially
 * changed. "Materially changed" is defined PER RULE INPUT, deliberately
 * narrowly, so that an agent who dismisses a signal does not get it back
 * because a clock ticked:
 *
 *   long_ownership_tenure      band only. The relationship's validFrom never
 *                              moves, so the only material development is the
 *                              tenure crossing into a higher confidence band
 *                              (5y Emerging -> 7y WorthReviewing -> 10y
 *                              StrongIndicator). A dismissed Emerging tenure
 *                              signal comes back when — and only when — it
 *                              becomes WorthReviewing, and not before its
 *                              quiet period regardless.
 *   stale_previous_appraisal   band + the reference date (followUpAt, or
 *                              outcomeAt for a DEFERRED appraisal). An agent
 *                              rescheduling the follow-up is a genuinely new
 *                              fact about this appraisal; so is the overdue
 *                              period crossing a band boundary.
 *   past_buyer_interest        band + the relationship row's own updatedAt.
 *                              This rule's band is constant, so the only
 *                              material change available is the relationship
 *                              itself being edited. (An opportunity being
 *                              created removes the candidate entirely, which
 *                              is handled by expiry, not by re-review.)
 *   observation-derived rules  band + the observation's sourceTimestamp. A
 *                              genuinely NEW observation row already produces
 *                              a NEW dedupeKey (the observation id is in the
 *                              key), so re-review here only covers the same
 *                              observation being re-banded.
 *
 * The fingerprint is stored on the row (evidence_fingerprint) and compared
 * with IS DISTINCT FROM, so a pre-existing row with a NULL fingerprint reads
 * as "changed" the first time the sweep sees it — which is correct: the
 * sweep has no evidence about what that row was decided against.
 */
function buildEvidenceFingerprint(parts: Array<string | number | null>): string {
  return parts.map((p) => (p === null ? "" : String(p))).join("|");
}

export interface EvaluationScope {
  brokerageId: number;
  /** Undefined = the whole brokerage (the sweep). A non-empty array restricts every rule to those properties (the single-property route). */
  propertyIds?: number[];
  now: Date;
  /** Hard ceiling on candidates produced for this scope. Exceeding it sets `truncated`. */
  maxCandidates: number;
}

export interface EvaluationResult {
  candidates: SignalCandidate[];
  /**
   * True when maxCandidates was reached. A truncated candidate set is NOT an
   * authoritative statement about what is currently true for this brokerage,
   * so callers must skip the "no longer supported -> Expired" pass — exactly
   * the same "absence of evidence from an incomplete pass proves nothing"
   * rule lib/exceptions/engine.ts applies to a rule that threw.
   */
  truncated: boolean;
}

/* ---------------------------------------------------------------------
 * Rule 1 — long ownership tenure (property-anchored).
 * -----------------------------------------------------------------*/

async function longOwnershipTenureCandidates(scope: EvaluationScope, limit: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const cutoff = new Date(now.getTime() - LONG_OWNERSHIP_TENURE_YEARS_EMERGING * 365 * MS_PER_DAY);

  const rows = await db
    .select({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      validFrom: growRelationships.validFrom,
    })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, ["owner", "co_owner"]),
        isNotNull(growRelationships.propertyId),
        lte(growRelationships.validFrom, cutoff),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => {
    const years = daysBetween(now, r.validFrom) / 365;
    const confidenceBand: PropertySignalConfidenceBand =
      years >= LONG_OWNERSHIP_TENURE_YEARS_STRONG ? "StrongIndicator" : years >= LONG_OWNERSHIP_TENURE_YEARS_WORTH_REVIEWING ? "WorthReviewing" : "Emerging";
    const propertyId = r.propertyId as number;
    return {
      brokerageId,
      partyId: r.partyId,
      propertyId,
      signalType: "long_ownership_tenure" as const,
      title: "Long ownership tenure",
      explanation: `This contact has been recorded as ${r.relationshipType === "co_owner" ? "a co-owner" : "the owner"} of this property for approximately ${Math.floor(years)} years. AE surfaces long ownership tenure as a pattern worth reviewing, since an owner's circumstances can change over a long tenure — this is not a prediction about this contact's plans, and AE has no information about their private intentions.`,
      evidence: { relationshipId: r.id, relationshipType: r.relationshipType, validFrom: r.validFrom.toISOString(), approximateTenureYears: Math.floor(years) },
      source: "internal",
      sourceTimestamp: r.validFrom,
      confidenceBand,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "long_ownership_tenure", propertyId, partyId: r.partyId, sourceRowId: r.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand]),
    };
  });
}

/* ---------------------------------------------------------------------
 * Rule 2 — stale appraisal follow-up (property-anchored).
 *
 * `appraisals` has no brokerage_id, so this is the one rule that reaches
 * tenant scope through a join on `properties` (see this module's header).
 * -----------------------------------------------------------------*/

async function staleAppraisalCandidates(scope: EvaluationScope, limit: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const cutoff = new Date(now.getTime() - STALE_APPRAISAL_OVERDUE_DAYS_EMERGING * MS_PER_DAY);

  const rows = await db
    .select({
      id: appraisals.id,
      propertyId: appraisals.propertyId,
      partyId: appraisals.partyId,
      status: appraisals.status,
      outcome: appraisals.outcome,
      followUpAt: appraisals.followUpAt,
      outcomeAt: appraisals.outcomeAt,
    })
    .from(appraisals)
    .innerJoin(properties, eq(appraisals.propertyId, properties.id))
    .where(
      and(
        eq(properties.brokerageId, brokerageId),
        or(
          and(eq(appraisals.status, "FOLLOW_UP"), isNotNull(appraisals.followUpAt), lte(appraisals.followUpAt, cutoff)),
          and(eq(appraisals.outcome, "DEFERRED"), isNotNull(appraisals.outcomeAt), lte(appraisals.outcomeAt, cutoff)),
        ),
        ...(scope.propertyIds ? [inArray(appraisals.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(appraisals.id))
    .limit(limit);

  const candidates: SignalCandidate[] = [];
  for (const a of rows) {
    // Same precedence the pre-sweep implementation used: an appraisal in
    // FOLLOW_UP is described by its follow-up date; otherwise (DEFERRED) by
    // its outcome date.
    let referenceDate: Date;
    let reasonPrefix: string;
    if (a.status === "FOLLOW_UP" && a.followUpAt) {
      referenceDate = a.followUpAt;
      reasonPrefix = "An appraisal follow-up on this property is overdue";
    } else if (a.outcome === "DEFERRED" && a.outcomeAt) {
      referenceDate = a.outcomeAt;
      reasonPrefix = "A deferred appraisal on this property has had no further activity";
    } else {
      continue;
    }
    const overdueDays = daysBetween(now, referenceDate);
    if (overdueDays < STALE_APPRAISAL_OVERDUE_DAYS_EMERGING) continue;
    const confidenceBand: PropertySignalConfidenceBand =
      overdueDays >= STALE_APPRAISAL_OVERDUE_DAYS_STRONG ? "StrongIndicator" : overdueDays >= STALE_APPRAISAL_OVERDUE_DAYS_WORTH_REVIEWING ? "WorthReviewing" : "Emerging";
    candidates.push({
      brokerageId,
      partyId: a.partyId ?? null,
      propertyId: a.propertyId,
      signalType: "stale_previous_appraisal",
      title: "Stale previous appraisal",
      explanation: `${reasonPrefix} (${overdueDays} days) — worth a check-in to see whether their plans have changed.`,
      evidence: { appraisalId: a.id, status: a.status, outcome: a.outcome, overdueDays },
      source: "internal",
      sourceTimestamp: referenceDate,
      confidenceBand,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "stale_previous_appraisal", propertyId: a.propertyId, partyId: a.partyId ?? null, sourceRowId: a.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "ref", referenceDate.toISOString()]),
    });
  }
  return candidates;
}

/* ---------------------------------------------------------------------
 * Rule 3 — past buyer interest with no opportunity yet.
 *
 * THE ONE CONTACT-ANCHORED RULE IN STAGE 1. The pre-sweep implementation
 * could only ever see relationships that already had a property, because it
 * was reached one property at a time. A brokerage-wide sweep sees the
 * property-LESS relationships too — packages/db/src/schema/grow.ts has
 * allowed those since Priority 0.5 precisely because prospecting starts with
 * a person, not a property — and for those the candidate is anchored on the
 * party instead.
 *
 * This is deliberately the SAME rule with the same meaning, not a new one:
 * stage 1 is the model and the engine, and new rule semantics are for a
 * later stage. What changes is only which subject the existing rule can
 * attach to. The per-candidate "does an opportunity already exist?" SELECT
 * the old implementation ran is now a single anti-join.
 * -----------------------------------------------------------------*/

async function pastBuyerInterestCandidates(scope: EvaluationScope, limit: number): Promise<SignalCandidate[]> {
  const { brokerageId } = scope;

  const rows = await db
    .select({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      validFrom: growRelationships.validFrom,
      updatedAt: growRelationships.updatedAt,
    })
    .from(growRelationships)
    .leftJoin(
      growOpportunities,
      and(
        eq(growOpportunities.brokerageId, brokerageId),
        eq(growOpportunities.partyId, growRelationships.partyId),
        // IS NOT DISTINCT FROM so a property-less relationship matches a
        // property-less opportunity for the same contact — plain `=` would
        // be NULL (never true) and every property-less contact would be
        // raised forever even after an opportunity exists for them.
        sql`${growOpportunities.propertyId} is not distinct from ${growRelationships.propertyId}`,
      ),
    )
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, ["prospective_buyer", "buyer"]),
        isNull(growOpportunities.id),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => ({
    brokerageId,
    partyId: r.partyId,
    propertyId: r.propertyId,
    signalType: "past_buyer_interest" as const,
    title: "Past buyer interest, not yet followed up",
    explanation:
      r.propertyId === null
        ? "This contact was recorded as an interested buyer, but no opportunity has been created for them yet and no property is linked to that interest."
        : "This contact was recorded as an interested buyer for this property, but no opportunity has been created for them yet.",
    evidence: { relationshipId: r.id, relationshipType: r.relationshipType },
    source: "internal",
    sourceTimestamp: r.validFrom,
    confidenceBand: "Emerging" as const,
    expiresAt: null,
    dedupeKey: buildDedupeKey({ brokerageId, signalType: "past_buyer_interest", propertyId: r.propertyId, partyId: r.partyId, sourceRowId: r.id }),
    evidenceFingerprint: buildEvidenceFingerprint(["band", "Emerging", "rel", r.updatedAt.toISOString()]),
  }));
}

/* ---------------------------------------------------------------------
 * Rules 4-8 — provider-observation-derived (property-anchored).
 * -----------------------------------------------------------------*/

const OBSERVATION_SIGNAL_MAP: Record<string, { signalType: PropertySignalType; title: string; describe: (payload: Record<string, unknown>) => string }> = {
  sales_history: {
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    describe: () => "A provider observation recorded recent sales activity relevant to this property.",
  },
  // PROPERTY_OBSERVATION_TYPES' "market_activity" shares
  // recent_nearby_sales_activity with sales_history rather than inventing a
  // 13th signal type outside the merged schema's fixed enum.
  market_activity: {
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    describe: () => "A provider observation recorded broader market activity (e.g. listing/demand trends) relevant to this property.",
  },
  planning_development: {
    signalType: "development_planning_activity",
    title: "Development or planning activity",
    describe: () => "A provider observation recorded planning or development activity near this property.",
  },
  valuation_equity: {
    signalType: "estimated_equity_band",
    title: "Estimated equity position",
    describe: () => "A provider observation recorded valuation/equity information for this property.",
  },
  mortgage_refinancing: {
    signalType: "mortgage_refinancing_indicator",
    title: "Mortgage or refinancing activity",
    describe: () => "A provider observation recorded mortgage or refinancing activity for this property.",
  },
  ownership: {
    signalType: "property_ownership_change",
    title: "Possible ownership change",
    describe: () => "A provider observation of ownership data differs from AE's own recorded owner(s) — worth reviewing, not a confirmed change.",
  },
};

const OBSERVATION_SIGNAL_TYPES = Object.keys(OBSERVATION_SIGNAL_MAP);

async function observationCandidates(scope: EvaluationScope, limit: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const staleBefore = new Date(now.getTime() - OBSERVATION_SIGNAL_STALE_AFTER_DAYS * MS_PER_DAY);

  const rows = await db
    .select({
      id: propertyProviderObservations.id,
      propertyId: propertyProviderObservations.propertyId,
      observationType: propertyProviderObservations.observationType,
      provider: propertyProviderObservations.provider,
      payload: propertyProviderObservations.payload,
      sourceTimestamp: propertyProviderObservations.sourceTimestamp,
      retrievedAt: propertyProviderObservations.retrievedAt,
    })
    .from(propertyProviderObservations)
    .where(
      and(
        eq(propertyProviderObservations.brokerageId, brokerageId),
        eq(propertyProviderObservations.isCurrent, true),
        // address_candidate has no corresponding signal type — it feeds match
        // review, not signals — so it is excluded in SQL rather than fetched
        // and discarded.
        inArray(propertyProviderObservations.observationType, OBSERVATION_SIGNAL_TYPES),
        // "too old to raise a new signal from at all" pushed into the query.
        gte(sql`coalesce(${propertyProviderObservations.sourceTimestamp}, ${propertyProviderObservations.retrievedAt})`, staleBefore),
        ...(scope.propertyIds ? [inArray(propertyProviderObservations.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(propertyProviderObservations.id))
    .limit(limit);

  return rows.map((o) => {
    const mapping = OBSERVATION_SIGNAL_MAP[o.observationType];
    const sourceTimestamp = o.sourceTimestamp ?? o.retrievedAt;
    const ageDays = daysBetween(now, sourceTimestamp);
    const confidenceBand: PropertySignalConfidenceBand =
      ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_STRONG ? "StrongIndicator" : ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_WORTH_REVIEWING ? "WorthReviewing" : "Emerging";
    return {
      brokerageId,
      partyId: null,
      propertyId: o.propertyId,
      signalType: mapping.signalType,
      title: mapping.title,
      explanation: mapping.describe((o.payload as Record<string, unknown>) ?? {}),
      evidence: { observationId: o.id, provider: o.provider, observationType: o.observationType, payload: o.payload },
      source: o.provider,
      sourceTimestamp,
      confidenceBand,
      expiresAt: addDays(sourceTimestamp, OBSERVATION_SIGNAL_STALE_AFTER_DAYS),
      dedupeKey: buildDedupeKey({ brokerageId, signalType: mapping.signalType, propertyId: o.propertyId, partyId: null, sourceRowId: o.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "ts", sourceTimestamp.toISOString()]),
    };
  });
}

/**
 * The number of statements evaluateCandidates() issues, independent of how
 * many candidates come back. Asserted by the scale test so a future rule
 * added without a set-based query is caught rather than quietly regressing
 * the sweep into N+1.
 */
export const EVALUATION_STATEMENTS_PER_SCOPE = 4;

/** Runs every rule for one scope, in parallel, and returns the combined candidate set. */
export async function evaluateCandidates(scope: EvaluationScope): Promise<EvaluationResult> {
  if (scope.propertyIds && scope.propertyIds.length === 0) return { candidates: [], truncated: false };

  // +1 so a rule that exactly fills the budget is still recognisable as
  // "there may be more", rather than silently looking complete.
  const perRuleLimit = scope.maxCandidates + 1;
  const [tenure, staleAppraisal, pastBuyer, observations] = await Promise.all([
    longOwnershipTenureCandidates(scope, perRuleLimit),
    staleAppraisalCandidates(scope, perRuleLimit),
    pastBuyerInterestCandidates(scope, perRuleLimit),
    observationCandidates(scope, perRuleLimit),
  ]);

  const all = [...tenure, ...staleAppraisal, ...pastBuyer, ...observations];
  if (all.length <= scope.maxCandidates) return { candidates: all, truncated: false };
  return { candidates: all.slice(0, scope.maxCandidates), truncated: true };
}
