import { and, eq, gt, inArray, isNull, lte, or, sql, isNotNull, gte, asc } from "drizzle-orm";
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
import { logger, incrementCounter } from "@aee/events";
import {
  boundPayload,
  buildEvidence,
  buildReason,
  describeDuration,
  formatDateAtPrecision,
  type SignalObservation,
} from "./evidence.js";

/**
 * AE GROW "Brokerage-wide Signal Sweep" — the SET-BASED evaluation core.
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
 * WHY SET-BASED. Every rule below is a single brokerage-scoped query
 * returning every candidate at once, and persistence.ts writes them in
 * batched multi-row upserts — so the statement count per brokerage is bounded
 * by the number of RULES, not by the number of candidates.
 * lib/propertyIntelligence/__tests__/sweepScale.test.ts asserts exactly that.
 *
 * TENANT ISOLATION. Every query here takes brokerageId as a mandatory
 * argument and filters on it — including each CTE inside the one rule that
 * uses raw SQL, so no intermediate result set is ever tenant-mixed and then
 * narrowed afterwards. Migration 0036 stores appraisals.brokerage_id, kept
 * equal to properties.brokerage_id. The stale-appraisal rule still joins
 * `properties` and filters properties.brokerageId. Adding `brokerage_id =`
 * on every E-9 read is still open, which is why E-9 stays partial. A
 * brokerageId always arrives from the server session; nothing here accepts
 * one from a client.
 *
 * NOTHING HERE CONTACTS ANYONE. These functions only read. They never write a
 * row, never publish an event, never call a provider, and never produce an
 * outbound message of any kind. A candidate is a proposal for a reviewable,
 * dismissable indicator — nothing more.
 *
 * =====================================================================
 * STAGE 2 — WHAT CHANGED AND WHY
 * =====================================================================
 *
 * 1. THE TENURE RULE WAS INERT, AND WORSE THAN INERT.
 *    It read growRelationships.validFrom, which is `defaultNow()` — the
 *    instant the ROW was written, not the instant the owner acquired the
 *    property. On imported data every contact looks like they bought on
 *    import day, so the rule produced nothing; on a database that had been
 *    running a while it would have produced a "tenure" that measured how long
 *    AE had known about the row. It now reads the new, explicitly observed
 *    growRelationships.ownershipStartDate and ABSTAINS where that is NULL.
 *    Abstaining is the point: "AE does not know when you bought this" is a
 *    true and useful statement, and inventing a tenure from a row timestamp
 *    is not.
 *
 * 2. CONTACTS WITH NO PROPERTY ARE NOW GENUINELY REACHABLE.
 *    Stage 1 made the dedupe key party-anchorable so a property-less contact
 *    COULD hold a signal; only past_buyer_interest could actually produce
 *    one. Three rules below are contact-first and work with or without a
 *    property: re_engagement_opportunity, agent_recorded_motivation and
 *    lease_tenancy_milestone. re_engagement_opportunity in particular is the
 *    rule that serves the stated strategy — nurturing FUTURE sellers,
 *    including contacts with no obvious current signal — because its whole
 *    input is a real recorded relationship plus a long silence.
 *
 * 3. NO RULE PRODUCES A BARE SCORE.
 *    Every candidate carries a structured evidence envelope (./evidence.ts):
 *    what was observed, which record it came from, when the fact is dated,
 *    what AE did NOT know, and what a human might choose to do — plus a
 *    plain-language explanation that stands on its own.
 *
 * WHAT THIS IS NOT. None of these rules watch "activity in an area". There is
 * no rule here that fires because something happened NEAR a property and
 * nothing else; the provider-observation rules (4-8) require an observation
 * that a provider attached to THAT property, and every other rule requires a
 * recorded relationship between a real contact and this brokerage.
 */

/* ---------------------------------------------------------------------
 * Rule thresholds. Every one is a named constant with the reasoning next to
 * it, because a threshold nobody can explain is indistinguishable from a
 * magic number.
 * -----------------------------------------------------------------*/

/** Tenure bands, in years of OBSERVED ownership (never row age). Unchanged from the pre-sweep constants. */
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

/**
 * Re-engagement dormancy bands, in days since the last recorded contact.
 *
 * DELIBERATELY MUCH LONGER THAN GROW TODAY'S "cold contact" CARD (21 days).
 * The two are different statements and must not be confused: Grow Today's
 * Rule D is a live, per-request nudge that someone has gone quiet this month.
 * This is a persisted, dismissable, evidence-backed observation that a real
 * relationship has been left alone for half a year or more — the population
 * the "future sellers with no obvious current signal" strategy is about.
 *
 * WHAT THE BAND MEANS HERE. It ranks HOW OVERDUE a conversation is, not how
 * likely anyone is to sell. A longer silence against a real recorded
 * relationship is a stronger statement about AE's own records, and that is
 * the only thing AE is entitled to be confident about.
 */
const RE_ENGAGEMENT_DORMANT_DAYS_EMERGING = 180;
const RE_ENGAGEMENT_DORMANT_DAYS_WORTH_REVIEWING = 365;
const RE_ENGAGEMENT_DORMANT_DAYS_STRONG = 730;

/**
 * Lease/tenancy milestone window around growRelationships.validTo.
 *
 * Looks a little way BACK as well as forward: a tenancy that ended three
 * weeks ago and left a landlord with an empty property is exactly as
 * conversation-worthy as one ending next month, and an agent who was away
 * should not silently miss it.
 */
const LEASE_MILESTONE_WINDOW_AHEAD_DAYS = 120;
const LEASE_MILESTONE_WINDOW_BEHIND_DAYS = 30;
const LEASE_MILESTONE_STRONG_WITHIN_DAYS = 30;
const LEASE_MILESTONE_WORTH_REVIEWING_WITHIN_DAYS = 60;
/** How long after validTo a lease milestone signal stops being a milestone at all. */
const LEASE_MILESTONE_EXPIRES_AFTER_DAYS = 30;

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
  /**
   * The value THIS RULE orders its scan by (an `id`, ascending). Internal to
   * evaluation: persistence.ts never reads it. It exists so a rule that hits
   * its budget can report exactly where it stopped, and the next run can
   * resume after that point instead of re-reading the same head of the table
   * forever. See PER-RULE BUDGETING below.
   */
  orderingKey: number;
}

/**
 * DEDUPE KEY — the identity of "this kind of signal, about this subject,
 * justified by THIS specific underlying row".
 *
 * Property-anchored (the pre-existing form, deliberately byte-identical so
 * every row already in the database keeps its key):
 *     `${brokerageId}:${signalType}:${propertyId}:${sourceRowId}`
 *
 * Party-anchored (a contact who has no property at all can hold a signal; the
 * literal "party" segment makes the two namespaces unambiguous even if a
 * property id and a party id ever collide):
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
 *   long_ownership_tenure      band + the OBSERVED ownership start date. The
 *                              band escalating (5y Emerging -> 7y
 *                              WorthReviewing -> 10y StrongIndicator) is real
 *                              news; so is the start date itself changing,
 *                              which now genuinely can happen when a provider
 *                              observation fills in a date AE did not have.
 *   stale_previous_appraisal   band + the reference date (followUpAt, or
 *                              outcomeAt for a DEFERRED appraisal). An agent
 *                              rescheduling the follow-up is a genuinely new
 *                              fact about this appraisal.
 *   past_buyer_interest        band + the relationship row's own updatedAt.
 *   agent_recorded_motivation  band + the relationship row's own updatedAt.
 *                              The band is constant, so the only material
 *                              change is the agent editing what they recorded.
 *   re_engagement_opportunity  band + the last-touch instant. NOT the
 *                              dormancy day count, which moves every single
 *                              day and would defeat the whole policy: a
 *                              dismissed re-engagement signal must come back
 *                              when the silence crosses into a new band, not
 *                              tomorrow. (A new recorded contact retires the
 *                              signal outright via the unsupported-expiry
 *                              pass, which is not a re-review at all.)
 *   lease_tenancy_milestone    band + validTo. A lease end date being moved
 *                              is new information; the date merely getting
 *                              closer within the same band is not.
 *   observation-derived rules  band + the observation's sourceTimestamp. A
 *                              genuinely NEW observation row already produces
 *                              a NEW dedupeKey (the observation id is in the
 *                              key), so re-review here only covers the same
 *                              observation being re-banded.
 *
 * THE INVARIANT EVERY RULE MUST HOLD: a fingerprint is built ONLY from values
 * that are stable while the underlying records are unchanged. Nothing derived
 * from `now` — no day counts, no ages, no "years so far" — may appear in one,
 * even though those values legitimately appear in the human-readable
 * explanation and in `evidence.basis`. __tests__/rules.test.ts asserts this
 * by sweeping twice and comparing fingerprints.
 *
 * The fingerprint is stored on the row (evidence_fingerprint) and compared
 * with IS DISTINCT FROM, so a pre-existing row with a NULL fingerprint reads
 * as "changed" the first time the sweep sees it — which is correct: the sweep
 * has no evidence about what that row was decided against.
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
  /**
   * Where each rule should RESUME from, by rule name — `{ [ruleName]: lastOrderingKey }`.
   * Absent or 0 means "start from the beginning". Supplied by the sweep from
   * the brokerage's persisted cursor; see PER-RULE BUDGETING below.
   */
  ruleCursors?: Record<string, number>;
}

