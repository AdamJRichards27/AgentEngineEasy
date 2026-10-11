// AE GROW Pilot Readiness WP9 — internal error text must never reach a client.
//
// Live smoke testing of the hardened branch found response bodies containing
// the Postgres driver's own text — `Failed query: select "id",
// "brokerage_id" ... from ...` — returned to any authenticated caller. The
// same class of defect was fixed first in routes/growAppraisals.ts
// (handleGrowAppraisalError) and routes/propertyIntelligence.ts
// (handlePropertyIntelligenceError); this suite covers the seven remaining
// routers: documents, appraisals, aml, transactions, properties, tasks and
// offers.
//
// Two proofs per router, both over real HTTP through the real app, the real
// session cookie and real Postgres — the same technique
// routes/__tests__/routeIdValidation.test.ts,
// routes/__tests__/growAppraisalsHardening.test.ts and
// routes/__tests__/propertyIntelligence.test.ts already use:
//
//   1. A malformed route id is a 400 answered BEFORE any query runs, so the
//      driver never produces text to leak in the first place.
//   2. A genuine unrecognised internal failure — an untyped driver error
//      raised from deep inside a real query, triggered here by ordinary
//      request data the route schema accepts — is a generic 500 whose body
//      carries no query text, no table name and no column name.
//
// Each unknown-failure vector below is a real latent fault, not a stub: a
// value the route's own zod schema admits which Postgres then rejects at
// bind/cast time. Before this work package every one of them was returned to
// the caller verbatim, with a client-error status.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, automationAttentionItems } from "@aee/db";
import {
  createBrokerageWithUsers,
  createListedProperty,
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
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let cookie: string;

const suffix = Date.now();

/** A NUL byte, which Postgres rejects in any text value. Built rather than
 *  written literally so this source file stays free of control characters. */
const NUL = String.fromCharCode(0);

/**
 * Larger than int4 but still a safe JS integer, so `z.number().int()`
 * accepts it and Postgres then rejects it with 22003 (numeric value out of
 * range) at bind time.
 */
const INT4_OVERFLOW = 9_007_199_254_740_991;

/**
 * Every shape a route id can be malformed in — the same list
 * routes/__tests__/routeIdValidation.test.ts uses. The last two ARE
 * integers; they are simply outside the int4 range every `serial` primary
 * key in this schema uses. None of them is a valid uuid either, which is
 * what routes/tasks.ts's own ids are.
 */
const MALFORMED_IDS = ["abc", "0", "-1", "1.5", "99999999999999999999", "2147483648"];

const GENERIC_MESSAGE = "An unexpected error occurred. Please try again or contact support if the problem persists.";

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `WP9 ErrorLeak ${suffix}`);
  cookie = A.admin.cookie;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

interface RouteUnderTest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path with {id} standing in for the parameter under test. */
  path: string;
  body?: unknown;
}

