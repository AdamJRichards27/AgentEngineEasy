import { and, eq, isNotNull, lt } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  growOpportunities,
  properties,
  parties,
  GROW_CONSENT_CHANNELS,
  type GrowOpportunitySignal,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { PropertyIntelligenceAccessError } from "./observations.js";
import { PropertyIntelligenceTransitionError } from "./matches.js";
import { evaluateCandidates } from "./evaluation.js";
import { loadContactabilityFilter } from "./contactability.js";
import {
  HUMAN_DECIDED_STATUSES,
  expireSignalsPastExpiry,
  expireUnsupportedSignals,
  loadSignalsByDedupeKeys,
  upsertSignalCandidates,
} from "./persistence.js";

/**
 * AE GROW Priority 5 Remediation — the deterministic Property Intelligence
 * rule engine's human-facing lifecycle (review / dismiss / promote), plus the
 * single-property recalculation entry point.
 *
 * The rules themselves now live in ./evaluation.ts (set-based, shared with
 * the brokerage-wide sweep in ./sweep.ts) and the single write path lives in
 * ./persistence.ts. This file owns everything a HUMAN does to a signal.
 *
 * Every rule reads ONLY data genuinely available in AE today:
 * growRelationships, appraisals, and propertyProviderObservations rows a
 * caller actually wrote. Nothing here invents or estimates a fact a provider
 * never supplied. The four PROPERTY_SIGNAL_TYPES this codebase declares but
 * that have no real evidence source wired (land_use_zoning_change,
 * lease_tenancy_milestone, agent_recorded_motivation,
 * re_engagement_opportunity) are deliberately NOT implemented.
 *
 * =====================================================================
 * RE-REVIEW POLICY (AE GROW "Brokerage-wide Signal Sweep", stage 1)
 * =====================================================================
 *
 * THE PROBLEM THIS REPLACES. Until this change, Dismissed / Reviewed /
 * Superseded were terminal for a dedupeKey FOREVER: the engine skipped any
 * human-decided row unconditionally. Because a dedupeKey encodes the
 * underlying row (a relationship id, an appraisal id, an observation id), a
 * contact whose long-tenure signal was reviewed once could never be
 * surfaced again from that same relationship — not in a year, not in a
 * decade, even though a five-year tenure becoming an eleven-year tenure is
 * genuinely new information. "Never again" was an accident of the dedupe
 * mechanism, not a decision anyone made.
 *
 * THE POLICY. A human decision now sets a QUIET PERIOD rather than a
 * permanent tombstone:
 *
 *   dismissSignal()  -> next_review_at = now + DISMISS_QUIET_PERIOD_DAYS (180)
 *       A dismissal is a considered "not this, not now". Six months is long
 *       enough that the agent is not re-shown their own decision within any
 *       normal working cycle, and short enough that a genuinely changed
 *       situation is not buried for years.
 *
 *   reviewSignal()   -> next_review_at = now + REVIEW_QUIET_PERIOD_DAYS (30)
 *       "Reviewed" is an acknowledgement, not a rejection — the agent looked
 *       and took it on board. A shorter period matches that weaker claim.
 *
 *   promoteSignal()  -> next_review_at stays NULL (PERMANENTLY TERMINAL)
 *       Promotion created a real growOpportunities row. Re-raising the same
 *       evidence would duplicate work the agent is already doing, so a
 *       promoted signal is never re-raised. NULL next_review_at means
 *       "never", and that is also what every pre-existing row in the
 *       database carries — so nothing already decided before this change is
 *       ever resurrected by it.
 *
 * TWO CONDITIONS, BOTH REQUIRED. The sweep may raise a human-decided
 * dedupeKey again only when BOTH hold:
 *   1. next_review_at is set AND has elapsed. A dismissal is NEVER silently
 *      overridden before its quiet period — this is enforced in the upsert's
 *      ON CONFLICT predicate (persistence.ts), evaluated atomically by
 *      Postgres, not by a read-then-write check that could race a concurrent
 *      dismissal.
 *   2. The evidence has MATERIALLY CHANGED — the rule-specific definition
 *      documented on buildEvidenceFingerprint() in ./evaluation.ts. Time
 *      passing is not, by itself, a material change.
 *
 * WHAT A RE-RAISE LOOKS LIKE. The row goes back to Active, re_raise_count is
 * incremented, and the superseded decision is snapshotted into
 * prior_decision so an Active signal never displays a stale dismissal reason
 * while the reviewer can still see what was decided last time. The
 * authoritative trail remains the audit log, which is untouched by this
 * change. dismissedReason remains MANDATORY on every dismissal.
 *
 * UNCHANGED: a genuinely new piece of evidence (a new observation row, a
 * second owner relationship) still produces a NEW dedupeKey, never collides
 * with a decided one, and raises its own Active signal immediately — no
 * quiet period applies, because that is a different signal about a different
 * fact.
 */