/** What one rule did with the budget it was given. */
export interface RuleEvaluationReport {
  rule: string;
  /** Candidates kept from this rule. */
  produced: number;
  /** The budget it was allowed this pass. */
  budget: number;
  /** True when the rule had more to give than its budget allowed. */
  truncated: boolean;
  /** Where a continuation should resume; 0 means "start again from the beginning next run". */
  nextCursor: number;
}

export interface EvaluationResult {
  candidates: SignalCandidate[];
  /**
   * True when AT LEAST ONE rule had more candidates than its budget allowed.
   * A truncated candidate set is NOT an authoritative statement about what is
   * currently true for this brokerage, so callers must skip the "no longer
   * supported -> Expired" pass — exactly the same "absence of evidence from
   * an incomplete pass proves nothing" rule lib/exceptions/engine.ts applies
   * to a rule that threw.
   */
  truncated: boolean;
  /** Per-rule outcome, for logging, metrics and continuation. */
  ruleReports: RuleEvaluationReport[];
  /**
   * The cursors to persist and hand back on the next run, by rule name. A
   * rule that completed resets to 0 so the next run re-reads it from the top.
   */
  nextRuleCursors: Record<string, number>;
  /**
   * The signal types for which THIS PASS IS AUTHORITATIVE — every rule that
   * can produce them ran to completion within its budget. A caller may safely
   * expire unsupported signals of these types even when `truncated` is true
   * overall, because the incompleteness is in a different rule.
   *
   * (Not yet consumed: expireUnsupportedSignals is signal-type-blind today.
   * Exposed here so narrowing it is a contained change rather than a
   * re-derivation — see this stage's report.)
   */
  authoritativeSignalTypes: PropertySignalType[];
}

/* ---------------------------------------------------------------------
 * Rule 1 — long ownership tenure (property-anchored).
 *
 * INPUT: growRelationships.ownershipStartDate — an OBSERVED acquisition date
 * captured from a source that genuinely carries one (the import pipeline's
 * mapped "date acquired" column, or a provider `ownership` observation). See
 * the column's comment in packages/db/src/schema/grow.ts.
 *
 * ABSTAINS when ownershipStartDate is NULL. Not "falls back to validFrom",
 * not "assumes the median", not "guesses from the row age" — produces no
 * candidate at all, so the agent is never shown a tenure AE made up. The
 * cost of abstaining is a missing signal; the cost of guessing is an agent
 * telling a homeowner they have lived somewhere for a decade when they moved
 * in last year.
 * -----------------------------------------------------------------*/

const LONG_OWNERSHIP_TENURE_RULE_VERSION = 2;

async function longOwnershipTenureCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const cutoff = new Date(now.getTime() - LONG_OWNERSHIP_TENURE_YEARS_EMERGING * 365 * MS_PER_DAY);

  const rows = await db
    .select({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      ownershipStartDate: growRelationships.ownershipStartDate,
      ownershipStartSource: growRelationships.ownershipStartSource,
      ownershipStartPrecision: growRelationships.ownershipStartPrecision,
    })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, ["owner", "co_owner"]),
        isNotNull(growRelationships.propertyId),
        // THE ABSTENTION, expressed in SQL: a row with no observed ownership
        // start is not a candidate, full stop.
        isNotNull(growRelationships.ownershipStartDate),
        lte(growRelationships.ownershipStartDate, cutoff),
        gt(growRelationships.id, after),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => {
    const ownershipStart = r.ownershipStartDate as Date;
    const tenureDays = daysBetween(now, ownershipStart);
    const years = tenureDays / 365;
    const confidenceBand: PropertySignalConfidenceBand =
      years >= LONG_OWNERSHIP_TENURE_YEARS_STRONG
        ? "StrongIndicator"
        : years >= LONG_OWNERSHIP_TENURE_YEARS_WORTH_REVIEWING
          ? "WorthReviewing"
          : "Emerging";
    const propertyId = r.propertyId as number;
    const roleWord = r.relationshipType === "co_owner" ? "a co-owner" : "the owner";
    const startedPhrase = formatDateAtPrecision(ownershipStart, r.ownershipStartPrecision);
    const provenance =
      r.ownershipStartSource === "provider_observation"
        ? "a property-data provider's ownership record"
        : r.ownershipStartSource === "import"
          ? "your imported records"
          : "your own records";

    return {
      brokerageId,
      partyId: r.partyId,
      propertyId,
      signalType: "long_ownership_tenure" as const,
      title: "Long ownership tenure",
      explanation: buildReason({
        observed: `This contact is recorded as ${roleWord} of this property since ${startedPhrase} (${describeDuration(tenureDays)}), according to ${provenance}.`,
        whyItMatters:
          "A long tenure is one of the few durable reasons to start a conversation with a homeowner who has not asked for anything — circumstances, equity and needs all tend to move over that kind of period, and a market update is a natural reason to get in touch.",
      }),
      evidence: buildEvidence({
        rule: "long_ownership_tenure",
        ruleVersion: LONG_OWNERSHIP_TENURE_RULE_VERSION,
        observations: [
          {
            what: `Recorded as ${roleWord} of this property since ${startedPhrase}`,
            recordType: "grow_relationships",
            recordId: r.id,
            observedAt: ownershipStart.toISOString(),
            source: r.ownershipStartSource === "provider_observation" ? "provider_observation" : "internal",
            detail: {
              relationshipType: r.relationshipType,
              ownershipStartSource: r.ownershipStartSource,
              ownershipStartPrecision: r.ownershipStartPrecision,
            },
          },
        ],
        basis: {
          ownershipStartDate: ownershipStart.toISOString(),
          ownershipStartPrecision: r.ownershipStartPrecision,
          ownershipStartSource: r.ownershipStartSource,
          approximateTenureYears: Math.floor(years),
          tenureDays,
          bandThresholdsYears: {
            Emerging: LONG_OWNERSHIP_TENURE_YEARS_EMERGING,
            WorthReviewing: LONG_OWNERSHIP_TENURE_YEARS_WORTH_REVIEWING,
            StrongIndicator: LONG_OWNERSHIP_TENURE_YEARS_STRONG,
          },
        },
        unknowns:
          r.ownershipStartPrecision === "day"
            ? []
            : [`The source recorded the ownership start only to the nearest ${r.ownershipStartPrecision ?? "unknown unit"}, so the exact date is not known.`],
        agentAction: "Consider a market update or appraisal conversation, if that suits this contact.",
        legacy: {
          // Stage 1's flat keys, so existing readers are unaffected.
          relationshipId: r.id,
          relationshipType: r.relationshipType,
          ownershipStartDate: ownershipStart.toISOString(),
          approximateTenureYears: Math.floor(years),
        },
      }),
      source: "internal",
      sourceTimestamp: ownershipStart,
      confidenceBand,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "long_ownership_tenure", propertyId, partyId: r.partyId, sourceRowId: r.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "start", ownershipStart.toISOString()]),
      orderingKey: r.id,
    };
  });
}

