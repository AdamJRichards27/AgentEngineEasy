import { and, asc, desc, eq, gt, isNotNull, isNull, lt, max, or, sql } from "drizzle-orm";
import { db, appraisals, growActivities, growCommitments, growOpportunities, growOpportunitySignals, growRelationships, parties, properties } from "@aee/db";
import { visibleLinkedPropertySql, visibleRequiredPropertySql } from "./propertyVisibility.js";
import { isOverdueLocal, isToday, localDateKey, resolveTimeZone, startOfLocalDay } from "./commandCentre/timezone.js";
import { loadContactabilityFilter } from "./propertyIntelligence/contactability.js";
import {
  COLD_CONTACT_THRESHOLD_DAYS,
  PER_PARTY_SIGNAL_SELECTOR,
  RANK_APPRAISAL_NO_ACTION_SET,
  RANK_OPPORTUNITY_NO_ACTION_SET,
  compareSignalStrength,
  confidenceBandLabel,
  ruleDWinsOverSignal,
  rankColdRelationship,
  rankDueToday,
  rankOverdueCommitment,
  rankSignal,
  type SignalContactability,
  type SignalNarrative,
  type SignalRanking,
  type SignalRankingFactor,
} from "./grow/signalRanking.js";

// AE GROW Priority 1 — Daily Command Centre.
//
// getGrowTodaySummary() is Grow's own "what needs my attention today?"
// surface, deliberately shaped the same way apps/api/src/lib/homeSummary.ts's
// header comment already pre-scoped it: a flat, deterministic list of
// concrete actionable items, never a BI dashboard of counts/charts/trends —
// see that file's comment for the boundary this function was built to
// respect. Reads only Grow's own domain tables (growRelationships,
// growActivities, growOpportunities) plus canonical parties/properties for
// display labels — RUN's workflow/transaction/financial tables are never
// touched here, and never will be; that is RUN's Command Centre's job
// (apps/api/src/lib/commandCentre), not Grow's.
//
// Every rule below is DETERMINISTIC — plain date/threshold comparisons on
// data an agent (or the existing Grow import/entry flows) already entered.
// None of it is predictive scoring, and growOpportunities.confidenceScore/
// scoreExplanation (Grow Stage A's existing "explainable, never just a
// score" fields) are deliberately not read here — an Opportunity Score
// engine is out of scope for Priority 1 (see
// docs/AE_GROW_PRIORITY_1_DAILY_COMMAND_CENTRE_REPORT.md).
//
// AE GROW PRIORITY 3 — additive communication-action metadata only. Each
// action already carries a stable partyId; contactEmail/contactMobile and
// the new "email"/"sms"/"view_contact" availableActions entries below are
// pulled from the exact same parties join each query already performs
// (no new query), so the Grow Today frontend can render Email/SMS/View
// Contact buttons without a second round-trip. None of Priority 1's
// ranking/priority/threshold/dedup/prioritisation logic is touched.
//
// AE GROW PRIORITY 5 REMEDIATION — Rule F, additive. Surfaces Property
// Intelligence signals (packages/db/src/schema/propertyIntelligence.ts,
// lib/propertyIntelligence/signals.ts) as Grow Today items under the exact
// same conditions the remediation objective specifies: active, not
// expired, not dismissed, belonging to the authenticated brokerage, linked
// to accessible records, gated by grow.propertyIntelligence.read, and
// meeting a minimum evidence bar (see PROPERTY_INTELLIGENCE_MIN_CONFIDENCE_BANDS
// below). This file still does not know what an entitlement is — the
// caller (routes/grow.ts) resolves grow.propertyIntelligence.read and
// passes a plain boolean into getGrowTodaySummary's new options
// parameter, exactly the same "resolve cross-cutting concerns at the
// route, keep the rule engine itself concern-free" boundary this file
// already draws around auth/session concepts. Rules A-E's own logic,
// signatures, and behaviour are completely untouched by this addition —
// see routes/__tests__/growToday.test.ts's regression coverage.
//
// =====================================================================
// AE GROW "BROKERAGE-WIDE SIGNAL SWEEP" STAGE 3 — PRIORITISATION,
// EXPLAINABILITY AND THE DAILY COMMAND CENTRE.
// =====================================================================
//
// Stage 1 made the sweep WRITE brokerage-wide, party-anchored signals.
// Everything below is what the agent actually SEES. Four concrete defects on
// this read path meant a correctly-written signal was, in practice, invisible
// or misleading; each is fixed here and each has a test that fails without
// the fix.
//
//  1. PARTY-LESS SIGNALS WERE SILENTLY DROPPED. Rule F's query used
//     innerJoin(parties), so the party-anchored, property-LESS signals stage 1
//     deliberately made possible — a contact with no property holding a
//     signal — never reached Today at all, and neither did the
//     observation-derived signals that legitimately have no contact. The join
//     is now a leftJoin (with the tenant id in the join predicate, which the
//     innerJoin never had), GrowTodayAction.partyId is nullable, and a
//     contact-less card simply renders without the contact-specific actions.
//
//  2. SIGNALS SORTED LAST BECAUSE dueAt WAS NULL. The comparator put every
//     dated item ahead of every undated one, so a signal sat behind every
//     dated card in its band — i.e. off the bottom of the working day. Every
//     action now carries an explicit rankScore and the comparator orders by
//     (priority band, rankScore desc, then the original dueAt/lastActivityAt
//     tiebreak). The band is still decided FIRST and is unchanged, and the
//     Rules A-E baselines in lib/grow/signalRanking.ts are arranged so that
//     A-E's ordering among themselves is byte-for-byte what it was before.
//
//  3. THE `Emerging` BAND WAS FILTERED OUT ENTIRELY. That band is exactly the
//     "future seller with no obvious current signal" population the strategy
//     targets, and discarding it turned the sweep into a present-tense alert
//     engine. Emerging signals now surface, ranked low (a quiet Keep Warm
//     card), capped at MAX_EMERGING_SIGNAL_ACTIONS per day with the remainder
//     reported as a count rather than silently dropped.
//
//  4. THERE WAS NO PRIORITISATION AND NO EXPLANATION. Ranking now lives in
//     lib/grow/signalRanking.ts — a pure, self-contained module computed at
//     READ time from columns that already exist (signal type, confidence
//     band, evidence, source, re_raise_count, recency, contactability,
//     existing relationship state). It returns a score, the ITEMISED factors
//     that produced it, and a plain-language narrative the agent can act on
//     and repeat to a homeowner. A bare score is never surfaced on its own.
//
// TWO THINGS THIS FILE STILL DOES NOT DO, AND MUST NEVER DO:
//
//   - IT NEVER CONTACTS ANYBODY. Nothing on this path sends, schedules, or
//     queues an outbound message. A signal is surfaced and ranked; the agent
//     decides. There is no code path from a high rankScore to a customer
//     communication, and there must never be one.
//   - IT NEVER WEAKENS CONSENT. See the block immediately below.
//
// =====================================================================
// STAGE 3 — READ-TIME CONTACTABILITY (security finding P1-3).
// =====================================================================
//
// THE DEFECT. Stage 1 enforced contactability only at SIGNAL-RAISE time, and
// the surfacing path applied no consent filter at all. That leaves a real
// ordering in which a suppressed contact is surfaced forever:
//
//   1. Contact C has no consent rows; the sweep raises an Active signal with
//      expiresAt NULL (every internal rule sets NULL).
//   2. C is later recorded DNC LISTED, or suppressed on every channel.
//   3. The next sweep drops C's candidate BEFORE the write, so the existing
//      row is never refreshed...
//   4. ...but the sweep deliberately keeps suppressed candidates in its
//      `supported` set, so expireUnsupportedSignals does not retire the row
//      either...
//   5. ...and expireSignalsPastExpiry cannot touch it, because expires_at is
//      NULL.
//
// The row is frozen Active forever and Rule F kept surfacing it — together
// with the contact's email and mobile — after they went on the Do Not Call
// register. The sweep's own comment states the intended design ("the
// contactability filter must hide a contact, never silently retire their
// history"); nothing implemented the hiding. This file is where it belongs,
// because hiding is a READ-path decision: the history stays intact on the
// row, exactly as designed.
//
// THE FIX, AND THE ONE DISTINCTION IT DRAWS. loadContactabilityFilter() is
// consulted on every read, for every rule, and the result decides between two
// treatments:
//
//   HIDDEN ENTIRELY — the SYSTEM-INITIATED PROSPECTING rules: Rule F
//     (Property Intelligence signals) and Rule D (the generic "cold contact,
//     reach out to reconnect" nudge). These exist purely to suggest
//     approaching someone. For a contact who must not be approached the
//     correct number of suggestions is zero, and the correct amount of
//     contact detail to return is none. A withheld signal is still counted in
//     GrowTodaySignalSummary.withheldDoNotContact so the surface can be
//     honest that something was held back, and it remains fully visible,
//     reviewable and dismissible on the contact/property record.
//
//   SHOWN, BUT NEVER AS OUTREACH — the AGENT'S OWN DATED COMMITMENTS: Rules
//     A/B/C (an opportunity follow-up the agent scheduled) and Rule E (an
//     appraisal follow-up the agent scheduled). Deleting these would erase an
//     obligation a human actually made and leave them unable to see why it
//     vanished. They are surfaced with contactEmail/contactMobile forced to
//     NULL in the response itself — so no channel affordance can be rendered
//     even by a frontend that ignores the flag — with the email/sms
//     availableActions removed, rank pinned to 0, and recommendedAction
//     replaced by DO_NOT_CONTACT_RECOMMENDED_ACTION. "Reach out to
//     reconnect" is exactly the sentence such a card must never carry.
//     F-1 applies this same treatment to Open growCommitments rows that are
//     due today or overdue. Completed and Cancelled rows are not read.
//
// This filter is a READ. It resolves no consent policy, picks no channel, and
// writes nothing — lib/propertyIntelligence/contactability.ts's own header
// documents that boundary and nothing here widens it. When a tenant has no
// DNCR or suppression rows, it is two statements that match nothing and
// change no behaviour at all. Those rows are appended by
// lib/consentControlsPersistence.ts, and the Grow consent routes call those
// writers. This read does not.
//
// STILL OUTSTANDING, AND NOT FIXABLE FROM THIS FILE:
// lib/propertyIntelligence/signals.ts's listActiveSignalsForParty() — the
// Contact 360 read — has the identical hole and is owned by the sweep agent.
// See this change's report.
//
// =====================================================================
// AE GROW COMPLETION PROGRAM — SLICE W2-A. BOUNDING, PER-PARTY
// CONSOLIDATION, AND THE QUERY REWRITE.
// =====================================================================
//
// Everything above made this surface CORRECT. None of it made it SURVIVE a
// real brokerage. Three families of defect are fixed below; each has a named
// constant, a comment explaining the number, and a test.
//
// -------------------------------------------------------------------
// 1. NOTHING STRONG WAS EVER CAPPED (F-2).
// -------------------------------------------------------------------
//
// MAX_EMERGING_SIGNAL_ACTIONS was the ONLY cap in the whole pipeline, and it
// protected the WEAKEST band. Rules A/B/C emit one card per open opportunity,
// Rule E one per FOLLOW_UP appraisal, Rule D one per cold party, and Rule F
// one per Active non-Emerging signal — all uncapped — and priorityActions was
// then returned in full, with no LIMIT in the query, no pagination in the
// route and no windowing in the UI.
//
// The arithmetic that makes that a day-one defect rather than a theoretical
// one: the sweep writes up to 5,000 candidates per brokerage per run, and a
// 5,000-contact brokerage importing a database that is mostly two years
// dormant produces re_engagement_opportunity at StrongIndicator, scoring
// 40 (band) + 10 (type) + 6 (internal source) + 6 (no open opportunity)
// + 6 (never contacted) = 68, against SIGNAL_DO_TODAY_MIN_SCORE of 55. That
// is THOUSANDS of Do Today cards on the first morning.
//
// Two bounds are added, at two different layers, because they solve two
// different problems:
//   - the *_ROW_CAP constants bound what each rule READS, so the process
//     never materialises a whole tenant's joined contact strings in heap;
//   - MAX_PRIORITY_ACTIONS bounds what the response RETURNS, after the
//     deterministic sort, so the strongest cards always survive the cut.
// Both are stated, never silent: see GrowTodaySignalSummary.
//
// -------------------------------------------------------------------
// 2. THERE WAS NO DE-DUPLICATION AMONG SIGNALS (F-3 — DECISION 3).
// -------------------------------------------------------------------
//
// Read this carefully, because MOST of DECISION 3 was already built and is
// deliberately left alone here. Write-time exclusion already enforces "no open
// opportunity, no open commitment" (evaluation.ts). Read-time signal-vs-cold
// de-dup already works: a surfaced signal adds its partyId to
// partyIdsWithOpportunityAction and Rule D skips it. F-5 is the case where
// Rule D is the card that wins: its rank is strictly higher than the party's
// best signal (ruleDWinsOverSignal), or the Emerging cap held that signal
// back. The losing signal is not discarded. It rides on the cold card as
// relatedSignals. A tie keeps the signal, which is the more specific card.
//
// The genuine gap was narrower: nothing de-duplicated signals AGAINST EACH
// OTHER. partyIdsWithOpportunityAction suppressed only Rule D, never a sibling
// signal, so a long-tenure owner dormant 200 days with no open opportunity got
// BOTH long_ownership_tenure AND re_engagement_opportunity — two cards, one
// person. That is DECISION 3's "or stronger signal" clause, and it was
// unimplemented and untested.
//
// The fix is READ-PATH consolidation, consistent with this file's existing
// precedent that hiding is a READ-path decision (see the contactability block
// above). Every row is preserved, nothing is written, and it is reversible by
// deleting one loop. The deliberately REJECTED alternative was tightening the
// write path with a "no stronger signal" subquery in reEngagementCandidates:
// that would put a second statement inside a rule whose one-statement-per-rule
// shape EVALUATION_STATEMENTS_PER_SCOPE asserts, and would hide rows the
// Contact 360 review surface may legitimately want to show.
//
// THREE THINGS THE CONSOLIDATION MUST NOT GET WRONG:
//   - PARTY-LESS SIGNALS MUST NOT COLLAPSE. A signal with partyId null is
//     anchored to a PROPERTY. Grouping them by partyId would fold every
//     property in the brokerage into one phantom "null" bucket and delete all
//     but one. The identical trap is already documented for the
//     contactsNeedingAttention count at the bottom of this file. They bypass
//     grouping entirely.
//   - THE LOSERS MUST SURVIVE. DECISION 3 requires the evidence to be
//     preserved, so every suppressed sibling rides on the winning card as a
//     relatedSignals entry. AE can then show its working: "this is the card,
//     and here is the other thing I know about this person".
//   - THE EMERGING CAP MUST COUNT CARDS, NOT ROWS. It is applied AFTER
//     grouping now. Before, one party with four Emerging signals could eat
//     four of the ten slots on their own.
//
// Which sibling wins is a REAL, PENDING PRODUCT DECISION. See
// PER_PARTY_SIGNAL_SELECTOR in lib/grow/signalRanking.ts, which is the single
// place it is decided and the single place it would be flipped.
//
// -------------------------------------------------------------------
// 3. THE QUERY REWRITE (I-2, I-4, I-5, I-16).
// -------------------------------------------------------------------
//
// I-2, the worst of them: this function used to SELECT EVERY ROW of
// grow_activities for the brokerage and compute a max-per-party in a JavaScript
// loop. grow_activities is the only Grow table that grows with USAGE rather
// than with inventory, and Grow Today is the landing surface every agent hits
// every morning — so at a realistic 250,000 activity rows, every single
// /grow/today request shipped 250,000 rows over the wire to compute at most a
// few thousand dates. It is now a `max(occurred_at) ... group by party_id`
// aggregate, restricted to the party ids the other rules actually asked about.
//
// I-4: the other four tenant reads were unbounded too, and each joins
// parties/properties, so every row carried a name, an email, a mobile and an
// address. They are now capped and ordered so that truncation removes the
// LEAST relevant rows, and the truncation is stated rather than hidden.
//
// lib/ai/coaching/metrics.ts is the model followed here — tenant-scoped,
// bounded by named *_ROW_CAP constants, and honest about truncation as a
// stated limitation rather than presenting a partial list as complete. Its
// constants are deliberately NOT imported: growContext.ts already depends on
// this file, and importing back out of lib/ai/ would invert that layering.
//
// THE STATEMENT COUNT. It was five parallel reads plus two serial
// contactability statements (seven). W2-A made it the rule reads, then the
// activity aggregate and the two contactability statements in parallel: six
// statements without Property Intelligence and seven with it (the signal read
// is the one that is entitlement-gated). F-1 adds one bounded
// grow_commitments read to that first wave, so the count is seven without
// Property Intelligence and eight with it. The second wave still has to
// follow the first because it is scoped BY the first wave's party ids —
// which is exactly what makes it bounded.

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionType =
  | "opportunity_follow_up"
  | "opportunity_no_action_set"
  | "relationship_cold"
  | "appraisal_follow_up"
  // AE Grow Priority 5 Remediation — additive: a Property Intelligence
  // signal surfaced by Rule F below.
  | "property_intelligence_signal"
  // F-1 — an Open growCommitments row that is due today or overdue. Not an
  // opportunity next-action and not an appraisal follow-up.
  | "commitment";

