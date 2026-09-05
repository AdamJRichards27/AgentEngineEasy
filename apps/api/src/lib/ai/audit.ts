import { db, aiInteractions, aiUsage } from "@aee/db";
import type { AiRole, ResponseKind, RiskLevel } from "./types.js";
import { logger } from "@aee/events";

export interface LogAiInteractionInput {
  requestId: string;
  brokerageId: number;
  userId: number;
  aiRole: AiRole;
  contextType?: string;
  contextId?: number;
  promptKey?: string;
  promptVersion?: number;
  question?: string;
  responseKind?: ResponseKind;
  riskLevel: RiskLevel;
  status: "success" | "error" | "blocked_permission" | "blocked_entitlement" | "blocked_flag";
  errorMessage?: string;
}

export interface LogAiUsageInput {
  interactionId: number;
  provider: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  latencyMs?: number;
}

// AI Audit Layer: one row per request, written for every call that reaches the
// orchestrator - including requests blocked before any provider call is made, so
// a denied AI request is exactly as visible in the audit trail as a successful
// one. Mirrors lib/audit.ts's logAudit(): fire-and-forget, a logging failure
// must never break the response the user is waiting on.
export async function logAiInteraction(input: LogAiInteractionInput): Promise<number | null> {
  try {
    const [row] = await db
      .insert(aiInteractions)
      .values({
        requestId: input.requestId,
        brokerageId: input.brokerageId,
        userId: input.userId,
        aiRole: input.aiRole,
        contextType: input.contextType,
        contextId: input.contextId,
        promptKey: input.promptKey,
        promptVersion: input.promptVersion,
        question: input.question,
        responseKind: input.responseKind,
        riskLevel: input.riskLevel,
        status: input.status,
        errorMessage: input.errorMessage,
      })
      .returning({ id: aiInteractions.id });
    return row === undefined ? null : row.id;
  } catch (err) {
    logger.error("log_ai_interaction_failed", { requestId: input.requestId, brokerageId: input.brokerageId, userId: input.userId, error: err });
    return null;
  }
}

export async function logAiUsage(input: LogAiUsageInput): Promise<void> {
  try {
    await db.insert(aiUsage).values({
      interactionId: input.interactionId,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      totalTokens: input.totalTokens,
      estimatedCostUsd: input.estimatedCostUsd === undefined ? undefined : String(input.estimatedCostUsd),
      latencyMs: input.latencyMs,
    });
  } catch (err) {
    logger.error("log_ai_usage_failed", { interactionId: input.interactionId, provider: input.provider, error: err });
  }
}
