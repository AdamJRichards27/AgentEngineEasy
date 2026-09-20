// Agent Engine 2.0 — Exception & Risk Engine (Priority 4, Build
// Instructions §24).
//
// Route-level HTTP regression coverage for routes/exceptions.ts — the
// surface's own auth/tenancy/validation/financial-redaction wiring.
// Mirrors automationOps.test.ts's exact convention (real createApp()/
// app.listen(0) server, tenant-isolated brokerages via
// createBrokerageWithUsers, raw fetch() calls with session cookies,
// cleanup in after()). Deliberately does NOT re-derive the dedup/
// lifecycle/concurrency business logic already fully covered at the lib
// level in lib/exceptions/__tests__/model.test.ts and engine.test.ts —
// this file exists to catch a regression in the route wiring itself (a
// missing role check, a wrong status code, a tenant leak) even if every
// underlying model.ts/queries.ts function still behaves correctly in
// isolation.
//
// Fixtures are built two ways, deliberately: brokerages/users/properties
// through the real HTTP routes (so req.authedUser/session cookies are
// genuine and cleanupBrokerages() already knows how to tear them down);
// risk exceptions through model.ts's own createOrUpdateException directly
// (there is no HTTP route that creates one — only the engine does, and
// driving a real rule's detection end-to-end for route-wiring tests would
// be far more complex than necessary, exactly automationOps.test.ts's own
// stated reasoning for hand-inserting execution/action fixtures).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import { tryHoldExceptionScanLockForTests } from "../../lib/exceptions/engine.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `Exceptions Routes A ${suffix}`;
const brokerageBName = `Exceptions Routes B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyA: number;
let propertyB: number;

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
  propertyA = await createProperty(A.agent.cookie, "1 Exceptions Route Test St");
  propertyB = await createProperty(B.agent.cookie, "1 Exceptions Route Test St (B)");
});

after(async () => {
  const ids = [A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number");
  await cleanupBrokerages(ids);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

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

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

let fixtureCounter = 0;
async function makeException(overrides: Partial<RiskFinding> & { propertyId: number; brokerageId: number }) {
  fixtureCounter += 1;
  const { propertyId, brokerageId, ...rest } = overrides;
  const finding: RiskFinding = {
    ruleId: "TEST_ROUTE_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: "Route test finding",
    problemDescription: "A route test problem.",
    businessImpact: "Route test impact.",
    detectedCause: "Route test cause.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId,
    transactionId: null,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the route test thing.",
    resolutionRequirements: "The route test condition clears.",
    dismissible: true,
    sourceRecordType: "property",
    sourceRecordId: String(propertyId),
    dedupKey: `TEST_ROUTE_RULE:${brokerageId}:${propertyId}:${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...rest,
  };
  return createOrUpdateException(finding, brokerageId, propertyId, null, newCorrelationId(), null);
}

// ---------------------------------------------------------------------
// Auth / role surface.
// ---------------------------------------------------------------------

const SAMPLE_UUID = "11111111-1111-1111-1111-111111111111";

