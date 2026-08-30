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

// ---------------------------------------------------------------------
// Agent Engine 2.0 — WAE Stage 2: Controlled Production Workflows.
// ---------------------------------------------------------------------

export const AUTOMATION_TASK_KINDS = ["TASK", "REMINDER"] as const;
export type AutomationTaskKind = (typeof AUTOMATION_TASK_KINDS)[number];

export const AUTOMATION_TASK_STATUSES = ["ACTIVE", "COMPLETED", "SUPERSEDED", "CANCELLED"] as const;
export type AutomationTaskStatus = (typeof AUTOMATION_TASK_STATUSES)[number];

export const AUTOMATION_ATTENTION_ITEM_STATUSES = ["OPEN", "RESOLVED"] as const;
export type AutomationAttentionItemStatus = (typeof AUTOMATION_ATTENTION_ITEM_STATUSES)[number];

// Closed vocabulary of task keys the Stage 2 workflow catalogue
// (templates.ts) is permitted to create. Never a free-form string a rule
// author could invent — CREATE_INTERNAL_TASK/CREATE_REMINDER's zod
// inputSchema (apps/api/src/lib/ai/actions/registry.ts) validates against
// exactly this list, and rules.ts's assertActionsAreRegistered/
// createRuleVersion never accept action params outside a registered
// action's own schema.
export const AUTOMATION_TASK_KEYS = [
  // Workflow 1 — Agency Agreement Signed
  "CONFIRM_AML_CTF_REQUIREMENTS",
  "VERIFY_REGISTERED_PROPERTY_OWNERS",
  "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
  "REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO",
  // Workflow 2 — Offer Accepted
  "PREPARE_CONTRACT_DOCUMENTATION",
  "CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES",
  "RECORD_TRANSACTION_DATES_CONDITIONS",
  "FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS",
  "IDENTIFY_MISSING_TRANSACTION_INFO",
  // Workflow 3 — Contract Signed
  "CONFIRM_CONTRACT_EXCHANGE_STATUS",
  "CAPTURE_CONTRACT_CONDITION_DATES",
  "CONDITION_DEADLINE_FOLLOWUP",
  "IDENTIFY_MISSING_LEGAL_REPRESENTATIVES",
  "PREPARE_SETTLEMENT_TRACKING",
  // Workflow 4 — Settlement Scheduled
  "CONFIRM_SETTLEMENT_DATE_TIME",
  "PRE_SETTLEMENT_MILESTONE_REMINDER",
  "IDENTIFY_UNRESOLVED_TRANSACTION_CONDITIONS",
  "PREPARE_INTERNAL_SETTLEMENT_TASKS",
  // Workflow 5 — Settlement Completed
  "CONFIRM_TRANSACTION_RECORD_COMPLETE",
  "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
  "RECORD_RETENTION_CLOSURE_CHECK",
  "PREPARE_PERMITTED_CLIENT_FOLLOWUP",
  "PREPARE_PROPERTY_TRANSACTION_CLOSURE",
] as const;
export type AutomationTaskKey = (typeof AUTOMATION_TASK_KEYS)[number];

// Closed vocabulary of attention-item reason codes — the minimal, compatible
// interface onto the future Exception & Risk Engine (Build Instructions §7:
// "use the smallest compatible interface and document the future
// integration point" — see docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md §7).
export const AUTOMATION_ATTENTION_REASON_CODES = [
  "MISSING_SETTLEMENT_DATE",
  "INCOMPLETE_TRIGGERING_EVENT",
  "MISSING_REGISTERED_OWNER",
  "MISSING_LEGAL_REPRESENTATIVE",
  "CONDITION_WITHOUT_DUE_DATE",
  "OTHER",
] as const;
export type AutomationAttentionReasonCode = (typeof AUTOMATION_ATTENTION_REASON_CODES)[number];

// Closed vocabulary of "protected future action" labels REQUEST_ACTION_APPROVAL
// may reference — descriptive only, never a registered, executable actionKey.
// Stage 2 explicitly does not execute any of these; see Build Instructions
// §"Out of scope" — AML verification orders, listing publication, supplier
// orders, and any action that would incur cost all stay strictly manual.
export const PROTECTED_FUTURE_ACTION_KEYS = [
  "ORDER_AML_VERIFICATION",
  "PUBLISH_LISTING",
  "ENGAGE_SUPPLIER",
  "INCUR_COST",
  "SEND_BINDING_INSTRUCTION",
  "ALTER_CONTRACT",
  "OTHER_PROTECTED_ACTION",
] as const;
export type ProtectedFutureActionKey = (typeof PROTECTED_FUTURE_ACTION_KEYS)[number];
