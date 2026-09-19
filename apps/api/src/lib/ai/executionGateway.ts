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

// AE GROW Priority 6 Stage F4.0 (Project Owner decisions D2/D4): the
// Gateway no longer ignores who is asking. There are exactly two entry
// points, and neither can impersonate the other:
//
//   executeAIAction(requestId, brokerageId, caller)   -- HUMAN path, used by
//     POST /ai/actions/requests/:id/execute. The caller must be the
//     request's approver (approvedByUserId, which must be set for any
//     approval-required request) or a brokerage administrator; for an
//     auto-approved request (requiresApproval = false, no human approver
//     exists) the requester or an administrator. The caller must also hold
//     an allowed role and the action's required entitlement, on top of the
//     unchanged requester policy re-check. Authority failures never change
//     the request's state.
//
//   executeAIActionAsSystem(requestId, brokerageId)   -- SYSTEM path, used
//     ONLY by the automation engine (lib/automation/engine.ts). Refuses any
//     request whose actorType is not "SYSTEM" or that is not auto-execute-
//     eligible (stored requiresApproval must be false AND the authority
//     formula in authority.ts must say eligible for both the stored and the
//     currently registered authority/risk), so an action that requires
//     human approval can never be executed through it.
//
// markFailed is conditional on the status the caller last observed, and
// rows stuck in EXECUTING after a crash are handled by
// recoverStuckExecutingActionRequests() (actionRequests.ts) -- which marks
// them FAILED and never re-executes.

import { db, users, aiActionRequests, type AiActionRequest, type UserRole } from "@aee/db";
import { and, eq } from "drizzle-orm";
import { evaluateAIAction, type PolicyActor } from "./policyEngine.js";
import { getActionDefinition, type AIActionDefinition, type ActionExecutionContext, type ActorType } from "./actions/registry.js";
import {
  getAIActionRequest,
  hashInputPayload,
  canActorAccessActionRequest,
  isBrokerageAdminActor,
  actorHoldsActionEntitlement,
  transitionActionRequestToExpired,
} from "./actionRequests.js";
import { publishAiActionEvent } from "./actionEvents.js";
import { isAutoExecuteEligible, riskTierForLevel, type AuthorityLevel } from "./authority.js";
import type { RiskLevel } from "./types.js";

export type ExecutionDenialReason =
  | "NOT_FOUND"
  | "WRONG_STATUS"
  | "EXPIRED"
  | "PAYLOAD_TAMPERED"
  | "POLICY_DENIED"
  | "ACTION_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "EXECUTION_FAILED"
  // F4.0 human-path authority denials (never change request state).
  | "APPROVAL_MISSING"
  | "EXECUTOR_NOT_AUTHORISED"
  | "EXECUTOR_ROLE_FORBIDDEN"
  | "ENTITLEMENT_DENIED"
  // F4.0 system-path refusal (never changes request state).
  | "SYSTEM_PATH_FORBIDDEN";

export interface ExecutionResult {
  ok: boolean;
  reason?: ExecutionDenialReason;
  policyReason?: string;
  request?: AiActionRequest;
  result?: unknown;
  errorMessage?: string;
}

type ExecutionCaller = { kind: "user"; actor: PolicyActor } | { kind: "system" };

// Conditional on the status this caller last observed (APPROVED before
// the claim, EXECUTING after it), so a stale caller can never overwrite a
// newer terminal state such as COMPLETED. Returns the updated row, or null
// if the row had already moved on.
async function markFailed(
  row: AiActionRequest,
  expectedStatus: "APPROVED" | "EXECUTING",
  errorMessage: string,
): Promise<AiActionRequest | null> {
  const [failed] = await db
    .update(aiActionRequests)
    .set({ status: "FAILED", errorMessage, updatedAt: new Date() })
    .where(and(eq(aiActionRequests.id, row.id), eq(aiActionRequests.status, expectedStatus)))
    .returning();
  return failed ?? null;
}

// Human-path authority (D2/D4). Pure check, no state change.
async function authorizeHumanExecutor(
  row: AiActionRequest,
  definition: AIActionDefinition<unknown> | undefined,
  executor: PolicyActor,
): Promise<ExecutionDenialReason | null> {
  const isAdmin = isBrokerageAdminActor(executor);
  if (row.requiresApproval) {
    // An approval-required request can only be APPROVED by a recorded
    // human approval; a row without one was not approved through
    // approveAIActionRequest() and is never executable by a human.
    if (row.approvedByUserId === null) return "APPROVAL_MISSING";
    if (row.approvedByUserId !== executor.id && !isAdmin) return "EXECUTOR_NOT_AUTHORISED";
  } else if (row.userId !== executor.id && !isAdmin) {
    // Auto-approved (no human approver exists): the human it was proposed
    // on behalf of, or an administrator.
    return "EXECUTOR_NOT_AUTHORISED";
  }
  if (definition && !definition.allowedRoles.some((role) => role === executor.role)) {
    return "EXECUTOR_ROLE_FORBIDDEN";
  }
  return null;
}