function fullSurface(): Array<{ method: string; path: string; body?: unknown }> {
  return [
    { method: "GET", path: `/api/properties/${propertyA}/exceptions` },
    { method: "GET", path: "/api/exceptions" },
    { method: "GET", path: `/api/exceptions/${SAMPLE_UUID}` },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/acknowledge` },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/start-remediation` },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/awaiting-external`, body: { note: "x" } },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/resolve`, body: { note: "x" } },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/dismiss`, body: { reason: "x" } },
    { method: "POST", path: `/api/exceptions/${SAMPLE_UUID}/reassign`, body: { ownerType: "UNASSIGNED_QUEUE", ownerUserId: null, reason: "x" } },
    { method: "GET", path: "/api/exceptions/ops/health" },
    { method: "POST", path: "/api/exceptions/ops/scan" },
  ];
}

test("unauthenticated requests are rejected across the entire exceptions surface", async () => {
  for (const req of fullSurface()) {
    const res = await fetch(`${baseUrl}${req.path}`, {
      method: req.method,
      headers: req.body ? { "content-type": "application/json" } : undefined,
      body: req.body ? JSON.stringify(req.body) : undefined,
    });
    assert.equal(res.status, 401, `${req.method} ${req.path} should be 401 when unauthenticated`);
  }
});

test("the ops surface (health, scan) is Brokerage Administrator only — 403 for an Agent, reachable for an Admin", async () => {
  for (const req of [
    { method: "GET", path: "/api/exceptions/ops/health" },
    { method: "POST", path: "/api/exceptions/ops/scan" },
  ]) {
    const res = await fetch(`${baseUrl}${req.path}`, { method: req.method, headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 403, `${req.method} ${req.path} should be 403 for an Agent`);
  }

  const healthRes = await fetch(`${baseUrl}/api/exceptions/ops/health`, { headers: { cookie: A.admin.cookie } });
  assert.equal(healthRes.status, 200);
  const healthBody = await json<{ recentRuns: unknown[] }>(healthRes);
  assert.ok(Array.isArray(healthBody.recentRuns));

  // Only the auth/role gate and the response shape are under test here —
  // the sweep itself is covered by lib/exceptions/__tests__ with
  // tenant-scoped scans. Letting this route run a REAL scan would sweep
  // every brokerage in the shared test database, including other files'
  // tenants mid-setup/cleanup (e.g. a property deleted mid-scan -> FK
  // violation -> 500). So hold the engine's single-flight lock ourselves:
  // the admin must get past auth and receive the engine's 409 "already
  // running" refusal, which is itself the production contract for an
  // overlapping manual trigger.
  let release: (() => Promise<void>) | null = null;
  for (let attempt = 0; attempt < 120 && !release; attempt++) {
    release = await tryHoldExceptionScanLockForTests();
    if (!release) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(release, "could not take the scan lock (another file's scan kept it held)");
  try {
    const scanRes = await fetch(`${baseUrl}/api/exceptions/ops/scan`, { method: "POST", headers: { cookie: A.admin.cookie } });
    assert.equal(scanRes.status, 409);
    const scanBody = await json<{ error: string }>(scanRes);
    assert.match(scanBody.error, /already running/);
  } finally {
    await release!();
  }
});

// ---------------------------------------------------------------------
// GET /properties/:propertyId/exceptions
// ---------------------------------------------------------------------

test("GET /properties/:propertyId/exceptions returns the property's exceptions for both Agent and Admin, and 404s a cross-tenant property", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });

  for (const cookie of [A.agent.cookie, A.admin.cookie]) {
    const res = await fetch(`${baseUrl}/api/properties/${propertyA}/exceptions`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await json<{ exceptions: Array<{ id: string }>; summary: { openCount: number } }>(res);
    assert.ok(body.exceptions.some((e) => e.id === created.exception.id));
    assert.ok(body.summary.openCount >= 1);
  }

  const crossTenantRes = await fetch(`${baseUrl}/api/properties/${propertyB}/exceptions`, { headers: { cookie: A.agent.cookie } });
  assert.equal(crossTenantRes.status, 404);
});

// ---------------------------------------------------------------------
// GET /exceptions — cross-property view, ownership restriction.
// ---------------------------------------------------------------------

test("GET /exceptions restricts a non-admin to their own properties' exceptions; a Brokerage Administrator sees the whole tenant", async () => {
  const secondAgent = await devLogin(baseUrl, {
    email: `agent2-exceptions-routes-${suffix}@example.com`,
    firstName: "Agent2",
    lastName: "User",
    brokerageName: brokerageAName,
  });
  const propertyAgent2 = await createProperty(secondAgent.cookie, "2 Exceptions Route Test St");

  const ownException = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });
  const otherAgentException = await makeException({ propertyId: propertyAgent2, brokerageId: A.brokerageId });

  const agent1Res = await fetch(`${baseUrl}/api/exceptions?limit=100`, { headers: { cookie: A.agent.cookie } });
  assert.equal(agent1Res.status, 200);
  const agent1Body = await json<{ exceptions: Array<{ id: string }> }>(agent1Res);
  const agent1Ids = agent1Body.exceptions.map((e) => e.id);
  assert.ok(agent1Ids.includes(ownException.exception.id), "must include this agent's own property's exception");
  assert.ok(!agent1Ids.includes(otherAgentException.exception.id), "must never include another agent's property's exception");

  const adminRes = await fetch(`${baseUrl}/api/exceptions?limit=100`, { headers: { cookie: A.admin.cookie } });
  assert.equal(adminRes.status, 200);
  const adminBody = await json<{ exceptions: Array<{ id: string }> }>(adminRes);
  const adminIds = adminBody.exceptions.map((e) => e.id);
  assert.ok(adminIds.includes(ownException.exception.id));
  assert.ok(adminIds.includes(otherAgentException.exception.id), "a Brokerage Administrator must see the whole tenant");
});

test("GET /exceptions rejects an invalid query", async () => {
  const res = await fetch(`${baseUrl}/api/exceptions?limit=not-a-number`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------
// GET /exceptions/:id
// ---------------------------------------------------------------------

test("GET /exceptions/:id returns the exception with its history for the owning tenant, and 404s identically for a cross-tenant id and a nonexistent one", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });

  const res = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(res.status, 200);
  const body = await json<{ exception: { id: string }; history: Array<{ transitionType: string }> }>(res);
  assert.equal(body.exception.id, created.exception.id);
  assert.ok(body.history.some((t) => t.transitionType === "OPENED"));

  const crossTenantRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}`, { headers: { cookie: B.agent.cookie } });
  const nonexistentRes = await fetch(`${baseUrl}/api/exceptions/${randomUUID()}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(crossTenantRes.status, 404);
  assert.equal(nonexistentRes.status, 404);
  const crossTenantBody = await json<{ error: string }>(crossTenantRes);
  const nonexistentBody = await json<{ error: string }>(nonexistentRes);
  assert.equal(crossTenantBody.error, nonexistentBody.error);
});

// ---------------------------------------------------------------------
// Financial redaction (Build Instructions §20/§21) at the route layer.
// ---------------------------------------------------------------------

test("an exception requiring financial entitlement is hidden entirely from a non-admin caller, and visible to a Brokerage Administrator", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId, requiresFinancialEntitlement: true });

  const agentDetailRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}`, { headers: { cookie: A.agent.cookie } });
  assert.equal(agentDetailRes.status, 404, "a financially-gated exception must be hidden, not merely relabelled, from a non-admin");

  const adminDetailRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}`, { headers: { cookie: A.admin.cookie } });
  assert.equal(adminDetailRes.status, 200);

  const agentListRes = await fetch(`${baseUrl}/api/properties/${propertyA}/exceptions`, { headers: { cookie: A.agent.cookie } });
  const agentListBody = await json<{ exceptions: Array<{ id: string }> }>(agentListRes);
  assert.ok(!agentListBody.exceptions.some((e) => e.id === created.exception.id));

  const adminListRes = await fetch(`${baseUrl}/api/properties/${propertyA}/exceptions`, { headers: { cookie: A.admin.cookie } });
  const adminListBody = await json<{ exceptions: Array<{ id: string }> }>(adminListRes);
  assert.ok(adminListBody.exceptions.some((e) => e.id === created.exception.id));
});

// ---------------------------------------------------------------------
// Lifecycle mutation routes.
// ---------------------------------------------------------------------

test("POST /exceptions/:id/acknowledge and /start-remediation advance status, validate cross-tenant access, and 404 identically for a nonexistent id", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });

  const ackRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/acknowledge`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(ackRes.status, 200);
  const ackBody = await json<{ exception: { status: string } }>(ackRes);
  assert.equal(ackBody.exception.status, "ACKNOWLEDGED");

  const remediationRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/start-remediation`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(remediationRes.status, 200);
  const remediationBody = await json<{ exception: { status: string } }>(remediationRes);
  assert.equal(remediationBody.exception.status, "IN_PROGRESS");

  const crossTenantRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/acknowledge`, { method: "POST", headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantRes.status, 404);

  const nonexistentRes = await fetch(`${baseUrl}/api/exceptions/${randomUUID()}/acknowledge`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(nonexistentRes.status, 404);
});

