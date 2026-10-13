// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// The rule registry (Build Instructions §8): a controlled, typed,
// code-defined catalogue. There is deliberately no database table of rule
// definitions and no interpreter for a stored rule payload — every rule is
// a plain TypeScript object in this package, reviewed and shipped like any
// other code change, which is what §8's explicit prohibition on "arbitrary
// code, user-authored SQL, unrestricted scripts, raw AI prompts as
// detection rules, arbitrary webhooks, unvalidated expressions" requires.
//
// Every rule implements ONE detection method — scanBrokerage(brokerageId,
// now) — that returns the RiskFinding[] for every currently-true occurrence
// of that rule's condition within one tenant. The periodic sweep (engine.ts)
// calls this for every rule, for every brokerage, in bounded batches. A rule
// that also declares triggerEventTypes gets evaluated immediately when one
// of those domain events fires, by calling this same scanBrokerage for just
// that event's brokerage — one detection function per rule, not two, so the
// event-driven and time-driven paths can never silently drift apart from
// each other. B08 also sets the optional resolutionEvidenceWhenAbsent hook
// so a listing that has left the marketing window is recorded as no longer
// applicable instead of as a cleared condition. No other rule sets it.
import type { RiskException } from "@aee/db";
import type { AgentEngineEasyEventType } from "@aee/events";
import type { ResolutionEvidence, RiskExceptionCategory, RiskFinding } from "./types.js";

// What the scheduled scan does when a successful pass no longer returns an
// open exception because the record left the rule's scan window (the
// transaction closed, or the property left stageRange). TypeScript only —
// stored on the rule object, not in the database.
//
// KEEP_OPEN: do not resolve. The exception stays open with its owner and
// brokerage. Required for FINANCIAL, AML/CTF, compliance, security, and
// F32–F34.
// NO_LONGER_APPLICABLE: resolve, and record that reason. Never record a
// scope exit as CONDITION_SATISFIED.
export const SCOPE_EXIT_POLICIES = ["KEEP_OPEN", "NO_LONGER_APPLICABLE"] as const;
export type ScopeExitPolicy = (typeof SCOPE_EXIT_POLICIES)[number];

// Ordinary rules resolve on scope exit. Pinned rules cannot use that default.
export const DEFAULT_SCOPE_EXIT_POLICY: ScopeExitPolicy = "NO_LONGER_APPLICABLE";

// AML/CTF is the compliance category that exists today. COMPLIANCE and
// SECURITY are pinned now so a future rule in either category fails startup
// unless it explicitly keeps the exception open. No migration: categories
// are text, and this check is import-time TypeScript.
export const PINNED_SCOPE_EXIT_CATEGORIES = ["FINANCIAL", "AML_CTF", "COMPLIANCE", "SECURITY"] as const;

export const PINNED_SCOPE_EXIT_RULE_IDS = [
  "F32_CLOSURE_BLOCKED_BY_UNRESOLVED_CONDITION",
  "F33_CLOSURE_ATTEMPTED_PREMATURELY",
  "F34_CLOSED_TRANSACTION_HAS_ACTIVE_BLOCKER",
] as const;

export type TransactionCloseScope = "LEAVES" | "STAYS";

