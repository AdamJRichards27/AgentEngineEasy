// R-F28 — LAUNCH_ITEM responsibility actions.
// All six verbs accept LAUNCH_ITEM only when both
// PIT_CREW_RESPONSIBILITY_ACTIONS_ENABLED and
// PIT_CREW_LAUNCH_ITEM_SOURCE_ENABLED are the literal "true".
// Either flag off rejects before a campaign_items read and before an
// overlay write. COMPLETE is the work-item 404. BLOCKED stays actionable.
// The campaign item and the launch plan are unchanged.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  campaignItems,
  communicationMessages,
  db,
  domainEvents,
  financialPaymentOutbox,
  financialPaymentRequests,
  launchPlans,
  pitCrewAssignments,
  pitCrewResponsibilityEvents,
  setDbQueryObserver,
  users,
} from "@aee/db";
import { claimWorkItem, PitCrewPropertyMismatchError } from "../assignment.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG } from "../launchItemSource.js";
import { getPitCrewTeam, getPitCrewWorkspace } from "../queries.js";
import {
  PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG,
  acknowledgeEscalation,
  escalateWorkItem,
  handBackWorkItem,
  reclaimHandedBack,
  resolveEscalation,
  returnEscalation,
  PitCrewResponsibilityDisabledError,
  type ResponsibilityMutationResult,
} from "../responsibility.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const ACTIONS = ["hand-back", "escalate", "acknowledge", "resolve", "return", "reclaim"] as const;
type ActionName = (typeof ACTIONS)[number];

const FLAG_OFF: ReadonlyArray<{ label: string; value: string | undefined }> = [
  { label: "unset", value: undefined },
  { label: "empty", value: "" },
  { label: "false", value: "false" },
  { label: "TRUE", value: "TRUE" },
  { label: "1", value: "1" },
  { label: "yes", value: "yes" },
];

const AUDIT_ACTION: Record<ActionName, string> = {
  "hand-back": "PC_HANDED_BACK",
  escalate: "PC_ESCALATED",
  acknowledge: "PC_ESCALATION_ACKNOWLEDGED",
  resolve: "PC_ESCALATION_RESOLVED",
  return: "PC_ESCALATION_RETURNED",
  reclaim: "PC_RECLAIMED",
};

const COST_SENTINEL = 88133741;
const VENDOR_SENTINEL = "Rf28-Vendor-Sentinel-9f3c";
const WORK_ITEM_NOT_FOUND = "Work item not found in this brokerage.";

let server: Server;
let baseUrl: string;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrew: DevLoginResult;
let foreignAdmin: DevLoginResult;
let brokerageId: number;
let otherBrokerageId: number;
let propertyId: number;
let otherPropertyId: number;
let foreignPropertyId: number;
let fixtureCounter = 0;
let savedResponsibilityFlag: string | undefined;
let savedLaunchFlag: string | undefined;

function actor(user: DevLoginResult, sourceRecordId: string, expectedVersion: number, targetPropertyId = propertyId) {
  return {
    brokerageId,
    propertyId: targetPropertyId,
    sourceType: "LAUNCH_ITEM" as const,
    sourceRecordId,
    expectedVersion,
    actorUserId: user.user.id,
    actorEmail: user.user.email,
  };
}

function responder(action: ActionName): DevLoginResult {
  return action === "acknowledge" || action === "resolve" || action === "return" ? admin : pitCrew;
}