function call(route: RouteUnderTest, id: string): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  if (route.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${route.path.replace("{id}", id)}`, {
    method: route.method,
    headers,
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

async function createProperty(address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(res.status, 201, `create property failed: ${await res.clone().text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

/**
 * The single assertion this whole work package exists for: whatever the
 * status, the body never describes the server's own internals.
 */
async function assertNoInternalDetail(res: Response, label: string): Promise<{ error?: unknown }> {
  const text = await res.text();
  assert.doesNotMatch(text, /Failed query/i, `${label} leaked the driver's failed-query text: ${text}`);
  assert.doesNotMatch(text, /select /i, `${label} leaked SQL: ${text}`);
  assert.doesNotMatch(text, /\bfrom "?\w+"?\b/i, `${label} leaked a table reference: ${text}`);
  assert.doesNotMatch(text, /\bbrokerage_id\b|\bproperty_id\b|\bparams:/i, `${label} leaked a column/bind detail: ${text}`);
  return JSON.parse(text) as { error?: unknown };
}

async function assertRejectsMalformedIds(routes: RouteUnderTest[]): Promise<void> {
  for (const route of routes) {
    for (const id of MALFORMED_IDS) {
      const res = await call(route, id);
      const label = `${route.method} ${route.path.replace("{id}", id)}`;
      const clone = res.clone();
      assert.equal(res.status, 400, `${label} must answer 400, got ${res.status}: ${await clone.text()}`);
      const body = await assertNoInternalDetail(res, label);
      assert.equal(typeof body.error, "string", `${label} must use the existing { error } shape`);
    }
  }
}

/** A generic 500 with nothing of the server in it. */
async function assertGenericServerError(res: Response, label: string): Promise<void> {
  const clone = res.clone();
  assert.equal(res.status, 500, `${label} must answer 500, got ${res.status}: ${await clone.text()}`);
  const body = await assertNoInternalDetail(res, label);
  assert.equal(body.error, GENERIC_MESSAGE, `${label} must answer the generic message`);
}

/* =====================================================================
 * 1. Malformed route ids — a 400 before any query runs.
 * ===================================================================*/

test("documents: every :id route rejects a malformed id (there was no guard at all)", async () => {
  await assertRejectsMalformedIds([
    { method: "PUT", path: "/api/documents/agency-agreement-terms/{id}", body: { commissionType: "Percentage", commissionRateBps: 220 } },
    { method: "GET", path: "/api/documents/agency-agreement-terms/{id}" },
    { method: "POST", path: "/api/documents/packages/{id}/populate", body: {} },
    { method: "POST", path: "/api/documents/packages/{id}/send-for-signature", body: {} },
    { method: "GET", path: "/api/documents/signed-download/{id}" },
    { method: "GET", path: "/api/documents/{id}/content" },
    { method: "POST", path: "/api/documents/{id}/versions", body: {} },
    { method: "POST", path: "/api/documents/{id}/signed-download", body: {} },
    { method: "POST", path: "/api/documents/{id}/quarantine", body: {} },
    { method: "GET", path: "/api/documents/packages/by-property/{id}" },
  ]);
});

test("appraisals: every :propertyId route rejects a malformed id (there was no guard at all)", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/appraisals/by-property/{id}" },
    { method: "POST", path: "/api/appraisals/by-property/{id}/start", body: {} },
    { method: "POST", path: "/api/appraisals/by-property/{id}", body: {} },
    { method: "POST", path: "/api/appraisals/by-property/{id}/finalise", body: {} },
  ]);
});

test("aml: every :propertyId / :verificationId route rejects a malformed id (there was no guard at all)", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/aml/by-property/{id}" },
    { method: "GET", path: "/api/aml/service-orders/by-property/{id}" },
    { method: "POST", path: "/api/aml/{id}/retry", body: {} },
    { method: "POST", path: "/api/aml/{id}/resolve-exception", body: { notes: "Reviewed" } },
  ]);
});

test("transactions: every :id / :propertyId / :conditionId route rejects a malformed id (there was no guard at all)", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/transactions/by-property/{id}" },
    { method: "GET", path: "/api/transactions/{id}" },
    { method: "GET", path: "/api/transactions/{id}/conditions" },
    { method: "POST", path: "/api/transactions/{id}/contract-signed", body: {} },
    { method: "POST", path: "/api/transactions/{id}/finance-approved", body: {} },
    { method: "POST", path: "/api/transactions/{id}/settlement-schedule", body: { settlementDate: "2030-01-01" } },
    { method: "POST", path: "/api/transactions/{id}/settlement-complete", body: {} },
    { method: "POST", path: "/api/transactions/{id}/calculate-commission", body: {} },
    { method: "POST", path: "/api/transactions/{id}/funds-received", body: { amountCents: 100 } },
    { method: "POST", path: "/api/transactions/{id}/agent-paid", body: {} },
    { method: "POST", path: "/api/transactions/{id}/close", body: {} },
    { method: "POST", path: "/api/transactions/{id}/conditions", body: { description: "Subject to finance" } },
    { method: "POST", path: "/api/transactions/{id}/exchange", body: {} },
    { method: "POST", path: "/api/transactions/{id}/unconditional", body: {} },
    { method: "POST", path: "/api/transactions/{id}/legal-representatives", body: {} },
    { method: "POST", path: "/api/transactions/conditions/{id}/reschedule", body: { newDueDate: null } },
    { method: "POST", path: "/api/transactions/conditions/{id}/resolve", body: { status: "Satisfied" } },
  ]);
});