/** See the re-review policy above. Deliberately constants, not env-tunable: a quiet period is a product decision an operator should not be able to quietly shorten to zero. */
export const DISMISS_QUIET_PERIOD_DAYS = 180;
export const REVIEW_QUIET_PERIOD_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Ceiling on candidates evaluated for ONE property by the recalculate route.
 * A single property cannot plausibly produce this many; the bound exists so
 * the route can never be turned into an unbounded query by pathological data.
 */
const MAX_CANDIDATES_PER_PROPERTY = 500;

const HUMAN_DECIDED = new Set<string>(HUMAN_DECIDED_STATUSES);

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new PropertyIntelligenceAccessError("Property not found");
}

/**
 * Recomputes every rule for ONE property and upserts the result,
 * idempotently — the POST /property/:id/recalculate route's entry point.
 *
 * Now a thin scoping wrapper over the shared evaluation/persistence code the
 * brokerage-wide sweep uses, so the two can never drift. Behaviour for a
 * property-scoped caller is unchanged: the same rules, the same dedupe keys,
 * the same "signals this property currently has" response (including rows
 * left untouched because a human decided them), and the same preservation of
 * unsupported signals as Expired rather than deleted.
 *
 * NOTE: this path deliberately does NOT apply the contactability filter. It
 * is an explicit, entitled, per-property human action on a record the agent
 * is already looking at — not a system-initiated suggestion — and filtering
 * it would silently hide rows from the surface that exists to review them.
 * The sweep, which IS system-initiated, does apply the filter.
 */
export async function recalculateSignalsForProperty(propertyId: number, brokerageId: number): Promise<GrowOpportunitySignal[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  const now = new Date();
  const propertyIds = [propertyId];

  await expireSignalsPastExpiry(brokerageId, now, propertyIds);

  const { candidates, truncated } = await evaluateCandidates({ brokerageId, propertyIds, now, maxCandidates: MAX_CANDIDATES_PER_PROPERTY });
  await upsertSignalCandidates(brokerageId, candidates, now);

  const dedupeKeys = candidates.map((c) => c.dedupeKey);
  // An incomplete pass proves nothing about what is currently true, so the
  // "no longer supported" expiry is skipped when the candidate set was
  // truncated (see expireUnsupportedSignals' own contract).
  if (!truncated) {
    await expireUnsupportedSignals(brokerageId, dedupeKeys, now, propertyIds);
  }

  return loadSignalsByDedupeKeys(brokerageId, dedupeKeys);
}

/**
 * Lazily flips any Active signal for this property past its own expiresAt to
 * Expired.
 *
 * Retained, and still called on the read paths, but it is no longer the
 * mechanism the system relies on: ./sweep.ts performs this expiry
 * brokerage-wide on a schedule. Keeping the read-time call is harmless (it
 * is a single indexed UPDATE that usually matches nothing) and means a read
 * immediately after an expiry boundary is still correct on a deployment
 * where the sweep is disabled.
 */
export async function expireStaleSignals(propertyId: number, brokerageId: number): Promise<void> {
  await db
    .update(growOpportunitySignals)
    .set({ status: "Expired", updatedAt: new Date() })
    .where(
      and(
        eq(growOpportunitySignals.propertyId, propertyId),
        eq(growOpportunitySignals.brokerageId, brokerageId),
        eq(growOpportunitySignals.status, "Active"),
        isNotNull(growOpportunitySignals.expiresAt),
        lt(growOpportunitySignals.expiresAt, new Date()),
      ),
    );
}

async function assertSignalInBrokerage(signalId: number, brokerageId: number): Promise<GrowOpportunitySignal> {
  const [row] = await db.select().from(growOpportunitySignals).where(and(eq(growOpportunitySignals.id, signalId), eq(growOpportunitySignals.brokerageId, brokerageId)));
  if (!row) throw new PropertyIntelligenceAccessError("Signal not found");
  return row;
}

