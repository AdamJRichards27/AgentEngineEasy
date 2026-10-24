// Owner t165u: "Offer prices: listing agent and authorised brokerage administrators only."
// GET /api/offers/centre and GET /api/offers/buyers: an Agent sees only properties they are the
// listing agent for (properties.agent_id); a propertyId for a colleague's listing is 404, the same
// as a missing one. Brokerage Administrators stay brokerage-wide. No migration: agent_id exists.
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
let colleague: DevLoginResult;
let listingPropertyId: number;
let colleaguePropertyId: number;
const PRICE = 71_234_561;
const COLLEAGUE_PRICE = 63_456_789;

async function get(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
}

async function recordOffer(cookie: string, propertyId: number, price: number, firstName: string) {
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ offerPriceCents: price, buyer: { firstName, lastName: "Policy", email: `${firstName.toLowerCase()}-${suffix}@example.com`, mobile: "0400000002" } }),
  });
  assert.equal(res.status, 201, await res.text());
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
  A = await createBrokerageWithUsers(baseUrl, `OC Price A ${suffix}`);
  colleague = await devLogin(baseUrl, { email: `colleague-ocprice-${suffix}@example.com`, firstName: "Cole", lastName: "League", brokerageName: `OC Price A ${suffix}` });
  await db.update(users).set({ role: "Agent" }).where(eq(users.id, colleague.user.id));
  assert.equal(colleague.user.brokerageId, A.brokerageId, "colleague is in brokerage A");

  listingPropertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Listing Agent St`, sellerEmail: `seller-ocprice-${suffix}@example.com` })).propertyId;
  colleaguePropertyId = (await createListedProperty(baseUrl, colleague.cookie, { address: `${suffix} Colleague St`, sellerEmail: `seller-ocprice-c-${suffix}@example.com` })).propertyId;
  await recordOffer(A.agent.cookie, listingPropertyId, PRICE, "Lia");
  await recordOffer(colleague.cookie, colleaguePropertyId, COLLEAGUE_PRICE, "Cai");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("/offers/centre: the listing agent sees their listing's offer price, not a colleague's", async () => {
  const res = await get("/offers/centre", A.agent.cookie);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes(String(PRICE)), "own listing's price is listed");
  assert.ok(!text.includes(String(COLLEAGUE_PRICE)) && !text.includes("Cai"), "colleague's offer is not listed");
  const body = JSON.parse(text) as { offers: Array<{ propertyId: number }>; total: number };
  assert.ok(body.offers.every((o) => o.propertyId === listingPropertyId));
  assert.equal(body.total, body.offers.length, "the total counts only visible rows");
});

test("/offers/centre: a brokerage administrator sees every listing's offer price", async () => {
  const res = await get("/offers/centre", A.admin.cookie);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes(String(PRICE)) && text.includes(String(COLLEAGUE_PRICE)));
});

for (const path of ["/offers/centre", "/offers/buyers"]) {
  test(`${path}: an Agent filtering on a colleague's listing gets 404 with no data`, async () => {
    const res = await get(`${path}?propertyId=${colleaguePropertyId}`, A.agent.cookie);
    assert.equal(res.status, 404);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "Not found" });
    assert.ok(!text.includes(String(COLLEAGUE_PRICE)) && !text.includes("Cai"));
  });

  test(`${path}: the listing agent and the administrator can filter on the listing`, async () => {
    for (const who of [A.agent, A.admin]) {
      const res = await get(`${path}?propertyId=${listingPropertyId}`, who.cookie);
      assert.equal(res.status, 200);
      assert.ok((await res.text()).includes("Lia"));
    }
  });
}

test("/offers/buyers: an Agent sees buyers on their own listings only; the administrator sees all", async () => {
  const agentText = await (await get("/offers/buyers", A.agent.cookie)).text();
  assert.ok(agentText.includes("Lia") && !agentText.includes("Cai"));
  const colleagueText = await (await get("/offers/buyers", colleague.cookie)).text();
  assert.ok(colleagueText.includes("Cai") && !colleagueText.includes("Lia"));
  const adminText = await (await get("/offers/buyers", A.admin.cookie)).text();
  assert.ok(adminText.includes("Lia") && adminText.includes("Cai"));
});
