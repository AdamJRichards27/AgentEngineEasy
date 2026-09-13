import { Router } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { askCopilot } from "../lib/ai/orchestrator.js";
import { isRoleEnabled } from "../lib/ai/featureFlags.js";
import { resolveBrokerageTier, isRoleEntitled } from "../lib/ai/entitlements.js";
import { AiEntitlementError, AiFeatureDisabledError } from "../lib/ai/types.js";
import { GrowRateLimitError } from "../lib/ai/growRateLimiter.js";

export const aiRouter = Router();

// AE GROW Priority 6 Stage C — bounded custom-range validation happens again,
// independently, in coaching/period.ts's resolvePeriod() (CUSTOM_PERIOD_MAX_DAYS/
// CUSTOM_PERIOD_MAX_LOOKBACK_DAYS) - the length caps here only stop a wildly
// oversized string from ever reaching that parser, they are not the actual
// range validation.
const COACHING_PERIOD_KEYS = ["last7days", "last30days", "currentMonth", "previousPeriod", "custom"] as const;

// AE GROW Priority 6 Stage B: "grow" is additive to the contextType enum, and
// growFocusItemId is a new optional field - every existing (RUN Copilot)
// request body shape is still accepted unchanged. growFocusItemId is a
// string (Grow Today item ids look like "opportunity:123", not a numeric
// id), capped at 64 chars - comfortably longer than any real id this app
// generates, short enough to reject an oversized/malicious value outright
// rather than pass it through to buildGrowContext's exact-match lookup.
//
// AE GROW Priority 6 Stage C: mode/period/periodStartDate/periodEndDate are
// additive. mode defaults to "ask" when omitted (every existing caller
// omits it and is completely unaffected). The refine below is the entire
// "no raw role name from client" / "unsupported modes fail closed"
// boundary at the request-validation layer: mode "coach" is accepted ONLY
// alongside contextType "grow" - there is no other combination that can
// reach the business_coach role, and a client cannot send a role name at
// all (this schema has no such field).
const askSchema = z
  .object({
    question: z.string().min(1).max(2000),
    contextType: z.enum(["property", "transaction", "business", "grow"]).nullable().optional(),
    contextId: z.number().int().positive().nullable().optional(),
    growFocusItemId: z.string().min(1).max(64).nullable().optional(),
    mode: z.enum(["ask", "coach"]).optional(),
    period: z.enum(COACHING_PERIOD_KEYS).optional(),
    periodStartDate: z.string().min(1).max(40).optional(),
    periodEndDate: z.string().min(1).max(40).optional(),
  })
  .refine((data) => data.mode !== "coach" || data.contextType === "grow", {
    message: 'mode "coach" is only supported together with contextType "grow".',
    path: ["mode"],
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
      growFocusItemId: parsed.data.growFocusItemId ?? null,
      mode: parsed.data.mode ?? "ask",
      period: parsed.data.period,
      periodStartDate: parsed.data.periodStartDate ?? null,
      periodEndDate: parsed.data.periodEndDate ?? null,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof AiFeatureDisabledError || err instanceof AiEntitlementError) {
      res.status(403).json({ error: err.message });
      return;
    }
    // AE GROW Priority 6 Stage B — Grow-scoped asks only (this also covers
    // Business Coach requests, which are always also Grow-scoped) - see
    // growRateLimiter.ts. 429 (Too Many Requests) rather than 403/500,
    // since this is neither a permission failure nor a server error.
    if (err instanceof GrowRateLimitError) {
      res.status(429).json({ error: err.message });
      return;
    }
    logger.error("ai_ask_route_failed", { error: err });
    res.status(500).json({ error: "The AI Copilot could not answer that right now. Try again in a moment." });
  }
});

// Lets the UI know, before rendering any AI affordance, whether Copilot (and,
// AE GROW Priority 6 Stage C, the Business Coach) is available for this user.
// Enforcement itself still happens server-side on every /ask call regardless
// of what this endpoint says - this exists only so the UI doesn't show a
// control that would just 403.
aiRouter.get("/capabilities", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // resolveBrokerageTier() is async (AE GROW Priority 0.5 Workstream 4 - it
  // derives the tier from the real entitlement resolver, not a hardcoded
  // stub) and MUST be awaited: an unawaited Promise passed to
  // isRoleEntitled() indexes TIER_CAPABILITIES with a Promise object,
  // resolves to undefined, and throws on `.roles` - a real 500 on every
  // request. See routes/__tests__/ai.test.ts for the regression test.
  const tier = await resolveBrokerageTier(authedUser.brokerageId);
  res.json({
    tier,
    copilotEnabled: isRoleEnabled("copilot") && isRoleEntitled(tier, "copilot"),
    // AE GROW Priority 6 Stage C — additive field. False on STARTER (no
    // grow.access), true on GROW/PRO once AI_BUSINESS_COACH_ENABLED is
    // turned on - see featureFlags.ts/entitlements.ts, unchanged by this
    // stage. Existing consumers of this endpoint that only read
    // copilotEnabled are completely unaffected by this addition.
    businessCoachEnabled: isRoleEnabled("business_coach") && isRoleEntitled(tier, "business_coach"),
  });
});
