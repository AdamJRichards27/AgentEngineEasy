import { and, eq, lt, isNotNull, notInArray } from "drizzle-orm";
import {
  db,
  growOpportunitySignals,
  propertyProviderObservations,
  growRelationships,
  growOpportunities,
  appraisals,
  properties,
  parties,
  type GrowOpportunitySignal,
  type PropertySignalType,
  type PropertySignalConfidenceBand,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { PropertyIntelligenceAccessError } from "./observations.js";
import { PropertyIntelligenceTransitionError } from "./matches.js";

/**
 * AE GROW Priority 5 Remediation — the deterministic rule engine the
 * merged schema (packages/db/src/schema/propertyIntelligence.ts) already
 * documents at lib/propertyIntelligence/signals.ts, but which never
 * actually shipped (see the remediation tracking report's lead finding).
 *
 * Every rule below reads ONLY data genuinely available in AE today:
 * growRelationships, appraisals, and propertyProviderObservations rows a
 * caller (a test fixture, or a future provider-ingestion job — see
 * observations.ts) actually wrote. Nothing here invents or estimates a
 * fact a provider never supplied. The four PROPERTY_SIGNAL_TYPES this
 * codebase declares but that have no real evidence source wired
 * (land_use_zoning_change, lease_tenancy_milestone, agent_recorded_motivation,
 * re_engagement_opportunity) are deliberately NOT implemented here — see
 * the remediation tracking report's "Genuine gaps" section for why
 * fabricating a rule for them would violate the remediation's own
 * "do not manufacture provider data to make a rule appear functional"
 * instruction.
 *
 * Idempotency and dismissal-resistance are both derived from one
 * mechanism: dedupeKey encodes not just "this kind of signal, on this
 * property" but the SPECIFIC underlying row that justifies it (a
 * relationship id, an appraisal id, or a specific observation id). A
 * recalculation that finds the exact same underlying row produces the
 * exact same dedupeKey; a genuinely new/changed piece of evidence (a new
 * observation row, e.g.) produces a NEW dedupeKey. Combined with
 * upsertSignal's rule below ("never resurrect a human-decided signal"),
 * this gives exactly the "resistant to immediate regeneration after
 * dismissal unless material evidence changes" behaviour the remediation
 * objective asks for, without needing a separate evidence-diffing pass.
 */

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

const HUMAN_DECIDED_STATUSES = new Set(["Dismissed", "Reviewed", "Superseded"]);

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

interface SignalCandidate {
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
}

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new PropertyIntelligenceAccessError("Property not found");
}

/** Rule 1 — long ownership tenure, from growRelationships (owner/co_owner, Active). */
async function longOwnershipTenureCandidates(propertyId: number, brokerageId: number, now: Date): Promise<SignalCandidate[]> {
  const rows = await db
    .select()
    .from(growRelationships)
    .where(and(eq(growRelationships.propertyId, propertyId), eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active")));

  const candidates: SignalCandidate[] = [];
  for (const r of rows) {
    if (r.relationshipType !== "owner" && r.relationshipType !== "co_owner") continue;
    const years = daysBetween(now, r.validFrom) / 365;
    if (years < LONG_OWNERSHIP_TENURE_YEARS_EMERGING) continue;
    const confidenceBand: PropertySignalConfidenceBand =
      years >= LONG_OWNERSHIP_TENURE_YEARS_STRONG ? "StrongIndicator" : years >= LONG_OWNERSHIP_TENURE_YEARS_WORTH_REVIEWING ? "WorthReviewing" : "Emerging";
    candidates.push({
      brokerageId,
      partyId: r.partyId,
      propertyId,
      signalType: "long_ownership_tenure",
      title: "Long ownership tenure",
      explanation: `This contact has been recorded as ${r.relationshipType === "co_owner" ? "a co-owner" : "the owner"} of this property for approximately ${Math.floor(years)} years. AE surfaces long ownership tenure as a pattern worth reviewing, since an owner's circumstances can change over a long tenure — this is not a prediction about this contact's plans, and AE has no information about their private intentions.`,
      evidence: { relationshipId: r.id, relationshipType: r.relationshipType, validFrom: r.validFrom.toISOString(), approximateTenureYears: Math.floor(years) },
      source: "internal",
      sourceTimestamp: r.validFrom,
      confidenceBand,
      expiresAt: null,
      dedupeKey: `${brokerageId}:long_ownership_tenure:${propertyId}:${r.id}`,
    });
  }
  return candidates;
}

/** Rule 2 — stale appraisal follow-up, from the appraisals table (FOLLOW_UP overdue, or DEFERRED long ago). */
async function staleAppraisalCandidates(propertyId: number, brokerageId: number, now: Date): Promise<SignalCandidate[]> {
  const rows = await db.select().from(appraisals).where(eq(appraisals.propertyId, propertyId));
  const candidates: SignalCandidate[] = [];
  for (const a of rows) {
    let referenceDate: Date | null = null;
    let reasonPrefix = "";
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
      propertyId,
      signalType: "stale_previous_appraisal",
      title: "Stale previous appraisal",
      explanation: `${reasonPrefix} (${overdueDays} days) — worth a check-in to see whether their plans have changed.`,
      evidence: { appraisalId: a.id, status: a.status, outcome: a.outcome, overdueDays },
      source: "internal",
      sourceTimestamp: referenceDate,
      confidenceBand,
      expiresAt: null,
      dedupeKey: `${brokerageId}:stale_previous_appraisal:${propertyId}:${a.id}`,
    });
  }
  return candidates;
}