export type GrowTodayActionButton =
  | { action: "add_note" }
  | { action: "view_property"; propertyId: number }
  | { action: "update_next_action"; opportunityId: number }
  | { action: "ask_ae" }
  // AE Grow Priority 3 — additive: rendered only when the contact has that
  // channel on file (email/sms) or unconditionally (view_contact, since
  // partyId is always present on every action).
  | { action: "email"; partyId: number }
  | { action: "sms"; partyId: number }
  | { action: "view_contact"; partyId: number }
  // AE Grow Priority 4 -- additive: rendered only on an appraisal follow-up card.
  | { action: "view_appraisal"; appraisalId: number };

/**
 * W2-A (F-3 / DECISION 3) — a signal AE knows about for this contact that did
 * NOT become the card, carried on the card that did so the evidence is never
 * lost. Two ways that happens, distinguished by `relationship`:
 *
 *   - "consolidated_into_this_card": this signal lost the one-card contest.
 *     Either a sibling signal won on rankScore (see PER_PARTY_SIGNAL_SELECTOR),
 *     or Rule D's cold-contact card outranked it (ruleDWinsOverSignal). The
 *     evidence rides on the card that was kept.
 *   - "withheld_by_daily_cap": every signal for this party was held back by
 *     MAX_EMERGING_SIGNAL_ACTIONS, so a Rule D cold-contact card surfaced
 *     instead and carries them as its explanation (F-5).
 *
 * The row itself is untouched in either case and remains fully visible on the
 * contact and property records.
 */
export interface GrowTodayRelatedSignal {
  signalId: number;
  signalType: string;
  title: string;
  /** The signal's own stored, already-hedged explanation. Never re-worded here. */
  explanation: string;
  confidenceBand: string;
  confidenceBandLabel: string;
  /** What it scored. Shown only alongside the winning card's own explanation, never alone. */
  rankScore: number;
  relationship: "consolidated_into_this_card" | "withheld_by_daily_cap";
}

/**
 * Stage 3 — the agent-readable explanation that rides with a surfaced
 * signal. `factors` is the itemised breakdown of the rankScore, so the
 * ranking is auditable rather than an opaque number; `headline` /
 * `talkingPoint` / `caution` are what the agent reads and (for the talking
 * point) may choose to say.
 *
 * W2-A (F-5) — NO LONGER SIGNAL-ONLY. Rule D's cold-contact card used to emit
 * whyItMatters: null unconditionally, so when a cap withheld a contact's
 * signal the surviving cold card carried nothing but "No contact recorded for
 * N days." and could not explain why AE had chosen it. A Rule D card now
 * carries this too.
 *
 * confidenceBand / confidenceBandLabel are therefore NULLABLE: a cold-contact
 * card has no stored confidence band, because it is not a signal. That
 * nullability is load-bearing on the web side — apps/web/src/lib/growToday.ts's
 * rankSummaryLine() renders "priority N/100" for any non-null whyItMatters,
 * and a cold card must not suddenly start displaying a score, so the mirror
 * guards on a null band. Still null on Rules A/B/C and E, whose `reason` and
 * `recommendedAction` are already the whole explanation.
 */
export interface GrowTodayWhyItMatters extends SignalNarrative {
  confidenceBand: string | null;
  confidenceBandLabel: string | null;
  factors: SignalRankingFactor[];
  /** W2-A — see GrowTodayRelatedSignal. Empty when nothing was folded in. */
  relatedSignals: GrowTodayRelatedSignal[];
}

export interface GrowTodayAction {
  id: string;
  type: GrowTodayActionType;
  priority: GrowTodayPriority;
  // Stage 3: nullable. An observation-derived signal legitimately has no
  // linked contact, and dropping those rows (the old innerJoin) hid real
  // information rather than protecting anything.
  partyId: number | null;
  contactName: string;
  // AE Grow Priority 3 — additive: lets the frontend decide whether to
  // render an Email/SMS action without a second lookup.
  //
  // Stage 3: FORCED TO NULL whenever contactability is "do_not_contact", so
  // the API contract itself makes a channel affordance impossible to render
  // for a contact who must not be approached — the guarantee does not depend
  // on the frontend remembering to check a flag.
  contactEmail: string | null;
  contactMobile: string | null;
  relationshipType: string | null;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
  appraisalId: number | null;
  /**
   * F-1 — the growCommitments row this card is about. Null on every other
   * rule. The card is that existing record, not a second commitment model.
   */
  commitmentId: number | null;
  reason: string;
  recommendedAction: string;
  dueAt: string | null;
  lastActivityAt: string | null;
  availableActions: GrowTodayActionButton[];
  /**
   * Stage 3 — 0..100, ordering ONLY. Never a probability, never a
   * "likelihood of selling", and never rendered on its own without the
   * whyItMatters factors that produced it.
   */
  rankScore: number;
  /** Stage 3 — the signal's stored confidence band; null on Rules A-E. */
  confidenceBand: string | null;
  /** Stage 3 — stage 1's contactability verdict, re-checked at read time. */
  contactability: SignalContactability;
  /** Stage 3 — set only when contactability is "do_not_contact". */
  contactabilityNote: string | null;
  /** Stage 3 — see GrowTodayWhyItMatters. Null on Rules A-E. */
  whyItMatters: GrowTodayWhyItMatters | null;
}

/**
 * Stage 3 — what happened to this brokerage's signals on this read, so the
 * screen can be honest about what it is NOT showing. Always present; all
 * zeroes when the caller is not entitled to Property Intelligence.
 */
