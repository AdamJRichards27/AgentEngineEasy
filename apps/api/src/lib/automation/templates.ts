// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Initial vertical slice: "Trigger AGENCY_AGREEMENT_SIGNED -> create the
// next approved internal task or workflow action through the controlled
// action registry." This is deliberately the ONLY system template shipped
// in this foundation stage — Build Instructions explicitly rule out
// "the complete workflow catalogue" here; docs/stage-wf/WF1_DISCOVERY.md's
// own Stage 6 note lists four future templates (Agency Agreement Signed,
// Offer Accepted, Settlement Completed, Task Overdue) and this stage
// builds exactly one of them, end to end, as proof the foundation works.
//
// The action is PROPERTY_NOTE_ADD — an existing, already-tested action
// (apps/api/src/lib/ai/actions/registry.ts, backed by
// apps/api/src/lib/propertyNotes.ts) — reused rather than duplicated. It
// is purely additive/reversible and sends no email, SMS, financial
// instruction, or third-party request, satisfying the vertical slice's
// explicit constraint. The one change this PR makes to that action is
// adding "SYSTEM" to its allowedActorTypes (registry.ts) so an
// automation-originated proposeAIAction() call is accepted at all — the
// action's own execute()/schema/risk profile are untouched.
//
// No HTTP route installs this template automatically; a brokerage's
// Brokerage Administrator installs and activates it explicitly by calling
// installAgencyAgreementSignedTemplate() and then
// approveAndActivateRuleVersion() (rules.ts) — a rule-management UI is
// explicitly out of scope for this stage (see the WF2 report).
//
// NOTE ON PRODUCTION WIRING: repository search confirmed no code path
// currently calls publishDomainEvent({eventType: "AGENCY_AGREEMENT_SIGNED", ...})
// anywhere in this codebase — the event exists in the canonical catalogue
// (packages/events/src/types.ts) but nothing yet publishes it from the
// real agency-agreement/e-sign completion flow. Wiring that publish call
// belongs to the document/e-sign integration module, not this foundation
// PR (out of scope: "large refactors unrelated to the foundation"), and is
// recorded as a deferred item in the WF2 report. This engine is fully
// functional and fully tested against a directly published
// AGENCY_AGREEMENT_SIGNED event in the interim. Still true as of Stage 2 —
// see docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md's deferred-items list.

import type { AutomationRule, AutomationRuleVersion } from "@aee/db";
import {
  createAutomationRule,
  createRuleVersion,
  getAutomationRuleByTemplateKey,
  type AutomationRuleAction,
} from "./rules.js";
import type { AutomationConditionGroup } from "./conditions.js";

export const AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY = "AGENCY_AGREEMENT_SIGNED";

// "ALL" over a single "propertyId exists" condition: every canonical
// AGENCY_AGREEMENT_SIGNED event is expected to carry a propertyId, but the
// condition is still evaluated (rather than assumed) so a malformed event
// produces a clean SKIPPED execution instead of a downstream action-input
// validation failure.
export const AGENCY_AGREEMENT_SIGNED_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [{ field: "propertyId", operator: "exists" }],
};

export const AGENCY_AGREEMENT_SIGNED_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "PROPERTY_NOTE_ADD",
    params: {
      propertyId: "$event.propertyId",
      note:
        "Agency agreement signed. Automation created this note as the next approved internal step — " +
        "review the file and progress it to listing preparation.",
    },
  },
];

export async function installAgencyAgreementSignedTemplate(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{ rule: AutomationRule; version: AutomationRuleVersion }> {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Agency agreement signed — create next task",
    description:
      "WHEN an agency agreement is fully signed, create an internal property note recording the next step, " +
      "through the controlled AI Action Registry.",
    triggerEventType: AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY,
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY,
  });

  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: AGENCY_AGREEMENT_SIGNED_CONDITION_GROUP,
    actions: AGENCY_AGREEMENT_SIGNED_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation.",
  });

  return { rule, version };
}

