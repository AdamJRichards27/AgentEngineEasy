import { Router } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { askCopilot } from "../lib/ai/orchestrator.js";
import { isRoleEnabled } from "../lib/ai/featureFlags.js";
import { resolveBrokerageTier, isRoleEntitled } from "../lib/ai/entitlements.js";
import { AiEntitlementError, AiFeatureDisabledError } from "../lib/ai/types.js";
import { GrowRateLimitError } from "../lib/ai/growRateLimiter.js";
import { AiDailyCapExceededError, getAiUsageSnapshot } from "../lib/ai/dailyUsage.js";
import { AiUsageLimitsNotConfiguredError } from "../lib/ai/usageLimits.js";
import { explainEntitlementDecision } from "../lib/entitlements/resolver.js";
import { isRestoredEnvironmentOutboundBlockedError } from "../lib/outboundGuard.js";

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
  // AE GROW Pilot Readiness WP1 (P2-2) — grow.ai.use ("Ask Agent Engine questions scoped to
  // Grow context", lib/billing/catalogue.ts) is required for every Grow-scoped request (Grow
  // Ask AE and the Business Coach, which is only reachable with contextType "grow"). Checked
  // per user via the same resolver requireEntitlement() uses, before askCopilot() does any
  // work. Non-Grow (RUN Copilot) requests are deliberately untouched by this gate.
  if (parsed.data.contextType === "grow") {
    const isCoach = parsed.data.mode === "coach";
    try {
      const decision = await explainEntitlementDecision(authedUser, "grow.ai.use");
      if (decision.allowed === false) {
        res.status(403).json({
          error: isCoach
            ? "Your plan does not include the AI Business Coach (Grow AI is not enabled for this account)."
            : "Grow-scoped Ask AE requires a Grow or Pro plan with Grow AI enabled.",
          reason: decision.reason,
          entitlementKey: "grow.ai.use",
        });
        return;
      }
    } catch (err) {
      logger.error("ai_ask_grow_ai_entitlement_failed_closed", { error: err, userId: authedUser.id });
      res.status(403).json({ error: "Not entitled", reason: "ENTITLEMENT_MISSING", entitlementKey: "grow.ai.use" });
      return;
    }
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
    // AE GROW Pilot Readiness WP1 (P1-3) — durable daily AI limits
    // (lib/ai/dailyUsage.ts), enforced inside askCopilot() before any provider call.
    // `scope` says which of the two independent limits was reached ("user" or "brokerage").
    if (err instanceof AiDailyCapExceededError) {
      res.status(429).json({ error: err.message, limit: err.limit, tier: err.tier, scope: err.scope, unit: err.unit });
      return;
    }
    // Live activation without configuration — an operator fault, not a client error and not a
    // quota refusal (lib/ai/usageLimits.ts). The operator-facing detail goes to the log; the
    // caller gets an honest "unavailable" rather than an answer served under a limit nobody
    // decided on.
    if (err instanceof AiUsageLimitsNotConfiguredError) {
      logger.error("ai_usage_limits_unconfigured", { missing: err.missing, tier: err.tier, detail: err.message });
      res.status(503).json({
        error: "AI is not available right now. An administrator has been notified.",
        code: "AI_USAGE_LIMITS_NOT_CONFIGURED",
      });
      return;
    }
    // WS4-11 D-AI: a restored environment's refusal is a deliberate 503 (middlewares/errorHandler.ts), not a 500.
    if (isRestoredEnvironmentOutboundBlockedError(err)) throw err;
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

// AE GROW post-merge hardening — read-only AI usage inspection.
//
// Answers "how much AI have I used today, and how much has my brokerage used?" from the same
// durable ai_interactions rows the limits themselves count (lib/ai/dailyUsage.ts), so it is
// correct whether or not any limit is configured or enforced — metering happens in the pilot's
// mock-provider default too.
//
// Tenant scoping is total and not client-controllable: brokerageId and userId both come from
// req.authedUser, never from the query string or body, so there is no shape of this request
// that can read another brokerage's or another user's usage. A Brokerage Administrator
// additionally gets a per-user breakdown FOR THEIR OWN BROKERAGE ONLY, which is user ids and
// counts and nothing else — no question text, no response, no email address, no name. Gated by
// the existing role model (BROKERAGE_ADMIN_ROLES, middlewares/auth.ts — "brokerage
// users/settings/oversight"), the same role that already sees brokerage-wide oversight
// surfaces elsewhere in this API; no new entitlement key was invented for it.
//
// AE GROW W2-C (C-10) — the same response now also carries TOKENS and ESTIMATED COST, read back
// from ai_usage (which until now was written on every successful request and read by nothing).
// Nothing here changes what is ENFORCED: the ceilings still count requests only
// (lib/ai/dailyUsage.ts), because denominating them in tokens or dollars is a commercial
// decision reserved for pilot evidence, and this endpoint exists to produce that evidence
// rather than pre-empt it. Cost is always accompanied by costEstimateBasis so a provider-side
// estimate is never read as a bill.
//
// WHO SEES WHAT (Project Owner ruling — brokerage-wide AI spend is administrator-only):
//
//   Every authenticated user        their own request count, their own tokens and their own
//                                   estimated cost; the brokerage's REQUEST COUNT and ceiling
//                                   (which predate this and explain a brokerage-wide refusal).
//
//   Brokerage Administrator ONLY    tokens.brokerage — brokerage-wide tokens and estimated
//   (+ everything above)            provider cost — plus users[], byRole[] and distribution.
//
// An agent must not learn the brokerage's token total or provider spend, other agents' usage,
// or any other commercially sensitive brokerage-wide AI consumption figure, THROUGH ANY FIELD
// of this response. That is enforced in lib/ai/dailyUsage.ts, which never puts the withheld
// figures into the object it returns — not by the frontend declining to render them — and the
// gate is the caller's role, resolved below from the session and never from client input.
// routes/__tests__/aiUsageAdminOnly.test.ts asserts the negative case field by field.
//
// Not covered here, and deliberately not papered over: voice transcription (routes/aiVoice.ts)
// writes no ai_interactions or ai_usage row at all, so STT spend is absent from these totals.
aiRouter.get("/usage", requireAuth, async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const isBrokerageAdmin = BROKERAGE_ADMIN_ROLES.includes(authedUser.role);
  try {
    const snapshot = await getAiUsageSnapshot({
      brokerageId: authedUser.brokerageId,
      userId: authedUser.id,
      // Resolved HERE, from the session's role, and never from anything the
      // client sends: there is no query parameter, header or body field that
      // can turn this on. dailyUsage.ts does the withholding; this line is
      // the only place that decides who qualifies.
      includeBrokerageOversight: isBrokerageAdmin,
    });
    res.json(snapshot);
  } catch (err) {
    if (err instanceof AiUsageLimitsNotConfiguredError) {
      // Reported rather than papered over: displaying a limit that is not actually in force
      // would be worse than saying the limits are not configured.
      logger.error("ai_usage_limits_unconfigured", { missing: err.missing, tier: err.tier, detail: err.message });
      res.status(503).json({
        error: "AI usage limits are not configured. An administrator has been notified.",
        code: "AI_USAGE_LIMITS_NOT_CONFIGURED",
      });
      return;
    }
    logger.error("ai_usage_route_failed", { error: err });
    res.status(500).json({ error: "AI usage could not be read right now. Try again in a moment." });
  }
});
