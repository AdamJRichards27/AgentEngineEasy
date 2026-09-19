// AE GROW Pilot Readiness WP6a (D1-residual) — a malformed route id must be a
// 400, not a 500.
//
// The P0 crash fix stopped the process dying on these requests, which left the
// residual defect visible: a non-numeric (or out-of-range) :id was still
// handed straight to Drizzle/Postgres as a bind value, so a mistyped URL
// produced a server error with a database diagnostic in the log instead of the
// ordinary client error it is. Real HTTP against the real app, through the
// real session cookie, for every route the live smoke run flagged plus the
// rest of the same pattern in the routers this work package owns.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { db, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let cookie: string;
let realPropertyId: number;

const suffix = Date.now();

/**
 * Every shape a route id can be malformed in. "abc" is what the smoke run
 * used; 0 / -1 / 1.5 are the classic off-by-type values; the last two are the
 * ones a naive `Number.isInteger` guard still lets through — they ARE
 * integers, they are simply far outside the int4 range every `serial` primary
 * key in this schema uses, so they reached Postgres as an unbindable value and
 * produced exactly the same 500.
 */
const MALFORMED_IDS = ["abc", "0", "-1", "1.5", "99999999999999999999", "2147483648"];

/** The first id past int4's ceiling, and therefore the boundary of the guard. */
const FIRST_OUT_OF_RANGE_ID = "2147483648";
const LAST_IN_RANGE_ID = "2147483647";

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

  A = await createBrokerageWithUsers(baseUrl, `WP6a IdValidation ${suffix}`);
  cookie = A.admin.cookie;

  for (const key of [
    "grow.access",
    "grow.opportunities.manage",
    "grow.relationships.manage",
    "grow.contacts.read",
    "grow.contacts.manage",
  ]) {
    await db.insert(entitlementGrants).values({
      brokerageId: A.brokerageId,
      entitlementKey: key,
      granteeType: "brokerage",
      granteeId: A.brokerageId,
      sourceType: "manual",
      status: "Active",
    });
  }
  invalidateEntitlementCache(A.brokerageId);

  const created = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: `1 Id Validation St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(created.status, 201);
  realPropertyId = ((await created.json()) as { property: { id: number } }).property.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

interface RouteUnderTest {
  method: "GET" | "POST" | "PATCH";
  /** Path with {id} standing in for the parameter under test. */
  path: string;
  body?: unknown;
}

async function call(route: RouteUnderTest, id: string): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  if (route.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${route.path.replace("{id}", id)}`, {
    method: route.method,
    headers,
    body: route.body === undefined ? undefined : JSON.stringify(route.body),
  });
}

async function assertRejectsMalformedIds(routes: RouteUnderTest[]): Promise<void> {
  for (const route of routes) {
    for (const id of MALFORMED_IDS) {
      const res = await call(route, id);
      const label = `${route.method} ${route.path.replace("{id}", id)}`;
      assert.equal(res.status, 400, `${label} must answer 400, got ${res.status}: ${await res.clone().text()}`);
      const body = (await res.json()) as { error?: unknown };
      assert.equal(typeof body.error, "string", `${label} must use the existing { error } shape`);
    }
  }
}

// ---------------------------------------------------------------------
// The endpoints the live smoke run caught returning 500.
// ---------------------------------------------------------------------

test("smoke-run defects: the exact endpoints that returned 500 now return 400", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/communications/threads/{id}" },
    { method: "POST", path: "/api/communications/messages/{id}/approve", body: { expectedVersion: 1 } },
    { method: "POST", path: "/api/communications/messages/{id}/send", body: { expectedVersion: 1 } },
    { method: "POST", path: "/api/communications/messages/{id}/cancel", body: { expectedVersion: 1 } },
    { method: "GET", path: "/api/properties/{id}" },
    { method: "PATCH", path: "/api/grow/opportunities/{id}", body: { recommendedNextAction: "Call" } },
  ]);
});

// ---------------------------------------------------------------------
// The rest of the same pattern in the routers this work package owns — the
// smoke run only exercised a handful of them, but every one of these had the
// identical unguarded `Number(req.params...)`.
// ---------------------------------------------------------------------

