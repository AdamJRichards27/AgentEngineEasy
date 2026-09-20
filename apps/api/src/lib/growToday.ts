import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, appraisals, growActivities, growOpportunities, growOpportunitySignals, growRelationships, parties, properties } from "@aee/db";
import { loadContactabilityFilter } from "./propertyIntelligence/contactability.js";
import {
  RANK_APPRAISAL_NO_ACTION_SET,
  RANK_OPPORTUNITY_NO_ACTION_SET,
  confidenceBandLabel,
  rankColdRelationship,
  rankDueToday,
  rankOverdueCommitment,
  rankSignal,
  type SignalContactability,
  type SignalNarrative,
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
//
// This filter is a READ. It resolves no consent policy, picks no channel, and
// writes nothing — lib/propertyIntelligence/contactability.ts's own header
// documents that boundary and nothing here widens it. For pilot tenants
// (whose DNC/suppression tables are empty, since their only writers are on
// the telephony path) it is two statements that match nothing and change no
// behaviour at all.
//
// STILL OUTSTANDING, AND NOT FIXABLE FROM THIS FILE:
// lib/propertyIntelligence/signals.ts's listActiveSignalsForParty() — the
// Contact 360 read — has the identical hole and is owned by the sweep agent.
// See this change's report.

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionType =
  | "opportunity_follow_up"
  | "opportunity_no_action_set"
  | "relationship_cold"
  | "appraisal_follow_up"
  // AE Grow Priority 5 Remediation — additive: a Property Intelligence
  // signal surfaced by Rule F below.
  | "property_intelligence_signal";

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
 * Stage 3 — the agent-readable explanation that rides with a surfaced
 * signal. `factors` is the itemised breakdown of the rankScore, so the
 * ranking is auditable rather than an opaque number; `headline` /
 * `talkingPoint` / `caution` are what the agent reads and (for the talking
 * point) may choose to say. Null on Rules A-E, whose `reason` and
 * `recommendedAction` are already the whole explanation.
 */
export interface GrowTodayWhyItMatters extends SignalNarrative {
  confidenceBand: string;
  confidenceBandLabel: string;
  factors: SignalRankingFactor[];
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
// ever) is surfaced as "Keep Warm" — a documented, adjustable constant, not
// a magic number buried in the rule logic below.
const COLD_CONTACT_THRESHOLD_DAYS = 21;

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

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

function endOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}

function daysSince(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function formatDateUtc(date: Date): string {
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
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
      ),
    );
}

