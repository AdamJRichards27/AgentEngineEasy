import { eq } from "drizzle-orm";
import { db, amlVerifications, type UserRole } from "@aee/db";
import { BROKERAGE_ADMIN_ROLES } from "../../../middlewares/auth.js";
import { listOffersForProperty } from "../../offers.js";
import { getPropertyTimeline, type TimelineItem } from "../../timeline.js";
import type { AiContextPackage, AiToolDefinition, AiToolResult } from "../types.js";
import {
  AI_PRICE_WITHHELD_MARKER,
  containsPriceKey,
  resolveAiOfferPriceAccess,
  scrubDollarFigures,
} from "./offerPriceAccess.js";

// Tool Registry: every tool here is read-only (riskLevel 0) and wraps an
// existing service function or a simple scoped read - none of them write to the
// database. Every tool re-derives its scope from ctx.property, which the Context
// Engine has already brokerageId-checked, so a tool can never be pointed at
// another brokerage's data even if the model hallucinates an id.

const NO_PROPERTY_ERROR = "No property is in context for this request.";

const getPortfolioOverview: AiToolDefinition = {
  name: "get_portfolio_overview",
  description: "Read-only summary of the caller's brokerage: active property count and upcoming settlement count.",
  riskLevel: 0,
  async run(ctx) {
    return { tool: "get_portfolio_overview", ok: true, data: ctx.business };
  },
};

const getPropertySummary: AiToolDefinition = {
  name: "get_property_summary",
  description: "Read-only summary of the property in context: address and workflow stage.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_property_summary", ok: false, error: NO_PROPERTY_ERROR };
    }
    return { tool: "get_property_summary", ok: true, data: property };
  },
};

const getTransactionStatus: AiToolDefinition = {
  name: "get_transaction_status",
  description: "Read-only status of the transaction tied to the property in context, if one exists.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_transaction_status", ok: false, error: NO_PROPERTY_ERROR };
    }
    return { tool: "get_transaction_status", ok: true, data: ctx.transaction };
  },
};

// Owner t165u / t171u: offer prices reach the model only for the listing
// agent and Brokerage Administrators (tools/offerPriceAccess.ts). Pit Crew
// (the other brokerage-wide role) gets each offer's id and status with the
// price key omitted and a withheld marker. An Agent who is not the listing
// agent (own-property rule), a caller without run.access, another
// brokerage, or a caller who cannot be confirmed gets no offers at all. Decided here, inside the tool, so no prompt,
// UI or route change can widen it.
const NOT_AVAILABLE_ERROR = "This property is not available for this request.";
const NO_RUN_ACCESS_ERROR = "Offers are part of Run, which this account does not have access to.";

const getOffersForProperty: AiToolDefinition = {
  name: "get_offers_for_property",
  description:
    "Read-only list of offers made on the property in context. Offer prices are included only for the listing agent and Brokerage Administrators; for anyone else each offer carries offerTermsVisible: false and a withheld marker instead of a price.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_offers_for_property", ok: false, error: NO_PROPERTY_ERROR };
    }
    const access = await resolveAiOfferPriceAccess(ctx, property.id);
    if (access.kind === "denied") {
      return { tool: "get_offers_for_property", ok: false, error: NOT_AVAILABLE_ERROR };
    }
    if (access.kind === "no_run_access") {
      return { tool: "get_offers_for_property", ok: false, error: NO_RUN_ACCESS_ERROR };
    }
    const offers = await listOffersForProperty(property.id);
    const summarized =
      access.kind === "full"
        ? offers.map((offer) => ({ id: offer.id, status: offer.status, offerPriceCents: offer.offerPriceCents, offerTermsVisible: true as const }))
        : offers.map((offer) => ({ id: offer.id, status: offer.status, offerTermsVisible: false as const, offerPrice: AI_PRICE_WITHHELD_MARKER }));
    return { tool: "get_offers_for_property", ok: true, data: summarized };
  },
};

