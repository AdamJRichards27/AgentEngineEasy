// Agent Engine 2.0 -- WAE Operational Readiness (Stage: WF4).
//
// The operational visibility + control API surface (Section "operational
// visibility" -- "may be an internal admin page, an operations endpoint,
// or both"; this stage scopes it to the endpoint, deferring a dedicated
// admin frontend page as a documented, low-risk follow-up). Every route is
// gated requireAuth + requireRole(...BROKERAGE_ADMIN_ROLES), tenant-scoped
// via authedUser.brokerageId, and follows the exact conventions
// ai-actions.ts already established: zod validation on request bodies, a
// reason-to-HTTP-status mapping function per denial-reason union, and a
// generic try/catch 500 that never leaks internals.
//
// This router calls straight into operations.ts's domain functions for
// every mutation (retry/cancel/notes/pause/resume/health) -- it never
// re-implements claiming, cancellation, or classification logic itself.
// The list/detail read endpoints below are the one place this file does
// its own querying, since operations.ts is a mutation/health service, not
// a read model -- the redaction applied here still reuses operations.ts's
// own redactSensitiveFields/detailActionForOps, so there remains only one
// place in the codebase that decides what is safe to show an operator.

import { Router } from "express";
import { z } from "zod";
import { and, asc, desc, eq } from "drizzle-orm";
import { db, automationExecutions, automationActions, domainEvents } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { retryAutomationAction } from "../lib/automation/engine.js";
import {
  cancelAction,
  cancelExecution,
  addExecutionResolutionNote,
  pauseAutomationRule,
  resumeAutomationRule,
  getAutomationHealth,
  detailActionForOps,
  redactSensitiveFields,
} from "../lib/automation/operations.js";
import { AutomationValidationError } from "../lib/automation/rules.js";

export const automationOpsRouter = Router();

// Every route in this router requires the same gate: an authenticated
// Brokerage Administrator. Applied once here rather than repeated on every
// handler -- mirrors requireAuth/requireRole's own composable design.
automationOpsRouter.use(requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function actorFrom(authedUser: { id: number; role: string }): { id: number; role: string } {
  return { id: authedUser.id, role: authedUser.role };
}

// ---------------------------------------------------------------------
// GET /automation/ops/executions/:id -- detail, including actions,
// approval linkage (aiActionRequestId per action, resolvable through the
// existing GET /ai/actions/requests/:id), and the triggering event.
// ---------------------------------------------------------------------
automationOpsRouter.get("/executions/:id", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const executionId = req.params.id;
  if (!UUID_PATTERN.test(executionId)) {
    res.status(400).json({ error: "Invalid execution id" });
    return;
  }
  try {
    const [execution] = await db
      .select()
      .from(automationExecutions)
      .where(and(eq(automationExecutions.id, executionId), eq(automationExecutions.brokerageId, authedUser.brokerageId)));
    if (!execution) {
      res.status(404).json({ error: "Execution not found" });
      return;
    }

    const [triggeringEvent] = await db.select().from(domainEvents).where(eq(domainEvents.id, execution.triggeringEventId));
    const actionRows = await db
      .select()
      .from(automationActions)
      .where(eq(automationActions.executionId, executionId))
      .orderBy(asc(automationActions.sequence));

    res.json({
      execution: { ...execution, conditionResult: redactSensitiveFields(execution.conditionResult) },
      triggeringEvent: triggeringEvent
        ? {
            id: triggeringEvent.id,
            eventType: triggeringEvent.eventType,
            propertyId: triggeringEvent.propertyId,
            transactionId: triggeringEvent.transactionId,
            occurredAt: triggeringEvent.occurredAt,
          }
        : null,
      actions: actionRows.map(detailActionForOps),
    });
  } catch (err) {
    console.error("GET /automation/ops/executions/:id failed", err);
    res.status(500).json({ error: "Could not load this execution right now. Try again in a moment." });
  }
});

// ---------------------------------------------------------------------
// POST /automation/ops/actions/:id/retry -- claimActionForRetry then
// re-runs the retry logic, both inside engine.ts's retryAutomationAction
// (Component 4: the atomic claim is the sole gate, never a second,
// route-local eligibility check).
// ---------------------------------------------------------------------
function statusForRetryReason(reason: string | undefined): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

automationOpsRouter.post("/actions/:id/retry", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "Invalid action id" });
    return;
  }
  try {
    const result = await retryAutomationAction(req.params.id, authedUser.brokerageId, `user:${authedUser.id}`);
    if (!result.ok) {
      res.status(statusForRetryReason(result.reason)).json({ error: "Could not retry this action", reason: result.reason });
      return;
    }
    res.json({ status: result.status });
  } catch (err) {
    console.error("POST /automation/ops/actions/:id/retry failed", err);
    res.status(500).json({ error: "Could not retry this action right now. Try again in a moment." });
  }
});

