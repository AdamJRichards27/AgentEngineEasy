import { and, asc, count, desc, eq, gte, lte } from "drizzle-orm";
import { db, growActivities, growCommitments, growOpportunities, growRelationships, parties, properties } from "@aee/db";
import { resolveEntitlements } from "../../entitlements/resolver.js";
import type { EntitlementActor } from "../../entitlements/types.js";
import { getGrowTodaySummary, type GrowTodayAction } from "../../growToday.js";
import { visibleLinkedPropertySql } from "../../propertyVisibility.js";
import type {
  GrowContext,
  GrowDueCommitmentView,
  GrowOpportunityStageSummary,
  GrowRecentActivityView,
  GrowRelationshipTypeCount,
  GrowTodayItemView,
} from "../types.js";

/**
 * AE GROW Priority 6 Stage B — Grow context builder.
 *
 * Replaces the Priority-0.5-era placeholder ("architect the shape, do not
 * build Grow itself" — this was always the deferred follow-up that stop
 * point pointed to). Deliberately reuses lib/growToday.ts's
 * getGrowTodaySummary() rather than re-querying growRelationships/
 * growOpportunities/appraisals/growOpportunitySignals from scratch: that
 * function is Priority 1/3/4/5's own already-tested "what needs attention
 * today" engine, and every item this builder exposes to the model is a
 * genuine subset of what the exact same authenticated user can already see
 * on the real Grow Today page (routes/grow.ts's GET /grow/today) — nothing
 * here computes a NEW judgement about a contact or property that the rest
 * of the product doesn't already make and show.
 *
 * F-6 adds one extra read, computeDueCommitments, of grow_commitments. It
 * uses the same brokerage / Open / due-today-or-overdue predicate F-1
 * already uses to build commitment cards, capped for the model. It is not
 * a new ranking and it is not the Grow Today follow-up list.
 *
 * Tenant isolation: every query below is scoped by brokerageId, taken from
 * the authenticated caller's own session (orchestrator.ts -> contextEngine.ts
 * -> here) and never from anything the client could influence. This function
 * never receives or trusts a brokerageId supplied by request body/params.
 *
 * Bounding: every list on GrowContext is capped by one of the *_LIMIT
 * constants below before it leaves this file, regardless of how much Grow
 * data the brokerage holds — the Stage B "avoid unbounded queries into
 * model context" requirement is enforced HERE, at the one place all of it
 * funnels through, rather than repeated in each of the tools that merely
 * read a field off the finished GrowContext.
 *
 * Data minimisation: GrowTodayItemView deliberately drops the contact
 * email/mobile/availableActions fields the real GrowTodayAction carries —
 * Stage B never emails, texts, or offers a UI affordance from an AI
 * response, so those fields would only be extra personal information
 * riding along in a model prompt with no purpose.
 *
 * Fail closed: every query here throws on a real database error rather than
 * swallowing it into an empty GrowContext — orchestrator.ts's askCopilot()
 * lets that error propagate as a 500 (routes/ai.ts's existing catch-all),
 * never as a silent "Grow has no data" answer that would be indistinguishable
 * from a genuinely empty brokerage.
 */

const GROW_TODAY_ITEMS_LIMIT = 20;
const DUE_FOLLOWUPS_LIMIT = 20;
// F-6 — same prompt bound as due follow-ups. The underlying Grow Today
// commitment read (GROW_TODAY_COMMITMENT_ROW_CAP) is larger; this slice is
// what the model is allowed to see in one call. Most overdue first, so a
// truncation drops the least overdue.
const DUE_COMMITMENTS_LIMIT = 20;
const APPRAISAL_FOLLOWUPS_LIMIT = 15;
const ACTIVE_SIGNALS_LIMIT = 20;
const RECENT_ACTIVITY_LIMIT = 20;
const RECENT_ACTIVITY_LOOKBACK_DAYS = 14;

function toItemView(action: GrowTodayAction): GrowTodayItemView {
  return {
    id: action.id,
    type: action.type,
    priority: action.priority,
    partyId: action.partyId,
    contactName: action.contactName,
    propertyId: action.propertyId,
    propertyLabel: action.propertyLabel,
    opportunityId: action.opportunityId,
    appraisalId: action.appraisalId,
    reason: action.reason,
    recommendedAction: action.recommendedAction,
    dueAt: action.dueAt,
    lastActivityAt: action.lastActivityAt,
  };
}