// Offer and transaction entries in the Property Timeline carry the offer or
// sale price in their label ("Offer received from X ($...)") and in their
// detail payload (offerPriceCents / purchasePriceCents). For a caller who may
// not see offer prices, those figures are removed here, on top of the
// Timeline's own Brokerage-Administrator-only financial redaction (#131/#134),
// which still applies to commission, funds and payout entries for everyone
// else, including the listing agent.
const PRICE_BEARING_TIMELINE_CATEGORIES = new Set<TimelineItem["category"]>(["Offer", "Transaction"]);

// A caller without run.access gets no offer data at all, so Offer entries
// are dropped from the timeline for them (dropOfferEntries), not just scrubbed.
export function redactTimelineForAi(
  items: TimelineItem[],
  options: { dropOfferEntries?: boolean } = {},
): Array<TimelineItem & { priceWithheld?: string }> {
  const kept = options.dropOfferEntries === true ? items.filter((item) => item.category !== "Offer") : items;
  return kept.map((item) => {
    const priceBearing = PRICE_BEARING_TIMELINE_CATEGORIES.has(item.category);
    const label = priceBearing ? scrubDollarFigures(item.label) : item.label;
    const dropDetail = item.detail !== undefined && (priceBearing || containsPriceKey(item.detail));
    if (label === item.label && !dropDetail) return item;
    const { detail: _detail, ...rest } = item;
    return {
      ...rest,
      label,
      priceWithheld: AI_PRICE_WITHHELD_MARKER,
    };
  });
}

const getPropertyTimelineTool: AiToolDefinition = {
  name: "get_property_timeline",
  description: "Read-only chronological timeline of events for the property in context.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_property_timeline", ok: false, error: NO_PROPERTY_ERROR };
    }
    // Owner t165u / t171u: same access decision as get_offers_for_property.
    const access = await resolveAiOfferPriceAccess(ctx, property.id);
    if (access.kind === "denied") {
      return { tool: "get_property_timeline", ok: false, error: NOT_AVAILABLE_ERROR };
    }
    // #131/#134 — the Timeline's financial-entitlement boundary applies to
    // every reader, including Copilot: a non-Brokerage-Administrator asking
    // the AI about a property must not get commission/funds/agent-paid
    // figures back through this tool when they couldn't see them on the
    // Property Workspace page itself. The role is the one access just
    // re-read from the database, not the request's own claim.
    const canViewFinancials = BROKERAGE_ADMIN_ROLES.includes(access.role as UserRole);
    const timeline = await getPropertyTimeline(property.id, ctx.brokerageId, canViewFinancials);
    return {
      tool: "get_property_timeline",
      ok: true,
      data: access.kind === "full" ? timeline : redactTimelineForAi(timeline, { dropOfferEntries: access.kind === "no_run_access" }),
    };
  },
};

const getAmlStatusForProperty: AiToolDefinition = {
  name: "get_aml_status_for_property",
  description: "Read-only AML verification status for parties on the property in context.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_aml_status_for_property", ok: false, error: NO_PROPERTY_ERROR };
    }
    const rows = await db.select().from(amlVerifications).where(eq(amlVerifications.propertyId, property.id));
    const summarized = rows.map((row) => ({ id: row.id, status: row.status }));
    return { tool: "get_aml_status_for_property", ok: true, data: summarized };
  },
};

export const TOOL_REGISTRY: AiToolDefinition[] = [
  getPortfolioOverview,
  getPropertySummary,
  getTransactionStatus,
  getOffersForProperty,
  getPropertyTimelineTool,
  getAmlStatusForProperty,
];

