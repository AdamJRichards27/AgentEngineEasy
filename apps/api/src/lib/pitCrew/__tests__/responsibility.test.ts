// R-F15 PR 2 — hand-back and escalate library safety tests.
// Real risk_exceptions rows, same fixture shape as assignment.test.ts.
// The flag stays the literal "true" for the suite and is restored after.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  communicationMessages,
  db,
  domainEvents,
  financialPaymentOutbox,
  financialPaymentRequests,
  pitCrewAssignments,
  pitCrewResponsibilityEvents,
  riskExceptions,
  transactions,
  users,
} from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { claimWorkItem, completeWorkItem, handoffWorkItem, setWaitingOn, PitCrewTransitionError, PitCrewConcurrencyError, PitCrewPropertyMismatchError, PitCrewAssigneeMismatchError } from "../assignment.js";
import { getPitCrewWorkspace } from "../queries.js";
import {
  PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG,
  acknowledgeEscalation,
  escalateWorkItem,
  handBackWorkItem,
  reclaimHandedBack,
  resolveEscalation,
  resolveResponsibilityRecipient,
  returnEscalation,
  PitCrewResponsibilityDisabledError,
  PitCrewResponsibilityForbiddenError,
  PitCrewResponsibilityValidationError,
} from "../responsibility.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

const FORBIDDEN_IMPORT_SUFFIXES = [
  "exceptions/model.js",
  "transactions.js",
  "offers.js",
  "transactionConditions.js",
  "communications/messages.js",
  "communications/outbox.js",
  "integrations/commsProof.js",
  "financial/communications.js",
  "financial/settlement.js",
  "financial/agreements.js",
  "financial/paymentOutbox.js",
  "financial/pcFeeCalculations.js",
  "financial/pcFeeAuthorities.js",
  "financial/events.js",
  "launch/model.js",
  "integrations/launchProof.js",
  "ai/actionRequests.js",
  "automation/rules.js",
];

const FORBIDDEN_CALLS = [
  "acknowledgeException",
  "startRemediation",
  "markAwaitingExternal",
  "resolveExceptionManually",
  "dismissException",
  "reassignOwner",
  "acceptOffer",
  "recordContractSigned",
  "recordFinanceApproved",
  "scheduleSettlement",
  "completeSettlement",
  "recordFundsReceived",
  "recordAgentPaid",
  "recordLegalRepresentatives",
  "closeTransaction",
  "calculateCommission",
  "withdrawOffer",
  "declineOffer",
  "resolveCondition",
  "maybeRecordUnconditional",
  "addCondition",
  "rescheduleConditionDueDate",
  "sendMessageNow",
  "approveMessage",
  "dispatchMessage",
  "dispatchDueMessages",
  "sendSmsViaIntegration",
  "notifyFinancialEvent",
  "finalizeCommissionForSettlement",
  "ensurePcSuccessFeeRequest",
  "approveCommissionAgreement",
  "createCommissionAgreement",
  "cancelCommissionAgreement",
  "scheduleDebitForPaymentRequest",
  "dispatchOutboxEntry",
  "dispatchPendingPaymentOutbox",
  "cancelScheduledDebit",
  "reverseDebit",
  "createPcFeeCalculation",
  "activatePcFeeAuthority",
  "revokePcFeeAuthority",
  "createPcFeeAuthority",
  "emitFinancialEvent",
  "decideVendorApproval",
  "publishListingToMockPortal",
  "approveAIActionRequest",
  "approveAndActivateRuleVersion",
  "dispatchOperationalAlert",
];

test("responsibility.ts does not import or call the forbidden writers", () => {
  const source = readFileSync(new URL("../responsibility.ts", import.meta.url), "utf8");
  for (const suffix of FORBIDDEN_IMPORT_SUFFIXES) {
    assert.equal(source.includes(suffix), false, `responsibility.ts must not reference ${suffix}`);
  }
  for (const name of FORBIDDEN_CALLS) {
    assert.equal(source.includes(name), false, `responsibility.ts must not reference ${name}`);
  }
});

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