async function withFlags(responsibility: string | undefined, launch: string | undefined, run: () => Promise<void>): Promise<void> {
  const previousResponsibility = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  const previousLaunch = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  if (responsibility === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = responsibility;
  if (launch === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
  else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = launch;
  try {
    await run();
  } finally {
    if (previousResponsibility === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = previousResponsibility;
    if (previousLaunch === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
    else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = previousLaunch;
  }
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

async function ensurePlan(targetBrokerageId: number, targetPropertyId: number, createdBy: number): Promise<string> {
  const [existing] = await db.select({ id: launchPlans.id }).from(launchPlans).where(eq(launchPlans.propertyId, targetPropertyId));
  if (existing) return existing.id;
  const [plan] = await db
    .insert(launchPlans)
    .values({
      brokerageId: targetBrokerageId,
      propertyId: targetPropertyId,
      templateType: "CUSTOM",
      status: "PLANNING",
      createdBy,
    })
    .returning({ id: launchPlans.id });
  return plan.id;
}

async function insertItem(input: {
  targetBrokerageId?: number;
  targetPropertyId?: number;
  createdBy?: number;
  title: string;
  status?: string;
}): Promise<string> {
  const targetBrokerageId = input.targetBrokerageId ?? brokerageId;
  const targetPropertyId = input.targetPropertyId ?? propertyId;
  const createdBy = input.createdBy ?? admin.user.id;
  const status = input.status ?? "TO_ORGANISE";
  const launchPlanId = await ensurePlan(targetBrokerageId, targetPropertyId, createdBy);
  const [item] = await db
    .insert(campaignItems)
    .values({
      launchPlanId,
      propertyId: targetPropertyId,
      brokerageId: targetBrokerageId,
      itemType: "PHOTOGRAPHY",
      title: input.title,
      description: "Saturday photography booking",
      status,
      responsibleOwnerType: "PIT_CREW",
      costCents: COST_SENTINEL,
      vendorName: VENDOR_SENTINEL,
      completedAt: status === "COMPLETE" ? new Date("2026-09-01T00:00:00.000Z") : null,
      blockedAt: status === "BLOCKED" ? new Date("2026-08-01T00:00:00.000Z") : null,
      blockedReason: status === "BLOCKED" ? "Vendor has not confirmed the date." : null,
    })
    .returning({ id: campaignItems.id });
  return item.id;
}

async function sourceSnapshot(itemId: string) {
  const [item] = await db.select().from(campaignItems).where(eq(campaignItems.id, itemId));
  assert.ok(item, itemId);
  const [plan] = await db.select().from(launchPlans).where(eq(launchPlans.id, item.launchPlanId));
  const domain = await db
    .select({ id: domainEvents.id, eventType: domainEvents.eventType })
    .from(domainEvents)
    .where(eq(domainEvents.propertyId, item.propertyId))
    .orderBy(asc(domainEvents.id));
  const messages = await db
    .select({ id: communicationMessages.id })
    .from(communicationMessages)
    .where(eq(communicationMessages.propertyId, item.propertyId))
    .orderBy(asc(communicationMessages.id));
  const payments = await db
    .select({ id: financialPaymentRequests.id })
    .from(financialPaymentRequests)
    .where(eq(financialPaymentRequests.propertyId, item.propertyId))
    .orderBy(asc(financialPaymentRequests.id));
  const outbox = await db
    .select({ id: financialPaymentOutbox.id })
    .from(financialPaymentOutbox)
    .where(eq(financialPaymentOutbox.brokerageId, item.brokerageId))
    .orderBy(asc(financialPaymentOutbox.id));
  return { item, plan, domain, messages, payments, outbox };
}

async function keyCount(sourceRecordId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "LAUNCH_ITEM"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)));
  return Number(row?.n ?? 0);
}

async function runAction(
  action: ActionName,
  sourceRecordId: string,
  expectedVersion: number,
  user: DevLoginResult,
  targetPropertyId = propertyId,
): Promise<ResponsibilityMutationResult> {
  const base = actor(user, sourceRecordId, expectedVersion, targetPropertyId);
  switch (action) {
    case "hand-back":
      return handBackWorkItem({ ...base, reasonCategory: "WORK_COMPLETE", nextAction: "Confirm the Saturday shoot." });
    case "escalate":
      return escalateWorkItem({
        ...base,
        reasonCategory: "BLOCKED_DEPENDENCY",
        severity: "ATTENTION",
        note: "The vendor has not confirmed.",
        nextAction: "Chase the vendor.",
      });
    case "acknowledge":
      return acknowledgeEscalation(base);
    case "resolve":
      return resolveEscalation({ ...base, note: "Resolved for the launch item." });
    case "return":
      return returnEscalation({ ...base, note: "Returned to Pit Crew." });
    case "reclaim":
      return reclaimHandedBack(base);
  }
}

async function claimItem(sourceRecordId: string) {
  return claimWorkItem(actor(pitCrew, sourceRecordId, 0));
}

async function openEscalation(sourceRecordId: string): Promise<ResponsibilityMutationResult> {
  const claimed = await claimItem(sourceRecordId);
  return escalateWorkItem({
    ...actor(pitCrew, sourceRecordId, claimed.version),
    reasonCategory: "MISSING_INFORMATION",
    severity: "ATTENTION",
    note: "The launch brief is missing.",
    nextAction: "Send the brief.",
  });
}

async function openHandBack(sourceRecordId: string): Promise<ResponsibilityMutationResult> {
  const claimed = await claimItem(sourceRecordId);
  return handBackWorkItem({
    ...actor(pitCrew, sourceRecordId, claimed.version),
    reasonCategory: "NEXT_ACTION_WITH_AGENT",
    nextAction: "Confirm the Saturday shoot.",
  });
}

async function prepare(action: ActionName, sourceRecordId: string): Promise<{ version: number; user: DevLoginResult }> {
  if (action === "hand-back" || action === "escalate") {
    const claimed = await claimItem(sourceRecordId);
    return { version: claimed.version, user: pitCrew };
  }
  if (action === "reclaim") {
    const handed = await openHandBack(sourceRecordId);
    return { version: handed.assignment.version, user: pitCrew };
  }
  const escalated = await openEscalation(sourceRecordId);
  return { version: escalated.assignment.version, user: admin };
}

function assertOutcome(action: ActionName, result: ResponsibilityMutationResult): void {
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(String(COST_SENTINEL)), false, action);
  assert.equal(encoded.includes(VENDOR_SENTINEL), false, action);
  const { assignment, responsibilityEvent: event } = result;
  assert.equal(event.brokerageId, brokerageId, action);
  assert.equal(event.propertyId, propertyId, action);
  if (action === "hand-back") {
    assert.equal(assignment.status, "HANDED_BACK");
    assert.equal(assignment.assignedToUserId, null);
    assert.equal(assignment.claimedAt, null);
    assert.equal(assignment.completedAt, null);
    assert.equal(event.kind, "HAND_BACK");
    assert.equal(event.status, "OPEN");
    assert.equal(event.resultingResponsibility, "AGENT");
    assert.equal(event.severity, null);
    assert.equal(event.expectedResponseAt, null);
    assert.equal(event.recipientUserId, agent.user.id);
    assert.equal(event.recipientRole, null);
    return;
  }
  if (action === "escalate") {
    assert.equal(assignment.status, "ESCALATED");
    assert.equal(assignment.assignedToUserId, pitCrew.user.id);
    assert.equal(assignment.completedAt, null);
    assert.equal(event.kind, "ESCALATION");
    assert.equal(event.status, "OPEN");
    assert.equal(event.resultingResponsibility, "BROKERAGE_ADMINISTRATOR");
    assert.equal(event.recipientUserId, null);
    assert.equal(event.recipientRole, "Brokerage Administrator");
    assert.equal(event.severity, "ATTENTION");
    return;
  }
  if (action === "acknowledge") {
    assert.equal(assignment.status, "ESCALATED");
    assert.equal(event.status, "ACKNOWLEDGED");
    assert.equal(event.acknowledgedByUserId, admin.user.id);
    return;
  }
  if (action === "resolve") {
    assert.equal(assignment.status, "IN_PROGRESS");
    assert.equal(event.status, "RESOLVED");
    assert.equal(event.closingNote, "Resolved for the launch item.");
    assert.equal(event.closedByUserId, admin.user.id);
    return;
  }
  if (action === "return") {
    assert.equal(assignment.status, "IN_PROGRESS");
    assert.equal(event.status, "RETURNED");
    assert.equal(event.closingNote, "Returned to Pit Crew.");
    assert.equal(event.closedByUserId, admin.user.id);
    return;
  }
  assert.equal(assignment.status, "CLAIMED");
  assert.equal(assignment.assignedToUserId, pitCrew.user.id);
  assert.equal(event.status, "SUPERSEDED");
  assert.equal(event.kind, "HAND_BACK");
  assert.equal(event.closedByUserId, pitCrew.user.id);
}

async function assertWorkItemNotFound(run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof PitCrewPropertyMismatchError);
    assert.equal(err.message, WORK_ITEM_NOT_FOUND);
    return true;
  });
}