// AE GROW Priority 6 Stage B — Grow-scoped, read-only tools.
//
// Every tool below reads ONE already-bounded field off ctx.grow
// (context/growContext.ts) - none of them query the database directly, none
// of them accept a caller-supplied brokerageId/tenant filter, and none of
// them can return more rows than growContext.ts's own *_LIMIT constants
// already capped. This is deliberate: growContext.ts is the single place
// bounding/tenant-scoping happens for Grow, and every tool here is a thin,
// independently-testable read of its output - never a second, parallel path
// to the database that could drift out of sync with those limits.
//
// ctx.grow is only non-null when contextType === "grow" (contextEngine.ts) -
// so a Grow tool asked to run outside a Grow-scoped request (which should
// never happen given selectToolsForContext below, but is checked here too,
// defense in depth) fails closed with ok: false rather than throwing or
// silently returning stale/wrong data.
const NO_GROW_CONTEXT_ERROR = "No Grow context is available for this request.";

const getGrowTodayItems: AiToolDefinition = {
  name: "get_grow_today_items",
  description: "Read-only list of the caller's current Grow Today priority actions (who to call today, follow-ups, signals), already bounded and tenant-scoped.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_grow_today_items", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_grow_today_items", ok: true, data: ctx.grow.todayItems };
  },
};

const getContactRelationshipSummary: AiToolDefinition = {
  name: "get_contact_relationship_summary",
  description: "Read-only aggregate count of the caller's active Grow relationships, grouped by relationship type. Never returns individual contact details beyond what get_grow_today_items already exposes.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_contact_relationship_summary", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_contact_relationship_summary", ok: true, data: ctx.grow.relationshipBreakdown };
  },
};

// Named for what it actually returns. This tool reads ctx.grow.dueFollowUps,
// which growContext.ts builds by filtering Grow Today priority actions down
// to items that carry a dueAt and are not recorded commitments. It was
// called "get_due_commitments" until W2-C, which made the model answer
// "what did I promise?" with opportunity next-action dates. Do not point
// this tool back at grow_commitments. Recorded promises are
// get_due_commitments, below.
const getGrowTodayDueItems: AiToolDefinition = {
  name: "get_grow_today_due_items",
  description:
    "Read-only list of the caller's Grow Today items that carry a due date (opportunity next-action and appraisal follow-up due dates), soonest first. " +
    "This is a date-filtered view of the same Grow Today list as get_grow_today_items - it does NOT read recorded Grow commitments, so never describe these as commitments the caller made. Use get_due_commitments for those.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_grow_today_due_items", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_grow_today_due_items", ok: true, data: ctx.grow.dueFollowUps };
  },
};

// F-6 — the genuine commitments read. ctx.grow.dueCommitments is filled by
// growContext.ts's computeDueCommitments from grow_commitments (Open, due
// today or overdue, brokerage-scoped, capped). It is not dueFollowUps and
// not a Grow Today card. Renaming get_grow_today_due_items back to this
// name would return follow-ups again.
const getDueCommitments: AiToolDefinition = {
  name: "get_due_commitments",
  description:
    "Read-only list of the caller's Open Grow commitments that are due today or overdue, most overdue first. " +
    "Each row is a recorded grow_commitments promise (id, status, description, dueAt, contact, property, opportunity), already bounded and tenant-scoped. " +
    "This is not get_grow_today_due_items: opportunity next-actions and appraisal follow-ups are follow-ups, not commitments.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_due_commitments", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_due_commitments", ok: true, data: ctx.grow.dueCommitments };
  },
};

const getGrowOpportunityPipeline: AiToolDefinition = {
  name: "get_grow_opportunity_pipeline",
  description: "Read-only count of the caller's open Grow opportunities, grouped by pipeline stage.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_grow_opportunity_pipeline", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_grow_opportunity_pipeline", ok: true, data: ctx.grow.opportunityPipeline };
  },
};

const getAppraisalFollowups: AiToolDefinition = {
  name: "get_appraisal_followups",
  description: "Read-only list of the caller's Grow Today items that are appraisal follow-ups needing attention.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_appraisal_followups", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_appraisal_followups", ok: true, data: ctx.grow.appraisalFollowUps };
  },
};

