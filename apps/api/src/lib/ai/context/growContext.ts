import { and, count, desc, eq, gte } from "drizzle-orm";
import { db, growActivities, growOpportunities, growRelationships } from "@aee/db";
import { resolveEntitlements } from "../../entitlements/resolver.js";
import type { EntitlementActor } from "../../entitlements/types.js";
import { getGrowTodaySummary, type GrowTodayAction } from "../../growToday.js";
import type { GrowContext, GrowOpportunityStageSummary, GrowRecentActivityView, GrowRelationshipTypeCount, GrowTodayItemView } from "../types.js";

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
 * Tenant isolation: every query below is scoped by brokerageId, taken from
 * the authenticated caller's own session (orchestrator.ts -> contextEngine.ts
 * -> here) and never from anything the client could influence. This function
 * never receives or trusts a brokerageId supplied by request body/params.
 *
 * Bounding: every list on GrowContext is capped by one of the *_LIMIT
 * constants below before it leaves this file, regardless of how much Grow
 * data the brokerage holds — the Stage B "avoid unbounded queries into
 * model context" requirement is enforced HERE, at the one place all of it
 * funnels through, rather than repeated in each of the eight tools that
 * merely read a field off the finished GrowContext.
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

async function computeRelationshipBreakdown(brokerageId: number): Promise<GrowRelationshipTypeCount[]> {
  const rows = await db
    .select({ relationshipType: growRelationships.relationshipType, count: count() })
    .from(growRelationships)
    .where(and(eq(growRelationships.brokerageId, brokerageId), eq(growRelationships.status, "Active")))
    .groupBy(growRelationships.relationshipType);
  return rows.map((row) => ({ relationshipType: row.relationshipType, count: Number(row.count) }));
}

async function computeOpportunityPipeline(brokerageId: number): Promise<GrowOpportunityStageSummary[]> {
  const rows = await db
    .select({ stage: growOpportunities.stage, count: count() })
    .from(growOpportunities)
    .where(and(eq(growOpportunities.brokerageId, brokerageId), eq(growOpportunities.status, "Open")))
    .groupBy(growOpportunities.stage);
  return rows.map((row) => ({ stage: row.stage, count: Number(row.count) }));
}

async function computeRecentActivity(brokerageId: number): Promise<GrowRecentActivityView[]> {
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
    .where(and(eq(growActivities.brokerageId, brokerageId), gte(growActivities.occurredAt, since)))
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
 */
export async function buildGrowContext(brokerageId: number, focusItemId: string | null): Promise<GrowContext> {
  const includePropertyIntelligenceSignals = await brokerageHasEntitlement(brokerageId, "grow.propertyIntelligence.read");

  const [todaySummary, relationshipBreakdown, opportunityPipeline, recentActivity] = await Promise.all([
    getGrowTodaySummary(brokerageId, { includePropertyIntelligenceSignals }),
    computeRelationshipBreakdown(brokerageId),
    computeOpportunityPipeline(brokerageId),
    computeRecentActivity(brokerageId),
  ]);

  const allItems = todaySummary.priorityActions.map(toItemView);
  const todayItems = allItems.slice(0, GROW_TODAY_ITEMS_LIMIT);
  const dueFollowUps = allItems
    .filter((item) => item.dueAt !== null)
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
    appraisalFollowUps,
    activeSignals,
    opportunityPipeline,
    recentActivity,
  };
}