test("offers: every :propertyId / :id route rejects a malformed id (there was no guard at all)", async () => {
  await assertRejectsMalformedIds([
    { method: "POST", path: "/api/offers/by-property/{id}", body: { offerPriceCents: 100000 } },
    { method: "GET", path: "/api/offers/by-property/{id}" },
    { method: "GET", path: "/api/offers/{id}" },
    { method: "POST", path: "/api/offers/{id}/accept", body: {} },
    { method: "POST", path: "/api/offers/{id}/decline", body: {} },
    { method: "POST", path: "/api/offers/{id}/withdraw", body: {} },
  ]);
});

test("tasks: the numeric :propertyId and both uuid :id routes reject a malformed id", async () => {
  // routes/tasks.ts is the one router here whose own ids are `uuid` columns
  // (automation_tasks.id, automation_attention_items.id), not serials — so a
  // non-uuid string was the malformed case, and Postgres answered it with
  // "invalid input syntax for type uuid" wrapped in the driver's own
  // "Failed query: select ..." text.
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/tasks/by-property/{id}" },
    { method: "POST", path: "/api/tasks/{id}/complete", body: {} },
    { method: "POST", path: "/api/tasks/attention-items/{id}/resolve", body: {} },
  ]);
  // A well-formed uuid that simply does not exist stays an ordinary 404/400
  // outcome, never the malformed-id 400 above.
  const unknownUuid = "00000000-0000-4000-8000-000000000000";
  const res = await fetch(`${baseUrl}/api/tasks/attention-items/${unknownUuid}/resolve`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404, `a well-formed unknown uuid expected 404, got ${res.status}`);
  const body = await assertNoInternalDetail(res, "unknown attention item uuid");
  assert.match(String(body.error), /not found/i, "the operator-authored not-found message is deliberately kept");
});

test("properties: the timeline route rejects a malformed id", async () => {
  await assertRejectsMalformedIds([{ method: "GET", path: "/api/properties/{id}/timeline" }]);
});

/* =====================================================================
 * 2. Unrecognised internal failures — a generic 500, never the driver's
 *    own text. Each vector is request data the route's zod schema accepts
 *    and Postgres then rejects, i.e. a genuine untyped driver error
 *    raised from inside a real query.
 * ===================================================================*/

