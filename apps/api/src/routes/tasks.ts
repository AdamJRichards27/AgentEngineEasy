import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, automationTasks, automationAttentionItems } from "@aee/db";
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

tasksRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
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
  const result = await completeAutomationTask({ brokerageId: user.brokerageId, taskId: req.params.id, userId: user.id });
  if (!result.ok) {
    res.status(result.reason === "NOT_FOUND" ? 404 : 400).json({ error: result.reason });
    return;
  }
  res.json({ task: result.task });
});

tasksRouter.post("/attention-items/:id/resolve", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  try {
    const item = await resolveAttentionItem({
      brokerageId: user.brokerageId,
      attentionItemId: req.params.id,
      resolvedByUserId: user.id,
      resolutionNote: typeof req.body?.notes === "string" ? req.body.notes : null,
    });
    res.json({ item });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
