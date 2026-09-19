// AI Governance, Authority & Action Control Architecture -- Stage G5/G6/G8.
//
// HTTP surface for the AI Action Registry, Approval Engine, and Execution
// Gateway. Every route requires an authenticated human session
// (requireAuth) -- actorType is always hardcoded "USER" here, never
// accepted from the request body, because a request arriving on this
// router is by definition a human calling through their own session. The
// AI-initiated path (actorType "AI") is Ask Agent Engine's own internal
// call into proposeAIAction() from within the orchestrator (Stage G9), not
// a public endpoint a client can hit with an arbitrary actor type.
//
// This router deliberately exposes only the narrow verbs the state
// machine defines -- propose / approve / reject / execute -- never a
// generic "run this action" or "edit this request" endpoint.
//
// AE GROW Priority 6 Stage F4.0 (Project Owner decisions D2/D4): the
// action key is dynamic (route param for propose, stored on the request
// for everything else), so the per-action required entitlement cannot be
// a static requireEntitlement() middleware here. It is enforced in the
// service layer instead, for the authenticated caller on every verb:
//   - propose: evaluateAIAction() (via proposeAIAction) checks the
//     caller's own entitlement -> 403 "Action denied by policy";
//   - approve/reject: approveAIActionRequest()/rejectAIActionRequest()
//     -> 403 ENTITLEMENT_DENIED;
//   - execute: executeAIAction() -> 403 ENTITLEMENT_DENIED.
// Reads and every verb on a specific request are limited to the requester
// or a brokerage administrator (execute: the approver or an administrator);
// anyone else gets exactly the 404 a missing/cross-tenant id gets.

import { Router } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { listActionDefinitions } from "../lib/ai/actions/registry.js";
import { proposeAIAction, getAIActionRequestForActor, approveAIActionRequest, rejectAIActionRequest } from "../lib/ai/actionRequests.js";
import { executeAIAction } from "../lib/ai/executionGateway.js";
import type { PolicyActor } from "../lib/ai/policyEngine.js";

export const aiActionsRouter = Router();

function actorFrom(authedUser: { id: number; role: string; brokerageId: number }): PolicyActor {
  return { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId };
}

// Metadata only -- never leak inputSchema/execute internals to clients.
aiActionsRouter.get("/", requireAuth, (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const definitions = listActionDefinitions()
    .filter((d) => d.enabled)
    .map((d) => ({
      actionKey: d.actionKey,
      name: d.name,
      description: d.description,
      category: d.category,
      authorityLevel: d.authorityLevel,
      riskLevel: d.riskLevel,
      allowedRoles: d.allowedRoles,
      resourceType: d.resourceType,
      reversible: d.reversible,
      version: d.version,
    }))
    // Golden Rule reflected in the API too: only show actions this user's
    // own role could ever perform.
    .filter((d) => d.allowedRoles.some((role) => role === authedUser.role));
  res.json({ actions: definitions });
});

const proposeSchema = z.object({
  input: z.unknown(),
  resourceId: z.string().nullable().optional(),
});

aiActionsRouter.post("/:actionKey/propose", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const parsed = proposeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const { request, decision } = await proposeAIAction({
      actionKey: req.params.actionKey,
      actor: actorFrom(authedUser),
      actorType: "USER",
      rawInput: parsed.data.input,
      resourceId: parsed.data.resourceId ?? null,
    });
    if (!decision.allowed || !request) {
      res.status(403).json({ error: "Action denied by policy", reason: decision.reason });
      return;
    }
    res.status(201).json({ request });
  } catch (err) {
    logger.error("ai_action_propose_route_failed", { error: err });
    res.status(500).json({ error: "Could not propose this action right now. Try again in a moment." });
  }
});

aiActionsRouter.get("/requests/:id", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  // Requester or brokerage administrator only; a same-brokerage colleague
  // gets the same 404 as a missing or cross-tenant id (never the payload).
  const request = await getAIActionRequestForActor(id, actorFrom(authedUser));
  if (!request) {
    res.status(404).json({ error: "AI action request not found" });
    return;
  }
  res.json({ request });
});

const rejectSchema = z.object({ reason: z.string().min(1).max(2000) });

function statusForApprovalReason(reason: string | undefined): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    case "APPROVER_ROLE_FORBIDDEN":
    case "REJECTOR_ROLE_FORBIDDEN":
    case "ENTITLEMENT_DENIED":
      return 403;
    default:
      return 409;
  }
}

aiActionsRouter.post("/requests/:id/approve", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  const result = await approveAIActionRequest(id, authedUser.brokerageId, actorFrom(authedUser));
  if (!result.ok) {
    res.status(statusForApprovalReason(result.reason)).json({ error: "Could not approve this request", reason: result.reason });
    return;
  }
  res.json({ request: result.request });
});

aiActionsRouter.post("/requests/:id/reject", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const result = await rejectAIActionRequest(id, authedUser.brokerageId, actorFrom(authedUser), parsed.data.reason);
  if (!result.ok) {
    res.status(statusForApprovalReason(result.reason)).json({ error: "Could not reject this request", reason: result.reason });
    return;
  }
  res.json({ request: result.request });
});

function statusForExecutionReason(reason: string | undefined): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    case "EXECUTOR_NOT_AUTHORISED":
    case "EXECUTOR_ROLE_FORBIDDEN":
    case "ENTITLEMENT_DENIED":
      return 403;
    default:
      return 409;
  }
}

aiActionsRouter.post("/requests/:id/execute", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid request id" });
    return;
  }
  try {
    const result = await executeAIAction(id, authedUser.brokerageId, actorFrom(authedUser));
    if (!result.ok) {
      res.status(statusForExecutionReason(result.reason)).json({
        error: "Could not execute this request",
        reason: result.reason,
        policyReason: result.policyReason,
      });
      return;
    }
    res.json({ request: result.request, result: result.result });
  } catch (err) {
    logger.error("ai_action_execute_route_failed", { error: err });
    res.status(500).json({ error: "Could not execute this request right now. Try again in a moment." });
  }
});
