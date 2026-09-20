import { Router, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db, automationTasks, automationAttentionItems } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { completeAutomationTask } from "../lib/automation/tasks.js";
import { resolveAttentionItem } from "../lib/automation/attentionItems.js";

// #122 — agent-facing task/attention-item visibility. automationTasks and
// automationAttentionItems previously had zero non-admin surface: the WAE
// creates real rows in both tables from production rule activity, but the
// only existing route was the admin-gated automation/ops surface
// (routes/automationOps.ts). An ordinary agent working a property had no
// way to see, action, or complete a task the workflow catalogue created
// for them.
export const tasksRouter = Router();

// AE GROW Pilot Readiness WP9 — route-id validation, the same bounded guard
// routes/grow.ts, routes/communications.ts, routes/growAppraisals.ts and
// routes/propertyIntelligence.ts already use (each keeps its own local copy;
// this is deliberately not a shared module). automationTasks.propertyId is a
// `serial` reference, i.e. an int4, and `Number("abc")` reached Postgres as
// NaN.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

// Unlike every other router in this app, this one's own ids are `uuid`
// columns (packages/db/src/schema/automation.ts: automationTasks.id and
// automationAttentionItems.id are both `uuid(...)`), not serials — so the
// malformed-id case here is a non-uuid string, which Postgres rejects with
// "invalid input syntax for type uuid" and Drizzle re-throws as its own
// "Failed query: select ..." text. Validating the shape first keeps that a
// 400 before any query runs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUuidParam(res: Response, value: unknown, label: "task" | "attention item"): string | null {
  if (typeof value === "string" && UUID_RE.test(value)) return value;
  res.status(400).json({ error: `Invalid ${label} id` });
  return null;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_TASK_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/**
 * Driver/ORM text, as a second line of defence behind the prototype test in
 * isOperatorAuthoredError below.
 */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape this app's own
 * lib/*.ts domain services use for their operator-authored, caller-facing
 * messages (here: "Attention item not found in this brokerage."), which are
 * deliberately kept.
 *
 * Every driver/ORM/system error is a SUBCLASS of Error and therefore fails
 * this prototype-identity test: drizzle's DrizzleQueryError (whose message is
 * the `Failed query: select "id", "brokerage_id" ... from ...` text live
 * smoke testing found in real response bodies), pg's DatabaseError, and
 * RangeError/TypeError/SyntaxError. DrizzleQueryError notably does NOT
 * override `name` — it reports "Error" — so a name check alone would let the
 * leak straight through; only the prototype identity separates them.
 */
function isOperatorAuthoredError(err: unknown): err is Error {
  return err instanceof Error && Object.getPrototypeOf(err) === Error.prototype && !DRIVER_TEXT.test(err.message);
}

/**
 * Typed/expected domain errors keep their own status and message; anything
 * else is an unrecognised server fault, logged in full server-side (the
 * structured logger attaches the ambient correlationId itself — see
 * packages/events/src/logger.ts) and answered generically. Mirrors
 * handleGrowAppraisalError / handlePropertyIntelligenceError.
 */
function handleTaskError(err: unknown, res: Response, expectedStatus: number): void {
  if (isOperatorAuthoredError(err)) {
    res.status(expectedStatus).json({ error: err.message });
    return;
  }
  logger.error("tasks_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_TASK_ERROR });
}

tasksRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = parsePositiveId(req.params.propertyId);
  if (propertyId === null) {
    res.status(400).json({ error: "Invalid property id" });
    return;
  }
  const user = req.authedUser!;

  const tasks = await db
    .select()
    .from(automationTasks)
    .where(and(eq(automationTasks.propertyId, propertyId), eq(automationTasks.brokerageId, user.brokerageId), eq(automationTasks.status, "ACTIVE")));
  const attentionItems = await db
    .select()
    .from(automationAttentionItems)
    .where(
      and(
        eq(automationAttentionItems.propertyId, propertyId),
        eq(automationAttentionItems.brokerageId, user.brokerageId),
        eq(automationAttentionItems.status, "OPEN"),
      ),
    );

  res.json({ tasks, attentionItems });
});

tasksRouter.post("/:id/complete", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const taskId = readUuidParam(res, req.params.id, "task");
  if (taskId === null) return;
  const result = await completeAutomationTask({ brokerageId: user.brokerageId, taskId, userId: user.id });
  if (!result.ok) {
    res.status(result.reason === "NOT_FOUND" ? 404 : 400).json({ error: result.reason });
    return;
  }
  res.json({ task: result.task });
});

tasksRouter.post("/attention-items/:id/resolve", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const attentionItemId = readUuidParam(res, req.params.id, "attention item");
  if (attentionItemId === null) return;
  try {
    const item = await resolveAttentionItem({
      brokerageId: user.brokerageId,
      attentionItemId,
      resolvedByUserId: user.id,
      resolutionNote: typeof req.body?.notes === "string" ? req.body.notes : null,
    });
    res.json({ item });
  } catch (err) {
    // resolveAttentionItem's only expected failure is its own
    // "Attention item not found in this brokerage." — the 404 this route has
    // always answered. A driver fault used to be returned as a 404 carrying
    // the driver's message; it is now a logged, generic 500.
    handleTaskError(err, res, 404);
  }
});
