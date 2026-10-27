import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { appraisalComparableSales, appraisals, db, entitlementGrants, properties, users } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { cleanupBrokerages, createBrokerageWithUsers, devLogin, type DevLoginResult } from "./testSupport.js";

// Owner t525u item 2: Market Activity privacy. Public market events (just
// listed, sold) stay brokerage-wide, but another agent's private activity
// (withdrawn listings, agent-entered appraisal comparables) and any record
// link (propertyId, appraisalId, internal record dates) stay with the agent,
// Brokerage Administrator and Pit Crew (the existing property-visibility rule).
// Synthetic data only; no outbound calls.

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const day = 86_400_000;
let admin: DevLoginResult, agent1: DevLoginResult, agent2: DevLoginResult, pitCrew: DevLoginResult, otherAdmin: DevLoginResult;
let brokerageId = 0;
const ids: Record<string, number> = {};
const cleanupIds: number[] = [];
const prev = process.env.GROW_MARKET_ACTIVITY_ENABLED;

async function grant(b: number, key: string) {
  await db.insert(entitlementGrants).values({ brokerageId: b, entitlementKey: key, granteeType: "brokerage", granteeId: b, sourceType: "manual", status: "Active" });
  invalidateEntitlementCache(b);
}
async function property(cookie: string, label: string, suburb: string, set: Partial<typeof properties.$inferInsert>): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: `${label} ${suffix}`, state: "QLD", suburb, postcode: "4000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status}`);
  const id = ((await res.json()) as { property: { id: number } }).property.id;
  await db.update(properties).set(set).where(eq(properties.id, id));
  return id;
}
async function comparable(propertyId: number, address: string): Promise<{ appraisalId: number; compId: number }> {
  const [a] = await db.insert(appraisals).values({ propertyId, brokerageId } as typeof appraisals.$inferInsert).returning();
  const [c] = await db.insert(appraisalComparableSales).values({ appraisalId: a.id, address: `${address} ${suffix}`, source: "manual", saleDate: new Date(Date.now() - 4 * day) }).returning();
  return { appraisalId: a.id, compId: c.id };
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
  const name = `MAP A ${suffix}`;
  const A = await createBrokerageWithUsers(baseUrl, name);
  admin = A.admin; agent1 = A.agent; brokerageId = A.brokerageId;
  agent2 = await devLogin(baseUrl, { email: `agent2-map-${suffix}@example.com`, firstName: "Other", lastName: "Agent", brokerageName: name });
  pitCrew = await devLogin(baseUrl, { email: `pc-map-${suffix}@example.com`, firstName: "Pit", lastName: "Crew", brokerageName: name });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  const OTHER = await createBrokerageWithUsers(baseUrl, `MAP Other ${suffix}`);
  otherAdmin = OTHER.admin;
  cleanupIds.push(brokerageId, OTHER.brokerageId);
  await grant(brokerageId, "grow.access");
  await grant(OTHER.brokerageId, "grow.access");
  const now = Date.now();
  ids.a1Listed = await property(agent1.cookie, "1 Mine Listed St", "Paddington", { listingStatus: "Listed", campaignStartDate: new Date(now - 2 * day), latitude: "-27.4600000", longitude: "153.0000000" });
  ids.a1Withdrawn = await property(agent1.cookie, "2 Mine Withdrawn St", "Paddington", { listingStatus: "Withdrawn", campaignStartDate: new Date(now - 40 * day), campaignEndDate: new Date(now - 3 * day) });
  ids.a2Listed = await property(agent2.cookie, "5 Their Listed St", "Ashgrove", { listingStatus: "Listed", campaignStartDate: new Date(now - 1 * day), latitude: "-27.4450000", longitude: "152.9800000" });
  ids.a2Sold = await property(agent2.cookie, "6 Their Sold St", "Ashgrove", { listingStatus: "Sold", campaignStartDate: new Date(now - 50 * day), campaignEndDate: new Date(now - 2 * day) });
  ids.a2Withdrawn = await property(agent2.cookie, "7 Their Withdrawn St", "Ashgrove", { listingStatus: "Withdrawn", campaignStartDate: new Date(now - 50 * day), campaignEndDate: new Date(now - 2 * day) });
  const mine = await comparable(ids.a1Listed, "8 Mine Comparable Ct");
  const theirs = await comparable(ids.a2Listed, "9 Their Comparable Ct");
  ids.mineComp = mine.compId; ids.theirComp = theirs.compId; ids.theirAppraisal = theirs.appraisalId;
  ids.foreign = await property(OTHER.agent.cookie, "99 Foreign St", "Ashgrove", { listingStatus: "Listed", campaignStartDate: new Date(now - 1 * day), latitude: "-27.4400000", longitude: "152.9700000" });
});

