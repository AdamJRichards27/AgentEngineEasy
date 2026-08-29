// AI Governance, Authority & Action Control Architecture -- Stage G3.
//
// The Policy & Permission Engine is the single place that decides whether a
// proposed AI action is permitted. It is a pure decision function: it never
// mutates state and never executes anything. Both the Approval Engine (G5)
// and the Execution Gateway (G6) call this on every request -- including a
// second time at execution, per the codebase's existing defense-in-depth
// convention (see askCopilot()'s re-check comment in orchestrator.ts) -- and
// both must fail closed if this does not return an explicit allow.
//
// Golden Rule (Build Instructions Part 4): the AI can never be granted more
// authority than the authenticated human actually has. This is enforced by
// checking that the calling user's own role is inside the action
// definition's allowedRoles -- the exact same roles that could perform the
// action manually. There is no separate, more permissive "AI role".
//
// This module does not implement its own entitlement engine. It routes every
// entitlement check through the existing, authoritative central resolver
// (apps/api/src/lib/entitlements/resolver.ts) so there remains only one
// source of truth for what a brokerage's subscription tier allows -- the
// AI-specific entitlement stub (./entitlements.ts) is not consulted here.
//
// Fail-safe rule (Part 6): every branch below defaults to denial. A thrown
// error, a missing definition, or an unrecognised actor type is a denial,
// never a silent allow.

import { explainEntitlementDecision } from "../entitlements/resolver.js";
import type { EntitlementActor } from "../entitlements/types.js";
import {
  getActionDefinition,
  type ActorType,
} from "./actions/registry.js";
import { isAutoExecuteEligible, riskTierForLevel, type RiskTier } from "./authority.js";
import type { RiskLevel } from "./types.js";

export type PolicyDenialReason =
  | "ACTION_NOT_FOUND"
  | "ACTION_DISABLED"
  | "RESTRICTED_ACTION_BLOCKED"
  | "ACTOR_TYPE_FORBIDDEN"
  | "ROLE_FORBIDDEN"
  | "TENANT_CONTEXT_REQUIRED"
  | "INPUT_SCHEMA_INVALID"
  | "ENTITLEMENT_DENIED";

export interface PolicyActor {
  // Deliberately narrow: id/role/brokerageId only, and only ever populated
  // from server-side session/auth state (apps/api/src/middlewares/auth.ts).
  // Never accept these fields from an AI-generated payload (Part 20).
  id: number;
  role: string;
  brokerageId: number;
}

export interface EvaluateAIActionInput {
  actionKey: string;
  actor: PolicyActor;
  actorType: ActorType;
  rawInput: unknown;
}

export interface PolicyDecision {
  allowed: boolean;
  reason: PolicyDenialReason | "OK";
  actionKey: string;
  authorityLevel?: number;
  riskLevel?: RiskLevel;
  riskTier?: RiskTier;
  requiresApproval: boolean;
  entitlementKey?: string;
  parsedInput?: unknown;
}

function denyWith(actionKey: string, reason: PolicyDenialReason, extra: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    allowed: false,
    reason,
    actionKey,
    requiresApproval: true,
    ...extra,
  };
}

export async function evaluateAIAction(input: EvaluateAIActionInput): Promise<PolicyDecision> {
  const { actionKey } = input;

  let definition;
  try {
    definition = getActionDefinition(actionKey);
  } catch (err) {
    console.error("evaluateAIAction: registry lookup threw, failing closed", err);
    return denyWith(actionKey, "ACTION_NOT_FOUND");
  }

  if (!definition) {
    return denyWith(actionKey, "ACTION_NOT_FOUND");
  }

  if (!definition.enabled) {
    return denyWith(actionKey, "ACTION_DISABLED");
  }

  const riskTier = riskTierForLevel(definition.riskLevel);

  // RESTRICTED-risk actions must never be directly executed by AI, and must
  // never even reach the approval queue as an AI-executable action (Part 3).
  // A human performs these through the existing, unmodified application --
  // registering one here at all would be a build error, but this check
  // stays in place as the last line of defense regardless.
  if (riskTier === "RESTRICTED") {
    return denyWith(actionKey, "RESTRICTED_ACTION_BLOCKED", {
      authorityLevel: definition.authorityLevel,
      riskLevel: definition.riskLevel,
      riskTier,
    });
  }

  if (!definition.allowedActorTypes.includes(input.actorType)) {
    return denyWith(actionKey, "ACTOR_TYPE_FORBIDDEN", {
      authorityLevel: definition.authorityLevel,
      riskLevel: definition.riskLevel,
      riskTier,
    });
  }

  // Golden Rule: the actor's own manual role must be one of the roles that
  // could perform this action by hand. No AI-only bypass exists.
  if (!definition.allowedRoles.some((role) => role === input.actor.role)) {
    return denyWith(actionKey, "ROLE_FORBIDDEN", {
      authorityLevel: definition.authorityLevel,
      riskLevel: definition.riskLevel,
      riskTier,
    });
  }

  if (!input.actor.brokerageId) {
    return denyWith(actionKey, "TENANT_CONTEXT_REQUIRED", {
      authorityLevel: definition.authorityLevel,
      riskLevel: definition.riskLevel,
      riskTier,
    });
  }

  const parsed = definition.inputSchema.safeParse(input.rawInput);
  if (!parsed.success) {
    return denyWith(actionKey, "INPUT_SCHEMA_INVALID", {
      authorityLevel: definition.authorityLevel,
      riskLevel: definition.riskLevel,
      riskTier,
    });
  }

  if (definition.requiredEntitlementKey) {
    const entitlementActor: EntitlementActor = {
      id: input.actor.id,
      role: input.actor.role,
      brokerageId: input.actor.brokerageId,
    };
    let entitlementDecision;
    try {
      entitlementDecision = await explainEntitlementDecision(entitlementActor, definition.requiredEntitlementKey);
    } catch (err) {
      console.error("evaluateAIAction: entitlement check threw, failing closed", err);
      return denyWith(actionKey, "ENTITLEMENT_DENIED", {
        authorityLevel: definition.authorityLevel,
        riskLevel: definition.riskLevel,
        riskTier,
        entitlementKey: definition.requiredEntitlementKey,
      });
    }
    if (!entitlementDecision.allowed) {
      return denyWith(actionKey, "ENTITLEMENT_DENIED", {
        authorityLevel: definition.authorityLevel,
        riskLevel: definition.riskLevel,
        riskTier,
        entitlementKey: definition.requiredEntitlementKey,
      });
    }
  }

  const requiresApproval = !isAutoExecuteEligible(definition.authorityLevel, riskTier);

  return {
    allowed: true,
    reason: "OK",
    actionKey,
    authorityLevel: definition.authorityLevel,
    riskLevel: definition.riskLevel,
    riskTier,
    requiresApproval,
    entitlementKey: definition.requiredEntitlementKey,
    parsedInput: parsed.data,
  };
}
