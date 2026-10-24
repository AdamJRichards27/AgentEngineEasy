// #34 / Owner t162u ("do not expose confidential offer details to unauthorised users"):
// GET /api/offers/centre and GET /api/offers/buyers carry offer prices, conditions and
// buyer names, so they use the same role gate as the buyer engagement timeline:
// Agents and Brokerage Administrators only. Pit Crew is 403 (no body data) until the
// Owner decides Pit Crew buyer access (BE-Q3 / D2d). A propertyId from another
// brokerage stays 404, identical to a missing one. Read-only; no writes beyond fixtures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

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
let pitCrew: DevLoginResult;
let aPropertyId: number;
let bPropertyId: number;
const PRICE = 81_234_567;

async function get(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `OC Role A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `OC Role B ${suffix}`);
  pitCrew = await devLogin(baseUrl, { email: `pitcrew-ocrole-${suffix}@example.com`, firstName: "Pat", lastName: "Crew", brokerageName: `OC Role A ${suffix}` });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  assert.equal(pitCrew.user.brokerageId, A.brokerageId, "Pit Crew user is in brokerage A");

  aPropertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Role Gate St`, sellerEmail: `seller-ocrole-${suffix}@example.com` })).propertyId;
  bPropertyId = (await createListedProperty(baseUrl, B.agent.cookie, { address: `${suffix} Other Gate St`, sellerEmail: `seller-ocrole-b-${suffix}@example.com` })).propertyId;
  const res = await fetch(`${baseUrl}/api/offers/by-property/${aPropertyId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ offerPriceCents: PRICE, buyer: { firstName: "Gia", lastName: "Gate", email: `gia-${suffix}@example.com`, mobile: "0400000001" } }),
  });
  assert.equal(res.status, 201, await res.text());
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

for (const path of ["/offers/centre", "/offers/buyers"]) {
  test(`${path}: Pit Crew gets 403 with no offer or buyer data, with and without a propertyId`, async () => {
    for (const q of ["", `?propertyId=${aPropertyId}`]) {
      const res = await get(`${path}${q}`, pitCrew.cookie);
      assert.equal(res.status, 403);
      const text = await res.text();
      assert.deepEqual(JSON.parse(text), { error: "Forbidden" });
      assert.ok(!text.includes(String(PRICE)) && !text.includes("Gia"), "no confidential data in the 403 body");
    }
  });

  test(`${path}: Agent and Brokerage Administrator of the same brokerage get 200 with their data`, async () => {
    for (const who of [A.agent, A.admin]) {
      const res = await get(`${path}?propertyId=${aPropertyId}`, who.cookie);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("Gia"), "the buyer is listed");
      if (path === "/offers/centre") assert.ok(text.includes(String(PRICE)), "the offer is listed");
    }
  });

  test(`${path}: another brokerage's propertyId is 404 for Agent and Admin, same as a missing id; Pit Crew is refused first (403)`, async () => {
    for (const who of [A.agent, A.admin]) {
      const foreign = await get(`${path}?propertyId=${bPropertyId}`, who.cookie);
      assert.equal(foreign.status, 404);
      assert.deepEqual(await foreign.json(), { error: "Not found" });
      const missing = await get(`${path}?propertyId=2147483000`, who.cookie);
      assert.equal(missing.status, 404);
    }
    const pcForeign = await get(`${path}?propertyId=${bPropertyId}`, pitCrew.cookie);
    assert.equal(pcForeign.status, 403);
  });

  test(`${path}: brokerage B's agent never sees brokerage A's offer or buyer`, async () => {
    const res = await get(path, B.agent.cookie);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes("Gia") && !text.includes(String(PRICE)));
  });
}
