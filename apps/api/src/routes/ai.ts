import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { askCopilot } from "../lib/ai/orchestrator.js";
import { isRoleEnabled } from "../lib/ai/featureFlags.js";
import { resolveBrokerageTier, isRoleEntitled } from "../lib/ai/entitlements.js";
import { AiEntitlementError, AiFeatureDisabledError } from "../lib/ai/types.js";

export const aiRouter = Router();

const askSchema = z.object({
  question: z.string().min(1).max(2000),
  contextType: z.enum(["property", "transaction", "business"]).nullable().optional(),
  contextId: z.number().int().positive().nullable().optional(),
});

// Level 0 (read-only) only - see lib/ai/types.ts RISK_LEVEL_DESCRIPTIONS. Every
// permission/entitlement/feature-flag check happens again inside askCopilot()
// even though requireAuth has already run here - the orchestrator never trusts
// a route to have already done its job.
aiRouter.post("/ask", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const parsed = askSchema.safeParse(req.body);
  if (parsed.success === false) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  try {
    const result = await askCopilot({
      brokerageId: authedUser.brokerageId,
      userId: authedUser.id,
      userRole: authedUser.role,
      question: parsed.data.question,
      contextType: parsed.data.contextType ?? null,
      contextId: parsed.data.contextId ?? null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AiFeatureDisabledError || err instanceof AiEntitlementError) {
      res.status(403).json({ error: err.message });
      return;
    }
    console.error("POST /ai/ask failed", err);
    res.status(500).json({ error: "The AI Copilot could not answer that right now. Try again in a moment." });
  }
});

// Lets the UI know, before rendering any AI affordance, whether Copilot is
// available for this user. Enforcement itself still happens server-side on
// every /ask call regardless of what this endpoint says - this exists only so
// the UI doesn't show a control that would just 403.
aiRouter.get("/capabilities", requireAuth, (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const tier = resolveBrokerageTier(authedUser.brokerageId);
  res.json({
    tier,
    copilotEnabled: isRoleEnabled("copilot") && isRoleEntitled(tier, "copilot"),
  });
});