// Mirrors lib/ai/entitlements.ts's resolveBrokerageTier() exactly: a
// synthetic system-level actor, because every entitlement grant this
// codebase issues is brokerage-scoped (never user-scoped), and this
// question is "does this BROKERAGE hold grow.propertyIntelligence.read",
// not "does this one user". Kept local to this file rather than exported —
// nothing else needs a Grow-specific entitlement check today.
async function brokerageHasEntitlement(brokerageId: number, entitlementKey: string): Promise<boolean> {
  const systemActor: EntitlementActor = { id: -1, role: "system", brokerageId };
  const entitlements = await resolveEntitlements(systemActor);
  return entitlements.has(entitlementKey);
}

async function computeRelationshipBreakdown(
  brokerageId: number,
  restrictToPropertyIds: number[] | null,
): Promise<GrowRelationshipTypeCount[]> {
  const rows = await db
    .select({ relationshipType: growRelationships.relationshipType, count: count() })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.status, "Active"),
        visibleLinkedPropertySql(growRelationships.propertyId, restrictToPropertyIds),
      ),
    )
    .groupBy(growRelationships.relationshipType);
  return rows.map((row) => ({ relationshipType: row.relationshipType, count: Number(row.count) }));
}

async function computeOpportunityPipeline(
  brokerageId: number,
  restrictToPropertyIds: number[] | null,
): Promise<GrowOpportunityStageSummary[]> {
  const rows = await db
    .select({ stage: growOpportunities.stage, count: count() })
    .from(growOpportunities)
    .where(
      and(
        eq(growOpportunities.brokerageId, brokerageId),
        eq(growOpportunities.status, "Open"),
        visibleLinkedPropertySql(growOpportunities.propertyId, restrictToPropertyIds),
      ),
    )
    .groupBy(growOpportunities.stage);
  return rows.map((row) => ({ stage: row.stage, count: Number(row.count) }));
}

// Same UTC end-of-today boundary Grow Today uses for "due today or overdue"
// (growToday.ts endOfTodayUtc). Kept local: that helper is not exported, and
// importing a second copy of the ranking rules from here would couple the
// AI context builder to Grow Today's card logic. The predicate below is the
// F-1 grow_commitments predicate (brokerage, Open, dueAt <= end of today).
function endOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
}

function contactDisplayName(party: {
  firstName: string | null;
  lastName: string | null;
  organisationName: string | null;
}): string {
  if (party.organisationName) return party.organisationName;
  const name = `${party.firstName ?? ""} ${party.lastName ?? ""}`.trim();
  return name.length > 0 ? name : "Unknown contact";
}

// F-6 — the commitment read get_due_commitments exists to expose.
//
// This is not a filter of Grow Today cards. F-1 already surfaces Open
// commitments that are due today or overdue as cards of type "commitment",
// but those cards share GrowTodayItemView with opportunity next-actions and
// appraisal follow-ups. Reading that list answered "what did I promise?"
// with follow-ups. This query reads grow_commitments directly, with the
// same brokerage, status, and due-date predicate F-1 uses, and returns the
// row fields (id, description, dueAt, party, property, opportunity).
//
// The party join repeats brokerageId so a bad foreign key cannot attach
// another tenant's name. The property join does the same for the address:
// a property id that is not in this brokerage contributes a null label,
// never the other tenant's address. Email and mobile are not selected.
async function computeDueCommitments(brokerageId: number, restrictToPropertyIds: number[] | null): Promise<GrowDueCommitmentView[]> {
  const rows = await db
    .select({
      id: growCommitments.id,
      partyId: growCommitments.partyId,
      propertyId: growCommitments.propertyId,
      opportunityId: growCommitments.opportunityId,
      description: growCommitments.description,
      dueAt: growCommitments.dueAt,
      firstName: parties.firstName,
      lastName: parties.lastName,
      organisationName: parties.organisationName,
      propertyAddress: properties.formattedAddress,
    })
    .from(growCommitments)
    .innerJoin(parties, and(eq(growCommitments.partyId, parties.id), eq(parties.brokerageId, brokerageId)))
    .leftJoin(properties, and(eq(growCommitments.propertyId, properties.id), eq(properties.brokerageId, brokerageId)))
    .where(
      and(
        eq(growCommitments.brokerageId, brokerageId),
        eq(growCommitments.status, "Open"),
        lte(growCommitments.dueAt, endOfTodayUtc()),
        visibleLinkedPropertySql(growCommitments.propertyId, restrictToPropertyIds),
      ),
    )
    .orderBy(asc(growCommitments.dueAt), asc(growCommitments.id))
    .limit(DUE_COMMITMENTS_LIMIT);

  return rows.map((row) => ({
    id: row.id,
    status: "Open",
    partyId: row.partyId,
    contactName: contactDisplayName(row),
    propertyId: row.propertyId,
    propertyLabel: row.propertyAddress ?? null,
    opportunityId: row.opportunityId,
    description: row.description,
    dueAt: row.dueAt.toISOString(),
  }));
}