function isSystemAutoExecutable(row: AiActionRequest, definition: AIActionDefinition<unknown> | undefined): boolean {
  if (row.actorType !== "SYSTEM") return false;
  if (row.requiresApproval) return false;
  if (!isAutoExecuteEligible(row.authorityLevel as AuthorityLevel, riskTierForLevel(row.riskLevel as RiskLevel))) return false;
  if (definition && !isAutoExecuteEligible(definition.authorityLevel, riskTierForLevel(definition.riskLevel))) return false;
  return true;
}

/**
 * Human execution path (POST /ai/actions/requests/:id/execute). `caller`
 * must be the authenticated human, built from server-side session state.
 */
export async function executeAIAction(requestId: number, brokerageId: number, caller: PolicyActor): Promise<ExecutionResult> {
  return runExecution(requestId, brokerageId, { kind: "user", actor: caller });
}

/**
 * System execution path -- for the automation engine ONLY. Executes a
 * request only if it was proposed with actorType "SYSTEM" and is
 * auto-execute-eligible; anything requiring human approval is refused
 * with SYSTEM_PATH_FORBIDDEN and left untouched.
 */
export async function executeAIActionAsSystem(requestId: number, brokerageId: number): Promise<ExecutionResult> {
  return runExecution(requestId, brokerageId, { kind: "system" });
}

async function runExecution(requestId: number, brokerageId: number, caller: ExecutionCaller): Promise<ExecutionResult> {
  const row = await getAIActionRequest(requestId, brokerageId);
  if (!row) return { ok: false, reason: "NOT_FOUND" };

  const definition = getActionDefinition(row.actionKey);

  // Caller authority first -- before any status inspection or transition,
  // so an unauthorised caller can neither learn the row's state nor
  // expire/fail it.
  if (caller.kind === "user") {
    if (!canActorAccessActionRequest(row, caller.actor)) return { ok: false, reason: "NOT_FOUND" };
  } else if (!isSystemAutoExecutable(row, definition)) {
    return { ok: false, reason: "SYSTEM_PATH_FORBIDDEN" };
  }

  if (row.status !== "APPROVED") return { ok: false, reason: "WRONG_STATUS", request: row };

  if (caller.kind === "user") {
    const denial = await authorizeHumanExecutor(row, definition, caller.actor);
    if (denial) return { ok: false, reason: denial };
  }

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await transitionActionRequestToExpired(row, "APPROVED");
    return { ok: false, reason: "EXPIRED" };
  }

  if (hashInputPayload(row.inputPayload) !== row.inputPayloadHash) {
    const failed = await markFailed(row, "APPROVED", "Input payload failed tamper check at execution time.");
    if (failed) await publishAiActionEvent(failed, "AI_ACTION_BLOCKED", { reason: "PAYLOAD_TAMPERED", stage: "EXECUTION" });
    return { ok: false, reason: "PAYLOAD_TAMPERED" };
  }

  if (!definition) {
    await markFailed(row, "APPROVED", "Action definition no longer registered.");
    return { ok: false, reason: "ACTION_NOT_FOUND" };
  }

  const [userRow] = await db.select().from(users).where(eq(users.id, row.userId));
  if (!userRow) {
    await markFailed(row, "APPROVED", "Requesting user no longer exists.");
    return { ok: false, reason: "USER_NOT_FOUND" };
  }

  // Golden Rule re-check against the ORIGINAL requester (unchanged
  // semantics): the request itself must still be permitted right now.
  const actor: PolicyActor = { id: userRow.id, role: userRow.role, brokerageId: row.brokerageId };

  const decision = await evaluateAIAction({
    actionKey: row.actionKey,
    actor,
    actorType: row.actorType as ActorType,
    rawInput: row.inputPayload,
  });

  if (!decision.allowed) {
    const failed = await markFailed(row, "APPROVED", `Policy re-check denied at execution time: ${decision.reason}`);
    if (failed) await publishAiActionEvent(failed, "AI_ACTION_BLOCKED", { reason: decision.reason });
    return { ok: false, reason: "POLICY_DENIED", policyReason: decision.reason };
  }

  // Additionally (F4.0), a human executor must personally hold the
  // action's required entitlement. A caller-specific denial: the request
  // stays APPROVED for an entitled approver/administrator.
  if (caller.kind === "user" && !(await actorHoldsActionEntitlement(definition, caller.actor))) {
    return { ok: false, reason: "ENTITLEMENT_DENIED" };
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
    await publishAiActionEvent(completed, "AI_ACTION_EXECUTED", { result: result ?? null });
    return { ok: true, request: completed, result };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown execution error";
    const failed = await markFailed(claimed, "EXECUTING", errorMessage);
    if (failed) await publishAiActionEvent(failed, "AI_ACTION_FAILED", { errorMessage });
    return { ok: false, reason: "EXECUTION_FAILED", request: failed ?? undefined, errorMessage };
  }
}