// Naming note: this reads Property Intelligence SIGNALS already surfaced on
// the caller's own Grow Today list (growContext.ts's activeSignals, gated by
// includePropertyIntelligenceSignals's grow.propertyIntelligence.read
// entitlement check) - not a separate/broader Property Intelligence query.
const getPropertyIntelligenceSignals: AiToolDefinition = {
  name: "get_property_intelligence_signals",
  description: "Read-only list of the caller's active Property Intelligence signals as already surfaced on Grow Today, each carrying its own confidence band. Empty if the brokerage is not entitled to Property Intelligence.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_property_intelligence_signals", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_property_intelligence_signals", ok: true, data: ctx.grow.activeSignals };
  },
};

const getRecentRelationshipActivity: AiToolDefinition = {
  name: "get_recent_relationship_activity",
  description: "Read-only list of the caller's recent Grow relationship activity (last 14 days), most recent first.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_recent_relationship_activity", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_recent_relationship_activity", ok: true, data: ctx.grow.recentActivity };
  },
};

// The only Grow tool whose result depends on something other than
// brokerageId: growFocusItemId (threaded through
// AskCopilotInput -> BuildContextInput -> buildGrowContext -> ctx.grow.focusedItem).
// growContext.ts already resolves focusItemId by exact match against this
// SAME brokerage's own Grow Today list, so an id for another brokerage's item
// (or an id that doesn't exist) resolves to focusedItem: null here, never an
// error and never another tenant's data.
const explainGrowTodayItem: AiToolDefinition = {
  name: "explain_grow_today_item",
  description: "Read-only detail for the single Grow Today item the caller asked to have explained (via growFocusItemId), or null if none was specified or it could not be found in the caller's own Grow Today list.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "explain_grow_today_item", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "explain_grow_today_item", ok: true, data: ctx.grow.focusedItem };
  },
};

export const GROW_TOOL_REGISTRY: AiToolDefinition[] = [
  getGrowTodayItems,
  getContactRelationshipSummary,
  getGrowTodayDueItems,
  getDueCommitments,
  getGrowOpportunityPipeline,
  getAppraisalFollowups,
  getPropertyIntelligenceSignals,
  getRecentRelationshipActivity,
  explainGrowTodayItem,
];

// AE GROW Priority 6 Stage C — Business Coach, read-only coaching tools.
//
// Every tool below reads ONE already-computed field off ctx.coach
// (context/businessCoachContext.ts / coaching/metrics.ts) - exactly the same
// "thin reader of an already-bounded, already-tenant-scoped context field"
// pattern GROW_TOOL_REGISTRY above already established for Stage B. None of
// these tools query the database, accept a caller-supplied brokerageId/date-
// range override, or can return an unbounded result: every cap and every
// date-range validation already happened in coaching/period.ts and
// coaching/metrics.ts before ctx.coach existed.
//
// ctx.coach is only non-null when role === "business_coach" (mode "coach") -
// so a coaching tool run outside that path (which selectToolsForContext
// below should never allow, but is checked here too, defense in depth,
// exactly mirroring the Grow tools' own ctx.grow === null check) fails
// closed with ok:false.
const NO_COACH_CONTEXT_ERROR = "No coaching context is available for this request.";

const getActivityConsistency: AiToolDefinition = {
  name: "get_activity_consistency",
  description: "Read-only activity consistency metrics for the requested period: counts by activity type, active days, and the longest gap between active days.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_activity_consistency", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_activity_consistency", ok: true, data: ctx.coach.activity };
  },
};

const getCommitmentPerformance: AiToolDefinition = {
  name: "get_commitment_performance",
  description: "Read-only commitment performance metrics: completion rate for the requested period, currently overdue count and age, and contacts with repeated overdue commitments.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_commitment_performance", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_commitment_performance", ok: true, data: ctx.coach.commitments };
  },
};

const getAppraisalMomentum: AiToolDefinition = {
  name: "get_appraisal_momentum",
  description: "Read-only appraisal metrics: appraisals created in the requested period by current status/outcome, and appraisals with no recent update.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_appraisal_momentum", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_appraisal_momentum", ok: true, data: ctx.coach.appraisals };
  },
};