export async function listSignalsForProperty(propertyId: number, brokerageId: number, status?: string): Promise<GrowOpportunitySignal[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  await expireStaleSignals(propertyId, brokerageId);
  const conditions = [eq(growOpportunitySignals.propertyId, propertyId), eq(growOpportunitySignals.brokerageId, brokerageId)];
  if (status) conditions.push(eq(growOpportunitySignals.status, status));
  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(...conditions));
}

/* =====================================================================
 * CONTACTABILITY ON THE CONTACT 360 READ — WHAT CHANGED, AND WHY
 * =====================================================================
 *
 * THE ORIGINAL RATIONALE, PRESERVED. The sweep consults the contactability
 * filter when it RAISES a signal, which only protects a contact who was
 * already DNC-listed or fully suppressed at that moment. For a contact listed
 * AFTERWARDS the existing row was stranded in exactly the wrong state:
 *
 *   - the sweep drops their candidate, so the row is never refreshed;
 *   - but the candidate still counts as SUPPORTED, so the "no longer
 *     supported -> Expired" pass deliberately leaves it alone (and correctly
 *     so — the filter must hide a contact, never silently retire their
 *     history);
 *   - and these rows carry expires_at IS NULL, so the expiry pass never
 *     touches them either.
 *
 * The row therefore stayed Active forever and kept being surfaced as a
 * prospecting suggestion. That hole is REAL and this function still closes
 * it. A write-time-only check cannot, because the event that must change the
 * answer (a DNC listing) happens after the write.
 *
 * WHAT THAT RATIONALE GOT WRONG, AND WHAT REPLACES IT. The remedy chosen was
 * `return []` — withhold the rows entirely. That conflated two different
 * questions, and answering the second with the first's answer destroyed
 * information the brokerage is entitled to:
 *
 *     MAY THIS CONTACT BE CONTACTED?   No. That is what the DNC record says,
 *                                      and it is absolute.
 *     DOES THIS SIGNAL EXIST?          Yes. A DNC listing is a restriction on
 *                                      OUTREACH. It is not a statement that
 *                                      the tenure, the past enquiry or the
 *                                      recorded motivation never happened,
 *                                      and it is not an instruction to blind
 *                                      an authorised internal user to their
 *                                      own brokerage's records.
 *
 * SIGNAL EXISTS != CONTACT MAY BE CONTACTED. `return []` answered the second
 * question with the first's answer and, in doing so, erased legitimate
 * relationship intelligence from an entitled internal user rather than
 * merely removing the outreach they must not perform. Worse, it erased it
 * SILENTLY: the agent could not tell a contact with no signals from a
 * contact whose signals were withheld, so the suppression itself became
 * invisible on the one record that should state it most plainly.
 *
 * THE INVARIANT THAT REPLACES IT, and which this module's tests enforce:
 *
 *     ROWS MAY BE READ FOR DISPLAY.
 *     NO OUTREACH AFFORDANCE MAY BE DERIVED FROM THEM.
 *
 * Both halves are load-bearing. The read returns the rows AND, inseparably,
 * the restriction — which is why the return type is a struct and not an
 * array. A caller cannot obtain a suppressed contact's signals without also
 * obtaining the fact that they must not be contacted; there is deliberately
 * no overload, no flag and no sibling function that yields the bare rows.
 * "Forgot to check the restriction" is not reachable, because there is
 * nothing to forget: the restriction arrives in the same value as the data.
 *
 * WHAT THE SECOND HALF COSTS THE CALLER is documented on
 * ContactOutreachRestriction below and enforced in service.ts (the generated
 * agentAction is dropped), routes/propertyIntelligence.ts (promotion to an
 * opportunity is refused) and PropertyIntelligencePanel.tsx (the restriction
 * is rendered before any signal, and the promote control is not rendered at
 * all). See __tests__/contactabilityOutreachPathway.test.ts, which walks
 * every affordance on those surfaces and asserts that none of them yields an
 * email, SMS or call for a suppressed contact.
 *
 * STILL TRUE, AND UNCHANGED BY ANY OF THE ABOVE:
 *
 *   - HIDES OUTREACH, NEVER RETIRES DATA. The rows are not touched, not
 *     expired, not dismissed, and the restriction lifts the moment the
 *     suppression lapses. Evidence and history are preserved exactly.
 *   - WHAT COUNTS AS SUPPRESSED is owned entirely by ./contactability.ts —
 *     DNC LISTED (or UNKNOWN) on any channel, or an in-force suppression on
 *     EVERY channel. A partial (single-channel) suppression deliberately does
 *     not restrict here: the agent can still reach that contact another way.
 *     This function makes no consent decision of its own and writes nothing.
 *   - THE SWEEP IS UNCHANGED. It still refuses to RAISE or REFRESH a
 *     suppressed contact's signal (sweep.ts:772-776), and Grow Today still
 *     withholds them from the prospecting surface entirely
 *     (growToday.ts:908). Nothing here widens a system-INITIATED suggestion;
 *     this is a human-initiated read of a record the agent has already
 *     navigated to.
 *   - NOT APPLIED TO listSignalsForProperty() ABOVE, for the same reason
 *     recalculateSignalsForProperty() does not apply it: that is an explicit,
 *     entitled, per-property human action, not a suggestion about a person.
 *
 * SCOPE. This is a product/technical architecture decision about what an
 * authorised internal user may SEE. It is not a legal conclusion about AU/NZ
 * do-not-call obligations, and it does not relax one: no outreach becomes
 * permissible anywhere as a result of it.
 * =====================================================================*/

