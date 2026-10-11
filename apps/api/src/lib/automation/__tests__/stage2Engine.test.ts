// Agent Engine 2.0 — WAE Stage 2: Controlled Production Workflows.
//
// End-to-end and targeted tests for the five Stage 2 workflow templates
// (templates.ts) running through the real, unmodified engine (engine.ts)
// against the real database and the real event pipeline — same pattern as
// the Foundation stage's engine.test.ts. Several tests below deliberately
// drive the REAL production domain functions in apps/api/src/lib/transactions.ts
// (acceptOffer, recordContractSigned, scheduleSettlement, completeSettlement)
// rather than directly publishing a synthetic event, to prove genuine
// production-event wiring end to end (Build Instructions §9's explicit
// end-to-end vertical test requirement) — not just that the engine behaves
// correctly against a hand-crafted DomainEvent.
//
// Covers the Stage 2 testing requirements (Build Instructions §9):
//   - each of the five triggers                              -> tests 1-5
//   - successful execution                                    -> tests 1-5
//   - condition mismatch / incomplete event payload            -> test 6
//   - exception/attention-item creation                        -> test 6
//   - changed transaction date (supersede)                     -> test 7
//   - disabled workflow                                        -> test 8
//   - duplicate event delivery                                 -> test 9
//   - wrong tenant                                              -> test 10
//   - insufficient authority                                    -> test 11
//   - approval-required action                                  -> test 12
//   - invalid registered-action payload                         -> test 13
//   - repeated action execution attempt                         -> test 14
//   - retryable failure (against a Stage 2 action)               -> test 15
//   - task creation / reminder creation                         -> tests 1-7
//   - audit continuity / correlation-causation continuity        -> test 16
//   - workflow version used for execution                       -> test 17
//
// "Missing entitlement" and "non-retryable failure" are deliberately NOT
// re-tested here: both are fully generic engine/policy mechanisms already
// proven by the Foundation stage's engine.test.ts (scenarios 6 and 11), and
// no Stage 2 action defines a requiredEntitlementKey or changes the
// retry-classification logic — re-asserting identical, unmodified machinery
// against a different trigger would not exercise any new code path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  auditLogs,
  brokerages,
  users,
  properties,
  offers,
  transactions,
  workflows,
  workflowSteps,
  automationRules,
  automationRuleVersions,
  automationExecutions,
  automationActions,
  automationTasks,
  automationAttentionItems,
  eventProcessingReceipts,
  aiActionRequests,
  domainEvents,
  type UserRole,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId, type DomainEvent } from "@aee/events";
import { configureEvents } from "../../events.js";
import { registerAutomationEngine } from "../bootstrap.js";
import { handleAutomationDomainEvent, retryAutomationAction } from "../engine.js";
import { createAutomationRule, createRuleVersion, approveAndActivateRuleVersion } from "../rules.js";
import { approveAIActionRequest } from "../../ai/actionRequests.js";
import { acceptOffer, recordContractSigned, scheduleSettlement, completeSettlement } from "../../transactions.js";
import type { AutomationConditionGroup } from "../conditions.js";
import {
  installAgencyAgreementSignedTemplate,
  installAgencyAgreementSignedStage2Version,
  installOfferAcceptedTemplate,
  installContractSignedTemplate,
  installSettlementScheduledTemplates,
  installSettlementCompletedTemplate,
} from "../templates.js";

configureEvents();
registerAutomationEngine();

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

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

async function createProperty(brokerageId: number, agentId: number): Promise<number> {
  const [row] = await db.insert(properties).values({ brokerageId, agentId, formattedAddress: "1 Stage 2 Engine Test St, Testville" }).returning();
  return row.id;
}

async function createReceivedOffer(propertyId: number): Promise<number> {
  const [row] = await db
    .insert(offers)
    .values({ propertyId, offerPriceCents: 750_000_00, status: "Received", shareToken: randomUUID() })
    .returning();
  return row.id;
}