/* ---------------------------------------------------------------------
 * Rule 2 — stale appraisal follow-up (property-anchored).
 *
 * Migration 0036 stores brokerage_id. This rule still reaches tenant scope
 * through a join on `properties` (see this module's header). E-9 reads are
 * not closed by the column alone.
 * -----------------------------------------------------------------*/

const STALE_APPRAISAL_RULE_VERSION = 2;

async function staleAppraisalCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
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
        gt(appraisals.id, after),
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
    let observedWhat: string;
    let reasonPrefix: string;
    if (a.status === "FOLLOW_UP" && a.followUpAt) {
      referenceDate = a.followUpAt;
      observedWhat = "An appraisal follow-up on this property fell due and has not been actioned";
      reasonPrefix = "An appraisal follow-up on this property has been overdue";
    } else if (a.outcome === "DEFERRED" && a.outcomeAt) {
      referenceDate = a.outcomeAt;
      observedWhat = "An appraisal on this property was deferred and nothing has been recorded since";
      reasonPrefix = "A deferred appraisal on this property has had no further activity for";
    } else {
      continue;
    }
    const overdueDays = daysBetween(now, referenceDate);
    if (overdueDays < STALE_APPRAISAL_OVERDUE_DAYS_EMERGING) continue;
    const confidenceBand: PropertySignalConfidenceBand =
      overdueDays >= STALE_APPRAISAL_OVERDUE_DAYS_STRONG
        ? "StrongIndicator"
        : overdueDays >= STALE_APPRAISAL_OVERDUE_DAYS_WORTH_REVIEWING
          ? "WorthReviewing"
          : "Emerging";
    candidates.push({
      brokerageId,
      partyId: a.partyId ?? null,
      propertyId: a.propertyId,
      signalType: "stale_previous_appraisal",
      title: "Stale previous appraisal",
      explanation: buildReason({
        observed: `${reasonPrefix} ${describeDuration(overdueDays)} (since ${formatDateAtPrecision(referenceDate, "day")}).`,
        whyItMatters:
          "Someone who went as far as an appraisal had a reason to; the reason usually outlives the appraisal. A check-in is a low-cost way to find out whether anything has changed for them.",
      }),
      evidence: buildEvidence({
        rule: "stale_previous_appraisal",
        ruleVersion: STALE_APPRAISAL_RULE_VERSION,
        observations: [
          {
            what: observedWhat,
            recordType: "appraisals",
            recordId: a.id,
            observedAt: referenceDate.toISOString(),
            source: "internal",
            detail: { status: a.status, outcome: a.outcome },
          },
        ],
        basis: {
          referenceDate: referenceDate.toISOString(),
          overdueDays,
          bandThresholdsDays: {
            Emerging: STALE_APPRAISAL_OVERDUE_DAYS_EMERGING,
            WorthReviewing: STALE_APPRAISAL_OVERDUE_DAYS_WORTH_REVIEWING,
            StrongIndicator: STALE_APPRAISAL_OVERDUE_DAYS_STRONG,
          },
        },
        unknowns:
          a.partyId === null
            ? ["This appraisal has no contact linked to it, so AE cannot tell you who to speak to."]
            : [],
        agentAction: "Consider a check-in to see whether their plans have changed.",
        legacy: { appraisalId: a.id, status: a.status, outcome: a.outcome, overdueDays },
      }),
      source: "internal",
      sourceTimestamp: referenceDate,
      confidenceBand,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "stale_previous_appraisal", propertyId: a.propertyId, partyId: a.partyId ?? null, sourceRowId: a.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "ref", referenceDate.toISOString()]),
      orderingKey: a.id,
    });
  }
  return candidates;
}

/* ---------------------------------------------------------------------
 * Rule 3 — past buyer interest with no opportunity yet.
 *
 * Property-anchored when the relationship names a property, party-anchored
 * when it does not — packages/db/src/schema/grow.ts has allowed property-less
 * relationships since Priority 0.5 precisely because prospecting starts with
 * a person, not a property.
 * -----------------------------------------------------------------*/

const PAST_BUYER_INTEREST_RULE_VERSION = 2;

async function pastBuyerInterestCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
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
        gt(growRelationships.id, after),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => {
    const observed =
      r.propertyId === null
        ? "This contact is recorded as an interested buyer, with no property linked to that interest and no opportunity created for them."
        : "This contact is recorded as an interested buyer for this property, and no opportunity has been created for them.";
    return {
      brokerageId,
      partyId: r.partyId,
      propertyId: r.propertyId,
      signalType: "past_buyer_interest" as const,
      title: "Past buyer interest, not yet followed up",
      explanation: buildReason({
        observed,
        whyItMatters:
          "Buyers become sellers. Someone who was looking is already engaged with the market and already known to this brokerage, which makes them cheaper to reach than a stranger.",
      }),
      evidence: buildEvidence({
        rule: "past_buyer_interest",
        ruleVersion: PAST_BUYER_INTEREST_RULE_VERSION,
        observations: [
          {
            what: `Recorded as ${r.relationshipType === "buyer" ? "a buyer" : "a prospective buyer"}${r.propertyId === null ? ", with no property linked" : " for this property"}`,
            recordType: "grow_relationships",
            recordId: r.id,
            observedAt: r.validFrom.toISOString(),
            source: "internal",
            detail: { relationshipType: r.relationshipType, propertyLinked: r.propertyId !== null },
          },
          {
            what: "No opportunity exists for this contact against this property",
            recordType: "grow_opportunities",
            recordId: null,
            observedAt: null,
            source: "internal",
          },
        ],
        basis: { relationshipType: r.relationshipType, relationshipRecordedAt: r.validFrom.toISOString(), openOpportunities: 0 },
        unknowns: [
          "growRelationships.validFrom records when AE learned of this interest, not necessarily when the interest began.",
        ],
        agentAction: "Consider whether this contact is worth qualifying into an opportunity.",
        legacy: { relationshipId: r.id, relationshipType: r.relationshipType },
      }),
      source: "internal",
      sourceTimestamp: r.validFrom,
      confidenceBand: "Emerging" as const,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "past_buyer_interest", propertyId: r.propertyId, partyId: r.partyId, sourceRowId: r.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", "Emerging", "rel", r.updatedAt.toISOString()]),
      orderingKey: r.id,
    };
  });
}

/* ---------------------------------------------------------------------
 * Rules 4-8 — provider-observation-derived (property-anchored).
 * -----------------------------------------------------------------*/

const OBSERVATION_RULE_VERSION = 2;

const OBSERVATION_SIGNAL_MAP: Record<
  string,
  { signalType: PropertySignalType; title: string; observed: string; whyItMatters: string; agentAction: string }