// =======================================================================
// Agent Engine 2.0 — WAE Stage 2: Controlled Production Workflows.
//
// Five workflow templates covering the five priority triggers (Build
// Instructions §3), each composed only of the six Stage 2-permitted,
// registered actions (PROPERTY_NOTE_ADD, CREATE_INTERNAL_TASK,
// CREATE_REMINDER, ASSIGN_TASK_OWNER, RAISE_ATTENTION_ITEM,
// REQUEST_ACTION_APPROVAL — see apps/api/src/lib/ai/actions/registry.ts),
// deterministic seed data (no free-form config — every action's params
// resolve either to a static, hand-authored string or to a "$event.<path>"
// placeholder templated against the triggering event's own facts).
//
// Design note on "identify/confirm missing X information" (Build
// Instructions §3's Workflows 1-3 outcomes): the automation engine's
// conditions (conditions.ts/facts.ts) only ever evaluate fields carried on
// the triggering DOMAIN EVENT — by deliberate Stage 1 design, extending
// facts.ts to perform live database joins (e.g. "does this transaction
// currently have a legalRepresentatives value set?") was judged out of
// scope (see the Foundation stage's own facts.ts module comment). Rather
// than fabricate a live-lookup capability the engine does not have, each
// "confirm/identify missing X" outcome below is implemented as the
// deterministic creation of the task that PROMPTS a human to make that
// determination — the same "AI/automation prepares, a human confirms"
// boundary Build Instructions §10 draws by excluding "autonomous AI
// workflow creation" from this stage. Where the triggering event ITSELF
// can plausibly be missing a required field (Workflow 4's settlementDate),
// that IS a fact available to conditions.ts, and is handled with a genuine
// second, inverse-condition fail-safe rule below (RAISE_ATTENTION_ITEM),
// not a task.
//
// Design note on condition/date fields not yet on the domain event payload
// (Workflow 3's "finance/building-pest/cooling-off/other condition dates"):
// apps/api/src/lib/transactions.ts's recordContractSigned() currently
// publishes CONTRACT_SIGNED with an empty payload — the transactions schema
// has no structured per-condition date columns yet (offers.conditions is a
// free-form jsonb captured at OFFER stage, not carried onto the transaction
// or the CONTRACT_SIGNED event). Rather than invent a payload shape nothing
// publishes, Workflow 3 creates a deterministic CAPTURE_CONTRACT_CONDITION_DATES
// task prompting a human to capture/confirm those dates — the same honest
// "documented gap, not a fabricated capability" precedent the WAE
// Foundation stage set for AGENCY_AGREEMENT_SIGNED's zero production
// publishers. See docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md §9 for
// the full deferred-items list this implies for a future stage (structured
// condition-date columns + a real deadline-scheduler dependency, Build
// Instructions §6's "document the deferred scheduler dependency").
// =======================================================================

function eventFieldExists(field: string): AutomationConditionGroup["conditions"][number] {
  return { field, operator: "exists" };
}

// ---------------------------------------------------------------------
// Workflow 1 — Agency Agreement Signed (v2 on the existing Stage 1 rule).
//
// Added as a NEW VERSION on the SAME rule Stage 1 already installs
// (createRuleVersion, not a second rule) — Build Instructions §1: "Do not
// repeat the completed foundation work." v1's single PROPERTY_NOTE_ADD note
// stays intact as history; v2 supersedes it with the full Stage 2 task set.
// Do NOT automatically order AML verification, publish a listing, engage
// suppliers, or incur costs (§3) — every action below only ever creates an
// internal task prompting a human to do those things.
// ---------------------------------------------------------------------

export const AGENCY_AGREEMENT_SIGNED_STAGE2_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      taskKey: "CONFIRM_AML_CTF_REQUIREMENTS",
      title: "Confirm AML/CTF requirements for all registered sellers",
      detail:
        "Agency agreement signed. Confirm what AML/CTF verification is required before listing — this task does not " +
        "order verification automatically; a human must review and initiate it through the existing AML workflow.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      taskKey: "VERIFY_REGISTERED_PROPERTY_OWNERS",
      title: "Verify all registered property owners are recorded",
      detail: "Confirm every registered owner on title is captured as a Seller party on this property before proceeding.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      taskKey: "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
      title: "Prepare listing-launch requirements",
      detail:
        "Assemble what is needed to take this property live (photography, copy, disclosures) — this task does not " +
        "publish the listing automatically.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      taskKey: "REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO",
      title: "Request any missing property or campaign information",
      detail: "Review the file for missing property details or campaign preferences needed before listing preparation continues.",
      originatingEventId: "$event.eventId",
    },
  },
];

export async function installAgencyAgreementSignedStage2Version(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{ rule: AutomationRule; version: AutomationRuleVersion }> {
  let rule = await getAutomationRuleByTemplateKey(input.brokerageId, AGENCY_AGREEMENT_SIGNED_TEMPLATE_KEY);
  if (!rule) {
    const installed = await installAgencyAgreementSignedTemplate(input);
    rule = installed.rule;
  }

  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: AGENCY_AGREEMENT_SIGNED_CONDITION_GROUP,
    actions: AGENCY_AGREEMENT_SIGNED_STAGE2_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "WAE Stage 2 — Controlled Production Workflows: full Workflow 1 task catalogue.",
  });

  return { rule, version };
}

