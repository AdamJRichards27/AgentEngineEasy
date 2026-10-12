// R-F42 — run closure classification, milestone auto-completion, and the
// financial close blockers. No migration. Existing task rows are not
// rewritten; a task completes only when a milestone is processed while
// that row is still ACTIVE and the live evidence holds.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  db,
  amlVerifications,
  auditLogs,
  automationTasks,
  commissionAgreements,
  commissionCalculations,
  domainEvents,
  financialDisputes,
  financialPaymentRequests,
  financialReconciliations,
  pitCrewAssignments,
  riskExceptions,
  transactions,
  users,
} from "@aee/db";
import { AUTOMATION_TASK_KEYS } from "../../lib/automation/types.js";
import {
  AUTOMATION_TASK_CLOSURE_POLICY,
  MUST_COMPLETE_BEFORE_CLOSE_TASK_KEYS,
  NEVER_AUTO_COMPLETE_TASK_KEYS,
  RUN_CLOSURE_AUTO_COMPLETE_ACTOR_EMAIL,
} from "../../lib/automation/closurePolicy.js";
import { completeSatisfiedAutomationTasks } from "../../lib/automation/closureAutoComplete.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { getPitCrewWorkspace } from "../../lib/pitCrew/queries.js";
import {
  cleanupBrokerages,
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  devLogin,
  getDomainEventsForProperty,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = process.env.AML_WEBHOOK_SECRET ?? "test-only-aml-webhook-secret";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let pitCrew: DevLoginResult;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

function amlWebhookHeaders(body: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", process.env.AML_WEBHOOK_SECRET!).update(`${timestamp}.`).update(body).digest("hex"),
  };
}

async function insertTask(values: typeof automationTasks.$inferInsert) {
  const [row] = await db.insert(automationTasks).values(values).returning();
  return row;
}

async function reloadTask(id: string) {
  const [row] = await db.select().from(automationTasks).where(eq(automationTasks.id, id));
  assert.ok(row, `task ${id} missing`);
  return row;
}

async function clearBuyerAml(propertyId: number, sellerPartyId: number, cookie: string) {
  const amlListRes = await getJson(`/aml/by-property/${propertyId}`, cookie);
  assert.equal(amlListRes.status, 200);
  const { verifications } = await readJson<{ verifications: Array<{ partyId: number; status: string; providerReference: string }> }>(amlListRes);
  const buyer = verifications.find((row) => row.partyId !== sellerPartyId && row.status !== "Complete");
  assert.ok(buyer, "contract signing must start buyer AML");
  const body = JSON.stringify({ providerReference: buyer.providerReference, outcome: "VERIFIED", reviewRequired: false });
  const webhook = await fetch(`${baseUrl}/api/aml/webhook`, { method: "POST", headers: amlWebhookHeaders(body), body });
  assert.equal(webhook.status, 200, await webhook.text());
}