> = {
  sales_history: {
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    observed: "A property-data provider recorded recent sales activity relevant to this property.",
    whyItMatters: "Owners pay attention to what comparable homes actually sell for; a concrete local result is a natural, non-pushy reason to make contact.",
    agentAction: "Consider sending this owner the comparable result, if that suits them.",
  },
  // PROPERTY_OBSERVATION_TYPES' "market_activity" shares
  // recent_nearby_sales_activity with sales_history rather than inventing a
  // 13th signal type outside the merged schema's fixed enum.
  market_activity: {
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    observed: "A property-data provider recorded broader market activity (for example listing or demand trends) relevant to this property.",
    whyItMatters: "A moving local market is context an owner rarely has, and supplying it is a reason to talk that does not depend on them being ready to sell.",
    agentAction: "Consider a market update for this owner.",
  },
  planning_development: {
    signalType: "development_planning_activity",
    title: "Development or planning activity",
    observed: "A property-data provider recorded planning or development activity near this property.",
    whyItMatters: "Planning changes affect how an owner feels about staying, and they are the kind of thing owners want explained by someone they trust.",
    agentAction: "Consider whether this owner would value an explanation of what the activity means for them.",
  },
  valuation_equity: {
    signalType: "estimated_equity_band",
    title: "Estimated equity position",
    observed: "A property-data provider recorded valuation or equity information for this property.",
    whyItMatters: "An equity position an owner has not looked at in years is often the thing that makes a move feel possible.",
    agentAction: "Consider a conversation about what their position currently looks like.",
  },
  mortgage_refinancing: {
    signalType: "mortgage_refinancing_indicator",
    title: "Mortgage or refinancing activity",
    observed: "A property-data provider recorded mortgage or refinancing activity for this property.",
    whyItMatters: "Refinancing means the owner is already reconsidering their finances, which is often when moving is on the table too.",
    agentAction: "Consider a light-touch check-in.",
  },
  ownership: {
    signalType: "property_ownership_change",
    title: "Possible ownership change",
    observed: "A property-data provider's ownership record differs from the owner AE has recorded for this property.",
    whyItMatters: "Either AE's records are out of date or the property has changed hands. Both are worth knowing before anyone makes contact.",
    agentAction: "Review the ownership record and correct whichever side is wrong. This is a data-quality check, not a confirmed sale.",
  },
};

const OBSERVATION_SIGNAL_TYPES = Object.keys(OBSERVATION_SIGNAL_MAP);

async function observationCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
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
        gt(propertyProviderObservations.id, after),
        ...(scope.propertyIds ? [inArray(propertyProviderObservations.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(propertyProviderObservations.id))
    .limit(limit);

  return rows.map((o) => {
    const mapping = OBSERVATION_SIGNAL_MAP[o.observationType];
    const sourceTimestamp = o.sourceTimestamp ?? o.retrievedAt;
    const datedByProvider = o.sourceTimestamp !== null;
    // The provider payload is externally controlled and unbounded in the
    // schema. Bound it before it enters evidence (and therefore the heap, and
    // therefore grow_opportunity_signals.evidence); the complete value stays
    // on the observation row, which `fullValueAt` points at. No observation
    // rule fingerprints the payload, so this cannot churn a fingerprint.
    const payload = boundPayload(o.payload, { recordType: "property_provider_observations", recordId: o.id, column: "payload" });
    const ageDays = daysBetween(now, sourceTimestamp);
    const confidenceBand: PropertySignalConfidenceBand =
      ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_STRONG
        ? "StrongIndicator"
        : ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_WORTH_REVIEWING
          ? "WorthReviewing"
          : "Emerging";
    return {
      brokerageId,
      partyId: null,
      propertyId: o.propertyId,
      signalType: mapping.signalType,
      title: mapping.title,
      explanation: buildReason({
        observed: `${mapping.observed} It is dated ${formatDateAtPrecision(sourceTimestamp, "day")} (${describeDuration(ageDays)} ago).`,
        whyItMatters: mapping.whyItMatters,
      }),
      evidence: buildEvidence({
        rule: mapping.signalType,
        ruleVersion: OBSERVATION_RULE_VERSION,
        observations: [
          {
            what: mapping.observed,
            recordType: "property_provider_observations",
            recordId: o.id,
            observedAt: sourceTimestamp.toISOString(),
            source: o.provider,
            detail: { observationType: o.observationType, payload: payload.payload },
          },
        ],
        basis: {
          observationType: o.observationType,
          provider: o.provider,
          sourceTimestamp: sourceTimestamp.toISOString(),
          ageDays,
          payloadBounded: payload.bounded,
          payloadOmittedKeys: payload.omittedKeys,
          payloadOriginalBytes: payload.originalBytes,
          fullPayloadAt: payload.fullValueAt,
          bandThresholdsDays: {
            StrongIndicator: OBSERVATION_FRESH_WITHIN_DAYS_STRONG,
            WorthReviewing: OBSERVATION_FRESH_WITHIN_DAYS_WORTH_REVIEWING,
          },
          staleAfterDays: OBSERVATION_SIGNAL_STALE_AFTER_DAYS,
        },
        unknowns: [
          ...(datedByProvider
            ? []
            : ["The provider did not date this observation, so AE is using the time it was retrieved instead."]),
          "This observation has no contact attached to it — it describes the property, not a person.",
          ...(payload.bounded
            ? [`The provider's payload was too large to store whole on this signal; the complete version is on property_provider_observations row ${o.id}.`]
            : []),
        ],
        agentAction: mapping.agentAction,
        legacy: { observationId: o.id, provider: o.provider, observationType: o.observationType, payload: payload.payload },
      }),
      source: o.provider,
      sourceTimestamp,
      confidenceBand,
      expiresAt: addDays(sourceTimestamp, OBSERVATION_SIGNAL_STALE_AFTER_DAYS),
      dedupeKey: buildDedupeKey({ brokerageId, signalType: mapping.signalType, propertyId: o.propertyId, partyId: null, sourceRowId: o.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "ts", sourceTimestamp.toISOString()]),
      orderingKey: o.id,
    };
  });
}

/* ---------------------------------------------------------------------
 * Rule 9 — agent-recorded motivation (contact-anchored; property optional).
 *
 * THE LEAST INFERENTIAL RULE IN THE FILE. It surfaces something a HUMAN
 * explicitly typed: this contact was recorded as a prospective seller. AE
 * adds exactly one observation of its own — that nobody has opened an
 * opportunity for them — and stops. There is no scoring, no proxy, and
 * nothing derived.
 *
 * The band is constant (StrongIndicator) for the same reason: an agent's own
 * recorded judgement is the strongest evidence this system has access to, and
 * grading it by age would be AE second-guessing a person.
 *
 * Property-anchored when the relationship names a property, party-anchored
 * when it does not — so a prospective seller with no property in AE yet is
 * fully covered.
 * -----------------------------------------------------------------*/

const AGENT_RECORDED_MOTIVATION_RULE_VERSION = 1;

/** The relationship types that mean "a person at this brokerage recorded an intention to sell". */
const AGENT_RECORDED_MOTIVATION_TYPES = ["prospective_seller"] as const;

async function agentRecordedMotivationCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
  const { brokerageId } = scope;

  const rows = await db
    .select({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      role: growRelationships.role,
      sourceType: growRelationships.sourceType,
      sourceEvidence: growRelationships.sourceEvidence,
      validFrom: growRelationships.validFrom,
      updatedAt: growRelationships.updatedAt,
    })
    .from(growRelationships)
    .leftJoin(
      growOpportunities,
      and(
        eq(growOpportunities.brokerageId, brokerageId),
        eq(growOpportunities.partyId, growRelationships.partyId),
        eq(growOpportunities.status, "Open"),
      ),
    )
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, [...AGENT_RECORDED_MOTIVATION_TYPES]),
        // Nobody is already working this contact. An open opportunity means
        // an agent has it in hand, and re-surfacing it as a "signal" would be
        // noise about work already under way.
        isNull(growOpportunities.id),
        gt(growRelationships.id, after),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => {
    const recordedOn = formatDateAtPrecision(r.validFrom, "day");
    const propertyClause = r.propertyId === null ? "no property is linked to it yet" : "it is linked to this property";
    return {
      brokerageId,
      partyId: r.partyId,
      propertyId: r.propertyId,
      signalType: "agent_recorded_motivation" as const,
      title: "Recorded as a prospective seller, with nothing in the pipeline",
      explanation: buildReason({
        observed: `Someone at this brokerage recorded this contact as a prospective seller on ${recordedOn}${r.role ? ` (${r.role})` : ""}, and ${propertyClause}. There is no open opportunity tracking them.`,
        whyItMatters:
          "This is your own team's judgement, not an inference by AE — and right now nothing is carrying it forward. It is the cheapest possible lead to act on because the qualifying has already been done.",
      }),
      evidence: buildEvidence({
        rule: "agent_recorded_motivation",
        ruleVersion: AGENT_RECORDED_MOTIVATION_RULE_VERSION,
        observations: [
          {
            what: "Recorded as a prospective seller by someone at this brokerage",
            recordType: "grow_relationships",
            recordId: r.id,
            observedAt: r.validFrom.toISOString(),
            source: "internal",
            detail: { relationshipType: r.relationshipType, role: r.role, sourceType: r.sourceType, sourceEvidence: r.sourceEvidence },
          },
          {
            what: "No open opportunity exists for this contact",
            recordType: "grow_opportunities",
            recordId: null,
            observedAt: null,
            source: "internal",
          },
        ],
        basis: { relationshipType: r.relationshipType, recordedAt: r.validFrom.toISOString(), openOpportunities: 0, propertyLinked: r.propertyId !== null },
        unknowns: [
          "AE does not know what was said at the time — only that the relationship was recorded.",
          ...(r.propertyId === null ? ["No property is linked to this contact, so AE cannot say which home this is about."] : []),
        ],
        agentAction: "Consider opening an opportunity, or closing the loop if it is no longer live.",
        legacy: { relationshipId: r.id, relationshipType: r.relationshipType, role: r.role },
      }),
      source: "internal",
      sourceTimestamp: r.validFrom,
      confidenceBand: "StrongIndicator" as const,
      expiresAt: null,
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "agent_recorded_motivation", propertyId: r.propertyId, partyId: r.partyId, sourceRowId: r.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", "StrongIndicator", "rel", r.updatedAt.toISOString()]),
      orderingKey: r.id,
    };
  });
}

