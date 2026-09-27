// R-F16 PR 4 — recipient inbox read. Flag off refuses before any read of
// pit_crew_responsibility_events. While on, the caller sees OPEN and
// ACKNOWLEDGED events in their brokerage where they are the user recipient
// or the event's recipient_role is their role.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, pitCrewResponsibilityEvents, setDbQueryObserver, users } from "@aee/db";
import { listBrokerageExceptions, listedExceptionTitle } from "../../exceptions/queries.js";
import { createOrUpdateException, newCorrelationId } from "../../exceptions/model.js";
import type { RiskFinding } from "../../exceptions/types.js";
import { claimWorkItem } from "../assignment.js";
import { listResponsibilityItemsForRecipient } from "../queries.js";
import {
  PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG,
  acknowledgeEscalation,
  escalateWorkItem,
  handBackWorkItem,
  reclaimHandedBack,
  resolveEscalation,
  returnEscalation,
  PitCrewResponsibilityDisabledError,
} from "../responsibility.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "../../../routes/__tests__/testSupport.js";
import type { ResponsibilityInbox, ResponsibilityInboxItem } from "../types.js";

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

test("queries.ts does not import the writers the responsibility inbox must not call", () => {
  const source = readFileSync(new URL("../queries.ts", import.meta.url), "utf8");
  for (const suffix of FORBIDDEN_IMPORT_SUFFIXES) {
    assert.equal(source.includes(suffix), false, `queries.ts must not reference ${suffix}`);
  }
});

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const SECRET = "RF16-FIN-12500";
const NEXT_ACTION = "Review the returned condition evidence and confirm the next step.";
const ESCALATION_NOTE = "Settlement figure is outside Pit Crew authority.";
const ESCALATION_NEXT = "Decide whether the brokerage will authorise the next settlement step.";