test("communications: every remaining :id route rejects a malformed id", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/communications/messages/{id}" },
    { method: "POST", path: "/api/communications/messages/{id}/request-approval", body: { expectedVersion: 1 } },
    { method: "POST", path: "/api/communications/messages/{id}/requeue", body: { expectedVersion: 1 } },
    { method: "POST", path: "/api/communications/threads/{id}/participants", body: { partyId: 1 } },
    { method: "POST", path: "/api/communications/threads/{id}/participants/manual", body: { displayName: "X" } },
    { method: "POST", path: "/api/communications/threads/{id}/messages", body: { channel: "EMAIL" } },
    { method: "GET", path: "/api/properties/{id}/communications/threads" },
    { method: "POST", path: "/api/properties/{id}/communications/threads", body: { subject: "Hi" } },
    { method: "GET", path: "/api/properties/{id}/communications/recipients" },
    { method: "GET", path: "/api/grow/contacts/{id}/communications/threads" },
    { method: "POST", path: "/api/grow/contacts/{id}/communications/threads", body: { subject: "Hi" } },
    { method: "GET", path: "/api/grow/contacts/{id}/communications/recipients" },
    { method: "POST", path: "/api/communications/templates/{id}/versions", body: { bodyText: "x" } },
    { method: "POST", path: "/api/communications/templates/{id}/activate", body: {} },
    { method: "POST", path: "/api/communications/templates/{id}/archive", body: {} },
  ]);
});

test("properties: every :id route rejects a malformed id", async () => {
  await assertRejectsMalformedIds([
    { method: "GET", path: "/api/properties/{id}/workspace" },
    { method: "GET", path: "/api/properties/{id}/timeline" },
    { method: "POST", path: "/api/properties/{id}/ownership-review", body: {} },
    { method: "POST", path: "/api/properties/{id}/listing-details", body: {} },
    { method: "POST", path: "/api/properties/{id}/ready-to-list", body: {} },
    { method: "POST", path: "/api/properties/{id}/go-live", body: {} },
  ]);
});

test("grow: the relationship id guard covers out-of-range integers too", async () => {
  // PATCH /grow/relationships/:id already rejected "abc"; it did not reject an
  // id past int4, which produced the same 500 as an unguarded route.
  await assertRejectsMalformedIds([{ method: "PATCH", path: "/api/grow/relationships/{id}", body: { status: "Active" } }]);
});

// ---------------------------------------------------------------------
// Unchanged behaviour for well-formed ids: the guard must reject malformed
// input only, never turn a legitimate lookup into a 400.
// ---------------------------------------------------------------------

test("a well-formed but unknown id still resolves normally, never 400", async () => {
  const unknownButValid = String(2_000_000_000);
  const cases: Array<{ route: RouteUnderTest; expected: number[] }> = [
    { route: { method: "GET", path: "/api/properties/{id}" }, expected: [404] },
    { route: { method: "GET", path: "/api/properties/{id}/workspace" }, expected: [404] },
    { route: { method: "GET", path: "/api/communications/threads/{id}" }, expected: [404] },
    { route: { method: "GET", path: "/api/communications/messages/{id}" }, expected: [404] },
    { route: { method: "PATCH", path: "/api/grow/opportunities/{id}", body: { recommendedNextAction: "Call" } }, expected: [404] },
  ];
  for (const { route, expected } of cases) {
    const res = await call(route, unknownButValid);
    const label = `${route.method} ${route.path.replace("{id}", unknownButValid)}`;
    assert.ok(expected.includes(res.status), `${label} expected one of ${expected.join("/")}, got ${res.status}`);
  }

  // int4's largest value is in range by definition, and must not be rejected
  // as "too large" — it is only the value one past it that is out of range.
  const boundary = await call({ method: "GET", path: "/api/properties/{id}" }, LAST_IN_RANGE_ID);
  assert.equal(boundary.status, 404, "the int4 ceiling itself is a valid id");
  const pastBoundary = await call({ method: "GET", path: "/api/properties/{id}" }, FIRST_OUT_OF_RANGE_ID);
  assert.equal(pastBoundary.status, 400, "one past the int4 ceiling is not");
});

test("a real id still returns its resource", async () => {
  const res = await fetch(`${baseUrl}/api/properties/${realPropertyId}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { property: { id: number } };
  assert.equal(body.property.id, realPropertyId);

  const workspace = await fetch(`${baseUrl}/api/properties/${realPropertyId}/workspace`, { headers: { cookie } });
  assert.equal(workspace.status, 200);

  const threads = await fetch(`${baseUrl}/api/properties/${realPropertyId}/communications/threads`, { headers: { cookie } });
  assert.equal(threads.status, 200);
});