/**
 * An in-force restriction on contacting a party, travelling WITH that party's
 * signals so the two can never be separated.
 *
 * Deliberately has no "allowed" representation — the type is `… | null`, and
 * null is the only way to express "no restriction". A boolean field would
 * invite `if (r.outreachProhibited)` against an object that a serialisation
 * bug, a partial mock or an older API build had left without the key, which
 * reads as permitted. An absent OBJECT cannot be misread that way.
 */
export interface ContactOutreachRestriction {
  /**
   * Always literally true when the object exists. Present so a JSON consumer
   * that reaches for a field finds one that cannot be falsy, rather than
   * inferring permission from a missing key.
   */
  readonly outreachProhibited: true;
  /** Why, in a form code can branch on without parsing prose. */
  readonly reason: "contactability_suppressed";
  /**
   * Every channel AE knows about. This restriction is never partial — a
   * partial suppression does not reach this code at all — so the list is
   * total by construction rather than assembled from the suppressing rows.
   */
  readonly blockedChannels: readonly string[];
  /** The sentence a human reads. Identical wording to Grow Today's own DNC note, so one contact does not get two different explanations on two screens. */
  readonly notice: string;
  /** What the agent is told to do instead, replacing any generated outreach action. */
  readonly recommendedAction: string;
}

/**
 * The wording is Grow Today's, verbatim (growToday.ts:341-344), not a second
 * paraphrase of it. A contact who is suppressed is suppressed on every
 * surface, and an agent who reads two different explanations of the same
 * restriction on two screens is entitled to conclude that one of them is
 * wrong.
 */
export const CONTACT_OUTREACH_RESTRICTION_NOTICE =
  "A do-not-contact listing or a full-channel suppression is on file for this contact. AE will not present them as someone to reach out to, and no outreach action is offered here.";
export const CONTACT_OUTREACH_RESTRICTION_ACTION =
  "Do not contact. This contact is on a do-not-contact record or is suppressed on every channel — review the contact record before taking any action at all.";

/** The signals, and — inseparably — whether the person they are about may be contacted. */
export interface PartySignalRead {
  signals: GrowOpportunitySignal[];
  /** Null means no restriction is on file. Non-null means outreach is prohibited; see ContactOutreachRestriction. */
  outreachRestriction: ContactOutreachRestriction | null;
}

/**
 * Active, non-expired, non-dismissed signals for a contact, together with any
 * in-force outreach restriction on that contact.
 *
 * Replaces listActiveSignalsForParty(), which returned a bare array and
 * therefore had to express "suppressed" as an empty one. The rename is the
 * point: every call site had to be revisited, and no caller can still be
 * holding the old bare-array contract. See the block comment above for the
 * invariant this signature exists to make unforgeable.
 */
export async function readActiveSignalsForParty(partyId: number, brokerageId: number): Promise<PartySignalRead> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");

  // Resolved BEFORE the rows are read, so the restriction is already known by
  // the time any signal exists in memory on this path. Nothing downstream can
  // observe the signals in a state where the restriction has not been decided.
  const contactability = await loadContactabilityFilter(brokerageId, [partyId]);
  const outreachRestriction: ContactOutreachRestriction | null = contactability.isSuppressed(partyId)
    ? {
        outreachProhibited: true,
        reason: "contactability_suppressed",
        blockedChannels: GROW_CONSENT_CHANNELS,
        notice: CONTACT_OUTREACH_RESTRICTION_NOTICE,
        recommendedAction: CONTACT_OUTREACH_RESTRICTION_ACTION,
      }
    : null;

  const signals = await db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.partyId, partyId), eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.status, "Active")));

  return { signals, outreachRestriction };
}

