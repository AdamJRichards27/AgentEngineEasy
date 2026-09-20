import type { AiRole, SubscriptionTier } from "./types.js";
import { resolveEntitlements } from "../entitlements/resolver.js";
import type { EntitlementActor } from "../entitlements/types.js";

/**
 * AE GROW Priority 0.5 — Workstream 4: AI entitlement source-of-truth consolidation.
 *
 * Before this phase, resolveBrokerageTier() was a disconnected stub — hardcoded to always
 * return "STARTER" because "no subscription/tenant concept exists in the database yet." That
 * premise is no longer true: packages/db/src/schema/billing.ts's entitlementGrants (Grow Stage
 * A) and apps/api/src/lib/entitlements/resolver.ts (the real, tested, tenant-scoped, fail-closed
 * entitlement resolver) are exactly that subscription/tenant concept, already used to gate every
 * Grow route and, since this phase's Workstream 3, every RUN route (Pit Crew, Financial) too.
 *
 * This function now derives its answer from that SAME resolver — there is no second,
 * independent notion of "what tier is this brokerage" anywhere in the codebase after this
 * change. It resolves entitlements via a synthetic system-level actor
 * ({ id: -1, role: "system", brokerageId }) rather than a real user id: resolver.ts's
 * grantAppliesToActor() only inspects actor.id for the "user" granteeType, and every grant this
 * codebase issues today is "brokerage"-scoped (see runAccessBackfill.ts, catalogue.ts), so the
 * synthetic id is never actually consulted — this call answers "what does this BROKERAGE hold",
 * not "what does this one user hold", which is what a brokerage-wide AI tier decision requires.
 *
 * Tier mapping (matches the three real products in lib/billing/catalogue.ts exactly):
 *   - grow.access AND run.access   -> "PRO"     (the Pro + Grow bundle product)
 *   - grow.access only             -> "GROW"    (the standalone Grow product)
 *   - neither (or run.access only) -> "STARTER" (the Starter/RUN-only product, and the
 *                                                 pre-Grow default — see "no divergence" below)
 *
 * No-divergence guarantee: a brokerage with zero entitlement grants at all resolves to
 * "STARTER" here, identical to the old hardcoded return value — so this change cannot silently
 * downgrade or upgrade any brokerage's AI capability on its own. Proven in
 * __tests__/entitlements.test.ts.
 */
export async function resolveBrokerageTier(brokerageId: number): Promise<SubscriptionTier> {
  const systemActor: EntitlementActor = { id: -1, role: "system", brokerageId };
  const entitlements = await resolveEntitlements(systemActor);
  const hasGrow = entitlements.has("grow.access");
  const hasRun = entitlements.has("run.access");
  if (hasGrow && hasRun) return "PRO";
  if (hasGrow) return "GROW";
  return "STARTER";
}

interface TierCapabilities {
  roles: Record<AiRole, boolean>;
  /**
   * PROVISIONAL TECHNICAL SAFETY LIMIT — NOT a commercial allowance.
   *
   * These three numbers were written when nothing read them, and they are per BROKERAGE, not
   * per user (see docs/AE_GROW_PILOT_READINESS_REPORT.md §6.1). They survive only as the
   * FALLBACK DEFAULT for the brokerage-level daily safety ceiling in lib/ai/usageLimits.ts,
   * used when no operator configuration exists and no live AI provider is approved.
   *
   * Nothing else may read this field: the effective per-user and per-brokerage limits are
   * resolved exclusively by lib/ai/usageLimits.ts, and once LIVE_AI_PROVIDER_APPROVED=true
   * these numbers are deliberately NOT used — that case fails closed until an operator has
   * configured both limits explicitly. Do not treat them as a published entitlement, and do
   * not add a third caller.
   */
  maxAiRequestsPerDay: number;
}

export const TIER_CAPABILITIES: Record<SubscriptionTier, TierCapabilities> = {
  STARTER: {
    roles: { copilot: true, proactive_intelligence: false, business_coach: false, workflow_ai: false, pitcrew_ai: false },
    maxAiRequestsPerDay: 20,
  },
  GROW: {
    roles: { copilot: true, proactive_intelligence: true, business_coach: true, workflow_ai: false, pitcrew_ai: false },
    maxAiRequestsPerDay: 200,
  },
  PRO: {
    roles: { copilot: true, proactive_intelligence: true, business_coach: true, workflow_ai: true, pitcrew_ai: true },
    maxAiRequestsPerDay: 1000,
  },
};

// Entitlement enforcement must always happen here, server-side, before any
// provider call - never rely on the UI hiding a button. Called from
// orchestrator.ts for every request, in addition to (not instead of) the
// requireAuth/requireRole permission check on the route itself.
export function isRoleEntitled(tier: SubscriptionTier, role: AiRole): boolean {
  return TIER_CAPABILITIES[tier].roles[role];
}
