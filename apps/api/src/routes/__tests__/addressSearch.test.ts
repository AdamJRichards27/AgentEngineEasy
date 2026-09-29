// UAT-T1 — GET /properties/address-search under the default mock provider.
// PROPERTY_DATA_PROVIDER is unset, so createPropertyDataProvider() builds
// MockPropertyDataProvider. Start Property withholds queries shorter than
// 3 characters (apps/web/src/pages/StartProperty.tsx). This route does not:
// an empty q is 400, and any other non-blank q is searched.
//
// The route does not read or write property rows. A user from another
// brokerage can call it and still cannot see or create the target
// brokerage's property. Cross-brokerage POST /parties is already locked
// elsewhere and is not repeated in this file:
// - apps/api/src/routes/__tests__/parties.test.ts
//   "POST /: brokerage B cannot link a party to brokerage A's property"
// - apps/api/src/routes/__tests__/runPropertyPartyIsolationRejection.test.ts
//   "linking a party to a property in another brokerage is still 404 and increments once"
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, properties } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

delete process.env.PROPERTY_DATA_PROVIDER;

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

async function propertyIds(brokerageId: number): Promise<number[]> {
  const rows = await db.select({ id: properties.id }).from(properties).where(eq(properties.brokerageId, brokerageId));
  return rows.map((row) => row.id);
}

before(async () => {
  assert.equal(process.env.PROPERTY_DATA_PROVIDER, undefined);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `UAT Address A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `UAT Address B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("UAT-T1 address search", { concurrency: 1 }, () => {
  test("auth is required", async () => {
    const res = await fetch(`${baseUrl}/api/properties/address-search?q=12%20Harbour%20Street`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), { error: "Not authenticated" });
  });

  test("a normal query returns the mock candidate and writes nothing", async () => {
    const query = "12 Harbour Street, Sydney NSW";
    const before = await propertyIds(A.brokerageId);
    const res = await fetch(`${baseUrl}/api/properties/address-search?q=${encodeURIComponent(query)}`, {
      headers: { cookie: A.agent.cookie },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), {
      candidates: [{ placeId: `mock-${encodeURIComponent(query)}`, formattedAddress: query }],
    });
    assert.deepEqual(await propertyIds(A.brokerageId), before);
  });

  test("an empty query is rejected and a short or blank query follows the current route", async () => {
    const missing = await fetch(`${baseUrl}/api/properties/address-search`, { headers: { cookie: A.agent.cookie } });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "q is required" });

    const empty = await fetch(`${baseUrl}/api/properties/address-search?q=`, { headers: { cookie: A.agent.cookie } });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "q is required" });

    const blank = await fetch(`${baseUrl}/api/properties/address-search?q=${encodeURIComponent("   ")}`, {
      headers: { cookie: A.agent.cookie },
    });
    assert.equal(blank.status, 200);
    assert.deepEqual(await blank.json(), { candidates: [] });

    const shortQuery = "ab";
    const short = await fetch(`${baseUrl}/api/properties/address-search?q=${encodeURIComponent(shortQuery)}`, {
      headers: { cookie: A.agent.cookie },
    });
    assert.equal(short.status, 200);
    assert.deepEqual(await short.json(), {
      candidates: [{ placeId: `mock-${encodeURIComponent(shortQuery)}`, formattedAddress: shortQuery }],
    });
  });

  test("a user from another brokerage cannot read or write the target property", async () => {
    const address = `${suffix} Private Lane`;
    const created = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { cookie: A.agent.cookie, "content-type": "application/json" },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { property: { id: number; brokerageId: number } };
    const propertyId = createdBody.property.id;
    const beforeA = await propertyIds(A.brokerageId);
    const beforeB = await propertyIds(B.brokerageId);

    const res = await fetch(`${baseUrl}/api/properties/address-search?q=${encodeURIComponent(address)}`, {
      headers: { cookie: B.agent.cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { candidates: Array<Record<string, unknown>> };
    assert.deepEqual(body, {
      candidates: [{ placeId: `mock-${encodeURIComponent(address)}`, formattedAddress: address }],
    });
    for (const candidate of body.candidates) {
      assert.equal("id" in candidate, false);
      assert.equal("propertyId" in candidate, false);
      assert.equal("brokerageId" in candidate, false);
    }

    assert.deepEqual(await propertyIds(A.brokerageId), beforeA);
    assert.deepEqual(await propertyIds(B.brokerageId), beforeB);
    const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
    assert.equal(row?.formattedAddress, address);
    assert.equal(row?.brokerageId, A.brokerageId);
  });
});