// ---------------------------------------------------------------------
// Workflow 2 — Offer Accepted.
// Do NOT send binding instructions, alter contracts, or initiate financial
// activity (§3) — every action below only creates internal tasks.
// ---------------------------------------------------------------------

export const OFFER_ACCEPTED_TEMPLATE_KEY = "OFFER_ACCEPTED";

export const OFFER_ACCEPTED_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [eventFieldExists("propertyId"), eventFieldExists("transactionId")],
};

export const OFFER_ACCEPTED_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_CONTRACT_DOCUMENTATION",
      title: "Prepare/confirm contract documentation",
      detail: "Offer accepted. Assemble and confirm the contract documentation required to proceed to exchange.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES",
      title: "Confirm buyer and seller legal representatives",
      detail: "Confirm the solicitor/conveyancer acting for each side is captured on the transaction record.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "RECORD_TRANSACTION_DATES_CONDITIONS",
      title: "Record required transaction dates and conditions",
      detail: "Capture the contract, cooling-off, finance, and any other condition dates and terms for this transaction.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS",
      title: "Follow up on exchange / unconditional status",
      detail: "Create a follow-up checkpoint to confirm this transaction reaches exchange and, later, unconditional status.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "IDENTIFY_MISSING_TRANSACTION_INFO",
      title: "Identify any missing transaction information",
      detail: "Review the transaction record for missing information (price terms, deposit, special conditions) before proceeding.",
      originatingEventId: "$event.eventId",
    },
  },
];

export async function installOfferAcceptedTemplate(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{ rule: AutomationRule; version: AutomationRuleVersion }> {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Offer accepted — create transaction-progression tasks",
    description: "WHEN an offer is accepted, create the approved set of internal transaction-progression tasks.",
    triggerEventType: OFFER_ACCEPTED_TEMPLATE_KEY,
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: OFFER_ACCEPTED_TEMPLATE_KEY,
  });
  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: OFFER_ACCEPTED_CONDITION_GROUP,
    actions: OFFER_ACCEPTED_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation (WAE Stage 2).",
  });
  return { rule, version };
}

// ---------------------------------------------------------------------
// Workflow 3 — Contract Signed.
// ---------------------------------------------------------------------

export const CONTRACT_SIGNED_TEMPLATE_KEY = "CONTRACT_SIGNED";

export const CONTRACT_SIGNED_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [eventFieldExists("propertyId"), eventFieldExists("transactionId")],
};

export const CONTRACT_SIGNED_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CONFIRM_CONTRACT_EXCHANGE_STATUS",
      title: "Confirm contract exchange status",
      detail: "Contract signed. Confirm whether contracts have formally exchanged between both parties.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CAPTURE_CONTRACT_CONDITION_DATES",
      title: "Capture finance / building-pest / cooling-off / other condition dates",
      detail:
        "The triggering event does not yet carry structured condition dates (deferred — see " +
        "docs/stage-wf/WF3_STAGE2_CONTROLLED_WORKFLOWS.md). Capture and confirm each applicable condition date manually.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CONDITION_DEADLINE_FOLLOWUP",
      title: "Create deadline-based follow-up tasks for contract conditions",
      detail: "Once condition dates are captured, create the deadline-based follow-ups needed to track each one to resolution.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "IDENTIFY_MISSING_LEGAL_REPRESENTATIVES",
      title: "Identify any missing legal-representative information",
      detail: "Confirm both sides' legal representatives are on file; flag and follow up on anything missing.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_SETTLEMENT_TRACKING",
      title: "Prepare the transaction for settlement tracking",
      detail: "Set up the internal checklist needed to track this transaction through to settlement.",
      originatingEventId: "$event.eventId",
    },
  },
];

export async function installContractSignedTemplate(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{ rule: AutomationRule; version: AutomationRuleVersion }> {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Contract signed — prepare settlement tracking",
    description: "WHEN a contract is signed, confirm exchange status, capture condition dates, and prepare settlement tracking.",
    triggerEventType: CONTRACT_SIGNED_TEMPLATE_KEY,
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: CONTRACT_SIGNED_TEMPLATE_KEY,
  });
  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: CONTRACT_SIGNED_CONDITION_GROUP,
    actions: CONTRACT_SIGNED_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation (WAE Stage 2).",
  });
  return { rule, version };
}

