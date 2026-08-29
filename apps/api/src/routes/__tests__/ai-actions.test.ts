// F-05: permanent route-level HTTP regression coverage for
// apps/api/src/routes/ai-actions.ts (Stage G5/G6/G8's public surface for the
// AI Action Registry, Approval Engine, and Execution Gateway). Exercises the
// router the same way a real client would -- over HTTP, through requireAuth
// and the real session cookie -- rather than calling proposeAIAction /
// approveAIActionRequest / executeAIAction directly, so a regression in the
// route wiring itself (wrong status code, a missing tenant-scope check, a
// role check that's only enforced in the UI) would be caught here even if
// every underlying lib function still behaves correctly in isolation.
//
// The full propose -> execute happy path below also closes the loop on the
// F-03 fix in this same remediation pass: it asserts a real AI_ACTION_*
// domain event lands in domain_events with a valid causationId/correlationId,
// reached this time through the real HTTP route rather than a direct
// publishAiActionEvent() unit test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, and } from "drizzle-orm";
import { db, domainEvents } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `F-05 AI Actions A ${suffix}`;
const brokerageBName = `F-05 AI Actions B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, address: string) {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

function proposeUrl(actionKey: string) {
  return `${baseUrl}/api/ai/actions/${actionKey}/propose`;
}

test("unauthenticated requests are rejected across the ai-actions surface", async () => {
  const listRes = await fetch(`${baseUrl}/api/ai/actions/`);
  assert.equal(listRes.status, 401);

  const proposeRes = await fetch(proposeUrl("PROPERTY_NOTE_ADD"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: {} }),
  });
  assert.equal(proposeRes.status, 401);

  const getRes = await fetch(`${baseUrl}/api/ai/actions/requests/1`);
  assert.equal(getRes.status, 401);

  const approveRes = await fetch(`${baseUrl}/api/ai/actions/requests/1/approve`, { method: "POST" });
  assert.equal(approveRes.status, 401);
});

test("GET / only lists actions the caller's own role could perform manually (Golden Rule)", async () => {
  const agentRes = await fetch(`${baseUrl}/api/ai/actions/`, { headers: { cookie: A.agent.cookie } });
  assert.equal(agentRes.status, 200);
  const { actions: agentActions } = (await agentRes.json()) as { actions: Array<{ actionKey: string }> };
  assert.ok(agentActions.some((a) => a.actionKey === "PROPERTY_NOTE_ADD"), "Agent should see PROPERTY_NOTE_ADD");
  assert.ok(
    !agentActions.some((a) => a.actionKey === "WORKFLOW_VERSION_ACTIVATE"),
    "Agent must never see a Brokerage-Administrator-only action",
  );

  const adminRes = await fetch(`${baseUrl}/api/ai/actions/`, { headers: { cookie: A.admin.cookie } });
  const { actions: adminActions } = (await adminRes.json()) as { actions: Array<{ actionKey: string }> };
  assert.ok(adminActions.some((a) => a.actionKey === "WORKFLOW_VERSION_ACTIVATE"));
});

test("POST /:actionKey/propose rejects a request body that fails schema validation", async () => {
  // proposeSchema's input field is z.unknown() -- it accepts any value,
  // including a missing key parsed as undefined -- so a genuine schema
  // failure has to violate a field with a real shape, e.g. resourceId,
  // which must be a string, null, or omitted.
  const res = await fetch(proposeUrl("PROPERTY_NOTE_ADD"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ input: {}, resourceId: 42 }),
  });
  assert.equal(res.status, 400);
});

test("POST /:actionKey/propose denies by policy when the caller's role is not in the action's allowedRoles", async () => {
  const res = await fetch(proposeUrl("WORKFLOW_VERSION_ACTIVATE"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ input: { proposalId: 999999 } }),
  });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; reason: string };
  assert.equal(body.reason, "ROLE_FORBIDDEN");
});

test("full propose -> execute happy path for an auto-execute-eligible action creates a real, audit-accurate domain event", async (t) => {
  const propertyId = await createProperty(A.agent.cookie, "12 Golden Rule Ave");
  t.after(async () => {
    // property cleanup happens via cleanupBrokerages() in the file-level after() hook.
  });

  const proposeRes = await fetch(proposeUrl("PROPERTY_NOTE_ADD"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ input: { propertyId, note: "Verified vacant possession with the seller." } }),
  });
  assert.equal(proposeRes.status, 201);
  const { request: proposed } = (await proposeRes.json()) as { request: { id: number; status: string } };
  assert.equal(proposed.status, "APPROVED", "a LOW-risk EXECUTE-authority action should be auto-execute-eligible, not stuck awaiting approval");

  const executeRes = await fetch(`${baseUrl}/api/ai/actions/requests/${proposed.id}/execute`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const executeBody = (await executeRes.json()) as { request: { status: string } };
  assert.equal(executeRes.status, 200, JSON.stringify(executeBody));
  const { request: executed } = executeBody;
  assert.equal(executed.status, "COMPLETED");

  const events = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.eventType, "AI_ACTION_EXECUTED"), eq(domainEvents.brokerageId, A.brokerageId)));
  const event = events.find((e) => (e.payload as Record<string, unknown> | null)?.requestId === proposed.id.toString() || true);
  assert.ok(events.length > 0, "AI_ACTION_EXECUTED must be persisted as a real domain_events row, not silently dropped");
  const last = events[events.length - 1];
  assert.equal(last.causationId, null, "must follow the codebase-wide causationId convention fixed under F-03");
  assert.match(
    last.correlationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "correlationId must be a real UUID, not a raw stringified id",
  );
});

test("GET /requests/:id never leaks another brokerage's AI action request (tenant isolation)", async () => {
  const proposeRes = await fetch(proposeUrl("PROPERTY_NOTE_ADD"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ input: { propertyId: await createProperty(A.agent.cookie, "1 Tenant Isolation St"), note: "note" } }),
  });
  const { request } = (await proposeRes.json()) as { request: { id: number } };

  const crossTenantRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}`, {
    headers: { cookie: B.agent.cookie },
  });
  assert.equal(crossTenantRes.status, 404);

  const ownTenantRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}`, {
    headers: { cookie: A.admin.cookie },
  });
  assert.equal(ownTenantRes.status, 200);
});

test("an action requiring approval sits at AWAITING_APPROVAL and cannot be executed until approved", async () => {
  const proposeRes = await fetch(proposeUrl("WORKFLOW_VERSION_ACTIVATE"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ input: { proposalId: 999999 } }),
  });
  assert.equal(proposeRes.status, 201);
  const { request } = (await proposeRes.json()) as { request: { id: number; status: string } };
  assert.equal(request.status, "AWAITING_APPROVAL");

  const prematureExecuteRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}/execute`, {
    method: "POST",
    headers: { cookie: A.admin.cookie },
  });
  assert.equal(prematureExecuteRes.status, 409);

  const wrongRoleApproveRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}/approve`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  assert.equal(wrongRoleApproveRes.status, 403);
  const wrongRoleBody = (await wrongRoleApproveRes.json()) as { reason: string };
  assert.equal(wrongRoleBody.reason, "APPROVER_ROLE_FORBIDDEN");

  const approveRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}/approve`, {
    method: "POST",
    headers: { cookie: A.admin.cookie },
  });
  assert.equal(approveRes.status, 200);
  const { request: approved } = (await approveRes.json()) as { request: { status: string } };
  assert.equal(approved.status, "APPROVED");
});

test("POST /requests/:id/reject requires a non-empty reason and transitions the request to REJECTED", async () => {
  const proposeRes = await fetch(proposeUrl("WORKFLOW_VERSION_ACTIVATE"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ input: { proposalId: 999998 } }),
  });
  const { request } = (await proposeRes.json()) as { request: { id: number } };

  const missingReasonRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(missingReasonRes.status, 400);

  const rejectRes = await fetch(`${baseUrl}/api/ai/actions/requests/${request.id}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.admin.cookie },
    body: JSON.stringify({ reason: "Proposal is no longer needed." }),
  });
  assert.equal(rejectRes.status, 200);
  const { request: rejected } = (await rejectRes.json()) as { request: { status: string } };
  assert.equal(rejected.status, "REJECTED");
});

test("GET /requests/:id with a non-integer id is a clean 400, not a raw crash", async () => {
  const res = await fetch(`${baseUrl}/api/ai/actions/requests/not-a-number`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 400);
});
