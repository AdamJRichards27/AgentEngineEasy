import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { db, appraisals, growActivities, growOpportunities, growOpportunitySignals, growRelationships, parties, properties } from "@aee/db";

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

export interface GrowTodayAction {
  id: string;
  type: GrowTodayActionType;
  priority: GrowTodayPriority;
  partyId: number;
  contactName: string;
  // AE Grow Priority 3 — additive: lets the frontend decide whether to
  // render an Email/SMS action without a second lookup.
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
}

// A relationship/opportunity with no recorded contact in this many days (or
// ever) is surfaced as "Keep Warm" — a documented, adjustable constant, not
// a magic number buried in the rule logic below.
const COLD_CONTACT_THRESHOLD_DAYS = 21;

// AE GROW Priority 5 Remediation — Rule F's own minimum evidence bar. An
// "Emerging" signal is, by the schema's own confidence-band definition
// (packages/db/src/schema/propertyIntelligence.ts), the weakest band —
// real, but not yet worth a daily action item. It stays fully visible and
// reviewable on the property/contact record; Rule F just doesn't promote
// it onto Today. Only the stronger two bands do.
const PROPERTY_INTELLIGENCE_MIN_CONFIDENCE_BANDS = ["WorthReviewing", "StrongIndicator"] as const;

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
  explanation: string;
  confidenceBand: string;
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
      explanation: growOpportunitySignals.explanation,
      confidenceBand: growOpportunitySignals.confidenceBand,
      partyFirstName: parties.firstName,
      partyLastName: parties.lastName,
      partyOrganisationName: parties.organisationName,
      partyEmail: parties.email,
      partyMobile: parties.mobile,
      propertyAddress: properties.formattedAddress,
    })
    .from(growOpportunitySignals)
    // Rule F only ever surfaces a signal that has a linked contact (see the
    // header comment above the loop below) — an inner join on parties is
    // therefore both correct and a cheap extra tenant/shape guard, not just
    // an optimisation.
    .innerJoin(parties, eq(growOpportunitySignals.partyId, parties.id))
    .leftJoin(properties, eq(growOpportunitySignals.propertyId, properties.id))
    .where(
      and(
        eq(growOpportunitySignals.brokerageId, brokerageId),
        eq(growOpportunitySignals.status, "Active"),
        inArray(growOpportunitySignals.confidenceBand, PROPERTY_INTELLIGENCE_MIN_CONFIDENCE_BANDS),
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

  const today0 = startOfTodayUtc();
  const today1 = endOfTodayUtc();
  const actions: GrowTodayAction[] = [];
  const partyIdsWithOpportunityAction = new Set<number>();
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

    if (o.nextActionDueAt) {
      type = "opportunity_follow_up";
      if (o.nextActionDueAt.getTime() < today0.getTime()) {
        priority = "DoNow";
        reason = `Follow-up was due ${formatDateUtc(o.nextActionDueAt)}.`;
        followUpsDueCount++;
      } else if (o.nextActionDueAt.getTime() <= today1.getTime()) {
        priority = "DoToday";
        reason = "Follow-up is due today.";
        followUpsDueCount++;
      }
      // A future nextActionDueAt falls through with priority still null and
      // is intentionally not surfaced — see the loop comment above.
    } else if (o.opportunityType === "Appraisal") {
      priority = "DoToday";
      reason = "New appraisal opportunity doesn't have a next action set yet.";
      recommendedAction = o.recommendedNextAction ?? "Set a next action for this appraisal.";
    } else {
      priority = "KeepWarm";
      reason = "This opportunity doesn't have a next action set yet.";
      recommendedAction = o.recommendedNextAction ?? "Decide the next step for this opportunity.";
    }

    if (!priority) continue;

    partyIdsWithOpportunityAction.add(o.partyId);
    const availableActions: GrowTodayActionButton[] = [
      { action: "add_note" },
      { action: "update_next_action", opportunityId: o.id },
    ];
    if (o.propertyId) availableActions.push({ action: "view_property", propertyId: o.propertyId });
    if (o.partyEmail) availableActions.push({ action: "email", partyId: o.partyId });
    if (o.partyMobile) availableActions.push({ action: "sms", partyId: o.partyId });
    availableActions.push({ action: "view_contact", partyId: o.partyId });
    availableActions.push({ action: "ask_ae" });

    const lastActivityAt = o.lastMeaningfulContactAt ?? lastActivityByParty.get(o.partyId) ?? null;

    actions.push({
      id: `opportunity:${o.id}`,
      type,
      priority,
      partyId: o.partyId,
      contactName: contactDisplayName(o),
      contactEmail: o.partyEmail ?? null,
      contactMobile: o.partyMobile ?? null,
      relationshipType: null,
      propertyId: o.propertyId,
      propertyLabel: o.propertyAddress ?? null,
      opportunityId: o.id,
      appraisalId: null,
      reason,
      recommendedAction,
      dueAt: o.nextActionDueAt ? o.nextActionDueAt.toISOString() : null,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
      availableActions,
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
    if (ap.followUpAt.getTime() < today0.getTime()) {
      priority = "DoNow";
      reason = `Appraisal follow-up was due ${formatDateUtc(ap.followUpAt)}.`;
      followUpsDueCount++;
    } else if (ap.followUpAt.getTime() <= today1.getTime()) {
      priority = "DoToday";
      reason = "Appraisal follow-up is due today.";
      followUpsDueCount++;
    } else {
      continue;
    }

    partyIdsWithOpportunityAction.add(ap.partyId);

    const lastActivityAtAppraisal = lastActivityByParty.get(ap.partyId) ?? null;
    const availableActions: GrowTodayActionButton[] = [{ action: "view_appraisal", appraisalId: ap.id }];
    if (ap.partyEmail) availableActions.push({ action: "email", partyId: ap.partyId });
    if (ap.partyMobile) availableActions.push({ action: "sms", partyId: ap.partyId });
    availableActions.push({ action: "view_contact", partyId: ap.partyId });
    availableActions.push({ action: "ask_ae" });

    actions.push({
      id: `appraisal:${ap.id}:followup`,
      type: "appraisal_follow_up",
      priority,
      partyId: ap.partyId,
      contactName: contactDisplayName(ap),
      contactEmail: ap.partyEmail ?? null,
      contactMobile: ap.partyMobile ?? null,
      relationshipType: null,
      propertyId: ap.propertyId,
      propertyLabel: ap.propertyAddress ?? null,
      opportunityId: ap.opportunityId,
      appraisalId: ap.id,
      reason,
      recommendedAction: ap.followUpNotes ?? "Follow up on this appraisal.",
      dueAt: ap.followUpAt.toISOString(),
      lastActivityAt: lastActivityAtAppraisal ? lastActivityAtAppraisal.toISOString() : null,
      availableActions,
    });
  }

  // AE GROW Priority 5 Remediation — Rule F. Surfaces a manageable item for
  // each Property Intelligence signal already filtered, by
  // fetchPropertyIntelligenceSignalRows above, down to: Active, not
  // expired (expiresAt null or in the future), belonging to this
  // brokerage, and at or above the WorthReviewing confidence bar — so this
  // loop only has two of the remediation objective's remaining conditions
  // left to enforce itself:
  //   1. "Not dismissed" — already guaranteed by the query's own
  //      status = "Active" condition; a Dismissed (or Reviewed/Superseded/
  //      Expired) signal is never returned in the first place, so no
  //      separate check is needed in this loop.
  //   2. "Linked to accessible records" — a signal with no linked contact
  //      (every current observation-derived signal type) is skipped. Grow
  //      Today's own GrowTodayAction contract requires a non-null partyId
  //      on every item (contactName/email/sms/view_contact all depend on
  //      it) — exactly the same invariant Rules A-E already rely on. This
  //      loses no information: a property-only signal with no linked
  //      contact is still visible, reviewable, dismissible and promotable
  //      from the Property Workspace's own Property Intelligence panel —
  //      it just isn't promoted onto Today as its own card.
  //
  // Like Rule E, a surfaced party is added to partyIdsWithOpportunityAction
  // so the same contact never also shows as a generic "cold" nudge via
  // Rule D below — they already have a specific, concrete reason to reach
  // out. Rule F never contacts anyone, never creates a commitment,
  // opportunity, appraisal, or property change, and never presents its
  // signal's inference as a verified fact: reason is always the signal's
  // own already-hedged, plain-language explanation (see
  // lib/propertyIntelligence/signals.ts's SignalCandidate.explanation),
  // and recommendedAction only ever asks the agent to review it themselves.
  for (const s of propertyIntelligenceSignalRows) {
    if (s.partyId === null) continue;

    const priority: GrowTodayPriority = s.confidenceBand === "StrongIndicator" ? "DoToday" : "KeepWarm";
    partyIdsWithOpportunityAction.add(s.partyId);

    const availableActions: GrowTodayActionButton[] = [{ action: "add_note" }];
    if (s.propertyId) availableActions.push({ action: "view_property", propertyId: s.propertyId });
    if (s.partyEmail) availableActions.push({ action: "email", partyId: s.partyId });
    if (s.partyMobile) availableActions.push({ action: "sms", partyId: s.partyId });
    availableActions.push({ action: "view_contact", partyId: s.partyId });
    availableActions.push({ action: "ask_ae" });

    const lastActivityAtSignal = lastActivityByParty.get(s.partyId) ?? null;

    actions.push({
      id: `signal:${s.id}`,
      type: "property_intelligence_signal",
      priority,
      partyId: s.partyId,
      contactName: contactDisplayName(s),
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
    });
  }

  const priorityOrder: Record<GrowTodayPriority, number> = { DoNow: 0, DoToday: 1, KeepWarm: 2 };
  actions.sort((a, b) => {
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt) return -1;
    if (b.dueAt) return 1;
    // Oldest last-contact (or never-contacted, via the "" fallback sorting first) leads within a tie.
    return (a.lastActivityAt ?? "").localeCompare(b.lastActivityAt ?? "");
  });

  const contactsNeedingAttention = new Set(actions.map((a) => a.partyId)).size;

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
  };
}
