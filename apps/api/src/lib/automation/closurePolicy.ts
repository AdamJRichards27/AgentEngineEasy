// R-F42 — run-closure classification. A code map keyed by the existing
// AUTOMATION_TASK_KEYS vocabulary. There is no second task engine and no
// stored policy: task rows are not rewritten when this map changes.
//
// OF_Y tasks must be finished before final close. OF_N and OPTIONAL do not
// block close. autoCompleteOn names the milestone (a domain event type, or
// the transaction_legal_representatives_updated audit action) that may
// complete the task once live evidence is re-read.

import { AUTOMATION_TASK_KEYS, type AutomationTaskKey } from "./types.js";

export const CLOSURE_CLASSES = ["OF_Y", "OF_N", "OPTIONAL"] as const;
export type ClosureClass = (typeof CLOSURE_CLASSES)[number];

export interface AutomationTaskClosurePolicy {
  class: ClosureClass;
  autoCompleteOn?: readonly string[];
}

export const AUTOMATION_TASK_CLOSURE_POLICY: Record<AutomationTaskKey, AutomationTaskClosurePolicy> = {
  CONFIRM_AML_CTF_REQUIREMENTS: { class: "OF_N", autoCompleteOn: ["AML_COMPLETED"] },
  VERIFY_REGISTERED_PROPERTY_OWNERS: { class: "OF_N", autoCompleteOn: ["LISTING_LIVE"] },
  PREPARE_LISTING_LAUNCH_REQUIREMENTS: { class: "OF_N", autoCompleteOn: ["LISTING_LIVE"] },
  REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO: { class: "OPTIONAL", autoCompleteOn: ["LISTING_LIVE"] },

  PREPARE_CONTRACT_DOCUMENTATION: { class: "OF_N", autoCompleteOn: ["CONTRACT_SIGNED"] },
  CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES: {
    class: "OF_Y",
    autoCompleteOn: ["transaction_legal_representatives_updated"],
  },
  RECORD_TRANSACTION_DATES_CONDITIONS: { class: "OF_N", autoCompleteOn: ["SETTLEMENT_SCHEDULED"] },
  FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS: { class: "OF_N", autoCompleteOn: ["TRANSACTION_UNCONDITIONAL"] },
  IDENTIFY_MISSING_TRANSACTION_INFO: { class: "OF_N", autoCompleteOn: ["SETTLEMENT_COMPLETED"] },

  CONFIRM_CONTRACT_EXCHANGE_STATUS: { class: "OF_N", autoCompleteOn: ["CONTRACT_EXCHANGED"] },
  CAPTURE_CONTRACT_CONDITION_DATES: { class: "OF_N", autoCompleteOn: ["TRANSACTION_UNCONDITIONAL"] },
  CONDITION_DEADLINE_FOLLOWUP: { class: "OF_N", autoCompleteOn: ["TRANSACTION_UNCONDITIONAL"] },
  IDENTIFY_MISSING_LEGAL_REPRESENTATIVES: {
    class: "OF_Y",
    autoCompleteOn: ["transaction_legal_representatives_updated"],
  },
  PREPARE_SETTLEMENT_TRACKING: { class: "OF_N", autoCompleteOn: ["SETTLEMENT_SCHEDULED"] },

  CONFIRM_SETTLEMENT_DATE_TIME: { class: "OF_N", autoCompleteOn: ["SETTLEMENT_COMPLETED"] },
  PRE_SETTLEMENT_MILESTONE_REMINDER: { class: "OPTIONAL", autoCompleteOn: ["SETTLEMENT_COMPLETED"] },
  IDENTIFY_UNRESOLVED_TRANSACTION_CONDITIONS: {
    class: "OF_N",
    autoCompleteOn: ["TRANSACTION_UNCONDITIONAL", "SETTLEMENT_COMPLETED"],
  },
  PREPARE_INTERNAL_SETTLEMENT_TASKS: { class: "OF_N", autoCompleteOn: ["SETTLEMENT_COMPLETED"] },

  CONFIRM_TRANSACTION_RECORD_COMPLETE: { class: "OF_Y" },
  PREPARE_COMMISSION_PROCESSING_CHECKLIST: {
    class: "OF_Y",
    autoCompleteOn: ["AGENT_PAID", "FUNDS_RECEIVED", "COMMISSION_CALCULATED"],
  },
  RECORD_RETENTION_CLOSURE_CHECK: { class: "OF_Y" },
  PREPARE_PERMITTED_CLIENT_FOLLOWUP: { class: "OPTIONAL" },
  PREPARE_PROPERTY_TRANSACTION_CLOSURE: { class: "OF_N", autoCompleteOn: ["TRANSACTION_CLOSED"] },
};

export const MUST_COMPLETE_BEFORE_CLOSE_TASK_KEYS: readonly AutomationTaskKey[] = AUTOMATION_TASK_KEYS.filter(
  (key) => AUTOMATION_TASK_CLOSURE_POLICY[key].class === "OF_Y",
);

/** S1 and S3 stay manual attestations. Nothing may auto-complete them. */
export const NEVER_AUTO_COMPLETE_TASK_KEYS = [
  "CONFIRM_TRANSACTION_RECORD_COMPLETE",
  "RECORD_RETENTION_CLOSURE_CHECK",
] as const satisfies readonly AutomationTaskKey[];

export const COMMISSION_CHECKLIST_TASK_KEY = "PREPARE_COMMISSION_PROCESSING_CHECKLIST" as const;

/** System actor for milestone auto-completion. userId stays null. */
export const RUN_CLOSURE_AUTO_COMPLETE_ACTOR_EMAIL = "ops:run-closure-auto-complete";

export const MANUAL_COMMISSION_PAYMENT_METHODS = ["TRUST_ACCOUNT", "EFT", "CHEQUE", "BPAY", "OTHER"] as const;
export type ManualCommissionPaymentMethod = (typeof MANUAL_COMMISSION_PAYMENT_METHODS)[number];

export function isAutomationTaskKey(value: string): value is AutomationTaskKey {
  return (AUTOMATION_TASK_KEYS as readonly string[]).includes(value);
}

export function taskKeysForMilestone(eventType: string): AutomationTaskKey[] {
  const never = new Set<string>(NEVER_AUTO_COMPLETE_TASK_KEYS);
  return AUTOMATION_TASK_KEYS.filter((key) => {
    if (never.has(key)) return false;
    const on = AUTOMATION_TASK_CLOSURE_POLICY[key].autoCompleteOn;
    return on?.includes(eventType) ?? false;
  });
}
