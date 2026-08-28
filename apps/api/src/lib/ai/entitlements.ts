import type { AiRole, SubscriptionTier } from "./types.js";

// No subscription/tenant concept exists in the database yet (repository audit
// RISK - see the completion report). Every brokerage resolves to STARTER until a
// real billing/subscription build lands; this function is the single seam that
// future build changes - nothing else in the AI layer needs to know how tier is
// determined.
export function resolveBrokerageTier(_brokerageId: number): SubscriptionTier {
  return "STARTER";
}

interface TierCapabilities {
  roles: Record<AiRole, boolean>;
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