export interface GrowTodaySignalSummary {
  /** Signal cards actually on today's list. */
  surfaced: number;
  /** Of those, how many are the weakest ("Emerging") band. */
  emergingSurfaced: number;
  /**
   * Emerging-band signals that qualified but were held back by
   * MAX_EMERGING_SIGNAL_ACTIONS. They remain fully visible on the contact and
   * property records — this count exists so the screen can say so rather than
   * pretending they do not exist.
   */
  emergingWithheld: number;
  /**
   * Signals that qualified on every other condition but were WITHHELD because
   * their contact must not be contacted (finding P1-3). Reported as a count so
   * the surface can be honest that something was held back without naming or
   * describing the contact — the row itself is untouched and remains visible
   * on the contact/property record.
   */
  withheldDoNotContact: number;
  /**
   * W2-A (F-3 / DECISION 3) — signals that lost the per-party selection to a
   * stronger sibling. NOT hidden: each one rides on the winning card as a
   * whyItMatters.relatedSignals entry, so this is a count of cards merged, not
   * of evidence discarded.
   */
  consolidatedIntoStrongerSignal: number;
  /**
   * W2-A (F-2) — cards of ANY rule (not only signals) dropped by
   * MAX_PRIORITY_ACTIONS after the full list was sorted. Because the cut
   * happens after the sort, what is dropped is always the lowest-ranked tail
   * of the day.
   */
  withheldByActionCap: number;
  /**
   * W2-A (I-4) — plain-language statements of what this response is BOUNDED
   * by, in the shape lib/ai/coaching/metrics.ts established: a surface that
   * truncates its input says so, rather than presenting a partial list as if
   * it were complete. Empty when nothing was truncated, which is the normal
   * case for every brokerage below the caps.
   */
  limitations: string[];
}

export interface GrowTodaySummary {
  generatedAt: string;
  // Distinguishes "this brokerage has never used Grow" (purposeful onboarding
  // empty state) from "this brokerage uses Grow and is simply caught up
  // today" (a plain "nothing needs attention" state) — see Grow.tsx. Not
  // itself rendered as a stat tile; the four counts below are the only
  // headline numbers shown, matching the "small set of headline indicators,
  // no vanity metrics" requirement.
  hasAnyGrowData: boolean;
  counts: {
    priorityActions: number;
    followUpsDue: number;
    openOpportunities: number;
    contactsNeedingAttention: number;
  };
  priorityActions: GrowTodayAction[];
  /** Stage 3 — see GrowTodaySignalSummary. */
  signalSummary: GrowTodaySignalSummary;
}

// A relationship/opportunity with no recorded contact in this many days (or
// ever) is surfaced as "Keep Warm".
//
// W2-A (F-7): this used to be declared here AND in lib/grow/signalRanking.ts,
// with a comment on each saying it matched the other. It is now declared once,
// in signalRanking.ts (the pure leaf module this file already imports from),
// and imported — see that constant's own comment. Re-exported so nothing that
// reads "Grow Today's cold threshold" from this module breaks.
export { COLD_CONTACT_THRESHOLD_DAYS };

/* ---------------------------------------------------------------------
 * W2-A (I-4, I-5) — WHAT EACH RULE IS ALLOWED TO READ.
 *
 * Every one of these bounds a query that was previously "every matching row
 * in the tenant", joined to parties/properties so that each row also carried a
 * name, an email, a mobile and a formatted address. On a large brokerage that
 * was several megabytes of heap per request, on the one endpoint every agent
 * loads every morning.
 *
 * THE VALUES DELIBERATELY MATCH lib/ai/coaching/metrics.ts's own *_ROW_CAP
 * constants for the same tables, so the two bounded Grow read surfaces agree
 * on how much of a tenant they will look at. They are not imported from there:
 * lib/ai/context/growContext.ts already depends on THIS file, and importing
 * back out of lib/ai/ would invert that dependency.
 *
 * ORDERING IS PART OF THE CAP. A LIMIT without an ORDER BY truncates
 * arbitrarily and non-deterministically; each query below orders so that the
 * rows most likely to matter are the rows that survive, and so that repeating
 * the same request returns the same rows.
 * -----------------------------------------------------------------*/

/** Active relationships read for Rule D. Ordered so truncation cannot change which relationship wins a party — see the query. */
export const GROW_TODAY_RELATIONSHIP_ROW_CAP = 2000;
/** Open opportunities read for Rules A/B/C. Ordered by due date, so dated commitments outlive undated ones. */
export const GROW_TODAY_OPPORTUNITY_ROW_CAP = 1000;
/** FOLLOW_UP appraisals read for Rule E. Ordered by follow-up date, so the most overdue survive. */
export const GROW_TODAY_APPRAISAL_ROW_CAP = 500;
/**
 * F-1 — Open commitments whose due date is today or earlier. Ordered by due
 * date, so the most overdue survive a truncation. Future-dated Open rows are
 * not part of Today (same rule as a future opportunity next-action).
 */
export const GROW_TODAY_COMMITMENT_ROW_CAP = 500;
/** Active Property Intelligence signals read for Rule F. Ordered by confidence band, so the strongest evidence survives. */
export const GROW_TODAY_SIGNAL_ROW_CAP = 500;

/**
 * W2-A (F-2) — THE TOTAL NUMBER OF CARDS ONE /grow/today RESPONSE MAY CARRY.
 *
 * THIS IS A TECHNICAL SAFETY BOUND, NOT A PRODUCT DECISION. It is not a claim
 * about how many actions an agent should work in a day, and it must not be
 * read as one. The Project Owner has not set a number, and inventing a
 * commercial one here would be worse than inventing none: the number that
 * belongs on this screen is a coaching judgement, and it is theirs to make.
 * What this constant does is stop the response from being unbounded, which is
 * a property of the code and squarely an engineering concern.
 *
 * WHY 200.
 *   - It is roughly an ORDER OF MAGNITUDE above the largest plausible genuine
 *     working day, so it cannot silently become the product rule by accident.
 *     For comparison, lib/ai/context/growContext.ts — the only other consumer
 *     of this list — already slices it to 20 before showing anything to the
 *     model.
 *   - It bounds the serialised response at a few hundred kilobytes rather
 *     than the several megabytes an uncapped list produces, and the frontend
 *     renders this list flat, with no pagination and no windowing.
 *   - It is applied AFTER the deterministic sort, so the cards that survive
 *     are always the highest-ranked ones; a cap that truncated before sorting
 *     would be arbitrary and is not what this does.
 *
 * WHAT IS CUT IS REPORTED, NEVER SILENT: GrowTodaySignalSummary.
 * withheldByActionCap counts it and the web mirror states it, following the
 * same honesty rule as emergingWithheld and withheldDoNotContact.
 */
export const MAX_PRIORITY_ACTIONS = 200;

// AE GROW "Brokerage-wide Signal Sweep" stage 3 — THE EMERGING BAND IS NO
// LONGER FILTERED OUT.
//
// Priority 5 Remediation excluded the "Emerging" band from Today entirely, on
// the reasoning that the weakest band was "not yet worth a daily action
// item". That reasoning is wrong for the strategy this product is actually
// executing: AE exists to identify and NURTURE FUTURE SELLERS, including
// contacts with no obvious current signal — and "no obvious current signal"
// is, definitionally, the Emerging band. Filtering it removed exactly the
// population the sweep was built to find and left behind a present-tense
// alert engine.
//
// Emerging signals are therefore surfaced, but they are surfaced HONESTLY:
// lib/grow/signalRanking.ts gives the band the lowest evidence weight by a
// wide margin, so in practice they land in Keep Warm below every stronger
// item, and the cap below stops a large brokerage's long tail from burying
// the day. Whatever the cap holds back is reported as a count
// (GrowTodaySignalSummary.emergingWithheld), never silently discarded — and
// every one of them remains fully visible on the contact and property
// records regardless.
const MAX_EMERGING_SIGNAL_ACTIONS = 10;

// Stage 3 — read-time contactability. See this file's stage 3 header block
// for the HIDE / SHOW-BUT-NEVER-AS-OUTREACH split these two constants serve:
// they are used only by the rules that survive suppression (an agent's own
// dated commitment), never by the prospecting rules, which withhold the item
// entirely.
const DO_NOT_CONTACT_RECOMMENDED_ACTION =
  "Do not contact. This contact is on a do-not-contact record or is suppressed on every channel — review the contact record before taking any action at all.";
const DO_NOT_CONTACT_NOTE =
  "A do-not-contact listing or a full-channel suppression is on file for this contact. AE will not present them as someone to reach out to, and no outreach action is offered here.";

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function formatLocalDate(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone });
}

/**
 * Exclusive end of the local calendar day `now` falls in.
 *
 * startOfNextLocalDay adds a fixed 24h, which is an hour early on a fall-back
 * day. Step forward with the existing localDateKey / startOfLocalDay helpers
 * until the calendar day changes, then take that next local midnight. The
 * due-today / overdue decision itself is isToday / isOverdueLocal.
 */
function exclusiveEndOfLocalDay(now: Date, timeZone: string): Date {
  const todayKey = localDateKey(now, timeZone);
  let probe = new Date(startOfLocalDay(now, timeZone).getTime() + 20 * 60 * 60 * 1000);
  for (let step = 0; step < 12 && localDateKey(probe, timeZone) === todayKey; step++) {
    probe = new Date(probe.getTime() + 60 * 60 * 1000);
  }
  return startOfLocalDay(probe, timeZone);
}

function contactDisplayName(party: {
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
}): string {
  if (party.partyOrganisationName) return party.partyOrganisationName;
  const name = `${party.partyFirstName ?? ""} ${party.partyLastName ?? ""}`.trim();
  return name.length > 0 ? name : "Unknown contact";
}

interface RelationshipRow {
  id: number;
  partyId: number;
  propertyId: number | null;
  relationshipType: string;
  isPrimary: boolean;
  validFrom: Date;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
  partyEmail: string | null;
  partyMobile: string | null;
  propertyAddress: string | null;
}

// AE GROW Priority 5 Remediation — Rule F's own read, kept as a standalone
// function (rather than inlined into the Promise.all below like Rules A-E's
// queries) so it can short-circuit to an empty array with zero DB cost when
// includePropertyIntelligenceSignals is false, without the ternary-branch
// typing awkwardness of mixing a Drizzle query builder and Promise.resolve([])
// inline. Reads growOpportunitySignals directly — the exact same table
// lib/propertyIntelligence/signals.ts itself reads and writes — rather than
// importing that module, so this file never takes a dependency on the
// Property Intelligence service/entitlement layer.
interface PropertyIntelligenceSignalRow {
  id: number;
  partyId: number | null;
  propertyId: number | null;
  signalType: string;
  title: string;
  explanation: string;
  confidenceBand: string;
  source: string;
  evidence: unknown;
  reRaiseCount: number;
  computedAt: Date | null;
  sourceTimestamp: Date | null;
  partyFirstName: string | null;
  partyLastName: string | null;
  partyOrganisationName: string | null;
  partyEmail: string | null;
  partyMobile: string | null;
  propertyAddress: string | null;
}