/* ---------------------------------------------------------------------
 * Rule 10 — lease / tenancy milestone (contact-anchored; property optional).
 *
 * A tenant or landlord relationship whose validTo — an END DATE someone
 * actually recorded — falls in a narrow window around today.
 *
 * ABSTAINS when validTo is NULL, which is the overwhelming majority of rows:
 * an open-ended relationship has no milestone, and AE does not invent one.
 * The rule is therefore silent on a tenant that does not record lease end
 * dates, which is the honest outcome rather than a fabricated one.
 * -----------------------------------------------------------------*/

const LEASE_TENANCY_MILESTONE_RULE_VERSION = 1;

async function leaseTenancyMilestoneCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const windowStart = new Date(now.getTime() - LEASE_MILESTONE_WINDOW_BEHIND_DAYS * MS_PER_DAY);
  const windowEnd = new Date(now.getTime() + LEASE_MILESTONE_WINDOW_AHEAD_DAYS * MS_PER_DAY);

  const rows = await db
    .select({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      validTo: growRelationships.validTo,
      updatedAt: growRelationships.updatedAt,
    })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        inArray(growRelationships.relationshipType, ["tenant", "landlord"]),
        // THE ABSTENTION: no recorded end date, no milestone.
        isNotNull(growRelationships.validTo),
        gte(growRelationships.validTo, windowStart),
        lte(growRelationships.validTo, windowEnd),
        gt(growRelationships.id, after),
        ...(scope.propertyIds ? [inArray(growRelationships.propertyId, scope.propertyIds)] : []),
      ),
    )
    .orderBy(asc(growRelationships.id))
    .limit(limit);

  return rows.map((r) => {
    const validTo = r.validTo as Date;
    const daysAway = Math.abs(daysBetween(validTo, now));
    const hasPassed = validTo.getTime() < now.getTime();
    const confidenceBand: PropertySignalConfidenceBand =
      daysAway <= LEASE_MILESTONE_STRONG_WITHIN_DAYS
        ? "StrongIndicator"
        : daysAway <= LEASE_MILESTONE_WORTH_REVIEWING_WITHIN_DAYS
          ? "WorthReviewing"
          : "Emerging";
    const partyWord = r.relationshipType === "landlord" ? "landlord" : "tenant";
    const whenPhrase = hasPassed
      ? `ended on ${formatDateAtPrecision(validTo, "day")} (${describeDuration(daysAway)} ago)`
      : `is recorded as ending on ${formatDateAtPrecision(validTo, "day")} (in ${describeDuration(daysAway)})`;

    return {
      brokerageId,
      partyId: r.partyId,
      propertyId: r.propertyId,
      signalType: "lease_tenancy_milestone" as const,
      title: "Lease or tenancy milestone approaching",
      explanation: buildReason({
        observed: `This contact's recorded ${partyWord} relationship ${whenPhrase}.`,
        whyItMatters:
          r.relationshipType === "landlord"
            ? "The end of a tenancy is one of the few moments an investor genuinely reconsiders whether to keep holding the property — re-let, renovate, or sell."
            : "A tenancy ending is a moment when someone is already thinking about where they live next, and a renter today is frequently a buyer later.",
      }),
      evidence: buildEvidence({
        rule: "lease_tenancy_milestone",
        ruleVersion: LEASE_TENANCY_MILESTONE_RULE_VERSION,
        observations: [
          {
            what: `Recorded ${partyWord} relationship with an end date of ${formatDateAtPrecision(validTo, "day")}`,
            recordType: "grow_relationships",
            recordId: r.id,
            observedAt: validTo.toISOString(),
            source: "internal",
            detail: { relationshipType: r.relationshipType, hasPassed },
          },
        ],
        basis: {
          validTo: validTo.toISOString(),
          daysFromToday: daysAway,
          hasPassed,
          windowDays: { behind: LEASE_MILESTONE_WINDOW_BEHIND_DAYS, ahead: LEASE_MILESTONE_WINDOW_AHEAD_DAYS },
          bandThresholdsDays: {
            StrongIndicator: LEASE_MILESTONE_STRONG_WITHIN_DAYS,
            WorthReviewing: LEASE_MILESTONE_WORTH_REVIEWING_WITHIN_DAYS,
          },
        },
        unknowns: [
          "AE only knows the end date that was recorded on the relationship; it does not know whether the lease has since been renewed elsewhere.",
          ...(r.propertyId === null ? ["No property is linked to this relationship."] : []),
        ],
        agentAction: "Consider asking what they plan to do next.",
        legacy: { relationshipId: r.id, relationshipType: r.relationshipType, validTo: validTo.toISOString() },
      }),
      source: "internal",
      sourceTimestamp: validTo,
      confidenceBand,
      // A milestone stops being a milestone once it is well behind us. This
      // is the rule whose signals genuinely age out on their own.
      expiresAt: addDays(validTo, LEASE_MILESTONE_EXPIRES_AFTER_DAYS),
      dedupeKey: buildDedupeKey({ brokerageId, signalType: "lease_tenancy_milestone", propertyId: r.propertyId, partyId: r.partyId, sourceRowId: r.id }),
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "validTo", validTo.toISOString()]),
      orderingKey: r.id,
    };
  });
}

/* ---------------------------------------------------------------------
 * Rule 11 — re-engagement opportunity (CONTACT-ANCHORED, always).
 *
 * THE RULE THE STRATEGY IS ACTUALLY ABOUT.
 *
 * Every other rule needs something to have HAPPENED. This one is for the
 * contacts where nothing has happened and nothing is going to happen unless
 * someone decides to make it happen — the people a brokerage already knows,
 * already has permission to contact, and has quietly stopped talking to. That
 * population is where future sellers come from, and no "current signal" will
 * ever surface them.
 *
 * INPUTS, all of them real records:
 *   - the contact has a genuine recorded connection: at least one Active
 *     growRelationships row, or at least one growContactRoles row. A bare
 *     `parties` row with nothing attached is NOT a relationship and is not
 *     raised — that would be "every row in the database", which is the
 *     opposite of prioritisation.
 *   - nobody is already on it: no Open growOpportunities AND no Open
 *     growCommitments for this contact. A commitment is an agent's own
 *     "I will call them next month"; re-raising it as a signal would be AE
 *     nagging about a promise already made.
 *   - the silence: the last recorded grow_activities.occurredAt for this
 *     contact — or, where there has never been one, the date the contact
 *     record itself was created — is at least
 *     RE_ENGAGEMENT_DORMANT_DAYS_EMERGING ago.
 *
 * WHY "OR THE CONTACT'S CREATION DATE" MATTERS BOTH WAYS. It means a contact
 * imported three years ago and never once contacted IS surfaced (correct —
 * that is the archetype). It also means a contact imported this morning is
 * NOT surfaced (also correct — an import is not a period of neglect), which
 * is what stops this rule from firing on an entire freshly imported database
 * the moment it lands.
 *
 * THIS RULE IS ALWAYS PARTY-ANCHORED AND NEVER CARRIES A propertyId, even
 * when the contact owns properties, because the subject genuinely is the
 * person. Their properties appear in the evidence instead.
 *
 * NOT PROPERTY-SCOPABLE. It is skipped entirely when the caller passes
 * propertyIds (the single-property recalculate route), because "recalculate
 * this property" must never mint brokerage-wide contact signals as a side
 * effect. Only the sweep runs it.
 * -----------------------------------------------------------------*/

