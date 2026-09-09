import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users, privacyRequests } from "@aee/db";
import { cleanupBrokerages } from "./testSupport.js";

// Critical Blocker Remediation, Phase 8 — application privacy controls:
// GET /legal/versions, POST /privacy/requests, GET /privacy/requests/mine,
// GET /admin/privacy-requests, POST /admin/privacy-requests/:id/resolve.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const runId = Date.now();
const createdBrokerageIds = new Set<number>();

before(async () => {
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

// AE GROW Priority 2 -- CI Stabilisation Gate root cause: this teardown
// used to hand-roll its own delete order and never deleted
// entitlement_grants (inserted by POST /auth/dev-login for every new
// brokerage -- see routes/auth.ts). DELETE FROM brokerages therefore
// threw a foreign key violation (entitlement_grants_brokerage_id_brokerages_id_fk,
// Postgres code 23503) inside the for loop, which meant server.close()
// on the last line was never reached -- leaving the HTTP server open and
// hanging the test process indefinitely (node:test's after hook has no
// implicit try/finally). Delegating to the shared, FK-order-correct
// cleanupBrokerages() helper (extended by this fix to also delete
// privacy_requests) and closing the server in a finally fixes both the
// FK violation and the hang, regardless of whether cleanup throws.
after(async () => {
  try {
    await cleanupBrokerages([...createdBrokerageIds]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

function cookieFrom(res: Response): string {
  const c = res.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
  if (!c) throw new Error("expected a session cookie");
  return c;
}

let brokerageCounter = 0;
async function createAdmin(email: string): Promise<{ cookie: string; userId: number; brokerageId: number }> {
  const name = `Privacy Test Brokerage ${runId}-${brokerageCounter++}`;
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, firstName: "Admin", lastName: "User", brokerageName: name }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: { id: number; brokerageId: number } };
  createdBrokerageIds.add(body.user.brokerageId);
  return { cookie: cookieFrom(res), userId: body.user.id, brokerageId: body.user.brokerageId };
}

test("GET /legal/versions is public and returns non-empty version strings", async () => {
  const res = await fetch(`${baseUrl}/api/legal/versions`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { termsVersion: string; privacyVersion: string };
  assert.ok(body.termsVersion.length > 0);
  assert.ok(body.privacyVersion.length > 0);
});

test("a signed-in user can create a privacy request and see it in their own history", async () => {
  const admin = await createAdmin(`priv1-${runId}@example.com`);
  const createRes = await fetch(`${baseUrl}/api/privacy/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: admin.cookie },
    body: JSON.stringify({ type: "export" }),
  });
  assert.equal(createRes.status, 201);
  const listRes = await fetch(`${baseUrl}/api/privacy/requests/mine`, { headers: { cookie: admin.cookie } });
  const body = (await listRes.json()) as { requests: Array<{ type: string; status: string }> };
  assert.ok(body.requests.some((r) => r.type === "export" && r.status === "pending"));
});

test("an unauthenticated caller cannot create a privacy request", async () => {
  const res = await fetch(`${baseUrl}/api/privacy/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "deletion" }),
  });
  assert.equal(res.status, 401);
});

test("resolving a privacy request never deletes or exports data — it only records a human decision, and is tenant-scoped", async () => {
  const adminA = await createAdmin(`priv2a-${runId}@example.com`);
  const adminB = await createAdmin(`priv2b-${runId}@example.com`);
  const createRes = await fetch(`${baseUrl}/api/privacy/requests`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminA.cookie },
    body: JSON.stringify({ type: "deletion" }),
  });
  const { request } = (await createRes.json()) as { request: { id: number } };

  // Admin queue view — joined against users so the admin can see WHO is
  // asking without a second lookup (this list previously carried only a
  // bare userId).
  const listRes = await fetch(`${baseUrl}/api/admin/privacy-requests`, { headers: { cookie: adminA.cookie } });
  const listBody = (await listRes.json()) as { requests: Array<{ id: number; userEmail: string }> };
  const listedRow = listBody.requests.find((r) => r.id === request.id);
  assert.ok(listedRow, "the newly created request must appear in admin A's queue");
  assert.equal(listedRow!.userEmail, `priv2a-${runId}@example.com`);

  // Cross-tenant: admin B must not be able to resolve admin A's request.
  const crossTenantRes = await fetch(`${baseUrl}/api/admin/privacy-requests/${request.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminB.cookie },
    body: JSON.stringify({ status: "completed" }),
  });
  assert.equal(crossTenantRes.status, 404);

  const resolveRes = await fetch(`${baseUrl}/api/admin/privacy-requests/${request.id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminA.cookie },
    body: JSON.stringify({ status: "completed", notes: "Exported manually and emailed to the requester." }),
  });
  assert.equal(resolveRes.status, 200);
  const [dbRow] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, request.id));
  assert.equal(dbRow.status, "completed");
  assert.ok(dbRow.handledAt);
  assert.equal(dbRow.handledByUserId, adminA.userId);
  // The user account itself must still exist — "deletion" here is a
  // reviewed request, never an automatic delete.
  const [stillExists] = await db.select().from(users).where(eq(users.id, adminA.userId));
  assert.ok(stillExists, "resolving a deletion request must never itself delete the account");
});
