// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// Shared types for the rule registry and engine, mirroring the
// enum-in-comment / named-export convention already established by
// apps/api/src/lib/automation/types.ts.

import type {
  RiskExceptionCategory,
  RiskExceptionOwnerType,
  RiskExceptionSeverity,
} from "@aee/db";

export {
  RISK_EXCEPTION_SEVERITIES,
  RISK_EXCEPTION_STATUSES,
  OPEN_RISK_EXCEPTION_STATUSES,
  RISK_EXCEPTION_CATEGORIES,
  RISK_EXCEPTION_OWNER_TYPES,
} from "@aee/db";
export type {
  RiskExceptionSeverity,
  RiskExceptionStatus,
  RiskExceptionCategory,
  RiskExceptionOwnerType,
  RiskException,
  RiskExceptionTransition,
} from "@aee/db";

// Allow-listed metadata keys only (Build Instructions §5). Every rule's
// finding.metadata is stripped to this set before it is ever written to
// risk_exceptions.metadata — see model.ts's sanitizeMetadata(). Additive:
// a new rule that needs a new safe key adds it here, in review, rather
// than writing an unreviewed key straight through.
export const RISK_EXCEPTION_METADATA_ALLOW_LIST = [
  "conditionId",
  "conditionDescription",
  "amlVerificationId",
  "amlStatus",
  "offerId",
  "documentPackageId",
  "documentId",
  "signatureRequestId",
  "automationExecutionId",
  "automationActionId",
  "automationTaskId",
  "settlementDate",
  "dueDate",
  "daysOverdue",
  "daysUntilDue",
  "partyRole",
  "missingFields",
  // Agent Engine 2.0 — Communications Hub (Priority 8). Delivery-failure
  // and blocked-send findings (rules/communicationDelivery.ts) need to
  // name which message/channel/failure they're about.
  "communicationMessageId",
  "communicationChannel",
  "communicationFailureCategory",
  // Agent Engine 2.0 — Financial Transaction Engine (Priority 9, Stage F,
  // Section 22). Commission-agreement/PC-fee-payment/marketing-invoice/
  // dispute findings (rules/financial.ts) need to name which financial
  // record they're about. No dollar figures are added here — a
  // FinancialControlError-worthy amount already lives on the underlying
  // financial record itself (readable via its sourceRecordType/
  // sourceRecordId, same as every other category) — these are IDs only,
  // same posture as offerId/documentId/etc above.
  "commissionAgreementId",
  "pcFeeAuthorityId",
  "paymentRequestId",
  "marketingPaymentRecordId",
  "campaignItemId",
  "financialDisputeId",
  // AE Step 5 remediation — Proof D (Workflow and Risk). A dead-lettered
  // integration command finding (rules/integrationOperational.ts) needs to
  // name which outbox command/connection/capability/source-record it's
  // about — IDs only, same posture as every other key above.
  "integrationOutboxId",
  "integrationConnectionId",
  "integrationCapability",
  "integrationSourceRecordType",
  "integrationSourceRecordId",
  // AE Step 5 remediation — Proof C (Financial Transaction Engine). A
  // reconciliation-variance finding (rules/financial.ts's FIN05) needs to
  // name which financial_reconciliations evidence row it's about.
  "financialReconciliationId",
] as const;
export type RiskExceptionMetadataKey = (typeof RISK_EXCEPTION_METADATA_ALLOW_LIST)[number];

// How a resolved/dismissed exception's condition recurring is handled
// (Build Instructions §7, §11, §14). Every rule declares exactly one.
export const RECURRENCE_MODES = ["REOPEN", "NEW_OCCURRENCE"] as const;
export type RecurrenceMode = (typeof RECURRENCE_MODES)[number];

export type ResolutionEvidence =
  | { kind: "FIELD_NOW_PRESENT"; field: string; value: string }
  | { kind: "TASK_COMPLETED"; taskId: string }
  | { kind: "CONDITION_RESOLVED"; conditionId: number; resolution: string }
  | { kind: "AML_COMPLETED"; amlVerificationId: number }
  | { kind: "SETTLEMENT_RECORDED"; settlementDate: string }
  | { kind: "WORKFLOW_SUCCEEDED"; automationExecutionId: string }
  | { kind: "APPROVAL_DECIDED"; automationActionId: string; decision: string }
  | { kind: "MANUAL"; note: string; recordedByUserId: number }
  // The engine's own scheduled/event-driven re-evaluation: this rule's
  // scanBrokerage ran successfully this pass and no longer found this
  // dedup key among its current findings. This is only ever recorded when
  // the evaluation itself SUCCEEDED (engine.ts never auto-resolves on a
  // failed evaluation — absence of evidence from a failure is never proof
  // of completion, Build Instructions §3), so a clean pass finding nothing
  // is itself authoritative: the rule re-derived the current truth from
  // live domain state and it no longer matches.
  | { kind: "RULE_CONDITION_CLEARED"; ruleId: string; ruleVersion: number };

// What one rule evaluation pass found for one source record. The engine
// (engine.ts) turns this into a risk_exceptions row via model.ts's
// createOrUpdateException — a rule never writes to the database directly.
export interface RiskFinding {
  ruleId: string;
  ruleVersion: number;
  category: RiskExceptionCategory;
  severity: RiskExceptionSeverity;
  title: string;
  problemDescription: string;
  businessImpact: string;
  detectedCause: string;
  ownerType: RiskExceptionOwnerType;
  ownerUserId: number | null;
  // The property (always) and transaction (where the condition is
  // transaction-scoped) this finding belongs to — every rule already has
  // both in scope wherever it constructs a finding, so this is reported
  // directly rather than re-derived by the engine from sourceRecordType/
  // sourceRecordId (which are for traceability display, not for driving
  // riskExceptions.propertyId/transactionId).
  propertyId: number;
  transactionId: number | null;
  dueAt: Date | null;
  escalatesAt: Date | null;
  recommendedAction: string;
  resolutionRequirements: string;
  dismissible: boolean;
  sourceRecordType: string;
  sourceRecordId: string;
  dedupKey: string;
  recurrenceMode: RecurrenceMode;
  requiresFinancialEntitlement: boolean;
  metadata?: Partial<Record<RiskExceptionMetadataKey, string | number>>;
}

export interface RuleEvalTarget {
  brokerageId: number;
  propertyId: number;
  transactionId: number | null;
  correlationId: string;
  causationId: string | null;
}

// A resolver a rule can call to check whether its own previously-open
// finding's condition has since cleared, for auto-resolution during a
// rescan. Returns null when the condition still holds (exception stays
// open); returns evidence when it has cleared (engine auto-resolves).
export type AutoResolveCheck = (target: RuleEvalTarget, exception: import("@aee/db").RiskException) => Promise<ResolutionEvidence | null>;
