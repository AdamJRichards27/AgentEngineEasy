// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
//
// The "Stage 3 field/operator registry" referenced by
// packages/db/src/schema/automation.ts's automationRuleVersions.conditionGroup
// comment: an explicit, closed, typed operator set (Build Instructions
// §"Conditions using an explicit, typed operator set") and a pure,
// data-only evaluator for it.
//
// Deliberately NOT a scripting language: a condition is
// {field, operator, value?}. There is no operator that accepts a function,
// expression string, or template to evaluate — evaluateConditionGroup only
// ever compares a fact value (read via facts.ts's safe dot-path getter)
// against a fixed, JSON-serialisable `value` using one of the whitelisted
// operators below. This is what satisfies "never execute an arbitrary
// function, prompt, script, URL, or database mutation supplied through
// workflow configuration" for the conditions side of a rule.

import { z } from "zod";
import { getFactValue, type AutomationFacts } from "./facts.js";

export const CONDITION_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "notIn",
  "exists",
  "notExists",
  "contains",
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export interface AutomationCondition {
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}

export interface AutomationConditionGroup {
  operator: "ALL" | "ANY";
  conditions: Array<AutomationCondition | AutomationConditionGroup>;
}

function isConditionGroup(node: AutomationCondition | AutomationConditionGroup): node is AutomationConditionGroup {
  return (node as AutomationConditionGroup).conditions !== undefined;
}

// zod validation for conditionGroup, used by rules.ts at rule-version write
// time (fail closed on an unrecognised operator or malformed tree, rather
// than storing something the evaluator would silently mis-handle later).
const baseConditionSchema: z.ZodType<AutomationCondition> = z.object({
  field: z.string().min(1),
  operator: z.enum(CONDITION_OPERATORS),
  value: z.unknown().optional(),
});

export const automationConditionGroupSchema: z.ZodType<AutomationConditionGroup> = z.lazy(() =>
  z.object({
    operator: z.enum(["ALL", "ANY"]),
    conditions: z.array(z.union([baseConditionSchema, automationConditionGroupSchema])).min(1),
  }),
);

export interface ConditionEvalDetail {
  field: string;
  operator: ConditionOperator;
  expected?: unknown;
  actual: unknown;
  matched: boolean;
}

export interface ConditionGroupEvalResult {
  matched: boolean;
  groupOperator: "ALL" | "ANY";
  evaluated: Array<ConditionEvalDetail | ConditionGroupEvalResult>;
}

function evaluateCondition(condition: AutomationCondition, facts: AutomationFacts): ConditionEvalDetail {
  const actual = getFactValue(facts, condition.field);
  const matched = applyOperator(condition.operator, actual, condition.value);
  return { field: condition.field, operator: condition.operator, expected: condition.value, actual, matched };
}

function applyOperator(operator: ConditionOperator, actual: unknown, expected: unknown): boolean {
  switch (operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "notExists":
      return actual === undefined || actual === null;
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case "in":
      return Array.isArray(expected) && expected.includes(actual as never);
    case "notIn":
      return Array.isArray(expected) && !expected.includes(actual as never);
    case "contains":
      if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
      if (Array.isArray(actual)) return actual.includes(expected as never);
      return false;
    default: {
      // Exhaustiveness guard: an operator outside CONDITION_OPERATORS can
      // only reach here if a stored conditionGroup bypassed
      // automationConditionGroupSchema (e.g. written before this
      // validation existed). Fail closed — never true.
      const _exhaustive: never = operator;
      void _exhaustive;
      return false;
    }
  }
}

export function evaluateConditionGroup(
  group: AutomationConditionGroup,
  facts: AutomationFacts,
): ConditionGroupEvalResult {
  const evaluated = group.conditions.map((node) =>
    isConditionGroup(node) ? evaluateConditionGroup(node, facts) : evaluateCondition(node, facts),
  );
  const matched =
    group.operator === "ALL" ? evaluated.every((e) => e.matched) : evaluated.some((e) => e.matched);
  return { matched, groupOperator: group.operator, evaluated };
}