const getOpportunityPipelineHealth: AiToolDefinition = {
  name: "get_opportunity_pipeline_health",
  description: "Read-only open opportunity pipeline metrics: distribution by stage, average age, opportunities new in the requested period, and opportunities showing signs of stalling.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_opportunity_pipeline_health", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_opportunity_pipeline_health", ok: true, data: ctx.coach.opportunities };
  },
};

const getRelationshipEngagement: AiToolDefinition = {
  name: "get_relationship_engagement",
  description: "Read-only relationship engagement metrics: active relationships by type, and contacts with no recorded activity in the last 21 days.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_relationship_engagement", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_relationship_engagement", ok: true, data: ctx.coach.relationships };
  },
};

const getGrowTodayPatterns: AiToolDefinition = {
  name: "get_grow_today_patterns",
  description: "Read-only snapshot of the caller's current Grow Today list grouped by priority and item type. A live snapshot, not a historical log of items resolved over time.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_grow_today_patterns", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "get_grow_today_patterns", ok: true, data: ctx.coach.growToday };
  },
};

const getPerformanceSnapshot: AiToolDefinition = {
  name: "get_performance_snapshot",
  description: "Read-only bundle of every coaching metric for the requested period in one call: activity, commitments, appraisals, opportunities, relationships, and Grow Today patterns.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "get_performance_snapshot", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    const { activity, commitments, appraisals, opportunities, relationships, growToday, period } = ctx.coach;
    return { tool: "get_performance_snapshot", ok: true, data: { period, activity, commitments, appraisals, opportunities, relationships, growToday } };
  },
};

const comparePerformancePeriods: AiToolDefinition = {
  name: "compare_performance_periods",
  description: "Read-only, already-computed comparison of the requested period against the previous comparable period across activity, commitment completion, appraisals, and new opportunities.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.coach === null) {
      return { tool: "compare_performance_periods", ok: false, error: NO_COACH_CONTEXT_ERROR };
    }
    return { tool: "compare_performance_periods", ok: true, data: ctx.coach.comparison };
  },
};

export const COACH_TOOL_REGISTRY: AiToolDefinition[] = [
  getActivityConsistency,
  getCommitmentPerformance,
  getAppraisalMomentum,
  getOpportunityPipelineHealth,
  getRelationshipEngagement,
  getGrowTodayPatterns,
  getPerformanceSnapshot,
  comparePerformancePeriods,
];

// Copilot only ever runs the read-only tools relevant to the current context -
// property-scoped tools are skipped entirely (not merely told to return
// nothing) when there is no property in context, keeping every provider call's
// tool surface as small as the question actually requires.
//
// AE GROW Priority 6 Stage B: a Grow-scoped request runs ONLY the Grow tools
// above, checked before the existing property-based branches below - Grow
// tool results are never mixed with the property/business tool surface (ctx.
// property is always null for contextType "grow" anyway, so without this
// branch a Grow request would silently fall through to the
// portfolio-overview-only branch and never see its own Grow data).
//
// AE GROW Priority 6 Stage C: a Business Coach request (role "business_coach",
// mode "coach") runs ONLY the coaching tools, checked BEFORE the Grow branch -
// every coach request also has contextType "grow" (routes/ai.ts's schema
// requires it), so without this ordering a coach request would silently fall
// through to GROW_TOOL_REGISTRY and never see its own coaching metrics.
export function selectToolsForContext(ctx: AiContextPackage): AiToolDefinition[] {
  if (ctx.role === "business_coach") {
    return COACH_TOOL_REGISTRY;
  }
  if (ctx.contextType === "grow") {
    return GROW_TOOL_REGISTRY;
  }
  if (ctx.property === null) {
    return [getPortfolioOverview];
  }
  return TOOL_REGISTRY;
}

export async function runAllTools(ctx: AiContextPackage): Promise<AiToolResult[]> {
  const tools = selectToolsForContext(ctx);
  return Promise.all(tools.map((tool) => tool.run(ctx, {})));
}
