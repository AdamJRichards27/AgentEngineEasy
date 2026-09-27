// R-F16 — HTTP surface for hand-back, escalate, acknowledge, resolve,
// return, and reclaim. The flag is off unless it is the literal "true".
// While off, all six routes are 404 and write no responsibility event.
// While on, the routes are thin wrappers: zod, the library, and the
// existing Pit Crew error mapper. Agents stay on requireRole's 403.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, pitCrewAssignments, pitCrewResponsibilityEvents, users } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG } from "../../lib/pitCrew/responsibility.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const NOT_FOUND = JSON.stringify({ error: "Not found." });
const INVALID = JSON.stringify({ error: "Invalid request." });
const FORBIDDEN = JSON.stringify({ error: "Forbidden" });
const ASSIGNEE_NOT_FOUND = JSON.stringify({ error: "Assignee not found in this brokerage." });
const PROPERTY_NOT_FOUND = JSON.stringify({ error: "Property not found in this brokerage." });
const WORK_ITEM_NOT_FOUND = JSON.stringify({ error: "Work item not found in this brokerage." });
const ORIGINATOR_FORBIDDEN = JSON.stringify({ error: "Not allowed to act on this responsibility event." });

const ROUTES = [
  "hand-back",
  "escalate",
  "escalation/acknowledge",
  "escalation/resolve",
  "escalation/return",
  "hand-back/reclaim",
] as const;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let fixtureCounter = 0;
let savedFlag: string | undefined;
let admin: DevLoginResult;
let agent: DevLoginResult;
let pitCrew: DevLoginResult;
let brokerageId: number;
let propertyId: number;
let otherAgent: DevLoginResult;
let otherBrokerageId: number;
let otherPropertyId: number;

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

async function postItem(sourceType: string, sourceRecordId: string, action: string, cookie: string, body: unknown) {
  return postRaw(`/pit-crew/items/${sourceType}/${sourceRecordId}/${action}`, cookie, body);
}

function isolationSeries(): Array<{ boundary: string; value: number }> {
  const found: Array<{ boundary: string; value: number }> = [];
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
    const match = /^tenant_isolation_rejection_total\{boundary="([^"]*)"\} (\d+)$/.exec(line);
    assert.ok(match, `unparsed metric line: ${line}`);
    found.push({ boundary: match[1], value: Number(match[2]) });
  }
  return found;
}

async function assertJson(res: Response, status: number, body: string): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(await res.text(), body);
}