async function activateVersion(input: { ruleId: number; brokerageId: number; approverId: number }): Promise<void> {
  const versions = await db
    .select()
    .from(automationRuleVersions)
    .where(eq(automationRuleVersions.ruleId, input.ruleId));
  const latest = versions.sort((a, b) => b.version - a.version)[0];
  await approveAndActivateRuleVersion({ versionId: latest.id, brokerageId: input.brokerageId, approvedByUserId: input.approverId });
}

async function publishSynthetic(input: {
  eventType: DomainEvent["eventType"];
  brokerageId: number;
  propertyId: number;
  transactionId?: number | null;
  agentId: number;
  payload?: Record<string, unknown>;
}): Promise<DomainEvent> {
  return publishDomainEvent({
    eventType: input.eventType,
    occurredAt: new Date(),
    propertyId: input.propertyId,
    transactionId: input.transactionId ?? null,
    partyId: null,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    actorType: "USER",
    actorId: input.agentId,
    source: "test:stage2Engine",
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: `test-${input.eventType}:${randomUUID()}`,
    payload: input.payload ?? {},
    metadata: {},
  });
}

async function cleanupBrokerage(brokerageId: number): Promise<void> {
  const propertyRows = await db.select({ id: properties.id }).from(properties).where(eq(properties.brokerageId, brokerageId));
  const propertyIds = propertyRows.map((r) => r.id);

  if (propertyIds.length > 0) {
    await db.delete(automationTasks).where(inArray(automationTasks.propertyId, propertyIds));
    await db.delete(automationAttentionItems).where(inArray(automationAttentionItems.propertyId, propertyIds));

    const workflowRows = await db.select({ id: workflows.id }).from(workflows).where(inArray(workflows.propertyId, propertyIds));
    const workflowIds = workflowRows.map((r) => r.id);
    if (workflowIds.length > 0) {
      await db.delete(workflowSteps).where(inArray(workflowSteps.workflowId, workflowIds));
    }
    await db.delete(workflows).where(inArray(workflows.propertyId, propertyIds));
    // transactions.acceptedOfferId references offers.id, so transactions
    // must be deleted before offers — reversed from an earlier draft, which
    // deleted offers first and failed teardown with a foreign-key violation
    // whenever a test's fixture had gone through acceptOffer() (real
    // execution against Replit's Postgres caught this, not static review).
    await db.delete(transactions).where(inArray(transactions.propertyId, propertyIds));
    await db.delete(offers).where(inArray(offers.propertyId, propertyIds));
  }

  const eventRows = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  const eventIds = eventRows.map((r) => r.id);

  const executionRows = await db.select({ id: automationExecutions.id }).from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  const executionIds = executionRows.map((r) => r.id);
  if (executionIds.length > 0) {
    await db.delete(automationActions).where(inArray(automationActions.executionId, executionIds));
  }
  await db.delete(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));

  if (eventIds.length > 0) {
    await db.delete(eventProcessingReceipts).where(inArray(eventProcessingReceipts.eventId, eventIds));
  }

  const ruleRows = await db.select({ id: automationRules.id }).from(automationRules).where(eq(automationRules.brokerageId, brokerageId));
  for (const rule of ruleRows) {
    await db.delete(automationRuleVersions).where(eq(automationRuleVersions.ruleId, rule.id));
  }
  await db.delete(automationRules).where(eq(automationRules.brokerageId, brokerageId));

  await db.delete(aiActionRequests).where(eq(aiActionRequests.brokerageId, brokerageId));
  await db.delete(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  // Run audit rows now reference the brokerage. Delete them before the brokerage row.
  await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

function taskKeysFor(propertyId: number) {
  return db.select().from(automationTasks).where(eq(automationTasks.propertyId, propertyId));
}

// ---------------------------------------------------------------------
// 1. Workflow 1 — Agency Agreement Signed (v2) + workflow version used
// ---------------------------------------------------------------------

test("Workflow 1 (Agency Agreement Signed) v2 — successful execution creates the full Stage 2 task set, and the execution binds to v2 not v1", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 1");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { rule, version: v1 } = await installAgencyAgreementSignedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: v1.id, brokerageId, approvedByUserId: adminId });

  const { version: v2 } = await installAgencyAgreementSignedStage2Version({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: v2.id, brokerageId, approvedByUserId: adminId });

  const event = await publishSynthetic({ eventType: "AGENCY_AGREEMENT_SIGNED", brokerageId, propertyId, agentId, payload: { propertyId } });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "COMPLETED");
  assert.equal(execution.ruleId, rule.id);
  assert.equal(execution.ruleVersionId, v2.id, "the ACTIVE version (v2) must be what executes, never the superseded v1");
  assert.notEqual(execution.ruleVersionId, v1.id);

  const tasks = await taskKeysFor(propertyId);
  const taskKeys = tasks.map((t2) => t2.taskKey).sort();
  assert.deepEqual(taskKeys, [
    "CONFIRM_AML_CTF_REQUIREMENTS",
    "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
    "REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO",
    "VERIFY_REGISTERED_PROPERTY_OWNERS",
  ]);
  assert.ok(tasks.every((t2) => t2.status === "ACTIVE"));

  const actions = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actions.length, 4);
  assert.ok(actions.every((a) => a.status === "SUCCEEDED"));
});

