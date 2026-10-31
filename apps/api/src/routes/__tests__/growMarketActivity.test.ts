import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, entitlementGrants, properties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

// CC #26 / SPEC-02: GET /grow/market-activity — flag gate, brokerage isolation,
// internal sources only, no outbound network calls.

let server: Server;
let baseUrl: string;
const suffix = Date.now();
type B = { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let A: B;
let OTHER: B;
const cleanupIds: number[] = [];
const prev = process.env.GROW_MARKET_ACTIVITY_ENABLED;
const realFetch = globalThis.fetch;
const outbound: string[] = [];

async function grant(brokerageId: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId, entitlementKey: key, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(brokerageId);
}
async function property(cookie: string, label: string, suburb: string): Promise<number> {
  const res = await realFetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: `${label} ${suffix}`, state: "QLD", suburb, postcode: "4000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  A = await createBrokerageWithUsers(baseUrl, `MA A ${suffix}`);
  OTHER = await createBrokerageWithUsers(baseUrl, `MA Other ${suffix}`);
  cleanupIds.push(A.brokerageId, OTHER.brokerageId);
  await grant(A.brokerageId, "grow.access");
  await grant(OTHER.brokerageId, "grow.access");
  const day = 86_400_000;
  const listed = await property(A.agent.cookie, "1 Listed St", "Paddington");
  await db.update(properties).set({ listingStatus: "Listed", campaignStartDate: new Date(Date.now() - 2 * day) }).where(eq(properties.id, listed));
  const sold = await property(A.agent.cookie, "2 Sold St", "Ashgrove");
  await db.update(properties).set({ listingStatus: "Sold", campaignStartDate: new Date(Date.now() - 60 * day), campaignEndDate: new Date(Date.now() - 3 * day) }).where(eq(properties.id, sold));
  const old = await property(A.agent.cookie, "3 Old St", "Paddington");
  await db.update(properties).set({ listingStatus: "Listed", campaignStartDate: new Date(Date.now() - 90 * day) }).where(eq(properties.id, old));
  const foreign = await property(OTHER.agent.cookie, "9 Foreign St", "Paddington");
  await db.update(properties).set({ listingStatus: "Listed", campaignStartDate: new Date(Date.now() - 1 * day) }).where(eq(properties.id, foreign));
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(baseUrl)) outbound.push(url);
    return realFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  if (prev === undefined) delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  else process.env.GROW_MARKET_ACTIVITY_ENABLED = prev;
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

const get = (cookie: string, q = "") => fetch(`${baseUrl}/api/grow/market-activity${q}`, { headers: { cookie } });
type Body = { counts: Record<string, number>; events: { type: string; address: string; sourceLabel: string; suburb: string | null }[]; providers: string };

test("flag OFF: 404", async () => {
  delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  assert.equal((await get(A.agent.cookie)).status, 404);
});

test("own-brokerage internal events only, labelled, in range; no outbound calls", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  outbound.length = 0;
  const res = await get(A.agent.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Body;
  assert.equal(body.providers, "none");
  assert.equal(body.counts.justListed, 1);
  assert.equal(body.counts.sold, 1);
  assert.ok(body.events.every((e) => e.sourceLabel === "AE property record" || e.sourceLabel === "Agent-entered comparable"));
  assert.ok(!body.events.some((e) => e.address.includes("Foreign")), "other brokerage must not appear");
  assert.ok(!body.events.some((e) => e.address.includes("Old St")), "out-of-range must not appear");
  assert.deepEqual(outbound, []);
});

test("suburb and type filters; 30d range; bad range 400; no grow.access 403", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const pad = (await (await get(A.agent.cookie, "?suburbs=paddington")).json()) as Body;
  assert.deepEqual(pad.events.map((e) => e.type), ["justListed"]);
  const soldOnly = (await (await get(A.agent.cookie, "?types=sold&range=30d")).json()) as Body;
  assert.deepEqual(soldOnly.events.map((e) => e.type), ["sold"]);
  assert.equal((await get(A.agent.cookie, "?range=year")).status, 400);
  const NOG = await createBrokerageWithUsers(baseUrl, `MA NoGrow ${suffix}`);
  cleanupIds.push(NOG.brokerageId);
  assert.equal((await get(NOG.agent.cookie)).status, 403);
});

test("other brokerage sees only its own event", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const body = (await (await get(OTHER.agent.cookie)).json()) as Body;
  assert.equal(body.events.length, 1);
  assert.ok(body.events[0].address.includes("Foreign"));
});
