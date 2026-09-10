import { and, eq } from "drizzle-orm";
import { db, growActivities, growOpportunities, growRelationships, parties, properties } from "@aee/db";

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

export const GROW_TODAY_PRIORITIES = ["DoNow", "DoToday", "KeepWarm"] as const;
export type GrowTodayPriority = (typeof GROW_TODAY_PRIORITIES)[number];

export type GrowTodayActionType = "opportunity_follow_up" | "opportunity_no_action_set" | "relationship_cold";

export type GrowTodayActionButton =
  | { action: "add_note" }
  | { action: "view_property"; propertyId: number }
  | { action: "update_next_action"; opportunityId: number }
  | { action: "ask_ae" };

export interface GrowTodayAction {
  id: string;
  type: GrowTodayActionType;
  priority: GrowTodayPriority;
  partyId: number;
  contactName: string;
  relationshipType: string | null;
  propertyId: number | null;
  propertyLabel: string | null;
  opportunityId: number | null;
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
  propertyAddress: string | null;
}

export async function getGrowTodaySummary(brokerageId: number): Promise<GrowTodaySummary> {
  const [relationshipRows, opportunityRows, activityRows] = await Promise.all([
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
    availableActions.push({ action: "ask_ae" });

    const lastActivityAt = o.lastMeaningfulContactAt ?? lastActivityByParty.get(o.partyId) ?? null;

    actions.push({
      id: `opportunity:${o.id}`,
      type,
      priority,
      partyId: o.partyId,
      contactName: contactDisplayName(o),
      relationshipType: null,
      propertyId: o.propertyId,
      propertyLabel: o.propertyAddress ?? null,
      opportunityId: o.id,
      reason,
      recommendedAction,
      dueAt: o.nextActionDueAt ? o.nextActionDueAt.toISOString() : null,
      lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
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
    availableActions.push({ action: "ask_ae" });

    actions.push({
      id: `relationship:${r.id}`,
      type: "relationship_cold",
      priority: "KeepWarm",
      partyId: r.partyId,
      contactName: contactDisplayName(r),
      relationshipType: r.relationshipType,
      propertyId: r.propertyId,
      propertyLabel: r.propertyAddress ?? null,
      opportunityId: null,
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
    hasAnyGrowData: relationshipRows.length > 0 || opportunityRows.length > 0,
    counts: {
      priorityActions: actions.length,
      followUpsDue: followUpsDueCount,
      openOpportunities: opportunityRows.length,
      contactsNeedingAttention,
    },
    priorityActions: actions,
  };
}