// ---------------------------------------------------------------------
// Workflow 4 — Settlement Scheduled. Split into two rules under the same
// trigger (Build Instructions §4/§7 — "safe when event information is
// incomplete"; §3's own "flag missing information that could prevent
// settlement" outcome): a normal preparation path when settlementDate is
// present, and a genuinely-conditional fail-safe when it is not. This is
// the one workflow where a required field's absence is a fact the engine
// CAN evaluate directly from the triggering event (unlike the live-DB-state
// "missing X" cases documented at the top of this file), so it gets a real
// RAISE_ATTENTION_ITEM fail-safe rather than a prompting task.
// ---------------------------------------------------------------------

export const SETTLEMENT_SCHEDULED_PREPARE_TEMPLATE_KEY = "SETTLEMENT_SCHEDULED_PREPARE";
export const SETTLEMENT_SCHEDULED_MISSING_DATE_TEMPLATE_KEY = "SETTLEMENT_SCHEDULED_MISSING_DATE";

export const SETTLEMENT_SCHEDULED_PREPARE_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [eventFieldExists("propertyId"), eventFieldExists("transactionId"), eventFieldExists("payload.settlementDate")],
};

export const SETTLEMENT_SCHEDULED_MISSING_DATE_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [eventFieldExists("propertyId"), { field: "payload.settlementDate", operator: "notExists" }],
};

export const SETTLEMENT_SCHEDULED_PREPARE_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CONFIRM_SETTLEMENT_DATE_TIME",
      title: "Confirm settlement date and time",
      detail: "Settlement scheduled. Confirm the settlement date and time recorded here matches all parties' expectations.",
      originatingEventId: "$event.eventId",
      originatingField: "payload.settlementDate",
    },
  },
  {
    actionKey: "CREATE_REMINDER",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PRE_SETTLEMENT_MILESTONE_REMINDER",
      title: "Pre-settlement milestone reminder",
      detail:
        "Reminder tied to the scheduled settlement date. A material reschedule supersedes this reminder rather than " +
        "silently overwriting it — see automation_tasks' supersede model.",
      dueAt: "$event.payload.settlementDate",
      originatingEventId: "$event.eventId",
      originatingField: "payload.settlementDate",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "IDENTIFY_UNRESOLVED_TRANSACTION_CONDITIONS",
      title: "Identify unresolved transaction conditions",
      detail: "Review the transaction for any condition that has not yet been satisfied ahead of settlement.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_INTERNAL_SETTLEMENT_TASKS",
      title: "Prepare internal pre-settlement tasks",
      detail: "Assemble the internal checklist needed ahead of settlement (figures, keys, final inspection coordination).",
      originatingEventId: "$event.eventId",
    },
  },
];

export const SETTLEMENT_SCHEDULED_MISSING_DATE_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "RAISE_ATTENTION_ITEM",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      reasonCode: "MISSING_SETTLEMENT_DATE",
      summary: "A SETTLEMENT_SCHEDULED event was received with no settlement date — settlement preparation cannot proceed safely.",
      originatingEventId: "$event.eventId",
    },
  },
];

export async function installSettlementScheduledTemplates(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{
  prepare: { rule: AutomationRule; version: AutomationRuleVersion };
  missingDateFailsafe: { rule: AutomationRule; version: AutomationRuleVersion };
}> {
  const prepareRule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Settlement scheduled — prepare settlement",
    description: "WHEN settlement is scheduled with a valid date, confirm the date, create a milestone reminder, and prepare pre-settlement tasks.",
    triggerEventType: "SETTLEMENT_SCHEDULED",
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: SETTLEMENT_SCHEDULED_PREPARE_TEMPLATE_KEY,
  });
  const prepareVersion = await createRuleVersion({
    ruleId: prepareRule.id,
    brokerageId: input.brokerageId,
    conditionGroup: SETTLEMENT_SCHEDULED_PREPARE_CONDITION_GROUP,
    actions: SETTLEMENT_SCHEDULED_PREPARE_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation (WAE Stage 2).",
  });

  const missingDateRule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Settlement scheduled — missing settlement date fail-safe",
    description: "WHEN a SETTLEMENT_SCHEDULED event carries no settlement date, raise an attention item instead of proceeding.",
    triggerEventType: "SETTLEMENT_SCHEDULED",
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: SETTLEMENT_SCHEDULED_MISSING_DATE_TEMPLATE_KEY,
  });
  const missingDateVersion = await createRuleVersion({
    ruleId: missingDateRule.id,
    brokerageId: input.brokerageId,
    conditionGroup: SETTLEMENT_SCHEDULED_MISSING_DATE_CONDITION_GROUP,
    actions: SETTLEMENT_SCHEDULED_MISSING_DATE_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation (WAE Stage 2) — fail-safe path.",
  });

  return {
    prepare: { rule: prepareRule, version: prepareVersion },
    missingDateFailsafe: { rule: missingDateRule, version: missingDateVersion },
  };
}

