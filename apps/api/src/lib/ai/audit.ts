import { eq } from "drizzle-orm";
import { db, aiInteractions, aiUsage } from "@aee/db";
import type { AiRole, ResponseKind, RiskLevel } from "./types.js";
import { incrementCounter, logger } from "@aee/events";

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
// must never break the response the user is waiting on. The failure is not
// silent: it is a structured error log plus ai_interaction_log_failure_total.
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
    logger.error("log_ai_interaction_failed", {
      requestId: input.requestId,
      brokerageId: input.brokerageId,
      userId: input.userId,
      status: input.status,
      error: err,
    });
    incrementCounter("ai_interaction_log_failure_total", { operation: "insert" });
    return null;
  }
}

export interface UpdateAiInteractionInput {
  status: LogAiInteractionInput["status"];
  responseKind?: ResponseKind;
  errorMessage?: string;
}

/**
 * Updates the row logAiInteraction inserted before the provider call.
 * Same best-effort contract: a failure is logged and counted, and does not
 * throw, so a finished answer is still returned.
 */
export async function updateAiInteraction(id: number, patch: UpdateAiInteractionInput): Promise<boolean> {
  const values: { status: string; responseKind?: string; errorMessage?: string } = { status: patch.status };
  if (patch.responseKind !== undefined) values.responseKind = patch.responseKind;
  if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage;
  try {
    await db.update(aiInteractions).set(values).where(eq(aiInteractions.id, id));
    return true;
  } catch (err) {
    logger.error("log_ai_interaction_update_failed", {
      interactionId: id,
      status: patch.status,
      error: err,
    });
    incrementCounter("ai_interaction_log_failure_total", { operation: "update" });
    return false;
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
