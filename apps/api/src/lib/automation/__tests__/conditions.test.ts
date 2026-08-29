// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
// Pure-logic tests: facts extraction, the typed condition-operator set, and
// the closed action-params templating substitution. None of these touch
// the database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFacts, getFactValue } from "../facts.js";
import { evaluateConditionGroup, automationConditionGroupSchema, type AutomationConditionGroup } from "../conditions.js";
import { resolveActionParams } from "../templating.js";
import type { DomainEvent } from "@aee/events";

function fakeEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    eventType: "AGENCY_AGREEMENT_SIGNED",
    eventVersion: 1,
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:00.000Z"),
    propertyId: 42,
    transactionId: null,
    partyId: null,
    actorType: "USER",
    actorId: 7,
    brokerageId: 5,
    agentId: 7,
    source: "test",
    correlationId: "22222222-2222-2222-2222-222222222222",
    causationId: null,
    idempotencyKey: null,
    metadata: { foo: "bar" },
    payload: { offerPriceCents: 500000, tags: ["urgent", "vip"] },
    processingStatus: "PROCESSED",
    handlerErrors: null,
    attemptCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------
// facts.ts
// ---------------------------------------------------------------------

test("buildFacts flattens the domain event's scoping columns alongside its payload/metadata", () => {
  const facts = buildFacts(fakeEvent());
  assert.equal(facts.propertyId, 42);
  assert.equal(facts.brokerageId, 5);
  assert.deepEqual(facts.payload, { offerPriceCents: 500000, tags: ["urgent", "vip"] });
});

test("getFactValue reads a nested dot-path", () => {
  const facts = buildFacts(fakeEvent());
  assert.equal(getFactValue(facts, "payload.offerPriceCents"), 500000);
});

test("getFactValue returns undefined for a missing path rather than throwing", () => {
  const facts = buildFacts(fakeEvent());
  assert.equal(getFactValue(facts, "payload.doesNotExist"), undefined);
  assert.equal(getFactValue(facts, "payload.doesNotExist.deeper"), undefined);
});

test("getFactValue refuses to traverse prototype-polluting path segments", () => {
  const facts = buildFacts(fakeEvent());
  assert.equal(getFactValue(facts, "__proto__.polluted"), undefined);
  assert.equal(getFactValue(facts, "payload.constructor"), undefined);
});

// ---------------------------------------------------------------------
// conditions.ts
// ---------------------------------------------------------------------

test("evaluateConditionGroup: ALL requires every condition to match", () => {
  const facts = buildFacts(fakeEvent());
  const group: AutomationConditionGroup = {
    operator: "ALL",
    conditions: [
      { field: "propertyId", operator: "exists" },
      { field: "payload.offerPriceCents", operator: "gte", value: 400000 },
    ],
  };
  assert.equal(evaluateConditionGroup(group, facts).matched, true);
});

test("evaluateConditionGroup: ALL fails clean (no throw) when one condition does not match — condition mismatch scenario", () => {
  const facts = buildFacts(fakeEvent());
  const group: AutomationConditionGroup = {
    operator: "ALL",
    conditions: [
      { field: "propertyId", operator: "exists" },
      { field: "payload.offerPriceCents", operator: "gte", value: 9_000_000 },
    ],
  };
  const result = evaluateConditionGroup(group, facts);
  assert.equal(result.matched, false);
  assert.equal(result.evaluated.length, 2);
});

test("evaluateConditionGroup: ANY matches if a single nested condition matches", () => {
  const facts = buildFacts(fakeEvent());
  const group: AutomationConditionGroup = {
    operator: "ANY",
    conditions: [
      { field: "payload.offerPriceCents", operator: "eq", value: 1 },
      { field: "payload.tags", operator: "contains", value: "vip" },
    ],
  };
  assert.equal(evaluateConditionGroup(group, facts).matched, true);
});

test("evaluateConditionGroup supports nested groups", () => {
  const facts = buildFacts(fakeEvent());
  const group: AutomationConditionGroup = {
    operator: "ALL",
    conditions: [
      { field: "propertyId", operator: "exists" },
      {
        operator: "ANY",
        conditions: [
          { field: "payload.tags", operator: "contains", value: "urgent" },
          { field: "payload.tags", operator: "eq", value: "never" },
        ],
      },
    ],
  };
  assert.equal(evaluateConditionGroup(group, facts).matched, true);
});

test("evaluateConditionGroup: notExists matches an absent field", () => {
  const facts = buildFacts(fakeEvent());
  const group: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "payload.missing", operator: "notExists" }] };
  assert.equal(evaluateConditionGroup(group, facts).matched, true);
});

test("evaluateConditionGroup: numeric comparisons never coerce strings (fail closed on type mismatch)", () => {
  const facts = { amount: "500000" };
  const group: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "amount", operator: "gte", value: 100 }] };
  assert.equal(evaluateConditionGroup(group, facts).matched, false);
});

test("automationConditionGroupSchema rejects an operator outside the closed set", () => {
  const invalid = { operator: "ALL", conditions: [{ field: "x", operator: "eval", value: "1+1" }] };
  assert.throws(() => automationConditionGroupSchema.parse(invalid));
});

test("automationConditionGroupSchema rejects an empty conditions array", () => {
  assert.throws(() => automationConditionGroupSchema.parse({ operator: "ALL", conditions: [] }));
});

test("automationConditionGroupSchema accepts a well-formed nested tree", () => {
  const valid: AutomationConditionGroup = {
    operator: "ALL",
    conditions: [{ field: "propertyId", operator: "exists" }, { operator: "ANY", conditions: [{ field: "x", operator: "eq", value: 1 }] }],
  };
  assert.doesNotThrow(() => automationConditionGroupSchema.parse(valid));
});

// ---------------------------------------------------------------------
// templating.ts
// ---------------------------------------------------------------------

test("resolveActionParams substitutes a $event.<path> placeholder with the fact value", () => {
  const facts = buildFacts(fakeEvent());
  const resolved = resolveActionParams({ propertyId: "$event.propertyId", note: "static text" }, facts) as Record<string, unknown>;
  assert.equal(resolved.propertyId, 42);
  assert.equal(resolved.note, "static text");
});

test("resolveActionParams substitutes nested placeholders inside arrays and objects", () => {
  const facts = buildFacts(fakeEvent());
  const resolved = resolveActionParams(
    { tags: ["fixed", "$event.payload.tags"], nested: { id: "$event.propertyId" } },
    facts,
  ) as { tags: unknown[]; nested: { id: unknown } };
  assert.equal(resolved.tags[0], "fixed");
  assert.deepEqual(resolved.tags[1], ["urgent", "vip"]);
  assert.equal(resolved.nested.id, 42);
});

test("resolveActionParams never evaluates a placeholder embedded inside a larger string (whole-value substitution only)", () => {
  const facts = buildFacts(fakeEvent());
  const resolved = resolveActionParams({ note: "Property is $event.propertyId today" }, facts) as Record<string, unknown>;
  assert.equal(resolved.note, "Property is $event.propertyId today");
});

test("resolveActionParams leaves a placeholder unresolved to undefined when the fact is missing, never throwing", () => {
  const facts = buildFacts(fakeEvent());
  const resolved = resolveActionParams({ x: "$event.payload.doesNotExist" }, facts) as Record<string, unknown>;
  assert.equal(resolved.x, undefined);
});