// ---------------------------------------------------------------------
// Workflow 5 — Settlement Completed.
// Do NOT calculate/transfer/reconcile/release money in this phase (§3) —
// every action below only creates internal tasks; commission calculation
// remains the existing, unmodified calculateCommission() in transactions.ts.
// ---------------------------------------------------------------------

export const SETTLEMENT_COMPLETED_TEMPLATE_KEY = "SETTLEMENT_COMPLETED";

export const SETTLEMENT_COMPLETED_CONDITION_GROUP: AutomationConditionGroup = {
  operator: "ALL",
  conditions: [eventFieldExists("propertyId"), eventFieldExists("transactionId")],
};

export const SETTLEMENT_COMPLETED_ACTIONS: AutomationRuleAction[] = [
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "CONFIRM_TRANSACTION_RECORD_COMPLETE",
      title: "Confirm the transaction record is complete",
      detail: "Settlement completed. Confirm every required field on the transaction record is populated before closure.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
      title: "Prepare commission-processing checklist",
      detail:
        "Prepare (do not calculate or release) the checklist needed for commission processing — actual calculation " +
        "remains the existing calculateCommission() flow, unchanged by this workflow.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "RECORD_RETENTION_CLOSURE_CHECK",
      title: "Record-retention and closure check",
      detail: "Confirm all required records for this transaction are retained ahead of closure.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_PERMITTED_CLIENT_FOLLOWUP",
      title: "Prepare permitted client follow-up",
      detail: "Prepare the internal task for an approved, internal client follow-up — this workflow sends no external communication.",
      originatingEventId: "$event.eventId",
    },
  },
  {
    actionKey: "CREATE_INTERNAL_TASK",
    params: {
      propertyId: "$event.propertyId",
      transactionId: "$event.transactionId",
      taskKey: "PREPARE_PROPERTY_TRANSACTION_CLOSURE",
      title: "Prepare the property/transaction for closure",
      detail: "Assemble the checklist needed to move this property/transaction to Closed.",
      originatingEventId: "$event.eventId",
    },
  },
];

export async function installSettlementCompletedTemplate(input: {
  brokerageId: number;
  createdByUserId: number;
}): Promise<{ rule: AutomationRule; version: AutomationRuleVersion }> {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Settlement completed — prepare closure",
    description: "WHEN settlement completes, prepare commission-processing, retention, client follow-up, and closure tasks.",
    triggerEventType: SETTLEMENT_COMPLETED_TEMPLATE_KEY,
    createdByUserId: input.createdByUserId,
    isSystemTemplate: true,
    templateKey: SETTLEMENT_COMPLETED_TEMPLATE_KEY,
  });
  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: SETTLEMENT_COMPLETED_CONDITION_GROUP,
    actions: SETTLEMENT_COMPLETED_ACTIONS,
    createdByUserId: input.createdByUserId,
    createdByAi: false,
    changeReason: "Initial system template installation (WAE Stage 2).",
  });
  return { rule, version };
}

// ---------------------------------------------------------------------
// Convenience installer — installs (or extends) the full Stage 2 catalogue
// for one brokerage in one call. Still requires a separate, explicit
// approveAndActivateRuleVersion() per version (rules.ts) before any of them
// evaluate live traffic — installation and activation stay distinct
// privileges, exactly as Stage 1 established.
// ---------------------------------------------------------------------

export async function installStage2WorkflowCatalogue(input: { brokerageId: number; createdByUserId: number }) {
  const agencyAgreementSigned = await installAgencyAgreementSignedStage2Version(input);
  const offerAccepted = await installOfferAcceptedTemplate(input);
  const contractSigned = await installContractSignedTemplate(input);
  const settlementScheduled = await installSettlementScheduledTemplates(input);
  const settlementCompleted = await installSettlementCompletedTemplate(input);

  return {
    agencyAgreementSigned,
    offerAccepted,
    contractSigned,
    settlementScheduled,
    settlementCompleted,
  };
}