async function closeAttempt(transactionId: number, cookie: string) {
  const res = await postJson(`/transactions/${transactionId}/close`, cookie);
  const text = await res.text();
  let body: { error?: string; blockers?: string[] } = {};
  try {
    body = JSON.parse(text) as { error?: string; blockers?: string[] };
  } catch {
    body = { error: text };
  }
  return { status: res.status, body, text };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { registerAutomationEngine } = await import("../../lib/automation/bootstrap.js");
  registerAutomationEngine();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `R-F42 Closure A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F42 Closure B ${suffix}`);
  pitCrew = await devLogin(baseUrl, {
    email: `pit-rf42-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: `R-F42 Closure A ${suffix}`,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("the closure map covers every task key and only the must-finish tasks block close", () => {
  assert.deepEqual([...Object.keys(AUTOMATION_TASK_CLOSURE_POLICY)].sort(), [...AUTOMATION_TASK_KEYS].sort());
  assert.deepEqual(
    [...MUST_COMPLETE_BEFORE_CLOSE_TASK_KEYS].sort(),
    [
      "CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES",
      "IDENTIFY_MISSING_LEGAL_REPRESENTATIVES",
      "CONFIRM_TRANSACTION_RECORD_COMPLETE",
      "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
      "RECORD_RETENTION_CLOSURE_CHECK",
    ].sort(),
  );
  for (const key of NEVER_AUTO_COMPLETE_TASK_KEYS) {
    assert.equal(AUTOMATION_TASK_CLOSURE_POLICY[key].class, "OF_Y");
    assert.equal(AUTOMATION_TASK_CLOSURE_POLICY[key].autoCompleteOn, undefined);
  }
  assert.equal(AUTOMATION_TASK_CLOSURE_POLICY.PREPARE_PERMITTED_CLIENT_FOLLOWUP.class, "OPTIONAL");
  assert.equal(AUTOMATION_TASK_CLOSURE_POLICY.PREPARE_PERMITTED_CLIENT_FOLLOWUP.autoCompleteOn, undefined);
  assert.deepEqual(AUTOMATION_TASK_CLOSURE_POLICY.PREPARE_COMMISSION_PROCESSING_CHECKLIST.autoCompleteOn, [
    "AGENT_PAID",
    "FUNDS_RECEIVED",
    "COMMISSION_CALCULATED",
  ]);
});

test("a clean close follows milestone auto-completion, and tasks that already missed their milestone stay open", async () => {
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Closure Journey St`,
    sellerEmail: `seller-rf42-journey-${suffix}@example.com`,
    conditionsText: "",
  });
  const { propertyId, sellerPartyId, transactionId } = created;

  const active = async (taskKey: (typeof AUTOMATION_TASK_KEYS)[number], extra: Partial<typeof automationTasks.$inferInsert> = {}) =>
    insertTask({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      taskKey,
      kind: "TASK",
      title: taskKey,
      status: "ACTIVE",
      ...extra,
    });

  const contractDoc = await active("PREPARE_CONTRACT_DOCUMENTATION");
  const supersededContractDoc = await active("PREPARE_CONTRACT_DOCUMENTATION", { status: "SUPERSEDED", title: "superseded contract doc" });
  const legalReps = await active("CONFIRM_TRANSACTION_LEGAL_REPRESENTATIVES");
  const dates = await active("RECORD_TRANSACTION_DATES_CONDITIONS");
  const followup = await active("FOLLOWUP_EXCHANGE_UNCONDITIONAL_STATUS");
  const missingInfo = await active("IDENTIFY_MISSING_TRANSACTION_INFO");
  const exchangeStatus = await active("CONFIRM_CONTRACT_EXCHANGE_STATUS");
  const cancelledExchange = await active("CONFIRM_CONTRACT_EXCHANGE_STATUS", { status: "CANCELLED", title: "cancelled exchange" });
  const conditionDates = await active("CAPTURE_CONTRACT_CONDITION_DATES");
  const conditionFollowup = await active("CONDITION_DEADLINE_FOLLOWUP");
  const missingReps = await active("IDENTIFY_MISSING_LEGAL_REPRESENTATIVES");
  const settlementTracking = await active("PREPARE_SETTLEMENT_TRACKING");
  const settlementTime = await active("CONFIRM_SETTLEMENT_DATE_TIME");
  const reminder = await active("PRE_SETTLEMENT_MILESTONE_REMINDER", { kind: "REMINDER" });
  const unresolved = await active("IDENTIFY_UNRESOLVED_TRANSACTION_CONDITIONS");
  const internalSettlement = await active("PREPARE_INTERNAL_SETTLEMENT_TASKS");
  const recordComplete = await active("CONFIRM_TRANSACTION_RECORD_COMPLETE");
  const commissionChecklist = await active("PREPARE_COMMISSION_PROCESSING_CHECKLIST");
  const retention = await active("RECORD_RETENTION_CLOSURE_CHECK");
  const clientFollowup = await active("PREPARE_PERMITTED_CLIENT_FOLLOWUP", { assignedRole: "Pit Crew" });
  const propertyClosure = await active("PREPARE_PROPERTY_TRANSACTION_CLOSURE");
  const otherBrokerageTask = await insertTask({
    brokerageId: B.brokerageId,
    propertyId,
    transactionId,
    taskKey: "PREPARE_CONTRACT_DOCUMENTATION",
    kind: "TASK",
    title: "other brokerage contract doc",
    status: "ACTIVE",
  });
  const sellerAmlTask = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId: null,
    taskKey: "CONFIRM_AML_CTF_REQUIREMENTS",
    kind: "TASK",
    title: "seller aml",
    status: "ACTIVE",
  });
  const ownersTask = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId: null,
    taskKey: "VERIFY_REGISTERED_PROPERTY_OWNERS",
    kind: "TASK",
    title: "owners",
    status: "ACTIVE",
  });
  const launchTask = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId: null,
    taskKey: "PREPARE_LISTING_LAUNCH_REQUIREMENTS",
    kind: "TASK",
    title: "launch",
    status: "ACTIVE",
  });
  const campaignTask = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId: null,
    taskKey: "REQUEST_MISSING_PROPERTY_CAMPAIGN_INFO",
    kind: "TASK",
    title: "campaign",
    status: "ACTIVE",
  });

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200, await signed.text());
  assert.equal((await reloadTask(contractDoc.id)).status, "COMPLETED");
  assert.equal((await reloadTask(supersededContractDoc.id)).status, "SUPERSEDED");
  assert.equal((await reloadTask(otherBrokerageTask.id)).status, "ACTIVE");

  const lateContractDoc = await active("PREPARE_CONTRACT_DOCUMENTATION", { title: "late contract doc" });
  assert.equal((await reloadTask(lateContractDoc.id)).status, "ACTIVE");
  assert.equal((await reloadTask(lateContractDoc.id)).completedAt, null);

  const [contractEvent] = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.propertyId, propertyId), eq(domainEvents.eventType, "CONTRACT_SIGNED")));
  assert.ok(contractEvent);
  const [autoAudit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, contractDoc.id), eq(auditLogs.action, "automation_task_auto_completed")));
  assert.ok(autoAudit);
  assert.equal(autoAudit.userId, null);
  assert.equal(autoAudit.userEmail, RUN_CLOSURE_AUTO_COMPLETE_ACTOR_EMAIL);
  assert.equal(autoAudit.brokerageId, A.brokerageId);
  const autoDetail = JSON.parse(autoAudit.updatedValue ?? "{}") as {
    milestoneEventType: string;
    milestoneEventId: string;
    evidence: { contractDate?: string };
  };
  assert.equal(autoDetail.milestoneEventType, "CONTRACT_SIGNED");
  assert.equal(autoDetail.milestoneEventId, contractEvent.id);
  assert.ok(autoDetail.evidence.contractDate);

  const taskEvents = await getDomainEventsForProperty(propertyId, "TASK_COMPLETED");
  const contractTaskEvent = taskEvents.find((event) => (event.payload as { taskId?: string } | null)?.taskId === contractDoc.id);
  assert.ok(contractTaskEvent);
  assert.equal(contractTaskEvent.brokerageId, A.brokerageId);
  assert.equal(contractTaskEvent.actorType, "SYSTEM");
  assert.equal(contractTaskEvent.actorId, null);
  assert.equal(contractTaskEvent.causationId, contractEvent.id);
  const taskPayload = contractTaskEvent.payload as { milestoneEventId?: string; evidence?: { contractDate?: string }; brokerageId?: number };
  assert.equal(taskPayload.brokerageId, A.brokerageId);
  assert.equal(taskPayload.milestoneEventId, contractEvent.id);
  assert.ok(taskPayload.evidence?.contractDate);

  await clearBuyerAml(propertyId, sellerPartyId, A.agent.cookie);

  const sellerSolicitorRes = await postJson("/parties", A.agent.cookie, {
    propertyId,
    role: "Solicitor",
    firstName: "Sue",
    lastName: "SellerSolicitor",
    email: `seller-solicitor-${suffix}@example.com`,
  });
  assert.equal(sellerSolicitorRes.status, 201, await sellerSolicitorRes.text());
  const { party: sellerSolicitor } = await readJson<{ party: { id: number } }>(sellerSolicitorRes);
  const oneSide = await postJson(`/transactions/${transactionId}/legal-representatives`, A.agent.cookie, {
    sellerSolicitorPartyId: sellerSolicitor.id,
  });
  assert.equal(oneSide.status, 200, await oneSide.text());
  assert.equal((await reloadTask(legalReps.id)).status, "ACTIVE");
  assert.equal((await reloadTask(missingReps.id)).status, "ACTIVE");

  const buyerSolicitorRes = await postJson("/parties", A.agent.cookie, {
    propertyId,
    role: "Solicitor",
    firstName: "Ben",
    lastName: "BuyerSolicitor",
    email: `buyer-solicitor-${suffix}@example.com`,
  });
  assert.equal(buyerSolicitorRes.status, 201, await buyerSolicitorRes.text());
  const { party: buyerSolicitor } = await readJson<{ party: { id: number } }>(buyerSolicitorRes);
  const bothSides = await postJson(`/transactions/${transactionId}/legal-representatives`, A.agent.cookie, {
    buyerSolicitorPartyId: buyerSolicitor.id,
  });
  assert.equal(bothSides.status, 200, await bothSides.text());
  assert.equal((await reloadTask(legalReps.id)).status, "COMPLETED");
  assert.equal((await reloadTask(missingReps.id)).status, "COMPLETED");
  const [legalAudit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, legalReps.id), eq(auditLogs.action, "automation_task_auto_completed")));
  const legalDetail = JSON.parse(legalAudit.updatedValue ?? "{}") as { milestoneEventId: string };
  assert.match(legalDetail.milestoneEventId, /^\d+$/);
  const legalTaskEvent = (await getDomainEventsForProperty(propertyId, "TASK_COMPLETED")).find(
    (event) => (event.payload as { taskId?: string } | null)?.taskId === legalReps.id,
  );
  assert.ok(legalTaskEvent);
  assert.equal(legalTaskEvent.causationId, null);
  assert.equal(legalTaskEvent.brokerageId, A.brokerageId);
  assert.equal((legalTaskEvent.payload as { milestoneEventId?: string }).milestoneEventId, legalDetail.milestoneEventId);

  const exchanged = await postJson(`/transactions/${transactionId}/exchange`, A.agent.cookie);
  assert.equal(exchanged.status, 200, await exchanged.text());
  for (const id of [exchangeStatus.id, followup.id, conditionDates.id, conditionFollowup.id, unresolved.id]) {
    assert.equal((await reloadTask(id)).status, "COMPLETED", id);
  }
  assert.equal((await reloadTask(cancelledExchange.id)).status, "CANCELLED");

  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-06-01",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());
  assert.equal((await reloadTask(dates.id)).status, "COMPLETED");
  assert.equal((await reloadTask(settlementTracking.id)).status, "COMPLETED");

  const settledRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(settledRes.status, 200, await settledRes.text());
  const { transaction: settled } = await readJson<{ transaction: { grossCommissionCents: number; gstCents: number } }>(settledRes);
  const expectedCents = settled.grossCommissionCents + settled.gstCents;
  for (const id of [missingInfo.id, settlementTime.id, reminder.id, internalSettlement.id]) {
    assert.equal((await reloadTask(id)).status, "COMPLETED", id);
  }
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE", "funds and agent payment are still missing");
  assert.equal((await reloadTask(recordComplete.id)).status, "ACTIVE");
  assert.equal((await reloadTask(retention.id)).status, "ACTIVE");

  const funds = await postJson(`/transactions/${transactionId}/funds-received`, A.admin.cookie, { amountCents: expectedCents });
  assert.equal(funds.status, 200, await funds.text());
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE", "agent payment is still missing");

  const paid = await postJson(`/transactions/${transactionId}/agent-paid`, A.admin.cookie);
  assert.equal(paid.status, 200, await paid.text());
  assert.equal((await reloadTask(commissionChecklist.id)).status, "COMPLETED");
  assert.equal((await reloadTask(recordComplete.id)).status, "ACTIVE", "S1 stays manual");
  assert.equal((await reloadTask(retention.id)).status, "ACTIVE", "S3 stays manual");

  const blocked = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(blocked.status, 409);
  assert.ok(blocked.body.blockers?.some((line) => /Confirm the transaction record is complete|CONFIRM_TRANSACTION_RECORD_COMPLETE/.test(line)));
  assert.ok(blocked.body.blockers?.some((line) => /RECORD_RETENTION_CLOSURE_CHECK/.test(line)));

  const completeRecord = await postJson(`/tasks/${recordComplete.id}/complete`, A.agent.cookie);
  assert.equal(completeRecord.status, 200, await completeRecord.text());
  const completeRetention = await postJson(`/tasks/${retention.id}/complete`, A.agent.cookie);
  assert.equal(completeRetention.status, 200, await completeRetention.text());

  const closed = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(closed.status, 200, closed.text);
  assert.equal((await reloadTask(propertyClosure.id)).status, "COMPLETED");
  assert.equal((await reloadTask(clientFollowup.id)).status, "ACTIVE");
  assert.equal((await reloadTask(clientFollowup.id)).completedAt, null);
  assert.equal((await reloadTask(lateContractDoc.id)).status, "ACTIVE");
  assert.equal((await reloadTask(lateContractDoc.id)).completedAt, null);
  assert.equal((await reloadTask(otherBrokerageTask.id)).status, "ACTIVE");
  for (const id of [sellerAmlTask.id, ownersTask.id, launchTask.id, campaignTask.id]) {
    assert.equal((await reloadTask(id)).status, "ACTIVE", "listing and seller AML already happened, so these rows are not rewritten");
  }

  const followupList = await getJson(`/tasks/by-property/${propertyId}`, A.agent.cookie);
  assert.equal(followupList.status, 200);
  const { tasks: visible } = await readJson<{ tasks: Array<{ id: string; assignedRole: string | null }> }>(followupList);
  assert.ok(visible.some((task) => task.id === clientFollowup.id && task.assignedRole === "Pit Crew"));

  const [listingEvent] = await getDomainEventsForProperty(propertyId, "LISTING_LIVE");
  assert.ok(listingEvent);
  await completeSatisfiedAutomationTasks({
    brokerageId: listingEvent.brokerageId!,
    propertyId,
    transactionId: listingEvent.transactionId,
    eventType: "LISTING_LIVE",
    eventId: listingEvent.id,
    correlationId: listingEvent.correlationId,
  });
  const [amlEvent] = await getDomainEventsForProperty(propertyId, "AML_COMPLETED");
  assert.ok(amlEvent);
  await completeSatisfiedAutomationTasks({
    brokerageId: amlEvent.brokerageId!,
    propertyId,
    transactionId: amlEvent.transactionId,
    eventType: "AML_COMPLETED",
    eventId: amlEvent.id,
    correlationId: amlEvent.correlationId,
  });
  for (const id of [ownersTask.id, launchTask.id, campaignTask.id, sellerAmlTask.id]) {
    assert.equal((await reloadTask(id)).status, "COMPLETED", id);
  }
  assert.equal((await reloadTask(lateContractDoc.id)).status, "ACTIVE");
});

