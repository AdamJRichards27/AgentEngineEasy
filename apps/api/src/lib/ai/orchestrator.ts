import { randomUUID } from "node:crypto";
import { buildContext } from "./context/contextEngine.js";
import { runAllTools } from "./tools/registry.js";
import { generateWithGateway, loadAiGatewayConfig } from "./gateway.js";
import { getPrompt } from "./prompts.js";
import { isRoleEnabled } from "./featureFlags.js";
import { isRoleEntitled } from "./entitlements.js";
import { logAiInteraction, logAiUsage } from "./audit.js";
import { assertGrowRateLimit, GrowRateLimitError } from "./growRateLimiter.js";
import { AUTO_EXECUTE_CEILING, AiEntitlementError, AiFeatureDisabledError, RISK_LEVEL_DESCRIPTIONS } from "./types.js";
import type { AiContextPackage, AiRole, AiStructuredResponse, AiToolResult, ResponseKind, RiskLevel } from "./types.js";

export interface AskCopilotInput {
  brokerageId: number;
  userId: number;
  userRole: string;
  question: string;
  // AE GROW Priority 6 Stage B: "grow" is additive - every existing caller
  // (RUN Copilot's routes/ai.ts, orchestrator.test.ts) keeps compiling and
  // behaving identically, since contextType still accepts every value it
  // always did.
  contextType: "property" | "transaction" | "business" | "grow" | null;
  contextId: number | null;
  // Optional (not required) so every existing call site - production and
  // test - that never mentions Grow keeps compiling unchanged. Only
  // meaningful when contextType is "grow"; ignored otherwise, same as
  // contextId is already ignored for contextType "business"/null today.
  growFocusItemId?: string | null;
}

export interface AskCopilotResult {
  requestId: string;
  response: AiStructuredResponse;
}

function classifyResponseKind(toolResults: AiToolResult[]): ResponseKind {
  const successful = toolResults.filter((result) => result.ok === true);
  if (successful.length === 0) {
    return "unknown";
  }
  const hasData = successful.some((result) => {
    if (Array.isArray(result.data)) return result.data.length > 0;
    return result.data !== null && result.data !== undefined;
  });
  return hasData ? "fact" : "unknown";
}

function toolResultHasUsableData(result: AiToolResult): boolean {
  if (Array.isArray(result.data)) return result.data.length > 0;
  return result.data !== null && result.data !== undefined;
}

// AE GROW Priority 6 Stage B — Grow-scoped response kind classification.
// Distinct from classifyResponseKind above (RUN Copilot's existing
// fact/unknown-only classifier, untouched by this function and still used
// for every non-Grow contextType): the Grow Response Contract requires
// Fact/Summary/Indicator/Recommendation/Unknown, because Grow's tool results
// are qualitatively different from Copilot's property/business results:
//   - indicator: a Property Intelligence signal came back with data - it
//                already self-carries its own confidence band, which is a
//                stronger and more specific claim than a plain "fact", so it
//                takes priority when present.
//   - summary:   an aggregated/calculated tool (relationship breakdown or
//                opportunity pipeline) came back with data - a genuine
//                computed figure, not one record's detail.
//   - fact:      some other Grow tool (today items, due commitments,
//                appraisal follow-ups, recent activity, the focused item)
//                came back with data - a directly-recorded detail.
//   - unknown:   no Grow tool returned any usable data.
//   - recommendation is never produced by this function: it is reserved for
//                the model's own explicit "I suggest..." framing, which
//                cannot be detected from tool results alone. Kept in the
//                shared ResponseKind union only because AiStructuredResponse
//                is shared with RUN Copilot.
function classifyGrowResponseKind(toolResults: AiToolResult[]): ResponseKind {
  const successful = toolResults.filter((result) => result.ok === true);
  if (successful.length === 0) {
    return "unknown";
  }
  const signalResult = successful.find((result) => result.tool === "get_property_intelligence_signals");
  if (signalResult !== undefined && toolResultHasUsableData(signalResult)) {
    return "indicator";
  }
  const summaryToolNames = new Set(["get_contact_relationship_summary", "get_grow_opportunity_pipeline"]);
  const summaryResult = successful.find((result) => summaryToolNames.has(result.tool));
  if (summaryResult !== undefined && toolResultHasUsableData(summaryResult)) {
    return "summary";
  }
  return successful.some(toolResultHasUsableData) ? "fact" : "unknown";
}

