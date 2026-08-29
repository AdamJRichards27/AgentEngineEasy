// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Shared status vocabularies and lightweight types for the automation
// engine, mirroring the enum-in-comment conventions already established on
// packages/db/src/schema/automation.ts (all five tables store these as
// plain `text` columns — no DB-level enum constraint — matching every
// other status column in this codebase, e.g. automationRules.status,
// aiActionRequests.status).
//
// Keeping these as named exports (rather than repeating string literals
// across engine.ts/rules.ts/__tests__) mirrors the existing
// AUTHORITY_LEVELS / USER_ROLES pattern (authority.ts, users.ts).

export const AUTOMATION_RULE_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"] as const;
export type AutomationRuleStatus = (typeof AUTOMATION_RULE_STATUSES)[number];

export const AUTOMATION_RULE_VERSION_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "APPROVED",
  "ACTIVE",
  "SUPERSEDED",
  "ARCHIVED",
] as const;
export type AutomationRuleVersionStatus = (typeof AUTOMATION_RULE_VERSION_STATUSES)[number];

// The spec's 10 execution states, verbatim (Build Instructions §"Execution
// status and failure recording").
export const AUTOMATION_EXECUTION_STATUSES = [
  "PENDING",
  "EVALUATING",
  "SKIPPED",
  "AWAITING_APPROVAL",
  "RUNNING",
  "PARTIALLY_COMPLETED",
  "COMPLETED",
  "FAILED",
  "BLOCKED",
  "CANCELLED",
] as const;
export type AutomationExecutionStatus = (typeof AUTOMATION_EXECUTION_STATUSES)[number];

// The spec's 10 action states, verbatim. COMPENSATED is reserved for a
// future compensation/rollback capability — nothing in this foundation
// stage ever sets it (no saga/compensation logic is implemented here; see
// the WF2 report's "deferred" section).
export const AUTOMATION_ACTION_STATUSES = [
  "PENDING",
  "SKIPPED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "COMPENSATED",
] as const;
export type AutomationActionStatus = (typeof AUTOMATION_ACTION_STATUSES)[number];

// Simplified authority-decision vocabulary recorded on automationActions,
// per automation.ts's own column comment. Produced by mapping the existing,
// reused policyEngine.PolicyDecision onto this closed set — this module
// never invents its own authority semantics (see engine.ts's
// mapDecisionToAuthorityDecision).
export const AUTOMATION_AUTHORITY_DECISIONS = [
  "ALLOW",
  "ALLOW_WITH_APPROVAL",
  "DENY",
  "BLOCK_MISSING_CONTEXT",
  "BLOCK_MISSING_ENTITLEMENT",
  "BLOCK_POLICY_CONFLICT",
] as const;
export type AutomationAuthorityDecision = (typeof AUTOMATION_AUTHORITY_DECISIONS)[number];

export const EVENT_PROCESSING_RECEIPT_STATUSES = ["PENDING", "PROCESSING", "PROCESSED", "FAILED", "DEAD_LETTER"] as const;
export type EventProcessingReceiptStatus = (typeof EVENT_PROCESSING_RECEIPT_STATUSES)[number];

// Handler name this engine claims event_processing_receipts rows under.
// Stable and unique across the codebase — see packages/db/src/schema/automation.ts's
// eventProcessingReceipts comment ("e.g. 'automation-engine'").
export const AUTOMATION_ENGINE_HANDLER_NAME = "automation-engine";