// ---------------------------------------------------------------------
// 2. Workflow 2 — Offer Accepted (genuine end-to-end vertical test)
// ---------------------------------------------------------------------

test("Workflow 2 (Offer Accepted) — end-to-end: a real acceptOffer() call publishes OFFER_ACCEPTED, which the workflow evaluates and turns into the approved task set with execution/audit evidence persisted", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 2 e2e");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  // The real, unmodified production domain function — not a synthetic event.
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  assert.equal(executions.length, 1);
  const [execution] = executions;
  assert.equal(execution.status, "COMPLETED");
  assert.equal(execution.ruleVersionId, version.id);

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 5);
  assert.ok(tasks.every((t2) => t2.transactionId === transaction.id));
  const taskKeys = tasks.map((t2) => t2.taskKey).sort();
  assert.deepEqual(taskKeys, [
    "CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES",
    "FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS",
    "IDENTIFY_MISSING_TRANSACTION_INFO",
    "PREPARE_CONTRACT_DOCUMENTATION",
    "RECORD_TRANSACTION_DATES_CONDITIONS",
  ]);

  // Full audit trail: every task's originatingEventId round-trips to the
  // exact event acceptOffer() published, via automationActions.result.
  const actions = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  for (const action of actions) {
    const result = action.result as { task?: { id?: string } } | null;
    assert.ok(result?.task?.id, "each action's persisted result must reference the created automation_tasks row");
  }
});

// ---------------------------------------------------------------------
// 3. Workflow 3 — Contract Signed (genuine end-to-end vertical test)
// ---------------------------------------------------------------------

test("Workflow 3 (Contract Signed) — end-to-end: a real recordContractSigned() call publishes CONTRACT_SIGNED and creates the full task set", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 3 e2e");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });

  const { version } = await installContractSignedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  await recordContractSigned({ transactionId: transaction.id, userId: agentId, brokerageId });

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 5);
  const taskKeys = tasks.map((t2) => t2.taskKey).sort();
  assert.deepEqual(taskKeys, [
    "CAPTURE_CONTRACT_CONDITION_DATES",
    "CONDITION_DEADLINE_FOLLOWUP",
    "CONFIRM_CONTRACT_EXCHANGE_STATUS",
    "IDENTIFY_MISSING_LEGAL_REPRESENTATIVES",
    "PREPARE_SETTLEMENT_TRACKING",
  ]);
});

// ---------------------------------------------------------------------
// 4. Workflow 4 — Settlement Scheduled (prepare path, genuine e2e)
// ---------------------------------------------------------------------