const MAX_GROW_SUPPORTING_RECORDS = 5;

// AE GROW Priority 6 Stage B — Deep Links / Response Contract supportingRecords.
//
// apps/web/src/App.tsx's route table is deliberately shallow (see that
// file's own header comment: "almost everything lives inside the Property
// Workspace"). The only per-record detail route that exists today is
// /properties/:id - there is no dedicated party/opportunity/appraisal detail
// route to link to. Rather than fabricate a URL that would 404, this
// returns deepLink: null for record types with no real route - a missing
// link is honest; a broken one is not.
//
// Tenant/existence re-check: every id used here came from ctx.grow, which
// growContext.ts already built by querying ONLY this same request's own
// brokerageId (see that file's own header comment) - it was never possible
// for a foreign-brokerage record to reach this function, so no separate
// re-query is needed before returning these ids, unlike a route handler that
// receives an id from client input.
function buildGrowSupportingRecords(context: AiContextPackage): AiStructuredResponse["supportingRecords"] {
  const grow = context.grow;
  if (grow === null) {
    return undefined;
  }
  const items = grow.focusedItem !== null ? [grow.focusedItem] : grow.todayItems.slice(0, MAX_GROW_SUPPORTING_RECORDS);
  const records: NonNullable<AiStructuredResponse["supportingRecords"]> = [];
  for (const item of items) {
    if (item.propertyId !== null) {
      records.push({
        recordType: "property",
        recordId: item.propertyId,
        label: item.propertyLabel ?? `Property #${item.propertyId}`,
        deepLink: `/properties/${item.propertyId}`,
      });
    } else if (item.opportunityId !== null) {
      records.push({ recordType: "opportunity", recordId: item.opportunityId, label: item.contactName, deepLink: null });
    } else if (item.appraisalId !== null) {
      records.push({ recordType: "appraisal", recordId: item.appraisalId, label: item.contactName, deepLink: null });
    } else {
      records.push({ recordType: "party", recordId: item.partyId, label: item.contactName, deepLink: null });
    }
    if (records.length >= MAX_GROW_SUPPORTING_RECORDS) {
      break;
    }
  }
  return records.length > 0 ? records : undefined;
}

// Static, deliberately conservative - restates in the response payload itself
// (not just the system prompt) the two constraints most likely to matter if a
// consumer of this API ever renders `summary` without also rendering the
// system prompt's constraints: never a live check of anything beyond Grow
// Today, never a claim about a contact's private intentions.
const GROW_LIMITATIONS: string[] = [
  "This answer only reflects data already visible in your own Grow Today list - it is not a live check of any external source.",
  "AE has no information about a contact's private plans or motivations; any pattern mentioned here is a reason to review, not a prediction about that person.",
];

function buildGrowSuggestedNextStep(context: AiContextPackage): string | undefined {
  const grow = context.grow;
  if (grow === null) {
    return undefined;
  }
  if (grow.focusedItem !== null) {
    return grow.focusedItem.recommendedAction;
  }
  if (grow.todayItems.length > 0) {
    return "Review your Grow Today list for prioritized follow-ups.";
  }
  return undefined;
}

// Nothing in this build calls this with anything but Level 0 - it exists so the
// ceiling is a real, enforced check rather than an implicit assumption a future
// higher-risk-level build could quietly slip past.
function assertWithinAutoExecuteCeiling(riskLevel: RiskLevel): void {
  if (riskLevel > AUTO_EXECUTE_CEILING) {
    throw new Error(
      `Refusing to auto-execute a Level ${riskLevel} action (${RISK_LEVEL_DESCRIPTIONS[riskLevel]}). ` +
        "This build never lets the AI carry out anything above Level 0 without a human."
    );
  }
}

