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

// Copilot only ever runs the read-only tools relevant to the current context -
// property-scoped tools are skipped entirely (not merely told to return
// nothing) when there is no property in context, keeping every provider call's
// tool surface as small as the question actually requires.
export function selectToolsForContext(ctx: AiContextPackage): AiToolDefinition[] {
  if (ctx.property === null) {
    return [getPortfolioOverview];
  }
  return TOOL_REGISTRY;
}

export async function runAllTools(ctx: AiContextPackage): Promise<AiToolResult[]> {
  const tools = selectToolsForContext(ctx);
  return Promise.all(tools.map((tool) => tool.run(ctx, {})));
}