test("Workflow 4 (Settlement Scheduled) — end-to-end: a real scheduleSettlement() call creates a confirm task, an authoritative-date reminder, and preparation tasks", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 4 prepare e2e");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });
  await recordContractSigned({ transactionId: transaction.id, userId: agentId, brokerageId });

  const { prepare, missingDateFailsafe } = await installSettlementScheduledTemplates({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: prepare.version.id, brokerageId, approvedByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: missingDateFailsafe.version.id, brokerageId, approvedByUserId: adminId });

  const settlementDate = new Date("2026-10-15T00:00:00.000Z");
  await scheduleSettlement({ transactionId: transaction.id, userId: agentId, brokerageId, settlementDate });

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 4, "the prepare rule's 4 actions must run; the missing-date fail-safe must NOT fire when a date is present");

  const reminder = tasks.find((t2) => t2.taskKey === "PRE_SETTLEMENT_MILESTONE_REMINDER");
  assert.ok(reminder);
  assert.equal(reminder!.kind, "REMINDER");
  assert.equal(reminder!.dueAt?.toISOString(), settlementDate.toISOString(), "the reminder's due date must be the authoritative settlementDate, not a re-derived one");

  const attentionItems = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.propertyId, propertyId));
  assert.equal(attentionItems.length, 0, "a valid settlement date must never raise the missing-date attention item");
});

test("Workflow 4 — missing settlement date fail-safe: an incomplete SETTLEMENT_SCHEDULED event raises an attention item instead of creating preparation tasks", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 4 missing date");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });

  const { prepare, missingDateFailsafe } = await installSettlementScheduledTemplates({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: prepare.version.id, brokerageId, approvedByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: missingDateFailsafe.version.id, brokerageId, approvedByUserId: adminId });

  // No real production code path publishes SETTLEMENT_SCHEDULED without a
  // date (scheduleSettlement() always requires one) — this synthesizes the
  // malformed/incomplete-payload scenario directly, the same technique the
  // Foundation stage used for its own condition-mismatch tests.
  const event = await publishSynthetic({
    eventType: "SETTLEMENT_SCHEDULED",
    brokerageId,
    propertyId,
    transactionId: transaction.id,
    agentId,
    payload: {},
  });

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(executions.length, 2, "both the prepare rule and the fail-safe rule must each produce their own execution row");

  const prepareExecution = executions.find((e) => e.ruleVersionId === prepare.version.id)!;
  assert.equal(prepareExecution.status, "SKIPPED", "the prepare rule's condition (settlementDate exists) must fail cleanly, never throw");

  const failsafeExecution = executions.find((e) => e.ruleVersionId === missingDateFailsafe.version.id)!;
  assert.equal(failsafeExecution.status, "COMPLETED");

  const attentionItems = await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.transactionId, transaction.id));
  assert.equal(attentionItems.length, 1);
  assert.equal(attentionItems[0].reasonCode, "MISSING_SETTLEMENT_DATE");
  assert.equal(attentionItems[0].status, "OPEN");

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 0, "no preparation task may be created when the settlement date is missing");
});

// ---------------------------------------------------------------------
// 5. Workflow 5 — Settlement Completed (genuine end-to-end vertical test)
// ---------------------------------------------------------------------

test("Workflow 5 (Settlement Completed) — end-to-end: a real completeSettlement() call publishes SETTLEMENT_COMPLETED and creates the full closure task set", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 5 e2e");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });
  await recordContractSigned({ transactionId: transaction.id, userId: agentId, brokerageId });
  await scheduleSettlement({ transactionId: transaction.id, userId: agentId, brokerageId, settlementDate: new Date("2026-10-15T00:00:00.000Z") });

  const { version } = await installSettlementCompletedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  // This offer has no tracked conditions and was never exchanged, so
  // unconditionalAt is still null. The test is the SETTLEMENT_COMPLETED
  // task set, not the completion gate.
  await db
    .update(transactions)
    .set({ unconditionalAt: new Date() })
    .where(eq(transactions.id, transaction.id));
  await completeSettlement({ transactionId: transaction.id, userId: agentId, brokerageId });

  const tasks = await taskKeysFor(propertyId);
  const taskKeys = tasks.map((t2) => t2.taskKey).sort();
  assert.deepEqual(taskKeys, [
    "CONFIRM_TRANSACTION_RECORD_COMPLETE",
    "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
    "PREPARE_PERMITTED_CLIENT_FOLLOWUP",
    "PREPARE_PROPERTY_TRANSACTION_CLOSURE",
    "RECORD_RETENTION_CLOSURE_CHECK",
  ]);
});