/** Rule 3 — past buyer interest with no opportunity yet created (re-engagement candidate). */
async function pastBuyerInterestCandidates(propertyId: number, brokerageId: number): Promise<SignalCandidate[]> {
  const rows = await db
    .select()
    .from(growRelationships)
    .where(and(eq(growRelationships.propertyId, propertyId), eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active")));

  const candidates: SignalCandidate[] = [];
  for (const r of rows) {
    if (r.relationshipType !== "prospective_buyer" && r.relationshipType !== "buyer") continue;
    const [existingOpportunity] = await db
      .select({ id: growOpportunities.id })
      .from(growOpportunities)
      .where(and(eq(growOpportunities.partyId, r.partyId), eq(growOpportunities.propertyId, propertyId)));
    if (existingOpportunity) continue;
    candidates.push({
      brokerageId,
      partyId: r.partyId,
      propertyId,
      signalType: "past_buyer_interest",
      title: "Past buyer interest, not yet followed up",
      explanation: "This contact was recorded as an interested buyer for this property, but no opportunity has been created for them yet.",
      evidence: { relationshipId: r.id, relationshipType: r.relationshipType },
      source: "internal",
      sourceTimestamp: r.validFrom,
      confidenceBand: "Emerging",
      expiresAt: null,
      dedupeKey: `${brokerageId}:past_buyer_interest:${propertyId}:${r.id}`,
    });
  }
  return candidates;
}

const OBSERVATION_SIGNAL_MAP: Record<string, { signalType: PropertySignalType; title: string; describe: (payload: Record<string, unknown>) => string }> = {
  sales_history: {
    signalType: "recent_nearby_sales_activity",
    title: "Recent nearby sales activity",
    describe: () => "A provider observation recorded recent sales activity relevant to this property.",
  },
  // PROPERTY_OBSERVATION_TYPES' "market_activity" (packages/db/src/schema/propertyIntelligence.ts)
  // has no dedicated slot of its own among the schema's 12 PROPERTY_SIGNAL_TYPES — it shares
  // recent_nearby_sales_activity with sales_history above (the remediation objective's own
  // suggested "market-activity observation" signal type maps onto this closest existing type)
  // rather than inventing a 13th signal type outside the merged schema's fixed enum.
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

/** Rules 4-8 — one candidate per CURRENT (isCurrent = true) observation whose type maps to a signal above. */
async function observationCandidates(propertyId: number, brokerageId: number, now: Date): Promise<SignalCandidate[]> {
  const rows = await db
    .select()
    .from(propertyProviderObservations)
    .where(
      and(
        eq(propertyProviderObservations.propertyId, propertyId),
        eq(propertyProviderObservations.brokerageId, brokerageId),
        eq(propertyProviderObservations.isCurrent, true),
      ),
    );

  const candidates: SignalCandidate[] = [];
  for (const o of rows) {
    const mapping = OBSERVATION_SIGNAL_MAP[o.observationType];
    if (!mapping) continue; // address_candidate has no corresponding signal type — it feeds match review, not signals.
    const sourceTimestamp = o.sourceTimestamp ?? o.retrievedAt;
    const ageDays = daysBetween(now, sourceTimestamp);
    if (ageDays > OBSERVATION_SIGNAL_STALE_AFTER_DAYS) continue; // too old to raise a new signal from at all
    const confidenceBand: PropertySignalConfidenceBand =
      ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_STRONG ? "StrongIndicator" : ageDays <= OBSERVATION_FRESH_WITHIN_DAYS_WORTH_REVIEWING ? "WorthReviewing" : "Emerging";
    candidates.push({
      brokerageId,
      partyId: null,
      propertyId,
      signalType: mapping.signalType,
      title: mapping.title,
      explanation: mapping.describe((o.payload as Record<string, unknown>) ?? {}),
      evidence: { observationId: o.id, provider: o.provider, observationType: o.observationType, payload: o.payload },
      source: o.provider,
      sourceTimestamp,
      confidenceBand,
      expiresAt: addDays(sourceTimestamp, OBSERVATION_SIGNAL_STALE_AFTER_DAYS),
      dedupeKey: `${brokerageId}:${mapping.signalType}:${propertyId}:${o.id}`,
    });
  }
  return candidates;
}

async function computeCandidatesForProperty(propertyId: number, brokerageId: number): Promise<SignalCandidate[]> {
  const now = new Date();
  const [tenure, staleAppraisal, pastBuyer, observations] = await Promise.all([
    longOwnershipTenureCandidates(propertyId, brokerageId, now),
    staleAppraisalCandidates(propertyId, brokerageId, now),
    pastBuyerInterestCandidates(propertyId, brokerageId),
    observationCandidates(propertyId, brokerageId, now),
  ]);
  return [...tenure, ...staleAppraisal, ...pastBuyer, ...observations];
}

/**
 * Upserts one candidate by dedupeKey. Never resurrects a human-decided
 * signal (Dismissed/Reviewed/Superseded) — those are left completely
 * untouched, which is exactly the "resistant to immediate regeneration
 * after dismissal unless material evidence changes" behaviour: a
 * genuinely new piece of evidence produces a NEW dedupeKey (a new
 * observation row, a changed relationship), never collides with the old
 * one, and so is free to raise a brand new Active signal alongside the
 * dismissed one.
 */
async function upsertSignal(candidate: SignalCandidate): Promise<GrowOpportunitySignal | null> {
  const [existing] = await db.select().from(growOpportunitySignals).where(eq(growOpportunitySignals.dedupeKey, candidate.dedupeKey));

  if (!existing) {
    const [inserted] = await db
      .insert(growOpportunitySignals)
      .values({
        brokerageId: candidate.brokerageId,
        partyId: candidate.partyId,
        propertyId: candidate.propertyId,
        signalType: candidate.signalType,
        title: candidate.title,
        explanation: candidate.explanation,
        evidence: candidate.evidence,
        source: candidate.source,
        sourceTimestamp: candidate.sourceTimestamp,
        confidenceBand: candidate.confidenceBand,
        status: "Active",
        dedupeKey: candidate.dedupeKey,
        expiresAt: candidate.expiresAt,
      })
      .returning();
    return inserted;
  }

  if (HUMAN_DECIDED_STATUSES.has(existing.status)) {
    return existing; // left untouched — see this function's own doc comment.
  }

  // Active or Expired (auto-managed states): refresh the editorial fields and,
  // if it had expired but the underlying evidence is still being produced by
  // this recalculation, bring it back to Active.
  const [updated] = await db
    .update(growOpportunitySignals)
    .set({
      title: candidate.title,
      explanation: candidate.explanation,
      evidence: candidate.evidence,
      confidenceBand: candidate.confidenceBand,
      computedAt: new Date(),
      status: "Active",
      expiresAt: candidate.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(growOpportunitySignals.id, existing.id))
    .returning();
  return updated;
}

/**
 * Recomputes every rule for one property and upserts the result,
 * idempotently. Also expires any Active/Expired signal for this property
 * that this run's candidates no longer support (e.g. the relationship that
 * justified a long_ownership_tenure signal became Historical) — preserving
 * the row (never deleted) with status Expired rather than leaving a stale
 * Active signal with no current supporting evidence.
 */
export async function recalculateSignalsForProperty(propertyId: number, brokerageId: number): Promise<GrowOpportunitySignal[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  await expireStaleSignals(propertyId, brokerageId);

  const candidates = await computeCandidatesForProperty(propertyId, brokerageId);
  const results: GrowOpportunitySignal[] = [];
  for (const candidate of candidates) {
    const row = await upsertSignal(candidate);
    if (row) results.push(row);
  }

  const currentDedupeKeys = candidates.map((c) => c.dedupeKey);
  const autoManagedConditions = [
    eq(growOpportunitySignals.propertyId, propertyId),
    eq(growOpportunitySignals.brokerageId, brokerageId),
    eq(growOpportunitySignals.status, "Active"),
  ];
  const staleRows =
    currentDedupeKeys.length > 0
      ? await db
          .select({ id: growOpportunitySignals.id })
          .from(growOpportunitySignals)
          .where(and(...autoManagedConditions, notInArray(growOpportunitySignals.dedupeKey, currentDedupeKeys)))
      : await db
          .select({ id: growOpportunitySignals.id })
          .from(growOpportunitySignals)
          .where(and(...autoManagedConditions));
  for (const row of staleRows) {
    await db.update(growOpportunitySignals).set({ status: "Expired", updatedAt: new Date() }).where(eq(growOpportunitySignals.id, row.id));
  }

  return results;
}

/** Lazily flips any Active signal past its own expiresAt to Expired — no cron/scheduler needed. */
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

/** Active, non-expired, non-dismissed signals for a contact — used by Contact 360 and Grow Today Rule F. */
export async function listActiveSignalsForParty(partyId: number, brokerageId: number): Promise<GrowOpportunitySignal[]> {
  const [party] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.id, partyId), eq(parties.brokerageId, brokerageId)));
  if (!party) throw new PropertyIntelligenceAccessError("Contact not found");
  return db
    .select()
    .from(growOpportunitySignals)
    .where(and(eq(growOpportunitySignals.partyId, partyId), eq(growOpportunitySignals.brokerageId, brokerageId), eq(growOpportunitySignals.status, "Active")));
}

export async function reviewSignal(input: { signalId: number; brokerageId: number; userId: number }): Promise<GrowOpportunitySignal> {
  const existing = await assertSignalInBrokerage(input.signalId, input.brokerageId);
  if (HUMAN_DECIDED_STATUSES.has(existing.status)) {
    throw new PropertyIntelligenceTransitionError(`Signal is already ${existing.status}`);
  }
  const [updated] = await db
    .update(growOpportunitySignals)
    .set({ status: "Reviewed", reviewedByUserId: input.userId, reviewedAt: new Date(), updatedAt: new Date() })
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
  if (!input.dismissedReason || input.dismissedReason.trim().length === 0) {
    throw new PropertyIntelligenceTransitionError("dismissedReason is required to dismiss a signal");
  }
  const existing = await assertSignalInBrokerage(input.signalId, input.brokerageId);
  if (HUMAN_DECIDED_STATUSES.has(existing.status)) {
    throw new PropertyIntelligenceTransitionError(`Signal is already ${existing.status}`);
  }
  const [updated] = await db
    .update(growOpportunitySignals)
    .set({
      status: "Dismissed",
      dismissedReason: input.dismissedReason,
      reviewedByUserId: input.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
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
 * promotion (a signal with a promotedOpportunityId already set cannot be
 * promoted again). Never creates an appraisal, campaign, transaction, or
 * communication — only a growOpportunities row, exactly like every other
 * manual "Create opportunity" action in this codebase (routes/grow.ts).
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
    .set({ status: "Superseded", promotedOpportunityId: opportunity.id, reviewedByUserId: input.userId, reviewedAt: new Date(), updatedAt: new Date() })
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
