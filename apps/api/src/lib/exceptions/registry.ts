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
// Every rule implements ONE method — scanBrokerage(brokerageId, now) — that
// returns the RiskFinding[] for every currently-true occurrence of that
// rule's condition within one tenant. The periodic sweep (engine.ts) calls
// this for every rule, for every brokerage, in bounded batches. A rule that
// also declares triggerEventTypes gets evaluated immediately when one of
// those domain events fires, by calling this same scanBrokerage for just
// that event's brokerage — one detection function per rule, not two, so
// the event-driven and time-driven paths can never silently drift apart
// from each other.
import type { AgentEngineEasyEventType } from "@aee/events";
import type { RiskExceptionCategory, RiskFinding } from "./types.js";

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
  scanBrokerage(brokerageId: number, now: Date): Promise<RiskFinding[]>;
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