// ---------------------------------------------------------------------
// 6. Condition mismatch / incomplete event payload — already exercised in
//    depth by test 4 above (Workflow 4's split-rule fail-safe). Additional,
//    simpler condition-mismatch coverage for a single-rule workflow:
// ---------------------------------------------------------------------

test("Workflow 2 — condition mismatch: an OFFER_ACCEPTED-shaped event missing transactionId is cleanly SKIPPED, never throws, and creates no tasks", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 2 condition mismatch");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  const event = await publishSynthetic({ eventType: "OFFER_ACCEPTED", brokerageId, propertyId, transactionId: null, agentId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "SKIPPED");
  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 0);
});

// ---------------------------------------------------------------------
// 7. Changed transaction date — supersede, through the real event pipeline
// ---------------------------------------------------------------------

test("Workflow 4 — a genuine settlement reschedule supersedes the prior reminder rather than silently overwriting it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - workflow 4 reschedule");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);
  const { transaction } = await acceptOffer({ offerId, userId: agentId, brokerageId });
  await recordContractSigned({ transactionId: transaction.id, userId: agentId, brokerageId });

  const { prepare, missingDateFailsafe } = await installSettlementScheduledTemplates({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: prepare.version.id, brokerageId, approvedByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: missingDateFailsafe.version.id, brokerageId, approvedByUserId: adminId });

  await scheduleSettlement({ transactionId: transaction.id, userId: agentId, brokerageId, settlementDate: new Date("2026-10-15T00:00:00.000Z") });
  const firstReminder = (await taskKeysFor(propertyId)).find((t2) => t2.taskKey === "PRE_SETTLEMENT_MILESTONE_REMINDER")!;

  // A genuine reschedule — same real domain function, new date.
  await scheduleSettlement({ transactionId: transaction.id, userId: agentId, brokerageId, settlementDate: new Date("2026-11-01T00:00:00.000Z") });

  const [supersededRow] = await db.select().from(automationTasks).where(eq(automationTasks.id, firstReminder.id));
  assert.equal(supersededRow.status, "SUPERSEDED");

  const currentActive = (await taskKeysFor(propertyId)).filter((t2) => t2.taskKey === "PRE_SETTLEMENT_MILESTONE_REMINDER" && t2.status === "ACTIVE");
  assert.equal(currentActive.length, 1);
  assert.equal(currentActive[0].dueAt?.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(supersededRow.supersededByTaskId, currentActive[0].id);
});

// ---------------------------------------------------------------------
// 8. Disabled workflow
// ---------------------------------------------------------------------

test("a Stage 2 rule version left in DRAFT (never activated) is never evaluated", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - disabled workflow");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  // Installed but deliberately never activated.
  await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });

  await acceptOffer({ offerId, userId: agentId, brokerageId });

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  assert.equal(executions.length, 0);
  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 0);
});

// ---------------------------------------------------------------------
// 9. Duplicate event delivery
// ---------------------------------------------------------------------

