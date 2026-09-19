// AE GROW Pilot Readiness WP1 (P2-4) — PATCH /grow/relationships/:id input
// validation: status must be a canonical growRelationships.status value
// (Active | Historical | PendingReview), role must be a bounded non-empty
// string, isPrimary a boolean, and a non-numeric id is a 400 — all rejected
// before any write. Same real-HTTP conventions as grow.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, growRelationships } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let relationshipId: number;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `WP1 Grow Rel Validation ${suffix}`);
  for (const key of ["grow.access", "grow.relationships.manage"]) {
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

  const propertyRes = await post("/properties", { formattedAddress: `1 Validation St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" });
  const propertyId = ((await propertyRes.json()) as { property: { id: number } }).property.id;
  const partyRes = await post("/parties", { propertyId, role: "Buyer", firstName: "Valid", lastName: "Ation" });
  const partyId = ((await partyRes.json()) as { party: { id: number } }).party.id;
  const relRes = await post("/grow/relationships", { partyId, propertyId, relationshipType: "owner", role: "Owner" });
  assert.equal(relRes.status, 201, await relRes.clone().text());
  relationshipId = ((await relRes.json()) as { relationship: { id: number } }).relationship.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function post(path: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify(body),
  });
}

function patch(id: number | string, body: unknown) {
  return fetch(`${baseUrl}/api/grow/relationships/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify(body),
  });
}

test("WP1 P2-4: PATCH /grow/relationships/:id rejects non-canonical status, unbounded/non-string role, non-boolean isPrimary and a non-numeric id with 400, without writing", async () => {
  for (const body of [
    { status: "Bogus" },
    { status: "active" },
    { status: 1 },
    { status: "" },
    { role: "x".repeat(201) },
    { role: 42 },
    { role: "   " },
    { isPrimary: "yes" },
  ]) {
    const res = await patch(relationshipId, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await patch("abc", { status: "Historical" })).status, 400);

  const [row] = await db.select().from(growRelationships).where(eq(growRelationships.id, relationshipId));
  assert.equal(row.status, "Active", "no rejected PATCH may have written anything");
  assert.equal(row.role, "Owner");
  assert.equal(row.isPrimary, false);
});

test("WP1 P2-4: PATCH /grow/relationships/:id still accepts every canonical status, a bounded role, and a boolean isPrimary", async () => {
  for (const status of ["PendingReview", "Historical", "Active"]) {
    const res = await patch(relationshipId, { status });
    assert.equal(res.status, 200, status);
    assert.equal(((await res.json()) as { relationship: { status: string } }).relationship.status, status);
  }
  const res = await patch(relationshipId, { role: "  Executor  ", isPrimary: true });
  assert.equal(res.status, 200);
  const { relationship } = (await res.json()) as { relationship: { role: string; isPrimary: boolean; status: string } };
  assert.equal(relationship.role, "Executor");
  assert.equal(relationship.isPrimary, true);
  assert.equal(relationship.status, "Active", "omitted status is unchanged");

  // role: null (like an omitted role) leaves the existing role unchanged, as before.
  const nullRole = await patch(relationshipId, { role: null });
  assert.equal(nullRole.status, 200);
  assert.equal(((await nullRole.json()) as { relationship: { role: string } }).relationship.role, "Executor");
});
