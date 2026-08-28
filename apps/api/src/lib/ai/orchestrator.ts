import { randomUUID } from "node:crypto";
import { buildContext } from "./context/contextEngine.js";
import { runAllTools } from "./tools/registry.js";
import { generateWithGateway, loadAiGatewayConfig } from "./gateway.js";
import { getPrompt } from "./prompts.js";
import { isRoleEnabled } from "./featureFlags.js";
import { isRoleEntitled } from "./entitlements.js";
import { logAiInteraction, logAiUsage } from "./audit.js";
import { AUTO_EXECUTE_CEILING, AiEntitlementError, AiFeatureDisabledError, RISK_LEVEL_DESCRIPTIONS } from "./types.js";
import type { AiRole, AiStructuredResponse, AiToolResult, ResponseKind, RiskLevel } from "./types.js";

export interface AskCopilotInput {
  brokerageId: number;
  userId: number;
  userRole: string;
  question: string;
  contextType: "property" | "transaction" | "business" | null;
  contextId: number | null;
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

  const context = await buildContext({
    requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    userRole: input.userRole,
    role,
    contextType: input.contextType,
    contextId: input.contextId,
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
  // Instructions Part 15/30, not part of this stage.
  assertWithinAutoExecuteCeiling(0);

  const toolResults = await runAllTools(context);
  const prompt = getPrompt("copilot.ask.v1");
  const config = loadAiGatewayConfig();

  const userPrompt = [
    `Agent question: ${input.question}`,
    "",
    "CONTEXT (JSON, already scoped to this agent's brokerage and permissions):",
    JSON.stringify(
      {
        brokerage: context.brokerage,
        business: context.business,
        property: context.property,
        transaction: context.transaction,
        toolResults,
      },
      null,
      2
    ),
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

  const kind = classifyResponseKind(toolResults);
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