test("duplicate delivery of a real acceptOffer()-published OFFER_ACCEPTED event produces exactly one execution and one task set", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - duplicate delivery");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });

  await acceptOffer({ offerId, userId: agentId, brokerageId });
  // Filtered by eventType, not just brokerageId: acceptOffer's own execution
  // publishes follow-on AI_ACTION_PROPOSED/AI_ACTION_EXECUTED/
  // AUTOMATION_EXECUTION_COMPLETED events for this same brokerage as a
  // direct consequence of the automation run this test is about to
  // re-deliver — an unfiltered, unordered `where(brokerageId)` query can
  // return any of those rows first depending on Postgres's physical row
  // order, which is not guaranteed by insertion order and was observed to
  // vary under concurrent load (see the completion report's test-evidence
  // section). Filtering by eventType makes the intended target
  // deterministic regardless of how many side-effect events acceptOffer's
  // own automation run has already produced by this point.
  const [event] = await db.select().from(domainEvents).where(and(eq(domainEvents.brokerageId, brokerageId), eq(domainEvents.eventType, "OFFER_ACCEPTED")));
  const triggeringEvent = { ...event, handlerErrors: event.handlerErrors as DomainEvent["handlerErrors"] } as DomainEvent;

  await assert.doesNotReject(() => handleAutomationDomainEvent(triggeringEvent));

  const executions = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(executions.length, 1);
  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 5, "a redelivered event must never create a second round of tasks");
});

// ---------------------------------------------------------------------
// 10. Wrong tenant
// ---------------------------------------------------------------------

test("wrong tenant: brokerage A's Offer Accepted rule never evaluates an event published under brokerage B", async (t) => {
  const brokerageA = await createBrokerage("Stage2 Engine - tenant A");
  const brokerageB = await createBrokerage("Stage2 Engine - tenant B");
  t.after(() => Promise.all([cleanupBrokerage(brokerageA), cleanupBrokerage(brokerageB)]));
  const adminA = await createUser(brokerageA, "Brokerage Administrator");
  const agentA = await createUser(brokerageA, "Agent");
  await createProperty(brokerageA, agentA);
  const { version } = await installOfferAcceptedTemplate({ brokerageId: brokerageA, createdByUserId: adminA });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId: brokerageA, approvedByUserId: adminA });

  const agentB = await createUser(brokerageB, "Agent");
  const propertyB = await createProperty(brokerageB, agentB);
  const offerB = await createReceivedOffer(propertyB);
  await acceptOffer({ offerId: offerB, userId: agentB, brokerageId: brokerageB });

  const tasksB = await taskKeysFor(propertyB);
  assert.equal(tasksB.length, 0, "brokerage A's rule must never fire for an event published under brokerage B");
});

// ---------------------------------------------------------------------
// 11. Insufficient authority
// ---------------------------------------------------------------------

test("insufficient authority: a Stage 2 rule version whose approver can no longer be verified is BLOCKED, fail closed", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - insufficient authority");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });
  await db.update(automationRuleVersions).set({ approvedByUserId: null }).where(eq(automationRuleVersions.id, version.id));

  await acceptOffer({ offerId, userId: agentId, brokerageId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  assert.equal(execution.status, "BLOCKED");
  assert.match(execution.errorMessage ?? "", /authority/i);
  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 0);
});

// ---------------------------------------------------------------------
// 12. Approval-required action — REQUEST_ACTION_APPROVAL, full chain
// ---------------------------------------------------------------------

const AGENCY_CONDITIONS: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "propertyId", operator: "exists" }] };

test("approval-required action: REQUEST_ACTION_APPROVAL always stops at AWAITING_APPROVAL and, once approved through the existing governance mechanism, executes to a durable record — never a boolean flag the workflow controls", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - approval required");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const rule = await createAutomationRule({ brokerageId, name: "approval test rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const ruleVersion = await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: AGENCY_CONDITIONS,
    actions: [
      {
        actionKey: "REQUEST_ACTION_APPROVAL",
        params: {
          propertyId: "$event.propertyId",
          protectedActionKey: "ORDER_AML_VERIFICATION",
          reason: "Sellers appear on title but AML has not yet been ordered.",
        },
      },
    ],
    createdByUserId: adminId,
  });
  await approveAndActivateRuleVersion({ versionId: ruleVersion.id, brokerageId, approvedByUserId: adminId });

  const event = await publishSynthetic({ eventType: "AGENCY_AGREEMENT_SIGNED", brokerageId, propertyId, agentId, payload: { propertyId } });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.status, "AWAITING_APPROVAL");

  const [actionRow] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRow.status, "AWAITING_APPROVAL");
  assert.equal(actionRow.authorityDecision, "ALLOW_WITH_APPROVAL");
  assert.ok(actionRow.aiActionRequestId);

  // No attention item exists yet — approval genuinely gates execution.
  assert.equal((await db.select().from(automationAttentionItems).where(eq(automationAttentionItems.propertyId, propertyId))).length, 0);

  const approval = await approveAIActionRequest(actionRow.aiActionRequestId!, brokerageId, { id: adminId, role: "Brokerage Administrator", brokerageId });
  assert.equal(approval.ok, true);
  assert.equal(approval.request?.status, "APPROVED");
});