const RE_ENGAGEMENT_RULE_VERSION = 1;

interface ReEngagementRow extends Record<string, unknown> {
  party_id: number;
  party_created_at: Date;
  active_relationships: number;
  active_relationship_types: string[] | null;
  active_property_ids: number[] | null;
  first_relationship_created_at: Date | null;
  last_activity_at: Date | null;
  last_activity_id: number | null;
  last_activity_type: string | null;
  activity_count: number;
  role_count: number;
  roles: string[] | null;
  last_touch_at: Date;
}

async function reEngagementCandidates(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]> {
  const { brokerageId, now } = scope;
  const cutoff = new Date(now.getTime() - RE_ENGAGEMENT_DORMANT_DAYS_EMERGING * MS_PER_DAY);

  // ONE statement. Every CTE carries `brokerage_id = $1` itself, so no
  // intermediate set is ever tenant-mixed; the outer query re-asserts it on
  // `parties`. `limit` is a number this module computed, never client input.
  const result = await db.execute<ReEngagementRow>(sql`
    with rel as (
      select party_id,
             count(*) filter (where status = 'Active')::int as active_relationships,
             array_remove(array_agg(distinct relationship_type) filter (where status = 'Active'), null) as active_relationship_types,
             array_remove(array_agg(distinct property_id) filter (where status = 'Active'), null) as active_property_ids,
             min(created_at) as first_relationship_created_at
      from grow_relationships
      where brokerage_id = ${brokerageId}
      group by party_id
    ),
    act as (
      select party_id,
             max(occurred_at) as last_activity_at,
             count(*)::int as activity_count,
             (array_agg(id order by occurred_at desc, id desc))[1] as last_activity_id,
             (array_agg(activity_type order by occurred_at desc, id desc))[1] as last_activity_type
      from grow_activities
      where brokerage_id = ${brokerageId} and party_id is not null
      group by party_id
    ),
    opp as (
      select party_id, count(*) filter (where status = 'Open')::int as open_opportunities
      from grow_opportunities
      where brokerage_id = ${brokerageId}
      group by party_id
    ),
    com as (
      select party_id, count(*) filter (where status = 'Open')::int as open_commitments
      from grow_commitments
      where brokerage_id = ${brokerageId}
      group by party_id
    ),
    rol as (
      select party_id, count(*)::int as role_count, array_agg(role order by role) as roles
      from grow_contact_roles
      where brokerage_id = ${brokerageId}
      group by party_id
    )
    select
      p.id as party_id,
      p.created_at as party_created_at,
      coalesce(rel.active_relationships, 0) as active_relationships,
      rel.active_relationship_types,
      rel.active_property_ids,
      rel.first_relationship_created_at,
      act.last_activity_at,
      act.last_activity_id,
      act.last_activity_type,
      coalesce(act.activity_count, 0) as activity_count,
      coalesce(rol.role_count, 0) as role_count,
      rol.roles,
      coalesce(act.last_activity_at, p.created_at) as last_touch_at
    from parties p
    left join rel on rel.party_id = p.id
    left join act on act.party_id = p.id
    left join opp on opp.party_id = p.id
    left join com on com.party_id = p.id
    left join rol on rol.party_id = p.id
    where p.brokerage_id = ${brokerageId}
      and p.id > ${after}
      and (coalesce(rel.active_relationships, 0) > 0 or coalesce(rol.role_count, 0) > 0)
      and coalesce(opp.open_opportunities, 0) = 0
      and coalesce(com.open_commitments, 0) = 0
      and coalesce(act.last_activity_at, p.created_at) <= ${cutoff.toISOString()}
    order by p.id
    limit ${limit}
  `);

  return (result.rows as ReEngagementRow[]).map((r) => {
    const lastTouchAt = new Date(r.last_touch_at);
    const dormantDays = daysBetween(now, lastTouchAt);
    const everContacted = r.last_activity_at !== null;
    const confidenceBand: PropertySignalConfidenceBand =
      dormantDays >= RE_ENGAGEMENT_DORMANT_DAYS_STRONG
        ? "StrongIndicator"
        : dormantDays >= RE_ENGAGEMENT_DORMANT_DAYS_WORTH_REVIEWING
          ? "WorthReviewing"
          : "Emerging";

    const relationshipTypes = r.active_relationship_types ?? [];
    const roles = r.roles ?? [];
    const propertyIds = r.active_property_ids ?? [];

    const connectionPhrase =
      relationshipTypes.length > 0
        ? `recorded in your database as ${relationshipTypes.map((t) => t.replace(/_/g, " ")).join(", ")}`
        : `recorded in your database with the role${roles.length === 1 ? "" : "s"} ${roles.join(", ")}`;

    const observations: SignalObservation[] = [
      everContacted
        ? {
            what: `The most recent contact of any kind recorded with this person was ${describeDuration(dormantDays)} ago`,
            recordType: "grow_activities",
            recordId: r.last_activity_id,
            observedAt: lastTouchAt.toISOString(),
            source: "internal",
            detail: { activityType: r.last_activity_type, totalRecordedActivities: r.activity_count },
          }
        : {
            what: "No contact of any kind has ever been recorded with this person",
            recordType: "parties",
            recordId: r.party_id,
            observedAt: lastTouchAt.toISOString(),
            source: "internal",
            detail: { contactRecordCreatedAt: new Date(r.party_created_at).toISOString(), totalRecordedActivities: 0 },
          },
      {
        what: `This person is ${connectionPhrase}`,
        recordType: relationshipTypes.length > 0 ? "grow_relationships" : "grow_contact_roles",
        recordId: null,
        observedAt: r.first_relationship_created_at ? new Date(r.first_relationship_created_at).toISOString() : null,
        source: "internal",
        detail: { activeRelationshipTypes: relationshipTypes, roles, activeRelationshipCount: r.active_relationships, linkedPropertyIds: propertyIds },
      },
      {
        what: "No open opportunity and no open commitment exists for this person, so nobody is currently working on them",
        recordType: "grow_opportunities",
        recordId: null,
        observedAt: null,
        source: "internal",
      },
    ];

    return {
      brokerageId,
      partyId: r.party_id,
      // Always null: the subject of this signal is the PERSON. Their
      // properties, if any, are in the evidence.
      propertyId: null,
      signalType: "re_engagement_opportunity" as const,
      title: everContacted ? "Long-dormant contact worth re-engaging" : "Known contact who has never been contacted",
      explanation: buildReason({
        observed: everContacted
          ? `This person is ${connectionPhrase}, and the last contact of any kind recorded with them was ${describeDuration(dormantDays)} ago (${formatDateAtPrecision(lastTouchAt, "day")}). Nobody currently has an open opportunity or an open commitment for them.`
          : `This person is ${connectionPhrase} and has been in your database since ${formatDateAtPrecision(lastTouchAt, "day")}, but no contact of any kind has ever been recorded with them. Nobody currently has an open opportunity or an open commitment for them.`,
        whyItMatters:
          "Most future sellers give no warning. What they do have is an existing relationship with a brokerage that has gone quiet — which is something you can fix today, unlike their timing, which you cannot.",
      }),
      evidence: buildEvidence({
        rule: "re_engagement_opportunity",
        ruleVersion: RE_ENGAGEMENT_RULE_VERSION,
        observations,
        basis: {
          lastTouchAt: lastTouchAt.toISOString(),
          lastTouchBasis: everContacted ? "last_recorded_activity" : "contact_record_created_at",
          dormantDays,
          activeRelationshipCount: r.active_relationships,
          activeRelationshipTypes: relationshipTypes,
          roles,
          linkedPropertyIds: propertyIds,
          recordedActivityCount: r.activity_count,
          bandThresholdsDays: {
            Emerging: RE_ENGAGEMENT_DORMANT_DAYS_EMERGING,
            WorthReviewing: RE_ENGAGEMENT_DORMANT_DAYS_WORTH_REVIEWING,
            StrongIndicator: RE_ENGAGEMENT_DORMANT_DAYS_STRONG,
          },
          bandMeaning: "How overdue a conversation is, based on AE's own records. Not a likelihood that this person will sell.",
        },
        unknowns: [
          "AE only knows about contact that was RECORDED in Grow. A call or conversation nobody logged is invisible to it.",
          ...(everContacted ? [] : ["AE has no record of any contact before this person's record was created, including anything that happened before they were imported."]),
          ...(propertyIds.length === 0 ? ["No property is linked to this contact."] : []),
        ],
        agentAction: "Consider a genuine, useful reason to get back in touch.",
        legacy: { partyId: r.party_id, dormantDays, lastActivityAt: r.last_activity_at ? new Date(r.last_activity_at).toISOString() : null },
      }),
      source: "internal",
      sourceTimestamp: lastTouchAt,
      // No expiry date: this signal stops being true when someone makes
      // contact, and the sweep's "no longer supported" pass is what retires
      // it. A time-based expiry would retire it while it was still true.
      expiresAt: null,
      confidenceBand,
      dedupeKey: buildDedupeKey({
        brokerageId,
        signalType: "re_engagement_opportunity",
        propertyId: null,
        partyId: r.party_id,
        // A literal, not a row id: there is exactly one re-engagement signal
        // per contact, because the subject IS the contact.
        sourceRowId: "contact",
      }),
      // NOT dormantDays — see buildEvidenceFingerprint()'s contract. This
      // fingerprint is stable for as long as nothing actually happens.
      evidenceFingerprint: buildEvidenceFingerprint(["band", confidenceBand, "touch", lastTouchAt.toISOString()]),
      orderingKey: r.party_id,
    };
  });
}

