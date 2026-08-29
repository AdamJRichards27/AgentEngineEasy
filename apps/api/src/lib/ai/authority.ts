// AI Governance, Authority & Action Control Architecture -- Stage G2.
//
// Formal AI Authority Level model (Build Instructions Part 1). This is a
// distinct axis from the pre-existing RiskLevel (0-4, ./types.ts): Authority
// answers "how much autonomy does the AI have to act at all", Risk answers
// "how sensitive is this particular action". Every AI action carries both.
export type AuthorityLevel = 1 | 2 | 3 | 4 | 5;

export const AUTHORITY_LEVELS = {
  OBSERVE: 1,
  RECOMMEND: 2,
  PREPARE: 3,
  EXECUTE: 4,
  SYSTEM_CHANGE: 5,
} as const satisfies Record<string, AuthorityLevel>;

export const AUTHORITY_LEVEL_DESCRIPTIONS: Record<AuthorityLevel, string> = {
  1: "OBSERVE -- retrieve, analyse, explain. No write action occurs, no approval required.",
  2: "RECOMMEND -- propose an action without creating or changing any operational record.",
  3: "PREPARE -- prepare a draft (email, task, workflow change, etc.) that stays DRAFT/PROPOSED until an authorised human converts it.",
  4: "EXECUTE -- request execution of an approved operational action, only through the AI Action Execution Gateway.",
  5: "SYSTEM_CHANGE -- workflow definitions, org settings, permissions, compliance/financial configuration. The AI may only analyse, recommend, and prepare a proposed change; it must never execute one directly.",
};

// Deterministic risk *tier* labels layered onto the existing 0-4 RiskLevel scale
// (apps/api/src/lib/ai/types.ts) per Build Instructions Part 3. Kept as a pure
// mapping function rather than a second numeric scale, so nothing already using
// RiskLevel has to change.
import type { RiskLevel } from "./types.js";

export type RiskTier = "LOW" | "MEDIUM" | "HIGH" | "RESTRICTED";

const RISK_LEVEL_TO_TIER: Record<RiskLevel, RiskTier> = {
  0: "LOW",
  1: "LOW",
  2: "MEDIUM",
  3: "HIGH",
  4: "RESTRICTED",
};

export function riskTierForLevel(riskLevel: RiskLevel): RiskTier {
  return RISK_LEVEL_TO_TIER[riskLevel];
}

// RESTRICTED actions (Part 3: AML/compliance determinations, financial ledger
// changes, commission calculation, entitlement/role/permission changes, schema
// or security-control changes, AI governance configuration itself) must never
// be auto-executed or even reach the approval queue as an executable action --
// the AI may only recommend that a human perform them through the existing,
// unmodified application workflow. This is enforced centrally, not per-action,
// so a newly registered action can never accidentally bypass it.
export function isAutoExecuteEligible(authorityLevel: AuthorityLevel, riskTier: RiskTier): boolean {
  if (riskTier === "RESTRICTED") return false;
  if (authorityLevel >= AUTHORITY_LEVELS.SYSTEM_CHANGE) return false;
  return authorityLevel <= AUTHORITY_LEVELS.RECOMMEND || riskTier === "LOW";
}
