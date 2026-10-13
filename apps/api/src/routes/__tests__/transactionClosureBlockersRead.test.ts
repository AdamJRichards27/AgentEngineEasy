// Read-only R-F42 closure blockers on the transaction GETs. The list is the
// same one POST /transactions/:id/close returns as 409 blockers once the
// transaction is Settled. The Settled check, the force override, and the
// Brokerage Administrator gate on close are unchanged. No migration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, transactions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createTransactionFromListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let transactionId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getJson(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postJson(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function bodyOf<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got ${res.status}: ${text}`);
  }
}

interface ClosureRead {
  transaction: { id: number; status: string; closedAt: string | null; closureBlockers?: unknown } | null;
  closureBlockers: string[] | null;
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function readBoth(cookie: string): Promise<{ byId: ClosureRead; byProperty: ClosureRead }> {
  const byIdRes = await getJson(`/transactions/${transactionId}`, cookie);
  assert.equal(byIdRes.status, 200, "GET /transactions/:id");
  const byPropertyRes = await getJson(`/transactions/by-property/${propertyId}`, cookie);
  assert.equal(byPropertyRes.status, 200, "GET /transactions/by-property/:propertyId");
  return { byId: await bodyOf<ClosureRead>(byIdRes), byProperty: await bodyOf<ClosureRead>(byPropertyRes) };
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

  A = await createBrokerageWithUsers(baseUrl, `Closure blockers A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Closure blockers B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Closure Blockers St`,
    sellerEmail: `seller-closure-blockers-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("GET returns the same closure blockers close would report, without closing", async () => {
  const beforeClose = await readBoth(A.agent.cookie);
  assert.deepEqual(beforeClose.byId.closureBlockers, beforeClose.byProperty.closureBlockers);
  const blockers = beforeClose.byId.closureBlockers;
  assert.ok(blockers);
  assert.ok(blockers.includes("The transaction has not become unconditional yet."));
  assert.ok(blockers.includes("Commission has not been calculated."));
  assert.ok(blockers.some((line) => line === "Funds reconciliation is COMMISSION_NOT_CALCULATED, not MATCHED."));
  assert.equal(beforeClose.byId.transaction?.closureBlockers, undefined);
  assert.notEqual(beforeClose.byId.transaction?.status, "Closed");
  assert.equal(beforeClose.byId.transaction?.closedAt, null);

  const tooEarly = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  assert.equal(tooEarly.status, 400);
  const tooEarlyBody = await bodyOf<{ error?: string; blockers?: unknown }>(tooEarly);
  assert.match(tooEarlyBody.error ?? "", /cannot be closed before settlement is completed/);
  assert.equal(tooEarlyBody.blockers, undefined);

  await db.update(transactions).set({ status: "Settled" }).where(eq(transactions.id, transactionId));

  const settled = await readBoth(A.agent.cookie);
  assert.equal(settled.byId.transaction?.status, "Settled");
  assert.deepEqual(settled.byId.closureBlockers, blockers);
  assert.deepEqual(settled.byProperty.closureBlockers, blockers);

  const blocked = await postJson(`/transactions/${transactionId}/close`, A.admin.cookie);
  assert.equal(blocked.status, 409);
  const blockedBody = await bodyOf<{ error?: string; blockers?: string[] }>(blocked);
  assert.match(blockedBody.error ?? "", /^Transaction cannot be closed:/);
  assert.deepEqual(blockedBody.blockers, blockers);

  const afterRefusal = await readBoth(A.agent.cookie);
  assert.equal(afterRefusal.byId.transaction?.status, "Settled");
  assert.equal(afterRefusal.byId.transaction?.closedAt, null);
  assert.deepEqual(afterRefusal.byId.closureBlockers, blockers);
});

test("another brokerage is 404 and does not receive the blocker list", async () => {
  const byId = await getJson(`/transactions/${transactionId}`, B.agent.cookie);
  assert.equal(byId.status, 404);
  assert.deepEqual(await bodyOf(byId), { error: "Not found" });

  const byProperty = await getJson(`/transactions/by-property/${propertyId}`, B.agent.cookie);
  assert.equal(byProperty.status, 404);
  assert.deepEqual(await bodyOf(byProperty), { error: "Not found" });
});

test("missing run.access is 403 and does not return closure blockers", async () => {
  await setRunAccess(A.brokerageId, false);
  try {
    for (const path of [`/transactions/${transactionId}`, `/transactions/by-property/${propertyId}`]) {
      const res = await getJson(path, A.agent.cookie);
      assert.equal(res.status, 403, path);
      const body = await bodyOf<{ error?: string; entitlementKey?: string; closureBlockers?: unknown; transaction?: unknown }>(res);
      assert.equal(body.error, "Not entitled");
      assert.equal(body.entitlementKey, "run.access");
      assert.equal(body.closureBlockers, undefined);
      assert.equal(body.transaction, undefined);
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});
