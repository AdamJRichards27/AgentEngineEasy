// #34 slice 3 — read-only buyer list (Buyer Engagement start):
// GET /api/offers/buyers lists property_parties rows with role "Buyer"
// across the caller's brokerage, joined to parties and properties (both
// brokerage-scoped). Names only: no email, mobile, residential address, or
// entity details. requireAuth + run.access. A propertyId filter naming
// another brokerage's property is 404 and increments
// tenant_isolation_rejection_total{boundary="transaction"} once (same rule
// as the offer routes). No writes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, parties, propertyParties } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, createListedProperty, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

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
let p1: number;
let p2: number;
let bProperty: number;
let bPartyId: number;

interface BuyerRow {
  linkId: number;
  partyId: number;
  buyerName: string | null;
  propertyId: number;
  propertyAddress: string;
  linkedAt: string;
  [key: string]: unknown;
}
interface BuyerBody { buyers: BuyerRow[]; total: number; limit: number; offset: number }

const get = (path: string, cookie: string) => fetch(`${baseUrl}/api${path}`, { headers: { cookie } });

async function createOffer(cookie: string, propertyId: number, firstName: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ offerPriceCents: 50_000_000, buyer: { firstName, lastName: "Buyer", email: `${firstName.toLowerCase()}-bl-${suffix}@example.com`, mobile: "0411111111" } }),
  });
  if (res.status !== 201) throw new Error(`create offer failed: ${res.status} ${await res.text()}`);
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

function isolationSeries(): string[] {
  return renderMetricsText().split("\n").filter((l) => l.startsWith("tenant_isolation_rejection_total{"));
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

  A = await createBrokerageWithUsers(baseUrl, `Buyer List A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Buyer List B ${suffix}`);
  p1 = (await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Buyer St`, sellerEmail: `seller-bl1-${suffix}@example.com` })).propertyId;
  p2 = (await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Second St`, sellerEmail: `seller-bl2-${suffix}@example.com` })).propertyId;
  await createOffer(A.agent.cookie, p1, "Amy");
  await createOffer(A.agent.cookie, p1, "Ben");
  await createOffer(A.agent.cookie, p2, "Cat");
  bProperty = (await createListedProperty(baseUrl, B.agent.cookie, { address: `${suffix} Other Rd`, sellerEmail: `seller-blb-${suffix}@example.com` })).propertyId;
  await createOffer(B.agent.cookie, bProperty, "Zed");
  // A mis-link: B's buyer party attached to A's property. Its name must never reach A.
  const [zed] = await db.select({ id: parties.id }).from(parties).where(and(eq(parties.brokerageId, B.brokerageId), eq(parties.firstName, "Zed")));
  bPartyId = zed.id;
  await db.insert(propertyParties).values({ propertyId: p1, partyId: bPartyId, role: "Buyer" });
});

after(async () => {
  await db.delete(propertyParties).where(and(eq(propertyParties.propertyId, p1), eq(propertyParties.partyId, bPartyId)));
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("lists Buyer links across the caller's brokerage, newest first, sellers excluded", async () => {
  const res = await get("/offers/buyers", A.agent.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as BuyerBody;
  assert.deepEqual(body.buyers.map((b) => b.buyerName), ["Cat Buyer", "Ben Buyer", "Amy Buyer"]);
  assert.equal(body.total, 3);
  const cat = body.buyers[0];
  assert.equal(cat.propertyId, p2);
  assert.ok(cat.propertyAddress.includes("Second St"));
  assert.ok(!Number.isNaN(Date.parse(cat.linkedAt)));
});

test("names only: no email, mobile, address, or entity fields", async () => {
  const raw = await (await get("/offers/buyers", A.admin.cookie)).text();
  assert.equal(/@example\.com|0411111111|"email"|"mobile"|residentialAddress|entityDetails|shareToken/i.test(raw), false);
  const body = JSON.parse(raw) as BuyerBody;
  assert.deepEqual(Object.keys(body.buyers[0]).sort(), ["buyerName", "linkId", "linkedAt", "partyId", "propertyAddress", "propertyId"]);
});

test("tenant isolation: B sees only its own buyer, and A never sees B's mis-linked party", async () => {
  const bBody = (await (await get("/offers/buyers", B.agent.cookie)).json()) as BuyerBody;
  assert.deepEqual(bBody.buyers.map((b) => b.buyerName), ["Zed Buyer"]);
  const aRaw = await (await get("/offers/buyers", A.agent.cookie)).text();
  assert.equal(aRaw.includes("Zed"), false);
});

test("propertyId filter and paging", async () => {
  const f = (await (await get(`/offers/buyers?propertyId=${p1}`, A.agent.cookie)).json()) as BuyerBody;
  assert.deepEqual(f.buyers.map((b) => b.buyerName), ["Ben Buyer", "Amy Buyer"]);
  const pg = (await (await get("/offers/buyers?limit=1&offset=1", A.agent.cookie)).json()) as BuyerBody;
  assert.deepEqual(pg.buyers.map((b) => b.buyerName), ["Ben Buyer"]);
  assert.equal(pg.total, 3);
  assert.equal(pg.limit, 1);
  assert.equal(pg.offset, 1);
});

test("invalid query values are 400", async () => {
  for (const q of ["limit=0", "limit=201", "offset=-1", "propertyId=abc", "propertyId=2147483648"]) {
    assert.equal((await get(`/offers/buyers?${q}`, A.agent.cookie)).status, 400, q);
  }
});

test("cross-brokerage propertyId is 404 and increments the metric once; missing id does not", async () => {
  resetMetricsForTesting();
  const res = await get(`/offers/buyers?propertyId=${bProperty}`, A.agent.cookie);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
  assert.deepEqual(isolationSeries(), ['tenant_isolation_rejection_total{boundary="transaction"} 1']);
  resetMetricsForTesting();
  assert.equal((await get("/offers/buyers?propertyId=2147483646", A.agent.cookie)).status, 404);
  assert.deepEqual(isolationSeries(), []);
});

test("requires authentication and run.access", async () => {
  assert.equal((await fetch(`${baseUrl}/api/offers/buyers`)).status, 401);
  await setRunAccess(A.brokerageId, false);
  try {
    const res = await get("/offers/buyers", A.agent.cookie);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string; entitlementKey?: string };
    assert.equal(body.error, "Not entitled");
    assert.equal(body.entitlementKey, "run.access");
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
  assert.equal((await get("/offers/buyers", A.agent.cookie)).status, 200);
});