/* =====================================================================
 * THE RULE REGISTRY, AND PER-RULE BUDGETING.
 *
 * =====================================================================
 * THE BUG THIS REPLACES (stage 1)
 * =====================================================================
 * Stage 1 ran every rule with `limit(maxCandidates + 1)`, concatenated the
 * results in a FIXED ORDER, and then cut the combined list with
 * `slice(0, maxCandidates)`. Each rule also scanned `order by id asc`.
 *
 * The consequence was not "some candidates are dropped". It was: for any
 * brokerage whose FIRST rule alone exceeds the cap, every later rule's output
 * is discarded in full, on every run, permanently — those signal types simply
 * never exist for that tenant, silently and with no error. 5,000 is not a
 * large number of owner relationships for a real brokerage, so this was
 * reachable in production, and every rule added to the list made it worse.
 *
 * It compounded: `truncated` also suppresses the sweep's "no longer supported
 * -> Expired" pass, so a permanently-over-cap tenant would also accumulate
 * unsupported Active signals forever — precisely the staleness this whole
 * feature exists to remove.
 *
 * =====================================================================
 * WHAT HAPPENS NOW
 * =====================================================================
 *
 * 1. EVERY RULE GETS A FAIR SHARE, ALWAYS. The rules run SEQUENTIALLY
 *    against a shared, decrementing budget. Before each rule, its allowance
 *    is recomputed as `remainingBudget / rulesStillToRun`, so:
 *      - no rule can consume another rule's share, however much data it has;
 *      - a rule that needs less than its share leaves the remainder to the
 *        others (classic water-filling), so the cap is not wasted;
 *      - the order rules appear in below stops mattering for whether a rule
 *        produces anything at all.
 *    Starvation is therefore gone outright, not merely made less likely.
 *
 * 2. TRUNCATION IS A PAUSE, NOT A CLIFF. Every rule scans by ascending id and
 *    accepts a resume point. A rule that fills its allowance reports the id
 *    it stopped at; the next run resumes AFTER it, and wraps back to the
 *    beginning once it runs out. A large brokerage therefore works through
 *    its whole population across consecutive runs instead of re-reading the
 *    same head of the table forever. Persisting the cursors is the caller's
 *    job (sweep.ts) — `nextRuleCursors` in / `ruleCursors` out.
 *
 * 3. TRUNCATION IS VISIBLE. Stage 1 recorded it only as a boolean on the run
 *    row. Each truncating rule now emits a counter and a log line naming the
 *    rule, the brokerage and the resume point.
 *
 * 4. PEAK MEMORY IS BOUNDED BY THE CAP, NOT BY CAP x RULES. Sequential
 *    execution means one rule's result set is live at a time and the
 *    accumulator never exceeds `maxCandidates`; stage 1's `Promise.all` held
 *    up to `rules x (maxCandidates + 1)` candidate objects simultaneously and
 *    then allocated another full copy in the spread. Combined with bounding
 *    the provider payload (see boundPayload() in ./evidence.ts), the worst
 *    case is now a documented, finite number rather than "however much jsonb
 *    a provider sent us".
 *
 * THE COST. Sequential execution trades a little wall-clock latency for the
 * memory bound and the fair-share guarantee. The statement count is
 * unchanged — it is still exactly one per rule — and the sweep is a
 * background job on a 30-minute timer, so latency is the cheapest thing here
 * to spend.
 * =====================================================================*/

interface RuleDefinition {
  name: string;
  /** Every signal type this rule can emit. Used to report which types this pass is authoritative for. */
  signalTypes: PropertySignalType[];
  /**
   * False for a rule that must NOT run when the caller scopes to specific
   * properties, because its subject is a contact rather than a property and
   * running it would mint brokerage-wide signals as a side effect of
   * recalculating one property.
   */
  propertyScopable: boolean;
  /**
   * AE GROW Completion W2-D — whether this rule may legitimately emit a
   * candidate with `propertyId: null`.
   *
   * Distinct from `propertyScopable`, and the two are NOT the same question:
   *
   *   propertyScopable  — "may this rule RUN when the caller scoped the pass
   *                        to specific properties?"
   *   contactAnchorable — "is a result from this rule still MEANINGFUL when it
   *                        has no property anchor at all?"
   *
   * re_engagement_opportunity is false/true: it must not run property-scoped
   * AND its subject is always the person. past_buyer_interest and
   * agent_recorded_motivation are true/true: they run property-scoped, and
   * they pass their source relationship's own propertyId straight through —
   * which grow_relationships declares nullable, so a genuine
   * "we know the person, we do not know the property" result is expected and
   * is already phrased for in each rule's explanation.
   *
   * Every other rule's subject IS a property. A row of one of those types
   * carrying a null propertyId is a data-integrity problem — it cannot be
   * explained, because the thing the explanation is about is missing — and
   * classifySignalAnchor() below reports it as "unusable" rather than
   * laundering it into a contact-anchored signal. Nothing widens this set to
   * make a surface look fuller; see the W2-D objective's "do not weaken their
   * evidence requirements to increase signal volume".
   */
  contactAnchorable: boolean;
  run(scope: EvaluationScope, limit: number, after: number): Promise<SignalCandidate[]>;
}