describe("R-F28 LAUNCH_ITEM responsibility actions", { concurrency: false }, () => {
  before(async () => {
    savedResponsibilityFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    savedLaunchFlag = process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
    process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = "true";

    const { configureEvents } = await import("../../events.js");
    configureEvents();
    const { createApp } = await import("../../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await createBrokerageWithUsers(baseUrl, `R-F28 Launch Responsibility ${Date.now()}`);
    admin = created.admin;
    agent = created.agent;
    brokerageId = created.brokerageId;
    pitCrew = await devLogin(baseUrl, {
      email: `pitcrew-rf28-${brokerageId}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: created.admin.user.brokerageName!,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

    const foreign = await createBrokerageWithUsers(baseUrl, `R-F28 Foreign ${Date.now()}`);
    foreignAdmin = foreign.admin;
    otherBrokerageId = foreign.brokerageId;
    propertyId = await createProperty(agent.cookie, `${Date.now()} Rf28 Launch St`);
    otherPropertyId = await createProperty(agent.cookie, `${Date.now()} Rf28 Other St`);
    foreignPropertyId = await createProperty(foreignAdmin.cookie, `${Date.now()} Rf28 Foreign St`);
  });

  after(async () => {
    if (savedResponsibilityFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedResponsibilityFlag;
    if (savedLaunchFlag === undefined) delete process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG];
    else process.env[PIT_CREW_LAUNCH_ITEM_SOURCE_FLAG] = savedLaunchFlag;
    await cleanupBrokerages([brokerageId, otherBrokerageId].filter((id): id is number => id != null));
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("both flags on: each action succeeds and leaves the campaign item unchanged", async () => {
    for (const action of ACTIONS) {
      const itemId = await insertItem({ title: `Rf28 happy ${action}` });
      const before = await sourceSnapshot(itemId);
      const prepared = await prepare(action, itemId);
      const result = await runAction(action, itemId, prepared.version, prepared.user);
      assertOutcome(action, result);
      assert.deepEqual(await sourceSnapshot(itemId), before, action);

      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.recordId, itemId), eq(auditLogs.action, AUDIT_ACTION[action])));
      assert.ok(audit, action);
      assert.equal(audit.brokerageId, brokerageId, action);
      assert.equal(audit.propertyId, propertyId, action);
      assert.equal(audit.recordType, "LAUNCH_ITEM", action);
      assert.equal(audit.recordId, itemId, action);
      assert.equal(audit.userId, prepared.user.user.id, action);
      assert.equal(JSON.stringify(audit).includes(String(COST_SENTINEL)), false, action);
      assert.equal(JSON.stringify(audit).includes(VENDOR_SENTINEL), false, action);
      if (action === "hand-back") {
        assert.equal(audit.previousValue, "CLAIMED");
        assert.equal(audit.updatedValue, "HANDED_BACK");
        assert.equal(audit.providerReference, null);
      }
      if (action === "escalate") {
        assert.equal(audit.previousValue, "CLAIMED");
        assert.equal(audit.updatedValue, "ESCALATED");
        assert.equal(audit.providerReference, null);
      }
      if (action === "resolve") {
        assert.equal(audit.previousValue, "ESCALATED");
        assert.equal(audit.updatedValue, "IN_PROGRESS");
        assert.equal(audit.providerReference, JSON.stringify({ closingNote: "Resolved for the launch item." }));
      }
    }
  });

  test("both flags on: a BLOCKED campaign item stays actionable and unchanged", async () => {
    for (const action of ACTIONS) {
      const itemId = await insertItem({ title: `Rf28 blocked ${action}`, status: "BLOCKED" });
      const before = await sourceSnapshot(itemId);
      const prepared = await prepare(action, itemId);
      const result = await runAction(action, itemId, prepared.version, prepared.user);
      assertOutcome(action, result);
      const after = await sourceSnapshot(itemId);
      assert.deepEqual(after, before, action);
      assert.equal(after.item.status, "BLOCKED", action);
      assert.equal(after.item.blockedReason, "Vendor has not confirmed the date.", action);
    }
  });

  test("a COMPLETE campaign item is rejected and an existing overlay is left untouched", async () => {
    for (const action of ACTIONS) {
      const untouchedId = await insertItem({ title: `Rf28 complete untouched ${action}`, status: "COMPLETE" });
      const untouchedBefore = await sourceSnapshot(untouchedId);
      await assertWorkItemNotFound(() => runAction(action, untouchedId, 0, responder(action)));
      assert.equal(await keyCount(untouchedId), 0, action);
      assert.deepEqual(await sourceSnapshot(untouchedId), untouchedBefore, action);

      const touchedId = await insertItem({ title: `Rf28 complete touched ${action}` });
      const prepared = await prepare(action, touchedId);
      await db.update(campaignItems).set({ status: "COMPLETE", completedAt: new Date("2026-09-02T00:00:00.000Z") }).where(eq(campaignItems.id, touchedId));
      const before = await sourceSnapshot(touchedId);
      const [beforeOverlay] = await db
        .select()
        .from(pitCrewAssignments)
        .where(and(eq(pitCrewAssignments.sourceType, "LAUNCH_ITEM"), eq(pitCrewAssignments.sourceRecordId, touchedId)));
      assert.ok(beforeOverlay, action);
      const [beforeEvents] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pitCrewResponsibilityEvents)
        .where(eq(pitCrewResponsibilityEvents.assignmentId, beforeOverlay.id));
      await assertWorkItemNotFound(() => runAction(action, touchedId, prepared.version, prepared.user));
      const [afterOverlay] = await db
        .select()
        .from(pitCrewAssignments)
        .where(eq(pitCrewAssignments.id, beforeOverlay.id));
      assert.deepEqual(afterOverlay, beforeOverlay, action);
      const [afterEvents] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(pitCrewResponsibilityEvents)
        .where(eq(pitCrewResponsibilityEvents.assignmentId, beforeOverlay.id));
      assert.equal(Number(afterEvents?.n ?? 0), Number(beforeEvents?.n ?? 0), action);
      assert.deepEqual(await sourceSnapshot(touchedId), before, action);
      assert.equal(before.item.status, "COMPLETE", action);
    }
  });

  test("either flag off rejects every action before campaign_items is read", async () => {
    for (const action of ACTIONS) {
      const itemId = await insertItem({ title: `Rf28 flag off ${action}` });
      const before = await sourceSnapshot(itemId);
      for (const flagCase of FLAG_OFF) {
        const statements: string[] = [];
        await withFlags(flagCase.value, "true", async () => {
          const uninstall = setDbQueryObserver((query) => {
            statements.push(query);
          });
          try {
            await assert.rejects(
              () => runAction(action, itemId, 0, responder(action)),
              (err: unknown) => {
                assert.ok(err instanceof PitCrewResponsibilityDisabledError, `${action} ${flagCase.label}`);
                assert.equal(err.message, "Not found.", `${action} ${flagCase.label}`);
                return true;
              },
            );
          } finally {
            uninstall();
          }
        });
        assert.deepEqual(statements, [], `${action} responsibility ${flagCase.label}`);
      }
      for (const flagCase of FLAG_OFF) {
        const statements: string[] = [];
        await withFlags("true", flagCase.value, async () => {
          const uninstall = setDbQueryObserver((query) => {
            statements.push(query);
          });
          try {
            await assertWorkItemNotFound(() => runAction(action, itemId, 0, responder(action)));
          } finally {
            uninstall();
          }
        });
        assert.deepEqual(
          statements.filter((query) => query.includes("campaign_items") || query.includes("pit_crew_responsibility_events")),
          [],
          `${action} launch ${flagCase.label}`,
        );
      }
      assert.equal(await keyCount(itemId), 0, action);
      assert.deepEqual(await sourceSnapshot(itemId), before, action);
    }
  });

  test("wrong brokerage, wrong property, and a missing campaign item are the work-item 404", async () => {
    const foreignItemId = await insertItem({
      targetBrokerageId: otherBrokerageId,
      targetPropertyId: foreignPropertyId,
      createdBy: foreignAdmin.user.id,
      title: "Rf28 foreign campaign item",
    });
    const mismatchItemId = await insertItem({
      targetPropertyId: otherPropertyId,
      title: "Rf28 other property campaign item",
    });
    for (const action of ACTIONS) {
      const foreignBefore = await sourceSnapshot(foreignItemId);
      const mismatchBefore = await sourceSnapshot(mismatchItemId);
      const missingId = randomUUID();
      await assertWorkItemNotFound(() => runAction(action, foreignItemId, 0, responder(action)));
      await assertWorkItemNotFound(() => runAction(action, mismatchItemId, 0, responder(action)));
      await assertWorkItemNotFound(() => runAction(action, missingId, 0, responder(action)));
      assert.equal(await keyCount(foreignItemId), 0, action);
      assert.equal(await keyCount(mismatchItemId), 0, action);
      assert.equal(await keyCount(missingId), 0, action);
      assert.deepEqual(await sourceSnapshot(foreignItemId), foreignBefore, action);
      assert.deepEqual(await sourceSnapshot(mismatchItemId), mismatchBefore, action);
    }
  });

  test("both flags on: an exception hand-back still does not read campaign_items, and OFFER stays rejected", async () => {
    fixtureCounter += 1;
    const finding: RiskFinding = {
      ruleId: "TEST_PITCREW_RF28_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `Rf28 exception ${fixtureCounter}`,
      problemDescription: "A test problem.",
      businessImpact: "Test impact.",
      detectedCause: "Test cause.",
      ownerType: "PIT_CREW",
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
      dedupKey: `TEST_PITCREW_RF28_RULE:${brokerageId}:${fixtureCounter}`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
    };
    const created = await createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
    const exceptionId = created.exception.id;
    const claimed = await claimWorkItem({
      brokerageId,
      propertyId,
      sourceType: "EXCEPTION",
      sourceRecordId: exceptionId,
      expectedVersion: 0,
      actorUserId: pitCrew.user.id,
      actorEmail: pitCrew.user.email,
    });
    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => {
      statements.push(query);
    });
    try {
      const handed = await handBackWorkItem({
        brokerageId,
        propertyId,
        sourceType: "EXCEPTION",
        sourceRecordId: exceptionId,
        expectedVersion: claimed.version,
        actorUserId: pitCrew.user.id,
        actorEmail: pitCrew.user.email,
        reasonCategory: "WORK_COMPLETE",
        nextAction: "Review the returned evidence.",
      });
      assert.equal(handed.assignment.status, "HANDED_BACK");
      assert.equal(handed.responsibilityEvent.resultingResponsibility, "AGENT");
      const [audit] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.recordId, exceptionId), eq(auditLogs.action, "PC_HANDED_BACK")));
      assert.equal(audit?.recordType, "EXCEPTION");
    } finally {
      uninstall();
    }
    assert.deepEqual(
      statements.filter((query) => query.includes("campaign_items")),
      [],
    );

    const offerId = randomUUID();
    const offerStatements: string[] = [];
    const uninstallOffer = setDbQueryObserver((query) => {
      offerStatements.push(query);
    });
    try {
      await assertWorkItemNotFound(() =>
        handBackWorkItem({
          ...actor(pitCrew, offerId, 0),
          sourceType: "OFFER",
          reasonCategory: "WORK_COMPLETE",
          nextAction: "Review the returned evidence.",
        }),
      );
    } finally {
      uninstallOffer();
    }
    assert.deepEqual(
      offerStatements.filter((query) => query.includes("campaign_items") || query.includes("pit_crew_assignments")),
      [],
    );
    const [offerOverlay] = await db
      .select({ id: pitCrewAssignments.id })
      .from(pitCrewAssignments)
      .where(eq(pitCrewAssignments.sourceRecordId, offerId));
    assert.equal(offerOverlay, undefined);
  });

  test("both flags on: a handed-back launch item leaves the active workspace and the team count", async () => {
    const handId = await insertItem({ title: "Rf28 workspace hand back" });
    const escalateId = await insertItem({ title: "Rf28 workspace escalate" });
    const beforeHand = await sourceSnapshot(handId);
    const beforeEscalate = await sourceSnapshot(escalateId);
    const beforeTeam = await getPitCrewTeam(brokerageId);
    const start = beforeTeam.find((member) => member.userId === pitCrew.user.id)?.activeItemCount ?? 0;

    const claimedHand = await claimItem(handId);
    const claimedEscalate = await claimItem(escalateId);
    const afterClaim = await getPitCrewTeam(brokerageId);
    assert.equal(afterClaim.find((member) => member.userId === pitCrew.user.id)?.activeItemCount, start + 2);

    await handBackWorkItem({
      ...actor(pitCrew, handId, claimedHand.version),
      reasonCategory: "WORK_COMPLETE",
      nextAction: "Confirm the Saturday shoot.",
    });
    await escalateWorkItem({
      ...actor(pitCrew, escalateId, claimedEscalate.version),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "AT_RISK",
      note: "Outside Pit Crew authority.",
      nextAction: "Decide the next step.",
      expectedResponseAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const workspace = await getPitCrewWorkspace(brokerageId, pitCrew.user.id);
    for (const list of [workspace.myWork, workspace.teamWork, workspace.launchCoordination, workspace.unassignedWork, workspace.waitingOn]) {
      assert.equal(list.some((item) => item.sourceRecordId === handId || item.sourceRecordId === escalateId), false);
    }
    const handed = workspace.handedBack.find((item) => item.sourceRecordId === handId);
    assert.ok(handed);
    assert.equal(handed.sourceType, "LAUNCH_ITEM");
    assert.equal(handed.title, "Rf28 workspace hand back");
    assert.equal(handed.severity, "INFORMATION");
    assert.equal(handed.category, "LAUNCH_CAMPAIGN");
    assert.equal(handed.pcStatus, "HANDED_BACK");
    assert.equal(handed.responsibility.kind, "HAND_BACK");
    assert.equal(handed.responsibility.recipientUserId, agent.user.id);
    assert.equal(handed.responsibility.reasonCategory, "WORK_COMPLETE");
    const escalated = workspace.escalated.find((item) => item.sourceRecordId === escalateId);
    assert.ok(escalated);
    assert.equal(escalated.sourceType, "LAUNCH_ITEM");
    assert.equal(escalated.severity, "INFORMATION");
    assert.equal(escalated.category, "LAUNCH_CAMPAIGN");
    assert.equal(escalated.responsibility.kind, "ESCALATION");
    assert.equal(escalated.responsibility.recipientRole, "Brokerage Administrator");
    assert.equal(escalated.responsibility.severity, "AT_RISK");
    const encoded = JSON.stringify(workspace);
    assert.equal(encoded.includes(String(COST_SENTINEL)), false);
    assert.equal(encoded.includes(VENDOR_SENTINEL), false);

    const afterTeam = await getPitCrewTeam(brokerageId);
    assert.equal(afterTeam.find((member) => member.userId === pitCrew.user.id)?.activeItemCount, start);
    assert.deepEqual(await sourceSnapshot(handId), beforeHand);
    assert.deepEqual(await sourceSnapshot(escalateId), beforeEscalate);
  });
});