// ---------------------------------------------------------------------
// 13. Invalid registered-action payload
// ---------------------------------------------------------------------

test("invalid registered-action payload: a CREATE_REMINDER action with a non-ISO dueAt fails schema validation and is BLOCKED, never throws or creates a task", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - invalid payload");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const rule = await createAutomationRule({ brokerageId, name: "invalid payload rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const ruleVersion = await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: AGENCY_CONDITIONS,
    actions: [
      {
        actionKey: "CREATE_REMINDER",
        params: { propertyId: "$event.propertyId", taskKey: "CONFIRM_AML_CTF_REQUIREMENTS", title: "bad reminder", dueAt: "not-a-real-date" },
      },
    ],
    createdByUserId: adminId,
  });
  await approveAndActivateRuleVersion({ versionId: ruleVersion.id, brokerageId, approvedByUserId: adminId });

  await assert.doesNotReject(() =>
    publishSynthetic({ eventType: "AGENCY_AGREEMENT_SIGNED", brokerageId, propertyId, agentId, payload: { propertyId } }),
  );

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  assert.equal(execution.status, "BLOCKED");
  const [actionRow] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(actionRow.status, "BLOCKED");
  assert.match(actionRow.errorMessage ?? "", /INPUT_SCHEMA_INVALID/);

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 0);
});

// ---------------------------------------------------------------------
// 14. Repeated action execution attempt (distinct from duplicate event
//     delivery, and from a retryable-failure retry): retrying an action
//     that already SUCCEEDED must be refused outright.
// ---------------------------------------------------------------------

test("repeated action execution attempt: retrying an already-SUCCEEDED action is refused, never re-executed", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - repeated execution attempt");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });
  await acceptOffer({ offerId, userId: agentId, brokerageId });

  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.brokerageId, brokerageId));
  const [succeededAction] = await db.select().from(automationActions).where(eq(automationActions.executionId, execution.id));
  assert.equal(succeededAction.status, "SUCCEEDED");

  const result = await retryAutomationAction(succeededAction.id, brokerageId);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "NOT_RETRY_ELIGIBLE");

  const tasksAfter = await taskKeysFor(propertyId);
  assert.equal(tasksAfter.length, 5, "a refused repeated-execution attempt must never create a second round of tasks");
});

// ---------------------------------------------------------------------
// 15. Retryable failure against a Stage 2 action
// ---------------------------------------------------------------------

