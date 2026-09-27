// R-F8 — tenant_isolation_rejection_total at the Run transaction, financial,
// and offer boundaries. The response for a cross-tenant id stays the same
// 404 the route already returned. The counter moves only when that row
// exists in another brokerage.
//
// Offer routes have no declared `offer` boundary label. They emit
// boundary="transaction", the closest declared value. See offers.ts.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
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

const DECLARED_BOUNDARIES = new Set([
  "property",
  "party",
  "transaction",
  "financial",
  "communications",
  "integrations",
  "pit_crew",
  "grow",
  "other",
]);

// No `offer` value is declared. Offer rejections use this closest value.
const OFFER_BOUNDARY = "transaction";
const MISSING_ID = 2_147_483_646;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let offerId: number;
let transactionId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

function isolationSeries(): Array<{ boundary: string; value: number; labels: string }> {
  const found: Array<{ boundary: string; value: number; labels: string }> = [];
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
    const match = /^tenant_isolation_rejection_total\{(.+)\} (\d+)$/.exec(line);
    assert.ok(match, `unparsed metric line: ${line}`);
    const labels = match[1];
    const boundary = /^boundary="([^"]*)"$/.exec(labels);
    assert.ok(boundary, `only the boundary label is allowed, got ${labels}`);
    found.push({ boundary: boundary[1], value: Number(match[2]), labels });
  }
  return found;
}

function identifyingIds(): number[] {
  return [A.brokerageId, B.brokerageId, propertyId, offerId, transactionId, A.admin.user.id, A.agent.user.id, B.admin.user.id, B.agent.user.id];
}

function assertBoundedLabels(): void {
  for (const series of isolationSeries()) {
    assert.ok(DECLARED_BOUNDARIES.has(series.boundary), series.boundary);
    assert.equal(series.labels, `boundary="${series.boundary}"`);
    for (const id of identifyingIds()) {
      assert.equal(series.boundary.includes(String(id)), false, `label value contains id ${id}`);
    }
  }
}

function assertIncrement(boundary: string): void {
  const series = isolationSeries();
  assert.equal(series.length, 1);
  assert.equal(series[0].boundary, boundary);
  assert.equal(series[0].value, 1);
  assertBoundedLabels();
}

function assertNoIncrement(): void {
  assert.deepEqual(isolationSeries(), []);
}

async function assertJson(res: Response, status: number, body: string): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(await res.text(), body);
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

  A = await createBrokerageWithUsers(baseUrl, `R-F8 Isolation A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F8 Isolation B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Isolation St`,
    sellerEmail: `seller-rf8-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  offerId = created.offerId;
  transactionId = created.transactionId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F8 tenant isolation rejection metric", { concurrency: 1 }, () => {
describe("R-F8 transaction boundary", { concurrency: 1 }, () => {
  test("a transaction in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/transactions/${transactionId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertIncrement("transaction");
  });

  test("a property in another brokerage on the by-property route is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/transactions/by-property/${propertyId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertIncrement("transaction");
  });

  test("a missing transaction id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/transactions/${MISSING_ID}`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertNoIncrement();
  });

  test("the caller's own transaction still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/transactions/${transactionId}`, A.agent.cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as { transaction: { id: number } };
    assert.equal(body.transaction.id, transactionId);
    assertNoIncrement();
  });

  test("a role rejection of the caller's own transaction does not increment", async () => {
    resetMetricsForTesting();
    const res = await postRaw(`/transactions/${transactionId}/close`, A.agent.cookie, {});
    await assertJson(res, 403, JSON.stringify({ error: "Forbidden" }));
    assertNoIncrement();
  });

  test("an entitlement rejection does not increment", async () => {
    await setRunAccess(A.brokerageId, false);
    try {
      resetMetricsForTesting();
      const res = await getRaw(`/transactions/${transactionId}`, A.agent.cookie);
      await assertJson(
        res,
        403,
        JSON.stringify({
          error: "Not entitled",
          reason: "ENTITLEMENT_MISSING",
          entitlementKey: "run.access",
          upgrade: { action: "grow.checkout", productCode: "grow" },
        }),
      );
      assertNoIncrement();
    } finally {
      await setRunAccess(A.brokerageId, true);
    }
  });
});

describe("R-F8 financial boundary", { concurrency: 1 }, () => {
  function agreementBody() {
    return { transactionId, method: "PERCENTAGE" as const, rateBps: 220 };
  }

  test("a transaction in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/financial/commission-agreements", B.admin.cookie, agreementBody());
    await assertJson(res, 404, JSON.stringify({ error: "Transaction not found" }));
    assertIncrement("financial");
  });

  test("a missing transaction id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/financial/commission-agreements", A.admin.cookie, {
      transactionId: MISSING_ID,
      method: "PERCENTAGE",
      rateBps: 220,
    });
    await assertJson(res, 404, JSON.stringify({ error: "Transaction not found" }));
    assertNoIncrement();
  });

  test("the caller's own transaction still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/financial/commission-agreements", A.admin.cookie, agreementBody());
    assert.equal(res.status, 201);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as { agreement: { status: string; transactionId: number } };
    assert.equal(body.agreement.status, "DRAFT");
    assert.equal(body.agreement.transactionId, transactionId);
    assertNoIncrement();
  });

  test("a role rejection does not increment", async () => {
    resetMetricsForTesting();
    const res = await postRaw("/financial/commission-agreements", A.agent.cookie, agreementBody());
    await assertJson(res, 403, JSON.stringify({ error: "Forbidden" }));
    assertNoIncrement();
  });

  test("an entitlement rejection does not increment", async () => {
    await setRunAccess(A.brokerageId, false);
    try {
      resetMetricsForTesting();
      const res = await postRaw("/financial/commission-agreements", A.admin.cookie, agreementBody());
      await assertJson(
        res,
        403,
        JSON.stringify({
          error: "Not entitled",
          reason: "ENTITLEMENT_MISSING",
          entitlementKey: "run.access",
          upgrade: { action: "grow.checkout", productCode: "grow" },
        }),
      );
      assertNoIncrement();
    } finally {
      await setRunAccess(A.brokerageId, true);
    }
  });
});

describe("R-F8 offer boundary", { concurrency: 1 }, () => {
  test("an offer in another brokerage is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/offers/${offerId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertIncrement(OFFER_BOUNDARY);
  });

  test("a property in another brokerage on the by-property route is still 404 and increments once", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/offers/by-property/${propertyId}`, B.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertIncrement(OFFER_BOUNDARY);
  });

  test("a missing offer id is still 404 and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/offers/${MISSING_ID}`, A.agent.cookie);
    await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
    assertNoIncrement();
  });

  test("the caller's own offer still succeeds and does not increment", async () => {
    resetMetricsForTesting();
    const res = await getRaw(`/offers/${offerId}`, A.agent.cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as { offer: { id: number } };
    assert.equal(body.offer.id, offerId);
    assertNoIncrement();
  });

  test("an entitlement rejection does not increment", async () => {
    await setRunAccess(A.brokerageId, false);
    try {
      resetMetricsForTesting();
      const res = await getRaw(`/offers/${offerId}`, A.agent.cookie);
      await assertJson(
        res,
        403,
        JSON.stringify({
          error: "Not entitled",
          reason: "ENTITLEMENT_MISSING",
          entitlementKey: "run.access",
          upgrade: { action: "grow.checkout", productCode: "grow" },
        }),
      );
      assertNoIncrement();
    } finally {
      await setRunAccess(A.brokerageId, true);
    }
  });
});
});