test("POST /exceptions/:id/awaiting-external validates its body and records the note", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });

  const badBodyRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/awaiting-external`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/awaiting-external`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ note: "Waiting on the vendor's solicitor." }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await json<{ exception: { status: string } }>(okRes);
  assert.equal(okBody.exception.status, "AWAITING_EXTERNAL");
});

test("POST /exceptions/:id/resolve validates its body, resolves a resolvable exception, and refuses a CRITICAL non-dismissible one", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId, severity: "ATTENTION", dismissible: false });

  const badBodyRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ note: "Confirmed fixed outside the app." }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await json<{ exception: { status: string } }>(okRes);
  assert.equal(okBody.exception.status, "RESOLVED");

  const critical = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId, severity: "CRITICAL", dismissible: false });
  const refusedRes = await fetch(`${baseUrl}/api/exceptions/${critical.exception.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ note: "trying to override" }),
  });
  assert.equal(refusedRes.status, 409);
  const refusedBody = await json<{ reason: string }>(refusedRes);
  assert.equal(refusedBody.reason, "REQUIRES_AUTHORITATIVE_EVIDENCE");
});

test("POST /exceptions/:id/dismiss validates its body and refuses a non-dismissible exception", async () => {
  const dismissible = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId, dismissible: true });
  const nonDismissible = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId, dismissible: false });

  const badBodyRes = await fetch(`${baseUrl}/api/exceptions/${dismissible.exception.id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(badBodyRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/exceptions/${dismissible.exception.id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reason: "Not applicable here." }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await json<{ exception: { status: string } }>(okRes);
  assert.equal(okBody.exception.status, "DISMISSED");

  const refusedRes = await fetch(`${baseUrl}/api/exceptions/${nonDismissible.exception.id}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ reason: "Not applicable here." }),
  });
  assert.equal(refusedRes.status, 409);
  const refusedBody = await json<{ reason: string }>(refusedRes);
  assert.equal(refusedBody.reason, "NOT_DISMISSIBLE");
});

test("POST /exceptions/:id/reassign validates its body, changes ownership, and never affects another tenant's exception", async () => {
  const created = await makeException({ propertyId: propertyA, brokerageId: A.brokerageId });

  const badBodyRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/reassign`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ ownerType: "NOT_A_REAL_TYPE", ownerUserId: null, reason: "x" }),
  });
  assert.equal(badBodyRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/reassign`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ ownerType: "BROKERAGE_ADMINISTRATOR", ownerUserId: A.admin.user.id, reason: "Escalating for review." }),
  });
  assert.equal(okRes.status, 200);
  const okBody = await json<{ exception: { ownerType: string; ownerUserId: number | null } }>(okRes);
  assert.equal(okBody.exception.ownerType, "BROKERAGE_ADMINISTRATOR");
  assert.equal(okBody.exception.ownerUserId, A.admin.user.id);

  const crossTenantRes = await fetch(`${baseUrl}/api/exceptions/${created.exception.id}/reassign`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: B.admin.cookie },
    body: JSON.stringify({ ownerType: "UNASSIGNED_QUEUE", ownerUserId: null, reason: "should not affect brokerage A's exception" }),
  });
  assert.equal(crossTenantRes.status, 404);
});