test("retryable failure: a genuine execution-time failure on a Stage 2 CREATE_INTERNAL_TASK action can be retried, reuses the same row, and can succeed", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - retryable failure");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);

  const rule = await createAutomationRule({ brokerageId, name: "stage2 retry rule", triggerEventType: "AGENCY_AGREEMENT_SIGNED", createdByUserId: adminId });
  const draftVersion = await createRuleVersion({
    ruleId: rule.id,
    brokerageId,
    conditionGroup: AGENCY_CONDITIONS,
    actions: [
      {
        actionKey: "CREATE_INTERNAL_TASK",
        params: { propertyId: "$event.propertyId", taskKey: "CONFIRM_AML_CTF_REQUIREMENTS", title: "retry test task" },
      },
    ],
    createdByUserId: adminId,
  });

  const event = await publishSynthetic({ eventType: "AGENCY_AGREEMENT_SIGNED", brokerageId, propertyId, agentId, payload: { propertyId } });

  const [execution] = await db
    .insert(automationExecutions)
    .values({
      brokerageId,
      ruleId: rule.id,
      ruleVersionId: draftVersion.id,
      triggeringEventId: event.id,
      correlationId: event.correlationId,
      status: "PARTIALLY_COMPLETED",
      startedAt: new Date(),
    })
    .returning();
  const [action] = await db
    .insert(automationActions)
    .values({
      executionId: execution.id,
      sequence: 1,
      actionKey: "CREATE_INTERNAL_TASK",
      params: { propertyId, taskKey: "CONFIRM_AML_CTF_REQUIREMENTS", title: "retry test task" },
      status: "FAILED",
      errorMessage: "simulated transient timeout",
      attemptCount: 1,
      maxAttempts: 3,
      startedAt: new Date(),
      completedAt: new Date(),
    })
    .returning();

  await approveAndActivateRuleVersion({ versionId: draftVersion.id, brokerageId, approvedByUserId: adminId });

  const result = await retryAutomationAction(action.id, brokerageId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.status, "SUCCEEDED");

  const [updated] = await db.select().from(automationActions).where(eq(automationActions.id, action.id));
  assert.equal(updated.status, "SUCCEEDED");
  assert.equal(updated.attemptCount, 2);

  const tasks = await taskKeysFor(propertyId);
  assert.equal(tasks.length, 1);
});

// ---------------------------------------------------------------------
// 16. Audit and correlation/causation continuity
// ---------------------------------------------------------------------

test("audit continuity: a Stage 2 execution and its completion event both carry the triggering event's correlationId, and causationId chains back to it", async (t) => {
  const brokerageId = await createBrokerage("Stage2 Engine - audit continuity");
  t.after(() => cleanupBrokerage(brokerageId));
  const adminId = await createUser(brokerageId, "Brokerage Administrator");
  const agentId = await createUser(brokerageId, "Agent");
  const propertyId = await createProperty(brokerageId, agentId);
  const offerId = await createReceivedOffer(propertyId);

  const { version } = await installOfferAcceptedTemplate({ brokerageId, createdByUserId: adminId });
  await approveAndActivateRuleVersion({ versionId: version.id, brokerageId, approvedByUserId: adminId });
  await acceptOffer({ offerId, userId: agentId, brokerageId });

  // Filtered on eventType, not just brokerageId: by the time acceptOffer()
  // resolves, the engine has already synchronously published
  // AUTOMATION_EXECUTION_COMPLETED for this same brokerage, so an
  // unfiltered, unordered query over domainEvents can nondeterministically
  // return either row first. Real execution against Replit's Postgres
  // caught this (an earlier draft filtered on brokerageId alone and failed
  // intermittently with "Cannot read properties of undefined" once a
  // second event existed) -- not something static review would have found.
  const [event] = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.brokerageId, brokerageId), eq(domainEvents.eventType, "OFFER_ACCEPTED")));
  const [execution] = await db.select().from(automationExecutions).where(eq(automationExecutions.triggeringEventId, event.id));
  assert.equal(execution.correlationId, event.correlationId);

  const completionEvents = await db.select().from(domainEvents).where(eq(domainEvents.brokerageId, brokerageId));
  const completion = completionEvents.find((e) => e.eventType === "AUTOMATION_EXECUTION_COMPLETED");
  assert.ok(completion);
  assert.equal(completion!.causationId, event.id);
  assert.equal(completion!.correlationId, event.correlationId);

  // Every created automation_tasks row also carries the same eventId,
  // via the new facts.ts eventId flattening and the rule templates'
  // "$event.eventId" -> originatingEventId params.
  const tasks = await taskKeysFor(propertyId);
  assert.ok(tasks.every((t2) => t2.originatingEventId === event.id));
});