const RULES: RuleDefinition[] = [
  { name: "long_ownership_tenure", signalTypes: ["long_ownership_tenure"], propertyScopable: true, contactAnchorable: false, run: longOwnershipTenureCandidates },
  { name: "stale_previous_appraisal", signalTypes: ["stale_previous_appraisal"], propertyScopable: true, contactAnchorable: false, run: staleAppraisalCandidates },
  // Passes grow_relationships.propertyId (nullable) through verbatim — see :640,
  // which already authors the no-property wording.
  { name: "past_buyer_interest", signalTypes: ["past_buyer_interest"], propertyScopable: true, contactAnchorable: true, run: pastBuyerInterestCandidates },
  {
    name: "provider_observations",
    signalTypes: [
      "recent_nearby_sales_activity",
      "development_planning_activity",
      "estimated_equity_band",
      "mortgage_refinancing_indicator",
      "property_ownership_change",
    ],
    propertyScopable: true,
    // The mirror case: these set partyId null and are anchored to a property
    // only. A provider observation with no property is not intelligence about
    // a person, it is a broken row.
    contactAnchorable: false,
    run: observationCandidates,
  },
  // Also passes a nullable relationship propertyId through — see :925.
  { name: "agent_recorded_motivation", signalTypes: ["agent_recorded_motivation"], propertyScopable: true, contactAnchorable: true, run: agentRecordedMotivationCandidates },
  { name: "lease_tenancy_milestone", signalTypes: ["lease_tenancy_milestone"], propertyScopable: true, contactAnchorable: false, run: leaseTenancyMilestoneCandidates },
  // ALWAYS contact-anchored — the only rule that is. See :1290.
  { name: "re_engagement_opportunity", signalTypes: ["re_engagement_opportunity"], propertyScopable: false, contactAnchorable: true, run: reEngagementCandidates },
];

/**
 * The number of statements evaluateCandidates() issues, independent of how
 * many candidates come back. Asserted by the scale test so a future rule
 * added without a set-based query is caught rather than quietly regressing
 * the sweep into N+1.
 *
 * Seven for a brokerage-wide sweep; six for a property-scoped caller, which
 * skips the one rule that is not property-scopable
 * (re_engagement_opportunity — see its comment).
 */
export const EVALUATION_STATEMENTS_PER_SCOPE = RULES.length;
export const EVALUATION_STATEMENTS_PER_PROPERTY_SCOPE = RULES.filter((r) => r.propertyScopable).length;

/** Exposed so a caller (and the tests) can reason about budgets without duplicating the list. */
export const EVALUATION_RULE_NAMES = RULES.map((r) => r.name);

/* =====================================================================
 * AE GROW Completion W2-D — THE ANCHOR TAXONOMY.
 *
 * Before this, "which rules may produce a signal with no property?" was
 * implicit in seven rule bodies, and the one surfacing path that cared
 * (getContactPropertyIntelligenceSummary) expressed its answer as a bare
 * `if (s.propertyId === null) continue`. That discarded the flagship
 * re_engagement_opportunity signal — which is ALWAYS contact-anchored — from
 * the contact record built to show it, and did so without saying anything.
 *
 * The taxonomy is now declared once, on the rule registry above, and read
 * through the three exports below. The three categories:
 *
 *   PROPERTY-ANCHORED  a verified property this signal is about.
 *   CONTACT-ANCHORED   the intelligence genuinely relates to the PERSON and
 *                      AE has no verified property association. A real
 *                      signal, to be surfaced honestly — with its evidence,
 *                      with its unknowns, and with NO property link and NO
 *                      property-specific action.
 *   UNUSABLE           neither anchor can be established, or a
 *                      property-dependent rule's row arrived without the
 *                      property its whole explanation is about. Counted and
 *                      reported, never surfaced as if it were the middle
 *                      category.
 *
 * The absence of a property is represented as an absence. Nothing here ever
 * infers, substitutes or fabricates a property association to make a row
 * renderable.
 * =====================================================================*/

export type SignalAnchor = "property" | "contact" | "unusable";

/**
 * Derived from RULES, never hand-listed, so adding a rule without deciding
 * this question cannot silently default it to "contact-anchorable".
 */
export const CONTACT_ANCHORABLE_SIGNAL_TYPES: ReadonlySet<string> = new Set<string>(
  RULES.filter((r) => r.contactAnchorable).flatMap((r) => r.signalTypes),
);

/** The rule names behind the set above, for tests and for operational reporting. */
export const CONTACT_ANCHORABLE_RULE_NAMES = RULES.filter((r) => r.contactAnchorable).map((r) => r.name);

/**
 * Which of the three categories a stored signal row falls into.
 *
 * Total and side-effect-free: it reads only the row's own type and its two
 * anchor columns, so a caller on a read path can classify without a lookup.
 * A signal type this codebase has no rule for is deliberately NOT
 * contact-anchorable — an unrecognised type with no property is exactly the
 * case where AE cannot say what it is looking at.
 */
export function classifySignalAnchor(signal: { signalType: string; partyId: number | null; propertyId: number | null }): SignalAnchor {
  if (signal.propertyId !== null) return "property";
  if (signal.partyId === null) return "unusable";
  return CONTACT_ANCHORABLE_SIGNAL_TYPES.has(signal.signalType) ? "contact" : "unusable";
}

/**
 * Runs every rule applicable to this scope, sequentially, against a shared
 * fairly-divided budget, and returns the combined candidate set.
 */
export async function evaluateCandidates(scope: EvaluationScope): Promise<EvaluationResult> {
  const emptyResult: EvaluationResult = {
    candidates: [],
    truncated: false,
    ruleReports: [],
    nextRuleCursors: {},
    authoritativeSignalTypes: [],
  };
  if (scope.propertyIds && scope.propertyIds.length === 0) return emptyResult;

  const propertyScoped = scope.propertyIds !== undefined;
  const applicable = RULES.filter((rule) => rule.propertyScopable || !propertyScoped);

  const candidates: SignalCandidate[] = [];
  const ruleReports: RuleEvaluationReport[] = [];
  const nextRuleCursors: Record<string, number> = {};
  const authoritativeSignalTypes: PropertySignalType[] = [];
  let truncated = false;

  let remainingBudget = scope.maxCandidates;
  let rulesRemaining = applicable.length;

  for (const rule of applicable) {
    // The fair share, recomputed each time so unused allowance flows on to
    // the rules that still have to run. `max(1, ...)` guarantees that even a
    // pathologically small maxCandidates still lets every rule speak.
    const budget = rulesRemaining > 0 ? Math.max(1, Math.floor(remainingBudget / rulesRemaining)) : 0;
    const cursor = Math.max(0, Math.trunc(scope.ruleCursors?.[rule.name] ?? 0));

    // +1 so a rule that exactly fills its budget is still recognisable as
    // "there may be more", rather than silently looking complete.
    const produced = await rule.run(scope, budget + 1, cursor);

    const ruleTruncated = produced.length > budget;
    const kept = ruleTruncated ? produced.slice(0, budget) : produced;

    // Where to resume. A rule that finished resets to 0, so the next run
    // re-reads it from the top and nothing is permanently skipped; a rule
    // that paused resumes after the last row it actually kept.
    const nextCursor = ruleTruncated && kept.length > 0 ? kept[kept.length - 1].orderingKey : 0;

    candidates.push(...kept);
    remainingBudget -= kept.length;
    rulesRemaining -= 1;
    nextRuleCursors[rule.name] = nextCursor;
    ruleReports.push({ rule: rule.name, produced: kept.length, budget, truncated: ruleTruncated, nextCursor });

    if (ruleTruncated) {
      truncated = true;
      // Stage 1 recorded truncation only as a boolean on the run row, which
      // told nobody WHICH rule was being cut off. These two lines are what
      // make a starving tenant visible in ordinary operations.
      // The metric stays on the existing closed label set — a rule name is
      // detail for the log line, not a metric label (see the label-set rule
      // in packages/events/src/metrics.ts).
      incrementCounter("property_signal_outcome_total", { outcome: "rule_truncated" });
      logger.warn("property_signal_rule_truncated", {
        brokerageId: scope.brokerageId,
        rule: rule.name,
        budget,
        produced: kept.length,
        resumeAfter: nextCursor,
        detail: "This rule had more candidates than its share of the per-brokerage cap. It will resume from resumeAfter on the next sweep.",
      });
    } else {
      // This rule ran to completion, so the pass IS authoritative for the
      // signal types only it can produce — even if another rule truncated.
      authoritativeSignalTypes.push(...rule.signalTypes);
    }
  }

  return { candidates, truncated, ruleReports, nextRuleCursors, authoritativeSignalTypes };
}