export interface RiskRule {
  ruleId: string;
  version: number;
  category: RiskExceptionCategory;
  name: string;
  description: string;
  // Which canonical events, if any, should trigger an immediate re-scan of
  // this rule for the event's brokerage (Build Instructions §9's
  // event-driven list). Empty for a purely time-driven rule.
  triggerEventTypes: AgentEngineEasyEventType[];
  // Omitted on an ordinary rule means NO_LONGER_APPLICABLE. Pinned rules
  // must set KEEP_OPEN; assertPinnedScopeExitPolicies throws at import
  // otherwise, so the process does not start.
  scopeExitPolicy?: ScopeExitPolicy;
  // Property stages this rule still scans. A current stage outside the list
  // is a scope exit. Omitted means stage alone is never a scope exit.
  // B08 does not use this. Its marketing window is the scan filter plus
  // resolutionEvidenceWhenAbsent, so a filled campaign that also leaves
  // Listed/Under Offer stays CONDITION_SATISFIED.
  stageRange?: readonly string[];
  // LEAVES (omitted): a closed transaction has left this rule's scan.
  // STAYS: the rule still evaluates closed transactions (financial records,
  // F34), so closedAt alone is not a scope exit and an in-scope condition
  // clear is still CONDITION_SATISFIED.
  transactionCloseScope?: TransactionCloseScope;
  scanBrokerage(brokerageId: number, now: Date): Promise<RiskFinding[]>;
  /**
   * Optional. When a successful scan did not return this still-open
   * exception, return evidence to store instead of the scope-exit
   * decision below. Return null to record CONDITION_SATISFIED (the
   * condition itself cleared). Throw to refuse auto-resolution of this
   * one exception — a failed explanation is not proof of completion.
   * Only B08 implements this, so a property that leaves Listed/Under Offer
   * with campaign fields still empty is NO_LONGER_APPLICABLE, while filled
   * fields stay a condition clear. Every other rule leaves it unset.
   */
  resolutionEvidenceWhenAbsent?(openException: RiskException): Promise<ResolutionEvidence | null>;
}

export interface ScopeExitRuleRef {
  ruleId: string;
  category: string;
  scopeExitPolicy?: ScopeExitPolicy;
  stageRange?: readonly string[];
  transactionCloseScope?: TransactionCloseScope;
}

export type ScopeExitKind = "TRANSACTION_CLOSED" | "STAGE_EXIT";

// Facts the sweep re-reads before it auto-resolves. transactionPresent is
// false when the exception names a transaction row that is gone.
export interface ScopeObservation {
  transactionId: number | null;
  transactionPresent: boolean;
  closedAt: Date | null;
  propertyPresent: boolean;
  workflowStage: string | null;
}

export function isPinnedScopeExitRule(rule: { ruleId: string; category: string }): boolean {
  return (
    (PINNED_SCOPE_EXIT_CATEGORIES as readonly string[]).includes(rule.category) ||
    (PINNED_SCOPE_EXIT_RULE_IDS as readonly string[]).includes(rule.ruleId)
  );
}

// Pinned rules stay KEEP_OPEN even if a caller forgot the field. Startup
// still fails closed via assertPinnedScopeExitPolicies, which requires the
// field to be written on the rule.
export function effectiveScopeExitPolicy(rule: ScopeExitRuleRef): ScopeExitPolicy {
  if (isPinnedScopeExitRule(rule)) return "KEEP_OPEN";
  return rule.scopeExitPolicy ?? DEFAULT_SCOPE_EXIT_POLICY;
}

/**
 * Throws when a FINANCIAL, AML/CTF, compliance, security, or F32–F34 rule
 * does not explicitly keep scope-exit exceptions open. Called at import so
 * a bad catalogue fails process startup.
 */
export function assertPinnedScopeExitPolicies(rules: readonly ScopeExitRuleRef[]): void {
  for (const rule of rules) {
    if (!isPinnedScopeExitRule(rule)) continue;
    if (rule.scopeExitPolicy !== "KEEP_OPEN") {
      throw new Error(
        `Risk rule ${rule.ruleId} (${rule.category}) must declare scopeExitPolicy "KEEP_OPEN". Leaving scope must not resolve FINANCIAL, AML/CTF, compliance, security, or F32–F34 exceptions (got ${rule.scopeExitPolicy ?? "undefined"}).`,
      );
    }
  }
}

/**
 * Whether this record has left the rule's scan window. Null means the
 * record is still in scope, so a missing finding is CONDITION_SATISFIED
 * rather than a scope exit. A scope exit is never reported as the
 * condition having cleared.
 */
export function detectScopeExit(rule: ScopeExitRuleRef, scope: ScopeObservation): ScopeExitKind | null {
  const closeLeaves = rule.transactionCloseScope !== "STAYS";
  if (scope.transactionId != null && closeLeaves && (!scope.transactionPresent || scope.closedAt != null)) {
    return "TRANSACTION_CLOSED";
  }
  if (rule.stageRange && rule.stageRange.length > 0) {
    if (!scope.propertyPresent || scope.workflowStage == null || !rule.stageRange.includes(scope.workflowStage)) {
      return "STAGE_EXIT";
    }
  }
  return null;
}