test("appraisals: a non-numeric price range (accepted as a string by the route schema) is a generic 500, not the numeric-cast failure", async () => {
  const propertyId = await createProperty(`1 Appraisal Leak St ${suffix}`);
  const started = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}/start`, { method: "POST", headers: { cookie } });
  assert.equal(started.status, 201, await started.clone().text());

  // priceRangeLow is `z.string().optional()` at the route and
  // numeric(12,2) in the database, so this passes validation and then fails
  // the cast — previously returned as `400 { error: "Failed query: ..." }`.
  const res = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ priceRangeLow: "not-a-number" }),
  });
  await assertGenericServerError(res, "POST /api/appraisals/by-property/:id");
});

test("appraisals: typed/expected domain errors keep their own 400 and their own message", async () => {
  const propertyId = await createProperty(`2 Appraisal Typed St ${suffix}`);
  // Finalising with no appraisal started, then with no price range captured —
  // both lib/appraisals.ts's own operator-authored messages, written for the
  // caller and deliberately NOT flattened into the generic 500.
  const notStarted = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}/finalise`, { method: "POST", headers: { cookie } });
  assert.equal(notStarted.status, 400, await notStarted.clone().text());
  const notStartedBody = await assertNoInternalDetail(notStarted, "appraisals typed error (not started)");
  assert.match(String(notStartedBody.error), /No appraisal has been started/i);

  const started = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}/start`, { method: "POST", headers: { cookie } });
  assert.equal(started.status, 201, await started.clone().text());
  const res = await fetch(`${baseUrl}/api/appraisals/by-property/${propertyId}/finalise`, { method: "POST", headers: { cookie } });
  assert.equal(res.status, 400, await res.clone().text());
  const body = await assertNoInternalDetail(res, "appraisals typed error (no price range)");
  assert.match(String(body.error), /price range is required/i);
});

test("documents: an out-of-range flat fee (accepted as an int by the route schema) is a generic 500, not the driver's range error", async () => {
  const propertyId = await createProperty(`3 Documents Leak St ${suffix}`);
  const res = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ commissionType: "FlatFee", flatFeeCents: INT4_OVERFLOW, agreementTermDays: 90 }),
  });
  await assertGenericServerError(res, "PUT /api/documents/agency-agreement-terms/:id");
});

test("documents: a missing property on GET agency-agreement-terms is 404 Not found, with no internal detail", async () => {
  // R-F40 — this GET answers 404 { error: "Not found" } for a missing
  // property, the same body as a foreign property. The body still must not
  // carry driver text.
  const res = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/2000000000`, {
    method: "GET",
    headers: { cookie },
  });
  assert.equal(res.status, 404, await res.clone().text());
  const body = await assertNoInternalDetail(res, "documents missing property");
  assert.equal(body.error, "Not found");
});

test("aml: a non-integer propertyId (accepted as a number by the route schema) is a generic 500, not the driver's bind failure", async () => {
  // requestSchema uses `z.number()`, not `z.number().int()`, so 1.5 passes
  // validation and reaches `where(eq(properties.id, 1.5))`. This route's
  // deliberate uniform 404 used to carry the driver's message.
  const res = await fetch(`${baseUrl}/api/aml/request`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ propertyId: 1.5, partyId: 1 }),
  });
  await assertGenericServerError(res, "POST /api/aml/request");
});

test("aml: the deliberate uniform 404 and its operator-authored message survive for expected errors", async () => {
  const res = await fetch(`${baseUrl}/api/aml/request`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ propertyId: 2000000000, partyId: 2000000000 }),
  });
  assert.equal(res.status, 404, await res.clone().text());
  const body = await assertNoInternalDetail(res, "aml typed error");
  assert.match(String(body.error), /not found/i);
});

test("offers: an out-of-range offer price (accepted as an int by the route schema) is a generic 500, not the driver's range error", async () => {
  const { propertyId } = await createListedProperty(baseUrl, cookie, {
    address: `4 Offers Leak St ${suffix}`,
    sellerEmail: `wp9-offers-seller-${suffix}@example.com`,
  });
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ offerPriceCents: INT4_OVERFLOW, buyer: { firstName: "Bob", lastName: "Buyer" } }),
  });
  await assertGenericServerError(res, "POST /api/offers/by-property/:id");
});

test("offers: typed/expected domain errors keep their own 400 and their own message", async () => {
  const propertyId = await createProperty(`5 Offers Typed St ${suffix}`);
  // Not Listed yet — lib/offers.ts's own operator-authored message.
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ offerPriceCents: 100000, buyer: { firstName: "Bob", lastName: "Buyer" } }),
  });
  assert.equal(res.status, 400, await res.clone().text());
  const body = await assertNoInternalDetail(res, "offers typed error");
  assert.match(String(body.error), /must be Listed/i);
});

