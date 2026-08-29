// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Registers the automation engine as a handler for every canonical
// AgentEngineEasy domain event type, exactly once, at app boot — the same
// place configureEvents() is already called (apps/api/src/index.ts).
// Before this file, packages/events/src/registry.ts's registerHandler()
// had zero call sites anywhere in the repository; this is the first real
// event consumer.
//
// Registering for every canonical event type (rather than only
// AGENCY_AGREEMENT_SIGNED) is deliberate: the engine itself is generic —
// "Trigger definition based on approved domain events" — and a brokerage
// creating a rule against any other canonical event type must not require
// an additional code change here. The cost of registering for a type with
// zero active rules is one cheap, indexed, tenant-scoped SELECT
// (getActiveRuleVersionsForTrigger) that returns no rows.
import { AGENT_ENGINE_EASY_EVENT_TYPES, registerHandler } from "@aee/events";
import { handleAutomationDomainEvent } from "./engine.js";

let registered = false;

export function registerAutomationEngine(): void {
  if (registered) return; // idempotent — safe to call more than once (e.g. in tests)
  for (const eventType of AGENT_ENGINE_EASY_EVENT_TYPES) {
    registerHandler(eventType, handleAutomationDomainEvent);
  }
  registered = true;
}
