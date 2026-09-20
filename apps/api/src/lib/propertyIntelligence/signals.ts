import { and, eq, isNotNull, lt } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  growOpportunities,
  properties,
  parties,
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

/**
 * Active, non-expired, non-dismissed signals for a contact — used by Contact
 * 360 and Grow Today Rule F.
 *
 * =====================================================================
 * CONTACTABILITY IS CHECKED ON READ, NOT ONLY ON WRITE
 * =====================================================================
 *
 * THE HOLE THIS CLOSES. The sweep consults the contactability filter when it
 * RAISES a signal, which only protects a contact who was already DNC-listed
 * or fully suppressed at that moment. For a contact listed AFTERWARDS the
 * existing row was stranded in exactly the wrong state:
 *
 *   - the sweep drops their candidate, so the row is never refreshed;
 *   - but the candidate still counts as SUPPORTED, so the "no longer
 *     supported -> Expired" pass deliberately leaves it alone (and correctly
 *     so — the filter must hide a contact, never silently retire their
 *     history);
 *   - and these rows carry expires_at IS NULL, so the expiry pass never
 *     touches them either.
 *
 * The row therefore stayed Active forever and kept being surfaced. A
 * write-time-only check cannot fix that, because the event that must change
 * the answer (a DNC listing) happens after the write.
 *
 * WHAT THIS DOES. Hides, never retires. A suppressed contact's signals are
 * withheld from this read; the rows themselves are not touched, not expired,
 * not dismissed, and reappear the moment the suppression lapses. That is the
 * same rule stage 1 applied to the sweep, now applied on the way out as well.
 *
 * WHAT COUNTS AS SUPPRESSED is owned entirely by
 * ./contactability.ts — DNC LISTED on any channel, or an in-force
 * suppression on EVERY channel. A partial (single-channel) suppression
 * deliberately does NOT hide: the agent can still reach that contact another
 * way, and hiding it would lose information they are entitled to see. This
 * function makes no consent decision of its own and writes nothing.
 *
 * NOT APPLIED TO listSignalsForProperty() ABOVE, deliberately and for the
 * same reason recalculateSignalsForProperty() does not apply it: that is an
 * explicit, entitled, per-property human action on a record the agent has
 * already navigated to, not a system-initiated suggestion about a person. See
 * this stage's report — it is flagged there for a product decision rather
 * than changed unilaterally.
 */
export async function listActiveSignalsForParty(partyId: number, brokerageId: number): Promise<GrowOpportunitySignal[]> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");

  // Checked BEFORE the signal read: a suppressed contact's rows are never
  // loaded at all, so there is no window in which they exist in memory on a
  // surfacing path.
  const contactability = await loadContactabilityFilter(brokerageId, [partyId]);
  if (contactability.isSuppressed(partyId)) return [];

  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.partyId, partyId), eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.status, "Active")));
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