/**
 * Whether outreach to this contact is prohibited, on its own — for a caller
 * that must make an outreach DECISION rather than render intelligence, and
 * so has no business loading the signals at all.
 *
 * Used by the promote-to-opportunity path, which is a write that would place
 * the contact into the opportunity funnel. Kept here, beside the read it
 * shares a definition of "suppressed" with, so the two can never diverge.
 */
export async function isOutreachRestrictedForParty(partyId: number, brokerageId: number): Promise<ContactOutreachRestriction | null> {
  const contactability = await loadContactabilityFilter(brokerageId, [partyId]);
  if (!contactability.isSuppressed(partyId)) return null;
  return {
    outreachProhibited: true,
    reason: "contactability_suppressed",
    blockedChannels: GROW_CONSENT_CHANNELS,
    notice: CONTACT_OUTREACH_RESTRICTION_NOTICE,
    recommendedAction: CONTACT_OUTREACH_RESTRICTION_ACTION,
  };
}

export async function reviewSignal(input: { signalId: number; brokerageId: number; userId: number }): Promise<GrowOpportunitySignal> {
  const existing = await assertSignalInBrokerage(input.signalId, input.brokerageId);
  if (HUMAN_DECIDED.has(existing.status)) {
    throw new PropertyIntelligenceTransitionError(`Signal is already ${existing.status}`);
  }
  const now = new Date();
  const [updated] = await db
    .update(growOpportunitySignals)
    .set({
      status: "Reviewed",
      reviewedByUserId: input.userId,
      reviewedAt: now,
      // Re-review policy: an acknowledgement, so a short quiet period.
      nextReviewAt: addDays(now, REVIEW_QUIET_PERIOD_DAYS),
      updatedAt: now,
    })
    .where(eq(growOpportunitySignals.id, existing.id))
    .returning();
  await logAudit({
    userId: input.userId,
    action: "property_intelligence_signal_reviewed",
    recordType: "grow_opportunity_signal",
    recordId: String(existing.id),
    propertyId: existing.propertyId ?? undefined,
    previousValue: existing.status,
    updatedValue: "Reviewed",
  });
  return updated;
}

export async function dismissSignal(input: {
  signalId: number;
  brokerageId: number;
  userId: number;
  dismissedReason: string;
}): Promise<GrowOpportunitySignal> {
  // Still mandatory — the re-review policy makes a dismissal temporary, not
  // unexplained.
  if (!input.dismissedReason || input.dismissedReason.trim().length === 0) {
    throw new PropertyIntelligenceTransitionError("dismissedReason is required to dismiss a signal");
  }
  const existing = await assertSignalInBrokerage(input.signalId, input.brokerageId);
  if (HUMAN_DECIDED.has(existing.status)) {
    throw new PropertyIntelligenceTransitionError(`Signal is already ${existing.status}`);
  }
  const now = new Date();
  const [updated] = await db
    .update(growOpportunitySignals)
    .set({
      status: "Dismissed",
      dismissedReason: input.dismissedReason,
      reviewedByUserId: input.userId,
      reviewedAt: now,
      // Re-review policy: a considered rejection, so a long quiet period.
      // Nothing may re-raise this dedupeKey before it elapses.
      nextReviewAt: addDays(now, DISMISS_QUIET_PERIOD_DAYS),
      updatedAt: now,
    })
    .where(eq(growOpportunitySignals.id, existing.id))
    .returning();
  await logAudit({
    userId: input.userId,
    action: "property_intelligence_signal_dismissed",
    recordType: "grow_opportunity_signal",
    recordId: String(existing.id),
    propertyId: existing.propertyId ?? undefined,
    previousValue: existing.status,
    updatedValue: "Dismissed",
  });
  return updated;
}