after(async () => {
  if (prev === undefined) delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  else process.env.GROW_MARKET_ACTIVITY_ENABLED = prev;
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

type Ev = { key: string; type: string; address: string; suburb: string | null; sourceLabel: string; eventDate: string; recordDate: string; propertyId: number | null; appraisalId: number | null; access?: string; lat?: number | null; lng?: number | null };
type Body = { counts: Record<string, number>; events: Ev[] };
async function list(u: DevLoginResult, q = "?range=30d"): Promise<Body> {
  const res = await fetch(`${baseUrl}/api/grow/market-activity${q}`, { headers: { cookie: u.cookie } });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as Body;
}
const has = (b: Body, s: string) => b.events.some((e) => e.address.includes(s));
const raw = (b: Body) => JSON.stringify(b);

test("flag off: 404 for every role and tenant", async () => {
  delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  for (const u of [admin, agent1, agent2, pitCrew, otherAdmin]) {
    const res = await fetch(`${baseUrl}/api/grow/market-activity?range=30d`, { headers: { cookie: u.cookie } });
    assert.equal(res.status, 404);
  }
});

test("Agent: another agent's private events (withdrawn, appraisal comparables) are not returned or counted", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const b = await list(agent1);
  assert.ok(!has(b, "Their Withdrawn St"), "another agent's withdrawn listing leaked");
  assert.ok(!has(b, "Their Comparable Ct"), "another agent's appraisal comparable leaked");
  assert.ok(!raw(b).includes(`"appraisalId":${ids.theirAppraisal}`), "another agent's appraisal id leaked");
  // Own private events stay.
  assert.ok(has(b, "Mine Withdrawn St") && has(b, "Mine Comparable Ct"));
  assert.equal(b.counts.withdrawn, 1);
  assert.equal(b.counts.agentEvidence, 1);
  // Filters can't be used to probe them either.
  const probe = await list(agent1, "?range=30d&suburbs=ashgrove&types=withdrawn,agentEvidence");
  assert.deepEqual(probe.events, []);
  assert.equal(probe.counts.withdrawn + probe.counts.agentEvidence, 0);
});

test("Agent: another agent's public market events stay visible but carry no record link or internal data", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const b = await list(agent1);
  const theirs = b.events.filter((e) => e.address.includes("Their "));
  assert.deepEqual(theirs.map((e) => e.type).sort(), ["justListed", "sold"]);
  for (const e of theirs) {
    assert.equal(e.propertyId, null, `${e.key}: property link leaked`);
    assert.equal(e.appraisalId, null);
    assert.equal(e.access, "public");
    assert.equal(e.recordDate, e.eventDate, "internal record date leaked");
    assert.ok(!e.key.includes(String(ids.a2Listed)) && !e.key.includes(String(ids.a2Sold)), "key leaks the property id");
    assert.equal(e.sourceLabel, "AE brokerage listing");
  }
  for (const id of [ids.a2Listed, ids.a2Sold, ids.a2Withdrawn]) assert.ok(!raw(b).includes(`"propertyId":${id}`));
  const mine = b.events.find((e) => e.address.includes("Mine Listed St"))!;
  assert.equal(mine.propertyId, ids.a1Listed);
  assert.equal(mine.access, "record");
});

test("the other Agent gets the mirror image", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const b = await list(agent2);
  assert.ok(!has(b, "Mine Withdrawn St") && !has(b, "Mine Comparable Ct"));
  assert.ok(has(b, "Their Withdrawn St") && has(b, "Their Comparable Ct"));
  assert.equal(b.events.find((e) => e.address.includes("Mine Listed St"))?.propertyId, null);
});

test("Brokerage Administrator and Pit Crew keep brokerage-wide access with record links", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  for (const u of [admin, pitCrew]) {
    const b = await list(u);
    for (const s of ["Mine Listed St", "Mine Withdrawn St", "Their Listed St", "Their Sold St", "Their Withdrawn St", "Mine Comparable Ct", "Their Comparable Ct"]) assert.ok(has(b, s), `${u.user.email}: ${s}`);
    assert.equal(b.events.find((e) => e.address.includes("Their Listed St"))?.propertyId, ids.a2Listed);
    assert.ok(!has(b, "Foreign"));
  }
});

test("cross-tenant: another brokerage sees only its own events, never brokerage A's", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const b = await list(otherAdmin);
  assert.deepEqual(b.events.map((e) => e.address.replace(` ${suffix}`, "")), ["99 Foreign St"]);
  const a = await list(agent1);
  assert.ok(!has(a, "Foreign"));
});

test("V5 map coordinates: only on AE property records the caller may open; never public-form, comparables or other tenants", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const a = await list(agent1);
  const mine = a.events.find((e) => e.address.includes("Mine Listed St"))!;
  assert.deepEqual([mine.lat, mine.lng], [-27.46, 153]);
  for (const e of a.events.filter((x) => x.access === "public" || x.type === "agentEvidence")) {
    assert.equal(e.lat, null, `${e.key}: coordinates on a non-record event`);
    assert.equal(e.lng, null);
  }
  assert.ok(!raw(a).includes("152.98"), "another agent's coordinates leaked");
  assert.ok(!raw(a).includes("152.97"), "another tenant's coordinates leaked");
  // Records without coordinates send nulls, not zeros.
  const withdrawn = a.events.find((e) => e.address.includes("Mine Withdrawn St"))!;
  assert.deepEqual([withdrawn.lat, withdrawn.lng], [null, null]);
  for (const u of [admin, pitCrew]) {
    const b = await list(u);
    const theirs = b.events.find((e) => e.address.includes("Their Listed St"))!;
    assert.deepEqual([theirs.lat, theirs.lng], [-27.445, 152.98]);
    assert.ok(!raw(b).includes("152.97"));
  }
  const o = await list(otherAdmin);
  const foreign = o.events.find((e) => e.address.includes("99 Foreign St"))!;
  assert.deepEqual([foreign.lat, foreign.lng], [-27.44, 152.97], "a tenant's own admin sees its own coordinates");
  assert.ok(!raw(o).includes("-27.46") && !raw(o).includes("152.98"), "brokerage A coordinates leaked cross-tenant");
});
