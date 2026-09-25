// R-F2 — Run entitlement consistency. Transaction routes (and the authenticated
// offer routes that create and mutate them) require run.access in addition to
// the existing auth / tenant / role gates. Dev-login auto-grants run.access, so
// this file revokes that grant and proves the 403, then restores it and proves
// the same calls succeed. The public offer share-token route stays open.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import {
  createBrokerageWithUsers,
  createTransactionFromListedProperty,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AML_WEBHOOK_SECRET = "aml-webhook-test-secret";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let offerId: number;
let shareToken: string;
let transactionId: number;
let conditionId: number;

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

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function assertNotEntitled(res: Response, label: string): Promise<void> {
  assert.equal(res.status, 403, label);
  const body = (await res.json()) as { error?: string; entitlementKey?: string };
  assert.equal(body.error, "Not entitled", label);
  assert.equal(body.entitlementKey, "run.access", label);
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

  A = await createBrokerageWithUsers(baseUrl, `Run Access Txn A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Run Access Txn B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Run Access St`,
    sellerEmail: `seller-run-access-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  offerId = created.offerId;
  transactionId = created.transactionId;

  const offerRes = await getJson(`/offers/${offerId}`, A.agent.cookie);
  assert.equal(offerRes.status, 200);
  shareToken = ((await offerRes.json()) as { offer: { shareToken: string } }).offer.shareToken;

  const conditionRes = await postJson(`/transactions/${transactionId}/conditions`, A.agent.cookie, {
    description: "Subject to finance",
  });
  assert.equal(conditionRes.status, 201);
  conditionId = ((await conditionRes.json()) as { condition: { id: number } }).condition.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("an unauthenticated transaction read is 401 before the entitlement gate", async () => {
  const res = await fetch(`${baseUrl}/api/transactions/${transactionId}`);
  assert.equal(res.status, 401);
});

test("transaction reads and mutations, and authenticated offer reads, require run.access", async () => {
  await setRunAccess(A.brokerageId, false);

  await assertNotEntitled(await getJson(`/transactions/${transactionId}`, A.agent.cookie), "GET /transactions/:id");
  await assertNotEntitled(
    await getJson(`/transactions/by-property/${propertyId}`, A.agent.cookie),
    "GET /transactions/by-property/:propertyId",
  );
  await assertNotEntitled(
    await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie),
    "POST /transactions/:id/contract-signed",
  );
  await assertNotEntitled(
    await postJson(`/transactions/conditions/${conditionId}/reschedule`, A.agent.cookie, { newDueDate: "2027-06-01" }),
    "POST /transactions/conditions/:conditionId/reschedule",
  );
  await assertNotEntitled(await getJson(`/offers/${offerId}`, A.agent.cookie), "GET /offers/:id");

  // Buyer status link has no session and is not a Run agent route.
  const publicRes = await fetch(`${baseUrl}/api/offers/public/${shareToken}`);
  assert.equal(publicRes.status, 200);

  // Brokerage B still holds run.access. A foreign transaction stays 404, not 403.
  const foreign = await getJson(`/transactions/${transactionId}`, B.agent.cookie);
  assert.equal(foreign.status, 404);

  await setRunAccess(A.brokerageId, true);

  const read = await getJson(`/transactions/${transactionId}`, A.agent.cookie);
  assert.equal(read.status, 200);
  const { transaction } = (await read.json()) as { transaction: { id: number } };
  assert.equal(transaction.id, transactionId);

  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200);

  const rescheduled = await postJson(`/transactions/conditions/${conditionId}/reschedule`, A.agent.cookie, {
    newDueDate: "2027-06-01",
  });
  assert.equal(rescheduled.status, 200);

  const offer = await getJson(`/offers/${offerId}`, A.agent.cookie);
  assert.equal(offer.status, 200);
});