async function computeRecentActivity(brokerageId: number, restrictToPropertyIds: number[] | null): Promise<GrowRecentActivityView[]> {
  const since = new Date(Date.now() - RECENT_ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: growActivities.id,
      partyId: growActivities.partyId,
      propertyId: growActivities.propertyId,
      activityType: growActivities.activityType,
      occurredAt: growActivities.occurredAt,
      summary: growActivities.summary,
    })
    .from(growActivities)
    .where(
      and(
        eq(growActivities.brokerageId, brokerageId),
        gte(growActivities.occurredAt, since),
        visibleLinkedPropertySql(growActivities.propertyId, restrictToPropertyIds),
      ),
    )
    .orderBy(desc(growActivities.occurredAt))
    .limit(RECENT_ACTIVITY_LIMIT);
  return rows.map((row) => ({
    id: row.id,
    partyId: row.partyId,
    propertyId: row.propertyId,
    activityType: row.activityType,
    occurredAt: row.occurredAt.toISOString(),
    summary: row.summary,
  }));
}

/**
 * @param brokerageId Authenticated caller's own brokerage — never client-supplied.
 * @param focusItemId Optional Grow Today item id (e.g. "opportunity:123") the
 *   caller wants explained. Looked up by exact match against this SAME
 *   brokerage's own Grow Today list — never used in a raw query, so an
 *   unrecognised or foreign-brokerage id simply resolves to `focusedItem:
 *   null` rather than an error or a cross-tenant leak.
 * @param restrictToPropertyIds The caller's `restrictedPropertyIdsFor` result.
 *   Null (the default) is brokerage-wide: Brokerage Administrator, Pit Crew,
 *   and existing callers that do not pass a scope. An array keeps contact-level
 *   rows and drops another agent's property-linked rows, the same filter Grow
 *   Today already applies.
 */
export async function buildGrowContext(
  brokerageId: number,
  focusItemId: string | null,
  restrictToPropertyIds: number[] | null = null,
): Promise<GrowContext> {
  const includePropertyIntelligenceSignals = await brokerageHasEntitlement(brokerageId, "grow.propertyIntelligence.read");

  const [todaySummary, relationshipBreakdown, opportunityPipeline, recentActivity, dueCommitments] = await Promise.all([
    getGrowTodaySummary(brokerageId, { includePropertyIntelligenceSignals, restrictToPropertyIds }),
    computeRelationshipBreakdown(brokerageId, restrictToPropertyIds),
    computeOpportunityPipeline(brokerageId, restrictToPropertyIds),
    computeRecentActivity(brokerageId, restrictToPropertyIds),
    computeDueCommitments(brokerageId, restrictToPropertyIds),
  ]);

  const allItems = todaySummary.priorityActions.map(toItemView);
  const todayItems = allItems.slice(0, GROW_TODAY_ITEMS_LIMIT);
  // Commitment cards carry a dueAt, but they are not follow-ups. Leaving
  // them in this list is how get_grow_today_due_items used to answer a
  // commitments question. Recorded promises are dueCommitments.
  const dueFollowUps = allItems
    .filter((item) => item.dueAt !== null && item.type !== "commitment")
    .sort((a, b) => (a.dueAt as string).localeCompare(b.dueAt as string))
    .slice(0, DUE_FOLLOWUPS_LIMIT);
  const appraisalFollowUps = allItems.filter((item) => item.type === "appraisal_follow_up").slice(0, APPRAISAL_FOLLOWUPS_LIMIT);
  const activeSignals = allItems.filter((item) => item.type === "property_intelligence_signal").slice(0, ACTIVE_SIGNALS_LIMIT);
  const focusedItem = focusItemId === null ? null : allItems.find((item) => item.id === focusItemId) ?? null;

  return {
    generatedAt: todaySummary.generatedAt,
    hasAnyGrowData: todaySummary.hasAnyGrowData,
    counts: todaySummary.counts,
    relationshipBreakdown,
    todayItems,
    focusedItem,
    dueFollowUps,
    dueCommitments,
    appraisalFollowUps,
    activeSignals,
    opportunityPipeline,
    recentActivity,
  };
}
