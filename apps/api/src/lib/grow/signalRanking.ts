/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 3 — PRIORITISATION AND
 * EXPLAINABILITY.
 *
 * ===================================================================
 * WHAT THIS MODULE IS
 * ===================================================================
 *
 * Stage 1 (lib/propertyIntelligence/**) made AE examine the whole brokerage
 * and WRITE evidence-backed signals. This module is the read-time half: it
 * decides, for one signal, HOW MUCH IT MATTERS and WHY IT MATTERS, in
 * language an agent can act on and repeat to a homeowner.
 *
 * It is deliberately SELF-CONTAINED and PURE:
 *   - no database access, no I/O, no clock of its own (`now` is passed in);
 *   - it reads only columns grow_opportunity_signals already has
 *     (signal_type, confidence_band, source, evidence, re_raise_count,
 *     computed_at, source_timestamp) plus a small, caller-supplied summary
 *     of the contact's existing relationship state;
 *   - it writes nothing, schedules nothing, and CANNOT cause a message to be
 *     sent. Ranking a signal high is not permission to contact anybody — it
 *     only changes where a card sits on one agent's screen.
 *
 * ===================================================================
 * THE PRODUCT CONSTRAINT THIS ENCODES
 * ===================================================================
 *
 * The strategy is identifying and NURTURING FUTURE SELLERS — including
 * contacts with no obvious current signal. It must NOT become an "area
 * activity alert engine". That is not a comment; it is expressed directly in
 * SIGNAL_TYPE_POINTS below, where `recent_nearby_sales_activity` and
 * `development_planning_activity` carry the LOWEST type weight in the table
 * and `stale_previous_appraisal` / `long_ownership_tenure` — the two signals
 * that describe a real relationship with a real homeowner — carry the
 * highest. Area activity is background colour for a conversation the agent
 * was already going to have; it is never, on its own, a reason to appear at
 * the top of somebody's day.
 *
 * Likewise the `Emerging` band scores low but is NOT zero and is NOT
 * filtered: "a future seller with no obvious current signal" is precisely the
 * population the strategy targets, so an Emerging signal earns a quiet
 * Keep Warm card rather than silent deletion.
 *
 * ===================================================================
 * THE SCORE IS NEVER THE EXPLANATION
 * ===================================================================
 *
 * rankSignal() returns a score AND the itemised `factors` that produced it
 * AND a plain-language `narrative`. The score exists to ORDER cards; the
 * factors exist so an agent (or a reviewer, or a regulator) can see exactly
 * which stored facts moved it; the narrative exists so the agent knows what
 * to actually do and say. A caller that surfaces the number without the other
 * two has not met the requirement.
 *
 * Every narrative sentence is HEDGED. AE has no information about anybody's
 * private intentions, and nothing here may read as if it does. Talking points
 * are phrased as questions the agent may choose to ask, never as assertions
 * about the homeowner's plans.
 */

/* ---------------------------------------------------------------------
 * Inputs
 * -----------------------------------------------------------------*/

/**
 * The subset of a grow_opportunity_signals row this module ranks. Mirrors
 * existing columns exactly — stage 3 adds no schema and reads nothing that
 * stage 1 did not already store.
 */
export interface RankableSignal {
  signalType: string;
  title: string;
  /** The signal's own stored, already-hedged plain-language explanation. */
  explanation: string;
  confidenceBand: string;
  /** "internal" (AE's own records) or a provider id. */
  source: string;
  /** jsonb — shape is per-rule and is read defensively below. */
  evidence: unknown;
  reRaiseCount: number;
  computedAt: Date | null;
  sourceTimestamp: Date | null;
}

/**
 * What the READ PATH already knows about this contact, supplied by the
 * caller so this module stays free of database access. Every field is
 * derived from data Grow Today already loads for its other rules.
 */
export interface SignalContactState {
  /**
   * False for an observation-derived signal, which is anchored to a PROPERTY
   * and has no linked contact at all.
   *
   * This matters to the score, not just to the display. The relationship-state
   * component below rewards "nobody is working this contact" and "nobody has
   * ever spoken to this contact" — and neither is a meaningful statement about
   * a signal that has no contact in the first place. Awarding those points
   * anyway was how a fresh nearby-sales-activity observation, the single
   * lowest-value signal type in the model, still climbed into Do Today: it
   * collected credit for a relationship gap that did not exist. A contact-less
   * signal now contributes nothing from this component.
   */
  hasLinkedContact: boolean;
  /** True when an Open growOpportunities row already exists for this contact. Meaningless when hasLinkedContact is false. */
  hasOpenOpportunity: boolean;
  /** Most recent recorded activity for this contact, or null if there has never been one. */
  lastActivityAt: Date | null;
  /**
   * The stage 1 contactability verdict (lib/propertyIntelligence/contactability.ts),
   * re-evaluated at READ time. "do_not_contact" means a DNC listing or a
   * full-channel suppression is on file.
   */
  contactability: SignalContactability;
  /** Display label for the linked property, used only to make a talking point concrete. */
  propertyLabel: string | null;
}

export type SignalContactability = "contactable" | "do_not_contact";

/* ---------------------------------------------------------------------
 * Outputs
 * -----------------------------------------------------------------*/

/** One itemised, human-readable contribution to the score. */
export interface SignalRankingFactor {
  /** Short label, e.g. "Owned for about 11 years". */
  label: string;
  /** One sentence saying why this moved the ranking. */
  detail: string;
  /** Signed contribution, rounded to a whole number. */
  points: number;
}

export interface SignalNarrative {
  /** Why this matters, now, in one or two sentences an agent can act on. */
  headline: string;
  /**
   * Something the agent could actually say. Always a question or an offer,
   * never a claim about the homeowner's intentions. Null when the signal type
   * gives AE nothing concrete enough to put in an agent's mouth.
   */
  talkingPoint: string | null;
  /** The limit of what AE actually knows. Never null — every signal is an inference. */
  caution: string;
}

/** A signal is never "DoNow": see SIGNAL_DO_TODAY_MIN_SCORE's comment below. */
export type SignalPriority = "DoToday" | "KeepWarm";

export interface SignalRanking {
  /** 0..100. Ordering only — it is not a probability and must never be shown as one. */
  score: number;
  priority: SignalPriority;
  /** Sorted by absolute contribution, largest first. Never empty. */
  factors: SignalRankingFactor[];
  narrative: SignalNarrative;
}

/* ---------------------------------------------------------------------
 * Weights. All named constants, all commented with the product reason —
 * never bare numbers buried in the scoring function.
 * -----------------------------------------------------------------*/

/**
 * How strong the evidence itself is. These are the schema's own bands
 * (packages/db/src/schema/propertyIntelligence.ts); the gap between
 * StrongIndicator and Emerging is the single largest lever in the model,
 * because evidence quality should dominate everything else.
 */
const CONFIDENCE_BAND_POINTS: Record<string, number> = {
  StrongIndicator: 40,
  WorthReviewing: 26,
  Emerging: 12,
};
const CONFIDENCE_BAND_POINTS_DEFAULT = 12;

/**
 * How close this KIND of signal sits to a real conversation with a real
 * homeowner about their own home.
 *
 * The ordering here is the anti-"area activity alert engine" rule, made
 * mechanical: a previous appraisal (they already invited us to value their
 * home) and a long tenure (a relationship with an owner) outrank anything
 * derived from what the neighbours are doing by a factor of four or more.
 */
const SIGNAL_TYPE_POINTS: Record<string, number> = {
  // They asked us for a valuation once. That is the strongest permission AE
  // can observe without inventing anything.
  stale_previous_appraisal: 22,
  // An agent wrote down a reason. A human judgement outranks every inference.
  agent_recorded_motivation: 20,
  // A real, long-held relationship with an owner — the core future-seller case.
  long_ownership_tenure: 18,
  property_ownership_change: 15,
  mortgage_refinancing_indicator: 13,
  estimated_equity_band: 12,
  // Today's buyer is tomorrow's seller.
  past_buyer_interest: 11,
  re_engagement_opportunity: 10,
  lease_tenancy_milestone: 9,
  land_use_zoning_change: 6,
  // Deliberately the two lowest weights in this table. See the module header.
  development_planning_activity: 5,
  recent_nearby_sales_activity: 4,
};
const SIGNAL_TYPE_POINTS_DEFAULT = 8;

/** Ceiling on the per-rule "how much evidence is actually behind this" component. */
const EVIDENCE_DEPTH_MAX = 12;

/**
 * Provenance and freshness, capped at this. AE's own records score a solid
 * constant; a third-party observation has to be recent to score as well,
 * because a provider fact decays and AE's own record of its own appraisal
 * does not.
 */
const INTERNAL_SOURCE_POINTS = 6;
const OBSERVATION_FRESHNESS_POINTS: Array<{ withinDays: number; points: number }> = [
  { withinDays: 14, points: 10 },
  { withinDays: 30, points: 7 },
  { withinDays: 90, points: 4 },
  { withinDays: 180, points: 2 },
];

/**
 * A re-raise is meaningful. Stage 1's re-review policy only lets the sweep
 * raise a human-decided dedupeKey again when its quiet period has elapsed AND
 * the evidence materially changed — so a re-raise is genuinely new
 * information about a contact somebody already looked at once, not noise.
 * Capped low and at two steps so a pathological row can never dominate.
 */
const RE_RAISE_POINTS_EACH = 4;
const RE_RAISE_POINTS_MAX = 8;

/**
 * Relationship state. The strategy is nurturing contacts NOBODY is currently
 * working — so "no open opportunity" is a positive, and an existing open
 * opportunity is a penalty, because an agent is already on it and the signal
 * is context rather than a new task.
 */
const NO_OPEN_OPPORTUNITY_POINTS = 6;
const HAS_OPEN_OPPORTUNITY_POINTS = -10;
const NEVER_CONTACTED_POINTS = 6;
const COLD_CONTACT_POINTS = 4;
/** Recorded contact this recently means do not put them at the top of today again. */
const RECENTLY_CONTACTED_DAYS = 7;
const RECENTLY_CONTACTED_POINTS = -12;

/**
 * How long without a recorded contact of any kind counts as "cold".
 *
 * AE GROW COMPLETION PROGRAM W2-A (F-7) — SINGLE-SOURCED. This constant used
 * to exist TWICE, here and at lib/growToday.ts, kept equal by a comment on
 * each saying it matched the other. Two surfaces that must agree on the
 * meaning of "cold" cannot be kept in agreement by a comment: the first person
 * to tune one of them silently gives Grow Today and the signal ranker two
 * different definitions of the same word, and nothing fails.
 *
 * It is declared HERE (the pure, dependency-free leaf module) and imported by
 * growToday.ts, which already imports from this file, rather than the other
 * way round — growToday.ts reaches the database and this module must not.
 */
export const COLD_CONTACT_THRESHOLD_DAYS = 21;

/**
 * At or above this, a signal earns a Do Today card; below it, Keep Warm.
 *
 * A signal is NEVER "DoNow" regardless of score. DoNow is reserved for a
 * DATED COMMITMENT THE AGENT ALREADY MADE (an overdue follow-up, an overdue
 * appraisal callback) — a promise to a real person. A signal is AE's
 * inference; letting an inference outrank a kept promise would be the wrong
 * product, and would also be the first step towards a system that nags.
 */
export const SIGNAL_DO_TODAY_MIN_SCORE = 55;

export const SIGNAL_SCORE_MAX = 100;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------
 * Defensive evidence readers. `evidence` is jsonb written by a module this
 * one does not own, so every read is total: a missing, renamed or
 * wrong-typed field degrades the score and the narrative, and never throws.
 * -----------------------------------------------------------------*/

function evidenceObject(evidence: unknown): Record<string, unknown> {
  return typeof evidence === "object" && evidence !== null && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
}

function evidenceNumber(evidence: unknown, key: string): number | null {
  const raw = evidenceObject(evidence)[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

function evidenceString(evidence: unknown, key: string): string | null {
  const raw = evidenceObject(evidence)[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function daysBetween(now: Date, then: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);
}

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

/* ---------------------------------------------------------------------
 * Component 3 — per-rule evidence depth.
 *
 * "How much of this kind of evidence is there?", answered from the rule's own
 * evidence blob (lib/propertyIntelligence/evaluation.ts writes these shapes).
 * A rule with no depth measure available returns null and simply contributes
 * nothing, rather than a made-up number.
 * -----------------------------------------------------------------*/

function evidenceDepthFactor(signal: RankableSignal): SignalRankingFactor | null {
  switch (signal.signalType) {
    case "long_ownership_tenure": {
      const years = evidenceNumber(signal.evidence, "approximateTenureYears");
      if (years === null) return null;
      // The rule's own floor is 5 years, so only tenure BEYOND the floor is
      // additional evidence. 1.5 points a year, capped.
      const points = clamp((years - 5) * 1.5, 0, EVIDENCE_DEPTH_MAX);
      return {
        label: `Owned for about ${Math.floor(years)} ${plural(Math.floor(years), "year", "years")}`,
        detail: `Tenure beyond AE's five-year floor adds weight — the longer a home is held, the more likely a future move conversation becomes relevant.`,
        points,
      };
    }
    case "stale_previous_appraisal": {
      const overdueDays = evidenceNumber(signal.evidence, "overdueDays");
      if (overdueDays === null) return null;
      const points = clamp(overdueDays / 12, 0, EVIDENCE_DEPTH_MAX);
      return {
        label: `Appraisal follow-up ${Math.floor(overdueDays)} ${plural(Math.floor(overdueDays), "day", "days")} overdue`,
        detail: `A valuation conversation was started and never closed out. The longer it sits, the more likely the agent simply lost the thread.`,
        points,
      };
    }
    case "past_buyer_interest": {
      const relationshipType = evidenceString(signal.evidence, "relationshipType");
      return {
        label: relationshipType === "buyer" ? "Recorded as a buyer" : "Recorded as a prospective buyer",
        detail: `A recorded buying interest with no opportunity behind it is an existing relationship nobody is currently working.`,
        points: 4,
      };
    }
    default:
      // Provider-observation rules carry a provider-shaped payload whose
      // structure AE does not control, so there is no honest per-rule depth
      // measure to read. They contribute through band, type and freshness
      // only — which is the correct, conservative outcome for third-party
      // data.
      return null;
  }
}

/* ---------------------------------------------------------------------
 * Component 4 — provenance and freshness.
 * -----------------------------------------------------------------*/

function provenanceFactor(signal: RankableSignal, now: Date): SignalRankingFactor {
  if (signal.source === "internal") {
    return {
      label: "Based on AE's own records",
      detail: `This comes from your brokerage's own relationship, appraisal and activity history — not a third-party data feed.`,
      points: INTERNAL_SOURCE_POINTS,
    };
  }
  const observedAt = signal.sourceTimestamp ?? signal.computedAt;
  if (!observedAt) {
    return {
      label: `Third-party observation of unknown age`,
      detail: `The ${signal.source} observation behind this carries no date, so AE gives it no freshness credit.`,
      points: 0,
    };
  }
  const ageDays = Math.max(0, daysBetween(now, observedAt));
  const tier = OBSERVATION_FRESHNESS_POINTS.find((t) => ageDays <= t.withinDays);
  return {
    label: `${signal.source} observation from ${ageDays} ${plural(ageDays, "day", "days")} ago`,
    detail: tier
      ? `Third-party observations decay; this one is recent enough to still be worth raising.`
      : `Third-party observations decay; this one is old enough that AE gives it no freshness credit.`,
    points: tier ? tier.points : 0,
  };
}

/* ---------------------------------------------------------------------
 * Narrative — "why this matters", per signal type, from stored evidence.
 *
 * WORDING RULES, enforced by review and by the tests in
 * routes/__tests__/growSignalRanking.test.ts:
 *   - never assert what the homeowner intends, plans or wants;
 *   - every talking point is a QUESTION or an OFFER the agent may choose to
 *     make, never a statement of fact about the contact;
 *   - the caution always names the limit of what AE actually knows.
 * -----------------------------------------------------------------*/

const GENERIC_CAUTION =
  "AE has no information about this contact's private intentions. This is a pattern in your own data, not a prediction that they are selling.";

function propertyPhrase(propertyLabel: string | null): string {
  return propertyLabel ? propertyLabel : "their property";
}

function buildNarrative(signal: RankableSignal, state: SignalContactState): SignalNarrative {
  const where = propertyPhrase(state.propertyLabel);

  switch (signal.signalType) {
    case "long_ownership_tenure": {
      const years = evidenceNumber(signal.evidence, "approximateTenureYears");
      const yearPhrase = years === null ? "a long time" : `about ${Math.floor(years)} ${plural(Math.floor(years), "year", "years")}`;
      return {
        headline: `AE has this contact recorded as an owner of ${where} for ${yearPhrase}. Long-held homes are where future listings most often come from, so this is a relationship worth keeping warm now — long before anyone is on the market.`,
        talkingPoint: `"You've been at ${where} a good while now — would it be useful to know what it would be worth in today's market, just so you have the number?"`,
        caution: GENERIC_CAUTION,
      };
    }
    case "stale_previous_appraisal": {
      const overdueDays = evidenceNumber(signal.evidence, "overdueDays");
      const overduePhrase =
        overdueDays === null
          ? "some time ago"
          : `${Math.floor(overdueDays)} ${plural(Math.floor(overdueDays), "day", "days")} ago`;
      return {
        headline: `This contact already invited a valuation conversation about ${where}, and the follow-up went quiet ${overduePhrase}. They asked once — that is the clearest permission in your whole database, and it is currently unactioned.`,
        talkingPoint: `"When we last spoke about the value of ${where} you were still weighing things up — has anything changed since then?"`,
        caution: `${GENERIC_CAUTION} An overdue follow-up says the conversation stopped; it does not say why.`,
      };
    }
    case "past_buyer_interest": {
      return {
        headline: `This contact was recorded as an interested buyer and no opportunity was ever created for them. Today's buyer is tomorrow's seller, and right now nobody in the brokerage is working this relationship.`,
        talkingPoint: `"Last time we spoke you were looking — are you still in the market, or has the plan changed?"`,
        caution: `${GENERIC_CAUTION} AE knows an interest was recorded; it does not know whether it was ever acted on outside AE.`,
      };
    }
    case "recent_nearby_sales_activity": {
      return {
        // Directly honours the "must not become an area activity alert
        // engine" constraint in the agent-facing copy itself.
        headline: `A ${signal.source} observation recorded sales or market activity relevant to ${where}. AE treats area activity as BACKGROUND for a conversation you were already going to have — on its own it is not a reason to contact anyone.`,
        talkingPoint: null,
        caution: `${GENERIC_CAUTION} Activity near a property says nothing about that property's owner.`,
      };
    }
    case "development_planning_activity": {
      return {
        headline: `A ${signal.source} observation recorded planning or development activity near ${where}. Useful context if you are already speaking to this owner — not a reason to start.`,
        talkingPoint: null,
        caution: `${GENERIC_CAUTION} Nearby planning activity is about the area, not about this owner.`,
      };
    }
    case "estimated_equity_band": {
      return {
        headline: `A ${signal.source} observation recorded valuation or equity information for ${where}. An owner with room to move has options — worth knowing before a conversation, never worth quoting at them.`,
        talkingPoint: `"If you ever wanted to understand your options around ${where}, I can put the current numbers in front of you — no obligation."`,
        caution: `${GENERIC_CAUTION} The figures are a third-party estimate, not this owner's actual financial position, and must not be repeated to them as fact.`,
      };
    }
    case "mortgage_refinancing_indicator": {
      return {
        headline: `A ${signal.source} observation recorded mortgage or refinancing activity for ${where}. Owners reviewing their finance are often reviewing their plans too — a reason to be in touch, not a reason to assume anything.`,
        talkingPoint: `"Is now a good time for a quick catch-up about ${where} and where you're heading with it?"`,
        caution: `${GENERIC_CAUTION} Finance activity has many explanations that have nothing to do with selling, and must never be raised with the contact directly.`,
      };
    }
    case "re_engagement_opportunity": {
      // AE GROW COMPLETION PROGRAM W2-A (B-4). This is the sweep's
      // HIGHEST-VOLUME signal type and it had NO case here at all, so it fell
      // to the default branch below and every card got talkingPoint: null —
      // the flagship "nurture a future seller" signal was the one signal that
      // gave the agent nothing to say.
      //
      // WORDING. `dormantDays` is written at the top level of the evidence
      // blob by evaluation.ts's re-engagement rule (its `legacy` block), and
      // is read defensively here: a missing or wrong-typed value degrades to
      // a vaguer phrase rather than throwing or inventing a number.
      //
      // Everything below asserts only what AE's OWN records show — that a
      // relationship exists and that nobody has recorded a contact for a long
      // time. It says nothing about why, nothing about the owner's plans, and
      // the talking point is an offer phrased as a question, exactly like the
      // long-tenure and past-buyer cases above.
      const dormantDays = evidenceNumber(signal.evidence, "dormantDays");
      const dormantPhrase =
        dormantDays === null
          ? "a long time"
          : `${Math.floor(dormantDays)} ${plural(Math.floor(dormantDays), "day", "days")}`;
      const neverContacted = /never been contacted/i.test(signal.title);
      return {
        headline: neverContacted
          ? `This person is in your database with a real recorded connection to the brokerage, and AE can find no contact of any kind ever recorded with them. Nobody has an open opportunity or commitment for them either, so this is a relationship that exists on paper and nowhere else.`
          : `AE has no contact of any kind recorded with this person for ${dormantPhrase}, and nobody currently has an open opportunity or commitment for them. The relationship has gone quiet — that is the part you can do something about today.`,
        talkingPoint: neverContacted
          ? `"We've had you on our books for a while and I don't think we've ever properly introduced ourselves — would a quick catch-up about ${where} be useful, or would you rather we just keep you on the mailing list?"`
          : `"It's been a while since we last spoke — is there anything happening with ${where} that would be worth a catch-up about, or shall I check back in later in the year?"`,
        caution: `${GENERIC_CAUTION} A gap in AE's records means nobody RECORDED a contact — it does not prove none happened, and it says nothing at all about whether this person wants to hear from you.`,
      };
    }
    case "property_ownership_change": {
      return {
        headline: `A ${signal.source} observation of ownership for ${where} does not match AE's own recorded owner. Either your record is stale or the property changed hands — both are worth ten minutes before anyone calls.`,
        talkingPoint: null,
        caution: `${GENERIC_CAUTION} This is a mismatch between two records, not a confirmed change of ownership — verify before acting.`,
      };
    }
    default: {
      return {
        headline: `${signal.title}. ${signal.explanation}`,
        talkingPoint: null,
        caution: GENERIC_CAUTION,
      };
    }
  }
}

/* ---------------------------------------------------------------------
 * The ranking itself.
 * -----------------------------------------------------------------*/

/**
 * Explanation used whenever a contact must not be contacted. Deliberately
 * describes the STATE, never the person, and never implies the agent may
 * reach out "carefully".
 */
export const DO_NOT_CONTACT_NARRATIVE_HEADLINE =
  "This contact is recorded as do-not-contact (a DNC listing, or every channel suppressed). AE is showing the signal so the record is not silently hidden from you, but this contact must not be approached — check the contact record before doing anything at all.";

/**
 * Scores and explains one signal.
 *
 * Contactability is applied LAST and absolutely: a do-not-contact contact is
 * pinned to score 0 and Keep Warm no matter how strong the evidence is, and
 * the narrative is replaced by a do-not-contact notice.
 *
 * NOTE ON WHERE THIS BRANCH FIRES. Grow Today (lib/growToday.ts) WITHHOLDS a
 * suppressed contact's signals entirely and so never reaches this branch —
 * hiding, not de-ranking, is the required behaviour on that surface (security
 * finding P1-3). This branch is retained deliberately as a belt-and-braces
 * guarantee for any future caller that chooses to display suppressed signals
 * on a review surface: it makes it impossible for this function to hand back
 * a high score for somebody who must not be approached, so a caller cannot
 * get that wrong by forgetting a filter.
 */
export function rankSignal(signal: RankableSignal, state: SignalContactState, now: Date): SignalRanking {
  const factors: SignalRankingFactor[] = [];

  // 1 — evidence strength (the schema's own confidence band).
  const bandPoints = CONFIDENCE_BAND_POINTS[signal.confidenceBand] ?? CONFIDENCE_BAND_POINTS_DEFAULT;
  factors.push({
    label: `Evidence strength: ${confidenceBandLabel(signal.confidenceBand)}`,
    detail:
      signal.confidenceBand === "Emerging"
        ? `An early pattern. AE keeps these visible because a future seller usually looks exactly like this long before they look like anything else.`
        : `AE's own assessment of how much evidence sits behind this signal.`,
    points: bandPoints,
  });

  // 2 — how close this kind of signal is to a conversation with an owner.
  const typePoints = SIGNAL_TYPE_POINTS[signal.signalType] ?? SIGNAL_TYPE_POINTS_DEFAULT;
  factors.push({
    label: `Signal type: ${signal.title}`,
    detail:
      typePoints >= SIGNAL_TYPE_POINTS_DEFAULT
        ? `This kind of signal describes a relationship with this owner, which AE ranks above anything happening merely nearby.`
        : `This kind of signal describes activity around the property rather than a relationship with its owner, so AE ranks it as background context.`,
    points: typePoints,
  });

  // 3 — per-rule evidence depth, read from the stored evidence blob.
  const depth = evidenceDepthFactor(signal);
  if (depth) factors.push(depth);

  // 4 — provenance and freshness.
  factors.push(provenanceFactor(signal, now));

  // 5 — re-raise persistence.
  const reRaises = Number.isFinite(signal.reRaiseCount) ? Math.max(0, Math.trunc(signal.reRaiseCount)) : 0;
  if (reRaises > 0) {
    factors.push({
      label: `Raised again after a previous decision (${reRaises}×)`,
      detail: `AE only re-raises a signal somebody already decided when the quiet period has passed AND the underlying evidence actually changed — so this is new information, not a repeat.`,
      points: Math.min(reRaises * RE_RAISE_POINTS_EACH, RE_RAISE_POINTS_MAX),
    });
  }

  // 6 — existing relationship state. Skipped entirely when there is no
  // contact: see SignalContactState.hasLinkedContact.
  if (!state.hasLinkedContact) {
    factors.push({
      label: "No contact is linked to this signal",
      detail: `This signal is about a property rather than a person, so AE has no relationship to weigh — review it on the property record.`,
      points: 0,
    });
  } else if (state.hasOpenOpportunity) {
    factors.push({
      label: "An opportunity is already open for this contact",
      detail: `Somebody is already working this relationship, so this signal is context for them rather than a new task for today.`,
      points: HAS_OPEN_OPPORTUNITY_POINTS,
    });
  } else {
    factors.push({
      label: "No open opportunity — nobody is working this contact",
      detail: `This is the nurture gap the brokerage-wide sweep exists to close.`,
      points: NO_OPEN_OPPORTUNITY_POINTS,
    });
  }

  if (!state.hasLinkedContact) {
    // Nothing to say about contact history for a property-anchored signal.
  } else if (state.lastActivityAt === null) {
    factors.push({
      label: "No contact ever recorded",
      detail: `AE has no record of anyone in the brokerage speaking to this contact.`,
      points: NEVER_CONTACTED_POINTS,
    });
  } else {
    const days = Math.max(0, daysBetween(now, state.lastActivityAt));
    if (days <= RECENTLY_CONTACTED_DAYS) {
      factors.push({
        label: `Spoken to ${days} ${plural(days, "day", "days")} ago`,
        detail: `Recent contact is on file, so AE deliberately pushes this down rather than prompting a second approach in the same week.`,
        points: RECENTLY_CONTACTED_POINTS,
      });
    } else if (days >= COLD_CONTACT_THRESHOLD_DAYS) {
      factors.push({
        label: `No contact recorded for ${days} days`,
        detail: `The relationship has gone quiet while the evidence behind this signal has not.`,
        points: COLD_CONTACT_POINTS,
      });
    }
  }

  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const score = Math.round(clamp(rawScore, 0, SIGNAL_SCORE_MAX));

  // Round the reported points too, so the itemisation an agent reads adds up
  // to roughly the number they are shown rather than to a hidden fraction.
  const reportedFactors = factors
    .map((f) => ({ ...f, points: Math.round(f.points) }))
    .sort((a, b) => Math.abs(b.points) - Math.abs(a.points));

  const narrative = buildNarrative(signal, state);

  if (state.contactability === "do_not_contact") {
    return {
      score: 0,
      priority: "KeepWarm",
      factors: [
        {
          label: "Do not contact",
          detail: `A do-not-contact record or a full-channel suppression is on file. This overrides every other factor and pins this item to the bottom of the day.`,
          points: 0,
        },
        ...reportedFactors,
      ],
      narrative: {
        headline: DO_NOT_CONTACT_NARRATIVE_HEADLINE,
        talkingPoint: null,
        caution: `${narrative.caution} Whatever the evidence says, this contact must not be approached.`,
      },
    };
  }

  return {
    score,
    priority: score >= SIGNAL_DO_TODAY_MIN_SCORE ? "DoToday" : "KeepWarm",
    factors: reportedFactors,
    narrative,
  };
}

/* ---------------------------------------------------------------------
 * AE GROW COMPLETION PROGRAM W2-A (F-3 / the Project Owner's DECISION 3) —
 * WHICH OF TWO SIGNALS ABOUT THE SAME PERSON IS "THE STRONGER SIGNAL".
 *
 * DECISION 3 asks that when several things would apply to one contact, AE
 * surfaces ONE best item with the evidence preserved. Doing that requires an
 * answer to a question this codebase had never actually written down: given a
 * long-tenure signal and a re-engagement signal for the same person, which one
 * IS the card?
 *
 * TWO CANDIDATE AUTHORITIES EXISTED, AND THEY DISAGREE.
 *
 *   - Total rankScore. This is already the ordering authority for EVERY OTHER
 *     comparison on this surface: growToday.ts's final comparator orders the
 *     whole day by it, across all six rules.
 *   - SIGNAL_TYPE_POINTS above. It expresses a real product judgement (how
 *     close a KIND of signal sits to a conversation with an owner) but it has
 *     never been declared a tie-break authority and it is only ONE of six
 *     components of the score.
 *
 * They genuinely conflict. A StrongIndicator re_engagement_opportunity scores
 * 68 and beats a WorthReviewing long_ownership_tenure on total score, while
 * losing to it on type weight (10 vs 18).
 *
 * WHAT IS IMPLEMENTED, AND WHY. Total rankScore — because it is the existing,
 * already-shipped ordering authority for this surface, and because picking the
 * winner by a criterion DIFFERENT from the one that then orders the list would
 * mean the chosen card could sort below a card it had just beaten. Choosing by
 * score keeps "the card AE kept" and "the card AE ranks highest" the same
 * sentence.
 *
 * THIS IS A PENDING PROJECT OWNER DECISION, NOT A SETTLED ONE. It is therefore
 * single-sourced into the one comparator below and named in
 * PER_PARTY_SIGNAL_SELECTOR, so flipping it to signal-type authority is an
 * edit to this function and nothing else. Whatever is chosen, the losing
 * signals are NEVER discarded: they ride on the winning card as
 * relatedSignals, so the evidence survives and AE can show its working.
 * -----------------------------------------------------------------*/

/** The criterion currently used to choose one card per party. See the block above. */
export const PER_PARTY_SIGNAL_SELECTOR = "rankScore" as const;
export type PerPartySignalSelector = typeof PER_PARTY_SIGNAL_SELECTOR;

/** The minimum a ranked signal must expose to be compared against a sibling. */
export interface ComparableRankedSignal {
  /** The total rankScore from rankSignal(). */
  score: number;
  /** The grow_opportunity_signals row id — the deterministic tiebreak. */
  rowId: number;
}

/**
 * Strongest first. THE ROW ID TIEBREAK IS LOAD-BEARING, not cosmetic: without
 * it two equally-scored signals order by whatever the database happened to
 * return, so the chosen card — and therefore the whole day's card list — could
 * differ between two identical requests a second apart. Every ordering of
 * signals on this surface goes through this one function so that the global
 * sort and the per-party winner can never disagree.
 */
export function compareSignalStrength(a: ComparableRankedSignal, b: ComparableRankedSignal): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.rowId - b.rowId;
}

/** The bands are stored as identifiers; agents read prose. */
export function confidenceBandLabel(band: string): string {
  switch (band) {
    case "StrongIndicator":
      return "Strong indicator";
    case "WorthReviewing":
      return "Worth reviewing";
    case "Emerging":
      return "Emerging";
    default:
      return band;
  }
}

/* ---------------------------------------------------------------------
 * Baseline ranks for the rules that are NOT signals (Grow Today's Rules
 * A-E), so that everything on the screen sits on ONE comparable scale.
 *
 * WHY THIS LIVES HERE. Before stage 3, signals carried dueAt: null and the
 * comparator sorted every dated item ahead of every undated one, which put
 * every signal behind every dated card in its band — i.e. out of the working
 * day entirely. Giving every card an explicit rank means a strong signal can
 * legitimately outrank a weak dated item WITHIN its priority band, while the
 * band itself (DoNow > DoToday > KeepWarm) is still decided first and is
 * completely unchanged.
 *
 * These baselines are intentionally arranged so that the pre-stage-3
 * ordering of Rules A-E among themselves is PRESERVED: more overdue ranks
 * ahead of less overdue (identical to "oldest dueAt first"), and a colder
 * contact ranks ahead of a warmer one (identical to "oldest lastActivityAt
 * first").
 * -----------------------------------------------------------------*/

/** A dated commitment the agent already made: most overdue leads the day. */
export function rankOverdueCommitment(overdueDays: number, kind: "opportunity" | "appraisal"): number {
  const base = kind === "appraisal" ? 72 : 70;
  return base + clamp(Math.floor(overdueDays), 0, 28);
}

/** Due today — urgent, but nothing has been broken yet. */
export function rankDueToday(kind: "opportunity" | "appraisal"): number {
  return kind === "appraisal" ? 70 : 68;
}

/**
 * A brand-new appraisal opportunity with no next action set. Ranks at the top
 * of Keep Warm-adjacent work: it is a real pipeline entity with nobody
 * driving it.
 */
export const RANK_APPRAISAL_NO_ACTION_SET = 60;

/** A non-appraisal opportunity with no next action set: real pipeline, less urgent. */
export const RANK_OPPORTUNITY_NO_ACTION_SET = 45;

/** A cold relationship with no more specific reason attached. */
export function rankColdRelationship(daysSinceContact: number | null): number {
  // Never contacted at all is the coldest possible state.
  if (daysSinceContact === null) return 38;
  return clamp(20 + Math.floor(daysSinceContact / 7), 20, 37);
}
