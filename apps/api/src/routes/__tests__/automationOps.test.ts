// Agent Engine 2.0 -- WAE Operational Readiness (Stage: WF4).
//
// Route-level HTTP regression coverage for
// apps/api/src/routes/automationOps.ts -- the ops API surface's own
// auth/tenancy/validation/routing correctness. Mirrors ai-actions.test.ts's
// exact convention (real createApp()/app.listen(0) server, two
// tenant-isolated brokerages via createBrokerageWithUsers, raw fetch()
// calls with session cookies, cleanup in after()) -- deliberately does NOT
// re-derive the retry/cancel/classification business logic already fully
// covered at the lib level in engine.test.ts and stage2Engine.test.ts;
// this file exists to catch a regression in the route wiring itself
// (wrong status code, a missing tenant-scope check, a role check only
// enforced in the UI) even if every underlying operations.ts/engine.ts
// function still behaves correctly in isolation.
//
// Fixtures are built two ways, deliberately:
//   - brokerages/users/properties: through the real HTTP routes
//     (createBrokerageWithUsers's dev-login flow, POST /api/properties) --
//     so req.authedUser/session cookies are genuine and cleanupBrokerages()
//     (testSupport.ts) already knows how to tear them down.
//   - rules/rule versions: through the real rules.ts service functions
//     (createAutomationRule/createRuleVersion/approveAndActivateRuleVersion)
//     -- there is still no rule-authoring HTTP route (Foundation-stage
//     scope), so this is the only way to get a real rule to pause/resume
//     or an execution/action to attach to.
//   - executions/actions: inserted directly into automationExecutions/
//     automationActions with a caller-controlled status, mirroring
//     engine.test.ts's own insertMinimalExecutionAndAction technique --
//     driving fixtures through the full engine pipeline via HTTP would be
//     far more complex than necessary for testing route wiring. This file
//     never registers the automation engine's event handler (no
//     registerAutomationEngine() call), so publishing a triggering event
//     below never races with these hand-built fixtures.
//
// automationRules/automationRuleVersions/automationExecutions/
// automationActions are NOT covered by testSupport.ts's cleanupBrokerages()
// (it predates WAE) -- cleanupAutomationRows() below deletes them first, in
// FK order, before cleanupBrokerages() runs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, automationRules, automationRuleVersions, automationExecutions, automationActions } from "@aee/db";
import { publishDomainEvent, newCorrelationId, type DomainEvent } from "@aee/events";
import { createAutomationRule, createRuleVersion, approveAndActivateRuleVersion } from "../../lib/automation/rules.js";
import type { AutomationConditionGroup } from "../../lib/automation/conditions.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const VALID_CONDITIONS: AutomationConditionGroup = { operator: "ALL", conditions: [{ field: "propertyId", operator: "exists" }] };

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `WF4 Ops A ${suffix}`;
const brokerageBName = `WF4 Ops B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyA: number;
let ruleA: Awaited<ReturnType<typeof setUpActiveRule>>;
let ruleB: Awaited<ReturnType<typeof setUpActiveRule>>;

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

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
  propertyA = await createProperty(A.agent.cookie, "1 Ops Route Test St");
  ruleA = await setUpActiveRule({ brokerageId: A.brokerageId, adminId: A.admin.user.id });
  ruleB = await setUpActiveRule({ brokerageId: B.brokerageId, adminId: B.admin.user.id });
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupAutomationRows(ids);
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------

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

async function setUpActiveRule(input: { brokerageId: number; adminId: number }) {
  const rule = await createAutomationRule({
    brokerageId: input.brokerageId,
    name: "Ops route test rule",
    triggerEventType: "AGENCY_AGREEMENT_SIGNED",
    createdByUserId: input.adminId,
  });
  const version = await createRuleVersion({
    ruleId: rule.id,
    brokerageId: input.brokerageId,
    conditionGroup: VALID_CONDITIONS,
    actions: [{ actionKey: "PROPERTY_NOTE_ADD", params: { propertyId: "$event.propertyId", note: "ops route test note" } }],
    createdByUserId: input.adminId,
  });
  const activated = await approveAndActivateRuleVersion({ versionId: version.id, brokerageId: input.brokerageId, approvedByUserId: input.adminId });
  return { rule, version: activated };
}

async function publishTriggeringEvent(input: { brokerageId: number; propertyId: number; agentId: number }): Promise<DomainEvent> {
  return publishDomainEvent({
    eventType: "AGENCY_AGREEMENT_SIGNED",
    occurredAt: new Date(),
    propertyId: input.propertyId,
    transactionId: null,
    partyId: null,
    brokerageId: input.brokerageId,
    agentId: input.agentId,
    actorType: "USER",
    actorId: input.agentId,
    source: "test:automationOps",
    correlationId: newCorrelationId(),
    causationId: null,
    idempotencyKey: `test-automation-ops:${randomUUID()}`,
    payload: { propertyId: input.propertyId },
    metadata: {},
  });
}

async function insertExecutionAndAction(input: {
  brokerageId: number;
  ruleId: number;
  ruleVersionId: number;
  triggeringEventId: string;
  correlationId: string;
  executionStatus: string;
  actionStatus: string;
  attemptCount?: number;
  maxAttempts?: number;
  errorMessage?: string | null;
}) {
  const [execution] = await db
    .insert(automationExecutions)
    .values({
      brokerageId: input.brokerageId,
      ruleId: input.ruleId,
      ruleVersionId: input.ruleVersionId,
      triggeringEventId: input.triggeringEventId,
      correlationId: input.correlationId,
      status: input.executionStatus,
      startedAt: new Date(),
    })
    .returning();
  const [action] = await db
    .insert(automationActions)
    .values({
      executionId: execution.id,
      sequence: 1,
      actionKey: "PROPERTY_NOTE_ADD",
      params: { note: "fixture" },
      status: input.actionStatus,
      errorMessage: input.errorMessage ?? null,
      attemptCount: input.attemptCount ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      startedAt: new Date(),
    })
    .returning();
  return { execution, action };
}

async function cleanupAutomationRows(brokerageIds: number[]): Promise<void> {
  if (brokerageIds.length === 0) return;
  const executionRows = await db
    .select({ id: automationExecutions.id })
    .from(automationExecutions)
    .where(inArray(automationExecutions.brokerageId, brokerageIds));
  const executionIds = executionRows.map((r) => r.id);
  if (executionIds.length > 0) {
    await db.delete(automationActions).where(inArray(automationActions.executionId, executionIds));
  }
  await db.delete(automationExecutions).where(inArray(automationExecutions.brokerageId, brokerageIds));

  const ruleRows = await db.select({ id: automationRules.id }).from(automationRules).where(inArray(automationRules.brokerageId, brokerageIds));
  const ruleIds = ruleRows.map((r) => r.id);
  if (ruleIds.length > 0) {
    await db.delete(automationRuleVersions).where(inArray(automationRuleVersions.ruleId, ruleIds));
  }
  await db.delete(automationRules).where(inArray(automationRules.brokerageId, brokerageIds));
}

async function freshExecutionA(
  executionStatus: string,
  actionStatus: string,
  extra?: { attemptCount?: number; maxAttempts?: number; errorMessage?: string | null },
) {
  const event = await publishTriggeringEvent({ brokerageId: A.brokerageId, propertyId: propertyA, agentId: A.agent.user.id });
  return insertExecutionAndAction({
    brokerageId: A.brokerageId,
    ruleId: ruleA.rule.id,
    ruleVersionId: ruleA.version.id,
    triggeringEventId: event.id,
    correlationId: event.correlationId,
    executionStatus,
    actionStatus,
    ...extra,
  });
}

// ---------------------------------------------------------------------
// Auth / role surface.
// ---------------------------------------------------------------------

const SAMPLE_UUID = "11111111-1111-1111-1111-111111111111";

function surfaceRequests(): Array<{ method: string; path: string; body?: unknown }> {
  return [
    { method: "GET", path: "/api/automation/ops/health" },
    { method: "GET", path: "/api/automation/ops/executions" },
    { method: "GET", path: `/api/automation/ops/executions/${SAMPLE_UUID}` },
    { method: "POST", path: `/api/automation/ops/actions/${SAMPLE_UUID}/retry` },
    { method: "POST", path: `/api/automation/ops/executions/${SAMPLE_UUID}/cancel`, body: { reason: "x" } },
    { method: "POST", path: `/api/automation/ops/actions/${SAMPLE_UUID}/cancel`, body: { reason: "x" } },
    { method: "POST", path: `/api/automation/ops/executions/${SAMPLE_UUID}/notes`, body: { note: "x" } },
    { method: "POST", path: "/api/automation/ops/rules/1/pause", body: { reason: "x" } },
    { method: "POST", path: "/api/automation/ops/rules/1/resume", body: { reason: "x" } },
  ];
}

test("unauthenticated requests are rejected across the entire automation ops surface", async () => {
  for (const req of surfaceRequests()) {
    const res = await fetch(`${baseUrl}${req.path}`, {
      method: req.method,
      headers: req.body ? { "content-type": "application/json" } : undefined,
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    assert.equal(res.status, 401, `${req.method} ${req.path} should be 401 when unauthenticated`);
  }
});

test("a non-admin (Agent) role is forbidden across the entire automation ops surface", async () => {
  for (const req of surfaceRequests()) {
    const res = await fetch(`${baseUrl}${req.path}`, {
      method: req.method,
      headers: { cookie: A.agent.cookie, ...(req.body ? { "content-type": "application/json" } : {}) },
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    assert.equal(res.status, 403, `${req.method} ${req.path} should be 403 for an Agent`);
  }
});

// ---------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------

test("GET /health returns a structured report for a Brokerage Administrator", async () => {
  const res = await fetch(`${baseUrl}/api/automation/ops/health`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { healthy: boolean; degraded: boolean; checks: Record<string, number | boolean> };
  assert.equal(typeof body.healthy, "boolean");
  assert.equal(typeof body.degraded, "boolean");
  assert.equal(typeof body.checks.staleRunningActions, "number");
  assert.equal(typeof body.checks.retryBacklog, "number");
});

// ---------------------------------------------------------------------
// GET /executions (list) -- tenant isolation.
// ---------------------------------------------------------------------

test("GET /executions only ever returns the caller's own brokerage's executions", async () => {
  const { execution: execA } = await freshExecutionA("AWAITING_APPROVAL", "AWAITING_APPROVAL");
  const propertyB = await createProperty(B.agent.cookie, "1 Ops Route Test St (B)");
  const eventB = await publishTriggeringEvent({ brokerageId: B.brokerageId, propertyId: propertyB, agentId: B.agent.user.id });
  const { execution: execB } = await insertExecutionAndAction({
    brokerageId: B.brokerageId,
    ruleId: ruleB.rule.id,
    ruleVersionId: ruleB.version.id,
    triggeringEventId: eventB.id,
    correlationId: eventB.correlationId,
    executionStatus: "AWAITING_APPROVAL",
    actionStatus: "AWAITING_APPROVAL",
  });

  const res = await fetch(`${baseUrl}/api/automation/ops/executions?limit=50`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { executions: Array<{ id: string }> };
  const ids = body.executions.map((e) => e.id);
  assert.ok(ids.includes(execA.id), "must include this brokerage's own execution");
  assert.ok(!ids.includes(execB.id), "must never include another brokerage's execution");
});

test("GET /executions rejects an invalid query", async () => {
  const res = await fetch(`${baseUrl}/api/automation/ops/executions?limit=not-a-number`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------
// GET /executions/:id (detail)
// ---------------------------------------------------------------------

test("GET /executions/:id returns the execution with its actions; cross-tenant is 404; a malformed id is 400", async () => {
  const { execution, action } = await freshExecutionA("PARTIALLY_COMPLETED", "AWAITING_APPROVAL");

  const res = await fetch(`${baseUrl}/api/automation/ops/executions/${execution.id}`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { execution: { id: string }; actions: Array<{ id: string }>; triggeringEvent: { id: string } | null };
  assert.equal(body.execution.id, execution.id);
  assert.equal(body.actions.length, 1);
  assert.equal(body.actions[0].id, action.id);
  assert.ok(body.triggeringEvent);

  const crossTenantRes = await fetch(`${baseUrl}/api/automation/ops/executions/${execution.id}`, { headers: { cookie: B.admin.cookie } });
  assert.equal(crossTenantRes.status, 404);

  const badIdRes = await fetch(`${baseUrl}/api/automation/ops/executions/not-a-uuid`, { headers: { cookie: A.admin.cookie } });
  assert.equal(badIdRes.status, 400);
});

// ---------------------------------------------------------------------
// POST /actions/:id/retry
// ---------------------------------------------------------------------

test("POST /actions/:id/retry is 404 for an action that does not exist, and 400 for a malformed id", async () => {
  const res = await fetch(`${baseUrl}/api/automation/ops/actions/${randomUUID()}/retry`, { method: "POST", headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { reason: string };
  assert.equal(body.reason, "NOT_FOUND");

  const badIdRes = await fetch(`${baseUrl}/api/automation/ops/actions/not-a-uuid/retry`, { method: "POST", headers: { cookie: A.admin.cookie } });
  assert.equal(badIdRes.status, 400);
});

// ---------------------------------------------------------------------
// POST /executions/:id/cancel, /actions/:id/cancel
// ---------------------------------------------------------------------

test("POST /executions/:id/cancel cancels a cancellable execution, refuses one that is not, and validates its input", async () => {
  const { execution: cancellable } = await freshExecutionA("AWAITING_APPROVAL", "AWAITING_APPROVAL");
  const okRes = await fetch(`${baseUrl}/api/automation/ops/executions/${cancellable.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "operator cancelled during test" }),
  });
  assert.equal(okRes.status, 200);
  const okBody = (await okRes.json()) as { execution: { status: string } };
  assert.equal(okBody.execution.status, "CANCELLED");

  const { execution: notCancellable } = await freshExecutionA("COMPLETED", "SUCCEEDED");
  const conflictRes = await fetch(`${baseUrl}/api/automation/ops/executions/${notCancellable.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "should be refused" }),
  });
  assert.equal(conflictRes.status, 409);

  const badBodyRes = await fetch(`${baseUrl}/api/automation/ops/executions/${notCancellable.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const notFoundRes = await fetch(`${baseUrl}/api/automation/ops/executions/${randomUUID()}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "x" }),
  });
  assert.equal(notFoundRes.status, 404);
});

test("POST /actions/:id/cancel cancels a cancellable action and never leaks another brokerage's action", async () => {
  const { action: cancellable } = await freshExecutionA("PARTIALLY_COMPLETED", "PENDING");
  const okRes = await fetch(`${baseUrl}/api/automation/ops/actions/${cancellable.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "operator cancelled during test" }),
  });
  assert.equal(okRes.status, 200);
  const okBody = (await okRes.json()) as { action: { status: string } };
  assert.equal(okBody.action.status, "CANCELLED");

  const { action: brokerageAAction } = await freshExecutionA("PARTIALLY_COMPLETED", "PENDING");
  const crossTenantRes = await fetch(`${baseUrl}/api/automation/ops/actions/${brokerageAAction.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ reason: "should not be visible to brokerage B" }),
  });
  assert.equal(crossTenantRes.status, 404);
});

// ---------------------------------------------------------------------
// POST /executions/:id/notes
// ---------------------------------------------------------------------

test("POST /executions/:id/notes records a note regardless of status, validates its body, and is tenant-scoped", async () => {
  const { execution } = await freshExecutionA("COMPLETED", "SUCCEEDED");
  const okRes = await fetch(`${baseUrl}/api/automation/ops/executions/${execution.id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ note: "Investigated, no action needed." }),
  });
  assert.equal(okRes.status, 200);
  const okBody = (await okRes.json()) as { execution: { resolutionNote: string | null } };
  assert.equal(okBody.execution.resolutionNote, "Investigated, no action needed.");

  const badBodyRes = await fetch(`${baseUrl}/api/automation/ops/executions/${execution.id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const crossTenantRes = await fetch(`${baseUrl}/api/automation/ops/executions/${execution.id}/notes`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ note: "should not be reachable from brokerage B" }),
  });
  assert.equal(crossTenantRes.status, 404);
});

// ---------------------------------------------------------------------
// POST /rules/:id/pause, /rules/:id/resume
// ---------------------------------------------------------------------

test("POST /rules/:id/pause and /rules/:id/resume toggle the rule's status, validate input, and never touch another brokerage's rule", async () => {
  const pauseRes = await fetch(`${baseUrl}/api/automation/ops/rules/${ruleA.rule.id}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "investigating a bad output" }),
  });
  assert.equal(pauseRes.status, 200);
  const pauseBody = (await pauseRes.json()) as { rule: { status: string } };
  assert.equal(pauseBody.rule.status, "PAUSED");

  const resumeRes = await fetch(`${baseUrl}/api/automation/ops/rules/${ruleA.rule.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "issue resolved" }),
  });
  assert.equal(resumeRes.status, 200);
  const resumeBody = (await resumeRes.json()) as { rule: { status: string } };
  assert.equal(resumeBody.rule.status, "ACTIVE");

  const badIdRes = await fetch(`${baseUrl}/api/automation/ops/rules/not-a-number/pause`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "x" }),
  });
  assert.equal(badIdRes.status, 400);

  const badBodyRes = await fetch(`${baseUrl}/api/automation/ops/rules/${ruleA.rule.id}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const crossTenantRes = await fetch(`${baseUrl}/api/automation/ops/rules/${ruleB.rule.id}/pause`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "should not affect brokerage B's rule" }),
  });
  assert.equal(crossTenantRes.status, 404);
});