async function fetchPropertyIntelligenceSignalRows(
  brokerageId: number,
  enabled: boolean,
  now: Date,
  restrictToPropertyIds: number[] | null,
): Promise<PropertyIntelligenceSignalRow[]> {
  if (!enabled) return [];
  return db
    .select({
      id: growOpportunitySignals.id,
      partyId: growOpportunitySignals.partyId,
      propertyId: growOpportunitySignals.propertyId,
      signalType: growOpportunitySignals.signalType,
      title: growOpportunitySignals.title,
      explanation: growOpportunitySignals.explanation,
      confidenceBand: growOpportunitySignals.confidenceBand,
      // Stage 3 — the ranking inputs. Every one of these is a column stage 1
      // already writes; nothing new is stored to make ranking possible.
      source: growOpportunitySignals.source,
      evidence: growOpportunitySignals.evidence,
      reRaiseCount: growOpportunitySignals.reRaiseCount,
      computedAt: growOpportunitySignals.computedAt,
      sourceTimestamp: growOpportunitySignals.sourceTimestamp,
      partyFirstName: parties.firstName,
      partyLastName: parties.lastName,
      partyOrganisationName: parties.organisationName,
      partyEmail: parties.email,
      partyMobile: parties.mobile,
      propertyAddress: properties.formattedAddress,
    })
    .from(growOpportunitySignals)
    // STAGE 3 DEFECT FIX. This was an innerJoin, which silently dropped every
    // signal with no linked party — including the party-anchored,
    // property-less signals stage 1 went out of its way to make possible, and
    // every observation-derived signal, which has no contact by construction.
    // A read path that deletes rows the write path deliberately created is a
    // bug, not a "cheap extra guard": the contract said party-less signals
    // could exist and this join said they could not.
    //
    // The tenant id is now IN the join predicate, which the innerJoin never
    // had — so a party id belonging to another brokerage can never
    // contribute a name, email or mobile to this response, even in the
    // presence of a bad partyId. Same hardening applied to properties.
    .leftJoin(parties, and(eq(growOpportunitySignals.partyId, parties.id), eq(parties.brokerageId, brokerageId)))
    .leftJoin(properties, and(eq(growOpportunitySignals.propertyId, properties.id), eq(properties.brokerageId, brokerageId)))
    .where(
      and(
        eq(growOpportunitySignals.brokerageId, brokerageId),
        eq(growOpportunitySignals.status, "Active"),
        // STAGE 3 DEFECT FIX: no confidence-band filter. See
        // MAX_EMERGING_SIGNAL_ACTIONS above for why the Emerging band is
        // ranked down rather than discarded.
        or(isNull(growOpportunitySignals.expiresAt), gt(growOpportunitySignals.expiresAt, now)),
        // Own-property scope. A signal with no property stays. Undefined
        // when the caller is brokerage-wide, so this statement is unchanged.
        visibleLinkedPropertySql(growOpportunitySignals.propertyId, restrictToPropertyIds),
      ),
    )
    // W2-A (I-4) — BOUNDED, AND BOUNDED IN THE RIGHT DIRECTION.
    //
    // This read was previously every Active signal in the brokerage. The sweep
    // writes up to 5,000 candidates per run, and each row here drags a name,
    // an email, a mobile and a formatted address along with it.
    //
    // The true rank is computed in Node (lib/grow/signalRanking.ts is pure and
    // has no database access by design), so the ORDER BY cannot use it. The
    // confidence band is the closest honest proxy available in SQL: it is the
    // single largest lever in the score by a wide margin — 40 / 26 / 12 points
    // against a type weight that never exceeds 22 — so ordering by band keeps
    // the strongest evidence and discards the weakest. The row id breaks ties,
    // which is what makes the truncation, and therefore the whole card list,
    // identical across two identical requests.
    .orderBy(
      sql`case ${growOpportunitySignals.confidenceBand}
            when 'StrongIndicator' then 0
            when 'WorthReviewing' then 1
            when 'Emerging' then 2
            else 3
          end`,
      asc(growOpportunitySignals.id),
    )
    .limit(GROW_TODAY_SIGNAL_ROW_CAP);
}

/**
 * W2-A (I-2) — THE SINGLE WORST SCALE PROBLEM IN GROW, AND THE ONE THAT
 * ARRIVES FIRST.
 *
 * WHAT THIS REPLACES. Grow Today used to run
 *
 *     select party_id, occurred_at from grow_activities where brokerage_id = ?
 *
 * — every activity row the brokerage has ever recorded — and then reduce it to
 * a max-per-party with a JavaScript loop. grow_activities is the ONLY Grow
 * table that grows with USAGE rather than with inventory: it accumulates a row
 * every time anybody does anything, forever, and it is never pruned. At a
 * realistic 250,000 rows that is 250,000 rows across the wire, parsed into
 * 250,000 Date objects, to produce a Map of at most a few thousand entries —
 * on the landing surface every agent in the tenant loads every morning, and
 * (via growContext.ts) underneath every single Grow "Ask AE" question before
 * one token is sent.
 *
 * WHAT IT DOES INSTEAD. The aggregate runs in the database, which is what
 * databases are for, and returns ONE row per party.
 *
 * WHY THERE IS NO ROW CAP HERE, DELIBERATELY. Two reasons, and the second is a
 * correctness argument rather than a performance one.
 *
 *   - It does not need one. The result is already bounded by the caller: it
 *     asks only about the party ids the four capped rule reads actually
 *     returned, so it can never exceed their combined caps.
 *   - A cap here would FABRICATE FACTS. Absence from this map means "no
 *     contact has ever been recorded for this person", which Rule D renders as
 *     "No contact recorded yet." and which the signal ranker scores with
 *     NEVER_CONTACTED_POINTS. Truncating the map would therefore invent
 *     coldness for real contacts — telling an agent nobody has ever spoken to
 *     somebody they called last week. A bound that produces a confident false
 *     statement is worse than the unbounded read it replaced, and no ordering
 *     avoids it: keeping the freshest parties mislabels the coldest, keeping
 *     the coldest mislabels the freshest.
 *
 * THE INDEX THIS WANTS (not added here — index work is batched into its own
 * migration PR): grow_activities (brokerage_id, party_id, occurred_at desc),
 * which turns this into an index-only scan. It is correct without it.
 */
async function fetchLastActivityByParty(
  brokerageId: number,
  partyIds: number[],
  restrictToPropertyIds: number[] | null,
): Promise<Map<number, Date>> {
  const lastActivityByParty = new Map<number, Date>();
  if (partyIds.length === 0) return lastActivityByParty;

  // ONE bind parameter (a JSON array expanded server-side) rather than N, so
  // the statement text is identical whatever the batch contains and no party
  // id is ever concatenated into SQL — the same technique
  // lib/propertyIntelligence/contactability.ts uses for the same reason. The
  // ids are already integer-filtered by the caller.
  const idArray = sql`array(select jsonb_array_elements_text(${JSON.stringify(partyIds)}::jsonb)::int)`;

  const rows = await db
    .select({ partyId: growActivities.partyId, lastOccurredAt: max(growActivities.occurredAt) })
    .from(growActivities)
    .where(
      and(
        eq(growActivities.brokerageId, brokerageId),
        isNotNull(growActivities.partyId),
        sql`${growActivities.partyId} = any(${idArray})`,
        // An activity on a property the caller cannot see is not their last
        // contact. Null when the caller is brokerage-wide.
        visibleLinkedPropertySql(growActivities.propertyId, restrictToPropertyIds),
      ),
    )
    .groupBy(growActivities.partyId);

  for (const row of rows) {
    // drizzle's max() reuses the column's own driver mapper, so occurredAt
    // decodes here exactly as it did when this loop read raw rows.
    if (row.partyId === null || row.lastOccurredAt === null) continue;
    lastActivityByParty.set(row.partyId, row.lastOccurredAt);
  }
  return lastActivityByParty;
}

/**
 * W2-A — one signal row, scored, plus the siblings for the same party that
 * lost to it. `consolidated` is populated only on a per-party winner and is
 * empty everywhere else, including on every party-less (property-anchored)
 * signal, which never participates in grouping at all.
 */
interface RankedSignalCandidate {
  row: PropertyIntelligenceSignalRow;
  ranking: SignalRanking;
  contactability: SignalContactability;
  consolidated: RankedSignalCandidate[];
}

/**
 * W2-A — projects a signal that did NOT become a card into the evidence that
 * rides on the card that did. Copies the signal's own stored explanation
 * verbatim: a consolidated sibling is never re-worded or re-summarised here,
 * because the whole point of keeping it is that the original evidence
 * survives.
 */
function toRelatedSignal(
  candidate: { row: PropertyIntelligenceSignalRow; ranking: SignalRanking },
  relationship: GrowTodayRelatedSignal["relationship"],
): GrowTodayRelatedSignal {
  return {
    signalId: candidate.row.id,
    signalType: candidate.row.signalType,
    title: candidate.row.title,
    explanation: candidate.row.explanation,
    confidenceBand: candidate.row.confidenceBand,
    confidenceBandLabel: confidenceBandLabel(candidate.row.confidenceBand),
    rankScore: candidate.ranking.score,
    relationship,
  };
}

/**
 * F-5 — the cold card's headline. Empty relatedSignals is the original
 * threshold sentence. A signal Rule D outranked, or one the Emerging cap
 * held back, is named here so the headline does not claim nothing more
 * specific is on file while the evidence sits on the card.
 */
function coldContactHeadline(lastActivity: Date | null, related: GrowTodayRelatedSignal[]): string {
  const gap = lastActivity ? `for ${daysSince(lastActivity)} days` : "at all";
  const surfacedBecause = `AE surfaced this contact because your own records show no recorded contact with them ${gap}`;
  const outranked = related.filter((signal) => signal.relationship === "consolidated_into_this_card");
  const capped = related.filter((signal) => signal.relationship === "withheld_by_daily_cap");
  if (outranked.length === 0 && capped.length === 0) {
    return `${surfacedBecause}, and AE's threshold for "gone quiet" is ${COLD_CONTACT_THRESHOLD_DAYS} days. There is nothing more specific than that on file — this is a gap in the relationship, not evidence about this person.`;
  }
  const sentences = [`${surfacedBecause}.`];
  if (outranked.length > 0) {
    sentences.push(
      outranked.length === 1
        ? "AE also holds a signal about this person, and this gap outranked it, so this is the card that was kept — that signal is listed below and remains fully visible on the contact record."
        : `AE also holds ${outranked.length} signals about this person, and this gap outranked them, so this is the card that was kept — they are listed below and remain fully visible on the contact record.`,
    );
  }
  if (capped.length > 0) {
    sentences.push(
      capped.length === 1
        ? "AE also holds another early-stage signal about this person that today's limit held back — it is listed below and remains fully visible on the contact record."
        : `AE also holds ${capped.length} other early-stage signals about this person that today's limit held back — they are listed below and remain fully visible on the contact record.`,
    );
  }
  return sentences.join(" ");
}

/**
 * E-2 — the action list on a Rule E `appraisal_follow_up` card.
 *
 * `view_appraisal` is always first: it is the card's primary action. When the
 * appraisal is anchored to a property, `view_property` is included in the same
 * shape opportunity cards already emit, so Today can open the existing
 * Property Workspace. A null `propertyId` contributes no `view_property`
 * button — the client must not be asked to render `/properties/null`.
 *
 * Outreach (email/sms) is still withheld for a do-not-contact contact.
 * Viewing the appraisal, the property, or the contact is not outreach and stays.
 */
export function appraisalFollowUpAvailableActions(
  ap: {
    id: number;
    propertyId: number | null;
    partyId: number;
    partyEmail: string | null;
    partyMobile: string | null;
  },
  doNotContact: boolean,
): GrowTodayActionButton[] {
  const availableActions: GrowTodayActionButton[] = [{ action: "view_appraisal", appraisalId: ap.id }];
  if (ap.propertyId) availableActions.push({ action: "view_property", propertyId: ap.propertyId });
  if (!doNotContact) {
    if (ap.partyEmail) availableActions.push({ action: "email", partyId: ap.partyId });
    if (ap.partyMobile) availableActions.push({ action: "sms", partyId: ap.partyId });
  }
  availableActions.push({ action: "view_contact", partyId: ap.partyId });
  availableActions.push({ action: "ask_ae" });
  return availableActions;
}