test("final close honours the financial and seller-AML blocks, manual S2 evidence, tenant isolation, and Pit Crew visibility", async () => {
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Closure Blockers St`,
    sellerEmail: `seller-rf42-blockers-${suffix}@example.com`,
    conditionsText: "",
  });
  const { propertyId, sellerPartyId, transactionId } = created;

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200, await signed.text());
  await clearBuyerAml(propertyId, sellerPartyId, A.agent.cookie);
  const exchanged = await postJson(`/transactions/${transactionId}/exchange`, A.agent.cookie);
  assert.equal(exchanged.status, 200, await exchanged.text());
  const scheduled = await postJson(`/transactions/${transactionId}/settlement-schedule`, A.agent.cookie, {
    settlementDate: "2027-07-01",
  });
  assert.equal(scheduled.status, 200, await scheduled.text());
  const settledRes = await postJson(`/transactions/${transactionId}/settlement-complete`, A.admin.cookie);
  assert.equal(settledRes.status, 200, await settledRes.text());
  const { transaction: settled } = await readJson<{
    transaction: { grossCommissionCents: number; gstCents: number; commissionCalculatedAt: string };
  }>(settledRes);
  const expectedCents = settled.grossCommissionCents + settled.gstCents;
  const funds = await postJson(`/transactions/${transactionId}/funds-received`, A.admin.cookie, { amountCents: expectedCents });
  assert.equal(funds.status, 200, await funds.text());
  const paid = await postJson(`/transactions/${transactionId}/agent-paid`, A.admin.cookie);
  assert.equal(paid.status, 200, await paid.text());

  // Holds final close open until the financial cases and manual S2 are done.
  const recordComplete = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    taskKey: "CONFIRM_TRANSACTION_RECORD_COMPLETE",
    kind: "TASK",
    title: "Confirm the transaction record is complete",
    status: "ACTIVE",
  });

  const [sellerAml] = await db
    .select()
    .from(amlVerifications)
    .where(and(eq(amlVerifications.propertyId, propertyId), eq(amlVerifications.partyId, sellerPartyId)));
  assert.equal(sellerAml.status, "Complete");
  await db.update(amlVerifications).set({ status: "Review Required" }).where(eq(amlVerifications.id, sellerAml.id));
  const sellerBlocked = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(sellerBlocked.status, 409);
  assert.ok(sellerBlocked.body.blockers?.some((line) => /seller part/i.test(line)));
  await db.update(amlVerifications).set({ status: "Complete" }).where(eq(amlVerifications.id, sellerAml.id));

  await db.update(transactions).set({ commissionCalculatedAt: null }).where(eq(transactions.id, transactionId));
  const commissionBlocked = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(commissionBlocked.status, 409);
  assert.ok(commissionBlocked.body.blockers?.some((line) => line === "Commission has not been calculated."));
  assert.ok(commissionBlocked.body.blockers?.some((line) => /COMMISSION_NOT_CALCULATED/.test(line)));
  await db
    .update(transactions)
    .set({ commissionCalculatedAt: new Date(settled.commissionCalculatedAt) })
    .where(eq(transactions.id, transactionId));

  await db.update(transactions).set({ fundsReceivedCents: 1 }).where(eq(transactions.id, transactionId));
  const partial = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(partial.status, 409);
  assert.ok(partial.body.blockers?.some((line) => /Funds reconciliation is PARTIAL, not MATCHED/.test(line)));
  await db.update(transactions).set({ fundsReceivedCents: expectedCents + 1 }).where(eq(transactions.id, transactionId));
  const over = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(over.status, 409);
  assert.ok(over.body.blockers?.some((line) => /Funds reconciliation is OVER_RECEIVED, not MATCHED/.test(line)));
  await db.update(transactions).set({ fundsReceivedCents: expectedCents }).where(eq(transactions.id, transactionId));

  const [paymentRequest] = await db
    .insert(financialPaymentRequests)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      amountCents: 1000,
      status: "DISPUTED",
    })
    .returning();
  const [dispute] = await db
    .insert(financialDisputes)
    .values({
      brokerageId: A.brokerageId,
      paymentRequestId: paymentRequest.id,
      disputedAmountCents: 1000,
      reason: "Commission figure disputed",
      status: "OPEN",
    })
    .returning();
  const disputed = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(disputed.status, 409);
  assert.ok(disputed.body.blockers?.some((line) => /FIN02/.test(line)));
  await db.update(financialDisputes).set({ status: "RESOLVED_PAYABLE" }).where(eq(financialDisputes.id, dispute.id));
  const disputeCleared = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(disputeCleared.status, 409, disputeCleared.text);
  assert.equal(disputeCleared.body.blockers?.some((line) => /FIN02/.test(line)) ?? false, false);

  await db.insert(financialReconciliations).values({
    brokerageId: A.brokerageId,
    recordType: "LEGACY_TRANSACTION_COMMISSION",
    recordId: String(transactionId),
    status: "UNRECONCILED",
    differenceCents: null,
  });

  const [agreement] = await db
    .insert(commissionAgreements)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      method: "PERCENTAGE",
      rateBps: 220,
    })
    .returning();
  const [calculation] = await db
    .insert(commissionCalculations)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      transactionId,
      commissionAgreementId: agreement.id,
      salePriceCentsInput: 80000000,
      methodUsed: "PERCENTAGE",
      grossCommissionCents: settled.grossCommissionCents - 1,
      commissionExGstCents: settled.grossCommissionCents - 1,
      gstCents: settled.gstCents,
      state: "ESTIMATE",
    })
    .returning();
  const mismatched = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(mismatched.status, 409);
  assert.ok(mismatched.body.blockers?.some((line) => /does not reconcile/.test(line)));
  await db
    .update(commissionCalculations)
    .set({ grossCommissionCents: settled.grossCommissionCents, commissionExGstCents: settled.grossCommissionCents })
    .where(eq(commissionCalculations.id, calculation.id));

  const commissionChecklist = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    taskKey: "PREPARE_COMMISSION_PROCESSING_CHECKLIST",
    kind: "TASK",
    title: "Prepare commission-processing checklist",
    status: "ACTIVE",
  });
  const stillMismatchedCleared = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(stillMismatchedCleared.status, 409);
  assert.equal(stillMismatchedCleared.body.blockers?.some((line) => /does not reconcile/.test(line)) ?? false, false);
  assert.ok(stillMismatchedCleared.body.blockers?.some((line) => /Prepare commission-processing checklist/.test(line)));

  const foreignClose = await closeAttempt(transactionId, B.admin.cookie);
  assert.equal(foreignClose.status, 404);
  const foreignComplete = await postJson(`/tasks/${commissionChecklist.id}/complete`, B.admin.cookie, {
    manualEvidence: { amountCents: expectedCents, date: "2026-10-01", paymentMethod: "EFT", reference: "EXT-1" },
  });
  assert.equal(foreignComplete.status, 404);
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE");

  const bare = await postJson(`/tasks/${commissionChecklist.id}/complete`, A.admin.cookie);
  assert.equal(bare.status, 400);
  const bareBody = await readJson<{ error: string }>(bare);
  assert.match(bareBody.error, /requires amountCents, date, paymentMethod, and reference/);
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE");

  const agentAttempt = await postJson(`/tasks/${commissionChecklist.id}/complete`, A.agent.cookie, {
    manualEvidence: { amountCents: expectedCents, date: "2026-10-01", paymentMethod: "EFT", reference: "EXT-AGENT" },
  });
  assert.equal(agentAttempt.status, 400);
  const agentBody = await readJson<{ error: string }>(agentAttempt);
  assert.match(agentBody.error, /Brokerage Administrator/);
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE");

  const wrongAmount = await postJson(`/tasks/${commissionChecklist.id}/complete`, A.admin.cookie, {
    manualEvidence: { amountCents: expectedCents + 1, date: "2026-10-01", paymentMethod: "EFT", reference: "EXT-WRONG" },
  });
  assert.equal(wrongAmount.status, 400);
  const wrongBody = await readJson<{ error: string }>(wrongAmount);
  assert.match(wrongBody.error, /must equal commission plus GST/);
  const rejectedAudits = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, commissionChecklist.id), eq(auditLogs.action, "automation_task_completed")));
  assert.equal(rejectedAudits.length, 0);
  assert.equal((await reloadTask(commissionChecklist.id)).status, "ACTIVE");

  const accepted = await postJson(`/tasks/${commissionChecklist.id}/complete`, A.admin.cookie, {
    manualEvidence: { amountCents: expectedCents, date: "2026-10-01", paymentMethod: "EFT", reference: "EXT-1001" },
  });
  assert.equal(accepted.status, 200, await accepted.text());
  assert.equal((await reloadTask(commissionChecklist.id)).status, "COMPLETED");
  const [manualAudit] = await db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.recordId, commissionChecklist.id), eq(auditLogs.action, "automation_task_completed")));
  assert.ok(manualAudit);
  assert.equal(manualAudit.userId, A.admin.user.id);
  assert.equal(manualAudit.brokerageId, A.brokerageId);
  const stored = JSON.parse(manualAudit.updatedValue ?? "{}") as {
    kind: string;
    amountCents: number;
    date: string;
    paymentMethod: string;
    reference: string;
    expectedCents: number;
    reconciled: boolean;
  };
  assert.equal(stored.kind, "manual_commission_sign_off");
  assert.equal(stored.amountCents, expectedCents);
  assert.equal(stored.date, "2026-10-01");
  assert.equal(stored.paymentMethod, "EFT");
  assert.equal(stored.reference, "EXT-1001");
  assert.equal(stored.expectedCents, expectedCents);
  assert.equal(stored.reconciled, true);

  const unassignedFinding: RiskFinding = {
    ruleId: "TEST_RF42_UNASSIGNED",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: "Unassigned routine exception",
    problemDescription: "Needs an owner.",
    businessImpact: "Visible work with nobody responsible.",
    detectedCause: "Test.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId,
    transactionId,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Assign an owner.",
    resolutionRequirements: "An owner is assigned.",
    dismissible: true,
    sourceRecordType: "transaction",
    sourceRecordId: String(transactionId),
    dedupKey: `TEST_RF42_UNASSIGNED:${transactionId}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
  const unassigned = await createOrUpdateException(unassignedFinding, A.brokerageId, propertyId, transactionId, newCorrelationId(), null);
  const unassignedBlocked = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(unassignedBlocked.status, 409);
  assert.ok(unassignedBlocked.body.blockers?.some((line) => /need an assigned owner/.test(line)));
  await db
    .update(riskExceptions)
    .set({ ownerType: "LISTING_AGENT", ownerUserId: A.agent.user.id })
    .where(eq(riskExceptions.id, unassigned.exception.id));

  const completeRecord = await postJson(`/tasks/${recordComplete.id}/complete`, A.agent.cookie);
  assert.equal(completeRecord.status, 200, await completeRecord.text());

  const followup = await insertTask({
    brokerageId: A.brokerageId,
    propertyId,
    transactionId,
    taskKey: "PREPARE_PERMITTED_CLIENT_FOLLOWUP",
    kind: "TASK",
    title: "Prepare permitted client follow-up",
    assignedRole: "Pit Crew",
    status: "ACTIVE",
  });
  const assignedFinding: RiskFinding = {
    ...unassignedFinding,
    ruleId: "TEST_RF42_ASSIGNED",
    title: "Assigned routine exception",
    ownerType: "PIT_CREW",
    ownerUserId: pitCrew.user.id,
    dedupKey: `TEST_RF42_ASSIGNED:${transactionId}`,
  };
  const assigned = await createOrUpdateException(assignedFinding, A.brokerageId, propertyId, transactionId, newCorrelationId(), null);
  await db.insert(pitCrewAssignments).values({
    brokerageId: A.brokerageId,
    sourceType: "EXCEPTION",
    sourceRecordId: assigned.exception.id,
    propertyId,
    status: "IN_PROGRESS",
    assignedToUserId: pitCrew.user.id,
    version: 1,
  });

  const closed = await closeAttempt(transactionId, A.admin.cookie);
  assert.equal(closed.status, 200, closed.text);

  const list = await getJson(`/tasks/by-property/${propertyId}`, A.agent.cookie);
  assert.equal(list.status, 200);
  const { tasks } = await readJson<{ tasks: Array<{ id: string; assignedRole: string | null; status: string }> }>(list);
  const visibleFollowup = tasks.find((task) => task.id === followup.id);
  assert.ok(visibleFollowup);
  assert.equal(visibleFollowup.assignedRole, "Pit Crew");
  assert.equal((await reloadTask(followup.id)).status, "ACTIVE");
  assert.equal((await reloadTask(followup.id)).completedAt, null);

  const workspace = await getPitCrewWorkspace(A.brokerageId, pitCrew.user.id);
  const item = [...workspace.myWork, ...workspace.teamWork].find((row) => row.sourceRecordId === assigned.exception.id);
  assert.ok(item, "an assigned non-financial exception stays in Pit Crew after close");
  assert.equal(item.ownerType, "PIT_CREW");
  assert.equal(item.ownerUserId, pitCrew.user.id);
  assert.equal(item.assignedToUserId, pitCrew.user.id);
  assert.equal(item.exceptionStatus, "OPEN");
});
