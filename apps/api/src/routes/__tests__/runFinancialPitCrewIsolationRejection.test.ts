// R-F10 — tenant_isolation_rejection_total at the financial and pit_crew
// API boundaries. The response for a cross-tenant id stays the response
// the route already returned. The counter moves only when that row exists
// in another brokerage. A missing id and a same-tenant success do not.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, financialPaymentRequests } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
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
  "other",
]);

const MISSING_ID = 2_147_483_646;
const NOT_ENTITLED = JSON.stringify({
  error: "Not entitled",
  reason: "ENTITLEMENT_MISSING",
  entitlementKey: "run.access",
  upgrade: { action: "grow.checkout", productCode: "grow" },
});

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let fixtureCounter = 0;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let otherPropertyId: number;
let transactionId: number;
let agreementId: number;
let authorityId: number;
let otherAuthorityId: number;
let paymentRequestId: number;
let exceptionId: string;
let otherExceptionId: string;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body?: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: body === undefined ? undefined : JSON.stringify(body),
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

function identifyingIds(): Array<number | string> {
  return [
    A.brokerageId,
    B.brokerageId,
    propertyId,
    otherPropertyId,
    transactionId,
    agreementId,
    authorityId,
    otherAuthorityId,
    paymentRequestId,
    exceptionId,
    otherExceptionId,
    A.admin.user.id,
    A.agent.user.id,
    B.admin.user.id,
    B.agent.user.id,
  ];
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

function buildFinding(targetPropertyId: number, targetBrokerageId: number): RiskFinding {
  fixtureCounter += 1;
  return {
    ruleId: "TEST_RF10_PITCREW_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `R-F10 finding ${fixtureCounter}`,
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
    dedupKey: `TEST_RF10_PITCREW_RULE:${targetBrokerageId}:RF10_${fixtureCounter}`,
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

  A = await createBrokerageWithUsers(baseUrl, `R-F10 Isolation A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F10 Isolation B ${suffix}`);
  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Isolation St`,
    sellerEmail: `seller-rf10-${suffix}@example.com`,
  });
  propertyId = created.propertyId;
  transactionId = created.transactionId;

  const otherProperty = await postRaw("/properties", B.agent.cookie, {
    formattedAddress: `${suffix} Other Isolation St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(otherProperty.status, 201);
  otherPropertyId = ((await otherProperty.json()) as { property: { id: number } }).property.id;

  const agreement = await postRaw("/financial/commission-agreements", A.admin.cookie, {
    transactionId,
    method: "PERCENTAGE",
    rateBps: 220,
  });
  assert.equal(agreement.status, 201);
  agreementId = ((await agreement.json()) as { agreement: { id: number } }).agreement.id;

  const authority = await postRaw("/financial/pc-fee-authorities", A.admin.cookie, {
    agentUserId: A.agent.user.id,
    rateBps: 690,
  });
  assert.equal(authority.status, 201);
  authorityId = ((await authority.json()) as { authority: { id: number } }).authority.id;

  const otherAuthority = await postRaw("/financial/pc-fee-authorities", B.admin.cookie, {
    agentUserId: B.agent.user.id,
    rateBps: 690,
  });
  assert.equal(otherAuthority.status, 201);
  otherAuthorityId = ((await otherAuthority.json()) as { authority: { id: number } }).authority.id;

  const [payment] = await db
    .insert(financialPaymentRequests)
    .values({ brokerageId: A.brokerageId, propertyId, transactionId, amountCents: 1500 })
    .returning({ id: financialPaymentRequests.id });
  paymentRequestId = payment.id;

  exceptionId = await createException(A.brokerageId, propertyId);
  otherExceptionId = await createException(B.brokerageId, otherPropertyId);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F10 tenant isolation rejection metric", { concurrency: 1 }, () => {
  describe("R-F10 financial boundary", { concurrency: 1 }, () => {
    test("a property in another brokerage on the summary is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/financial/summary`, B.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("financial");
    });

    test("a missing property id on the summary is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${MISSING_ID}/financial/summary`, A.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("the caller's own property summary still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/financial/summary`, A.admin.cookie);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { propertyId: number };
      assert.equal(body.propertyId, propertyId);
      assertNoIncrement();
    });

    test("a commission agreement in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/commission-agreements/${agreementId}`, B.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("financial");
    });

    test("a missing commission agreement id is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/commission-agreements/${MISSING_ID}`, A.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("the caller's own commission agreement still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/commission-agreements/${agreementId}`, A.admin.cookie);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agreement: { id: number; status: string } };
      assert.equal(body.agreement.id, agreementId);
      assert.equal(body.agreement.status, "DRAFT");
      assertNoIncrement();
    });

    test("approving another brokerage's agreement is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/commission-agreements/${agreementId}/approve`, B.admin.cookie, {});
      await assertJson(
        res,
        404,
        JSON.stringify({ error: `Commission agreement ${agreementId} not found.`, reason: "NOT_FOUND" }),
      );
      assertIncrement("financial");
    });

    test("approving a missing agreement is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/commission-agreements/${MISSING_ID}/approve`, A.admin.cookie, {});
      await assertJson(
        res,
        404,
        JSON.stringify({ error: `Commission agreement ${MISSING_ID} not found.`, reason: "NOT_FOUND" }),
      );
      assertNoIncrement();
    });

    test("the drafter's own separation-of-duties rejection does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/commission-agreements/${agreementId}/approve`, A.admin.cookie, {});
      await assertJson(
        res,
        403,
        JSON.stringify({
          error: "The user who drafted a commission agreement cannot also approve it.",
          reason: "SEPARATION_OF_DUTIES",
        }),
      );
      assertNoIncrement();
    });

    test("cancelling another brokerage's agreement is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/commission-agreements/${agreementId}/cancel`, B.admin.cookie, {
        reason: "cross-tenant",
      });
      await assertJson(
        res,
        404,
        JSON.stringify({ error: `Commission agreement ${agreementId} not found.`, reason: "NOT_FOUND" }),
      );
      assertIncrement("financial");
    });

    test("a PC fee authority in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/pc-fee-authorities/${authorityId}`, B.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("financial");
    });

    test("a missing PC fee authority id is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/pc-fee-authorities/${MISSING_ID}`, A.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("the caller's own PC fee authority still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/pc-fee-authorities/${authorityId}`, A.admin.cookie);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { authority: { id: number; status: string } };
      assert.equal(body.authority.id, authorityId);
      assert.equal(body.authority.status, "PENDING");
      assertNoIncrement();
    });

    test("naming an agent in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/financial/pc-fee-authorities", A.admin.cookie, {
        agentUserId: B.agent.user.id,
        rateBps: 690,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Agent not found" }));
      assertIncrement("financial");
    });

    test("naming an agent that does not exist is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/financial/pc-fee-authorities", A.admin.cookie, {
        agentUserId: MISSING_ID,
        rateBps: 690,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Agent not found" }));
      assertNoIncrement();
    });

    test("activating another brokerage's authority is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/pc-fee-authorities/${authorityId}/activate`, B.admin.cookie, {
        mandateProviderRef: "sandbox-rf10",
        mandateProvider: "sandbox",
      });
      await assertJson(res, 404, JSON.stringify({ error: `PC fee authority ${authorityId} not found.`, reason: "NOT_FOUND" }));
      assertIncrement("financial");
    });

    test("activating a missing authority is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/pc-fee-authorities/${MISSING_ID}/activate`, A.admin.cookie, {
        mandateProviderRef: "sandbox-rf10",
        mandateProvider: "sandbox",
      });
      await assertJson(
        res,
        404,
        JSON.stringify({ error: `PC fee authority ${MISSING_ID} not found.`, reason: "NOT_FOUND" }),
      );
      assertNoIncrement();
    });

    test("revoking another brokerage's authority is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/pc-fee-authorities/${authorityId}/revoke`, B.admin.cookie, {
        reason: "cross-tenant",
      });
      await assertJson(res, 404, JSON.stringify({ error: `PC fee authority ${authorityId} not found.`, reason: "NOT_FOUND" }));
      assertIncrement("financial");
    });

    test("a payment request in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/payment-requests/${paymentRequestId}`, B.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("financial");
    });

    test("a missing payment request id is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/payment-requests/${MISSING_ID}`, A.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("the caller's own payment request still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/payment-requests/${paymentRequestId}`, A.admin.cookie);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { paymentRequest: { id: number } };
      assert.equal(body.paymentRequest.id, paymentRequestId);
      assertNoIncrement();
    });

    test("a payment-request write for another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/financial/payment-requests/${paymentRequestId}/notice-sent`, B.admin.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("financial");
    });

    test("a PC fee calculation against another brokerage's authority is still 409 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/financial/pc-fee-calculations", A.admin.cookie, {
        transactionId,
        pcFeeAuthorityId: otherAuthorityId,
        commissionCalculationId: MISSING_ID,
      });
      await assertJson(res, 409, JSON.stringify({ error: `PC fee authority ${otherAuthorityId} not found.` }));
      assertIncrement("financial");
    });

    test("a PC fee calculation against a missing authority is still 409 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/financial/pc-fee-calculations", A.admin.cookie, {
        transactionId,
        pcFeeAuthorityId: MISSING_ID,
        commissionCalculationId: MISSING_ID,
      });
      await assertJson(res, 409, JSON.stringify({ error: `PC fee authority ${MISSING_ID} not found.` }));
      assertNoIncrement();
    });

    test("a collection read filtered by another brokerage's transaction does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/financial/commission-agreements?transactionId=${transactionId}`, B.admin.cookie);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { agreements: unknown[] };
      assert.deepEqual(body.agreements, []);
      assertNoIncrement();
    });

    test("a role rejection does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/financial/summary`, A.agent.cookie);
      await assertJson(res, 403, JSON.stringify({ error: "Forbidden" }));
      assertNoIncrement();
    });

    test("an entitlement rejection does not increment", async () => {
      await setRunAccess(A.brokerageId, false);
      try {
        resetMetricsForTesting();
        const res = await getRaw(`/properties/${propertyId}/financial/summary`, A.admin.cookie);
        await assertJson(res, 403, NOT_ENTITLED);
        assertNoIncrement();
      } finally {
        await setRunAccess(A.brokerageId, true);
      }
    });
  });

  describe("R-F10 pit_crew boundary", { concurrency: 1 }, () => {
    function claimBody(targetPropertyId: number) {
      return { propertyId: targetPropertyId, expectedVersion: 0 };
    }

    test("claiming a property in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/claim`, A.admin.cookie, claimBody(otherPropertyId));
      await assertJson(res, 404, JSON.stringify({ error: "Property not found in this brokerage." }));
      assertIncrement("pit_crew");
    });

    test("claiming a missing property is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/claim`, A.admin.cookie, claimBody(MISSING_ID));
      await assertJson(res, 404, JSON.stringify({ error: "Property not found in this brokerage." }));
      assertNoIncrement();
    });

    test("claiming another brokerage's work item on the caller's own property is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${otherExceptionId}/claim`, A.admin.cookie, claimBody(propertyId));
      await assertJson(res, 404, JSON.stringify({ error: "Work item not found in this brokerage." }));
      assertIncrement("pit_crew");
    });

    test("claiming a missing work item is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${randomUUID()}/claim`, A.admin.cookie, claimBody(propertyId));
      await assertJson(res, 404, JSON.stringify({ error: "Work item not found in this brokerage." }));
      assertNoIncrement();
    });

    test("a malformed work item id is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/pit-crew/items/EXCEPTION/not-a-real-uuid/claim", A.admin.cookie, claimBody(propertyId));
      await assertJson(res, 404, JSON.stringify({ error: "Work item not found in this brokerage." }));
      assertNoIncrement();
    });

    test("assigning to a user in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/assign`, A.admin.cookie, {
        propertyId,
        expectedVersion: 0,
        assigneeUserId: B.agent.user.id,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Assignee not found in this brokerage." }));
      assertIncrement("pit_crew");
    });

    test("assigning to a user that does not exist is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/assign`, A.admin.cookie, {
        propertyId,
        expectedVersion: 0,
        assigneeUserId: MISSING_ID,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Assignee not found in this brokerage." }));
      assertNoIncrement();
    });

    test("the caller's own claim still succeeds and a later conflict does not increment", async () => {
      resetMetricsForTesting();
      const claimed = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/claim`, A.admin.cookie, claimBody(propertyId));
      assert.equal(claimed.status, 200);
      assert.match(claimed.headers.get("content-type") ?? "", /^application\/json/);
      const row = (await claimed.json()) as { status: string; propertyId: number; version: number };
      assert.equal(row.status, "CLAIMED");
      assert.equal(row.propertyId, propertyId);
      assertNoIncrement();

      resetMetricsForTesting();
      const conflict = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/start`, A.admin.cookie, {
        propertyId,
        expectedVersion: row.version + 99,
      });
      await assertJson(conflict, 409, JSON.stringify({ error: "This item was changed by someone else. Refresh and try again." }));
      assertNoIncrement();
    });

    test("a note on a property in another brokerage keeps its error and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/note`, A.admin.cookie, {
        propertyId: otherPropertyId,
        note: "should not land",
      });
      await assertJson(
        res,
        500,
        JSON.stringify({ error: "An unexpected error occurred. Please try again or contact support if the problem persists." }),
      );
      assertIncrement("pit_crew");
    });

    test("a note on a missing property keeps its error and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/note`, A.admin.cookie, {
        propertyId: MISSING_ID,
        note: "missing property",
      });
      await assertJson(
        res,
        500,
        JSON.stringify({ error: "An unexpected error occurred. Please try again or contact support if the problem persists." }),
      );
      assertNoIncrement();
    });

    test("a note on the caller's own property still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/note`, A.admin.cookie, {
        propertyId,
        note: "own property note",
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { propertyId: number };
      assert.equal(body.propertyId, propertyId);
      assertNoIncrement();
    });

    test("the workspace read does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw("/pit-crew/workspace", A.admin.cookie);
      assert.equal(res.status, 200);
      assertNoIncrement();
    });

    test("a role rejection does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/pit-crew/items/EXCEPTION/${exceptionId}/claim`, A.agent.cookie, claimBody(propertyId));
      await assertJson(res, 403, JSON.stringify({ error: "Forbidden" }));
      assertNoIncrement();
    });

    test("an entitlement rejection does not increment", async () => {
      await setRunAccess(A.brokerageId, false);
      try {
        resetMetricsForTesting();
        const res = await postRaw(`/pit-crew/items/EXCEPTION/${otherExceptionId}/claim`, A.admin.cookie, claimBody(propertyId));
        await assertJson(res, 403, NOT_ENTITLED);
        assertNoIncrement();
      } finally {
        await setRunAccess(A.brokerageId, true);
      }
    });
  });
});