describe("listResponsibilityItemsForRecipient", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  let admin: DevLoginResult;
  let secondAdmin: DevLoginResult;
  let agent: DevLoginResult;
  let secondAgent: DevLoginResult;
  let pitCrew: DevLoginResult;
  let foreignAdmin: DevLoginResult;
  let brokerageId: number;
  let otherBrokerageId: number;
  let orphanBrokerageId: number;
  let propertyId: number;
  let secondPropertyId: number;
  let otherPropertyId: number;
  let fixtureCounter = 0;
  let savedFlag: string | undefined;

  function buildFinding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding> = {}): RiskFinding {
    fixtureCounter += 1;
    return {
      ruleId: "TEST_PITCREW_INBOX_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `Inbox finding ${fixtureCounter}`,
      problemDescription: "A test problem.",
      businessImpact: "Test impact.",
      detectedCause: "Test cause.",
      ownerType: "PIT_CREW",
      ownerUserId: null,
      propertyId: targetPropertyId,
      transactionId: null,
      dueAt: null,
      escalatesAt: null,
      recommendedAction: "Do the test thing.",
      resolutionRequirements: "The test condition clears.",
      dismissible: true,
      sourceRecordType: "property",
      sourceRecordId: String(targetPropertyId),
      dedupKey: `TEST_PITCREW_INBOX_RULE:${targetBrokerageId}:INBOX_${fixtureCounter}`,
      recurrenceMode: "REOPEN",
      requiresFinancialEntitlement: false,
      ...overrides,
    };
  }

  async function createException(
    targetPropertyId = propertyId,
    targetBrokerageId = brokerageId,
    overrides: Partial<RiskFinding> = {},
  ): Promise<string> {
    const result = await createOrUpdateException(
      buildFinding(targetPropertyId, targetBrokerageId, overrides),
      targetBrokerageId,
      targetPropertyId,
      null,
      newCorrelationId(),
      null,
    );
    return result.exception.id;
  }

  function actor(sourceRecordId: string, user: DevLoginResult, expectedVersion: number, targetPropertyId: number, targetBrokerageId = brokerageId) {
    return {
      brokerageId: targetBrokerageId,
      propertyId: targetPropertyId,
      sourceType: "EXCEPTION" as const,
      sourceRecordId,
      expectedVersion,
      actorUserId: user.user.id,
      actorEmail: user.user.email,
    };
  }

  async function claim(sourceRecordId: string, user: DevLoginResult, targetPropertyId: number, targetBrokerageId = brokerageId) {
    return claimWorkItem(actor(sourceRecordId, user, 0, targetPropertyId, targetBrokerageId));
  }

  async function titleFromExceptionRead(canViewFinancials: boolean, exceptionId: string, targetBrokerageId = brokerageId): Promise<string | null> {
    const page = await listBrokerageExceptions(targetBrokerageId, canViewFinancials, null, { limit: 200, offset: 0 });
    return page.exceptions.find((row) => row.id === exceptionId)?.title ?? null;
  }

  function byId(inbox: ResponsibilityInbox, sourceRecordId: string): ResponsibilityInboxItem | undefined {
    return inbox.items.find((item) => item.sourceRecordId === sourceRecordId);
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

    const created = await createBrokerageWithUsers(baseUrl, `PitCrew Inbox ${Date.now()}`);
    admin = created.admin;
    agent = created.agent;
    brokerageId = created.brokerageId;

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

    propertyId = await createProperty(agent.cookie, "1 Inbox Test St");
    pitCrew = await devLogin(baseUrl, {
      email: `pitcrew-inbox-${brokerageId}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: created.admin.user.brokerageName!,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

    secondAgent = await devLogin(baseUrl, {
      email: `agent2-inbox-${brokerageId}@example.com`,
      firstName: "Second",
      lastName: "Agent",
      brokerageName: created.admin.user.brokerageName!,
    });
    secondPropertyId = await createProperty(secondAgent.cookie, "2 Inbox Test St");

    const orphan = await devLogin(baseUrl, {
      email: `admin2-inbox-${brokerageId}@example.com`,
      firstName: "Second",
      lastName: "Admin",
      brokerageName: `PitCrew Inbox Orphan ${Date.now()}`,
    });
    orphanBrokerageId = orphan.user.brokerageId;
    await db.update(users).set({ brokerageId }).where(eq(users.id, orphan.user.id));
    secondAdmin = { cookie: orphan.cookie, user: { ...orphan.user, brokerageId } };

    const other = await createBrokerageWithUsers(baseUrl, `PitCrew Inbox Other ${Date.now()}`);
    otherBrokerageId = other.brokerageId;
    foreignAdmin = other.admin;
    otherPropertyId = await createProperty(other.agent.cookie, "9 Other Inbox St");
  });

  after(async () => {
    if (savedFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
    await cleanupBrokerages([brokerageId, otherBrokerageId, orphanBrokerageId]);
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  test("flag off throws before reading pit_crew_responsibility_events", async () => {
    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => statements.push(query));
    try {
      for (const value of [undefined, "TRUE", "1", "yes"] as const) {
        if (value === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
        else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = value;
        await assert.rejects(
          () => listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent"),
          (err: unknown) => {
            assert.ok(err instanceof PitCrewResponsibilityDisabledError);
            assert.equal(err.message, "Not found.");
            return true;
          },
        );
      }
    } finally {
      uninstall();
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    }
    assert.equal(
      statements.some((query) => query.includes("pit_crew_responsibility_events")),
      false,
    );
  });

  test("an agent sees their own hand-back and not another agent's", async () => {
    const ownId = await createException(propertyId, brokerageId, { title: "Agent one hand-back" });
    const otherId = await createException(secondPropertyId, brokerageId, { title: "Agent two hand-back" });
    const ownClaim = await claim(ownId, pitCrew, propertyId);
    const otherClaim = await claim(otherId, pitCrew, secondPropertyId);
    await handBackWorkItem({
      ...actor(ownId, pitCrew, ownClaim.version, propertyId),
      reasonCategory: "WORK_COMPLETE",
      note: "Evidence is back with the agent.",
      nextAction: NEXT_ACTION,
    });
    await handBackWorkItem({
      ...actor(otherId, pitCrew, otherClaim.version, secondPropertyId),
      reasonCategory: "NEXT_ACTION_WITH_AGENT",
      nextAction: NEXT_ACTION,
    });

    const ownInbox = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
    const otherInbox = await listResponsibilityItemsForRecipient(brokerageId, secondAgent.user.id, "Agent");
    const own = byId(ownInbox, ownId);
    assert.ok(own);
    assert.equal(byId(ownInbox, otherId), undefined);
    assert.equal(byId(otherInbox, otherId)?.sourceRecordId, otherId);
    assert.equal(byId(otherInbox, ownId), undefined);

    assert.equal(own.sourceType, "EXCEPTION");
    assert.equal(own.propertyId, propertyId);
    assert.equal(own.propertyAddress, "1 Inbox Test St");
    assert.equal(own.title, "Agent one hand-back");
    assert.equal(own.title, await titleFromExceptionRead(false, ownId));
    assert.equal(own.nextAction, NEXT_ACTION);
    assert.equal(own.kind, "HAND_BACK");
    assert.equal(own.reasonCategory, "WORK_COMPLETE");
    assert.equal(own.severity, null);
    assert.equal(own.note, "Evidence is back with the agent.");
    assert.equal(own.originatingUserId, pitCrew.user.id);
    assert.equal(own.recipientUserId, agent.user.id);
    assert.equal(own.recipientRole, null);
    assert.equal(own.expectedResponseAt, null);
    assert.equal(own.eventStatus, "OPEN");
    assert.equal(own.assignmentStatus, "HANDED_BACK");
    assert.equal(own.deepLink, `/properties/${propertyId}`);
    assert.equal(Number.isNaN(Date.parse(own.createdAt)), false);
    assert.equal(Number.isNaN(Date.parse(ownInbox.generatedAt)), false);
    assert.equal("closingNote" in own, false);
  });

  test("role-addressed escalations reach each brokerage administrator in that brokerage only", async () => {
    const roleId = await createException();
    const namedId = await createException();
    const foreignId = await createException(otherPropertyId, otherBrokerageId, { title: "Other brokerage escalation" });
    const roleClaim = await claim(roleId, pitCrew, propertyId);
    const namedClaim = await claim(namedId, pitCrew, propertyId);
    const foreignClaim = await claim(foreignId, foreignAdmin, otherPropertyId, otherBrokerageId);

    await escalateWorkItem({
      ...actor(roleId, pitCrew, roleClaim.version, propertyId),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
    });
    await escalateWorkItem({
      ...actor(namedId, pitCrew, namedClaim.version, propertyId),
      reasonCategory: "BLOCKED_DEPENDENCY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
      recipientUserId: admin.user.id,
    });
    await escalateWorkItem({
      ...actor(foreignId, foreignAdmin, foreignClaim.version, otherPropertyId, otherBrokerageId),
      reasonCategory: "MISSING_INFORMATION",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
    });

    const first = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");
    const second = await listResponsibilityItemsForRecipient(brokerageId, secondAdmin.user.id, "Brokerage Administrator");
    const foreign = await listResponsibilityItemsForRecipient(otherBrokerageId, foreignAdmin.user.id, "Brokerage Administrator");
    const agentInbox = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");

    assert.ok(byId(first, roleId));
    assert.ok(byId(second, roleId));
    assert.equal(byId(first, roleId)?.recipientRole, "Brokerage Administrator");
    assert.equal(byId(first, roleId)?.recipientUserId, null);
    assert.equal(byId(first, roleId)?.kind, "ESCALATION");
    assert.equal(byId(first, roleId)?.note, ESCALATION_NOTE);
    assert.equal(byId(first, roleId)?.nextAction, ESCALATION_NEXT);

    assert.ok(byId(first, namedId));
    assert.equal(byId(second, namedId), undefined);

    assert.equal(byId(first, foreignId), undefined);
    assert.equal(byId(second, foreignId), undefined);
    assert.ok(byId(foreign, foreignId));
    assert.equal(byId(foreign, roleId), undefined);
    assert.equal(byId(agentInbox, roleId), undefined);

    const otherBrokerage = await listResponsibilityItemsForRecipient(otherBrokerageId, admin.user.id, "Brokerage Administrator");
    assert.equal(byId(otherBrokerage, roleId), undefined);
    assert.equal(byId(otherBrokerage, namedId), undefined);
  });

  test("RESOLVED, RETURNED, and SUPERSEDED events are excluded, and ACKNOWLEDGED stays", async () => {
    const ackId = await createException();
    const returnId = await createException();
    const handId = await createException();
    const ackClaim = await claim(ackId, pitCrew, propertyId);
    const returnClaim = await claim(returnId, pitCrew, propertyId);
    const handClaim = await claim(handId, pitCrew, propertyId);

    const escalated = await escalateWorkItem({
      ...actor(ackId, pitCrew, ackClaim.version, propertyId),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
    });
    const acknowledged = await acknowledgeEscalation({
      ...actor(ackId, admin, escalated.assignment.version, propertyId),
      note: "Seen.",
    });
    const openInbox = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");
    assert.equal(byId(openInbox, ackId)?.eventStatus, "ACKNOWLEDGED");
    assert.equal(byId(openInbox, ackId)?.assignmentStatus, "ESCALATED");

    await resolveEscalation({
      ...actor(ackId, admin, acknowledged.assignment.version, propertyId),
      note: "Authorised the next step.",
    });
    const toReturn = await escalateWorkItem({
      ...actor(returnId, pitCrew, returnClaim.version, propertyId),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
    });
    await returnEscalation({
      ...actor(returnId, admin, toReturn.assignment.version, propertyId),
      note: "Returned for Pit Crew to continue.",
    });
    const handed = await handBackWorkItem({
      ...actor(handId, pitCrew, handClaim.version, propertyId),
      reasonCategory: "WORK_COMPLETE",
      nextAction: NEXT_ACTION,
      recipientUserId: agent.user.id,
    });
    const beforeReclaim = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
    assert.ok(byId(beforeReclaim, handId));
    await reclaimHandedBack(actor(handId, pitCrew, handed.assignment.version, propertyId));

    const adminInbox = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");
    const agentInbox = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
    assert.equal(byId(adminInbox, ackId), undefined);
    assert.equal(byId(adminInbox, returnId), undefined);
    assert.equal(byId(agentInbox, handId), undefined);
  });

  test("financial titles match the exception read", async () => {
    const agentTitle = `${SECRET} agent hand-back`;
    const adminTitle = `${SECRET} admin escalation`;
    const pitTitle = `${SECRET} pit crew escalation`;
    const shownDespiteCategory = "FINANCIAL category without the entitlement flag";
    const hiddenDespiteCategory = `${SECRET} launch campaign with entitlement`;

    const agentId = await createException(propertyId, brokerageId, {
      category: "FINANCIAL",
      requiresFinancialEntitlement: true,
      title: agentTitle,
    });
    const adminId = await createException(propertyId, brokerageId, {
      category: "FINANCIAL",
      requiresFinancialEntitlement: true,
      title: adminTitle,
    });
    const pitId = await createException(propertyId, brokerageId, {
      category: "FINANCIAL",
      requiresFinancialEntitlement: true,
      title: pitTitle,
    });
    const visibleFinancialCategoryId = await createException(propertyId, brokerageId, {
      category: "FINANCIAL",
      requiresFinancialEntitlement: false,
      title: shownDespiteCategory,
    });
    const hiddenLaunchId = await createException(propertyId, brokerageId, {
      category: "LAUNCH_CAMPAIGN",
      requiresFinancialEntitlement: true,
      title: hiddenDespiteCategory,
    });

    const agentClaim = await claim(agentId, pitCrew, propertyId);
    await handBackWorkItem({
      ...actor(agentId, pitCrew, agentClaim.version, propertyId),
      reasonCategory: "WORK_COMPLETE",
      note: "Evidence is back with the agent.",
      nextAction: NEXT_ACTION,
    });
    const adminClaim = await claim(adminId, pitCrew, propertyId);
    await escalateWorkItem({
      ...actor(adminId, pitCrew, adminClaim.version, propertyId),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
    });
    const pitClaim = await claim(pitId, pitCrew, propertyId);
    const pitEscalation = await escalateWorkItem({
      ...actor(pitId, pitCrew, pitClaim.version, propertyId),
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: ESCALATION_NOTE,
      nextAction: ESCALATION_NEXT,
      recipientUserId: admin.user.id,
    });
    await db
      .update(pitCrewResponsibilityEvents)
      .set({ recipientUserId: pitCrew.user.id, recipientRole: null })
      .where(eq(pitCrewResponsibilityEvents.id, pitEscalation.responsibilityEvent.id));
    const visibleClaim = await claim(visibleFinancialCategoryId, pitCrew, propertyId);
    await handBackWorkItem({
      ...actor(visibleFinancialCategoryId, pitCrew, visibleClaim.version, propertyId),
      reasonCategory: "INFORMATION_RETURNED",
      nextAction: NEXT_ACTION,
    });
    const hiddenClaim = await claim(hiddenLaunchId, pitCrew, propertyId);
    await handBackWorkItem({
      ...actor(hiddenLaunchId, pitCrew, hiddenClaim.version, propertyId),
      reasonCategory: "INFORMATION_RETURNED",
      nextAction: NEXT_ACTION,
    });

    const agentInbox = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
    const pitInbox = await listResponsibilityItemsForRecipient(brokerageId, pitCrew.user.id, "Pit Crew");
    const adminInbox = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");

    const agentItem = byId(agentInbox, agentId);
    const pitItem = byId(pitInbox, pitId);
    const adminItem = byId(adminInbox, adminId);
    const visibleItem = byId(agentInbox, visibleFinancialCategoryId);
    const hiddenLaunch = byId(agentInbox, hiddenLaunchId);
    assert.ok(agentItem && pitItem && adminItem && visibleItem && hiddenLaunch);

    assert.equal(agentItem.title, await titleFromExceptionRead(false, agentId));
    assert.equal(agentItem.title, listedExceptionTitle({ title: agentTitle, requiresFinancialEntitlement: true }, false));
    assert.equal(agentItem.title, null);
    assert.equal(agentItem.note, "Evidence is back with the agent.");
    assert.equal(agentItem.nextAction, NEXT_ACTION);

    assert.equal(pitItem.title, await titleFromExceptionRead(false, pitId));
    assert.equal(pitItem.title, null);
    assert.equal(pitItem.note, ESCALATION_NOTE);
    assert.equal(pitItem.nextAction, ESCALATION_NEXT);

    assert.equal(adminItem.title, await titleFromExceptionRead(true, adminId));
    assert.equal(adminItem.title, listedExceptionTitle({ title: adminTitle, requiresFinancialEntitlement: true }, true));
    assert.equal(adminItem.title, adminTitle);

    assert.equal(visibleItem.title, shownDespiteCategory);
    assert.equal(visibleItem.title, await titleFromExceptionRead(false, visibleFinancialCategoryId));
    assert.equal(hiddenLaunch.title, null);
    assert.equal(hiddenLaunch.title, await titleFromExceptionRead(false, hiddenLaunchId));

    assert.equal(JSON.stringify(agentInbox).includes(SECRET), false);
    assert.equal(JSON.stringify(pitInbox).includes(SECRET), false);
    assert.equal(JSON.stringify(adminItem).includes("amountCents"), false);
  });

  test("orders by expectedResponseAt nulls last, then createdAt, then id", async () => {
    async function roleEscalation(): Promise<{ sourceRecordId: string; eventId: number }> {
      const sourceRecordId = await createException();
      const claimed = await claim(sourceRecordId, pitCrew, propertyId);
      const escalated = await escalateWorkItem({
        ...actor(sourceRecordId, pitCrew, claimed.version, propertyId),
        reasonCategory: "OVERDUE_THIRD_PARTY",
        severity: "ATTENTION",
        note: ESCALATION_NOTE,
        nextAction: ESCALATION_NEXT,
      });
      return { sourceRecordId, eventId: escalated.responsibilityEvent.id };
    }

    const early = await roleEscalation();
    const late = await roleEscalation();
    const nullFirst = await roleEscalation();
    const nullSecond = await roleEscalation();
    const sameTimeLowerId = nullFirst.eventId < nullSecond.eventId ? nullFirst : nullSecond;
    const sameTimeHigherId = sameTimeLowerId === nullFirst ? nullSecond : nullFirst;

    await db
      .update(pitCrewResponsibilityEvents)
      .set({
        expectedResponseAt: new Date("2026-10-01T00:00:00.000Z"),
        createdAt: new Date("2026-09-01T00:00:03.000Z"),
      })
      .where(eq(pitCrewResponsibilityEvents.id, early.eventId));
    await db
      .update(pitCrewResponsibilityEvents)
      .set({
        expectedResponseAt: new Date("2026-10-03T00:00:00.000Z"),
        createdAt: new Date("2026-09-01T00:00:01.000Z"),
      })
      .where(eq(pitCrewResponsibilityEvents.id, late.eventId));
    const tiedCreatedAt = new Date("2026-09-01T00:00:04.000Z");
    await db
      .update(pitCrewResponsibilityEvents)
      .set({ expectedResponseAt: null, createdAt: tiedCreatedAt })
      .where(eq(pitCrewResponsibilityEvents.id, sameTimeLowerId.eventId));
    await db
      .update(pitCrewResponsibilityEvents)
      .set({ expectedResponseAt: null, createdAt: tiedCreatedAt })
      .where(eq(pitCrewResponsibilityEvents.id, sameTimeHigherId.eventId));

    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => statements.push(query));
    let inbox: ResponsibilityInbox;
    try {
      inbox = await listResponsibilityItemsForRecipient(brokerageId, admin.user.id, "Brokerage Administrator");
    } finally {
      uninstall();
    }

    const tracked = [early.sourceRecordId, late.sourceRecordId, sameTimeLowerId.sourceRecordId, sameTimeHigherId.sourceRecordId];
    const order = inbox.items.map((item) => item.sourceRecordId).filter((id) => tracked.includes(id));
    assert.deepEqual(order, [
      early.sourceRecordId,
      late.sourceRecordId,
      sameTimeLowerId.sourceRecordId,
      sameTimeHigherId.sourceRecordId,
    ]);

    const joined = statements.join("\n");
    const orderBy = joined.slice(joined.toLowerCase().lastIndexOf("order by"));
    const responseAt = orderBy.search(/expected_response_at" asc nulls last/i);
    const createdAt = orderBy.search(/created_at" asc/i);
    const idAt = orderBy.search(/"id" asc/i);
    assert.ok(responseAt >= 0 && createdAt > responseAt && idAt > createdAt, orderBy);
    assert.equal(/join\s+"financial_|from\s+"financial_|commission_|pc_fee_|marketing_payment/i.test(joined), false);
    assert.equal(joined.includes("problem_description"), false);
    assert.equal(joined.includes("recommended_action"), false);
  });
});