export async function getGrowTodaySummary(
  brokerageId: number,
  options?: { includePropertyIntelligenceSignals?: boolean; now?: Date; restrictToPropertyIds?: number[] | null },
): Promise<GrowTodaySummary> {
  // AE GROW Priority 5 Remediation — Rule F is entitlement-gated, but this
  // function never resolves grow.propertyIntelligence.read itself. The
  // caller (routes/grow.ts) checks the entitlement and passes the result in
  // here as a plain boolean, preserving this file's existing "no
  // cross-cutting concerns" boundary — growToday.ts has never imported an
  // entitlement or auth concept, and still doesn't.
  const includePropertyIntelligenceSignals = options?.includePropertyIntelligenceSignals ?? false;
  const now = options?.now ?? new Date();
  // null (the default) is brokerage-wide: Brokerage Administrator, Pit Crew,
  // and every existing caller that does not pass a scope. An array is the
  // caller's own properties from restrictedPropertyIdsFor. This function does
  // not decide who is brokerage-wide.
  const restrictToPropertyIds = options?.restrictToPropertyIds ?? null;
  const { timeZone } = await resolveTimeZone({ brokerageId });
  const dueBefore = exclusiveEndOfLocalDay(now, timeZone);
  // W2-A (I-4) — WAVE 1: the rule reads, all capped, all ordered. F-1 adds the
  // commitments read to this wave. The activity aggregate stays OUT of it
  // because it is scoped by the party ids these reads return, which is what
  // makes it bounded.
  const [relationshipRows, opportunityRows, appraisalFollowUpRows, commitmentRows, propertyIntelligenceSignalRows] = await Promise.all([
    db
      .select({
        id: growRelationships.id,
        partyId: growRelationships.partyId,
        propertyId: growRelationships.propertyId,
        relationshipType: growRelationships.relationshipType,
        isPrimary: growRelationships.isPrimary,
        validFrom: growRelationships.validFrom,
        partyFirstName: parties.firstName,
        partyLastName: parties.lastName,
        partyOrganisationName: parties.organisationName,
        partyEmail: parties.email,
        partyMobile: parties.mobile,
        propertyAddress: properties.formattedAddress,
      })
      .from(growRelationships)
      .innerJoin(parties, eq(growRelationships.partyId, parties.id))
      .leftJoin(properties, eq(growRelationships.propertyId, properties.id))
      .where(
        and(
          eq(growRelationships.brokerageId, brokerageId),
          eq(growRelationships.status, "Active"),
          visibleLinkedPropertySql(growRelationships.propertyId, restrictToPropertyIds),
        ),
      )
      // W2-A (I-4) — THE ORDER IS CHOSEN TO MAKE THE CAP HARMLESS TO
      // CORRECTNESS, not merely deterministic. Rule D below reduces these rows
      // to one per party, preferring the primary relationship and then the most
      // recently established one. Sorting by exactly that preference, WITHIN
      // party, means a truncation that cuts through the middle of a party's
      // relationships still leaves that party's WINNING row on the near side of
      // the cut. A truncated party therefore gets the same card it would have
      // got uncapped; only whole parties past the cap are lost, and that is
      // stated in limitations below.
      .orderBy(
        asc(growRelationships.partyId),
        desc(growRelationships.isPrimary),
        desc(growRelationships.validFrom),
        asc(growRelationships.id),
      )
      .limit(GROW_TODAY_RELATIONSHIP_ROW_CAP),
    db
      .select({
        id: growOpportunities.id,
        partyId: growOpportunities.partyId,
        propertyId: growOpportunities.propertyId,
        opportunityType: growOpportunities.opportunityType,
        recommendedNextAction: growOpportunities.recommendedNextAction,
        nextActionDueAt: growOpportunities.nextActionDueAt,
        lastMeaningfulContactAt: growOpportunities.lastMeaningfulContactAt,
        partyFirstName: parties.firstName,
        partyLastName: parties.lastName,
        partyOrganisationName: parties.organisationName,
        partyEmail: parties.email,
        partyMobile: parties.mobile,
        propertyAddress: properties.formattedAddress,
        // W2-A — the TRUE number of open opportunities, computed over the full
        // result set BEFORE the LIMIT applies (Postgres evaluates window
        // functions ahead of LIMIT). counts.openOpportunities is a headline
        // figure on the screen, and a capped read must not quietly turn it into
        // "1,000" for a brokerage that has 5,000. This costs no extra
        // statement and no extra round trip; it is the only read here that
        // needs an exact total, so it is the only one that pays for one.
        totalOpenOpportunities: sql<number>`count(*) over ()`.mapWith(Number),
      })
      .from(growOpportunities)
      .innerJoin(parties, eq(growOpportunities.partyId, parties.id))
      .leftJoin(properties, eq(growOpportunities.propertyId, properties.id))
      .where(
        and(
          eq(growOpportunities.brokerageId, brokerageId),
          eq(growOpportunities.status, "Open"),
          visibleLinkedPropertySql(growOpportunities.propertyId, restrictToPropertyIds),
        ),
      )
      // Dated commitments first, oldest due date leading — Postgres sorts
      // NULLS LAST on ASC, so the "no next action set" rows (which are the
      // least urgent of the three Rule A/B/C outcomes) are the ones a
      // truncation drops first.
      .orderBy(asc(growOpportunities.nextActionDueAt), asc(growOpportunities.id))
      .limit(GROW_TODAY_OPPORTUNITY_ROW_CAP),
    db
      .select({
        id: appraisals.id,
        partyId: appraisals.partyId,
        propertyId: appraisals.propertyId,
        opportunityId: appraisals.opportunityId,
        followUpAt: appraisals.followUpAt,
        followUpNotes: appraisals.followUpNotes,
        partyFirstName: parties.firstName,
        partyLastName: parties.lastName,
        partyOrganisationName: parties.organisationName,
        partyEmail: parties.email,
        partyMobile: parties.mobile,
        propertyAddress: properties.formattedAddress,
      })
      .from(appraisals)
      .innerJoin(properties, eq(appraisals.propertyId, properties.id))
      .innerJoin(parties, eq(appraisals.partyId, parties.id))
      .where(
        and(
          eq(properties.brokerageId, brokerageId),
          eq(appraisals.status, "FOLLOW_UP"),
          visibleRequiredPropertySql(appraisals.propertyId, restrictToPropertyIds),
        ),
      )
      // Most overdue first. Rule E only surfaces an overdue or due-today
      // follow-up, so a future-dated one — which it skips anyway — is exactly
      // what a truncation should drop.
      .orderBy(asc(appraisals.followUpAt), asc(appraisals.id))
      .limit(GROW_TODAY_APPRAISAL_ROW_CAP),
    // F-1 — Open commitments due today or overdue. Completed and Cancelled
    // are excluded here, in the query, so they never become cards. The party
    // and property joins carry the brokerage id so a bad foreign key cannot
    // contribute another tenant's name, email or address.
    db
      .select({
        id: growCommitments.id,
        partyId: growCommitments.partyId,
        propertyId: growCommitments.propertyId,
        opportunityId: growCommitments.opportunityId,
        description: growCommitments.description,
        dueAt: growCommitments.dueAt,
        partyFirstName: parties.firstName,
        partyLastName: parties.lastName,
        partyOrganisationName: parties.organisationName,
        partyEmail: parties.email,
        partyMobile: parties.mobile,
        propertyAddress: properties.formattedAddress,
      })
      .from(growCommitments)
      .innerJoin(parties, and(eq(growCommitments.partyId, parties.id), eq(parties.brokerageId, brokerageId)))
      .leftJoin(properties, and(eq(growCommitments.propertyId, properties.id), eq(properties.brokerageId, brokerageId)))
      .where(
        and(
          eq(growCommitments.brokerageId, brokerageId),
          eq(growCommitments.status, "Open"),
          lt(growCommitments.dueAt, dueBefore),
          visibleLinkedPropertySql(growCommitments.propertyId, restrictToPropertyIds),
        ),
      )
      // Most overdue first. A future-dated Open commitment is already excluded
      // by the due-date predicate, so a truncation drops the least overdue.
      .orderBy(asc(growCommitments.dueAt), asc(growCommitments.id))
      .limit(GROW_TODAY_COMMITMENT_ROW_CAP),
    fetchPropertyIntelligenceSignalRows(brokerageId, includePropertyIntelligenceSignals, now, restrictToPropertyIds),
  ]);

  // W2-A — the exact open-opportunity total, carried on every row by the
  // `count(*) over ()` above and therefore identical on all of them. Zero rows
  // means zero open opportunities, which is the only case where the window
  // function has nowhere to ride.
  const totalOpenOpportunities = opportunityRows[0]?.totalOpenOpportunities ?? 0;

  // W2-A — the one party-id set both wave-2 reads need.
  //
  // I-16: this used to be four concatenated arrays, duplicates and nulls
  // included. A contact on a relationship, an opportunity, an appraisal and a
  // signal contributed that id four times. De-duplicating here sizes the
  // activity aggregate and the JSON payload from the real cardinality.
  // loadContactabilityFilter de-duplicates again before it chunks, so a caller
  // that still concatenates cannot evaluate the same id twice in one pass.
  const partyIdsInScope = [
    ...new Set<number>(
      [
        ...relationshipRows.map((r) => r.partyId),
        ...opportunityRows.map((o) => o.partyId),
        ...appraisalFollowUpRows.map((a) => a.partyId),
        ...commitmentRows.map((c) => c.partyId),
        ...propertyIntelligenceSignalRows.map((s) => s.partyId),
      ].filter((id): id is number => typeof id === "number" && Number.isInteger(id)),
    ),
  ];

  // W2-A — WAVE 2. Both reads are scoped by the same bounded id set and are
  // independent of one another, so they run together: the statement count is
  // the same as before this change (four + one aggregate + contactability's
  // two), with one extra round-trip wave bought in exchange for the activity
  // read no longer being tenant-wide.
  //
  // Stage 3 — CONSENT / CONTACTABILITY, APPLIED AT READ TIME TO EVERY RULE.
  // See this file's "READ-TIME CONTACTABILITY (security finding P1-3)" header
  // block for the defect this closes and for the hide/show split below.
  const [lastActivityByParty, contactabilityFilter] = await Promise.all([
    fetchLastActivityByParty(brokerageId, partyIdsInScope, restrictToPropertyIds),
    loadContactabilityFilter(brokerageId, partyIdsInScope),
  ]);
  const contactabilityOf = (partyId: number | null): SignalContactability =>
    contactabilityFilter.isSuppressed(partyId) ? "do_not_contact" : "contactable";

  const actions: GrowTodayAction[] = [];
  const partyIdsWithOpportunityAction = new Set<number>();
  const partyIdsWithOpenOpportunity = new Set<number>(opportunityRows.map((o) => o.partyId));
  let followUpsDueCount = 0;

  // Rules A/B/C — open opportunities. Each opportunity produces at most one
  // action; a future-dated nextActionDueAt is deliberately NOT surfaced here
  // (that's what the Opportunities tab / future nurture surface is for —
  // Today only shows what needs a decision now or today, or has no plan at
  // all yet).
  for (const o of opportunityRows) {
    let priority: GrowTodayPriority | null = null;
    let reason = "";
    let recommendedAction = o.recommendedNextAction ?? "Follow up on this opportunity.";
    let type: GrowTodayActionType = "opportunity_no_action_set";
    // Stage 3 — every action now carries an explicit rank so that nothing is
    // ordered purely by whether it happens to have a date. See
    // lib/grow/signalRanking.ts's "Baseline ranks" block: these values are
    // chosen so Rules A-E's relative order among themselves is exactly what
    // it was before stage 3.
    let rankScore = 0;

    if (o.nextActionDueAt) {
      type = "opportunity_follow_up";
      if (isOverdueLocal(o.nextActionDueAt, now, timeZone)) {
        priority = "DoNow";
        reason = `Follow-up was due ${formatLocalDate(o.nextActionDueAt, timeZone)}.`;
        rankScore = rankOverdueCommitment(daysSince(o.nextActionDueAt), "opportunity");
        followUpsDueCount++;
      } else if (isToday(o.nextActionDueAt, now, timeZone)) {
        priority = "DoToday";
        reason = "Follow-up is due today.";
        rankScore = rankDueToday("opportunity");
        followUpsDueCount++;
      }
      // A future nextActionDueAt falls through with priority still null and
      // is intentionally not surfaced — see the loop comment above.
    } else if (o.opportunityType === "Appraisal") {
      priority = "DoToday";
      reason = "New appraisal opportunity doesn't have a next action set yet.";
      recommendedAction = o.recommendedNextAction ?? "Set a next action for this appraisal.";
      rankScore = RANK_APPRAISAL_NO_ACTION_SET;
    } else {
      priority = "KeepWarm";
      reason = "This opportunity doesn't have a next action set yet.";
      recommendedAction = o.recommendedNextAction ?? "Decide the next step for this opportunity.";
      rankScore = RANK_OPPORTUNITY_NO_ACTION_SET;
    }

    if (!priority) continue;

    partyIdsWithOpportunityAction.add(o.partyId);
    // Finding P1-3 — an opportunity follow-up is a commitment the AGENT made,
    // so it is never deleted by a suppression; it is shown with every outreach
    // affordance removed. See this file's read-time contactability header.
    const contactability = contactabilityOf(o.partyId);
    const doNotContact = contactability === "do_not_contact";
    const availableActions: GrowTodayActionButton[] = [
      { action: "add_note" },
      { action: "update_next_action", opportunityId: o.id },
    ];
    if (o.propertyId) availableActions.push({ action: "view_property", propertyId: o.propertyId });
    if (!doNotContact) {
      if (o.partyEmail) availableActions.push({ action: "email", partyId: o.partyId });
      if (o.partyMobile) availableActions.push({ action: "sms", partyId: o.partyId });
    }
    availableActions.push({ action: "view_contact", partyId: o.partyId });
    availableActions.push({ action: "ask_ae" });

    const lastActivityAt = o.lastMeaningfulContactAt ?? lastActivityByParty.get(o.partyId) ?? null;

    actions.push({
      id: `opportunity:${o.id}`,
      type,
      priority,
      partyId: o.partyId,
      contactName: contactDisplayName(o),
      contactEmail: doNotContact ? null : o.partyEmail ?? null,
      contactMobile: doNotContact ? null : o.partyMobile ?? null,
      relationshipType: null,
      propertyId: o.propertyId,
      propertyLabel: o.propertyAddress ?? null,
      opportunityId: o.id,
      appraisalId: null,
      commitmentId: null,
      reason,
      recommendedAction: doNotContact ? DO_NOT_CONTACT_RECOMMENDED_ACTION : recommendedAction,
      dueAt: o.nextActionDueAt ? o.nextActionDueAt.toISOString() : null,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
      availableActions,
      rankScore: doNotContact ? 0 : rankScore,
      confidenceBand: null,
      contactability,
      contactabilityNote: doNotContact ? DO_NOT_CONTACT_NOTE : null,
      whyItMatters: null,
    });
  }

  // Rule E -- appraisal follow-ups due (Sec.17). Mirrors Rules A/B/C: only an overdue or
  // due-today follow-up is surfaced here (a future-dated one is what the Appraisal
  // Workspace's own follow-up view is for); surfaced parties are added to
  // partyIdsWithOpportunityAction so the same contact never also shows as a cold
  // relationship in Rule D below.
  for (const ap of appraisalFollowUpRows) {
    if (!ap.partyId) continue;
    if (!ap.followUpAt) continue;
    let priority: GrowTodayPriority;
    let reason: string;
    let rankScore: number;
    if (isOverdueLocal(ap.followUpAt, now, timeZone)) {
      priority = "DoNow";
      reason = `Appraisal follow-up was due ${formatLocalDate(ap.followUpAt, timeZone)}.`;
      rankScore = rankOverdueCommitment(daysSince(ap.followUpAt), "appraisal");
      followUpsDueCount++;
    } else if (isToday(ap.followUpAt, now, timeZone)) {
      priority = "DoToday";
      reason = "Appraisal follow-up is due today.";
      rankScore = rankDueToday("appraisal");
      followUpsDueCount++;
    } else {
      continue;
    }

    partyIdsWithOpportunityAction.add(ap.partyId);

    const lastActivityAtAppraisal = lastActivityByParty.get(ap.partyId) ?? null;
    // Finding P1-3 — like an opportunity follow-up, an appraisal follow-up is
    // a commitment the AGENT scheduled, so suppression removes the outreach
    // affordances rather than the item.
    const contactability = contactabilityOf(ap.partyId);
    const doNotContact = contactability === "do_not_contact";
    // E-2: view_appraisal stays the primary action. When this follow-up is
    // anchored to a property, also offer view_property — the same button
    // opportunity cards already emit — so Today can open that property.
    // A missing propertyId adds nothing: the client must not be handed a
    // view_property button it would have to render as /properties/null.
    const availableActions = appraisalFollowUpAvailableActions(
      {
        id: ap.id,
        propertyId: ap.propertyId,
        partyId: ap.partyId,
        partyEmail: ap.partyEmail,
        partyMobile: ap.partyMobile,
      },
      doNotContact,
    );

    actions.push({
      id: `appraisal:${ap.id}:followup`,
      type: "appraisal_follow_up",
      priority,
      partyId: ap.partyId,
      contactName: contactDisplayName(ap),
      contactEmail: doNotContact ? null : ap.partyEmail ?? null,
      contactMobile: doNotContact ? null : ap.partyMobile ?? null,
      relationshipType: null,
      propertyId: ap.propertyId,
      propertyLabel: ap.propertyAddress ?? null,
      opportunityId: ap.opportunityId,
      appraisalId: ap.id,
      commitmentId: null,
      reason,
      recommendedAction: doNotContact ? DO_NOT_CONTACT_RECOMMENDED_ACTION : ap.followUpNotes ?? "Follow up on this appraisal.",
      dueAt: ap.followUpAt.toISOString(),
      lastActivityAt: lastActivityAtAppraisal ? lastActivityAtAppraisal.toISOString() : null,
      availableActions,
      rankScore: doNotContact ? 0 : rankScore,
      confidenceBand: null,
      contactability,
      contactabilityNote: doNotContact ? DO_NOT_CONTACT_NOTE : null,
      whyItMatters: null,
    });
  }

  // F-1 — Open commitments the agent already made, due today or overdue.
  //
  // The query has already dropped Completed, Cancelled, and anything due
  // on or after the next local midnight in the brokerage zone. What is
  // left is the answer to "what have I already committed to?" on this
  // surface. A future-dated promise stays on the contact record; Today does
  // not bring it forward. An Open commitment due before today's local start
  // stays overdue and stays listed.
  //
  // Contactability is the opportunity/appraisal treatment, not a new one: the
  // card stays (it is an obligation a person recorded) and outreach is
  // stripped. The description stays in `reason` so a do-not-contact card
  // still says what was promised after recommendedAction is replaced.
  //
  // A surfaced party joins partyIdsWithOpportunityAction so Rule D does not
  // also tell the agent to "reach out to reconnect" with someone they
  // already have a due commitment for. That is the same dedup Rules A/B/C
  // and E already apply; it is not a signal de-dup change.
  for (const c of commitmentRows) {
    let priority: GrowTodayPriority;
    let reason: string;
    let rankScore: number;
    if (isOverdueLocal(c.dueAt, now, timeZone)) {
      priority = "DoNow";
      reason = `Open commitment was due ${formatLocalDate(c.dueAt, timeZone)}. Promised: ${c.description}`;
      rankScore = rankOverdueCommitment(daysSince(c.dueAt), "opportunity");
      followUpsDueCount++;
    } else if (isToday(c.dueAt, now, timeZone)) {
      priority = "DoToday";
      reason = `Open commitment is due today. Promised: ${c.description}`;
      rankScore = rankDueToday("opportunity");
      followUpsDueCount++;
    } else {
      continue;
    }

    partyIdsWithOpportunityAction.add(c.partyId);

    const contactability = contactabilityOf(c.partyId);
    const doNotContact = contactability === "do_not_contact";
    const availableActions: GrowTodayActionButton[] = [{ action: "add_note" }];
    if (c.propertyId) availableActions.push({ action: "view_property", propertyId: c.propertyId });
    if (!doNotContact) {
      if (c.partyEmail) availableActions.push({ action: "email", partyId: c.partyId });
      if (c.partyMobile) availableActions.push({ action: "sms", partyId: c.partyId });
    }
    availableActions.push({ action: "view_contact", partyId: c.partyId });
    availableActions.push({ action: "ask_ae" });

    const lastActivityAtCommitment = lastActivityByParty.get(c.partyId) ?? null;

    actions.push({
      id: `commitment:${c.id}`,
      type: "commitment",
      priority,
      partyId: c.partyId,
      contactName: contactDisplayName(c),
      contactEmail: doNotContact ? null : c.partyEmail ?? null,
      contactMobile: doNotContact ? null : c.partyMobile ?? null,
      relationshipType: null,
      propertyId: c.propertyId,
      propertyLabel: c.propertyAddress ?? null,
      opportunityId: c.opportunityId,
      appraisalId: null,
      commitmentId: c.id,
      reason,
      recommendedAction: doNotContact ? DO_NOT_CONTACT_RECOMMENDED_ACTION : c.description,
      dueAt: c.dueAt.toISOString(),
      lastActivityAt: lastActivityAtCommitment ? lastActivityAtCommitment.toISOString() : null,
      availableActions,
      rankScore: doNotContact ? 0 : rankScore,
      confidenceBand: null,
      contactability,
      contactabilityNote: doNotContact ? DO_NOT_CONTACT_NOTE : null,
      whyItMatters: null,
    });
  }

  // =====================================================================
  // RULE F — PROPERTY INTELLIGENCE SIGNALS, RANKED AND EXPLAINED (stage 3).
  // =====================================================================
  //
  // The query above has already reduced the set to: Active (so never
  // Dismissed/Reviewed/Superseded/Expired), not past its expiresAt, and
  // belonging to this brokerage. What this block adds is the three things
  // that make a signal usable rather than merely present:
  //
  //   1. A RANK. lib/grow/signalRanking.ts scores each signal from columns
  //      that already exist, so the agent's day starts with the opportunities
  //      that matter most instead of with whatever happened to sort first.
  //   2. AN EXPLANATION. Every card carries whyItMatters: a headline, an
  //      optional talking point phrased as a question the agent may choose to
  //      ask, a caution naming the limit of what AE knows, and the itemised
  //      factors behind the score. The score is never surfaced alone.
  //   3. AN HONEST TREATMENT OF PARTY-LESS SIGNALS. A signal with no linked
  //      contact used to be dropped by an innerJoin. It is now surfaced as a
  //      property-anchored card with no contact-specific actions — the agent
  //      can still see and review it, which is the whole point of a sweep
  //      that examines everything the brokerage is authorised to use.
  //   4. A CONSENT GATE (finding P1-3). A signal whose contact must not be
  //      contacted is WITHHELD here — no card, no name, no email, no mobile —
  //      regardless of when the signal was raised relative to the
  //      suppression. The row itself is untouched: history is preserved, the
  //      contact is simply not put in front of an agent as a prospect.
  //
  // Like Rule E, a surfaced party is added to partyIdsWithOpportunityAction
  // so the same contact never also shows as a generic "cold" nudge via Rule D
  // below. A signal held back by the Emerging cap or by the consent gate
  // deliberately does NOT join that set: it produced no card, so it must not
  // suppress one. (For a suppressed contact this is moot — Rule D withholds
  // them too — but the invariant should not depend on that.)
  //
  // RULE F NEVER CONTACTS ANYONE. It creates no commitment, opportunity,
  // appraisal or property change, sends nothing, and queues nothing. `reason`
  // remains the signal's own already-hedged stored explanation (see
  // lib/propertyIntelligence/evaluation.ts's SignalCandidate.explanation) and
  // recommendedAction still only ever asks the agent to review it themselves.
  // THE CONSENT GATE. Applied before ranking, before display, and before any
  // contact field is read off the row — the withheld rows never reach the
  // card-building loop at all, so there is no path by which a suppressed
  // contact's email or mobile can end up in this response.
  const withheldDoNotContactSignals = propertyIntelligenceSignalRows.filter(
    (s) => contactabilityOf(s.partyId) === "do_not_contact",
  ).length;

  const rankedSignals: RankedSignalCandidate[] = propertyIntelligenceSignalRows
    .filter((s) => contactabilityOf(s.partyId) === "contactable")
    .map((s) => {
      const contactability = contactabilityOf(s.partyId);
      const ranking = rankSignal(
        {
          signalType: s.signalType,
          title: s.title,
          explanation: s.explanation,
          confidenceBand: s.confidenceBand,
          source: s.source,
          evidence: s.evidence,
          reRaiseCount: s.reRaiseCount,
          computedAt: s.computedAt,
          sourceTimestamp: s.sourceTimestamp,
        },
        {
          hasLinkedContact: s.partyId !== null,
          hasOpenOpportunity: s.partyId !== null && partyIdsWithOpenOpportunity.has(s.partyId),
          lastActivityAt: s.partyId === null ? null : lastActivityByParty.get(s.partyId) ?? null,
          contactability,
          propertyLabel: s.propertyAddress ?? null,
        },
        now,
      );
      return { row: s, ranking, contactability, consolidated: [] };
    })
    // Strongest first, so the Emerging cap below keeps the BEST of the long
    // tail rather than an arbitrary slice of it.
    //
    // W2-A — this comparator (and the row-id tiebreak that makes repeated
    // identical requests return identical card orders) now lives in
    // lib/grow/signalRanking.ts, so the GLOBAL ordering of signals and the
    // PER-PARTY choice of which sibling becomes the card are literally the
    // same function and cannot drift apart.
    .sort((a, b) => compareSignalStrength({ score: a.ranking.score, rowId: a.row.id }, { score: b.ranking.score, rowId: b.row.id }));

  // =====================================================================
  // W2-A (F-3) — PER-PARTY CONSOLIDATION. THE PROJECT OWNER'S DECISION 3.
  // =====================================================================
  //
  // One person, one card. `rankedSignals` is already sorted strongest-first by
  // compareSignalStrength, so the FIRST signal seen for a party is by
  // definition that party's winner and every later one is folded into it —
  // no second sort, no second criterion, nothing that could disagree with the
  // ordering the list is about to be rendered in.
  //
  // PARTY-LESS SIGNALS BYPASS THIS ENTIRELY. partyId null means the signal is
  // anchored to a PROPERTY, and property-anchored signals are not "the same
  // person" as each other — grouping them on a null key would collapse every
  // property in the brokerage into a single phantom bucket and silently drop
  // all but one of them. (The same trap is documented for the
  // contactsNeedingAttention count near the bottom of this file, which is where
  // it was first caught.)
  //
  // NOTHING IS DISCARDED. A folded sibling becomes a relatedSignals entry on
  // the winning card, so the agent sees the one best item AND the evidence
  // behind the choice — which is precisely what DECISION 3 asks for. The row
  // is untouched and still fully visible on the contact record.
  const consolidatedSignals: RankedSignalCandidate[] = [];
  const winnerIndexByParty = new Map<number, number>();
  let consolidatedIntoStrongerSignal = 0;
  for (const candidate of rankedSignals) {
    if (candidate.row.partyId === null) {
      consolidatedSignals.push(candidate);
      continue;
    }
    const winnerIndex = winnerIndexByParty.get(candidate.row.partyId);
    if (winnerIndex === undefined) {
      winnerIndexByParty.set(candidate.row.partyId, consolidatedSignals.length);
      consolidatedSignals.push(candidate);
      continue;
    }
    consolidatedSignals[winnerIndex].consolidated.push(candidate);
    consolidatedIntoStrongerSignal++;
  }

  // Rule D's winning relationship per party, chosen before the signal contest
  // so a cold card and a signal about the same person are compared on one
  // rank. The preference (primary, then most recently established) is the
  // same one the cold-card loop below emits.
  const relationshipByParty = new Map<number, RelationshipRow>();
  for (const r of relationshipRows) {
    const existing = relationshipByParty.get(r.partyId);
    if (
      !existing ||
      (r.isPrimary && !existing.isPrimary) ||
      (r.isPrimary === existing.isPrimary && r.validFrom.getTime() > existing.validFrom.getTime())
    ) {
      relationshipByParty.set(r.partyId, r);
    }
  }
  // Parties already claimed by an opportunity, appraisal follow-up, or open
  // commitment are not cold-card candidates. A signal for them still surfaces
  // on its own; Rule D will skip them below either way.
  const ruleDRankByParty = new Map<number, number>();
  for (const [partyId] of relationshipByParty) {
    if (partyIdsWithOpportunityAction.has(partyId)) continue;
    if (contactabilityOf(partyId) === "do_not_contact") continue;
    const lastActivity = lastActivityByParty.get(partyId) ?? null;
    if (!lastActivity) {
      ruleDRankByParty.set(partyId, rankColdRelationship(null));
      continue;
    }
    const days = daysSince(lastActivity);
    if (days >= COLD_CONTACT_THRESHOLD_DAYS) ruleDRankByParty.set(partyId, rankColdRelationship(days));
  }

  // F-5 — a signal Rule D outranks does not become a card and does not consume
  // an Emerging slot. The winner and every sibling folded into it travel
  // together, so a second signal about the same person is not dropped when
  // the cold card is the one that survives.
  const signalsLostToColdByParty = new Map<number, RankedSignalCandidate[]>();
  const signalsAfterColdContest: RankedSignalCandidate[] = [];
  for (const candidate of consolidatedSignals) {
    const partyId = candidate.row.partyId;
    const coldScore = partyId === null ? undefined : ruleDRankByParty.get(partyId);
    if (partyId !== null && coldScore !== undefined && ruleDWinsOverSignal(coldScore, candidate.ranking.score)) {
      const lost = signalsLostToColdByParty.get(partyId) ?? [];
      lost.push(candidate, ...candidate.consolidated);
      signalsLostToColdByParty.set(partyId, lost);
      continue;
    }
    signalsAfterColdContest.push(candidate);
  }

  // W2-A (F-3) — THE EMERGING CAP NOW COUNTS CARDS, NOT ROWS, because it runs
  // AFTER consolidation. Before, a single contact holding four Emerging
  // signals consumed four of the ten daily slots by themselves, which is the
  // opposite of what a cap meant to keep the day readable should do.
  let emergingSurfaced = 0;
  let emergingWithheld = 0;
  const signalsToSurface: RankedSignalCandidate[] = [];
  // W2-A (F-5) — parties whose only signal card the cap held back. Rule D's
  // cold-contact card for such a party is the one that survives, and it uses
  // this to explain itself instead of saying only "No contact recorded for N
  // days."
  const signalsWithheldByParty = new Map<number, RankedSignalCandidate[]>();
  for (const candidate of signalsAfterColdContest) {
    if (candidate.row.confidenceBand === "Emerging") {
      if (emergingSurfaced >= MAX_EMERGING_SIGNAL_ACTIONS) {
        emergingWithheld++;
        if (candidate.row.partyId !== null) {
          const held = signalsWithheldByParty.get(candidate.row.partyId) ?? [];
          // The folded siblings are held back with their winner — none of them
          // produced a card either, so all of them travel to Rule D.
          held.push(candidate, ...candidate.consolidated);
          signalsWithheldByParty.set(candidate.row.partyId, held);
        }
        continue;
      }
      emergingSurfaced++;
    }
    signalsToSurface.push(candidate);
  }

  for (const { row: s, ranking, consolidated } of signalsToSurface) {
    if (s.partyId !== null) partyIdsWithOpportunityAction.add(s.partyId);

    const availableActions: GrowTodayActionButton[] = [];
    // add_note is contact-anchored in the UI (POST /grow/activities carries
    // the partyId), so a contact-less signal genuinely cannot offer it.
    if (s.partyId !== null) availableActions.push({ action: "add_note" });
    if (s.propertyId) availableActions.push({ action: "view_property", propertyId: s.propertyId });
    if (s.partyId !== null) {
      if (s.partyEmail) availableActions.push({ action: "email", partyId: s.partyId });
      if (s.partyMobile) availableActions.push({ action: "sms", partyId: s.partyId });
      availableActions.push({ action: "view_contact", partyId: s.partyId });
    }
    availableActions.push({ action: "ask_ae" });

    const lastActivityAtSignal = s.partyId === null ? null : lastActivityByParty.get(s.partyId) ?? null;

    actions.push({
      id: `signal:${s.id}`,
      type: "property_intelligence_signal",
      priority: ranking.priority,
      partyId: s.partyId,
      // A signal with no linked contact is about a property, so the property
      // is what names the card. contactDisplayName's "Unknown contact"
      // fallback would be actively misleading here — there is no contact.
      contactName: s.partyId === null ? s.propertyAddress ?? "Property signal (no linked contact)" : contactDisplayName(s),
      contactEmail: s.partyEmail ?? null,
      contactMobile: s.partyMobile ?? null,
      relationshipType: null,
      propertyId: s.propertyId,
      propertyLabel: s.propertyAddress ?? null,
      opportunityId: null,
      appraisalId: null,
      commitmentId: null,
      reason: s.explanation,
      recommendedAction: "Review this signal on the property or contact record to decide whether it's worth acting on.",
      dueAt: null,
      lastActivityAt: lastActivityAtSignal ? lastActivityAtSignal.toISOString() : null,
      availableActions,
      rankScore: ranking.score,
      confidenceBand: s.confidenceBand,
      // Always "contactable": a suppressed contact's signal was withheld by
      // the consent gate above and never reaches this loop.
      contactability: "contactable",
      contactabilityNote: null,
      whyItMatters: {
        ...ranking.narrative,
        confidenceBand: s.confidenceBand,
        confidenceBandLabel: confidenceBandLabel(s.confidenceBand),
        factors: ranking.factors,
        // W2-A (F-3) — the siblings this card won against. Present so the
        // agent sees everything AE knows about this contact on the one card,
        // and so AE can show WHY this is the card rather than the other one.
        relatedSignals: consolidated.map((c) => toRelatedSignal(c, "consolidated_into_this_card")),
      },
    });
  }

  // Rule D — cold Active relationships, one card per party. relationshipByParty
  // was built above, before the signal contest, so the card emitted here is
  // the same relationship that was compared with the signal. Skipped for a
  // party already carrying an opportunity, appraisal, commitment, or surfaced
  // signal card so the same person never shows twice on Today.
  for (const r of relationshipByParty.values()) {
    if (partyIdsWithOpportunityAction.has(r.partyId)) continue;
    // THE CONSENT GATE (finding P1-3). Rule D is a pure prospecting nudge —
    // its whole content is "reach out to reconnect" — so for a contact who
    // must not be approached it is withheld outright rather than shown with
    // its own advice negated. Nothing about this contact, including their
    // name, reaches the response through this rule.
    if (contactabilityOf(r.partyId) === "do_not_contact") continue;
    const lastActivity = lastActivityByParty.get(r.partyId) ?? null;

    let reason: string | null = null;
    if (!lastActivity) {
      reason = "No contact recorded yet.";
    } else {
      const days = daysSince(lastActivity);
      if (days >= COLD_CONTACT_THRESHOLD_DAYS) {
        reason = `No contact recorded for ${days} days.`;
      }
    }
    if (!reason) continue;

    const availableActions: GrowTodayActionButton[] = [{ action: "add_note" }];
    if (r.propertyId) availableActions.push({ action: "view_property", propertyId: r.propertyId });
    if (r.partyEmail) availableActions.push({ action: "email", partyId: r.partyId });
    if (r.partyMobile) availableActions.push({ action: "sms", partyId: r.partyId });
    availableActions.push({ action: "view_contact", partyId: r.partyId });
    availableActions.push({ action: "ask_ae" });

    // =====================================================================
    // W2-A (F-5) — RULE D NOW EXPLAINS ITSELF.
    // =====================================================================
    //
    // This card used to emit whyItMatters: null unconditionally. When Rule D
    // won — because its rank beat the party's signal, or because the Emerging
    // cap held that signal back — the agent saw "No contact recorded for N
    // days." and the signal that lost was gone.
    //
    // NO CONFIDENCE BAND, DELIBERATELY. A cold-contact card is a date
    // comparison, not a signal, and it has no stored evidence band. Both band
    // fields are therefore null, which is exactly what the web mirror's
    // rankSummaryLine() keys off to keep a bare "priority N/100" OFF this card
    // — a threshold rule must never be dressed up as a scored inference.
    //
    // NO FACTORS, for the same reason: there is no itemised score to itemise.
    // What this card can honestly carry is the rule it fired on, the limit of
    // what that proves, and the signals that did not become the card. Each
    // keeps its own stored explanation (toRelatedSignal). That is the same
    // attachment a winning signal uses for a sibling it consolidated.
    const lostToCold = signalsLostToColdByParty.get(r.partyId) ?? [];
    const withheldForParty = signalsWithheldByParty.get(r.partyId) ?? [];
    const relatedSignals = [
      ...lostToCold.map((c) => toRelatedSignal(c, "consolidated_into_this_card")),
      ...withheldForParty.map((c) => toRelatedSignal(c, "withheld_by_daily_cap")),
    ];
    const coldWhyItMatters: GrowTodayWhyItMatters = {
      headline: coldContactHeadline(lastActivity, relatedSignals),
      // Nothing to put in the agent's mouth. A gap in a record is not a
      // conversation starter, and inventing one here would be the exact
      // over-reach every narrative in signalRanking.ts is written to avoid.
      talkingPoint: null,
      caution: `AE knows only that no contact was RECORDED in this period — it does not know that none happened, and it has no information at all about this contact's plans or intentions.`,
      confidenceBand: null,
      confidenceBandLabel: null,
      factors: [],
      relatedSignals,
    };

    actions.push({
      id: `relationship:${r.id}`,
      type: "relationship_cold",
      priority: "KeepWarm",
      partyId: r.partyId,
      contactName: contactDisplayName(r),
      contactEmail: r.partyEmail ?? null,
      contactMobile: r.partyMobile ?? null,
      relationshipType: r.relationshipType,
      propertyId: r.propertyId,
      propertyLabel: r.propertyAddress ?? null,
      opportunityId: null,
      appraisalId: null,
      commitmentId: null,
      reason,
      recommendedAction: "Reach out to reconnect.",
      dueAt: null,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      availableActions,
      rankScore: ruleDRankByParty.get(r.partyId) ?? rankColdRelationship(lastActivity ? daysSince(lastActivity) : null),
      confidenceBand: null,
      // Always "contactable" here: a suppressed contact was withheld above.
      contactability: "contactable",
      contactabilityNote: null,
      whyItMatters: coldWhyItMatters,
    });
  }

  // Stage 3 — ORDERING.
  //
  // The priority band still decides first and is completely unchanged, so
  // DoNow always precedes DoToday always precedes KeepWarm. WITHIN a band the
  // comparator now leads on rankScore instead of on "does this happen to have
  // a date", which is the defect that made every signal invisible: a null
  // dueAt used to force an item behind every dated item in its band.
  //
  // dueAt and lastActivityAt remain as tiebreaks, so two items of equal rank
  // resolve exactly as they did before stage 3.
  const priorityOrder: Record<GrowTodayPriority, number> = { DoNow: 0, DoToday: 1, KeepWarm: 2 };
  actions.sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (a.rankScore !== b.rankScore) return b.rankScore - a.rankScore;
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    // Oldest last-contact (or never-contacted, via the "" fallback sorting first) leads within a tie.
    return (a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? "");
  });

  // =====================================================================
  // W2-A (F-2) — THE ONE BOUND ON THE WHOLE RESPONSE.
  // =====================================================================
  //
  // AFTER the sort, never before: the cut therefore always removes the
  // lowest-ranked tail of the day, and never an arbitrary slice. On every
  // brokerage below the cap this line does nothing at all.
  //
  // Note what this does NOT do: it does not re-balance across priority bands.
  // If a tenant genuinely has 200+ Do Today items, the Keep Warm tail is what
  // goes, and that is the correct answer — the sort has already said those are
  // the least important things on the screen. The notice says so out loud.
  const priorityActions = actions.slice(0, MAX_PRIORITY_ACTIONS);
  const withheldByActionCap = actions.length - priorityActions.length;

  // A party-less signal card has no contact to count, so it is excluded here
  // rather than collapsing every such card into a single phantom "null"
  // contact (which is what a naive Set over a nullable field would do).
  //
  // Counted over the RETURNED cards, so the number beside the list always
  // describes the list the agent can actually see.
  const contactsNeedingAttention = new Set(
    priorityActions.map((a) => a.partyId).filter((id): id is number => id !== null),
  ).size;

  // W2-A (I-4) — STATED TRUNCATION, in lib/ai/coaching/metrics.ts's shape: a
  // bounded read says so in words the surface can render, rather than handing
  // back a partial list that looks complete. Each line names the rule, the
  // cap, and what survived the cut, so an agent reading it knows what to go
  // and look at instead.
  const limitations: string[] = [];
  if (opportunityRows.length >= GROW_TODAY_OPPORTUNITY_ROW_CAP) {
    limitations.push(
      `This brokerage has ${totalOpenOpportunities} open opportunities; Today reads the ${GROW_TODAY_OPPORTUNITY_ROW_CAP} with the earliest next-action dates. The rest are all on the Opportunities list.`,
    );
  }
  if (relationshipRows.length >= GROW_TODAY_RELATIONSHIP_ROW_CAP) {
    limitations.push(
      `This brokerage has at least ${GROW_TODAY_RELATIONSHIP_ROW_CAP} active relationships; Today's cold-contact check covers the first ${GROW_TODAY_RELATIONSHIP_ROW_CAP} by contact. Contacts beyond that are unaffected and still on the Contacts list.`,
    );
  }
  if (appraisalFollowUpRows.length >= GROW_TODAY_APPRAISAL_ROW_CAP) {
    limitations.push(
      `At least ${GROW_TODAY_APPRAISAL_ROW_CAP} appraisals are awaiting follow-up; Today shows the ${GROW_TODAY_APPRAISAL_ROW_CAP} most overdue. The Appraisal Workspace has the full list.`,
    );
  }
  if (commitmentRows.length >= GROW_TODAY_COMMITMENT_ROW_CAP) {
    limitations.push(
      `At least ${GROW_TODAY_COMMITMENT_ROW_CAP} open commitments are due today or overdue; Today shows the ${GROW_TODAY_COMMITMENT_ROW_CAP} most overdue. Each contact record has the full list.`,
    );
  }
  if (propertyIntelligenceSignalRows.length >= GROW_TODAY_SIGNAL_ROW_CAP) {
    limitations.push(
      `At least ${GROW_TODAY_SIGNAL_ROW_CAP} active signals exist; Today reads the ${GROW_TODAY_SIGNAL_ROW_CAP} with the strongest evidence bands. Every signal stays visible on its contact and property record.`,
    );
  }

  // W2-A — BOTH "SURFACED" COUNTS ARE DERIVED FROM THE RETURNED LIST, not
  // from the loop that built it. `signalsToSurface` is what survived the
  // Emerging cap, which is not the same thing as what survived the whole
  // pipeline: the total priority-action cap runs later and can cut signal
  // cards too. A field documented as "signal cards actually on today's list"
  // has to be counted off today's list, or the screen states a number the
  // agent can disprove by counting the cards in front of them.
  const surfacedSignalCards = priorityActions.filter((a) => a.type === "property_intelligence_signal");
  const signalSummary: GrowTodaySignalSummary = {
    surfaced: surfacedSignalCards.length,
    emergingSurfaced: surfacedSignalCards.filter((a) => a.confidenceBand === "Emerging").length,
    // Counts CARDS held back, not rows: after consolidation a card is a
    // contact. Rows folded into a card are counted by
    // consolidatedIntoStrongerSignal instead, and are never lost from either.
    emergingWithheld,
    withheldDoNotContact: withheldDoNotContactSignals,
    consolidatedIntoStrongerSignal,
    withheldByActionCap,
    limitations,
  };

  return {
    generatedAt: new Date().toISOString(),
    // AE GROW Priority 5 Remediation — genuine gap caught while writing this
    // file's own test coverage: without this third clause, a brokerage whose
    // ONLY actionable item today is a Rule F Property Intelligence signal
    // (no relationships, no opportunities yet) would report
    // hasAnyGrowData: false, which Grow.tsx reads as "never used Grow" and
    // renders as the onboarding empty state — hiding a real, concrete
    // action item behind an empty-state screen instead of showing it.
    // F-1 adds commitmentRows to this boolean for the same reason: a
    // brokerage whose only Grow record is a due or overdue Open commitment
    // must not be told it has never used Grow. Relationship rows, opportunity
    // rows, signals, and those commitment rows are all inputs.
    hasAnyGrowData:
      relationshipRows.length > 0 ||
      opportunityRows.length > 0 ||
      propertyIntelligenceSignalRows.length > 0 ||
      commitmentRows.length > 0,
    counts: {
      // The count beside the list describes the list. What the cap removed is
      // reported separately and explicitly as signalSummary.withheldByActionCap
      // rather than being folded into a headline number the agent cannot
      // reconcile against what is on their screen.
      priorityActions: priorityActions.length,
      followUpsDue: followUpsDueCount,
      // W2-A — the TRUE total, from the windowed count in the opportunities
      // query above, not the capped row count. A headline figure must not
      // quietly become "however many rows we happened to read".
      openOpportunities: totalOpenOpportunities,
      contactsNeedingAttention,
    },
    priorityActions,
    signalSummary,
  };
}
