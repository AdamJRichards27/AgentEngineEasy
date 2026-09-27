// R-F16 PR 4 — GET /pit-crew/responsibility-inbox.
// Flag off is 404 and does not query pit_crew_responsibility_events.
// The route's role list is Agent, Pit Crew, and Brokerage Administrator.
// canAccess is unchanged, so the workspace still refuses an Agent.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, pitCrewResponsibilityEvents, setDbQueryObserver, users } from "@aee/db";
import { listBrokerageExceptions } from "../../lib/exceptions/queries.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG } from "../../lib/pitCrew/responsibility.js";
import { listResponsibilityItemsForRecipient } from "../../lib/pitCrew/queries.js";
import type { ResponsibilityInbox, ResponsibilityInboxItem } from "../../lib/pitCrew/types.js";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

const NOT_FOUND = JSON.stringify({ error: "Not found." });
const FORBIDDEN = JSON.stringify({ error: "Forbidden" });
const SECRET = "RF16-ROUTE-FIN-12500";
const NEXT_ACTION = "Review the returned condition evidence and confirm the next step.";

const INBOX_KEYS = [
  "assignmentStatus",
  "createdAt",
  "deepLink",
  "eventStatus",
  "expectedResponseAt",
  "kind",
  "nextAction",
  "note",
  "operatorDisplayName",
  "originatingUserId",
  "propertyAddress",
  "propertyId",
  "reasonCategory",
  "recipientDisplayName",
  "recipientRole",
  "recipientUserId",
  "severity",
  "sourceRecordId",
  "sourceType",
  "title",
  "version",
];