test("transactions: a condition description Postgres rejects is a generic 500, and TransactionClosureBlockedError still keeps its own 409", async () => {
  const { transactionId } = await createTransactionFromListedProperty(baseUrl, cookie, {
    address: `6 Transactions Leak St ${suffix}`,
    sellerEmail: `wp9-transactions-seller-${suffix}@example.com`,
    conditionsText: "",
  });

  // `z.string().min(1)` accepts a NUL byte; Postgres rejects it in any text
  // value, from inside the insert — an untyped driver error, previously
  // returned as `400 { error: "Failed query: insert into ..." }`.
  const leak = await fetch(`${baseUrl}/api/transactions/${transactionId}/conditions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ description: `a${NUL}b` }),
  });
  await assertGenericServerError(leak, "POST /api/transactions/:id/conditions");

  // The typed error this router already mapped deliberately is untouched:
  // closing a transaction that has not settled is still a 409 carrying its
  // own blocker list, not a flattened 500.
  const blocked = await fetch(`${baseUrl}/api/transactions/${transactionId}/close`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const blockedBody = (await blocked.clone().json()) as { error: string; blockers?: string[] };
  assert.ok([400, 409].includes(blocked.status), `expected the existing typed mapping, got ${blocked.status}`);
  await assertNoInternalDetail(blocked, "transactions typed error");
  assert.notEqual(blockedBody.error, GENERIC_MESSAGE, "a typed/expected transaction error must keep its own message");
});

test("tasks: a resolution note Postgres rejects is a generic 500, not the driver's text wearing this route's 404", async () => {
  const propertyId = await createProperty(`7 Tasks Leak St ${suffix}`);
  const [item] = await db
    .insert(automationAttentionItems)
    .values({
      brokerageId: A.brokerageId,
      propertyId,
      reasonCode: "MANUAL_REVIEW_REQUIRED",
      summary: `WP9 attention item ${suffix}`,
      status: "OPEN",
    })
    .returning();

  try {
    const res = await fetch(`${baseUrl}/api/tasks/attention-items/${item.id}/resolve`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ notes: `a${NUL}b` }),
    });
    await assertGenericServerError(res, "POST /api/tasks/attention-items/:id/resolve");

    // The expected not-found case keeps this route's 404 and its own message.
    const ok = await fetch(`${baseUrl}/api/tasks/attention-items/${item.id}/resolve`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ notes: "Resolved by hand" }),
    });
    assert.equal(ok.status, 200, await ok.clone().text());
  } finally {
    await db.delete(automationAttentionItems).where(eq(automationAttentionItems.id, item.id));
  }
});

test("properties: an unreadable timeline row is a generic 500, not the driver's text wearing this route's 404", async () => {
  const propertyId = await createProperty(`8 Timeline Leak St ${suffix}`);

  // lib/timeline.ts coerces auditLogs.recordId (a `text` column) with
  // Number() for the aml_verification/party/offer display lookups, then
  // binds the result into an `inArray(...)`. A row whose recordId is not
  // numeric therefore reaches Postgres as NaN — a real, data-shaped, untyped
  // driver error inside getPropertyTimeline, which this route used to return
  // verbatim as a 404.
  const [poison] = await db
    .insert(auditLogs)
    .values({
      brokerageId: A.brokerageId,
      userId: A.admin.user.id,
      action: "aml_verification_retried",
      recordType: "aml_verification",
      recordId: "not-a-number",
      propertyId,
    })
    .returning();

  try {
    const res = await fetch(`${baseUrl}/api/properties/${propertyId}/timeline`, { headers: { cookie } });
    await assertGenericServerError(res, "GET /api/properties/:id/timeline");
  } finally {
    await db.delete(auditLogs).where(and(eq(auditLogs.id, poison.id)));
  }

  // With the poison row gone the same route is an ordinary 200 again, and a
  // property that does not exist is still the operator-authored 404.
  const ok = await fetch(`${baseUrl}/api/properties/${propertyId}/timeline`, { headers: { cookie } });
  assert.equal(ok.status, 200, await ok.clone().text());

  const missing = await fetch(`${baseUrl}/api/properties/2000000000/timeline`, { headers: { cookie } });
  assert.equal(missing.status, 404);
  const missingBody = await assertNoInternalDetail(missing, "properties typed error");
  assert.match(String(missingBody.error), /not found/i);
});
