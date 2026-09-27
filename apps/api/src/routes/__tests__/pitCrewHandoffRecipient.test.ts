// R-F11 — handoffWorkItem checks toUserId with assertUserInBrokerage before
// it loads the overlay. A same-brokerage handoff still returns the updated
// assignment row. A recipient in another brokerage and a missing user both
// return the existing assignee 404 and leave the row and its audit trail
// alone; only the cross-brokerage recipient increments
// tenant_isolation_rejection_total{boundary="pit_crew"}. A bad or foreign
// propertyId, with a valid same-brokerage recipient, still returns the
// existing property 404.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, pitCrewAssignments } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { cleanupBrokerages, createBrokerageWithUsers, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const MISSING_ID = 2_147_483_646;
const ASSIGNEE_NOT_FOUND = JSON.stringify({ error: "Assignee not found in this brokerage." });
const PROPERTY_NOT_FOUND = JSON.stringify({ error: "Property not found in this brokerage." });

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let fixtureCounter = 0;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
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

function assertIncrement(boundary: string): void {
  const series = isolationSeries();
  assert.equal(series.length, 1);
  assert.equal(series[0].boundary, boundary);
  assert.equal(series[0].value, 1);
}

function assertNoIncrement(): void {
  assert.deepEqual(isolationSeries(), []);
}

async function assertJson(res: Response, status: number, body: string): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(await res.text(), body);
}