// Orchestration Layer: context -> permissions -> entitlements -> tools ->
// provider -> structured response -> audit, in that order, for every request.
// routes/ai.ts has already run requireAuth before calling this; the checks here
// (feature flag, entitlement) are AI-specific and run again server-side even
// though the UI also hides disabled/unentitled capabilities - never UI-only.
export async function askCopilot(input: AskCopilotInput): Promise<AskCopilotResult> {
  const requestId = randomUUID();
  const role: AiRole = "copilot";
  const isGrowRequest = input.contextType === "grow";

  if (isRoleEnabled(role) === false) {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      riskLevel: 0,
      status: "blocked_flag",
      question: input.question,
    });
    throw new AiFeatureDisabledError("The AI Copilot is currently disabled for this environment.");
  }

  // AE GROW Priority 6 Stage B — Performance/Cost Controls: rate limiting.
  // Checked before any context/database work, and scoped to Grow only (see
  // growRateLimiter.ts's own header comment for the full rationale and its
  // documented single-process limitation).
  if (isGrowRequest) {
    try {
      assertGrowRateLimit(input.brokerageId);
    } catch (err) {
      if (err instanceof GrowRateLimitError) {
        await logAiInteraction({
          requestId,
          brokerageId: input.brokerageId,
          userId: input.userId,
          aiRole: role,
          contextType: input.contextType ?? undefined,
          question: input.question,
          riskLevel: 0,
          status: "blocked_flag",
          errorMessage: err.message,
        });
      }
      throw err;
    }
  }

  const context = await buildContext({
    requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    userRole: input.userRole,
    role,
    contextType: input.contextType,
    contextId: input.contextId,
    growFocusItemId: input.growFocusItemId ?? null,
  });

  if (isRoleEntitled(context.tier, role) === false) {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      riskLevel: 0,
      status: "blocked_entitlement",
      question: input.question,
    });
    throw new AiEntitlementError(`The ${context.tier} plan does not include the AI Copilot.`);
  }

  // AE GROW Priority 6 Stage B — Grow-specific entitlement gate. The check
  // above (isRoleEntitled(tier, "copilot")) is true for every tier today
  // (see entitlements.ts's TIER_CAPABILITIES - copilot: true on STARTER,
  // GROW, and PRO alike), so it does NOT gate Grow access on its own: a
  // STARTER brokerage (no grow.access) would otherwise sail through it.
  // resolveBrokerageTier() already derives tier from grow.access
  // specifically (grow.access && run.access -> PRO; grow.access only ->
  // GROW; neither/run-only -> STARTER), so "tier !== STARTER" here is
  // exactly "this brokerage holds grow.access" - the Stage B requirement
  // ("require auth + grow.access + existing AI entitlement") without a
  // second, parallel entitlement lookup.
  if (isGrowRequest && context.tier === "STARTER") {
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      contextType: input.contextType ?? undefined,
      question: input.question,
      riskLevel: 0,
      status: "blocked_entitlement",
    });
    throw new AiEntitlementError("Grow-scoped Ask AE requires a Grow or Pro plan.");
  }

  // Stage G9 note (Ask Agent Engine Action Interface / AI Context Security
  // Controls): askCopilot() is intentionally kept at the OBSERVE ceiling
  // (0 = read-only) below. Everything fed into the prompt above
  // (context.brokerage/business/property/transaction/...) is plain,
  // already-tenant-scoped data -- none of it is or contains a callable
  // tool, an action reference, or an authority claim, so nothing in the
  // retrieved context can grant itself execution rights no matter what
  // the model does with it (the classic prompt-injection failure mode:
  // "the document says to approve this" carries no authority here because
  // there is no path from prompt/context content to executeAIAction()).
  // The AI Action Registry (registry.ts) and Execution Gateway
  // (executionGateway.ts) are reachable only via the authenticated human
  // routes in routes/ai-actions.ts -- never automatically from this
  // function's output. Raising this ceiling or wiring a suggestion in
  // AiStructuredResponse.actionProposals into an automatic
  // proposeAIAction() call is future work explicitly deferred by Build
  // Instructions Part 15/30, not part of this stage. This applies equally
  // to Grow: ctx.grow is the same kind of plain, already-tenant-scoped data
  // as ctx.property/ctx.business, never a callable tool or authority claim.
  assertWithinAutoExecuteCeiling(0);

  const toolResults = await runAllTools(context);
  // AE GROW Priority 6 Stage B: a Grow-scoped ask uses the Grow-specific
  // prompt (five-way classification + the wording hard constraints) instead
  // of the original copilot.ask.v1 - every non-Grow contextType keeps using
  // copilot.ask.v1 exactly as before.
  const prompt = getPrompt(isGrowRequest ? "copilot.ask.grow.v1" : "copilot.ask.v1");
  const config = loadAiGatewayConfig();

  // AE GROW Priority 6 Stage B: the non-Grow payload shape below
  // (brokerage/business/property/transaction/toolResults) is byte-for-byte
  // identical to what this function has always sent - RUN Copilot's prompt
  // payload is unchanged. A Grow-scoped ask sends brokerage/grow/toolResults
  // instead: property/transaction are always null for contextType "grow"
  // (contextEngine.ts) and would only add noise, and business's
  // activePropertyCount/upcomingSettlementCount figures aren't part of
  // Grow's own subject matter.
  const contextPayload = isGrowRequest
    ? { brokerage: context.brokerage, grow: context.grow, toolResults }
    : { brokerage: context.brokerage, business: context.business, property: context.property, transaction: context.transaction, toolResults };

  const userPrompt = [
    `Agent question: ${input.question}`,
    "",
    "CONTEXT (JSON, already scoped to this agent's brokerage and permissions):",
    JSON.stringify(contextPayload, null, 2),
  ].join("\n");

  let generation;
  try {
    generation = await generateWithGateway(
      {
        systemPrompt: prompt.systemPrompt,
        userPrompt,
        model: config.model,
        temperature: config.temperature,
        maxOutputTokens: config.maxOutputTokens,
        timeoutMs: config.timeoutMs,
      },
      config
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI provider call failed";
    await logAiInteraction({
      requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      aiRole: role,
      contextType: input.contextType ?? undefined,
      contextId: input.contextId ?? undefined,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      question: input.question,
      riskLevel: 0,
      status: "error",
      errorMessage: message,
    });
    throw err;
  }

  const kind = isGrowRequest ? classifyGrowResponseKind(toolResults) : classifyResponseKind(toolResults);
  const toolsUsed = toolResults.filter((result) => result.ok === true).map((result) => result.tool);
  const response: AiStructuredResponse = {
    kind,
    summary: generation.response.text,
    details: toolResults.map((result) => (result.ok === true ? `${result.tool}: ok` : `${result.tool}: ${result.error ?? "no data"}`)),
    toolsUsed,
    riskLevel: 0,
    disclaimer:
      generation.usedFallback === true
        ? `Answered by the fallback AI provider (${generation.response.provider}) after the primary provider failed.`
        : undefined,
    // AE GROW Priority 6 Stage B — Response Contract additions. Left
    // undefined for every non-Grow request, exactly as before this stage
    // (these fields did not exist until this branch's types.ts commit, and
    // RUN Copilot never sets them).
    supportingRecords: isGrowRequest ? buildGrowSupportingRecords(context) : undefined,
    dataFreshness: isGrowRequest ? context.grow?.generatedAt : undefined,
    limitations: isGrowRequest ? GROW_LIMITATIONS : undefined,
    suggestedNextStep: isGrowRequest ? buildGrowSuggestedNextStep(context) : undefined,
  };

  const interactionId = await logAiInteraction({
    requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    aiRole: role,
    contextType: input.contextType ?? undefined,
    contextId: input.contextId ?? undefined,
    promptKey: prompt.key,
    promptVersion: prompt.version,
    question: input.question,
    responseKind: kind,
    riskLevel: 0,
    status: "success",
  });

  if (interactionId !== null) {
    await logAiUsage({
      interactionId,
      provider: generation.response.provider,
      model: generation.response.model,
      promptTokens: generation.response.usage.promptTokens,
      completionTokens: generation.response.usage.completionTokens,
      totalTokens: generation.response.usage.totalTokens,
      estimatedCostUsd: generation.response.usage.estimatedCostUsd,
      latencyMs: generation.response.latencyMs,
    });
  }

  return { requestId, response };
}
