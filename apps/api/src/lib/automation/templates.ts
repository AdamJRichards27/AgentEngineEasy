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
// AGENCY_AGREEMENT_SIGNED event in the interim.

import type { AutomationRule, AutomationRuleVersion } from "@aee/db";
import { createAutomationRule, createRuleVersion, type AutomationRuleAction } from "./rules.js";
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