function buildFinding(targetPropertyId: number, targetBrokerageId: number): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_RF11_HANDOFF_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `R-F11 finding ${fixtureCounter}`,
    problemDescription: "A test problem.",
    businessImpact: "Test impact.",
    detectedCause: "Test cause.",
    ownerType: "UNASSIGNED_QUEUE",
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
    dedupKey: `TEST_RF11_HANDOFF_RULE:${targetBrokerageId}:RF11_${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
  };
}

async function createException(targetBrokerageId: number, targetPropertyId: number): Promise<string> {
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

async function loadAssignment(sourceRecordId: string) {
  const [row] = await db
    .select()
    .from(pitCrewAssignments)
    .where(and(eq(pitCrewAssignments.sourceType, "EXCEPTION"), eq(pitCrewAssignments.sourceRecordId, sourceRecordId)))
    .limit(1);
  assert.ok(row, "assignment row should exist after claim");
  return row;
}

function rowJson(row: object): unknown {
  return JSON.parse(JSON.stringify(row));
}

async function auditRows(sourceRecordId: string) {
  return db
    .select({ id: auditLogs.id, action: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.recordType, "EXCEPTION"), eq(auditLogs.recordId, sourceRecordId)));
}

async function claim(sourceRecordId: string): Promise<{ version: number }> {
  const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/claim`, A.admin.cookie, {
    propertyId,
    expectedVersion: 0,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; version: number; assignedToUserId: number };
  assert.equal(body.status, "CLAIMED");
  assert.equal(body.assignedToUserId, A.admin.user.id);
  return { version: body.version };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `R-F11 Handoff A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F11 Handoff B ${suffix}`);

  const property = await postRaw("/properties", A.agent.cookie, {
    formattedAddress: `${suffix} Handoff St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(property.status, 201);
  propertyId = ((await property.json()) as { property: { id: number } }).property.id;

  const otherProperty = await postRaw("/properties", B.agent.cookie, {
    formattedAddress: `${suffix} Other Handoff St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(otherProperty.status, 201);
  otherPropertyId = ((await otherProperty.json()) as { property: { id: number } }).property.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F11 Pit Crew handoff recipient tenant check", { concurrency: 1 }, () => {
  test("a same-brokerage handoff is 200, returns the updated row, and does not increment", async () => {
    const sourceRecordId = await createException(A.brokerageId, propertyId);
    const claimed = await claim(sourceRecordId);
    const before = await loadAssignment(sourceRecordId);
    resetMetricsForTesting();

    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/handoff`, A.admin.cookie, {
      propertyId,
      expectedVersion: claimed.version,
      toUserId: A.agent.user.id,
      note: "Covering the settlement",
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as {
      status: string;
      assignedToUserId: number;
      handoffFromUserId: number;
      handoffToUserId: number;
      handoffNote: string;
      version: number;
      propertyId: number;
      sourceRecordId: string;
    };
    assert.equal(body.status, "CLAIMED");
    assert.equal(body.assignedToUserId, A.agent.user.id);
    assert.equal(body.handoffFromUserId, A.admin.user.id);
    assert.equal(body.handoffToUserId, A.agent.user.id);
    assert.equal(body.handoffNote, "Covering the settlement");
    assert.equal(body.version, before.version + 1);
    assert.equal(body.propertyId, propertyId);
    assert.equal(body.sourceRecordId, sourceRecordId);

    const updated = await loadAssignment(sourceRecordId);
    assert.deepEqual(body, rowJson(updated));
    assert.equal(updated.assignedToUserId, A.agent.user.id);
    assert.equal(updated.handoffToUserId, A.agent.user.id);
    assert.equal(updated.version, before.version + 1);

    const audits = await auditRows(sourceRecordId);
    assert.equal(audits.filter((row) => row.action === "PC_HANDOFF").length, 1);
    assertNoIncrement();
  });

  test("a recipient in another brokerage is 404, leaves the row and audit trail unchanged, and increments once", async () => {
    const sourceRecordId = await createException(A.brokerageId, propertyId);
    const claimed = await claim(sourceRecordId);
    const before = rowJson(await loadAssignment(sourceRecordId));
    const auditsBefore = await auditRows(sourceRecordId);
    assert.equal(auditsBefore.some((row) => row.action === "PC_HANDOFF"), false);
    resetMetricsForTesting();

    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/handoff`, A.admin.cookie, {
      propertyId,
      expectedVersion: claimed.version,
      toUserId: B.agent.user.id,
      note: "should not land",
    });
    await assertJson(res, 404, ASSIGNEE_NOT_FOUND);

    assert.deepEqual(rowJson(await loadAssignment(sourceRecordId)), before);
    assert.deepEqual(await auditRows(sourceRecordId), auditsBefore);
    assertIncrement("pit_crew");
  });

  test("a recipient that does not exist is 404, leaves the row and audit trail unchanged, and does not increment", async () => {
    const sourceRecordId = await createException(A.brokerageId, propertyId);
    const claimed = await claim(sourceRecordId);
    const before = rowJson(await loadAssignment(sourceRecordId));
    const auditsBefore = await auditRows(sourceRecordId);
    resetMetricsForTesting();

    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/handoff`, A.admin.cookie, {
      propertyId,
      expectedVersion: claimed.version,
      toUserId: MISSING_ID,
      note: "missing user",
    });
    await assertJson(res, 404, ASSIGNEE_NOT_FOUND);

    assert.deepEqual(rowJson(await loadAssignment(sourceRecordId)), before);
    assert.deepEqual(await auditRows(sourceRecordId), auditsBefore);
    assertNoIncrement();
  });

  test("a foreign propertyId with a valid same-brokerage recipient is still the property 404", async () => {
    const sourceRecordId = await createException(A.brokerageId, propertyId);
    const claimed = await claim(sourceRecordId);
    const before = rowJson(await loadAssignment(sourceRecordId));
    const auditsBefore = await auditRows(sourceRecordId);
    resetMetricsForTesting();

    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/handoff`, A.admin.cookie, {
      propertyId: otherPropertyId,
      expectedVersion: claimed.version,
      toUserId: A.agent.user.id,
      note: "foreign property",
    });
    await assertJson(res, 404, PROPERTY_NOT_FOUND);

    assert.deepEqual(rowJson(await loadAssignment(sourceRecordId)), before);
    assert.deepEqual(await auditRows(sourceRecordId), auditsBefore);
    assertIncrement("pit_crew");
  });

  test("a missing propertyId with a valid same-brokerage recipient is still the property 404 and does not increment", async () => {
    const sourceRecordId = await createException(A.brokerageId, propertyId);
    const claimed = await claim(sourceRecordId);
    const before = rowJson(await loadAssignment(sourceRecordId));
    const auditsBefore = await auditRows(sourceRecordId);
    resetMetricsForTesting();

    const res = await postRaw(`/pit-crew/items/EXCEPTION/${sourceRecordId}/handoff`, A.admin.cookie, {
      propertyId: MISSING_ID,
      expectedVersion: claimed.version,
      toUserId: A.agent.user.id,
      note: "missing property",
    });
    await assertJson(res, 404, PROPERTY_NOT_FOUND);

    assert.deepEqual(rowJson(await loadAssignment(sourceRecordId)), before);
    assert.deepEqual(await auditRows(sourceRecordId), auditsBefore);
    assertNoIncrement();
  });
});