import { APPRAISAL_AGREEMENT_RULES } from "./rules/appraisalAgreement.js";
import { LISTING_RULES } from "./rules/listing.js";
import { OFFERS_RULES } from "./rules/offers.js";
import { CONTRACT_CONDITIONS_RULES } from "./rules/contractConditions.js";
import { AML_CTF_RULES } from "./rules/amlCtf.js";
import { SETTLEMENT_CLOSURE_RULES } from "./rules/settlementClosure.js";
import { WORKFLOW_OPERATIONAL_RULES } from "./rules/workflowOperational.js";
// Agent Engine 2.0 — Property Launch & Campaign Coordination. Reuses this
// registry outright (13 LAUNCH_CAMPAIGN rules) rather than building a
// separate Launch warning system — see rules/launchCampaign.ts's own
// module comment.
import { LAUNCH_CAMPAIGN_RULES } from "./rules/launchCampaign.js";
// Agent Engine 2.0 — Communications Hub (Priority 8). Delivery failures and
// blocked sends (consent/cost) surface through this same registry, under
// their own COMMUNICATION category — see rules/communicationDelivery.ts's
// own module comment.
import { COMMUNICATION_DELIVERY_RULES } from "./rules/communicationDelivery.js";
// Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F,
// Section 22). Commission-agreement/PC-fee-payment/marketing-invoice/
// dispute findings surface through this same registry, under their own
// FINANCIAL category — see rules/financial.js's own module comment.
import { FINANCIAL_RULES } from "./rules/financial.js";
// AE Step 5 remediation — Proof D (Workflow and Risk). Dead-lettered
// integration commands (any capability/provider — generic across Proof
// A/B/C's mock adapters) surface through this same registry, under the
// existing WORKFLOW_OPERATIONAL category — see rules/integrationOperational.js's
// own module comment.
import { INTEGRATION_OPERATIONAL_RULES } from "./rules/integrationOperational.js";

export const RISK_RULES: RiskRule[] = [
  ...APPRAISAL_AGREEMENT_RULES,
  ...LISTING_RULES,
  ...OFFERS_RULES,
  ...CONTRACT_CONDITIONS_RULES,
  ...AML_CTF_RULES,
  ...SETTLEMENT_CLOSURE_RULES,
  ...WORKFLOW_OPERATIONAL_RULES,
  ...LAUNCH_CAMPAIGN_RULES,
  ...COMMUNICATION_DELIVERY_RULES,
  ...FINANCIAL_RULES,
  ...INTEGRATION_OPERATIONAL_RULES,
];

// Fail loudly at import time on a duplicate ruleId — a copy-paste error in
// a new rule module must never silently shadow an existing rule.
const seen = new Set<string>();
for (const rule of RISK_RULES) {
  if (seen.has(rule.ruleId)) {
    throw new Error(`Duplicate risk rule id registered: ${rule.ruleId}`);
  }
  seen.add(rule.ruleId);
}

// Startup-failing pin: FINANCIAL, AML/CTF, compliance, security, and
// F32–F34 cannot be resolved merely because a transaction closed or a
// property left the rule's stage range.
assertPinnedScopeExitPolicies(RISK_RULES);

export function getRuleById(ruleId: string): RiskRule | undefined {
  return RISK_RULES.find((r) => r.ruleId === ruleId);
}

const rulesByEventType = new Map<AgentEngineEasyEventType, RiskRule[]>();
for (const rule of RISK_RULES) {
  for (const eventType of rule.triggerEventTypes) {
    const existing = rulesByEventType.get(eventType) ?? [];
    existing.push(rule);
    rulesByEventType.set(eventType, existing);
  }
}

export function getRulesForEventType(eventType: AgentEngineEasyEventType): RiskRule[] {
  return rulesByEventType.get(eventType) ?? [];
}
