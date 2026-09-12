import { eq } from "drizzle-orm";
import { db, amlVerifications, type UserRole } from "@aee/db";
import { BROKERAGE_ADMIN_ROLES } from "../../../middlewares/auth.js";
import { listOffersForProperty } from "../../offers.js";
import { getPropertyTimeline } from "../../timeline.js";
import type { AiContextPackage, AiToolDefinition, AiToolResult } from "../types.js";

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

const getOffersForProperty: AiToolDefinition = {
  name: "get_offers_for_property",
  description: "Read-only list of offers made on the property in context.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_offers_for_property", ok: false, error: NO_PROPERTY_ERROR };
    }
    const offers = await listOffersForProperty(property.id);
    const summarized = offers.map((offer) => ({ id: offer.id, status: offer.status, offerPriceCents: offer.offerPriceCents }));
    return { tool: "get_offers_for_property", ok: true, data: summarized };
  },
};

const getPropertyTimelineTool: AiToolDefinition = {
  name: "get_property_timeline",
  description: "Read-only chronological timeline of events for the property in context.",
  riskLevel: 0,
  async run(ctx) {
    const property = ctx.property;
    if (property === null) {
      return { tool: "get_property_timeline", ok: false, error: NO_PROPERTY_ERROR };
    }
    // #131/#134 — the Timeline's financial-entitlement boundary applies to
    // every reader, including Copilot: a non-Brokerage-Administrator asking
    // the AI about a property must not get commission/funds/agent-paid
    // figures back through this tool when they couldn't see them on the
    // Property Workspace page itself.
    const canViewFinancials = BROKERAGE_ADMIN_ROLES.includes(ctx.userRole as UserRole);
    const timeline = await getPropertyTimeline(property.id, ctx.brokerageId, canViewFinancials);
    return { tool: "get_property_timeline", ok: true, data: timeline };
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

const getDueCommitments: AiToolDefinition = {
  name: "get_due_commitments",
  description: "Read-only list of the caller's Grow Today items that carry a due date (opportunity next-action or appraisal follow-up due dates), soonest first.",
  riskLevel: 0,
  async run(ctx) {
    if (ctx.grow === null) {
      return { tool: "get_due_commitments", ok: false, error: NO_GROW_CONTEXT_ERROR };
    }
    return { tool: "get_due_commitments", ok: true, data: ctx.grow.dueFollowUps };
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
  getDueCommitments,
  getGrowOpportunityPipeline,
  getAppraisalFollowups,
  getPropertyIntelligenceSignals,
  getRecentRelationshipActivity,
  explainGrowTodayItem,
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
export function selectToolsForContext(ctx: AiContextPackage): AiToolDefinition[] {
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