describe("pit crew responsibility actions", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  let admin: DevLoginResult;
  let secondAdmin: DevLoginResult;
  let agent: DevLoginResult;
  let secondAgent: DevLoginResult;
  let pitCrew: DevLoginResult;
  let brokerageId: number;
  let otherBrokerageId: number;
  let orphanBrokerageId: number;
  let propertyId: number;
  let foreignAdmin: DevLoginResult;
  let fixtureCounter = 0;
  let savedFlag: string | undefined;

  function buildFinding(overrides: Partial<RiskFinding> = {}): RiskFinding {
    fixtureCounter += 1;
    return {
      ruleId: "TEST_PITCREW_RESPONSIBILITY_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `Test PC responsibility finding ${fixtureCounter}`,
      problemDescription: "A test problem.",
      businessImpact: "Test impact.",
      detectedCause: "Test cause.",
      ownerType: "UNASSIGNED_QUEUE",
      ownerUserId: null,
      propertyId,
      transactionId: null,
      dueAt: null,
      escalatesAt: null,
      recommendedAction: "Do the test thing.",
      resolutionRequirements: "The test condition clears.",
      dismissible: true,
      sourceRecordType: "property",
      sourceRecordId: String(propertyId),
      dedupKey: `TEST_PITCREW_RESPONSIBILITY_RULE:${brokerageId}:RESPONSIBILITY_${fixtureCounter}`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
      ...overrides,
    };
  }

  async function createException(overrides: Partial<RiskFinding> = {}): Promise<string> {
    const result = await createOrUpdateException(buildFinding(overrides), brokerageId, propertyId, null, newCorrelationId(), null);
    return result.exception.id;
  }

  async function createProperty(cookie: string, address: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
    const { property } = (await res.json()) as { property: { id: number } };
    return property.id;
  }

  function base(sourceRecordId: string, user: DevLoginResult, expectedVersion: number) {
    return {
      brokerageId,
      propertyId,
      sourceType: "EXCEPTION" as const,
      sourceRecordId,
      expectedVersion,
      actorUserId: user.user.id,
      actorEmail: user.user.email,
    };
  }

  async function claim(sourceRecordId: string, user: DevLoginResult = pitCrew) {
    return claimWorkItem({ ...base(sourceRecordId, user, 0) });
  }

  async function sideEffects(exceptionId: string) {
    const [exception] = await db
      .select({
        status: riskExceptions.status,
        ownerType: riskExceptions.ownerType,
        ownerUserId: riskExceptions.ownerUserId,
      })
      .from(riskExceptions)
      .where(eq(riskExceptions.id, exceptionId));
    const txs = await db.select().from(transactions).where(eq(transactions.propertyId, propertyId));
    const messages = await db
      .select({ id: communicationMessages.id })
      .from(communicationMessages)
      .where(and(eq(communicationMessages.brokerageId, brokerageId), eq(communicationMessages.propertyId, propertyId)));
    const payments = await db
      .select({ id: financialPaymentRequests.id })
      .from(financialPaymentRequests)
      .where(and(eq(financialPaymentRequests.brokerageId, brokerageId), eq(financialPaymentRequests.propertyId, propertyId)));
    const outbox = await db
      .select({ id: financialPaymentOutbox.id })
      .from(financialPaymentOutbox)
      .where(eq(financialPaymentOutbox.brokerageId, brokerageId));
    const domain = await db.select({ id: domainEvents.id }).from(domainEvents).where(eq(domainEvents.propertyId, propertyId));
    return { exception, txs, messageIds: messages.map((row) => row.id), paymentIds: payments.map((row) => row.id), outboxIds: outbox.map((row) => row.id), domainIds: domain.map((row) => row.id) };
  }

  async function openEvents(assignmentId: number) {
    return db
      .select()
      .from(pitCrewResponsibilityEvents)
      .where(
        and(
          eq(pitCrewResponsibilityEvents.assignmentId, assignmentId),
          inArray(pitCrewResponsibilityEvents.status, ["OPEN", "ACKNOWLEDGED"]),
        ),
      );
  }

  function pitCrewSeries(): Array<{ boundary: string; value: number }> {
    const found: Array<{ boundary: string; value: number }> = [];
    for (const line of renderMetricsText().split("\n")) {
      if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
      const match = /^tenant_isolation_rejection_total\{boundary="([^"]*)"\} (\d+)$/.exec(line);
      assert.ok(match, `unparsed metric line: ${line}`);
      found.push({ boundary: match[1], value: Number(match[2]) });
    }
    return found;
  }

  before(async () => {
    savedFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    const { configureEvents } = await import("../../events.js");
    configureEvents();
    const { createApp } = await import("../../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await createBrokerageWithUsers(baseUrl, `PitCrew Responsibility ${Date.now()}`);
    admin = created.admin;
    agent = created.agent;
    brokerageId = created.brokerageId;
    propertyId = await createProperty(agent.cookie, "1 Responsibility Test St");

    pitCrew = await devLogin(baseUrl, {
      email: `pitcrew-rf15-${brokerageId}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: created.admin.user.brokerageName!,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

    secondAgent = await devLogin(baseUrl, {
      email: `agent2-rf15-${brokerageId}@example.com`,
      firstName: "Second",
      lastName: "Agent",
      brokerageName: created.admin.user.brokerageName!,
    });

    const orphan = await devLogin(baseUrl, {
      email: `admin2-rf15-${brokerageId}@example.com`,
      firstName: "Second",
      lastName: "Admin",
      brokerageName: `PitCrew Responsibility Orphan ${Date.now()}`,
    });
    orphanBrokerageId = orphan.user.brokerageId;
    await db.update(users).set({ brokerageId }).where(eq(users.id, orphan.user.id));
    secondAdmin = { cookie: orphan.cookie, user: { ...orphan.user, brokerageId } };

    const other = await createBrokerageWithUsers(baseUrl, `PitCrew Responsibility Other ${Date.now()}`);
    otherBrokerageId = other.brokerageId;
    foreignAdmin = other.admin;
  });

  after(async () => {
    if (savedFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
    await cleanupBrokerages([brokerageId, otherBrokerageId, orphanBrokerageId]);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test("flag off refuses every new function before a responsibility write", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    const calls = [
      () => handBackWorkItem({ ...base(sourceRecordId, pitCrew, claimed.version), reasonCategory: "WORK_COMPLETE", nextAction: "Review the returned evidence." }),
      () => escalateWorkItem({ ...base(sourceRecordId, pitCrew, claimed.version), reasonCategory: "MISSING_AUTHORITY", severity: "ATTENTION", note: "Outside authority.", nextAction: "Decide the next step." }),
      () => acknowledgeEscalation(base(sourceRecordId, admin, claimed.version)),
      () => resolveEscalation({ ...base(sourceRecordId, admin, claimed.version), note: "Resolved in test." }),
      () => returnEscalation({ ...base(sourceRecordId, admin, claimed.version), note: "Returned in test." }),
      () => reclaimHandedBack(base(sourceRecordId, pitCrew, claimed.version)),
      () => resolveResponsibilityRecipient({ kind: "HAND_BACK", brokerageId, propertyId: -1 }),
    ];
    try {
      for (const value of [undefined, "TRUE", "1", "yes", " true"] as const) {
        if (value === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
        else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = value;
        for (const call of calls) {
          await assert.rejects(call, (err: unknown) => {
            assert.ok(err instanceof PitCrewResponsibilityDisabledError);
            assert.equal(err.message, "Not found.");
            return true;
          });
        }
      }
    } finally {
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    }
    const events = await db
      .select()
      .from(pitCrewResponsibilityEvents)
      .where(eq(pitCrewResponsibilityEvents.assignmentId, claimed.id));
    assert.equal(events.length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
    assert.equal(row?.version, claimed.version);
  });

  test("hand-back and escalate leave the exception, transaction, messages, and payments unchanged", async () => {
    const handBackId = await createException({ ownerType: "PIT_CREW", ownerUserId: pitCrew.user.id });
    const escalateId = await createException({ ownerType: "PIT_CREW", ownerUserId: pitCrew.user.id });
    const beforeHandBack = await sideEffects(handBackId);
    const beforeEscalate = await sideEffects(escalateId);
    let claimed = await claim(handBackId);
    const handed = await handBackWorkItem({
      ...base(handBackId, pitCrew, claimed.version),
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Review the returned condition evidence and confirm the next step.",
    });
    claimed = await claim(escalateId);
    const escalated = await escalateWorkItem({
      ...base(escalateId, pitCrew, claimed.version),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "AT_RISK",
      note: "Settlement figure is outside Pit Crew authority.",
      nextAction: "Decide whether the brokerage will authorise the next settlement step.",
      expectedResponseAt: new Date("2026-10-01T04:00:00.000Z"),
    });

    const afterHandBack = await sideEffects(handBackId);
    const afterEscalate = await sideEffects(escalateId);
    assert.deepEqual(afterHandBack.exception, beforeHandBack.exception);
    assert.deepEqual(afterEscalate.exception, beforeEscalate.exception);
    assert.equal(afterHandBack.exception?.status, "OPEN");
    assert.equal(afterHandBack.exception?.ownerType, "PIT_CREW");
    assert.equal(afterHandBack.exception?.ownerUserId, pitCrew.user.id);
    assert.deepEqual(afterHandBack.txs, beforeHandBack.txs);
    assert.deepEqual(afterEscalate.txs, beforeEscalate.txs);
    assert.deepEqual(afterHandBack.messageIds, beforeHandBack.messageIds);
    assert.deepEqual(afterEscalate.messageIds, beforeEscalate.messageIds);
    assert.deepEqual(afterHandBack.paymentIds, beforeHandBack.paymentIds);
    assert.deepEqual(afterEscalate.paymentIds, beforeEscalate.paymentIds);
    assert.deepEqual(afterHandBack.outboxIds, beforeHandBack.outboxIds);
    assert.deepEqual(afterEscalate.outboxIds, beforeEscalate.outboxIds);
    assert.deepEqual(afterHandBack.domainIds, beforeHandBack.domainIds);
    assert.deepEqual(afterEscalate.domainIds, beforeEscalate.domainIds);

    assert.equal(handed.assignment.status, "HANDED_BACK");
    assert.equal(handed.assignment.assignedToUserId, null);
    assert.equal(handed.assignment.claimedAt, null);
    assert.equal(handed.assignment.completedAt, null);
    assert.equal(handed.responsibilityEvent.kind, "HAND_BACK");
    assert.equal(handed.responsibilityEvent.status, "OPEN");
    assert.equal(handed.responsibilityEvent.recipientUserId, agent.user.id);
    assert.equal(handed.responsibilityEvent.recipientRole, null);
    assert.equal(handed.responsibilityEvent.resultingResponsibility, "AGENT");
    assert.equal(handed.responsibilityEvent.severity, null);
    assert.equal(handed.responsibilityEvent.expectedResponseAt, null);

    assert.equal(escalated.assignment.status, "ESCALATED");
    assert.equal(escalated.assignment.assignedToUserId, pitCrew.user.id);
    assert.equal(escalated.assignment.completedAt, null);
    assert.equal(escalated.responsibilityEvent.kind, "ESCALATION");
    assert.equal(escalated.responsibilityEvent.recipientUserId, null);
    assert.equal(escalated.responsibilityEvent.recipientRole, "Brokerage Administrator");
    assert.equal(escalated.responsibilityEvent.resultingResponsibility, "BROKERAGE_ADMINISTRATOR");
    assert.equal(escalated.responsibilityEvent.severity, "AT_RISK");
    assert.ok(escalated.responsibilityEvent.expectedResponseAt);

    const [handAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, handBackId), eq(auditLogs.action, "PC_HANDED_BACK")));
    assert.equal(handAudit?.brokerageId, brokerageId);
    assert.equal(handAudit?.propertyId, propertyId);
    assert.equal(handAudit?.recordType, "EXCEPTION");
    assert.equal(handAudit?.previousValue, "CLAIMED");
    assert.equal(handAudit?.updatedValue, "HANDED_BACK");
    assert.equal(handAudit?.userId, pitCrew.user.id);
    const [escalateAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, escalateId), eq(auditLogs.action, "PC_ESCALATED")));
    assert.equal(escalateAudit?.brokerageId, brokerageId);
    assert.equal(escalateAudit?.propertyId, propertyId);
    assert.equal(escalateAudit?.previousValue, "CLAIMED");
    assert.equal(escalateAudit?.updatedValue, "ESCALATED");
  });

  test("DONE and UNCLAIMED reject hand-back and escalate", async () => {
    for (const run of [handBackWorkItem, escalateWorkItem] as const) {
      const freshId = await createException();
      const body = run === handBackWorkItem
        ? { reasonCategory: "WORK_COMPLETE", nextAction: "Review the returned evidence." }
        : { reasonCategory: "MISSING_INFORMATION", severity: "ATTENTION", note: "The figure is missing.", nextAction: "Supply the missing figure." };
      await assert.rejects(run({ ...base(freshId, pitCrew, 0), ...body } as never), PitCrewTransitionError);
      const [freshRow] = await db.select().from(pitCrewAssignments).where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, freshId)));
      if (freshRow) {
        const freshEvents = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.assignmentId, freshRow.id));
        assert.equal(freshEvents.length, 0);
      }
      const doneId = await createException();
      let row = await claim(doneId);
      row = await completeWorkItem({ ...base(doneId, pitCrew, row.version) });
      await assert.rejects(run({ ...base(doneId, pitCrew, row.version), ...body } as never), PitCrewTransitionError);
      const events = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.assignmentId, row.id));
      assert.equal(events.length, 0);
      const [after] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, row.id));
      assert.equal(after?.status, "DONE");
    }
  });

  test("a recipient in another brokerage increments the pit_crew isolation counter once and writes nothing", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    resetMetricsForTesting();
    await assert.rejects(
      handBackWorkItem({
        ...base(sourceRecordId, pitCrew, claimed.version),
        reasonCategory: "NEXT_ACTION_WITH_AGENT",
        nextAction: "Review the returned evidence.",
        recipientUserId: foreignAdmin.user.id,
      }),
      PitCrewAssigneeMismatchError,
    );
    const series = pitCrewSeries();
    assert.equal(series.length, 1);
    assert.equal(series[0]?.boundary, "pit_crew");
    assert.equal(series[0]?.value, 1);
    const events = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.assignmentId, claimed.id));
    assert.equal(events.length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
    assert.equal(row?.version, claimed.version);

    resetMetricsForTesting();
    await assert.rejects(
      handBackWorkItem({
        ...base(sourceRecordId, pitCrew, claimed.version),
        reasonCategory: "NEXT_ACTION_WITH_AGENT",
        nextAction: "Review the returned evidence.",
        recipientUserId: pitCrew.user.id,
      }),
      PitCrewResponsibilityValidationError,
    );
    assert.deepEqual(pitCrewSeries(), []);
  });

  test("a stale expectedVersion leaves no OPEN event and no hand-back audit", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    await assert.rejects(
      handBackWorkItem({
        ...base(sourceRecordId, pitCrew, 999),
        reasonCategory: "INFORMATION_RETURNED",
        nextAction: "Review the returned evidence.",
      }),
      PitCrewConcurrencyError,
    );
    assert.equal((await openEvents(claimed.id)).length, 0);
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, sourceRecordId), eq(auditLogs.action, "PC_HANDED_BACK")));
    assert.equal(audits.length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
    assert.equal(row?.version, claimed.version);
  });

  test("a non-EXCEPTION source is rejected before an overlay row is created", async () => {
    const sourceRecordId = `not-an-exception-${Date.now()}`;
    await assert.rejects(
      handBackWorkItem({
        ...base(sourceRecordId, pitCrew, 0),
        sourceType: "OFFER",
        reasonCategory: "WORK_COMPLETE",
        nextAction: "Review the returned evidence.",
      }),
      PitCrewPropertyMismatchError,
    );
    const rows = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.sourceRecordId, sourceRecordId));
    assert.equal(rows.length, 0);
  });

  test("hand-back from WAITING_ON clears waiting-on, keeps the last handoff, and can name another Agent", async () => {
    const sourceRecordId = await createException();
    let row = await claim(sourceRecordId);
    row = await handoffWorkItem({
      ...base(sourceRecordId, pitCrew, row.version),
      toUserId: admin.user.id,
      note: "Covering the file",
    });
    row = await setWaitingOn({
      ...base(sourceRecordId, pitCrew, row.version),
      waitingOnParty: "Buyer's solicitor",
      waitingOnNote: "Chasing the contract",
      waitingOnExpectedAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    const handed = await handBackWorkItem({
      ...base(sourceRecordId, pitCrew, row.version),
      reasonCategory: "NOT_PIT_CREW_WORK",
      nextAction: "The agent confirms whether this stays with the brokerage.",
      recipientUserId: secondAgent.user.id,
      note: "Returned with the evidence attached.",
    });
    assert.equal(handed.assignment.status, "HANDED_BACK");
    assert.equal(handed.assignment.waitingOnParty, null);
    assert.equal(handed.assignment.waitingOnNote, null);
    assert.equal(handed.assignment.waitingOnSince, null);
    assert.equal(handed.assignment.waitingOnExpectedAt, null);
    assert.equal(handed.assignment.handoffFromUserId, pitCrew.user.id);
    assert.equal(handed.assignment.handoffToUserId, admin.user.id);
    assert.equal(handed.assignment.completedAt, null);
    assert.equal(handed.responsibilityEvent.recipientUserId, secondAgent.user.id);
    assert.equal(handed.responsibilityEvent.note, "Returned with the evidence attached.");
  });

  test("one open event per assignment, and reclaim supersedes the hand-back", async () => {
    const sourceRecordId = await createException();
    let row = await claim(sourceRecordId);
    const handed = await handBackWorkItem({
      ...base(sourceRecordId, pitCrew, row.version),
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Review the returned evidence.",
    });
    assert.equal((await openEvents(handed.assignment.id)).length, 1);
    await assert.rejects(
      handBackWorkItem({
        ...base(sourceRecordId, pitCrew, handed.assignment.version),
        reasonCategory: "WORK_COMPLETE",
        nextAction: "Review the returned evidence again.",
      }),
      PitCrewTransitionError,
    );
    await assert.rejects(
      escalateWorkItem({
        ...base(sourceRecordId, pitCrew, handed.assignment.version),
        reasonCategory: "BLOCKED_DEPENDENCY",
        severity: "ATTENTION",
        note: "Still blocked.",
        nextAction: "Clear the dependency.",
      }),
      PitCrewTransitionError,
    );
    assert.equal((await openEvents(handed.assignment.id)).length, 1);

    const reclaimed = await reclaimHandedBack(base(sourceRecordId, pitCrew, handed.assignment.version));
    assert.equal(reclaimed.assignment.status, "CLAIMED");
    assert.equal(reclaimed.assignment.assignedToUserId, pitCrew.user.id);
    assert.ok(reclaimed.assignment.claimedAt);
    assert.equal(reclaimed.responsibilityEvent.status, "SUPERSEDED");
    assert.ok(reclaimed.responsibilityEvent.closedAt);
    assert.equal(reclaimed.responsibilityEvent.closedByUserId, pitCrew.user.id);
    assert.equal((await openEvents(reclaimed.assignment.id)).length, 0);
    const [reclaimAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, sourceRecordId), eq(auditLogs.action, "PC_RECLAIMED")));
    assert.equal(reclaimAudit?.previousValue, "HANDED_BACK");
    assert.equal(reclaimAudit?.updatedValue, "CLAIMED");
    assert.equal(reclaimAudit?.brokerageId, brokerageId);
    assert.equal(reclaimAudit?.propertyId, propertyId);

    const again = await handBackWorkItem({
      ...base(sourceRecordId, pitCrew, reclaimed.assignment.version),
      reasonCategory: "INFORMATION_RETURNED",
      nextAction: "Confirm the returned information.",
    });
    const open = await openEvents(again.assignment.id);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.id, again.responsibilityEvent.id);
    assert.notEqual(open[0]?.id, handed.responsibilityEvent.id);
  });

  test("acknowledge, resolve, and return keep the exception and the assignee", async () => {
    const namedId = await createException({ ownerType: "UNASSIGNED_QUEUE", ownerUserId: null });
    const roleId = await createException({ ownerType: "UNASSIGNED_QUEUE", ownerUserId: null });
    const beforeNamed = await sideEffects(namedId);
    const beforeRole = await sideEffects(roleId);

    let named = await claim(namedId);
    const namedEscalation = await escalateWorkItem({
      ...base(namedId, pitCrew, named.version),
      reasonCategory: "OTHER_MATERIAL_EXCEPTION",
      severity: "CRITICAL",
      note: "The authority for this step is missing.",
      nextAction: "Decide whether the brokerage will take the step.",
      recipientUserId: admin.user.id,
      expectedResponseAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    assert.equal(namedEscalation.assignment.assignedToUserId, pitCrew.user.id);
    const assigneeBefore = namedEscalation.assignment.assignedToUserId;

    await assert.rejects(
      resolveEscalation({ ...base(namedId, pitCrew, namedEscalation.assignment.version), note: "The originator cannot close this." }),
      PitCrewResponsibilityForbiddenError,
    );
    await assert.rejects(
      acknowledgeEscalation(base(namedId, secondAdmin, namedEscalation.assignment.version)),
      PitCrewResponsibilityForbiddenError,
    );
    const [unchanged] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, namedEscalation.assignment.id));
    assert.equal(unchanged?.status, "ESCALATED");
    assert.equal(unchanged?.version, namedEscalation.assignment.version);
    assert.equal(unchanged?.assignedToUserId, assigneeBefore);

    const acknowledged = await acknowledgeEscalation(base(namedId, admin, namedEscalation.assignment.version));
    assert.equal(acknowledged.assignment.status, "ESCALATED");
    assert.equal(acknowledged.assignment.assignedToUserId, assigneeBefore);
    assert.equal(acknowledged.assignment.version, namedEscalation.assignment.version + 1);
    assert.equal(acknowledged.responsibilityEvent.status, "ACKNOWLEDGED");
    assert.equal(acknowledged.responsibilityEvent.note, "The authority for this step is missing.");
    assert.equal(acknowledged.responsibilityEvent.closingNote, null);
    assert.equal(acknowledged.responsibilityEvent.acknowledgedByUserId, admin.user.id);
    assert.ok(acknowledged.responsibilityEvent.acknowledgedAt);
    const [ackAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, namedId), eq(auditLogs.action, "PC_ESCALATION_ACKNOWLEDGED")));
    assert.equal(ackAudit?.previousValue, "OPEN");
    assert.equal(ackAudit?.updatedValue, "ACKNOWLEDGED");
    assert.equal(ackAudit?.brokerageId, brokerageId);
    assert.equal(ackAudit?.propertyId, propertyId);

    const resolved = await resolveEscalation({
      ...base(namedId, admin, acknowledged.assignment.version),
      note: "The brokerage has authorised the step.",
    });
    assert.equal(resolved.assignment.status, "IN_PROGRESS");
    assert.equal(resolved.assignment.assignedToUserId, assigneeBefore);
    assert.equal(resolved.assignment.waitingOnParty, null);
    assert.equal(resolved.responsibilityEvent.status, "RESOLVED");
    assert.equal(resolved.responsibilityEvent.note, "The authority for this step is missing.");
    assert.equal(resolved.responsibilityEvent.closingNote, "The brokerage has authorised the step.");
    assert.equal(resolved.responsibilityEvent.closedByUserId, admin.user.id);
    assert.equal(resolved.responsibilityEvent.acknowledgedByUserId, admin.user.id);
    assert.equal((await openEvents(resolved.assignment.id)).length, 0);
    const afterNamed = await sideEffects(namedId);
    assert.deepEqual(afterNamed.exception, beforeNamed.exception);
    assert.equal(afterNamed.exception?.status, "OPEN");

    let role = await claim(roleId);
    role = await setWaitingOn({
      ...base(roleId, pitCrew, role.version),
      waitingOnParty: "Third party",
      waitingOnNote: "Overdue",
    });
    const roleEscalation = await escalateWorkItem({
      ...base(roleId, pitCrew, role.version),
      reasonCategory: "OVERDUE_THIRD_PARTY",
      severity: "ATTENTION",
      note: "The third party has not replied. This records that fact only.",
      nextAction: "Decide how the brokerage wants to proceed.",
    });
    assert.equal(roleEscalation.assignment.waitingOnParty, null);
    assert.equal(roleEscalation.assignment.assignedToUserId, pitCrew.user.id);
    assert.equal(roleEscalation.responsibilityEvent.expectedResponseAt, null);
    await assert.rejects(
      returnEscalation({ ...base(roleId, pitCrew, roleEscalation.assignment.version), note: "Originator cannot return this." }),
      PitCrewResponsibilityForbiddenError,
    );
    const returned = await returnEscalation({
      ...base(roleId, secondAdmin, roleEscalation.assignment.version),
      note: "Returned to Pit Crew with the brokerage decision.",
    });
    assert.equal(returned.assignment.status, "IN_PROGRESS");
    assert.equal(returned.assignment.assignedToUserId, pitCrew.user.id);
    assert.equal(returned.responsibilityEvent.status, "RETURNED");
    assert.equal(returned.responsibilityEvent.note, "The third party has not replied. This records that fact only.");
    assert.equal(returned.responsibilityEvent.closingNote, "Returned to Pit Crew with the brokerage decision.");
    assert.equal(returned.responsibilityEvent.closedByUserId, secondAdmin.user.id);
    const [returnAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, roleId), eq(auditLogs.action, "PC_ESCALATION_RETURNED")));
    assert.equal(returnAudit?.previousValue, "ESCALATED");
    assert.equal(returnAudit?.updatedValue, "IN_PROGRESS");
    assert.equal(returnAudit?.providerReference, JSON.stringify({ closingNote: "Returned to Pit Crew with the brokerage decision." }));
    const afterRole = await sideEffects(roleId);
    assert.deepEqual(afterRole.exception, beforeRole.exception);
    assert.deepEqual(afterRole.messageIds, beforeRole.messageIds);
    assert.deepEqual(afterRole.paymentIds, beforeRole.paymentIds);
    assert.deepEqual(afterRole.outboxIds, beforeRole.outboxIds);
  });

  test("a Brokerage Administrator can resolve their own role-addressed escalation", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId, admin);
    const escalated = await escalateWorkItem({
      ...base(sourceRecordId, admin, claimed.version),
      reasonCategory: "SETTLEMENT_OR_COMPLIANCE_RISK",
      severity: "ATTENTION",
      note: "Pit Crew must not progress this settlement step.",
      nextAction: "Decide the brokerage position.",
    });
    const resolved = await resolveEscalation({
      ...base(sourceRecordId, admin, escalated.assignment.version),
      note: "The brokerage position is recorded.",
    });
    assert.equal(resolved.assignment.status, "IN_PROGRESS");
    assert.equal(resolved.assignment.assignedToUserId, admin.user.id);
    assert.equal(resolved.responsibilityEvent.status, "RESOLVED");
    assert.equal(resolved.responsibilityEvent.note, "Pit Crew must not progress this settlement step.");
    assert.equal(resolved.responsibilityEvent.closingNote, "The brokerage position is recorded.");
  });

  test("resolve and return keep the escalation note and store the closing note", async () => {
    const resolveId = await createException();
    const returnId = await createException();
    const resolveClaimed = await claim(resolveId);
    const returnClaimed = await claim(returnId);

    const escalatedForResolve = await escalateWorkItem({
      ...base(resolveId, pitCrew, resolveClaimed.version),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: "Original escalation note for resolve.",
      nextAction: "Decide whether the brokerage authorises the step.",
    });
    const resolved = await resolveEscalation({
      ...base(resolveId, admin, escalatedForResolve.assignment.version),
      note: "Closing note for resolve.",
    });
    assert.equal(resolved.responsibilityEvent.note, "Original escalation note for resolve.");
    assert.equal(resolved.responsibilityEvent.closingNote, "Closing note for resolve.");
    assert.equal(resolved.responsibilityEvent.status, "RESOLVED");
    const [storedResolve] = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.id, resolved.responsibilityEvent.id));
    assert.equal(storedResolve?.note, "Original escalation note for resolve.");
    assert.equal(storedResolve?.closingNote, "Closing note for resolve.");
    const [resolveAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, resolveId), eq(auditLogs.action, "PC_ESCALATION_RESOLVED")));
    assert.equal(resolveAudit?.previousValue, "ESCALATED");
    assert.equal(resolveAudit?.updatedValue, "IN_PROGRESS");
    assert.equal(resolveAudit?.brokerageId, brokerageId);
    assert.equal(resolveAudit?.providerReference, JSON.stringify({ closingNote: "Closing note for resolve." }));

    const escalatedForReturn = await escalateWorkItem({
      ...base(returnId, pitCrew, returnClaimed.version),
      reasonCategory: "MISSING_INFORMATION",
      severity: "ATTENTION",
      note: "Original escalation note for return.",
      nextAction: "Decide what information the brokerage still needs.",
    });
    const returned = await returnEscalation({
      ...base(returnId, admin, escalatedForReturn.assignment.version),
      note: "Closing note for return.",
    });
    assert.equal(returned.responsibilityEvent.note, "Original escalation note for return.");
    assert.equal(returned.responsibilityEvent.closingNote, "Closing note for return.");
    assert.equal(returned.responsibilityEvent.status, "RETURNED");
    const [storedReturn] = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.id, returned.responsibilityEvent.id));
    assert.equal(storedReturn?.note, "Original escalation note for return.");
    assert.equal(storedReturn?.closingNote, "Closing note for return.");
    const [returnAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, returnId), eq(auditLogs.action, "PC_ESCALATION_RETURNED")));
    assert.equal(returnAudit?.previousValue, "ESCALATED");
    assert.equal(returnAudit?.updatedValue, "IN_PROGRESS");
    assert.equal(returnAudit?.providerReference, JSON.stringify({ closingNote: "Closing note for return." }));
  });

  test("AT_RISK and CRITICAL require expectedResponseAt, and escalate requires a note", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    await assert.rejects(
      escalateWorkItem({
        ...base(sourceRecordId, pitCrew, claimed.version),
        reasonCategory: "BLOCKED_DEPENDENCY",
        severity: "CRITICAL",
        note: "Blocked.",
        nextAction: "Unblock the dependency.",
      }),
      PitCrewResponsibilityValidationError,
    );
    await assert.rejects(
      escalateWorkItem({
        ...base(sourceRecordId, pitCrew, claimed.version),
        reasonCategory: "BLOCKED_DEPENDENCY",
        severity: "ATTENTION",
        note: "   ",
        nextAction: "Unblock the dependency.",
      }),
      PitCrewResponsibilityValidationError,
    );
    const events = await db.select().from(pitCrewResponsibilityEvents).where(eq(pitCrewResponsibilityEvents.assignmentId, claimed.id));
    assert.equal(events.length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
  });

  test("workspace active lists exclude HANDED_BACK and ESCALATED and the open event is joined only while the flag is on", async () => {
    const handedId = await createException({
      ownerType: "PIT_CREW",
      category: "LAUNCH_CAMPAIGN",
      severity: "CRITICAL",
      dueAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const escalatedId = await createException({
      ownerType: "PIT_CREW",
      category: "OFFERS",
      severity: "AT_RISK",
      dueAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    let handedRow = await claim(handedId);
    handedRow = await handBackWorkItem({
      ...base(handedId, pitCrew, handedRow.version),
      reasonCategory: "NEXT_ACTION_WITH_AGENT",
      nextAction: "Confirm the launch evidence.",
    }).then((result) => result.assignment);
    let escalatedRow = await claim(escalatedId);
    const escalated = await escalateWorkItem({
      ...base(escalatedId, pitCrew, escalatedRow.version),
      reasonCategory: "MISSING_INFORMATION",
      severity: "AT_RISK",
      note: "The offer file is incomplete.",
      nextAction: "Decide whether the brokerage will chase the missing offer document.",
      expectedResponseAt: new Date("2026-10-03T00:00:00.000Z"),
    });
    escalatedRow = escalated.assignment;

    const workspace = await getPitCrewWorkspace(brokerageId, pitCrew.user.id);
    for (const list of [workspace.myWork, workspace.teamWork, workspace.launchCoordination, workspace.transactionCoordination, workspace.unassignedWork, workspace.waitingOn, workspace.completedToday]) {
      assert.equal(list.some((item) => item.sourceRecordId === handedId || item.sourceRecordId === escalatedId), false);
    }
    assert.equal(workspace.summary.overdueCount, workspace.teamWork.filter((item) => item.overdue).length);
    const handedItem = workspace.handedBack.find((item) => item.sourceRecordId === handedId);
    assert.ok(handedItem);
    assert.equal(handedItem?.responsibility.reasonCategory, "NEXT_ACTION_WITH_AGENT");
    assert.equal(handedItem?.responsibility.recipientUserId, agent.user.id);
    assert.equal(handedItem?.responsibility.recipientDisplayName, "Agent User");
    assert.equal(handedItem?.responsibility.operatorDisplayName, "Pit Crew");
    assert.equal(handedItem?.responsibility.nextAction, "Confirm the launch evidence.");
    assert.equal(handedItem?.responsibility.severity, null);
    assert.equal(handedItem?.responsibility.closingNote, null);
    assert.equal(handedItem?.responsibility.expectedResponseAt, null);
    assert.equal(handedItem?.overdue, true);
    const escalatedItem = workspace.escalated.find((item) => item.sourceRecordId === escalatedId);
    assert.ok(escalatedItem);
    assert.equal(escalatedItem?.responsibility.severity, "AT_RISK");
    assert.equal(escalatedItem?.responsibility.note, "The offer file is incomplete.");
    assert.equal(escalatedItem?.responsibility.closingNote, null);
    assert.equal(escalatedItem?.responsibility.recipientRole, "Brokerage Administrator");
    assert.equal(escalatedItem?.responsibility.recipientDisplayName, null);
    assert.equal(escalatedItem?.responsibility.operatorDisplayName, "Pit Crew");
    assert.equal(escalatedItem?.responsibility.nextAction, "Decide whether the brokerage will chase the missing offer document.");
    assert.equal(escalatedItem?.responsibility.expectedResponseAt, "2026-10-03T00:00:00.000Z");
    assert.equal(escalatedItem?.assignedToUserId, pitCrew.user.id);

    delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    try {
      const hidden = await getPitCrewWorkspace(brokerageId, pitCrew.user.id);
      assert.equal(hidden.handedBack.some((item) => item.sourceRecordId === handedId), false);
      assert.equal(hidden.escalated.some((item) => item.sourceRecordId === escalatedId), false);
      assert.equal(hidden.teamWork.some((item) => item.sourceRecordId === handedId || item.sourceRecordId === escalatedId), false);
    } finally {
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    }
    const shown = await getPitCrewWorkspace(brokerageId, pitCrew.user.id);
    assert.equal(shown.handedBack.some((item) => item.sourceRecordId === handedId), true);
  });
});
