// R-F43 — exception routes that operate on a property or an exception
// require run.access. Brokerage membership is answered first, so another
// brokerage stays the existing 404 even when that caller has no
// run.access. A missing grant is requireEntitlement's existing 403 and
// nothing is written. A same-brokerage caller who holds run.access keeps
// the previous read and acknowledge behaviour, including financial
// redaction. Ops health and the manual scan do not take a property or
// exception id and stay on the role gate only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, riskExceptions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createOrUpdateException, newCorrelationId } from "../../lib/exceptions/model.js";
import type { RiskFinding } from "../../lib/exceptions/types.js";
import {
  cleanupBrokerages,
  createTransactionFromListedProperty,
  type DevLoginResult,
  createBrokerageWithUsers,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const MISSING_PROPERTY_ID = 2_000_000_000;

let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let transactionPropertyId: number;
let transactionId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function call(method: string, path: string, cookie?: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (cookie) init.headers = headers(cookie, body !== undefined);
  else if (body !== undefined) init.headers = { "content-type": "application/json" };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`${baseUrl}/api${path}`, init);
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

async function assertNotEntitled(res: Response, label: string): Promise<void> {
  const text = await res.text();
  assert.equal(res.status, 403, `${label} -> ${res.status} ${text}`);
  const body = JSON.parse(text) as {
    error?: string;
    reason?: string;
    entitlementKey?: string;
    upgrade?: { action?: string; productCode?: string };
  };
  assert.equal(body.error, "Not entitled", label);
  assert.equal(body.reason, "ENTITLEMENT_MISSING", label);
  assert.equal(body.entitlementKey, "run.access", label);
  assert.deepEqual(body.upgrade, { action: "grow.checkout", productCode: "grow" }, label);
}

interface ExceptionSnapshot {
  status: string;
  ownerType: string;
  ownerUserId: number | null;
  reassignmentCount: number;
}

async function snapshot(id: string): Promise<ExceptionSnapshot> {
  const [row] = await db
    .select({
      status: riskExceptions.status,
      ownerType: riskExceptions.ownerType,
      ownerUserId: riskExceptions.ownerUserId,
      reassignmentCount: riskExceptions.reassignmentCount,
    })
    .from(riskExceptions)
    .where(eq(riskExceptions.id, id));
  if (!row) throw new Error(`exception ${id} missing`);
  return row;
}

let fixtureCounter = 0;
async function makeException(overrides: Partial<RiskFinding> & { propertyId: number; brokerageId: number; transactionId: number | null }) {
  fixtureCounter += 1;
  const { propertyId, brokerageId, transactionId, ...rest } = overrides;
  const finding: RiskFinding = {
    ruleId: "TEST_RUN_ACCESS_RULE",
    ruleVersion: 1,
    category: "WORKFLOW_OPERATIONAL",
    severity: "ATTENTION",
    title: `Run access finding ${suffix}`,
    problemDescription: "A route test problem.",
    businessImpact: "Route test impact.",
    detectedCause: "Route test cause.",
    ownerType: "UNASSIGNED_QUEUE",
    ownerUserId: null,
    propertyId,
    transactionId,
    dueAt: null,
    escalatesAt: null,
    recommendedAction: "Do the route test thing.",
    resolutionRequirements: "The route test condition clears.",
    dismissible: true,
    sourceRecordType: transactionId == null ? "property" : "transaction",
    sourceRecordId: String(transactionId ?? propertyId),
    dedupKey: `TEST_RUN_ACCESS_RULE:${brokerageId}:${propertyId}:${fixtureCounter}`,
    recurrenceMode: "REOPEN",
    requiresFinancialEntitlement: false,
    ...rest,
  };
  const created = await createOrUpdateException(finding, brokerageId, propertyId, transactionId, newCorrelationId(), null);
  return created.exception;
}

const mutations: Array<{ method: string; path: (id: string) => string; body?: unknown; label: string }> = [
  { method: "POST", path: (id) => `/exceptions/${id}/acknowledge`, label: "POST /exceptions/:id/acknowledge" },
  { method: "POST", path: (id) => `/exceptions/${id}/start-remediation`, label: "POST /exceptions/:id/start-remediation" },
  {
    method: "POST",
    path: (id) => `/exceptions/${id}/awaiting-external`,
    body: { note: "Waiting." },
    label: "POST /exceptions/:id/awaiting-external",
  },
  { method: "POST", path: (id) => `/exceptions/${id}/resolve`, body: { note: "Done." }, label: "POST /exceptions/:id/resolve" },
  { method: "POST", path: (id) => `/exceptions/${id}/dismiss`, body: { reason: "Not applicable." }, label: "POST /exceptions/:id/dismiss" },
  {
    method: "POST",
    path: (id) => `/exceptions/${id}/reassign`,
    body: { ownerType: "UNASSIGNED_QUEUE", ownerUserId: null, reason: "Leave it." },
    label: "POST /exceptions/:id/reassign",
  },
];

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

  A = await createBrokerageWithUsers(baseUrl, `R-F43 Exceptions A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F43 Exceptions B ${suffix}`);

  const propRes = await call("POST", "/properties", A.agent.cookie, {
    formattedAddress: `${suffix} Exception Lane`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(propRes.status, 201, await propRes.clone().text());
  propertyId = ((await propRes.json()) as { property: { id: number } }).property.id;

  const created = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Exception Transaction St`,
  });
  transactionPropertyId = created.propertyId;
  transactionId = created.transactionId;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("without run.access every property and exception route is 403 and writes nothing", async () => {
  const propertyException = await makeException({ propertyId, brokerageId: A.brokerageId, transactionId: null });
  const transactionException = await makeException({
    propertyId: transactionPropertyId,
    brokerageId: A.brokerageId,
    transactionId,
  });
  const beforeProperty = await snapshot(propertyException.id);
  const beforeTransaction = await snapshot(transactionException.id);

  await setRunAccess(A.brokerageId, false);
  try {
    await assertNotEntitled(await call("GET", `/properties/${propertyId}/exceptions`, A.agent.cookie), "GET property exceptions");
    await assertNotEntitled(
      await call("GET", `/properties/${transactionPropertyId}/exceptions`, A.agent.cookie),
      "GET transaction property exceptions",
    );
    await assertNotEntitled(await call("GET", "/exceptions", A.agent.cookie), "GET /exceptions");
    await assertNotEntitled(await call("GET", `/exceptions/${propertyException.id}`, A.agent.cookie), "GET property exception");
    await assertNotEntitled(
      await call("GET", `/exceptions/${transactionException.id}`, A.admin.cookie),
      "GET transaction exception",
    );
    for (const entry of mutations) {
      await assertNotEntitled(
        await call(entry.method, entry.path(propertyException.id), A.agent.cookie, entry.body),
        entry.label,
      );
    }

    const health = await call("GET", "/exceptions/ops/health", A.admin.cookie);
    assert.equal(health.status, 200, await health.clone().text());
  } finally {
    await setRunAccess(A.brokerageId, true);
  }

  assert.deepEqual(await snapshot(propertyException.id), beforeProperty);
  assert.deepEqual(await snapshot(transactionException.id), beforeTransaction);
});

test("another brokerage is 404, including when that caller has no run.access, and matches a missing id", async () => {
  const propertyException = await makeException({ propertyId, brokerageId: A.brokerageId, transactionId: null });
  const transactionException = await makeException({
    propertyId: transactionPropertyId,
    brokerageId: A.brokerageId,
    transactionId,
  });
  const beforeProperty = await snapshot(propertyException.id);
  const beforeTransaction = await snapshot(transactionException.id);
  const missingExceptionId = randomUUID();

  await setRunAccess(B.brokerageId, false);
  try {
    const foreignProperty = await call("GET", `/properties/${propertyId}/exceptions`, B.agent.cookie);
    const foreignPropertyText = await foreignProperty.text();
    assert.equal(foreignProperty.status, 404, foreignPropertyText);
    assert.deepEqual(JSON.parse(foreignPropertyText), { error: `Property ${propertyId} not found`, reason: "NOT_FOUND" });
    assert.equal(JSON.parse(foreignPropertyText).entitlementKey, undefined);

    const missingProperty = await call("GET", `/properties/${MISSING_PROPERTY_ID}/exceptions`, B.agent.cookie);
    const missingPropertyText = await missingProperty.text();
    assert.equal(missingProperty.status, 404, missingPropertyText);
    assert.deepEqual(JSON.parse(missingPropertyText), {
      error: `Property ${MISSING_PROPERTY_ID} not found`,
      reason: "NOT_FOUND",
    });

    const foreignTransactionProperty = await call("GET", `/properties/${transactionPropertyId}/exceptions`, B.agent.cookie);
    assert.equal(foreignTransactionProperty.status, 404);
    assert.deepEqual(await foreignTransactionProperty.json(), {
      error: `Property ${transactionPropertyId} not found`,
      reason: "NOT_FOUND",
    });

    const foreignDetail = await call("GET", `/exceptions/${propertyException.id}`, B.agent.cookie);
    const foreignDetailText = await foreignDetail.text();
    const missingDetail = await call("GET", `/exceptions/${missingExceptionId}`, B.agent.cookie);
    const missingDetailText = await missingDetail.text();
    assert.equal(foreignDetail.status, 404, foreignDetailText);
    assert.equal(missingDetail.status, 404, missingDetailText);
    assert.equal(foreignDetailText, missingDetailText);
    assert.deepEqual(JSON.parse(foreignDetailText), { error: "Not found" });
    assert.equal(foreignDetailText.includes(propertyException.title), false);

    const foreignTransactionDetail = await call("GET", `/exceptions/${transactionException.id}`, B.admin.cookie);
    assert.equal(foreignTransactionDetail.status, 404);
    assert.equal(await foreignTransactionDetail.text(), missingDetailText);

    for (const entry of mutations) {
      const foreign = await call(entry.method, entry.path(transactionException.id), B.agent.cookie, entry.body);
      const foreignText = await foreign.text();
      const missing = await call(entry.method, entry.path(missingExceptionId), B.agent.cookie, entry.body);
      const missingText = await missing.text();
      assert.equal(foreign.status, 404, `${entry.label} -> ${foreign.status} ${foreignText}`);
      assert.equal(missing.status, 404, `${entry.label} missing -> ${missing.status} ${missingText}`);
      assert.equal(foreignText, missingText, entry.label);
      assert.deepEqual(JSON.parse(foreignText), { error: "Exception not found", reason: "NOT_FOUND" });
      assert.equal(foreignText.includes(transactionException.title), false);
    }
  } finally {
    await setRunAccess(B.brokerageId, true);
  }

  assert.deepEqual(await snapshot(propertyException.id), beforeProperty);
  assert.deepEqual(await snapshot(transactionException.id), beforeTransaction);
});

test("a same-brokerage caller with run.access keeps the previous read, acknowledge, and financial redaction", async () => {
  await setRunAccess(A.brokerageId, true);
  const created = await makeException({ propertyId, brokerageId: A.brokerageId, transactionId: null });
  const transactionException = await makeException({
    propertyId: transactionPropertyId,
    brokerageId: A.brokerageId,
    transactionId,
  });

  const propertyList = await call("GET", `/properties/${propertyId}/exceptions`, A.agent.cookie);
  assert.equal(propertyList.status, 200, await propertyList.clone().text());
  const propertyBody = (await propertyList.json()) as { exceptions: Array<{ id: string }> };
  assert.ok(propertyBody.exceptions.some((row) => row.id === created.id));

  const transactionList = await call("GET", `/properties/${transactionPropertyId}/exceptions`, A.agent.cookie);
  assert.equal(transactionList.status, 200, await transactionList.clone().text());
  const transactionBody = (await transactionList.json()) as { exceptions: Array<{ id: string }> };
  assert.ok(transactionBody.exceptions.some((row) => row.id === transactionException.id));

  const list = await call("GET", "/exceptions?limit=100", A.agent.cookie);
  assert.equal(list.status, 200, await list.clone().text());
  const listBody = (await list.json()) as { exceptions: Array<{ id: string }> };
  assert.ok(listBody.exceptions.some((row) => row.id === created.id));

  const detail = await call("GET", `/exceptions/${created.id}`, A.agent.cookie);
  assert.equal(detail.status, 200, await detail.clone().text());
  const detailBody = (await detail.json()) as { exception: { id: string; status: string } };
  assert.equal(detailBody.exception.id, created.id);
  assert.equal(detailBody.exception.status, "OPEN");

  const acknowledged = await call("POST", `/exceptions/${created.id}/acknowledge`, A.agent.cookie);
  assert.equal(acknowledged.status, 200, await acknowledged.clone().text());
  const acknowledgedBody = (await acknowledged.json()) as { exception: { status: string } };
  assert.equal(acknowledgedBody.exception.status, "ACKNOWLEDGED");
  assert.equal((await snapshot(created.id)).status, "ACKNOWLEDGED");

  const badBody = await call("POST", `/exceptions/${transactionException.id}/resolve`, A.agent.cookie, {});
  assert.equal(badBody.status, 400, await badBody.clone().text());
  assert.equal((await snapshot(transactionException.id)).status, "OPEN");

  const financial = await makeException({
    propertyId,
    brokerageId: A.brokerageId,
    transactionId: null,
    requiresFinancialEntitlement: true,
    category: "FINANCIAL",
  });
  const hidden = await call("GET", `/exceptions/${financial.id}`, A.agent.cookie);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await hidden.json(), { error: "Not found" });
  const visible = await call("GET", `/exceptions/${financial.id}`, A.admin.cookie);
  assert.equal(visible.status, 200, await visible.clone().text());

  const foreign = await call("GET", `/exceptions/${created.id}`, B.agent.cookie);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await foreign.json(), { error: "Not found" });
});
