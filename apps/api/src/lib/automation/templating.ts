// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// Resolves an action's stored `params` template (automationRuleVersions.actions[].params)
// against the triggering event's facts before the params are handed to
// proposeAIAction(). This is the ONLY substitution mechanism available to a
// rule author: a string value of the exact form "$event.<dot.path>" is
// replaced with the corresponding fact; every other string, number,
// boolean, array element, and nested object is passed through unchanged.
//
// There is deliberately no template-expression language here (no string
// interpolation inside a larger string, no arithmetic, no function calls) —
// only whole-value substitution of a single, explicit placeholder syntax.
// This is what keeps action params inert, declarative data rather than
// something that could ever evaluate workflow-configuration-supplied code
// (Safety Requirements: "never execute an arbitrary function, prompt,
// script, URL, or database mutation supplied through workflow
// configuration").

import { getFactValue, type AutomationFacts } from "./facts.js";

const PLACEHOLDER_RE = /^\$event\.([a-zA-Z0-9_.]+)$/;

export function resolveActionParams(params: unknown, facts: AutomationFacts): unknown {
  if (typeof params === "string") {
    const match = PLACEHOLDER_RE.exec(params);
    if (!match) return params;
    return getFactValue(facts, match[1]);
  }
  if (Array.isArray(params)) {
    return params.map((item) => resolveActionParams(item, facts));
  }
  if (params !== null && typeof params === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      resolved[key] = resolveActionParams(value, facts);
    }
    return resolved;
  }
  return params;
}