export async function getGrowTodaySummary(
  brokerageId: number,
  options?: { includePropertyIntelligenceSignals?: boolean },
): Promise<GrowTodaySummary> {
  // AE GROW Priority 5 Remediation — Rule F is entitlement-gated, but this
  // function never resolves grow.propertyIntelligence.read itself. The
  // caller (routes/grow.ts) checks the entitlement and passes the result in
  // here as a plain boolean, preserving this file's existing "no
  // cross-cutting concerns" boundary — growToday.ts has never imported an
  // entitlement or auth concept, and still doesn't.
  const includePropertyIntelligenceSignals = options?.includePropertyIntelligenceSignals ?? false;
  const propertyIntelligenceNow = new Date();
  const [relationshipRows, opportunityRows, activityRows, appraisalFollowUpRows, propertyIntelligenceSignalRows] = await Promise.all([
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
      .where(and(eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active"))),
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
      })
      .from(growOpportunities)
      .innerJoin(parties, eq(growOpportunities.partyId, parties.id))
      .leftJoin(properties, eq(growOpportunities.propertyId, properties.id))
      .where(and(eq(growOpportunities.brokerageId, brokerageId), eq(growOpportunities.status, "Open"))),
    db
      .select({ partyId: growActivities.partyId, occurredAt: growActivities.occurredAt })
      .from(growActivities)
      .where(eq(growActivities.brokerageId, brokerageId)),
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
      .where(and(eq(properties.brokerageId, brokerageId), eq(appraisals.status, "FOLLOW_UP"))),
    fetchPropertyIntelligenceSignalRows(brokerageId, includePropertyIntelligenceSignals, propertyIntelligenceNow),
  ]);

  const lastActivityByParty = new Map<number, Date>();
  for (const a of activityRows) {
    if (a.partyId === null) continue;
    const existing = lastActivityByParty.get(a.partyId);
    if (!existing || a.occurredAt > existing) lastActivityByParty.set(a.partyId, a.occurredAt);
  }

  // Stage 3 — CONSENT / CONTACTABILITY, APPLIED AT READ TIME TO EVERY RULE.
  // See this file's "READ-TIME CONTACTABILITY (security finding P1-3)" header
  // block for the defect this closes and for the hide/show split below.
  const allPartyIds: Array<number | null> = [
    ...relationshipRows.map((r) => r.partyId),
    ...opportunityRows.map((o) => o.partyId),
    ...appraisalFollowUpRows.map((a) => a.partyId),
    ...propertyIntelligenceSignalRows.map((s) => s.partyId),
  ];
  const contactabilityFilter = await loadContactabilityFilter(brokerageId, allPartyIds);
  const contactabilityOf = (partyId: number | null): SignalContactability =>
    contactabilityFilter.isSuppressed(partyId) ? "do_not_contact" : "contactable";

  const today0 = startOfTodayUtc();
  const today1 = endOfTodayUtc();
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
      if (o.nextActionDueAt.getTime() < today0.getTime()) {
        priority = "DoNow";
        reason = `Follow-up was due ${formatDateUtc(o.nextActionDueAt)}.`;
        rankScore = rankOverdueCommitment(daysSince(o.nextActionDueAt), "opportunity");
        followUpsDueCount++;
      } else if (o.nextActionDueAt.getTime() <= today1.getTime()) {
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
    if (ap.followUpAt.getTime() < today0.getTime()) {
      priority = "DoNow";
      reason = `Appraisal follow-up was due ${formatDateUtc(ap.followUpAt)}.`;
      rankScore = rankOverdueCommitment(daysSince(ap.followUpAt), "appraisal");
      followUpsDueCount++;
    } else if (ap.followUpAt.getTime() <= today1.getTime()) {
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
    const availableActions: GrowTodayActionButton[] = [{ action: "view_appraisal", appraisalId: ap.id }];
    if (!doNotContact) {
      if (ap.partyEmail) availableActions.push({ action: "email", partyId: ap.partyId });
      if (ap.partyMobile) availableActions.push({ action: "sms", partyId: ap.partyId });
    }
    availableActions.push({ action: "view_contact", partyId: ap.partyId });
    availableActions.push({ action: "ask_ae" });

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

  const rankedSignals = propertyIntelligenceSignalRows
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
        propertyIntelligenceNow,
      );
      return { row: s, ranking, contactability };
    })
    // Strongest first, so the Emerging cap below keeps the BEST of the long
    // tail rather than an arbitrary slice of it.
    .sort((a, b) => b.ranking.score - a.ranking.score || a.row.id - b.row.id);

  let emergingSurfaced = 0;
  let emergingWithheld = 0;
  const signalsToSurface: typeof rankedSignals = [];
  for (const candidate of rankedSignals) {
    if (candidate.row.confidenceBand === "Emerging") {
      if (emergingSurfaced >= MAX_EMERGING_SIGNAL_ACTIONS) {
        emergingWithheld++;
        continue;
      }
      emergingSurfaced++;
    }
    signalsToSurface.push(candidate);
  }

  for (const { row: s, ranking } of signalsToSurface) {
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
      },
    });
  }

  // Rule D — cold Active relationships, deduped to one card per party
  // (preferring the primary relationship, then the most recently
  // established one) and skipped for a party already carrying an
  // opportunity-based card above so the same person never shows twice on
  // Today.
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
      reason,
      recommendedAction: "Reach out to reconnect.",
      dueAt: null,
      lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
      availableActions,
      rankScore: rankColdRelationship(lastActivity ? daysSince(lastActivity) : null),
      confidenceBand: null,
      // Always "contactable" here: a suppressed contact was withheld above.
      contactability: "contactable",
      contactabilityNote: null,
      whyItMatters: null,
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

  // A party-less signal card has no contact to count, so it is excluded here
  // rather than collapsing every such card into a single phantom "null"
  // contact (which is what a naive Set over a nullable field would do).
  const contactsNeedingAttention = new Set(
    actions.map((a) => a.partyId).filter((id): id is number => id !== null),
  ).size;

  const signalSummary: GrowTodaySignalSummary = {
    surfaced: signalsToSurface.length,
    emergingSurfaced,
    emergingWithheld,
    withheldDoNotContact: withheldDoNotContactSignals,
  };

  return {
    generatedAt: new Date().toISOString(),
    // AE GROW Priority 5 Remediation — genuine gap caught while writing this
    // file's own test coverage: without this third clause, a brokerage whose
    // ONLY actionable item today is a Rule F Property Intelligence signal
    // (no relationships, no opportunities yet) would report
    // hasAnyGrowData: false, which Grow.tsx reads as "never used Grow" and
    // renders as the onboarding empty state — hiding a real, concrete
    // action item behind an empty-state screen instead of showing it. Rules
    // A-E's own inputs to this boolean are unchanged.
    hasAnyGrowData: relationshipRows.length > 0 || opportunityRows.length > 0 || propertyIntelligenceSignalRows.length > 0,
    counts: {
      priorityActions: actions.length,
      followUpsDue: followUpsDueCount,
      openOpportunities: opportunityRows.length,
      contactsNeedingAttention,
    },
    priorityActions: actions,
    signalSummary,
  };
}
