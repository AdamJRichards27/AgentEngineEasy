import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { appraisalComparableSales, appraisals, db, entitlementGrants, growCommitments, offers, parties, properties, propertyParties, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { isMarketActivityEnabled } from "../growMarketActivity.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

// Market Activity privacy regression coverage (Owner 27 Oct; Owner 28 Oct).
// Gaps closed here, beyond growMarketActivityPrivacy / AreaPins:
//  - auth and entitlement gates (401 signed out, 403 without grow.access);
//  - strict flag parsing;
//  - an Agent who owns no properties (empty own-property set);
//  - another agent's client records, offers, commitments, price and internal
//    notes seeded on their property never appear anywhere in the payload;
//  - public-form events and the response carry only allow-listed fields.
// The list's street-address display is deliberately not asserted either way
// (Owner undecided). Synthetic data only; no outbound calls.

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const day = 86_400_000;
let admin: DevLoginResult, agent1: DevLoginResult, agent2: DevLoginResult, agent3: DevLoginResult, pitCrew: DevLoginResult, noGrantAdmin: DevLoginResult;
const cleanupIds: number[] = [];
const prev = process.env.GROW_MARKET_ACTIVITY_ENABLED;
const ids: Record<string, number> = {};
const SECRET = {
  vendorFirst: `Zelda${suffix}`, vendorLast: `Vendorson${suffix}`, vendorEmail: `vendor-${suffix}@example.com`, vendorMobile: "0400999111",
  buyerFirst: `Quincy${suffix}`, offerCents: 98765432, commitment: `Call vendor re price ${suffix}`,
  price: `Guide $9,876,543 ${suffix}`, notes: `internal ownership note ${suffix}`, compAddress: `77 Secret Comparable Ct ${suffix}`,
};

async function grant(b: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId: b, entitlementKey: key, granteeType: "brokerage", granteeId: b, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(b);
}
async function prop(brokerageId: number, agentId: number, label: string, set: Partial<typeof properties.$inferInsert>): Promise<number> {
  const [p] = await db.insert(properties).values({ brokerageId, agentId, formattedAddress: `${label} ${suffix}`, suburb: "Ashgrove", state: "QLD", postcode: "4060", ...set } as typeof properties.$inferInsert).returning();
  return p.id;
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
  const name = `MAR A ${suffix}`;
  const A = await createBrokerageWithUsers(baseUrl, name);
  admin = A.admin; agent1 = A.agent;
  agent2 = await devLogin(baseUrl, { email: `agent2-mar-${suffix}@example.com`, firstName: "Second", lastName: "Agentperson", brokerageName: name });
  agent3 = await devLogin(baseUrl, { email: `agent3-mar-${suffix}@example.com`, firstName: "Third", lastName: "Agent", brokerageName: name });
  pitCrew = await devLogin(baseUrl, { email: `pc-mar-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  const NOGRANT = await createBrokerageWithUsers(baseUrl, `MAR NoGrant ${suffix}`);
  noGrantAdmin = NOGRANT.admin;
  cleanupIds.push(A.brokerageId, NOGRANT.brokerageId);
  await grant(A.brokerageId, "grow.access");
  const now = Date.now();
  const bA = A.brokerageId, a1 = agent1.user.id, a2 = agent2.user.id;
  ids.a1Listed = await prop(bA, a1, "1 Own Listed St", { listingStatus: "Listed", campaignStartDate: new Date(now - 2 * day) });
  ids.a2Sold = await prop(bA, a2, "2 Their Sold St", {
    listingStatus: "Sold", campaignStartDate: new Date(now - 60 * day), campaignEndDate: new Date(now - 2 * day),
    priceDisplay: SECRET.price, ownershipReviewNotes: SECRET.notes,
  } as Partial<typeof properties.$inferInsert>);
  ids.a2Withdrawn = await prop(bA, a2, "3 Their Withdrawn St", { listingStatus: "Withdrawn", campaignStartDate: new Date(now - 60 * day), campaignEndDate: new Date(now - 3 * day) });
  const [vendor] = await db.insert(parties).values({ brokerageId: bA, firstName: SECRET.vendorFirst, lastName: SECRET.vendorLast, email: SECRET.vendorEmail, mobile: SECRET.vendorMobile } as typeof parties.$inferInsert).returning();
  const [buyer] = await db.insert(parties).values({ brokerageId: bA, firstName: SECRET.buyerFirst, lastName: "Buyer" } as typeof parties.$inferInsert).returning();
  ids.vendor = vendor.id; ids.buyer = buyer.id;
  await db.insert(propertyParties).values({ propertyId: ids.a2Sold, partyId: vendor.id, role: "Vendor", isPrimary: true });
  const [offer] = await db.insert(offers).values({ propertyId: ids.a2Sold, buyerPartyId: buyer.id, offerPriceCents: SECRET.offerCents, status: "Accepted" }).returning();
  ids.offer = offer.id;
  const [c] = await db.insert(growCommitments).values({ brokerageId: bA, partyId: vendor.id, propertyId: ids.a2Sold, description: SECRET.commitment, dueAt: new Date(now + day), createdBy: a2 } as typeof growCommitments.$inferInsert).returning();
  ids.commitment = c.id;
  const [appr] = await db.insert(appraisals).values({ propertyId: ids.a2Sold, brokerageId: bA } as typeof appraisals.$inferInsert).returning();
  ids.appraisal = appr.id;
  await db.insert(appraisalComparableSales).values({ appraisalId: appr.id, address: SECRET.compAddress, source: "manual", saleDate: new Date(now - 4 * day) });
});

after(async () => {
  if (prev === undefined) delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  else process.env.GROW_MARKET_ACTIVITY_ENABLED = prev;
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

type Ev = Record<string, unknown> & { address: string; type: string; access: string; propertyId: number | null };
type Body = Record<string, unknown> & { counts: Record<string, number>; events: Ev[] };
async function get(u: DevLoginResult | null, q = "?range=30d") {
  return fetch(`${baseUrl}/api/grow/market-activity${q}`, { headers: u ? { cookie: u.cookie } : {} });
}
async function list(u: DevLoginResult, q = "?range=30d"): Promise<{ body: Body; raw: string }> {
  const res = await get(u, q);
  assert.equal(res.status, 200);
  const raw = await res.text();
  return { body: JSON.parse(raw) as Body, raw };
}
function assertNoPrivate(raw: string, who: string) {
  for (const [k, v] of Object.entries(SECRET)) assert.ok(!raw.includes(String(v)), `${who}: ${k} leaked`);
  for (const s of ["Second", "Agentperson", `agent2-mar-${suffix}`, "Their Withdrawn St"]) assert.ok(!raw.includes(s), `${who}: ${s} leaked`);
  for (const id of [ids.a2Sold, ids.a2Withdrawn]) assert.ok(!raw.includes(`"propertyId":${id}`) && !new RegExp(`"(listed|sold|withdrawn)-${id}"`).test(raw), `${who}: property id ${id} leaked`);
  assert.ok(!raw.includes(`"appraisalId":${ids.appraisal}`), `${who}: appraisal id leaked`);
  assert.ok(!/"(agentId|ownerUserId|createdBy|partyId|buyerPartyId|offerPriceCents|priceDisplay|ownershipReviewNotes|description|email|mobile)"/.test(raw), `${who}: private field name in payload`);
}

test("flag parsing is strict: only the string true (any case) enables the route", () => {
  for (const v of [undefined, "", "1", "yes", "on", "false", " true"]) assert.equal(isMarketActivityEnabled({ GROW_MARKET_ACTIVITY_ENABLED: v }), false, String(v));
  for (const v of ["true", "TRUE", "True"]) assert.equal(isMarketActivityEnabled({ GROW_MARKET_ACTIVITY_ENABLED: v }), true, v);
});

test("flag on: 401 signed out; 403 for a brokerage without grow.access", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  assert.equal((await get(null)).status, 401);
  const res = await get(noGrantAdmin);
  assert.equal(res.status, 403);
  assertNoPrivate(await res.text(), "no-grant");
});

test("flag off: signed-out and unentitled callers also get 404", async () => {
  delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  assert.equal((await get(null)).status, 404);
  assert.equal((await get(noGrantAdmin)).status, 404);
});

test("Agent: another agent's clients, offers, commitments, price, notes and listing performance never appear", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  for (const q of ["?range=30d", "?range=week", "?range=lastweek", "?range=30d&types=sold,withdrawn,agentEvidence&suburbs=ashgrove"]) {
    const { raw } = await list(agent1, q);
    assertNoPrivate(raw, `agent1 ${q}`);
  }
  const { body } = await list(agent1);
  assert.equal(body.counts.withdrawn, 0);
  assert.equal(body.counts.agentEvidence, 0);
});

test("public-form events and the response carry only allow-listed fields", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const { body } = await list(agent1);
  const allowedTop = ["asOf", "range", "start", "end", "counts", "events", "truncated", "areaPins", "providers"];
  for (const k of Object.keys(body)) assert.ok(allowedTop.includes(k), `unexpected top-level field ${k}`);
  const pub = body.events.filter((e) => e.access === "public");
  assert.deepEqual(pub.map((e) => e.type), ["sold"]);
  const allowedEvent = ["key", "type", "label", "sourceLabel", "address", "suburb", "eventDate", "recordDate", "propertyId", "appraisalId", "access", "lat", "lng"];
  for (const e of pub) {
    assert.deepEqual(Object.keys(e).filter((k) => !allowedEvent.includes(k)), [], "public event carries an extra field");
    assert.equal(e.propertyId, null);
    assert.equal(e.appraisalId, null);
    assert.equal(e.recordDate, e.eventDate);
    assert.equal(e.lat ?? null, null);
    assert.equal(e.lng ?? null, null);
    assert.match(String(e.key), /^public-\d+$/);
  }
});

test("Agent who owns no properties: public events only, nothing private, no record links", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const { body, raw } = await list(agent3);
  assertNoPrivate(raw, "agent3");
  assert.ok(body.events.length >= 2);
  for (const e of body.events) {
    assert.equal(e.access, "public");
    assert.equal(e.propertyId, null);
    assert.ok(["justListed", "sold"].includes(e.type));
  }
  assert.ok(!raw.includes(`"propertyId":${ids.a1Listed}`));
});

test("Brokerage Administrator and Pit Crew keep the brokerage-wide record view", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  for (const u of [admin, pitCrew]) {
    const { body, raw } = await list(u);
    assert.ok(body.events.some((e) => e.propertyId === ids.a2Sold && e.access === "record"), `${u.user.email}: sold record`);
    assert.ok(body.events.some((e) => e.propertyId === ids.a2Withdrawn), `${u.user.email}: withdrawn record`);
    assert.ok(raw.includes(`"appraisalId":${ids.appraisal}`), `${u.user.email}: comparable`);
    assert.ok(!body.events.some((e) => e.access === "public"), "nothing is downgraded to public form");
    // Even the brokerage-wide view is event-shaped: no client, offer or commitment data.
    for (const k of ["vendorFirst", "vendorEmail", "buyerFirst", "offerCents", "commitment", "notes"] as const) assert.ok(!raw.includes(String(SECRET[k])), `${u.user.email}: ${k}`);
  }
});
