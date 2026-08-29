// AI Governance, Authority & Action Control Architecture -- Stage G9.
//
// Protected System Operations. This is the explicit denylist Build
// Instructions Part 3 describes: categories of operation that must NEVER
// be reachable through the AI Action Registry, regardless of role,
// entitlement, or approval. RESTRICTED-risk actions are already blocked
// structurally by the Policy Engine (policyEngine.ts refuses any action
// whose risk tier resolves to RESTRICTED), but that only helps if
// riskLevel is set correctly on every registry entry. This module is the
// second, independent line of defense: a name-based denylist plus a
// self-check that runs the moment the registry module loads, so a future
// entry that is miscategorised (e.g. an entitlement-changing action wired
// up with riskLevel 0 by mistake) fails the app at startup instead of
// silently shipping an AI-executable privilege escalation.
//
// This list is deliberately about *categories of operation*, not specific
// actionKeys -- it exists so a reviewer adding a new action to the
// registry has an explicit checklist of "this must never be here" to
// check the new actionKey's name against.

export const PROTECTED_OPERATION_CATEGORIES = [
  "AML/compliance determinations (verdicts, overrides, status changes)",
  "Financial ledger and commission changes",
  "Entitlement, role, or permission changes",
  "Database schema changes",
  "Security control changes (auth, session, encryption configuration)",
  "AI governance configuration itself (this registry, the Policy Engine, authority levels)",
  "User account creation, deletion, or credential changes",
  "Direct SQL, arbitrary API calls, or raw workflow-step edits",
] as const;

// Name fragments that, if found in a registered actionKey (case-insensitive),
// indicate the action almost certainly belongs to a protected category above
// and must not be in the AI-executable registry.
const FORBIDDEN_ACTION_KEY_FRAGMENTS = [
  "AML",
  "COMPLIANCE",
  "LEDGER",
  "COMMISSION",
  "ENTITLEMENT",
  "ROLE",
  "PERMISSION",
  "SCHEMA",
  "SECURITY",
  "AUTH",
  "GOVERNANCE",
  "USER_DELETE",
  "USER_CREATE",
  "CREDENTIAL",
  "PASSWORD",
  "SQL",
];

export interface RegisteredActionLike {
  actionKey: string;
  riskLevel: number;
}

/**
 * Fails closed and loudly: throws (crashing startup) rather than allowing
 * the API to boot with a protected operation reachable through the AI
 * Action Registry. Called once, synchronously, from actions/registry.ts
 * immediately after ACTION_REGISTRY is constructed.
 */
export function assertNoProtectedOperationsRegistered(actions: RegisteredActionLike[]): void {
  for (const action of actions) {
    const upperKey = action.actionKey.toUpperCase();
    const hit = FORBIDDEN_ACTION_KEY_FRAGMENTS.find((fragment) => upperKey.includes(fragment));
    if (hit) {
      throw new Error(
        `AI Action Registry startup check failed: action "${action.actionKey}" matches forbidden fragment "${hit}". ` +
          `Protected operations (Part 3) must never be registered as AI-executable actions.`,
      );
    }
    if (action.riskLevel >= 4) {
      throw new Error(
        `AI Action Registry startup check failed: action "${action.actionKey}" has riskLevel ${action.riskLevel} ` +
          `(RESTRICTED tier). RESTRICTED-risk actions must never be directly executable by AI (Part 3).`,
      );
    }
  }
}
