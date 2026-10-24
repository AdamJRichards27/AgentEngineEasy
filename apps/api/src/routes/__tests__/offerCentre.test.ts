// #34 slice 1 — read-only Offer Centre: GET /api/offers/centre lists offers
// across the caller's brokerage's properties. requireAuth + run.access. Rows
// come only from properties whose brokerage_id is the caller's. Sorted by
// status (Received, Accepted, Declined, Withdrawn), then price descending,
// then id descending. Never returns shareToken or buyer contact details.
// A propertyId filter naming another brokerage's property is 404 and
// increments tenant_isolation_rejection_total{boundary="transaction"} once,
// the same rule the existing offer routes use. No writes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, offers } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
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

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let listedPropertyId: number;
let txnPropertyId: number;
let bPropertyId: number;
const aOfferIds: Record<string, number> = {};
let bOfferId: number;

interface CentreRow {
  id: number;
  propertyId: number;
  propertyAddress: string;
  buyerPartyId: number | null;
  buyerName: string | null;
  offerPriceCents: number;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}
interface CentreBody { offers: CentreRow[]; total: number; limit: number; offset: number }

async function get(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { cookie } });
}

async function createOffer(cookie: string, propertyId: number, price: number, firstName: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ offerPriceCents: price, buyer: { firstName, lastName: "Buyer", email: `${firstName.toLowerCase()}-${suffix}@example.com`, mobile: "0400000000" } }),
  });
  if (res.status !== 201) throw new Error(`create offer failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { offer: { id: number } }).offer.id;
}

async function setRunAccess(brokerageId: number, active: boolean): Promise<void> {
  await db
    .update(entitlementGrants)
    .set({ status: active ? "Active" : "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}

function isolationSeries(): Array<{ labels: string; value: number }> {
  return renderMetricsText()
    .split("\n")
    .filter((line) => line.startsWith("tenant_isolation_rejection_total{"))
    .map((line) => {
      const m = /^tenant_isolation_rejection_total\{(.+)\} (\d+)$/.exec(line);
      assert.ok(m, line);
      return { labels: m[1], value: Number(m[2]) };
    });
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

  A = await createBrokerageWithUsers(baseUrl, `Offer Centre A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Offer Centre B ${suffix}`);

  // A: one Listed property with five offers in mixed states.
  listedPropertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `${suffix} Centre St`, sellerEmail: `seller-oc-${suffix}@example.com` })).propertyId;
  aOfferIds.r500 = await createOffer(A.agent.cookie, listedPropertyId, 50_000_000, "Rae");
  aOfferIds.r900 = await createOffer(A.agent.cookie, listedPropertyId, 90_000_000, "Ned");
  aOfferIds.r700 = await createOffer(A.agent.cookie, listedPropertyId, 70_000_000, "Sam");
  aOfferIds.w950 = await createOffer(A.agent.cookie, listedPropertyId, 95_000_000, "Wil");
  aOfferIds.d990 = await createOffer(A.agent.cookie, listedPropertyId, 99_000_000, "Dee");
  await db.update(offers).set({ status: "Withdrawn" }).where(eq(offers.id, aOfferIds.w950));
  await db.update(offers).set({ status: "Declined" }).where(eq(offers.id, aOfferIds.d990));

  // A: a second property whose offer was accepted (creates a transaction).
  const txn = await createTransactionFromListedProperty(baseUrl, A.agent.cookie, {
    address: `${suffix} Accepted Rd`, sellerEmail: `seller-oc2-${suffix}@example.com`, offerPriceCents: 60_000_000,
  });
  txnPropertyId = txn.propertyId;
  aOfferIds.a600 = txn.offerId;

  // B: a property and offer that A must never see.
  bPropertyId = (await createListedProperty(baseUrl, B.agent.cookie, { address: `${suffix} Other Ave`, sellerEmail: `seller-ocb-${suffix}@example.com` })).propertyId;
  bOfferId = await createOffer(B.agent.cookie, bPropertyId, 123_000_000, "Bee");
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("lists every offer in the caller's brokerage, sorted by status then price desc", async () => {
  const res = await get("/offers/centre", A.agent.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as CentreBody;
  assert.deepEqual(
    body.offers.map((o) => o.id),
    [aOfferIds.r900, aOfferIds.r700, aOfferIds.r500, aOfferIds.a600, aOfferIds.d990, aOfferIds.w950],
  );
  assert.equal(body.total, 6);
  const first = body.offers[0];
  assert.equal(first.propertyId, listedPropertyId);
  assert.ok(first.propertyAddress.includes("Centre St"));
  assert.equal(first.buyerName, "Ned Buyer");
  assert.equal(first.status, "Received");
  assert.equal(first.offerPriceCents, 90_000_000);
});

test("never exposes share tokens or buyer contact details", async () => {
  const res = await get("/offers/centre", A.admin.cookie);
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.equal(/shareToken|share_token/i.test(raw), false, "no share token key");
  const tokens = (await db.select({ t: offers.shareToken }).from(offers).where(eq(offers.propertyId, listedPropertyId))).map((r) => r.t);
  for (const t of tokens) if (t) assert.equal(raw.includes(t), false, "no share token value");
  assert.equal(/@example\.com|0400000000|"email"|"mobile"/.test(raw), false, "no buyer contact details");
});

test("tenant isolation: brokerage B sees only its own offer and none of A's", async () => {
  const res = await get("/offers/centre", B.agent.cookie);
  assert.equal(res.status, 200);
  const body = (await res.json()) as CentreBody;
  assert.deepEqual(body.offers.map((o) => o.id), [bOfferId]);
  assert.equal(body.total, 1);
});

test("filters: status and propertyId (own property)", async () => {
  const byStatus = (await (await get("/offers/centre?status=Received", A.agent.cookie)).json()) as CentreBody;
  assert.deepEqual(byStatus.offers.map((o) => o.id), [aOfferIds.r900, aOfferIds.r700, aOfferIds.r500]);
  assert.equal(byStatus.total, 3);
  const byProperty = (await (await get(`/offers/centre?propertyId=${txnPropertyId}`, A.agent.cookie)).json()) as CentreBody;
  assert.deepEqual(byProperty.offers.map((o) => o.id), [aOfferIds.a600]);
});

test("pagination: limit and offset with a stable total", async () => {
  const page1 = (await (await get("/offers/centre?limit=2&offset=0", A.agent.cookie)).json()) as CentreBody;
  const page2 = (await (await get("/offers/centre?limit=2&offset=2", A.agent.cookie)).json()) as CentreBody;
  assert.deepEqual(page1.offers.map((o) => o.id), [aOfferIds.r900, aOfferIds.r700]);
  assert.deepEqual(page2.offers.map((o) => o.id), [aOfferIds.r500, aOfferIds.a600]);
  assert.equal(page1.total, 6);
  assert.equal(page1.limit, 2);
  assert.equal(page2.offset, 2);
});

test("invalid query values are 400", async () => {
  for (const q of ["status=Bogus", "limit=0", "limit=201", "offset=-1", "propertyId=abc", "propertyId=2147483648"]) {
    const res = await get(`/offers/centre?${q}`, A.agent.cookie);
    assert.equal(res.status, 400, q);
  }
});

test("a propertyId in another brokerage is 404 and increments the tenant-rejection metric once", async () => {
  resetMetricsForTesting();
  const res = await get(`/offers/centre?propertyId=${bPropertyId}`, A.agent.cookie);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Not found" });
  assert.deepEqual(isolationSeries(), [{ labels: 'boundary="transaction"', value: 1 }]);
});

test("a missing propertyId is 404 and a normal list does not increment the metric", async () => {
  resetMetricsForTesting();
  assert.equal((await get("/offers/centre?propertyId=2147483646", A.agent.cookie)).status, 404);
  assert.equal((await get("/offers/centre", A.agent.cookie)).status, 200);
  assert.deepEqual(isolationSeries(), []);
});

test("requires authentication", async () => {
  const res = await fetch(`${baseUrl}/api/offers/centre`);
  assert.equal(res.status, 401);
});

test("requires run.access: 403 Not entitled when revoked, 200 when restored", async () => {
  await setRunAccess(A.brokerageId, false);
  try {
    const res = await get("/offers/centre", A.agent.cookie);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error?: string; entitlementKey?: string };
    assert.equal(body.error, "Not entitled");
    assert.equal(body.entitlementKey, "run.access");
  } finally {
    await setRunAccess(A.brokerageId, true);
  }
  assert.equal((await get("/offers/centre", A.agent.cookie)).status, 200);
});

test("the read writes nothing: offer statuses are unchanged", async () => {
  const before2 = await db.select({ id: offers.id, status: offers.status }).from(offers).where(eq(offers.propertyId, listedPropertyId));
  await get("/offers/centre", A.agent.cookie);
  const after2 = await db.select({ id: offers.id, status: offers.status }).from(offers).where(eq(offers.propertyId, listedPropertyId));
  assert.deepEqual(after2.sort((a, b) => a.id - b.id), before2.sort((a, b) => a.id - b.id));
});
