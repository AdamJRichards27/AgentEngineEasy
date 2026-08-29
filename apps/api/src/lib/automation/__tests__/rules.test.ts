// Agent Engine 2.0 — Workflow Automation Engine (Stage: Foundation).
// Integration tests for the rule/version service layer (rules.ts) against
// the real database — same throwaway-fixture + t.after() teardown pattern
// as apps/api/src/lib/ai/__tests__/governance.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, users, automationRules, automationRuleVersions, type UserRole } from "@aee/db";
import {
  createAutomationRule,
  createRuleVersion,
  approveAndActivateRuleVersion,
  getActiveRuleVersionsForTrigger,
  AutomationValidationError,
  AutomationApprovalError,
} from "../rules.js";

async function createBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row.id;
}

async function createUser(brokerageId: number, role: UserRole): Promise<number> {
  const suffix = randomUUID();
  const [row] = await db
    .insert(users)
    .values({ authProviderId: `test-${suffix}`, email: `test-${suffix}@example.com`, role, brokerageId })
    .returning();
  return row.id;
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  const rules = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.brokerageId, brokerageId));
  for (const rule of rules) {
    await db.delete(automationRuleVersions).where(eq(automationRuleVersions.ruleId, rule.id));
  }
  await db.delete(automationRules).where(eq(automationRules.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

const VALID_CONDITIONS = { operator: "ALL" as const, conditions: [{ field: "propertyId", operator: "exists" as const }] };
const VALID_ACTIONS = [{ actionKey: "PROPERTY_NOTE_ADD", params: { propertyId: "$event.propertyId", note: "test" } }];

test("createAutomationRule rejects a triggerEventType outside the canonical event catalogue — fail closed", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - invalid trigger");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");

  await assert.rejects(
    () =>
      createAutomationRule({
        brokerageId,
        name: "bad rule",
        triggerEventType: "NOT_A_REAL_EVENT_TYPE",
        createdByUserId: adminId,
      }),
    AutomationValidationError,
  );
});

test("createRuleVersion rejects an action referencing an unregistered actionKey — component 4 write-time check", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - unregistered action");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const rule = await createAutomationRule({
    brokerageId,
    name: "rule with bad action",
    triggerEventType: "AGENCY_AGREEMENT_SIGNED",
    createdByUserId: adminId,
  });

  await assert.rejects(
    () =>
      createRuleVersion({
        ruleId: rule.id,
        brokerageId,
        conditionGroup: VALID_CONDITIONS,
        actions: [{ actionKey: "NOT_A_REGISTERED_ACTION", params: {} }],
        createdByUserId: adminId,
      }),
    AutomationValidationError,
  );
});

test("createRuleVersion rejects a malformed conditionGroup", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - malformed conditions");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const rule = await createAutomationRule({
    brokerageId,
    name: "rule with bad conditions",
    triggerEventType: "AGENCY_AGREEMENT_SIGNED",
    createdByUserId: adminId,
  });

  await assert.rejects(() =>
    createRuleVersion({
      ruleId: rule.id,
      brokerageId,
      // @ts-expect-error deliberately malformed for the test
      conditionGroup: { operator: "ALL", conditions: [{ field: "x", operator: "not-a-real-operator" }] },
      actions: VALID_ACTIONS,
      createdByUserId: adminId,
    }),
  );
});

test("createRuleVersion numbers versions sequentially per rule, starting at 1", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - version numbering");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const rule = await createAutomationRule({
    brokerageId,
    name: "versioned rule",
    triggerEventType: "AGENCY_AGREEMENT_SIGNED",
    createdByUserId: adminId,
  });

  const v1 = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId });
  const v2 = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId });
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
});

test("approveAndActivateRuleVersion requires the approver to be a Brokerage Administrator of the same tenant", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - approver role");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const rule = await createAutomationRule({ brokerageId, name: "rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const version = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId });

  await assert.rejects(
    () => approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: agentId }),
    AutomationApprovalError,
  );
});

test("approveAndActivateRuleVersion activates the version, marks the parent rule ACTIVE, and supersedes the previously active version — workflow overwrite prevention", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - activate and supersede");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const rule = await createAutomationRule({ brokerageId, name: "rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });

  const v1 = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId });
  const activatedV1 = await approveAndActivateRuleVersion({ versionId: v1.id, brokerageId, approvedByUserId: adminId });
  assert.equal(activatedV1.status, "ACTIVE");

  const [ruleAfterFirstActivation] = await db.select().from(automationRules).where(eq(automationRules.id, rule.id));
  assert.equal(ruleAfterFirstActivation.status, "ACTIVE");

  const v2 = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId, changeReason: "v2" });
  await approveAndActivateRuleVersion({ versionId: v2.id, brokerageId, approvedByUserId: adminId });

  const [v1AfterSecondActivation] = await db.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, v1.id));
  const [v2AfterSecondActivation] = await db.select().from(automationRuleVersions).where(eq(automationRuleVersions.id, v2.id));
  assert.equal(v1AfterSecondActivation.status, "SUPERSEDED");
  assert.equal(v2AfterSecondActivation.status, "ACTIVE");
});

test("getActiveRuleVersionsForTrigger only returns rules for the requested brokerage — tenant isolation", async (t) => {
  const brokerageA = await createBrokerage("Rules Test - tenant A");
  const brokerageB = await createBrokerage("Rules Test - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const adminA = await createUser(brokerageA, "Brokerage Administrator");

  const rule = await createAutomationRule({ brokerageId: brokerageA, name: "A-only rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminA });
  const version = await createRuleVersion({ ruleId: rule.id, brokerageId: brokerageA, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminA });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId: brokerageA, approvedByUserId: adminA });

  const matchesForA = await getActiveRuleVersionsForTrigger(brokerageA, "AGENCY_AGREEMENT_SIGNED");
  const matchesForB = await getActiveRuleVersionsForTrigger(brokerageB, "AGENCY_AGREEMENT_SIGNED");
  assert.equal(matchesForA.length, 1);
  assert.equal(matchesForB.length, 0);
});

test("getActiveRuleVersionsForTrigger excludes a rule whose parent status is PAUSED, even though its version is ACTIVE — disabled workflow", async (t) => {
  const brokerageId = await createBrokerage("Rules Test - paused rule");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const rule = await createAutomationRule({ brokerageId, name: "rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const version = await createRuleVersion({ ruleId: rule.id, brokerageId, conditionGroup: VALID_CONDITIONS, actions: VALID_ACTIONS, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  await db.update(automationRules).set({ status: "PAUSED" }).where(eq(automationRules.id, rule.id));

  const matches = await getActiveRuleVersionsForTrigger(brokerageId, "AGENCY_AGREEMENT_SIGNED");
  assert.equal(matches.length, 0);
});
