// AI Governance, Authority & Action Control Architecture -- Stage G6.
//
// AI Action Execution Gateway. This is the ONLY place in the codebase that
// ever calls a registered action definition's execute() function. No other
// module -- not the orchestrator, not a route handler, not an AI tool --
// is permitted to call execute() directly, so this file is the single
// choke point the rest of the governance system funnels through.
//
// Defense-in-depth (existing codebase convention -- see the re-check
// comment above assertWithinAutoExecuteCeiling() in orchestrator.ts): the
// full Policy Engine check runs again here, immediately before execution,
// even though it already ran once at proposal time. An approval that has
// been sitting in the queue must still be valid right now -- an
// entitlement can lapse, a role can change, an action can be disabled --
// so APPROVED status alone is never treated as sufficient authority.
//
// Tamper protection (Part 25): inputPayloadHash is re-verified here too,
// immediately before execute() is called, not just at approval time.
//
// Idempotency / no double-execution (Part 26): claiming a request for
// execution is a single conditional UPDATE ... WHERE status = 'APPROVED'.
// Only the caller that actually flips the row to EXECUTING may proceed;
// every other concurrent caller sees zero rows updated and backs off.

import { db, users, aiActionRequests, type AiActionRequest, type UserRole } from "@aee/db";
import { and, eq } from "drizzle-orm";
import { evaluateAIAction, type PolicyActor } from "./policyEngine.js";
import { getActionDefinition, type ActionExecutionContext, type ActorType } from "./actions/registry.js";
import { getAIActionRequest, hashInputPayload } from "./actionRequests.js";
import { publishAiActionEvent } from "./actionEvents.js";

export type ExecutionDenialReason =
  | "NOT_FOUND"
  | "WRONG_STATUS"
  | "EXPIRED"
  | "PAYLOAD_TAMPERED"
  | "POLICY_DENIED"
  | "ACTION_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "EXECUTION_FAILED";

export interface ExecutionResult {
  ok: boolean;
  reason?: ExecutionDenialReason;
  policyReason?: string;
  request?: AiActionRequest;
  result?: unknown;
  errorMessage?: string;
}

async function markFailed(row: AiActionRequest, errorMessage: string): Promise<void> {
  await db
    .update(aiActionRequests)
    .set({ status: "FAILED", errorMessage, updatedAt: new Date() })
    .where(eq(aiActionRequests.id, row.id));
}

export async function executeAIAction(requestId: number, brokerageId: number): Promise<ExecutionResult> {
  const row = await getAIActionRequest(requestId, brokerageId);
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (row.status !== "APPROVED") return { ok: false, reason: "WRONG_STATUS", request: row };

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await db.update(aiActionRequests).set({ status: "EXPIRED", updatedAt: new Date() }).where(eq(aiActionRequests.id, row.id));
    return { ok: false, reason: "EXPIRED" };
  }

  if (hashInputPayload(row.inputPayload) !== row.inputPayloadHash) {
    await markFailed(row, "Input payload failed tamper check at execution time.");
    await publishAiActionEvent(row, "AI_ACTION_BLOCKED", { reason: "PAYLOAD_TAMPERED" });
    return { ok: false, reason: "PAYLOAD_TAMPERED" };
  }

  const definition = getActionDefinition(row.actionKey);
  if (!definition) {
    await markFailed(row, "Action definition no longer registered.");
    return { ok: false, reason: "ACTION_NOT_FOUND" };
  }

  const [userRow] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!userRow) {
    await markFailed(row, "Requesting user no longer exists.");
    return { ok: false, reason: "USER_NOT_FOUND" };
  }

  const actor: PolicyActor = { id: userRow.id, role: userRow.role, brokerageId: row.brokerageId };

  const decision = await evaluateAIAction({
    actionKey: row.actionKey,
    actor,
    actorType: row.actorType as ActorType,
    rawInput: row.inputPayload,
  });

  if (!decision.allowed) {
    await markFailed(row, `Policy re-check denied at execution time: ${decision.reason}`);
    await publishAiActionEvent(row, "AI_ACTION_BLOCKED", { reason: decision.reason });
    return { ok: false, reason: "POLICY_DENIED", policyReason: decision.reason };
  }

  const [claimed] = await db
    .update(aiActionRequests)
    .set({ status: "EXECUTING", updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, "APPROVED")))
    .returning();

  if (!claimed) {
    // Lost the race to another concurrent execution attempt -- do not run
    // execute() a second time.
    return { ok: false, reason: "WRONG_STATUS" };
  }

  const ctx: ActionExecutionContext = {
    brokerageId: row.brokerageId,
    userId: userRow.id,
    userEmail: userRow.email,
    userRole: userRow.role as UserRole,
    actorType: row.actorType as ActorType,
  };

  try {
    const result = await definition.execute(ctx, decision.parsedInput);
    const [completed] = await db
      .update(aiActionRequests)
      .set({ status: "COMPLETED", executionResult: (result ?? null) as AiActionRequest["executionResult"], executedAt: new Date(), updatedAt: new Date() })
      .where(eq(aiActionRequests.id, row.id))
      .returning();
    await publishAiActionEvent(row, "AI_ACTION_EXECUTED", { result: result ?? null });
    return { ok: true, request: completed, result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown execution error";
    const [failed] = await db
      .update(aiActionRequests)
      .set({ status: "FAILED", errorMessage, updatedAt: new Date() })
      .where(eq(aiActionRequests.id, row.id))
      .returning();
    await publishAiActionEvent(row, "AI_ACTION_FAILED", { errorMessage });
    return { ok: false, reason: "EXECUTION_FAILED", request: failed, errorMessage };
  }
}
