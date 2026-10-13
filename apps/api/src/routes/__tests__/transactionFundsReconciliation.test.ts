// R-F37 — GET transaction reads add a sibling fundsReconciliation.
// Another brokerage stays 404. Missing run.access stays 403.
// POST bodies stay { transaction } with no reconciliation field.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, transactions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { computeFundsReconciliation } from "../../lib/transactionFunds.js";
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
let barePropertyId: number;

const FLAT_GROSS = 150_000;
const FLAT_GST = 15_000;
const FLAT_EXPECTED = FLAT_GROSS + FLAT_GST;

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

interface ReconciliationBody {
  transaction: {
    id: number;
    grossCommissionCents: number | null;
    gstCents: number | null;
    commissionCalculatedAt: string | null;
    fundsReceivedCents: number;
    fundsReconciliation?: unknown;
  } | null;
  fundsReconciliation: {
    status: string;
    expectedCents: number | null;
    receivedCents: number;
    varianceCents: number | null;
  } | null;
  closureBlockers: string[] | null;
  closureBlockerDetails: unknown[] | null;
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function readBoth(cookie: string): Promise<{ byId: ReconciliationBody; byProperty: ReconciliationBody }> {
  const byIdRes = await getJson(`/transactions/${transactionId}`, cookie);
  assert.equal(byIdRes.status, 200, "GET /transactions/:id");
  const byPropertyRes = await getJson(`/transactions/by-property/${propertyId}`, cookie);
  assert.equal(byPropertyRes.status, 200, "GET /transactions/by-property/:propertyId");
  return {
    byId: await bodyOf<ReconciliationBody>(byIdRes),
    byProperty: await bodyOf<ReconciliationBody>(byPropertyRes),
  };
}

function assertSibling(
  body: ReconciliationBody,
  expected: ReturnType<typeof computeFundsReconciliation>,
): void {
  assert.ok(body.transaction);
  assert.equal(body.transaction.id, transactionId);
  assert.equal("fundsReconciliation" in body.transaction, false);
  assert.equal("closureBlockers" in body.transaction, false);
  assert.equal("closureBlockerDetails" in body.transaction, false);
  assert.ok(Array.isArray(body.closureBlockers));
  assert.ok(Array.isArray(body.closureBlockerDetails));
  assert.deepEqual(body.closureBlockerDetails.map((detail) => (detail as { message: string }).message), body.closureBlockers);
  assert.deepEqual(Object.keys(body).sort(), ["closureBlockerDetails", "closureBlockers", "fundsReconciliation", "transaction"]);
  assert.deepEqual(body.fundsReconciliation, {
    status: expected.status,
    expectedCents: expected.expectedCents,
    receivedCents: expected.receivedCents,
    varianceCents: expected.varianceCents,
  });
  assert.equal(body.transaction.fundsReceivedCents, expected.receivedCents);
}

async function setCommissionAndFunds(fundsReceivedCents: number, calculated: boolean): Promise<void> {
  await db
    .update(transactions)
    .set({
      grossCommissionCents: calculated ? FLAT_GROSS : null,
      gstCents: calculated ? FLAT_GST : null,
      commissionCalculatedAt: calculated ? new Date("2026-10-01T00:00:00.000Z") : null,
      fundsReceivedCents,
    })
    .where(eq(transactions.id, transactionId));
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

  A = await createBrokerageWithUsers(baseUrl, `R-F37 Funds A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F37 Funds B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Funds Reconciliation St`,
    sellerEmail: `seller-rf37-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;

  const bare = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headers(A.agent.cookie, true),
    body: JSON.stringify({
      formattedAddress: `${suffix} No Transaction St`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(bare.status, 201);
  barePropertyId = ((await bare.json()) as { property: { id: number } }).property.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("GET returns fundsReconciliation beside an unchanged transaction", async () => {
  const { byId, byProperty } = await readBoth(A.agent.cookie);
  const expected = computeFundsReconciliation({
    grossCommissionCents: null,
    gstCents: null,
    commissionCalculatedAt: null,
    fundsReceivedCents: 0,
  });
  assertSibling(byId, expected);
  assertSibling(byProperty, expected);
  assert.deepEqual(byId.fundsReconciliation, byProperty.fundsReconciliation);
  assert.equal(byId.transaction?.commissionCalculatedAt, null);
  assert.equal(byId.transaction?.grossCommissionCents, null);
});

test("a property with no transaction returns null for both fields", async () => {
  const res = await getJson(`/transactions/by-property/${barePropertyId}`, A.agent.cookie);
  assert.equal(res.status, 200);
  const body = await bodyOf<ReconciliationBody>(res);
  assert.equal(body.transaction, null);
  assert.equal(body.fundsReconciliation, null);
  assert.equal(body.closureBlockers, null);
  assert.equal(body.closureBlockerDetails, null);
  assert.deepEqual(Object.keys(body).sort(), ["closureBlockerDetails", "closureBlockers", "fundsReconciliation", "transaction"]);
});

test("another brokerage is still 404 on both reads", async () => {
  const byId = await getJson(`/transactions/${transactionId}`, B.agent.cookie);
  assert.equal(byId.status, 404);
  assert.deepEqual(await bodyOf(byId), { error: "Not found" });

  const byProperty = await getJson(`/transactions/by-property/${propertyId}`, B.agent.cookie);
  assert.equal(byProperty.status, 404);
  assert.deepEqual(await bodyOf(byProperty), { error: "Not found" });

  const bare = await getJson(`/transactions/by-property/${barePropertyId}`, B.agent.cookie);
  assert.equal(bare.status, 404);
  assert.deepEqual(await bodyOf(bare), { error: "Not found" });
});

test("missing run.access is still 403 and does not return the reconciliation", async () => {
  await setRunAccess(A.brokerageId, false);
  try {
    for (const path of [`/transactions/${transactionId}`, `/transactions/by-property/${propertyId}`]) {
      const res = await getJson(path, A.agent.cookie);
      assert.equal(res.status, 403, path);
      const body = await bodyOf<{
        error?: string;
        entitlementKey?: string;
        fundsReconciliation?: unknown;
        closureBlockers?: unknown;
        transaction?: unknown;
      }>(res);
      assert.equal(body.error, "Not entitled");
      assert.equal(body.entitlementKey, "run.access");
      assert.equal(body.fundsReconciliation, undefined);
      assert.equal(body.closureBlockers, undefined);
      assert.equal(body.transaction, undefined);
    }
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
});

test("POST responses stay { transaction } and do not add fundsReconciliation", async () => {
  const signed = await postJson(`/transactions/${transactionId}/contract-signed`, A.agent.cookie);
  assert.equal(signed.status, 200);
  const signedBody = await bodyOf<{
    transaction: { id: number; fundsReconciliation?: unknown };
    fundsReconciliation?: unknown;
    closureBlockers?: unknown;
  }>(signed);
  assert.deepEqual(Object.keys(signedBody).sort(), ["transaction"]);
  assert.equal(signedBody.fundsReconciliation, undefined);
  assert.equal(signedBody.closureBlockers, undefined);
  assert.equal("fundsReconciliation" in signedBody.transaction, false);
  assert.equal(signedBody.transaction.id, transactionId);

  const finance = await postJson(`/transactions/${transactionId}/finance-approved`, A.agent.cookie);
  assert.equal(finance.status, 200);
  const financeBody = await bodyOf<Record<string, unknown>>(finance);
  assert.deepEqual(Object.keys(financeBody).sort(), ["transaction"]);

  const funds = await postJson(`/transactions/${transactionId}/funds-received`, A.admin.cookie, { amountCents: 1 });
  assert.equal(funds.status, 200);
  const fundsBody = await bodyOf<{
    transaction: { fundsReceivedCents: number; fundsReconciliation?: unknown };
    closureBlockers?: unknown;
  }>(funds);
  assert.deepEqual(Object.keys(fundsBody).sort(), ["transaction"]);
  assert.equal(fundsBody.closureBlockers, undefined);
  assert.equal("fundsReconciliation" in fundsBody.transaction, false);
  assert.equal(fundsBody.transaction.fundsReceivedCents, 1);

  const { byId } = await readBoth(A.agent.cookie);
  assertSibling(
    byId,
    computeFundsReconciliation({
      grossCommissionCents: null,
      gstCents: null,
      commissionCalculatedAt: null,
      fundsReceivedCents: 1,
    }),
  );
});

test("GET follows calculated commission and funds without changing the transaction object", async () => {
  const cases: Array<{ funds: number; status: string }> = [
    { funds: 0, status: "NOT_RECEIVED" },
    { funds: FLAT_EXPECTED - 1, status: "PARTIAL" },
    { funds: FLAT_EXPECTED, status: "MATCHED" },
    { funds: FLAT_EXPECTED + 1, status: "OVER_RECEIVED" },
  ];
  for (const item of cases) {
    await setCommissionAndFunds(item.funds, true);
    const { byId, byProperty } = await readBoth(A.admin.cookie);
    const expected = computeFundsReconciliation({
      grossCommissionCents: FLAT_GROSS,
      gstCents: FLAT_GST,
      commissionCalculatedAt: new Date("2026-10-01T00:00:00.000Z"),
      fundsReceivedCents: item.funds,
    });
    assert.equal(expected.status, item.status);
    assertSibling(byId, expected);
    assertSibling(byProperty, expected);
    assert.equal(byId.transaction?.grossCommissionCents, FLAT_GROSS);
    assert.equal(byId.transaction?.gstCents, FLAT_GST);
    assert.ok(byId.transaction?.commissionCalculatedAt);
  }
});