/**
 * Promotes a signal into a real growOpportunities row. Requires an
 * authenticated, entitled human action (checked by the caller/route);
 * re-checks tenant ownership itself regardless. Prevents duplicate
 * promotion. Never creates an appraisal, campaign, transaction, or
 * communication — only a growOpportunities row.
 *
 * Leaves next_review_at NULL: a promoted signal is permanently terminal (see
 * the re-review policy in this file's header).
 *
 * =====================================================================
 * W2-D — THIS IS THE OUTREACH PATHWAY, AND IT IS NOW CLOSED
 * =====================================================================
 *
 * Making a suppressed contact's signals VISIBLE (see readActiveSignalsForParty
 * above) is only safe if visibility cannot be converted into outreach. This
 * function is the one place on the Property Intelligence surface where it
 * could have been, and it is not obvious at a glance, because this function
 * genuinely does not send anything. What it does is create a
 * growOpportunities row — and an opportunity is the INPUT to the outreach
 * funnel:
 *
 *     promoteSignal()  ->  growOpportunities row (partyId set)
 *                      ->  Grow Today Rules A/B/C read it as an
 *                          "opportunity_follow_up" card (growToday.ts:625)
 *                      ->  that card is where `{ action: "email" }` and
 *                          `{ action: "sms" }` buttons are rendered.
 *
 * Grow Today already refuses to attach those buttons for a suppressed
 * contact, and forces contactEmail/contactMobile to null in the response
 * itself (growToday.ts:631-667). So the funnel is defended at its far end and
 * a promoted row would NOT in fact produce a sendable affordance today.
 *
 * That is not sufficient, and relying on it would be exactly the "assert,
 * don't prove" this change is required to avoid. It would make the safety of
 * Contact 360 depend on a check in a file this work item may not modify, via
 * a table neither file mentions, with no test tying the two together — a
 * defence that survives only until someone adds a second opportunity consumer
 * that does not repeat Grow Today's check.
 *
 * So the pathway is cut at the source as well: a suppressed contact's signal
 * cannot be promoted at all. Defence in depth, with the near end of the
 * funnel closed by the same definition of "suppressed" the read uses. The
 * agent keeps the intelligence; the funnel keeps the contact out.
 *
 * REFUSED, NOT HIDDEN. A 409 that names the reason, not a silent no-op and
 * not a 404 — the agent is entitled to know the signal exists, that it was
 * their own brokerage's DNC record that stopped them, and that nothing is
 * broken. Consistent with the panel, which does not render the control at
 * all; this check is what makes that a defence rather than a decoration,
 * since the route is reachable without the panel.
 */
export async function promoteSignal(input: { signalId: number; brokerageId: number; userId: number }): Promise<{
  signal: GrowOpportunitySignal;
  opportunityId: number;
}> {
  const existing = await assertSignalInBrokerage(input.signalId, input.brokerageId);
  if (existing.promotedOpportunityId !== null) {
    throw new PropertyIntelligenceTransitionError("Signal has already been promoted to an opportunity");
  }
  if (existing.status === "Dismissed") {
    throw new PropertyIntelligenceTransitionError("A dismissed signal cannot be promoted — review it first");
  }
  if (existing.partyId === null) {
    throw new PropertyIntelligenceTransitionError("Signal has no linked contact and cannot be promoted to an opportunity");
  }

  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, existing.partyId), eq(parties.brokerageId, input.brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");

  // Checked AFTER tenancy (so a foreign signal is still a 404, never a 409
  // that would confirm the row exists) and BEFORE the insert, so no
  // opportunity row is ever created and rolled back.
  const restriction = await isOutreachRestrictedForParty(existing.partyId, input.brokerageId);
  if (restriction) {
    throw new PropertyIntelligenceTransitionError(
      "This contact is on a do-not-contact record or is suppressed on every channel. The signal stays visible on their record, but it cannot be promoted to an opportunity — an opportunity is how a contact enters the follow-up and outreach funnel.",
    );
  }

  const [opportunity] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: input.brokerageId,
      partyId: existing.partyId,
      propertyId: existing.propertyId,
      opportunityType: "Listing",
      status: "Open",
      stage: "New",
      ownerUserId: input.userId,
      source: "property_intelligence_signal",
      reason: existing.explanation,
    })
    .returning();

  const [updatedSignal] = await db
    .update(growOpportunitySignals)
    .set({
      status: "Superseded",
      promotedOpportunityId: opportunity.id,
      reviewedByUserId: input.userId,
      reviewedAt: new Date(),
      nextReviewAt: null,
      updatedAt: new Date(),
    })
    .where(eq(growOpportunitySignals.id, existing.id))
    .returning();

  await logAudit({
    userId: input.userId,
    action: "property_intelligence_signal_promoted",
    recordType: "grow_opportunity_signal",
    recordId: String(existing.id),
    propertyId: existing.propertyId ?? undefined,
    updatedValue: JSON.stringify({ promotedOpportunityId: opportunity.id }),
  });

  return { signal: updatedSignal, opportunityId: opportunity.id };
}