// ---------------------------------------------------------------------
// POST /automation/ops/executions/:id/cancel, /automation/ops/actions/:id/cancel
// -- only while no irreversible side effect has occurred (operations.ts's
// cancelExecution/cancelAction own that check; this route never guesses
// at it independently).
// ---------------------------------------------------------------------
const cancelSchema = z.object({ reason: z.string().min(1).max(2000) });

function statusForCancelReason(reason: string | undefined): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    default:
      return 409;
  }
}

automationOpsRouter.post("/executions/:id/cancel", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "Invalid execution id" });
    return;
  }
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await cancelExecution(req.params.id, authedUser.brokerageId, actorFrom(authedUser), parsed.data.reason);
    if (!result.ok) {
      res.status(statusForCancelReason(result.reason)).json({ error: "Could not cancel this execution", reason: result.reason });
      return;
    }
    res.json({ execution: result.execution });
  } catch (err) {
    console.error("POST /automation/ops/executions/:id/cancel failed", err);
    res.status(500).json({ error: "Could not cancel this execution right now. Try again in a moment." });
  }
});

automationOpsRouter.post("/actions/:id/cancel", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "Invalid action id" });
    return;
  }
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await cancelAction(req.params.id, authedUser.brokerageId, actorFrom(authedUser), parsed.data.reason);
    if (!result.ok) {
      res.status(statusForCancelReason(result.reason)).json({ error: "Could not cancel this action", reason: result.reason });
      return;
    }
    res.json({ action: result.action });
  } catch (err) {
    console.error("POST /automation/ops/actions/:id/cancel failed", err);
    res.status(500).json({ error: "Could not cancel this action right now. Try again in a moment." });
  }
});

// ---------------------------------------------------------------------
// POST /automation/ops/executions/:id/notes -- a resolution note is
// available regardless of status and never changes status itself.
// ---------------------------------------------------------------------
const noteSchema = z.object({ note: z.string().min(1).max(4000) });

automationOpsRouter.post("/executions/:id/notes", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!UUID_PATTERN.test(req.params.id)) {
    res.status(400).json({ error: "Invalid execution id" });
    return;
  }
  const parsed = noteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await addExecutionResolutionNote(req.params.id, authedUser.brokerageId, { id: authedUser.id }, parsed.data.note);
    if (!result.ok) {
      res.status(404).json({ error: "Execution not found", reason: result.reason });
      return;
    }
    res.json({ execution: result.execution });
  } catch (err) {
    console.error("POST /automation/ops/executions/:id/notes failed", err);
    res.status(500).json({ error: "Could not add this note right now. Try again in a moment." });
  }
});

// ---------------------------------------------------------------------
// POST /automation/ops/rules/:id/pause, /automation/ops/rules/:id/resume
// -- reuses the existing automationRules.status column/setAutomationRuleStatus
// (rules.ts) directly; this route only adds the audit/event trail an
// operator control requires (operations.ts's pauseAutomationRule/
// resumeAutomationRule), never a second enable/disable mechanism.
// ---------------------------------------------------------------------
const ruleActionSchema = z.object({ reason: z.string().min(1).max(2000) });

automationOpsRouter.post("/rules/:id/pause", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId)) {
    res.status(400).json({ error: "Invalid rule id" });
    return;
  }
  const parsed = ruleActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const rule = await pauseAutomationRule(ruleId, authedUser.brokerageId, { id: authedUser.id }, parsed.data.reason);
    res.json({ rule });
  } catch (err) {
    if (err instanceof AutomationValidationError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("POST /automation/ops/rules/:id/pause failed", err);
    res.status(500).json({ error: "Could not pause this rule right now. Try again in a moment." });
  }
});

automationOpsRouter.post("/rules/:id/resume", async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const ruleId = Number(req.params.id);
  if (!Number.isInteger(ruleId)) {
    res.status(400).json({ error: "Invalid rule id" });
    return;
  }
  const parsed = ruleActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const rule = await resumeAutomationRule(ruleId, authedUser.brokerageId, { id: authedUser.id }, parsed.data.reason);
    res.json({ rule });
  } catch (err) {
    if (err instanceof AutomationValidationError) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("POST /automation/ops/rules/:id/resume failed", err);
    res.status(500).json({ error: "Could not resume this rule right now. Try again in a moment." });
  }
});