function buildFinding(targetPropertyId: number, targetBrokerageId: number): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_RF16_ROUTE_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `R-F16 finding ${fixtureCounter}`,
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
    dedupKey: `TEST_RF16_ROUTE_RULE:${targetBrokerageId}:RF16_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
}

async function createException(targetBrokerageId = brokerageId, targetPropertyId = propertyId): Promise<string> {
  const result = await createOrUpdateException(
    buildFinding(targetPropertyId, targetBrokerageId),
    targetBrokerageId,
    targetPropertyId,
    null,
    newCorrelationId(),
    null,
  );
  return result.exception.id;
}

async function claim(sourceRecordId: string): Promise<{ id: number; version: number; status: string; assignedToUserId: number | null }> {
  const res = await postItem("EXCEPTION", sourceRecordId, "claim", pitCrew.cookie, {
    propertyId,
    expectedVersion: 0,
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json() as Promise<{ id: number; version: number; status: string; assignedToUserId: number | null }>;
}

async function eventsFor(sourceRecordId: string) {
  const [assignment] = await db
    .select({ id: pitCrewAssignments.id })
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)))
    .limit(1);
  if (!assignment) return [];
  return db
    .select()
    .from(pitCrewResponsibilityEvents)
    .where(eq(pitCrewResponsibilityEvents.assignmentId, assignment.id));
}

async function auditActions(sourceRecordId: string, action: string) {
  return db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "EXCEPTION"), eq(auditLogs.recordId, sourceRecordId), eq(auditLogs.action, action)));
}

function handBackBody(version: number, overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    expectedVersion: version,
    reasonCategory: "WORK_COMPLETE",
    nextAction: "Review the returned condition evidence and confirm the next step.",
    ...overrides,
  };
}

function escalateBody(version: number, overrides: Record<string, unknown> = {}) {
  return {
    propertyId,
    expectedVersion: version,
    reasonCategory: "MISSING_AUTHORITY",
    severity: "ATTENTION",
    note: "Settlement figure is outside Pit Crew authority.",
    nextAction: "Decide whether the brokerage will authorise the next settlement step.",
    ...overrides,
  };
}

type MutationBody = {
  status: string;
  version: number;
  assignedToUserId: number | null;
  propertyId: number;
  sourceType: string;
  sourceRecordId: string;
  responsibilityEvent: {
    kind: string;
    status: string;
    note: string | null;
    closingNote: string | null;
    reasonCategory: string;
    severity: string | null;
    nextAction: string;
    recipientUserId: number | null;
    recipientRole: string | null;
    originatingUserId: number;
    resultingResponsibility: string;
  };
};

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

  const created = await createBrokerageWithUsers(baseUrl, `R-F16 Routes ${suffix}`);
  admin = created.admin;
  agent = created.agent;
  brokerageId = created.brokerageId;
  pitCrew = await devLogin(baseUrl, {
    email: `pitcrew-rf16-${brokerageId}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: admin.user.brokerageName!,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));

  const property = await postRaw("/properties", agent.cookie, {
    formattedAddress: `${suffix} Responsibility St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(property.status, 201);
  propertyId = ((await property.json()) as { property: { id: number } }).property.id;

  const other = await createBrokerageWithUsers(baseUrl, `R-F16 Routes Other ${suffix}`);
  otherAgent = other.agent;
  otherBrokerageId = other.brokerageId;
  const otherProperty = await postRaw("/properties", other.agent.cookie, {
    formattedAddress: `${suffix} Other Responsibility St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(otherProperty.status, 201);
  otherPropertyId = ((await otherProperty.json()) as { property: { id: number } }).property.id;
});

