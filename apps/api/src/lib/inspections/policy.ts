// Inspection policies (CC #34, Owner t113u D8 options A/B/C; Owner t165u:
// "Default inspection policy: B, preserving configurable A and C").
// Pure, migration-free. Storing a per-listing policy and bookings needs
// migration M4 (properties.inspection_policy, inspection tables), which is
// separately gated and NOT part of this change.
//
// A — qualified buyers only, strictly by appointment (no open homes).
// B — qualified buyers may book a private inspection; everyone else is
//     steered to an open home.
// C — open home only (no private inspections).

export const INSPECTION_POLICIES = ["A", "B", "C"] as const;
export type InspectionPolicy = (typeof INSPECTION_POLICIES)[number];
export type InspectionKind = "OPEN" | "PRIVATE";

/** Owner t165u: default for a listing with no explicit policy. */
export const DEFAULT_INSPECTION_POLICY: InspectionPolicy = "B";

export function resolveInspectionPolicy(configured: string | null | undefined): InspectionPolicy {
  return (INSPECTION_POLICIES as readonly string[]).includes(configured ?? "") ? (configured as InspectionPolicy) : DEFAULT_INSPECTION_POLICY;
}

export type InspectionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "INSPECTION_POLICY_OPEN_NOT_ALLOWED" | "INSPECTION_POLICY_PRIVATE_NOT_ALLOWED" | "BUYER_NOT_QUALIFIED";
      /** Under policy B an unqualified buyer is steered to an open home. */
      alternative?: "OPEN";
    };

/** Server-side check: never rely on the UI hiding an option. */
export function evaluateInspectionRequest(policy: InspectionPolicy, kind: InspectionKind, buyerQualified: boolean): InspectionDecision {
  if (kind === "OPEN") {
    return policy === "A" ? { allowed: false, code: "INSPECTION_POLICY_OPEN_NOT_ALLOWED" } : { allowed: true };
  }
  if (policy === "C") return { allowed: false, code: "INSPECTION_POLICY_PRIVATE_NOT_ALLOWED", alternative: "OPEN" };
  if (buyerQualified) return { allowed: true };
  return policy === "B" ? { allowed: false, code: "BUYER_NOT_QUALIFIED", alternative: "OPEN" } : { allowed: false, code: "BUYER_NOT_QUALIFIED" };
}