describe("GET /pit-crew/responsibility-inbox", { concurrency: false }, () => {
  let server: Server;
  let baseUrl: string;
  let admin: DevLoginResult;
  let agent: DevLoginResult;
  let secondAgent: DevLoginResult;
  let pitCrew: DevLoginResult;
  let outsider: DevLoginResult;
  let foreignAdmin: DevLoginResult;
  let brokerageId: number;
  let otherBrokerageId: number;
  let propertyId: number;
  let secondPropertyId: number;
  let otherPropertyId: number;
  let fixtureCounter = 0;
  let savedFlag: string | undefined;

  function headers(cookie: string): Record<string, string> {
    return { cookie, "content-type": "application/json" };
  }

  async function postRaw(path: string, cookie: string, body: unknown) {
    return fetch(`${baseUrl}/api${path}`, {
      method: "POST",
      headers: headers(cookie),
      body: JSON.stringify(body),
    });
  }

  async function getInbox(cookie?: string, query = ""): Promise<Response> {
    return fetch(`${baseUrl}/api/pit-crew/responsibility-inbox${query}`, {
      headers: cookie ? { cookie } : {},
    });
  }

  function buildFinding(targetPropertyId: number, targetBrokerageId: number, overrides: Partial<RiskFinding> = {}): RiskFinding {
    fixtureCounter += 1;
    return {
      ruleId: "TEST_RF16_INBOX_ROUTE_RULE",
      ruleVersion: 1,
      category: "WORKFLOW_OPERATIONAL",
      severity: "ATTENTION",
      title: `R-F16 inbox finding ${fixtureCounter}`,
      problemDescription: "A test problem that must not be copied onto the inbox.",
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
      dedupKey: `TEST_RF16_INBOX_ROUTE_RULE:${targetBrokerageId}:INBOX_${fixtureCounter}`,
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

  async function claim(sourceRecordId: string, targetPropertyId = propertyId) {
    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/claim`, pitCrew.cookie, {
      propertyId: targetPropertyId,
      expectedVersion: 0,
    });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json() as Promise<{ version: number }>;
  }

  async function setRunAccess(active: boolean): Promise<void> {
    await db
      .update(entitlementGrants)
      .set({ status: active ? "Active" : "Revoked" })
      .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
    invalidateEntitlementCache(brokerageId);
  }

  before(async () => {
    savedFlag = process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    const { configureEvents } = await import("../../lib/events.js");
    configureEvents();
    const { createApp } = await import("../../app.js");
    const app = createApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("unexpected server address");
    baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await createBrokerageWithUsers(baseUrl, `R-F16 Inbox ${Date.now()}`);
    admin = created.admin;
    agent = created.agent;
    brokerageId = created.brokerageId;
    pitCrew = await devLogin(baseUrl, {
      email: `pitcrew-rf16-inbox-${brokerageId}@example.com`,
      firstName: "Pit",
      lastName: "Crew",
      brokerageName: admin.user.brokerageName!,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
    secondAgent = await devLogin(baseUrl, {
      email: `agent2-rf16-inbox-${brokerageId}@example.com`,
      firstName: "Second",
      lastName: "Agent",
      brokerageName: admin.user.brokerageName!,
    });
    outsider = await devLogin(baseUrl, {
      email: `vendor-rf16-inbox-${brokerageId}@example.com`,
      firstName: "Outside",
      lastName: "Role",
      brokerageName: admin.user.brokerageName!,
    });

    async function createProperty(cookie: string, address: string): Promise<number> {
      const res = await postRaw("/properties", cookie, {
        formattedAddress: address,
        state: "NSW",
        suburb: "Testville",
        postcode: "2000",
      });
      assert.equal(res.status, 201, await res.clone().text());
      return ((await res.json()) as { property: { id: number } }).property.id;
    }

    propertyId = await createProperty(agent.cookie, "1 Route Inbox St");
    secondPropertyId = await createProperty(secondAgent.cookie, "2 Route Inbox St");

    const other = await createBrokerageWithUsers(baseUrl, `R-F16 Inbox Other ${Date.now()}`);
    foreignAdmin = other.admin;
    otherBrokerageId = other.brokerageId;
    otherPropertyId = await createProperty(other.agent.cookie, "9 Other Route Inbox St");
  });

  after(async () => {
    if (savedFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
    else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
    await db.update(users).set({ role: "Agent" }).where(eq(users.id, outsider.user.id));
    await setRunAccess(true);
    await cleanupBrokerages([brokerageId, otherBrokerageId]);
    if (server) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  test("flag off returns 404 and does not query pit_crew_responsibility_events", async () => {
    const statements: string[] = [];
    const uninstall = setDbQueryObserver((query) => statements.push(query));
    try {
      delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      const missing = await getInbox();
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), NOT_FOUND);

      const authed = await getInbox(agent.cookie, `?userId=${admin.user.id}`);
      assert.equal(authed.status, 404);
      assert.equal(await authed.text(), NOT_FOUND);

      await setRunAccess(false);
      const unentitled = await getInbox(agent.cookie);
      assert.equal(unentitled.status, 404);
      assert.equal(await unentitled.text(), NOT_FOUND);

      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "TRUE";
      const stillOff = await getInbox(admin.cookie);
      assert.equal(stillOff.status, 404);
      assert.equal(await stillOff.text(), NOT_FOUND);
    } finally {
      uninstall();
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
      await setRunAccess(true);
    }
    assert.equal(
      statements.some((query) => query.includes("pit_crew_responsibility_events")),
      false,
    );
  });

  test("an unauthenticated caller is 401 and a role outside the list is 403", async () => {
    const anon = await getInbox();
    assert.equal(anon.status, 401);
    assert.equal(await anon.text(), JSON.stringify({ error: "Not authenticated" }));

    await db.update(users).set({ role: "Vendor" }).where(eq(users.id, outsider.user.id));
    try {
      const res = await getInbox(outsider.cookie);
      assert.equal(res.status, 403);
      assert.equal(await res.text(), FORBIDDEN);
    } finally {
      await db.update(users).set({ role: "Agent" }).where(eq(users.id, outsider.user.id));
    }
  });

  test("a brokerage without run.access is refused the same way as other Pit Crew routes", async () => {
    await setRunAccess(false);
    try {
      const res = await getInbox(agent.cookie);
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error?: string; reason?: string; entitlementKey?: string };
      assert.equal(body.error, "Not entitled");
      assert.equal(body.entitlementKey, "run.access");
    } finally {
      await setRunAccess(true);
    }
  });

  test("the workspace role gate still excludes Agents", async () => {
    const res = await fetch(`${baseUrl}/api/pit-crew/workspace`, { headers: { cookie: agent.cookie } });
    assert.equal(res.status, 403);
    assert.equal(await res.text(), FORBIDDEN);
  });

  test("an agent sees their hand-back and not another agent's, and a query param cannot name another user", async () => {
    const ownId = await createException(propertyId);
    const otherId = await createException(secondPropertyId);
    const ownClaim = await claim(ownId, propertyId);
    const otherClaim = await claim(otherId, secondPropertyId);
    const handed = await postRaw(`/pit-crew/items/EXCEPTION/${ownId}/hand-back`, pitCrew.cookie, {
      propertyId,
      expectedVersion: ownClaim.version,
      reasonCategory: "WORK_COMPLETE",
      note: "Evidence is back with the agent.",
      nextAction: NEXT_ACTION,
    });
    assert.equal(handed.status, 200, await handed.clone().text());
    const otherHanded = await postRaw(`/pit-crew/items/EXCEPTION/${otherId}/hand-back`, pitCrew.cookie, {
      propertyId: secondPropertyId,
      expectedVersion: otherClaim.version,
      reasonCategory: "NEXT_ACTION_WITH_AGENT",
      nextAction: NEXT_ACTION,
    });
    assert.equal(otherHanded.status, 200, await otherHanded.clone().text());

    const res = await getInbox(agent.cookie, `?userId=${secondAgent.user.id}&brokerageId=${otherBrokerageId}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as ResponsibilityInbox;
    assert.deepEqual(Object.keys(body).sort(), ["generatedAt", "items"]);
    const fromSession = await listResponsibilityItemsForRecipient(brokerageId, agent.user.id, "Agent");
    assert.deepEqual(body.items, fromSession.items);
    const own = body.items.find((item) => item.sourceRecordId === ownId);
    assert.ok(own);
    assert.equal(body.items.some((item) => item.sourceRecordId === otherId), false);
    assert.deepEqual(Object.keys(own).sort(), [...INBOX_KEYS].sort());
    assert.equal(own.deepLink, `/properties/${propertyId}`);
    assert.equal(own.propertyAddress, "1 Route Inbox St");
    assert.equal(own.kind, "HAND_BACK");
    assert.equal(own.eventStatus, "OPEN");
    assert.equal(own.note, "Evidence is back with the agent.");
    assert.equal(own.nextAction, NEXT_ACTION);
    assert.equal("closingNote" in own, false);

    const second = await getInbox(secondAgent.cookie);
    const secondBody = (await second.json()) as ResponsibilityInbox;
    assert.equal(second.status, 200);
    assert.ok(secondBody.items.some((item) => item.sourceRecordId === otherId));
    assert.equal(secondBody.items.some((item) => item.sourceRecordId === ownId), false);
  });

  test("a brokerage administrator sees a role-addressed escalation in their brokerage only", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    const escalated = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/escalate`, pitCrew.cookie, {
      propertyId,
      expectedVersion: claimed.version,
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: "Outside Pit Crew authority.",
      nextAction: "Decide the next settlement step.",
    });
    assert.equal(escalated.status, 200, await escalated.clone().text());

    const foreignId = await createException(otherPropertyId, otherBrokerageId);
    const foreignPit = await devLogin(baseUrl, {
      email: `pitcrew-rf16-inbox-other-${otherBrokerageId}@example.com`,
      firstName: "Other",
      lastName: "Crew",
      brokerageName: foreignAdmin.user.brokerageName!,
    });
    await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, foreignPit.user.id));
    const foreignClaim = await postRaw(`/pit-crew/items/EXCEPTION/${foreignId}/claim`, foreignPit.cookie, {
      propertyId: otherPropertyId,
      expectedVersion: 0,
    });
    assert.equal(foreignClaim.status, 200, await foreignClaim.clone().text());
    const foreignVersion = ((await foreignClaim.json()) as { version: number }).version;
    const foreignEscalated = await postRaw(`/pit-crew/items/EXCEPTION/${foreignId}/escalate`, foreignPit.cookie, {
      propertyId: otherPropertyId,
      expectedVersion: foreignVersion,
      reasonCategory: "MISSING_INFORMATION",
      severity: "ATTENTION",
      note: "Other brokerage.",
      nextAction: "Decide in the other brokerage.",
    });
    assert.equal(foreignEscalated.status, 200, await foreignEscalated.clone().text());

    const res = await getInbox(admin.cookie);
    assert.equal(res.status, 200);
    const body = (await res.json()) as ResponsibilityInbox;
    const item = body.items.find((row) => row.sourceRecordId === sourceRecordId);
    assert.ok(item);
    assert.equal(item.kind, "ESCALATION");
    assert.equal(item.recipientRole, "Brokerage Administrator");
    assert.equal(item.recipientUserId, null);
    assert.equal(item.assignmentStatus, "ESCALATED");
    assert.equal(body.items.some((row) => row.sourceRecordId === foreignId), false);

    const foreignRes = await getInbox(foreignAdmin.cookie);
    const foreignBody = (await foreignRes.json()) as ResponsibilityInbox;
    assert.equal(foreignRes.status, 200);
    assert.ok(foreignBody.items.some((row) => row.sourceRecordId === foreignId));
    assert.equal(foreignBody.items.some((row) => row.sourceRecordId === sourceRecordId), false);

    const agentRes = await getInbox(agent.cookie);
    const agentBody = (await agentRes.json()) as ResponsibilityInbox;
    assert.equal(agentBody.items.some((row) => row.sourceRecordId === sourceRecordId), false);
  });

  test("financial title redaction matches the exception read", async () => {
    const agentTitle = `${SECRET} agent`;
    const adminTitle = `${SECRET} admin`;
    const pitTitle = `${SECRET} pit`;

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

    const agentClaim = await claim(agentId);
    const handed = await postRaw(`/pit-crew/items/EXCEPTION/${agentId}/hand-back`, pitCrew.cookie, {
      propertyId,
      expectedVersion: agentClaim.version,
      reasonCategory: "WORK_COMPLETE",
      note: "Evidence is back with the agent.",
      nextAction: NEXT_ACTION,
    });
    assert.equal(handed.status, 200, await handed.clone().text());

    const adminClaim = await claim(adminId);
    const escalated = await postRaw(`/pit-crew/items/EXCEPTION/${adminId}/escalate`, pitCrew.cookie, {
      propertyId,
      expectedVersion: adminClaim.version,
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: "Outside Pit Crew authority.",
      nextAction: "Decide the next settlement step.",
    });
    assert.equal(escalated.status, 200, await escalated.clone().text());

    const pitClaim = await claim(pitId);
    const pitEscalated = await postRaw(`/pit-crew/items/EXCEPTION/${pitId}/escalate`, pitCrew.cookie, {
      propertyId,
      expectedVersion: pitClaim.version,
      reasonCategory: "MISSING_AUTHORITY",
      severity: "ATTENTION",
      note: "Outside Pit Crew authority.",
      nextAction: "Decide the next settlement step.",
      recipientUserId: admin.user.id,
    });
    assert.equal(pitEscalated.status, 200, await pitEscalated.clone().text());
    const pitEventId = ((await pitEscalated.json()) as { responsibilityEvent: { id: number } }).responsibilityEvent.id;
    await db
      .update(pitCrewResponsibilityEvents)
      .set({ recipientUserId: pitCrew.user.id, recipientRole: null })
      .where(eq(pitCrewResponsibilityEvents.id, pitEventId));

    async function listedTitle(canViewFinancials: boolean, exceptionId: string): Promise<string | null> {
      const page = await listBrokerageExceptions(brokerageId, canViewFinancials, null, { limit: 200, offset: 0 });
      return page.exceptions.find((row) => row.id === exceptionId)?.title ?? null;
    }

    const agentRes = await getInbox(agent.cookie);
    const agentBody = (await agentRes.json()) as ResponsibilityInbox;
    const agentItem = agentBody.items.find((item) => item.sourceRecordId === agentId) as ResponsibilityInboxItem;
    assert.ok(agentItem);
    assert.equal(agentItem.title, await listedTitle(false, agentId));
    assert.equal(agentItem.title, null);
    assert.equal(agentItem.nextAction, NEXT_ACTION);
    assert.equal(agentItem.note, "Evidence is back with the agent.");
    assert.equal(JSON.stringify(agentBody).includes(SECRET), false);
    assert.equal(JSON.stringify(agentItem).includes("problemDescription"), false);

    const adminRes = await getInbox(admin.cookie);
    const adminBody = (await adminRes.json()) as ResponsibilityInbox;
    const adminItem = adminBody.items.find((item) => item.sourceRecordId === adminId);
    assert.ok(adminItem);
    assert.equal(adminItem.title, await listedTitle(true, adminId));
    assert.equal(adminItem.title, adminTitle);

    const pitRes = await getInbox(pitCrew.cookie);
    const pitBody = (await pitRes.json()) as ResponsibilityInbox;
    const pitItem = pitBody.items.find((item) => item.sourceRecordId === pitId);
    assert.ok(pitItem);
    assert.equal(pitItem.title, await listedTitle(false, pitId));
    assert.equal(pitItem.title, null);
    assert.equal(JSON.stringify(pitBody).includes(SECRET), false);
  });
});