after(async () => {
  if (savedFlag === undefined) delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
  else process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = savedFlag;
  await cleanupBrokerages([brokerageId, otherBrokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F16 Pit Crew hand-back and escalate routes", { concurrency: 1 }, () => {
  test("flag unset: all six routes return 404 and insert no responsibility event", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    const valid = {
      "hand-back": handBackBody(claimed.version),
      escalate: escalateBody(claimed.version),
      "escalation/acknowledge": { propertyId, expectedVersion: claimed.version },
      "escalation/resolve": { propertyId, expectedVersion: claimed.version, note: "Resolved in test." },
      "escalation/return": { propertyId, expectedVersion: claimed.version, note: "Returned in test." },
      "hand-back/reclaim": { propertyId, expectedVersion: claimed.version },
    } as const;

    try {
      delete process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG];
      for (const action of ROUTES) {
        const empty = await postItem("EXCEPTION", sourceRecordId, action, pitCrew.cookie, {});
        await assertJson(empty, 404, NOT_FOUND);
        const filled = await postItem("EXCEPTION", sourceRecordId, action, pitCrew.cookie, valid[action]);
        await assertJson(filled, 404, NOT_FOUND);
      }
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "TRUE";
      const stillOff = await postItem("EXCEPTION", sourceRecordId, "hand-back", pitCrew.cookie, valid["hand-back"]);
      await assertJson(stillOff, 404, NOT_FOUND);
    } finally {
      process.env[PIT_CREW_RESPONSIBILITY_ACTIONS_FLAG] = "true";
    }

    assert.equal((await eventsFor(sourceRecordId)).length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
    assert.equal(row?.version, claimed.version);
  });

  test("bad body and a reason or severity outside the enum are 400", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    const cases: Array<{ action: (typeof ROUTES)[number]; body: unknown }> = [
      { action: "hand-back", body: { propertyId, expectedVersion: claimed.version, reasonCategory: "WORK_COMPLETE" } },
      { action: "hand-back", body: handBackBody(claimed.version, { reasonCategory: "NOT_A_REASON" }) },
      { action: "escalate", body: escalateBody(claimed.version, { severity: "INFORMATION" }) },
      { action: "escalate", body: escalateBody(claimed.version, { reasonCategory: "WORK_COMPLETE" }) },
      { action: "escalate", body: escalateBody(claimed.version, { severity: "AT_RISK" }) },
      { action: "escalate", body: escalateBody(claimed.version, { recipientRole: "Agent" }) },
      { action: "escalation/resolve", body: { propertyId, expectedVersion: claimed.version } },
      { action: "escalation/return", body: { propertyId, expectedVersion: claimed.version, note: "   " } },
      { action: "hand-back/reclaim", body: { propertyId, expectedVersion: claimed.version, note: "no" } },
    ];
    for (const item of cases) {
      const res = await postItem("EXCEPTION", sourceRecordId, item.action, pitCrew.cookie, item.body);
      await assertJson(res, 400, INVALID);
    }
    assert.equal((await eventsFor(sourceRecordId)).length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
  });

  test("an Agent is 403 on all six routes", async () => {
    const sourceRecordId = await createException();
    for (const action of ROUTES) {
      const res = await postItem("EXCEPTION", sourceRecordId, action, agent.cookie, handBackBody(1));
      await assertJson(res, 403, FORBIDDEN);
    }
    assert.equal((await eventsFor(sourceRecordId)).length, 0);
  });

  test("a Pit Crew originator who is not an administrator cannot resolve", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    const escalated = await postItem("EXCEPTION", sourceRecordId, "escalate", pitCrew.cookie, escalateBody(claimed.version));
    assert.equal(escalated.status, 200, await escalated.clone().text());
    const open = (await escalated.json()) as MutationBody;
    assert.equal(open.responsibilityEvent.note, "Settlement figure is outside Pit Crew authority.");

    const res = await postItem("EXCEPTION", sourceRecordId, "escalation/resolve", pitCrew.cookie, {
      propertyId,
      expectedVersion: open.version,
      note: "Pit Crew tried to close its own escalation.",
    });
    await assertJson(res, 403, ORIGINATOR_FORBIDDEN);

    const events = await eventsFor(sourceRecordId);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, "OPEN");
    assert.equal(events[0]?.note, "Settlement figure is outside Pit Crew authority.");
    assert.equal(events[0]?.closingNote, null);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "ESCALATED");
    assert.equal(row?.assignedToUserId, pitCrew.user.id);
    assert.equal(row?.version, open.version);
  });

  test("non-EXCEPTION source type, a cross-tenant property, and acknowledge with no open escalation are 404", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);

    const wrongType = await postItem("OFFER", sourceRecordId, "hand-back", pitCrew.cookie, handBackBody(claimed.version));
    await assertJson(wrongType, 404, WORK_ITEM_NOT_FOUND);

    const foreignProperty = await postItem("EXCEPTION", sourceRecordId, "hand-back", pitCrew.cookie, handBackBody(claimed.version, { propertyId: otherPropertyId }));
    await assertJson(foreignProperty, 404, PROPERTY_NOT_FOUND);

    await db.update(pitCrewAssignments).set({ status: "ESCALATED" }).where(eq(pitCrewAssignments.id, claimed.id));
    const missing = await postItem("EXCEPTION", sourceRecordId, "escalation/acknowledge", admin.cookie, {
      propertyId,
      expectedVersion: claimed.version,
    });
    await assertJson(missing, 404, NOT_FOUND);

    assert.equal((await eventsFor(sourceRecordId)).length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "ESCALATED");
    assert.equal(row?.version, claimed.version);
  });

  test("a recipient in another brokerage is 404 and increments the pit_crew isolation counter once", async () => {
    const sourceRecordId = await createException();
    const claimed = await claim(sourceRecordId);
    resetMetricsForTesting();

    const res = await postItem(
      "EXCEPTION",
      sourceRecordId,
      "hand-back",
      pitCrew.cookie,
      handBackBody(claimed.version, { recipientUserId: otherAgent.user.id }),
    );
    await assertJson(res, 404, ASSIGNEE_NOT_FOUND);

    const series = isolationSeries();
    assert.equal(series.length, 1);
    assert.equal(series[0]?.boundary, "pit_crew");
    assert.equal(series[0]?.value, 1);
    assert.equal((await eventsFor(sourceRecordId)).length, 0);
    const [row] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(row?.status, "CLAIMED");
    assert.equal(row?.version, claimed.version);
  });

  test("a stale expectedVersion is 409 and the wrong status is 422", async () => {
    const staleId = await createException();
    const claimed = await claim(staleId);
    const stale = await postItem("EXCEPTION", staleId, "hand-back", pitCrew.cookie, handBackBody(999));
    await assertJson(stale, 409, JSON.stringify({ error: "This item was changed by someone else. Refresh and try again." }));
    assert.equal((await eventsFor(staleId)).length, 0);
    const [staleRow] = await db.select().from(pitCrewAssignments).where(eq(pitCrewAssignments.id, claimed.id));
    assert.equal(staleRow?.status, "CLAIMED");
    assert.equal(staleRow?.version, claimed.version);

    const unclaimedId = await createException();
    const unclaimed = await postItem("EXCEPTION", unclaimedId, "hand-back", pitCrew.cookie, handBackBody(0));
    await assertJson(unclaimed, 422, JSON.stringify({ error: "Cannot hand back a Pit Crew item in status UNCLAIMED." }));
    assert.equal((await eventsFor(unclaimedId)).length, 0);

    const doneId = await createException();
    const doneClaim = await claim(doneId);
    const completed = await postItem("EXCEPTION", doneId, "complete", pitCrew.cookie, {
      propertyId,
      expectedVersion: doneClaim.version,
    });
    assert.equal(completed.status, 200);
    const doneRow = (await completed.json()) as { version: number; status: string };
    assert.equal(doneRow.status, "DONE");
    const done = await postItem("EXCEPTION", doneId, "escalate", pitCrew.cookie, escalateBody(doneRow.version));
    await assertJson(done, 422, JSON.stringify({ error: "Cannot escalate a Pit Crew item in status DONE." }));
    assert.equal((await eventsFor(doneId)).length, 0);
  });

  test("happy path: hand-back, reclaim, escalate, acknowledge, resolve, and return", async () => {
    const handId = await createException();
    const claimed = await claim(handId);
    const handedRes = await postItem("EXCEPTION", handId, "hand-back", pitCrew.cookie, handBackBody(claimed.version, {
      note: "Evidence is back with the agent.",
    }));
    assert.equal(handedRes.status, 200);
    const handed = (await handedRes.json()) as MutationBody;
    assert.equal(handed.status, "HANDED_BACK");
    assert.equal(handed.assignedToUserId, null);
    assert.equal(handed.propertyId, propertyId);
    assert.equal(handed.sourceType, "EXCEPTION");
    assert.equal(handed.sourceRecordId, handId);
    assert.equal(handed.responsibilityEvent.kind, "HAND_BACK");
    assert.equal(handed.responsibilityEvent.status, "OPEN");
    assert.equal(handed.responsibilityEvent.reasonCategory, "WORK_COMPLETE");
    assert.equal(handed.responsibilityEvent.note, "Evidence is back with the agent.");
    assert.equal(handed.responsibilityEvent.closingNote, null);
    assert.equal(handed.responsibilityEvent.severity, null);
    assert.equal(handed.responsibilityEvent.recipientUserId, agent.user.id);
    assert.equal(handed.responsibilityEvent.recipientRole, null);
    assert.equal(handed.responsibilityEvent.resultingResponsibility, "AGENT");
    assert.equal(handed.responsibilityEvent.originatingUserId, pitCrew.user.id);
    assert.equal((await auditActions(handId, "PC_HANDED_BACK")).length, 1);

    const reclaimedRes = await postItem("EXCEPTION", handId, "hand-back/reclaim", pitCrew.cookie, {
      propertyId,
      expectedVersion: handed.version,
    });
    assert.equal(reclaimedRes.status, 200);
    const reclaimed = (await reclaimedRes.json()) as MutationBody;
    assert.equal(reclaimed.status, "CLAIMED");
    assert.equal(reclaimed.assignedToUserId, pitCrew.user.id);
    assert.equal(reclaimed.responsibilityEvent.status, "SUPERSEDED");
    assert.equal(reclaimed.responsibilityEvent.kind, "HAND_BACK");
    assert.equal((await auditActions(handId, "PC_RECLAIMED")).length, 1);

    const resolveId = await createException();
    const resolveClaim = await claim(resolveId);
    const escalatedRes = await postItem("EXCEPTION", resolveId, "escalate", pitCrew.cookie, escalateBody(resolveClaim.version, {
      severity: "AT_RISK",
      expectedResponseAt: "2026-10-01T04:00:00.000Z",
    }));
    assert.equal(escalatedRes.status, 200);
    const escalated = (await escalatedRes.json()) as MutationBody;
    assert.equal(escalated.status, "ESCALATED");
    assert.equal(escalated.assignedToUserId, pitCrew.user.id);
    assert.equal(escalated.responsibilityEvent.kind, "ESCALATION");
    assert.equal(escalated.responsibilityEvent.status, "OPEN");
    assert.equal(escalated.responsibilityEvent.reasonCategory, "MISSING_AUTHORITY");
    assert.equal(escalated.responsibilityEvent.severity, "AT_RISK");
    assert.equal(escalated.responsibilityEvent.note, "Settlement figure is outside Pit Crew authority.");
    assert.equal(escalated.responsibilityEvent.closingNote, null);
    assert.equal(escalated.responsibilityEvent.recipientUserId, null);
    assert.equal(escalated.responsibilityEvent.recipientRole, "Brokerage Administrator");
    assert.equal(escalated.responsibilityEvent.resultingResponsibility, "BROKERAGE_ADMINISTRATOR");
    assert.equal((await auditActions(resolveId, "PC_ESCALATED")).length, 1);

    const acknowledgedRes = await postItem("EXCEPTION", resolveId, "escalation/acknowledge", admin.cookie, {
      propertyId,
      expectedVersion: escalated.version,
      note: "Seen.",
    });
    assert.equal(acknowledgedRes.status, 200);
    const acknowledged = (await acknowledgedRes.json()) as MutationBody;
    assert.equal(acknowledged.status, "ESCALATED");
    assert.equal(acknowledged.assignedToUserId, pitCrew.user.id);
    assert.equal(acknowledged.version, escalated.version + 1);
    assert.equal(acknowledged.responsibilityEvent.status, "ACKNOWLEDGED");
    assert.equal(acknowledged.responsibilityEvent.note, "Settlement figure is outside Pit Crew authority.");
    assert.equal(acknowledged.responsibilityEvent.closingNote, null);
    assert.equal((await auditActions(resolveId, "PC_ESCALATION_ACKNOWLEDGED")).length, 1);

    const resolvedRes = await postItem("EXCEPTION", resolveId, "escalation/resolve", admin.cookie, {
      propertyId,
      expectedVersion: acknowledged.version,
      note: "Authorised the next settlement step.",
    });
    assert.equal(resolvedRes.status, 200);
    const resolved = (await resolvedRes.json()) as MutationBody;
    assert.equal(resolved.status, "IN_PROGRESS");
    assert.equal(resolved.assignedToUserId, pitCrew.user.id);
    assert.equal(resolved.responsibilityEvent.status, "RESOLVED");
    assert.equal(resolved.responsibilityEvent.note, "Settlement figure is outside Pit Crew authority.");
    assert.equal(resolved.responsibilityEvent.closingNote, "Authorised the next settlement step.");
    assert.equal((await auditActions(resolveId, "PC_ESCALATION_RESOLVED")).length, 1);

    const returnId = await createException();
    const returnClaim = await claim(returnId);
    const returnEscalatedRes = await postItem("EXCEPTION", returnId, "escalate", pitCrew.cookie, escalateBody(returnClaim.version));
    assert.equal(returnEscalatedRes.status, 200);
    const returnEscalated = (await returnEscalatedRes.json()) as MutationBody;
    const returnedRes = await postItem("EXCEPTION", returnId, "escalation/return", admin.cookie, {
      propertyId,
      expectedVersion: returnEscalated.version,
      note: "Returned for Pit Crew to continue.",
    });
    assert.equal(returnedRes.status, 200);
    const returned = (await returnedRes.json()) as MutationBody;
    assert.equal(returned.status, "IN_PROGRESS");
    assert.equal(returned.assignedToUserId, pitCrew.user.id);
    assert.equal(returned.responsibilityEvent.status, "RETURNED");
    assert.equal(returned.responsibilityEvent.note, "Settlement figure is outside Pit Crew authority.");
    assert.equal(returned.responsibilityEvent.closingNote, "Returned for Pit Crew to continue.");
    assert.equal((await auditActions(returnId, "PC_ESCALATION_RETURNED")).length, 1);
  });
});
